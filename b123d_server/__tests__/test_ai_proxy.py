"""
Unit tests for b123d_server/ai_proxy.py — v1 bring-your-own-key contract.

v1 rule: /ai/chat MUST carry an `X-Provider-Api-Key` header. The kernel's env
keys (ANTHROPIC_API_KEY / GEMINI_API_KEY / OPENAI_API_KEY) are NOT a fallback
and cannot be reached by other users' requests. These tests pin that contract.

Pure in-process: requests.post is patched so no real provider is hit, and the
Flask app is built fresh per test with app.test_client(). The auth gate is open
(REQUIRE_AUTH scrubbed) so /ai/chat runs without a Supabase session.

Runs under pytest (`python -m pytest b123d_server/__tests__/test_ai_proxy.py -q`)
or plain unittest (`python b123d_server/__tests__/test_ai_proxy.py`).
"""

import os
import sys
import unittest
from unittest import mock

# Make `import ai_proxy` work no matter where the runner's cwd is.
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), os.pardir))

from flask import Flask

import ai_proxy  # noqa: E402


class _FakeResp:
    """Minimal stand-in for a requests.Response on the non-streaming path."""

    def __init__(self, status_code=200, text='{"ok": true}'):
        self.status_code = status_code
        self.text = text

    def close(self):
        pass


def _make_client():
    app = Flask(__name__)
    ai_proxy.register_ai_routes(app)
    return app.test_client()


class AiProxyTestCase(unittest.TestCase):
    def setUp(self):
        # Scrub provider + auth env so ambient keys can't leak into assertions
        # AND so we can verify env-key paths are actually dead (no fallback).
        scrubbed = {k: "" for k in (
            "OPENAI_API_KEY", "OPENAI_BASE_URL",
            "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY",
            "REQUIRE_AUTH",
        )}
        env_patch = mock.patch.dict(os.environ, scrubbed)
        env_patch.start()
        self.addCleanup(env_patch.stop)
        self.client = _make_client()

    def _post(self, payload, headers=None):
        captured = {}

        def fake_post(url, headers=None, data=None, stream=False, timeout=None):
            captured["url"] = url
            captured["headers"] = headers or {}
            return _FakeResp()

        with mock.patch.object(ai_proxy.requests, "post", side_effect=fake_post):
            resp = self.client.post("/ai/chat", json=payload, headers=headers or {})
        return resp, captured


class TestClientKeyRequired(AiProxyTestCase):
    """v1 rule: no client key → 503, regardless of env."""

    def test_no_key_anywhere_returns_503(self):
        resp, _ = self._post(
            {"provider": "openai", "messages": [], "stream": False},
            headers={},
        )
        self.assertEqual(resp.status_code, 503)
        body = resp.get_json()
        self.assertIn("Settings", body.get("error", ""))
        self.assertIn("bring their own key", body.get("error", "").lower() + "")

    def test_env_key_alone_is_NOT_a_fallback_openai(self):
        # Even with OPENAI_API_KEY set on the kernel, a request without the
        # client header is rejected — proving the env key is unreachable from
        # user requests.
        with mock.patch.dict(os.environ, {"OPENAI_API_KEY": "sk-env-NEVER-USED"}):
            resp, _ = self._post(
                {"provider": "openai", "messages": [], "stream": False},
                headers={},
            )
        self.assertEqual(resp.status_code, 503)

    def test_env_key_alone_is_NOT_a_fallback_gemini(self):
        with mock.patch.dict(os.environ, {"GEMINI_API_KEY": "AIza-env-NEVER-USED"}):
            resp, _ = self._post(
                {"provider": "gemini", "messages": [], "stream": False},
                headers={},
            )
        self.assertEqual(resp.status_code, 503)

    def test_env_key_alone_is_NOT_a_fallback_anthropic(self):
        with mock.patch.dict(os.environ, {"ANTHROPIC_API_KEY": "sk-ant-env-NEVER-USED"}):
            resp, _ = self._post(
                {"provider": "anthropic", "messages": [], "stream": False},
                headers={},
            )
        self.assertEqual(resp.status_code, 503)


class TestBringYourOwnKey(AiProxyTestCase):
    """v1 rule: a request WITH a client key succeeds and uses that key upstream."""

    def test_openai_client_key_succeeds_and_is_used(self):
        resp, captured = self._post(
            {"provider": "openai", "model": "openai/gpt-oss-120b",
             "messages": [], "stream": False},
            headers={
                "X-Provider-Api-Key": "sk-byok-openai",
                "X-Provider-Base-Url": "https://api.groq.com/openai/v1",
            },
        )
        self.assertEqual(resp.status_code, 200, resp.get_data(as_text=True))
        self.assertEqual(captured["headers"].get("Authorization"), "Bearer sk-byok-openai")
        self.assertEqual(captured["url"], "https://api.groq.com/openai/v1/chat/completions")

    def test_anthropic_client_key_succeeds_and_is_used(self):
        resp, captured = self._post(
            {"provider": "anthropic", "model": "claude-opus-4-8",
             "messages": [], "stream": False},
            headers={"X-Provider-Api-Key": "sk-ant-byok"},
        )
        self.assertEqual(resp.status_code, 200, resp.get_data(as_text=True))
        self.assertEqual(captured["headers"].get("x-api-key"), "sk-ant-byok")
        self.assertEqual(captured["url"], ai_proxy.ANTHROPIC_URL)

    def test_gemini_client_key_succeeds_and_is_used(self):
        resp, captured = self._post(
            {"provider": "gemini", "model": "gemini-2.5-flash",
             "messages": [], "stream": False},
            headers={"X-Provider-Api-Key": "AIza-byok"},
        )
        self.assertEqual(resp.status_code, 200, resp.get_data(as_text=True))
        self.assertEqual(captured["headers"].get("x-goog-api-key"), "AIza-byok")

    def test_client_key_used_even_when_env_is_set(self):
        # Both present: client key still wins (and env key isn't reached).
        with mock.patch.dict(os.environ, {"OPENAI_API_KEY": "sk-env-IGNORED"}):
            resp, captured = self._post(
                {"provider": "openai", "messages": [], "stream": False},
                headers={"X-Provider-Api-Key": "sk-client-wins"},
            )
        self.assertEqual(resp.status_code, 200, resp.get_data(as_text=True))
        self.assertEqual(captured["headers"].get("Authorization"), "Bearer sk-client-wins")


class TestHealth(AiProxyTestCase):
    """v1 /ai/health: never reports env keys as a usable source."""

    def test_health_reports_requires_user_key_even_when_env_is_set(self):
        with mock.patch.dict(os.environ, {
            "ANTHROPIC_API_KEY": "sk-ant-env",
            "GEMINI_API_KEY": "AIza-env",
            "OPENAI_API_KEY": "sk-env",
        }):
            resp = self.client.get("/ai/health")
        self.assertEqual(resp.status_code, 200)
        body = resp.get_json()
        self.assertTrue(body["ok"])
        self.assertTrue(body.get("requires_user_key"))
        # Per-provider flags must NOT say configured=true even with env set,
        # because env keys aren't a usable source under the v1 contract.
        self.assertFalse(body["anthropic"]["configured"])
        self.assertFalse(body["gemini"]["configured"])
        self.assertFalse(body["openai"]["configured"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
