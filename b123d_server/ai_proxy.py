"""
Server-side AI proxy — keeps provider API keys off the browser client.

The Svelte studio (dev server on http://localhost:1420) cannot hold provider
API keys safely, so it never talks to api.anthropic.com or
generativelanguage.googleapis.com directly. Instead it POSTs to this Flask
app, which injects the key from the server environment and forwards to the
selected provider's chat API.

Provider routing: the client builds the provider-correct request body (in
src/lib/ai/providers/*) and tags it with a `provider` field
(`'gemini'` | `'anthropic'`, default `'gemini'`) plus `model` + `stream`. This
proxy reads those, builds the right upstream URL + auth headers, and relays the
response (SSE bytes streamed through unchanged). The proxy does NOT interpret
tool calls or reshape the body beyond stripping its own routing fields.

Routes registered by `register_ai_routes(app)`:

  POST /ai/chat
    body: { provider, model, stream, ...provider-specific fields }
    - non-streaming → 200 JSON (the upstream response, passed through)
    - streaming     → 200 text/event-stream (raw SSE bytes proxied through)
    - 503 JSON { error: "<PROVIDER>_API_KEY not configured" } when no key.

  GET /ai/health
    → 200 JSON {
        ok: true,
        anthropic: { configured: <bool> },
        gemini:    { configured: <bool> },
        default:   "gemini",
      }
    Never echoes a key — only whether one is present.

Transport: the `requests` library with stream=True for SSE.
Env vars:
  - GEMINI_API_KEY  (falls back to GOOGLE_API_KEY)  — Gemini
  - ANTHROPIC_API_KEY                               — Anthropic
"""

import json
import os

import requests
from flask import Response, jsonify, request, stream_with_context

from auth_gate import gate_request

ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
ANTHROPIC_VERSION = "2023-06-01"
GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models"

DEFAULT_PROVIDER = "gemini"
# Defaults surfaced so a thin client can omit them. Keep in lockstep with
# src/lib/ai/agent.js DEFAULT_*_MODEL.
DEFAULT_GEMINI_MODEL = "gemini-2.5-flash"
DEFAULT_ANTHROPIC_MODEL = "claude-opus-4-8"

# Routing fields the proxy consumes and must NOT forward upstream as part of
# the provider body.
_ROUTING_FIELDS = ("provider", "model", "stream")

# Pass-through allow-list per provider. We forward only the fields the upstream
# API understands so a malformed/oversized client payload can't smuggle
# arbitrary keys upstream.
_ANTHROPIC_FIELDS = (
    "model",
    "max_tokens",
    "system",
    "messages",
    "tools",
    "tool_choice",
    "stream",
    "temperature",
    "stop_sequences",
    "thinking",
    "output_config",
    "metadata",
)
_GEMINI_FIELDS = (
    "contents",
    "systemInstruction",
    "tools",
    "toolConfig",
    "generationConfig",
    "safetySettings",
)


def _anthropic_key():
    key = os.environ.get("ANTHROPIC_API_KEY")
    return key.strip() if key else None


def _gemini_key():
    key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    return key.strip() if key else None


def _anthropic_headers(key):
    return {
        "x-api-key": key,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
    }


def _gemini_headers(key):
    return {
        "x-goog-api-key": key,
        "content-type": "application/json",
    }


def _build_anthropic_body(payload):
    """Project the client payload onto the Anthropic-allowed field set."""
    body = {}
    for field in _ANTHROPIC_FIELDS:
        if field in payload and payload[field] is not None:
            body[field] = payload[field]
    body["model"] = payload.get("model") or DEFAULT_ANTHROPIC_MODEL
    body.setdefault("max_tokens", 4096)
    # `stream` lives in the URL/header story for Anthropic too; keep it in body
    # exactly as the existing wire expects (Anthropic reads `stream`).
    if "stream" in payload:
        body["stream"] = bool(payload["stream"])
    return body


def _build_gemini_body(payload):
    """Project the client payload onto the Gemini-allowed field set."""
    body = {}
    for field in _GEMINI_FIELDS:
        if field in payload and payload[field] is not None:
            body[field] = payload[field]
    return body


def _gemini_url(model, want_stream):
    model = model or DEFAULT_GEMINI_MODEL
    if want_stream:
        return f"{GEMINI_BASE}/{model}:streamGenerateContent?alt=sse"
    return f"{GEMINI_BASE}/{model}:generateContent"


def register_ai_routes(app) -> None:
    """Attach /ai/chat + /ai/health to an existing Flask app.

    CORS is handled app-wide by the `flask_cors.CORS(app, origins="*")` call
    in server.py, so these routes inherit the same permissive policy that
    /execute and /measure use.
    """

    @app.route("/ai/health", methods=["GET"])
    def ai_health():
        return jsonify({
            "ok": True,
            "anthropic": {"configured": _anthropic_key() is not None},
            "gemini": {"configured": _gemini_key() is not None},
            "default": DEFAULT_PROVIDER,
        })

    @app.route("/ai/chat", methods=["POST"])
    def ai_chat():
        # Supabase auth + daily AI cap. No-op unless REQUIRE_AUTH is set;
        # /ai/health stays open so the studio can probe configuration.
        gate = gate_request(request, "ai")
        if gate is not None:
            body, status = gate
            return jsonify(body), status

        payload = request.get_json(force=True, silent=True) or {}
        provider = (payload.get("provider") or DEFAULT_PROVIDER).strip().lower()
        want_stream = bool(payload.get("stream"))

        if provider == "anthropic":
            key = _anthropic_key()
            if not key:
                return jsonify({"error": "ANTHROPIC_API_KEY not configured"}), 503
            url = ANTHROPIC_URL
            headers = _anthropic_headers(key)
            body = _build_anthropic_body(payload)
        elif provider == "gemini":
            key = _gemini_key()
            if not key:
                return jsonify(
                    {"error": "GEMINI_API_KEY (or GOOGLE_API_KEY) not configured"}
                ), 503
            url = _gemini_url(payload.get("model"), want_stream)
            headers = _gemini_headers(key)
            body = _build_gemini_body(payload)
        else:
            return jsonify({"error": f"unknown AI provider '{provider}'"}), 400

        if want_stream:
            return _relay_stream(url, headers, body)
        return _relay_once(url, headers, body)


def _relay_stream(url, headers, body):
    """Open the upstream with stream=True and relay each SSE chunk through."""
    try:
        upstream = requests.post(
            url,
            headers=headers,
            data=json.dumps(body),
            stream=True,
            timeout=300,
        )
    except requests.RequestException as e:
        return jsonify({"error": f"upstream request failed: {e}"}), 502

    if upstream.status_code != 200:
        detail = upstream.text
        upstream.close()
        return Response(detail, status=upstream.status_code, mimetype="application/json")

    def generate():
        try:
            for chunk in upstream.iter_content(chunk_size=None):
                if chunk:
                    yield chunk
        finally:
            upstream.close()

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


def _relay_once(url, headers, body):
    """Single round trip — return the upstream status + body unchanged."""
    try:
        upstream = requests.post(
            url,
            headers=headers,
            data=json.dumps(body),
            timeout=300,
        )
    except requests.RequestException as e:
        return jsonify({"error": f"upstream request failed: {e}"}), 502

    return Response(
        upstream.text,
        status=upstream.status_code,
        mimetype="application/json",
    )
