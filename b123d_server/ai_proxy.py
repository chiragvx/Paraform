"""
Server-side AI proxy — keeps provider API keys off the browser client.

The Svelte studio (dev server on http://localhost:1420) cannot hold provider
API keys safely, so it never talks to api.anthropic.com or
generativelanguage.googleapis.com directly. Instead it POSTs to this Flask
app, which injects the key from the server environment and forwards to the
selected provider's chat API.

Provider routing: the client builds the provider-correct request body (in
src/lib/ai/providers/*) and tags it with a `provider` field
(`'openai'` | `'anthropic'` | `'gemini'`, default `'openai'`) plus `model` +
`stream`. This proxy reads those, builds the right upstream URL + auth headers,
and relays the response (SSE bytes streamed through unchanged). The proxy does
NOT interpret tool calls or reshape the body beyond stripping its own routing
fields.

Bring-your-own key (v1): EVERY /ai/chat request MUST carry a user-supplied key
in the `X-Provider-Api-Key` header (and, for OpenAI-compatible hosts, optionally
`X-Provider-Base-Url`). The studio Settings panel collects these and stores them
in sessionStorage on the user's browser. The proxy has NO env-key fallback for
/ai/chat — so a key configured in the kernel's `.env` (e.g. for the developer's
own testing) is structurally inaccessible to other users hitting this proxy.
Without a client header the route returns 503 with a clear "add your key"
message. The env helpers are retained only for /ai/health diagnostics.

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
# OpenAI-compatible base for GPT-OSS. Overridable via OPENAI_BASE_URL so the
# same code reaches Groq / OpenRouter / Together / Fireworks / vLLM / Ollama /
# OpenAI — whichever host serves the open-weight model.
OPENAI_DEFAULT_BASE = "https://openrouter.ai/api/v1"

DEFAULT_PROVIDER = "openai"
# Defaults surfaced so a thin client can omit them. Keep in lockstep with
# src/lib/ai/agent.js DEFAULT_*_MODEL.
DEFAULT_GEMINI_MODEL = "gemini-2.5-flash"
DEFAULT_ANTHROPIC_MODEL = "claude-opus-4-8"
DEFAULT_OPENAI_MODEL = "openai/gpt-oss-120b"

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
_OPENAI_FIELDS = (
    "model",
    "messages",
    "tools",
    "tool_choice",
    "max_tokens",
    "max_completion_tokens",
    "temperature",
    "top_p",
    "stream",
    "stream_options",
    "stop",
    "reasoning_effort",
)


def _anthropic_key():
    key = os.environ.get("ANTHROPIC_API_KEY")
    return key.strip() if key else None


def _gemini_key():
    key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    return key.strip() if key else None


def _openai_key():
    # OPENAI_API_KEY is the standard name; many GPT-OSS hosts (Groq, OpenRouter,
    # Together) also issue OpenAI-compatible keys. A single env var keeps the
    # proxy host-agnostic.
    key = os.environ.get("OPENAI_API_KEY")
    return key.strip() if key else None


def _openai_base():
    base = os.environ.get("OPENAI_BASE_URL")
    return (base.strip() if base else OPENAI_DEFAULT_BASE).rstrip("/")


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


def _openai_headers(key):
    return {
        "Authorization": f"Bearer {key}",
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


def _build_openai_body(payload):
    """Project the client payload onto the OpenAI-compatible field set."""
    body = {}
    for field in _OPENAI_FIELDS:
        if field in payload and payload[field] is not None:
            body[field] = payload[field]
    body["model"] = payload.get("model") or DEFAULT_OPENAI_MODEL
    body.setdefault("max_tokens", 4096)
    if "stream" in payload:
        body["stream"] = bool(payload["stream"])
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
        # v1: requests are served only with a user-supplied X-Provider-Api-Key,
        # so reporting per-provider env presence here would be misleading. The
        # studio decides readiness by checking whether the user has entered a
        # key in Settings. We just confirm the proxy is reachable + the default.
        return jsonify({
            "ok": True,
            "default": DEFAULT_PROVIDER,
            "requires_user_key": True,
            # The per-provider "configured" fields are intentionally omitted —
            # env-keys are no longer a code path for /ai/chat.
            "anthropic": {"configured": False},
            "gemini": {"configured": False},
            "openai": {"configured": False},
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

        # v1: bring-your-own key is REQUIRED. The user enters their own key in
        # Settings → AI (stored in sessionStorage on their browser, never at
        # rest in localStorage) and the client forwards it per-request as the
        # X-Provider-Api-Key header. There is no env-key fallback for /ai/chat
        # — so an `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` / `OPENAI_API_KEY` set
        # on this kernel for the developer's own testing is structurally
        # unreachable from other users' requests.
        client_key = (request.headers.get("X-Provider-Api-Key") or "").strip() or None
        client_base = (request.headers.get("X-Provider-Base-Url") or "").strip() or None

        if not client_key:
            return jsonify({
                "error": "Add your API key in Settings → AI Assistant. v1 requires "
                         "each user to bring their own key — the kernel's env keys "
                         "are not used to serve requests."
            }), 503

        if provider == "anthropic":
            url = ANTHROPIC_URL
            headers = _anthropic_headers(client_key)
            body = _build_anthropic_body(payload)
        elif provider == "gemini":
            url = _gemini_url(payload.get("model"), want_stream)
            headers = _gemini_headers(client_key)
            body = _build_gemini_body(payload)
        elif provider == "openai":
            base = client_base or _openai_base()
            url = f"{base.rstrip('/')}/chat/completions"
            headers = _openai_headers(client_key)
            body = _build_openai_body(payload)
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
