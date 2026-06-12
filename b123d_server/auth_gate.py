"""
Supabase JWT auth + per-user daily usage caps for the kernel server.

Opt-in: the gate is a no-op unless env REQUIRE_AUTH is "1"/"true", so local
dev and the existing test suites keep working with zero configuration.

When enabled, gated routes (/execute, /measure, /ai/chat) require a Supabase
access token in the Authorization header. The token is verified against
GET {SUPABASE_URL}/auth/v1/user (the project's publishable key as `apikey`),
and verified identities are cached in-process for ~5 minutes — keyed by a
SHA-256 of the token so raw tokens never sit in memory longer than the
request.

Usage counting is per (user, UTC day, kind) with kind ∈ {'ai', 'execute'}:

  - If SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SECRET_KEY) is set, counts are
    persisted via the `increment_usage` PostgREST RPC (see
    supabase_schema.sql) so they survive kernel restarts and shard correctly
    across instances. Plans come from `profiles.plan` (cached ~5 min).
  - An in-memory counter is ALWAYS maintained as the floor — on any Supabase
    outage the kernel degrades to per-process counting instead of
    hard-failing requests.

Caps (per UTC day) are env-tunable:

  free            CAP_AI_PER_DAY=15        CAP_EXECUTE_PER_DAY=60
  maker/lifetime  CAP_AI_PER_DAY_PRO=200   CAP_EXECUTE_PER_DAY_PRO=1000

Public surface (used by server.py + ai_proxy.py):
  auth_required()                       → bool
  verify_token(bearer_token)            → {user_id, email} | None
  get_plan(user_id)                     → 'free' | 'maker' | 'lifetime'
  check_and_count(user_id, kind)        → (allowed, count, cap)
  gate_request(flask_request, kind)     → None | (json_dict, status_code)

Transport: the `requests` library (already a server dependency via ai_proxy).
"""

import hashlib
import os
import sys
import threading
import time
from datetime import datetime, timezone

import requests

# Cache lifetimes. Token + plan caches trade staleness for latency: a revoked
# token / downgraded plan can linger up to this long, which is acceptable for
# a usage gate (it is not an authorization boundary for user data — RLS is).
_TOKEN_CACHE_TTL_S = 300.0
_PLAN_CACHE_TTL_S = 300.0

# Soft bound before expired entries are swept; keeps the caches from growing
# without limit under token churn.
_CACHE_SWEEP_AT = 1024

_HTTP_TIMEOUT_S = 10

_PRO_PLANS = ("maker", "lifetime")
_KNOWN_PLANS = ("free", "maker", "lifetime")

# All mutable module state below is guarded by this lock — the server runs
# threaded=True, so concurrent requests hit the gate in parallel.
_state_lock = threading.Lock()
_token_cache: dict = {}   # sha256(token) -> ({user_id, email}, monotonic expiry)
_plan_cache: dict = {}    # user_id -> (plan, monotonic expiry)
_mem_counts: dict = {}    # (user_id, utc_date_iso, kind) -> int


# ── Env plumbing ─────────────────────────────────────────────────────────────

def _truthy(value) -> bool:
    return str(value or "").strip().lower() in ("1", "true", "yes", "on")


def auth_required() -> bool:
    """Gate master switch — env REQUIRE_AUTH, default OFF."""
    return _truthy(os.environ.get("REQUIRE_AUTH"))


def _supabase_url():
    url = os.environ.get("SUPABASE_URL") or os.environ.get("VITE_SUPABASE_URL")
    return url.strip().rstrip("/") if url else None


def _publishable_key():
    key = (os.environ.get("SUPABASE_PUBLISHABLE_KEY")
           or os.environ.get("VITE_SUPABASE_PUBLISHABLE_KEY"))
    return key.strip() if key else None


def _service_key():
    key = (os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
           or os.environ.get("SUPABASE_SECRET_KEY"))
    return key.strip() if key else None


def _int_env(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


def _cap_for(plan: str, kind: str) -> int:
    """Daily cap for a plan/kind pair. Unknown plans get free-tier caps."""
    pro = plan in _PRO_PLANS
    if kind == "ai":
        return _int_env("CAP_AI_PER_DAY_PRO", 200) if pro else _int_env("CAP_AI_PER_DAY", 15)
    return _int_env("CAP_EXECUTE_PER_DAY_PRO", 1000) if pro else _int_env("CAP_EXECUTE_PER_DAY", 60)


def _utc_day() -> str:
    return datetime.now(timezone.utc).date().isoformat()


# ── Token verification ───────────────────────────────────────────────────────

def _token_fingerprint(token: str) -> str:
    # Cache key only — never store the raw token.
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _sweep_expired(cache: dict, now: float) -> None:
    """Drop expired entries once a cache crosses the soft bound (lock held)."""
    if len(cache) > _CACHE_SWEEP_AT:
        for key in [k for k, (_, exp) in cache.items() if exp <= now]:
            del cache[key]


def verify_token(bearer_token):
    """Resolve a Supabase access token to {user_id, email}, or None.

    Verification is delegated to Supabase Auth itself (GET /auth/v1/user) so
    the kernel never needs the JWT secret; non-200 → None. Successful lookups
    are cached ~5 min keyed by token hash.
    """
    if not bearer_token:
        return None
    url = _supabase_url()
    key = _publishable_key()
    if not url or not key:
        # Gate enabled but Supabase not configured — fail closed.
        return None

    fp = _token_fingerprint(bearer_token)
    now = time.monotonic()
    with _state_lock:
        hit = _token_cache.get(fp)
        if hit is not None and hit[1] > now:
            return dict(hit[0])

    try:
        resp = requests.get(
            f"{url}/auth/v1/user",
            headers={"apikey": key, "Authorization": f"Bearer {bearer_token}"},
            timeout=_HTTP_TIMEOUT_S,
        )
    except requests.RequestException as e:
        print(f"[paraform] auth: token verification request failed: {e}", file=sys.stderr)
        return None
    if resp.status_code != 200:
        return None
    try:
        data = resp.json()
    except ValueError:
        return None
    user_id = data.get("id") if isinstance(data, dict) else None
    if not user_id:
        return None

    identity = {"user_id": user_id, "email": data.get("email")}
    with _state_lock:
        _sweep_expired(_token_cache, now)
        _token_cache[fp] = (identity, now + _TOKEN_CACHE_TTL_S)
    return dict(identity)


# ── Plan lookup ──────────────────────────────────────────────────────────────

def get_plan(user_id: str) -> str:
    """'free' | 'maker' | 'lifetime' from profiles.plan; 'free' on any failure.

    Requires the service key (RLS hides other users' profile rows from the
    publishable key). Without one, everybody is treated as 'free'.
    """
    skey = _service_key()
    if not skey or not user_id:
        return "free"
    url = _supabase_url()
    if not url:
        return "free"

    now = time.monotonic()
    with _state_lock:
        hit = _plan_cache.get(user_id)
        if hit is not None and hit[1] > now:
            return hit[0]

    plan = "free"
    try:
        resp = requests.get(
            f"{url}/rest/v1/profiles",
            params={"id": f"eq.{user_id}", "select": "plan"},
            headers={"apikey": skey, "Authorization": f"Bearer {skey}"},
            timeout=_HTTP_TIMEOUT_S,
        )
        if resp.status_code == 200:
            rows = resp.json()
            if isinstance(rows, list) and rows:
                candidate = rows[0].get("plan")
                if candidate in _KNOWN_PLANS:
                    plan = candidate
    except Exception as e:
        # Network/parse failure → default 'free'; cached so an outage doesn't
        # hammer Supabase on every request.
        print(f"[paraform] auth: plan lookup failed for {user_id}: {e}", file=sys.stderr)

    with _state_lock:
        _sweep_expired(_plan_cache, now)
        _plan_cache[user_id] = (plan, now + _PLAN_CACHE_TTL_S)
    return plan


# ── Usage counting ───────────────────────────────────────────────────────────

def _increment_usage_remote(user_id: str, day: str, kind: str):
    """POST the increment_usage RPC; returns the new count or None on failure."""
    skey = _service_key()
    url = _supabase_url()
    if not skey or not url:
        return None
    try:
        resp = requests.post(
            f"{url}/rest/v1/rpc/increment_usage",
            json={"p_user_id": user_id, "p_day": day, "p_kind": kind},
            headers={"apikey": skey, "Authorization": f"Bearer {skey}"},
            timeout=_HTTP_TIMEOUT_S,
        )
        if resp.status_code in (200, 201):
            value = resp.json()
            if isinstance(value, int):
                return value
    except Exception as e:
        print(f"[paraform] auth: increment_usage RPC failed: {e}", file=sys.stderr)
    return None


def check_and_count(user_id: str, kind: str):
    """Count one request for (user, today UTC, kind) → (allowed, count, cap).

    The in-memory counter is always bumped and acts as the floor; when the
    service key is configured the durable Supabase count is folded in via
    max(), so a kernel restart can't reset a user's day but a Supabase outage
    can't block requests either.
    """
    plan = get_plan(user_id)
    cap = _cap_for(plan, kind)
    day = _utc_day()
    ckey = (user_id, day, kind)

    with _state_lock:
        # Old days never get hit again — drop them so the dict stays one
        # day deep per active user.
        if len(_mem_counts) > _CACHE_SWEEP_AT:
            for stale in [k for k in _mem_counts if k[1] != day]:
                del _mem_counts[stale]
        mem_count = _mem_counts.get(ckey, 0) + 1
        _mem_counts[ckey] = mem_count

    count = mem_count
    remote = _increment_usage_remote(user_id, day, kind)
    if remote is not None:
        count = max(remote, mem_count)

    return (count <= cap, count, cap)


# ── Flask glue ───────────────────────────────────────────────────────────────

def gate_request(flask_request, kind: str):
    """Auth + rate-limit gate for one request.

    Returns None when the request may proceed, otherwise a
    (json_dict, status_code) pair the route should jsonify and return.
    kind ∈ {'ai', 'execute'} selects which daily cap applies.
    """
    if not auth_required():
        return None

    auth_header = flask_request.headers.get("Authorization") or ""
    token = auth_header[7:].strip() if auth_header.lower().startswith("bearer ") else None
    identity = verify_token(token) if token else None
    if identity is None:
        return ({"ok": False, "error": "auth required", "code": "auth_required"}, 401)

    allowed, count, cap = check_and_count(identity["user_id"], kind)
    if not allowed:
        return ({
            "ok": False,
            "error": f"daily {kind} limit reached",
            "code": "rate_limited",
            "count": count,
            "cap": cap,
            "plan": get_plan(identity["user_id"]),  # cached — no extra round trip
        }, 429)

    return None


def _reset_state_for_tests() -> None:
    """Test hook — wipe every in-process cache/counter."""
    with _state_lock:
        _token_cache.clear()
        _plan_cache.clear()
        _mem_counts.clear()
