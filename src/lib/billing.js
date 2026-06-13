/**
 * billing.js — framework-free client for the Phase 4 billing endpoints.
 *
 * Resolves the engine base URL and the Bearer token EXACTLY like the kernel /
 * AI clients (see lib/document/kernel_client.js and
 * src/lib/auth/session.svelte.js): Vite env var first, then a localhost
 * sidecar when the page is on localhost, then the production window global.
 *
 * No Svelte runes here — plain async functions so it can be imported by both
 * the session store and view components.
 */

import { getAuthToken } from '../../lib/auth_token.js';

/** Backend (engine) base URL — mirrors kernel_client.js DEFAULT_ENDPOINT. */
function engineBase() {
  if (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_ENGINE_URL) {
    return import.meta.env.VITE_ENGINE_URL;
  }
  if (typeof window !== 'undefined') {
    const host = (window.location && window.location.hostname) || '';
    if (host === 'localhost' || host === '127.0.0.1') return 'http://localhost:7823';
    if (window.__PARAFORM_ENGINE_URL__) return window.__PARAFORM_ENGINE_URL__;
  }
  return '';
}

async function authHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  const token = await getAuthToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/**
 * Start a Stripe (or equivalent) checkout. On success the backend returns a
 * redirect URL and we navigate there. On a known failure we throw an Error
 * with a friendly, user-facing message.
 */
export async function startCheckout() {
  const base = engineBase();
  let res;
  try {
    res = await fetch(`${base}/billing/checkout`, {
      method: 'POST',
      headers: await authHeaders(),
      body: '{}',
    });
  } catch {
    throw new Error('Could not reach the billing service. Check your connection and try again.');
  }

  const json = await res.json().catch(() => null);

  if (res.ok && json && json.ok && json.url) {
    window.location.href = json.url;
    return;
  }

  if (res.status === 401) {
    throw new Error('Please sign in first.');
  }
  if (res.status === 503 || (json && json.code === 'billing_unconfigured')) {
    throw new Error("Billing isn't enabled on this deployment yet.");
  }
  throw new Error('Something went wrong starting checkout. Please try again.');
}

/**
 * Open the customer billing portal (manage subscription / cancel). Redirects
 * to the returned URL, or throws a friendly Error on failure.
 */
export async function openBillingPortal() {
  const base = engineBase();
  let res;
  try {
    res = await fetch(`${base}/billing/portal`, {
      method: 'POST',
      headers: await authHeaders(),
      body: '{}',
    });
  } catch {
    throw new Error('Could not reach the billing service. Check your connection and try again.');
  }

  const json = await res.json().catch(() => null);

  if (res.ok && json && json.ok && json.url) {
    window.location.href = json.url;
    return;
  }

  if (res.status === 401) {
    throw new Error('Please sign in first.');
  }
  if (res.status === 503 || res.status === 404 || (json && json.code === 'billing_unconfigured')) {
    throw new Error("Billing isn't available on this deployment yet.");
  }
  throw new Error('Could not open the billing portal. Please try again.');
}

/**
 * Convenience helper: GET the current account plan + usage. Returns the parsed
 * JSON envelope ({ ok, plan, usage }) or null on any error. The session store
 * owns its own copy; this is here for callers that just need a snapshot.
 */
export async function fetchAccount() {
  const base = engineBase();
  try {
    const res = await fetch(`${base}/billing/me`, {
      method: 'GET',
      headers: await authHeaders(),
    });
    if (!res.ok) return null;
    return await res.json().catch(() => null);
  } catch {
    return null;
  }
}
