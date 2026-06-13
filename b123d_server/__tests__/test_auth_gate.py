"""
Unit tests for b123d_server/auth_gate.py — pure in-process, no network.

Every HTTP touch goes through auth_gate.requests.{get,post}, which these
tests replace with fakes; os.environ is patched per-test. Runs under pytest
(`python -m pytest b123d_server/__tests__/test_auth_gate.py -q`) or plain
unittest (`python b123d_server/__tests__/test_auth_gate.py`).
"""

import os
import sys
import unittest
from unittest import mock

# Make `import auth_gate` work no matter where the runner's cwd is.
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), os.pardir))

import auth_gate  # noqa: E402


SUPABASE_ENV = {
    "REQUIRE_AUTH": "1",
    "SUPABASE_URL": "https://example.supabase.co",
    "SUPABASE_PUBLISHABLE_KEY": "sb_publishable_test",
}


class FakeResponse:
    def __init__(self, status_code=200, payload=None):
        self.status_code = status_code
        self._payload = payload

    def json(self):
        return self._payload


class FakeRequest:
    """Stand-in for flask.request — only .headers.get is consulted."""

    def __init__(self, token=None):
        self.headers = {"Authorization": f"Bearer {token}"} if token else {}


def _auth_user_response(user_id="user-1", email="u@example.com"):
    return FakeResponse(200, {"id": user_id, "email": email})


class AuthGateTestCase(unittest.TestCase):
    """Common scaffolding: clean module state + a scrubbed environment."""

    def setUp(self):
        auth_gate._reset_state_for_tests()
        # Scrub every gate-related var so ambient .env values (REQUIRE_AUTH,
        # VITE_SUPABASE_*, service keys, CAP_*) can't leak into tests.
        scrubbed = {k: "" for k in (
            "REQUIRE_AUTH", "SUPABASE_URL", "VITE_SUPABASE_URL",
            "SUPABASE_PUBLISHABLE_KEY", "VITE_SUPABASE_PUBLISHABLE_KEY",
            "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEY",
            "CAP_AI_PER_DAY", "CAP_EXECUTE_PER_DAY",
            "CAP_AI_PER_DAY_PRO", "CAP_EXECUTE_PER_DAY_PRO",
        )}
        env_patch = mock.patch.dict(os.environ, scrubbed)
        env_patch.start()
        self.addCleanup(env_patch.stop)
        self.addCleanup(auth_gate._reset_state_for_tests)

    def set_env(self, **kv):
        patch = mock.patch.dict(os.environ, kv)
        patch.start()
        self.addCleanup(patch.stop)


class TestAuthOff(AuthGateTestCase):
    def test_gate_passes_and_makes_no_http_calls(self):
        with mock.patch.object(auth_gate.requests, "get") as get, \
             mock.patch.object(auth_gate.requests, "post") as post:
            self.assertIsNone(auth_gate.gate_request(FakeRequest(), "execute"))
            self.assertIsNone(auth_gate.gate_request(FakeRequest("tok"), "ai"))
        get.assert_not_called()
        post.assert_not_called()
        self.assertFalse(auth_gate.auth_required())


class TestAuthRequired(AuthGateTestCase):
    def test_missing_token_is_401(self):
        self.set_env(**SUPABASE_ENV)
        body, status = auth_gate.gate_request(FakeRequest(), "execute")
        self.assertEqual(status, 401)
        self.assertFalse(body["ok"])
        self.assertEqual(body["code"], "auth_required")

    def test_invalid_token_is_401(self):
        self.set_env(**SUPABASE_ENV)
        with mock.patch.object(auth_gate.requests, "get",
                               return_value=FakeResponse(401, {"msg": "bad jwt"})):
            body, status = auth_gate.gate_request(FakeRequest("bad-token"), "execute")
        self.assertEqual(status, 401)
        self.assertEqual(body["code"], "auth_required")

    def test_valid_token_under_cap_is_allowed_and_counted(self):
        self.set_env(**SUPABASE_ENV)
        with mock.patch.object(auth_gate.requests, "get",
                               return_value=_auth_user_response()):
            self.assertIsNone(auth_gate.gate_request(FakeRequest("good-token"), "execute"))
        # The request was counted in the in-memory floor.
        allowed, count, cap = auth_gate.check_and_count("user-1", "execute")
        self.assertTrue(allowed)
        self.assertEqual(count, 2)   # gate call counted 1, this call counted 2
        self.assertEqual(cap, 60)    # free-plan execute default

    def test_over_cap_is_429_with_details(self):
        self.set_env(**SUPABASE_ENV, CAP_AI_PER_DAY="2")
        with mock.patch.object(auth_gate.requests, "get",
                               return_value=_auth_user_response()):
            self.assertIsNone(auth_gate.gate_request(FakeRequest("good-token"), "ai"))
            self.assertIsNone(auth_gate.gate_request(FakeRequest("good-token"), "ai"))
            body, status = auth_gate.gate_request(FakeRequest("good-token"), "ai")
        self.assertEqual(status, 429)
        self.assertEqual(body["code"], "rate_limited")
        self.assertEqual(body["error"], "daily ai limit reached")
        self.assertEqual(body["count"], 3)
        self.assertEqual(body["cap"], 2)
        self.assertEqual(body["plan"], "free")

    def test_caps_are_independent_per_kind(self):
        self.set_env(**SUPABASE_ENV, CAP_AI_PER_DAY="1")
        with mock.patch.object(auth_gate.requests, "get",
                               return_value=_auth_user_response()):
            self.assertIsNone(auth_gate.gate_request(FakeRequest("good-token"), "ai"))
            _, status = auth_gate.gate_request(FakeRequest("good-token"), "ai")
            self.assertEqual(status, 429)
            # 'execute' bucket is untouched by the exhausted 'ai' bucket.
            self.assertIsNone(auth_gate.gate_request(FakeRequest("good-token"), "execute"))


class TestProPlan(AuthGateTestCase):
    def test_paid_plan_gets_pro_caps(self):
        self.set_env(**SUPABASE_ENV, SUPABASE_SERVICE_ROLE_KEY="sb_secret_test")

        def fake_get(url, **kwargs):
            if "/auth/v1/user" in url:
                return _auth_user_response("pro-user")
            if "/rest/v1/profiles" in url:
                return FakeResponse(200, [{"plan": "paid"}])
            raise AssertionError(f"unexpected GET {url}")

        def fake_post(url, **kwargs):
            if "/rest/v1/rpc/increment_usage" in url:
                return FakeResponse(200, 1)
            raise AssertionError(f"unexpected POST {url}")

        with mock.patch.object(auth_gate.requests, "get", side_effect=fake_get), \
             mock.patch.object(auth_gate.requests, "post", side_effect=fake_post):
            self.assertEqual(auth_gate.get_plan("pro-user"), "paid")
            allowed, count, cap = auth_gate.check_and_count("pro-user", "ai")
            self.assertTrue(allowed)
            self.assertEqual(cap, 200)   # pro AI default, not free's 15
            allowed, count, cap = auth_gate.check_and_count("pro-user", "execute")
            self.assertEqual(cap, 1000)  # pro execute default

    def test_plan_lookup_failure_defaults_to_free(self):
        self.set_env(**SUPABASE_ENV, SUPABASE_SERVICE_ROLE_KEY="sb_secret_test")
        with mock.patch.object(auth_gate.requests, "get",
                               side_effect=auth_gate.requests.RequestException("down")):
            self.assertEqual(auth_gate.get_plan("user-1"), "free")


class TestTokenCache(AuthGateTestCase):
    def test_second_verify_hits_cache_not_http(self):
        self.set_env(**SUPABASE_ENV)
        with mock.patch.object(auth_gate.requests, "get",
                               return_value=_auth_user_response()) as get:
            first = auth_gate.verify_token("cached-token")
            second = auth_gate.verify_token("cached-token")
        self.assertEqual(first, {"user_id": "user-1", "email": "u@example.com"})
        self.assertEqual(second, first)
        self.assertEqual(get.call_count, 1)

    def test_failed_verify_is_not_cached(self):
        self.set_env(**SUPABASE_ENV)
        with mock.patch.object(auth_gate.requests, "get",
                               return_value=FakeResponse(401, {})) as get:
            self.assertIsNone(auth_gate.verify_token("bad"))
            self.assertIsNone(auth_gate.verify_token("bad"))
        self.assertEqual(get.call_count, 2)


class TestInMemoryFallback(AuthGateTestCase):
    def test_no_service_key_counts_in_memory_only(self):
        self.set_env(**SUPABASE_ENV)  # no service key
        with mock.patch.object(auth_gate.requests, "post") as post:
            for expected in (1, 2, 3):
                allowed, count, cap = auth_gate.check_and_count("user-1", "execute")
                self.assertTrue(allowed)
                self.assertEqual(count, expected)
        post.assert_not_called()  # RPC never attempted without a service key

    def test_rpc_outage_falls_back_to_memory_counter(self):
        self.set_env(**SUPABASE_ENV, SUPABASE_SERVICE_ROLE_KEY="sb_secret_test")

        def fake_get(url, **kwargs):
            return FakeResponse(200, [{"plan": "free"}])

        with mock.patch.object(auth_gate.requests, "get", side_effect=fake_get), \
             mock.patch.object(auth_gate.requests, "post",
                               side_effect=auth_gate.requests.RequestException("down")):
            allowed, count, cap = auth_gate.check_and_count("user-1", "ai")
            self.assertTrue(allowed)
            self.assertEqual(count, 1)   # memory floor survives the outage
            allowed, count, cap = auth_gate.check_and_count("user-1", "ai")
            self.assertEqual(count, 2)

    def test_remote_count_dominates_when_higher(self):
        # Kernel restarted mid-day: memory says 1, Supabase says 41.
        self.set_env(**SUPABASE_ENV, SUPABASE_SERVICE_ROLE_KEY="sb_secret_test")

        def fake_get(url, **kwargs):
            return FakeResponse(200, [{"plan": "free"}])

        with mock.patch.object(auth_gate.requests, "get", side_effect=fake_get), \
             mock.patch.object(auth_gate.requests, "post",
                               return_value=FakeResponse(200, 41)):
            allowed, count, cap = auth_gate.check_and_count("user-1", "execute")
        self.assertTrue(allowed)
        self.assertEqual(count, 41)


if __name__ == "__main__":
    unittest.main(verbosity=2)
