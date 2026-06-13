"""
Stripe billing integration for the kernel server (Phase 4).

Mirrors ai_proxy.register_ai_routes: `register_billing_routes(app)` attaches the
billing surface to an existing Flask app. Identity + plan + usage come from
auth_gate; Stripe is the source of truth for subscription state, mirrored into
profiles.{plan,stripe_customer_id,stripe_subscription_id,plan_status,
current_period_end} via webhooks.

Plan model is binary: 'free' | 'paid'. Paid = "Pro", $9.99/month.

Routes registered:

  GET  /billing/me        identity optional → {ok, plan, usage}
  POST /billing/checkout  identity required → {ok, url}   (Stripe Checkout)
  POST /billing/portal    identity required → {ok, url}   (Stripe Billing Portal)
  POST /billing/webhook   NO bearer auth, raw-body signature verified

Env vars:
  STRIPE_SECRET_KEY      — Stripe secret API key (sk_…)
  STRIPE_WEBHOOK_SECRET  — endpoint signing secret (whsec_…)
  STRIPE_PRICE_ID        — the $9.99/mo recurring price id (price_…)
  APP_URL                — redirect base (default http://localhost:1420)

The stripe SDK is imported lazily so this module imports cleanly even when
`stripe` isn't installed (the runtime kernel doesn't need it unless billing is
configured).
"""

import os
import sys
from datetime import datetime, timezone

import requests
from flask import jsonify, request

from auth_gate import (
    verify_token,
    get_plan,
    get_usage,
    auth_required,
    _supabase_url,
    _service_key,
)

_HTTP_TIMEOUT_S = 10

# Default free-tier caps surfaced for the unauthenticated /billing/me payload so
# the studio can render a meter in dev without a real identity. Mirror the
# auth_gate env-tunable defaults.
_DEFAULT_FREE_USAGE = {
    "ai": {"count": 0, "cap": 15},
    "execute": {"count": 0, "cap": 60},
}


# ── Env plumbing ─────────────────────────────────────────────────────────────

def _stripe_secret_key():
    key = os.environ.get("STRIPE_SECRET_KEY")
    return key.strip() if key else None


def _stripe_webhook_secret():
    key = os.environ.get("STRIPE_WEBHOOK_SECRET")
    return key.strip() if key else None


def _stripe_price_id():
    pid = os.environ.get("STRIPE_PRICE_ID")
    return pid.strip() if pid else None


def _app_url():
    return os.environ.get("APP_URL", "http://localhost:1420").rstrip("/")


def _import_stripe():
    """Lazily import the stripe SDK. Returns the module or None if unavailable."""
    try:
        import stripe  # noqa: WPS433 (intentional lazy import)
        return stripe
    except Exception as e:  # ImportError or anything during import
        print(f"[paraform] billing: stripe SDK unavailable: {e}", file=sys.stderr)
        return None


# ── Identity ─────────────────────────────────────────────────────────────────

def _require_identity(flask_request):
    """Resolve the Bearer token to {user_id, email}, or None.

    Header parsing mirrors auth_gate.gate_request.
    """
    auth_header = flask_request.headers.get("Authorization") or ""
    token = auth_header[7:].strip() if auth_header.lower().startswith("bearer ") else None
    if not token:
        return None
    return verify_token(token)


# ── Profile mirroring (service-role PostgREST) ────────────────────────────────

def _set_plan(user_id, plan=None, *, stripe_customer_id=None,
              stripe_subscription_id=None, plan_status=None,
              current_period_end=None):
    """PATCH profiles for `user_id` with the provided non-None columns.

    No-op (returns None) when the service key / url isn't configured.
    """
    skey = _service_key()
    url = _supabase_url()
    if not skey or not url or not user_id:
        return None

    body = {}
    if plan is not None:
        body["plan"] = plan
    if stripe_customer_id is not None:
        body["stripe_customer_id"] = stripe_customer_id
    if stripe_subscription_id is not None:
        body["stripe_subscription_id"] = stripe_subscription_id
    if plan_status is not None:
        body["plan_status"] = plan_status
    if current_period_end is not None:
        body["current_period_end"] = current_period_end
    if not body:
        return None

    try:
        requests.patch(
            f"{url}/rest/v1/profiles",
            params={"id": f"eq.{user_id}"},
            json=body,
            headers={
                "apikey": skey,
                "Authorization": f"Bearer {skey}",
                "Content-Type": "application/json",
                "Prefer": "return=minimal",
            },
            timeout=_HTTP_TIMEOUT_S,
        )
    except Exception as e:
        print(f"[paraform] billing: _set_plan failed for {user_id}: {e}", file=sys.stderr)
    return None


def _user_by_customer(customer_id):
    """Resolve a Stripe customer id back to a profiles.id, or None."""
    skey = _service_key()
    url = _supabase_url()
    if not skey or not url or not customer_id:
        return None
    try:
        resp = requests.get(
            f"{url}/rest/v1/profiles",
            params={"stripe_customer_id": f"eq.{customer_id}", "select": "id"},
            headers={"apikey": skey, "Authorization": f"Bearer {skey}"},
            timeout=_HTTP_TIMEOUT_S,
        )
        if resp.status_code == 200:
            rows = resp.json()
            if isinstance(rows, list) and rows:
                return rows[0].get("id")
    except Exception as e:
        print(f"[paraform] billing: _user_by_customer failed: {e}", file=sys.stderr)
    return None


def _customer_id_for(user_id):
    """Read profiles.stripe_customer_id for a user, or None."""
    skey = _service_key()
    url = _supabase_url()
    if not skey or not url or not user_id:
        return None
    try:
        resp = requests.get(
            f"{url}/rest/v1/profiles",
            params={"id": f"eq.{user_id}", "select": "stripe_customer_id"},
            headers={"apikey": skey, "Authorization": f"Bearer {skey}"},
            timeout=_HTTP_TIMEOUT_S,
        )
        if resp.status_code == 200:
            rows = resp.json()
            if isinstance(rows, list) and rows:
                return rows[0].get("stripe_customer_id")
    except Exception as e:
        print(f"[paraform] billing: _customer_id_for failed: {e}", file=sys.stderr)
    return None


def _epoch_to_iso(epoch):
    """Convert epoch seconds to an ISO-8601 UTC string, or None."""
    if epoch is None:
        return None
    try:
        return datetime.fromtimestamp(int(epoch), tz=timezone.utc).isoformat()
    except (TypeError, ValueError, OSError):
        return None


# ── Routes ───────────────────────────────────────────────────────────────────

def register_billing_routes(app) -> None:
    """Attach /billing/{me,checkout,portal,webhook} to an existing Flask app.

    Inherits the app-wide CORS policy from server.py.
    """

    @app.route("/billing/me", methods=["GET"])
    def billing_me():
        identity = _require_identity(request)
        if identity is not None:
            uid = identity["user_id"]
            return jsonify({
                "ok": True,
                "plan": get_plan(uid),
                "usage": get_usage(uid),
            })
        # No identity — dev / unauth. Even when REQUIRE_AUTH is on we serve a
        # free/empty payload here (the gate protects /execute + /ai, not the
        # billing meter), so the studio can always render something.
        return jsonify({
            "ok": True,
            "plan": "free",
            "usage": dict(_DEFAULT_FREE_USAGE),
        })

    @app.route("/billing/checkout", methods=["POST"])
    def billing_checkout():
        identity = _require_identity(request)
        if identity is None:
            return jsonify({"ok": False, "error": "auth required",
                            "code": "auth_required"}), 401

        secret = _stripe_secret_key()
        price = _stripe_price_id()
        if not secret or not price:
            return jsonify({"ok": False, "error": "billing not configured",
                            "code": "billing_unconfigured"}), 503

        stripe = _import_stripe()
        if stripe is None:
            return jsonify({"ok": False, "error": "billing not configured",
                            "code": "billing_unconfigured"}), 503

        app_url = _app_url()
        try:
            stripe.api_key = secret
            cs = stripe.checkout.Session.create(
                mode="subscription",
                line_items=[{"price": price, "quantity": 1}],
                customer_email=identity["email"],
                client_reference_id=identity["user_id"],
                success_url=f"{app_url}/#/studio?checkout=success",
                cancel_url=f"{app_url}/#/pricing?checkout=cancel",
                allow_promotion_codes=True,
            )
        except Exception as e:
            return jsonify({"ok": False, "error": str(e),
                            "code": "stripe_error"}), 502
        return jsonify({"ok": True, "url": cs.url})

    @app.route("/billing/portal", methods=["POST"])
    def billing_portal():
        identity = _require_identity(request)
        if identity is None:
            return jsonify({"ok": False, "error": "auth required",
                            "code": "auth_required"}), 401

        secret = _stripe_secret_key()
        if not secret:
            return jsonify({"ok": False, "error": "no active subscription",
                            "code": "no_customer"}), 503

        cust = _customer_id_for(identity["user_id"])
        if not cust:
            return jsonify({"ok": False, "error": "no active subscription",
                            "code": "no_customer"}), 404

        stripe = _import_stripe()
        if stripe is None:
            return jsonify({"ok": False, "error": "no active subscription",
                            "code": "no_customer"}), 503

        app_url = _app_url()
        try:
            stripe.api_key = secret
            ps = stripe.billing_portal.Session.create(
                customer=cust,
                return_url=f"{app_url}/#/studio",
            )
        except Exception as e:
            return jsonify({"ok": False, "error": str(e),
                            "code": "stripe_error"}), 502
        return jsonify({"ok": True, "url": ps.url})

    @app.route("/billing/webhook", methods=["POST"])
    def billing_webhook():
        secret = _stripe_webhook_secret()
        if not secret:
            return jsonify({"ok": False, "error": "billing not configured",
                            "code": "billing_unconfigured"}), 503

        stripe = _import_stripe()
        if stripe is None:
            return jsonify({"ok": False, "error": "billing not configured",
                            "code": "billing_unconfigured"}), 503

        payload = request.get_data()  # raw bytes — DO NOT use get_json here
        sig = request.headers.get("Stripe-Signature")
        try:
            event = stripe.Webhook.construct_event(payload, sig, secret)
        except Exception:
            # Covers stripe.error.SignatureVerificationError and ValueError
            # (malformed payload) — both mean "don't trust this event".
            return jsonify({"ok": False, "error": "bad signature"}), 400

        try:
            _handle_event(event)
        except Exception as e:
            # Never 500 on a malformed object — Stripe would retry forever.
            print(f"[paraform] billing: webhook handler error: {e}", file=sys.stderr)
        return jsonify({"ok": True})


def _event_get(event, key, default=None):
    """event may be a dict-like StripeObject or a plain dict."""
    try:
        return event.get(key, default)
    except AttributeError:
        return getattr(event, key, default)


def _data_object(event):
    data = _event_get(event, "data") or {}
    try:
        return data.get("object") or {}
    except AttributeError:
        return getattr(data, "object", {}) or {}


def _handle_event(event):
    """Mirror a verified Stripe event into profiles. Defensive on every field."""
    etype = _event_get(event, "type")
    obj = _data_object(event)
    if not isinstance(obj, dict):
        # StripeObject supports .get, but be safe for plain attribute access.
        get = lambda k: _event_get(obj, k)  # noqa: E731
    else:
        get = obj.get

    if etype == "checkout.session.completed":
        user_id = get("client_reference_id")
        customer = get("customer")
        subscription = get("subscription")
        if user_id:
            _set_plan(
                user_id, "paid",
                stripe_customer_id=customer,
                stripe_subscription_id=subscription,
                plan_status="active",
            )

    elif etype == "customer.subscription.updated":
        customer = get("customer")
        uid = _user_by_customer(customer)
        if uid:
            status = get("status")
            plan = "paid" if status in ("active", "trialing", "past_due") else "free"
            _set_plan(
                uid, plan,
                plan_status=status,
                current_period_end=_epoch_to_iso(get("current_period_end")),
            )

    elif etype == "customer.subscription.deleted":
        customer = get("customer")
        uid = _user_by_customer(customer)
        if uid:
            _set_plan(uid, "free", plan_status="canceled")

    # default: ignore (handled/ignored events still return 200).
