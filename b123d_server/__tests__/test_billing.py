"""
Unit tests for b123d_server/billing.py — pure in-process, no network, no real
Stripe. verify_token / get_plan / get_usage are patched on the billing module;
the Flask app is built fresh per-test and driven with app.test_client().

Runs under pytest (`python -m pytest b123d_server/__tests__/test_billing.py -q`)
or plain unittest (`python b123d_server/__tests__/test_billing.py`).
"""

import os
import sys
import unittest
from unittest import mock

# Make `import billing` work no matter where the runner's cwd is.
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), os.pardir))

from flask import Flask

import billing  # noqa: E402


def _make_client():
    app = Flask(__name__)
    billing.register_billing_routes(app)
    return app.test_client()


def _bearer(token="tok"):
    return {"Authorization": f"Bearer {token}"}


class BillingTestCase(unittest.TestCase):
    def setUp(self):
        # Scrub all billing-related env so ambient values can't leak in.
        scrubbed = {k: "" for k in (
            "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PRICE_ID",
            "APP_URL", "SUPABASE_URL", "VITE_SUPABASE_URL",
            "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEY",
        )}
        env_patch = mock.patch.dict(os.environ, scrubbed)
        env_patch.start()
        self.addCleanup(env_patch.stop)
        self.client = _make_client()


class TestBillingMe(BillingTestCase):
    def test_me_without_identity_returns_free_payload(self):
        with mock.patch.object(billing, "verify_token", return_value=None):
            resp = self.client.get("/billing/me")
        self.assertEqual(resp.status_code, 200)
        body = resp.get_json()
        self.assertTrue(body["ok"])
        self.assertEqual(body["plan"], "free")
        self.assertEqual(body["usage"]["ai"]["cap"], 15)
        self.assertEqual(body["usage"]["execute"]["cap"], 60)
        self.assertEqual(body["usage"]["ai"]["count"], 0)

    def test_me_with_identity_returns_plan_and_usage(self):
        identity = {"user_id": "u1", "email": "u@example.com"}
        usage = {"ai": {"count": 3, "cap": 200},
                 "execute": {"count": 7, "cap": 1000}}
        with mock.patch.object(billing, "verify_token", return_value=identity), \
             mock.patch.object(billing, "get_plan", return_value="paid"), \
             mock.patch.object(billing, "get_usage", return_value=usage):
            resp = self.client.get("/billing/me", headers=_bearer())
        self.assertEqual(resp.status_code, 200)
        body = resp.get_json()
        self.assertTrue(body["ok"])
        self.assertEqual(body["plan"], "paid")
        self.assertEqual(body["usage"], usage)


class TestBillingCheckout(BillingTestCase):
    def test_checkout_no_identity_is_401(self):
        with mock.patch.object(billing, "verify_token", return_value=None):
            resp = self.client.post("/billing/checkout")
        self.assertEqual(resp.status_code, 401)
        self.assertEqual(resp.get_json()["code"], "auth_required")

    def test_checkout_unconfigured_is_503(self):
        identity = {"user_id": "u1", "email": "u@example.com"}
        # STRIPE_SECRET_KEY/PRICE_ID scrubbed in setUp.
        with mock.patch.object(billing, "verify_token", return_value=identity):
            resp = self.client.post("/billing/checkout", headers=_bearer())
        self.assertEqual(resp.status_code, 503)
        body = resp.get_json()
        self.assertFalse(body["ok"])
        self.assertEqual(body["code"], "billing_unconfigured")

    def test_checkout_configured_returns_url(self):
        identity = {"user_id": "u1", "email": "u@example.com"}

        fake_session = mock.Mock(url="https://stripe.test/checkout/abc")
        fake_stripe = mock.Mock()
        fake_stripe.checkout.Session.create.return_value = fake_session

        with mock.patch.dict(os.environ, {
            "STRIPE_SECRET_KEY": "sk_test", "STRIPE_PRICE_ID": "price_test",
            "APP_URL": "http://localhost:1420",
        }), \
             mock.patch.object(billing, "verify_token", return_value=identity), \
             mock.patch.object(billing, "_import_stripe", return_value=fake_stripe):
            resp = self.client.post("/billing/checkout", headers=_bearer())

        self.assertEqual(resp.status_code, 200)
        body = resp.get_json()
        self.assertTrue(body["ok"])
        self.assertEqual(body["url"], "https://stripe.test/checkout/abc")
        # Verify the contract passed to Stripe.
        _, kwargs = fake_stripe.checkout.Session.create.call_args
        self.assertEqual(kwargs["mode"], "subscription")
        self.assertEqual(kwargs["client_reference_id"], "u1")
        self.assertEqual(kwargs["customer_email"], "u@example.com")
        self.assertEqual(kwargs["line_items"], [{"price": "price_test", "quantity": 1}])


class TestBillingPortal(BillingTestCase):
    def test_portal_no_identity_is_401(self):
        with mock.patch.object(billing, "verify_token", return_value=None):
            resp = self.client.post("/billing/portal")
        self.assertEqual(resp.status_code, 401)

    def test_portal_no_customer_is_404(self):
        identity = {"user_id": "u1", "email": "u@example.com"}
        with mock.patch.dict(os.environ, {"STRIPE_SECRET_KEY": "sk_test"}), \
             mock.patch.object(billing, "verify_token", return_value=identity), \
             mock.patch.object(billing, "_customer_id_for", return_value=None):
            resp = self.client.post("/billing/portal", headers=_bearer())
        self.assertEqual(resp.status_code, 404)
        self.assertEqual(resp.get_json()["code"], "no_customer")


class TestBillingWebhook(BillingTestCase):
    def test_webhook_unconfigured_is_503(self):
        # No STRIPE_WEBHOOK_SECRET.
        resp = self.client.post("/billing/webhook", data=b"{}")
        self.assertEqual(resp.status_code, 503)

    def test_webhook_bad_signature_is_400(self):
        fake_stripe = mock.Mock()
        fake_stripe.Webhook.construct_event.side_effect = ValueError("bad sig")
        with mock.patch.dict(os.environ, {"STRIPE_WEBHOOK_SECRET": "whsec_test"}), \
             mock.patch.object(billing, "_import_stripe", return_value=fake_stripe):
            resp = self.client.post("/billing/webhook", data=b"{}",
                                    headers={"Stripe-Signature": "garbage"})
        self.assertEqual(resp.status_code, 400)
        self.assertEqual(resp.get_json()["error"], "bad signature")

    def test_webhook_missing_signature_is_400(self):
        fake_stripe = mock.Mock()
        fake_stripe.Webhook.construct_event.side_effect = ValueError("no sig")
        with mock.patch.dict(os.environ, {"STRIPE_WEBHOOK_SECRET": "whsec_test"}), \
             mock.patch.object(billing, "_import_stripe", return_value=fake_stripe):
            resp = self.client.post("/billing/webhook", data=b"{}")
        self.assertEqual(resp.status_code, 400)

    def test_webhook_checkout_completed_sets_paid(self):
        event = {
            "type": "checkout.session.completed",
            "data": {"object": {
                "client_reference_id": "u1",
                "customer": "cus_123",
                "subscription": "sub_456",
            }},
        }
        fake_stripe = mock.Mock()
        fake_stripe.Webhook.construct_event.return_value = event
        with mock.patch.dict(os.environ, {"STRIPE_WEBHOOK_SECRET": "whsec_test"}), \
             mock.patch.object(billing, "_import_stripe", return_value=fake_stripe), \
             mock.patch.object(billing, "_set_plan") as set_plan:
            resp = self.client.post("/billing/webhook", data=b"{}",
                                    headers={"Stripe-Signature": "sig"})
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(resp.get_json()["ok"])
        set_plan.assert_called_once_with(
            "u1", "paid",
            stripe_customer_id="cus_123",
            stripe_subscription_id="sub_456",
            plan_status="active",
        )

    def test_webhook_subscription_deleted_sets_free(self):
        event = {
            "type": "customer.subscription.deleted",
            "data": {"object": {"customer": "cus_123"}},
        }
        fake_stripe = mock.Mock()
        fake_stripe.Webhook.construct_event.return_value = event
        with mock.patch.dict(os.environ, {"STRIPE_WEBHOOK_SECRET": "whsec_test"}), \
             mock.patch.object(billing, "_import_stripe", return_value=fake_stripe), \
             mock.patch.object(billing, "_user_by_customer", return_value="u1"), \
             mock.patch.object(billing, "_set_plan") as set_plan:
            resp = self.client.post("/billing/webhook", data=b"{}",
                                    headers={"Stripe-Signature": "sig"})
        self.assertEqual(resp.status_code, 200)
        set_plan.assert_called_once_with("u1", "free", plan_status="canceled")

    def test_webhook_ignored_event_is_200(self):
        event = {"type": "invoice.paid", "data": {"object": {}}}
        fake_stripe = mock.Mock()
        fake_stripe.Webhook.construct_event.return_value = event
        with mock.patch.dict(os.environ, {"STRIPE_WEBHOOK_SECRET": "whsec_test"}), \
             mock.patch.object(billing, "_import_stripe", return_value=fake_stripe):
            resp = self.client.post("/billing/webhook", data=b"{}",
                                    headers={"Stripe-Signature": "sig"})
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(resp.get_json()["ok"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
