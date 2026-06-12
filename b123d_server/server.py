"""
Paraform build123d execution server.

POST /execute  { "code": "<python>" }
  → 200 JSON { ok: true,  glb: "<base64 GLB>", topology: {...}, kernelVersion: {...} }
  → 400 JSON { ok: false, error: "<message>", kernelVersion: {...} }

GET  /health
  → 200 JSON { ok: true, server: "paraform-b123d" }

GET  /version
  → 200 JSON { wireFormat, namingContract, build123d, occt, python,
               buildHash, expectedBuild123d, mismatches: [...] }
"""

import hashlib
import json
import os
import sys
import threading
import traceback
from typing import Any

# Load the project-root .env so GEMINI_API_KEY / GOOGLE_API_KEY / ANTHROPIC_API_KEY
# (and the VITE_* vars) reach os.environ when the kernel is started via
# `npm run kernel` / `npm run start`. Best-effort: if python-dotenv isn't
# installed the server still runs, relying on the ambient environment.
try:
    from dotenv import load_dotenv
    load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), os.pardir, ".env"))
except Exception:
    pass

from flask import Flask, jsonify, request
from flask_cors import CORS

from harness import execute_b123d
import measure
from standard_parts import cache as _library_cache
from standard_parts import catalog as _library_catalog
from ai_proxy import register_ai_routes
from auth_gate import gate_request

app = Flask(__name__)
CORS(app, origins="*")

# Server-side AI proxy (Phase 1) — POST /ai/chat + GET /ai/health. Keeps the
# ANTHROPIC_API_KEY off the browser; inherits the app-wide CORS policy above
# so the localhost:1420 dev server can reach it.
register_ai_routes(app)

# Kernel build serialization. The server runs `threaded=True` (so an idle
# browser keep-alive connection or a slow build can't wedge the single worker
# and starve every other request — the old `threaded=False` deadlocked under
# the studio's keep-alive sockets, leaving placed parts un-rendered). But
# build123d / OCCT carry thread-local state that is NOT safe to run
# concurrently, so every kernel touch (/execute build + cache write, /measure
# read) is serialized through this lock. Net: concurrent connection handling,
# serial geometry kernel — the best of both.
_kernel_lock = threading.RLock()


# ── Version resolution ───────────────────────────────────────────────────────

_VERSIONS_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "VERSIONS.json")
_KERNEL_FILES = ("server.py", "harness.py", "naming.py")
_occt_warned = False


def _detect_build123d_version() -> str:
    try:
        import build123d
        return getattr(build123d, "__version__", "unknown") or "unknown"
    except Exception:
        return "unknown"


def _detect_occt_version() -> str:
    """OCCT version via OCP bindings.

    The bindings used by build123d are exposed as `OCP` — its
    package `__version__` mirrors the underlying OCCT release
    (e.g. '7.8.1.1'). Older builds expose `OCCT_Version.OCCT_VERSION_COMPLETE`
    so we try that path too before giving up.
    """
    global _occt_warned
    try:
        import OCP  # type: ignore
        ver = getattr(OCP, "__version__", None)
        if ver:
            return str(ver)
    except Exception:
        pass
    try:
        from OCP import OCCT_Version  # type: ignore
        ver = getattr(OCCT_Version, "OCCT_VERSION_COMPLETE", None)
        if ver:
            return str(ver)
    except Exception:
        pass
    try:
        import build123d  # type: ignore
        ver = getattr(build123d, "OCCT_VERSION", None)
        if ver:
            return str(ver)
    except Exception:
        pass
    if not _occt_warned:
        print("[paraform] WARNING: could not detect OCCT version via OCP or build123d", file=sys.stderr)
        _occt_warned = True
    return "unknown"


def _detect_python_version() -> str:
    return f"{sys.version_info.major}.{sys.version_info.minor}"


def _load_versions_file() -> dict:
    try:
        with open(_VERSIONS_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        print(f"[paraform] WARNING: could not read VERSIONS.json: {e}", file=sys.stderr)
        return {}


def _compute_build_hash(versions_blob: dict) -> str:
    """Short SHA1 prefix of VERSIONS.json + kernel module file contents.

    Goal: any edit to server.py / harness.py / naming.py / VERSIONS.json
    flips the hash so clients can detect they're talking to a different
    kernel build even when version strings haven't moved.
    """
    h = hashlib.sha1()
    try:
        h.update(json.dumps(versions_blob, sort_keys=True).encode("utf-8"))
    except Exception:
        pass
    here = os.path.dirname(os.path.abspath(__file__))
    for fname in _KERNEL_FILES:
        path = os.path.join(here, fname)
        try:
            with open(path, "rb") as f:
                h.update(f.read())
        except Exception:
            # Missing file still mixes into the hash via the filename
            h.update(fname.encode("utf-8"))
    return h.hexdigest()[:12]


def _compute_mismatches(expected: dict, actual: dict) -> list:
    """List of {field, expected, actual} entries where the runtime
    disagrees with the pinned spec. 'unknown' actuals never match.
    Python compares at major.minor only to match the pin format."""
    deltas: list = []
    for field, exp_val in (expected or {}).items():
        act_val = actual.get(field, "unknown")
        if not exp_val:
            continue
        if act_val == "unknown" or str(act_val) != str(exp_val):
            deltas.append({"field": field, "expected": exp_val, "actual": act_val})
    return deltas


def _resolve_versions() -> dict:
    """Combine VERSIONS.json pins with runtime-detected versions.

    Returns a dict with the wire-format and naming-contract numbers,
    every detected version, the build hash, the expected build123d
    pin, and a list of pin/runtime mismatches. Cached at module load.
    """
    blob = _load_versions_file()
    expected = blob.get("expected") or {}

    actual = {
        "build123d": _detect_build123d_version(),
        "occt":      _detect_occt_version(),
        "python":    _detect_python_version(),
    }

    build_hash = _compute_build_hash(blob)

    return {
        "wireFormat":         blob.get("wireFormat", 4),
        "namingContract":     blob.get("namingContract", 1),
        "build123d":          actual["build123d"],
        "occt":               actual["occt"],
        "python":             actual["python"],
        "buildHash":          build_hash,
        "expectedBuild123d":  expected.get("build123d"),
        "mismatches":         _compute_mismatches(expected, actual),
    }


# Cache once at module load — version detection is stable for the process
# lifetime, and re-reading VERSIONS.json on every /execute would add latency
# for no gain.
_KERNEL_VERSION: dict = _resolve_versions()


# ── Last-execution cache ─────────────────────────────────────────────────────
#
# /measure needs the live build123d Body objects + the v4 result dict from the
# most recent successful /execute so it can answer queries without re-running
# the document. We hold them in process memory. Caveats:
#   - Single-worker Flask is assumed (the existing `app.run(threaded=False)`
#     keeps this safe). Multi-worker deployments (gunicorn -w >1) would shard
#     the cache across workers and /measure could miss the worker that owns
#     the latest /execute. For Phase 2 the kernel runs single-process.
#   - The cache holds references to OCCT shapes — large docs grow the resident
#     set until the next /execute overwrites them. Acceptable for kernel use.

_last_execution_ns:     dict | None = None
_last_execution_result: dict | None = None


# ── Routes ───────────────────────────────────────────────────────────────────

@app.route("/health", methods=["GET"])
def health():
    try:
        import build123d
        b123d_version = getattr(build123d, "__version__", "unknown")
    except Exception:
        b123d_version = "unknown"
    return jsonify({"ok": True, "server": "paraform-b123d", "build123d_version": b123d_version})


@app.route("/version", methods=["GET"])
def version():
    return jsonify(_KERNEL_VERSION)


@app.route("/execute", methods=["POST"])
def execute():
    # Supabase auth + daily-cap gate. No-op unless REQUIRE_AUTH is set, so
    # local dev keeps working with zero configuration.
    gate = gate_request(request, "execute")
    if gate is not None:
        body, status = gate
        return jsonify(body), status

    data = request.get_json(force=True, silent=True) or {}
    code = data.get("code", "").strip()
    formats = data.get("formats") or ()
    # Tessellation chord-deviation tolerance in mm. Clamp to a safe band
    # so a stray slider value can't lock the kernel for minutes.
    raw_def = data.get("deflection", 0.1)
    try:
        deflection = float(raw_def)
    except (TypeError, ValueError):
        deflection = 0.1
    deflection = max(0.001, min(1.0, deflection))

    if not code:
        return jsonify({"ok": False, "error": "Empty code payload", "kernelVersion": _KERNEL_VERSION}), 400

    # Serialize the actual kernel build + cache write (OCCT isn't thread-safe);
    # connection handling stays concurrent via threaded=True.
    try:
        with _kernel_lock:
            result = execute_b123d(code, formats=tuple(formats), deflection=deflection)

            # Attach kernel version to every response — clients route geometry
            # to warnings if the kernel that produced it drifts from the doc's
            # saved pin.
            if isinstance(result, dict):
                result["kernelVersion"] = _KERNEL_VERSION

            # Pop the private fields the harness stashes for /measure so they
            # don't leak into the JSON response (build123d Body objects aren't
            # serialisable and would crash jsonify). Populate the process-local
            # last-execution cache on success — inside the lock so /measure
            # never observes a half-updated cache.
            ns      = result.pop("__namespace__", None) if isinstance(result, dict) else None
            raw_res = result.pop("__result__",    None) if isinstance(result, dict) else None
            topo    = result.pop("__topology__",  None) if isinstance(result, dict) else None

            if result.get("ok") and ns is not None and raw_res is not None:
                # Stash the live shapes for /measure. Include the freshly-built
                # topology so descriptor resolution doesn't have to rebuild it.
                if isinstance(raw_res, dict) and topo is not None:
                    raw_res["__topology__"] = topo
                global _last_execution_ns, _last_execution_result
                _last_execution_ns     = ns
                _last_execution_result = raw_res
    except Exception as e:
        return jsonify({
            "ok": False,
            "error": str(e),
            "traceback": traceback.format_exc(),
            "kernelVersion": _KERNEL_VERSION,
        }), 500

    if not result.get("ok"):
        return jsonify(result), 400

    return jsonify(result)


@app.route("/measure", methods=["POST"])
def measure_route():
    """Run a list of measure queries against the most recent /execute state.

    The kernel is otherwise stateless; this endpoint pulls from the process
    cache populated at the tail of /execute. If no execute has run yet — or
    the last one failed — the cache is empty and we surface that as a 400.
    """
    # Same gate + cap bucket as /execute — both are kernel touches.
    gate = gate_request(request, "execute")
    if gate is not None:
        body, status = gate
        return jsonify(body), status

    if _last_execution_ns is None or _last_execution_result is None:
        return jsonify({
            "ok": False,
            "error": "no document built yet — call /execute first",
            "kernelVersion": _KERNEL_VERSION,
        }), 400

    data = request.get_json(force=True, silent=True) or {}
    queries = data.get("queries") or []
    if not isinstance(queries, list):
        return jsonify({
            "ok": False,
            "error": "'queries' must be a list",
            "kernelVersion": _KERNEL_VERSION,
        }), 400

    # Per-query error isolation lives inside `measure.measure_query` — one
    # bad entry can't fail the whole batch. The result list is positional
    # with the input so callers can zip(queries, results). Hold the kernel
    # lock for the duration so a concurrent /execute can't swap the cached
    # shapes mid-batch (threaded=True makes that race real).
    results: list = []
    with _kernel_lock:
        for q in queries:
            try:
                results.append(measure.measure_query(q, _last_execution_ns, _last_execution_result))
            except Exception as e:
                # Defence in depth — `measure_query` already catches but we wrap
                # again so a truly pathological case still produces a clean entry.
                results.append({"ok": False, "error": f"unhandled: {e}"})

    return jsonify({
        "ok": True,
        "results": results,
        "kernelVersion": _KERNEL_VERSION,
    })


# ── Standard parts library ───────────────────────────────────────────────────


@app.route("/library", methods=["GET"])
def library_index():
    """Browse the standard-parts catalog.

    Returns the wire-safe view of every entry (no `_build` references,
    no private keys). Lightweight — just the metadata the LibraryDialog
    needs to render cards + search. The actual GLB is fetched on-demand
    via /library/<id>.
    """
    return jsonify({
        "ok": True,
        "entries": _library_catalog.public_list(),
        "kernelVersion": _KERNEL_VERSION,
    })


@app.route("/library/<entry_id>", methods=["GET"])
def library_entry(entry_id: str):
    """Fetch one catalog entry + its base64-encoded GLB.

    On miss the cache builds the body lazily and stores the GLB; on a
    repeat hit it's served from the in-process dict.

    400 on builder/export errors so the client can surface a kernel-side
    failure without 500ing the whole app; 404 on unknown id.
    """
    entry = _library_catalog.get(entry_id)
    if entry is None:
        return jsonify({
            "ok": False,
            "error": "unknown entry id",
            "kernelVersion": _KERNEL_VERSION,
        }), 404
    try:
        glb_bytes = _library_cache.get_glb(entry_id)
    except Exception as e:
        return jsonify({
            "ok": False,
            "error": f"library build failed: {e}",
            "traceback": traceback.format_exc(),
            "kernelVersion": _KERNEL_VERSION,
        }), 400
    if glb_bytes is None:
        # Defence in depth — catalog.get + cache.get_glb agreed the id is
        # unknown after we already checked. Surface as 404.
        return jsonify({
            "ok": False,
            "error": "unknown entry id",
            "kernelVersion": _KERNEL_VERSION,
        }), 404
    import base64 as _b64
    return jsonify({
        "ok": True,
        "entry": _library_catalog.public_entry(entry),
        "glbBase64": _b64.b64encode(glb_bytes).decode("ascii"),
        "kernelVersion": _KERNEL_VERSION,
    })


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 7823
    print(f"[paraform] build123d server -> http://localhost:{port}")
    print(f"[paraform] kernel version: build123d={_KERNEL_VERSION['build123d']} "
          f"occt={_KERNEL_VERSION['occt']} python={_KERNEL_VERSION['python']} "
          f"buildHash={_KERNEL_VERSION['buildHash']}")
    if _KERNEL_VERSION.get("mismatches"):
        print(f"[paraform] WARNING: version mismatches vs VERSIONS.json: {_KERNEL_VERSION['mismatches']}")
    print(f"[paraform] Expose via: cloudflared tunnel --url http://localhost:{port}")
    # threaded=True so idle keep-alive connections / slow builds can't wedge
    # the server (the old threaded=False deadlocked under the studio's
    # keep-alive sockets, leaving placed parts un-rendered). build123d/OCCT
    # thread-safety is preserved by serializing every kernel touch through
    # `_kernel_lock` in the /execute and /measure routes.
    app.run(host="0.0.0.0", port=port, debug=False, threaded=True)
