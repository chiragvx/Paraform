/**
 * Supabase auth session store (Svelte 5 runes).
 *
 * `session` is reactive state: { user, accessToken, loading }.
 *   - loading is true from boot until the initial getSession() resolves
 *     (route gating uses it to avoid a flash-of-studio before the session
 *     is known).
 *   - user / accessToken track supabase.auth via onAuthStateChange.
 *
 * initSession() is called once from main.js. It is non-blocking — the
 * network round-trip happens in the background and flips `loading` when
 * done. It also registers the lib/auth_token.js provider so the kernel /
 * AI clients attach `Authorization: Bearer <token>` to their requests.
 * The provider re-reads supabase.auth.getSession() on every call —
 * supabase-js refreshes expired tokens internally, so the latest session's
 * access_token is always current.
 *
 * When Supabase is unconfigured (placeholder URL — see lib/cloud.js
 * isCloudEnabled), the store stays signed-out and no provider is set, so
 * the whole app behaves exactly as before.
 */

import { supabase } from '../../../lib/supabase.js';
import { isCloudEnabled } from '../../../lib/cloud.js';
import { setAuthTokenProvider, getAuthToken } from '../../../lib/auth_token.js';
import { isDesktop } from '../../../lib/platform/runtime.js';
import { DESKTOP_REDIRECT, startDesktopOAuthListener, openInSystemBrowser } from './desktop_oauth.js';

export const session = $state({
  user: null,
  accessToken: null,
  loading: true,
  plan: 'free',
  usage: null,
});

/**
 * Backend (engine) base URL — resolved exactly like the kernel / AI clients
 * (see lib/document/kernel_client.js): Vite env var first, then a localhost
 * sidecar when the page is on localhost, then the production window global.
 */
function _engineBase() {
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

/**
 * Fetch the signed-in user's plan + usage from the backend (`GET
 * /billing/me`, Bearer auth) and apply it to the session store. Never
 * throws: on any error (or when auth is unconfigured) it leaves
 * plan='free' / usage=null and returns quietly.
 */
export async function refreshAccount() {
  if (!isAuthConfigured()) {
    session.plan = 'free';
    session.usage = null;
    return;
  }
  try {
    const token = await getAuthToken();
    if (!token) return;
    const base = _engineBase();
    if (!base) return;
    const res = await fetch(`${base.replace(/\/$/, '')}/billing/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return;
    const data = await res.json();
    if (data && data.ok) {
      session.plan = data.plan === 'paid' ? 'paid' : 'free';
      session.usage = data.usage ?? null;
    }
  } catch {
    /* network / parse failure — keep whatever we had, never throw */
  }
}

/** True when Supabase has real credentials (auth can actually work). */
export function isAuthConfigured() {
  return isCloudEnabled();
}

function _apply(s) {
  session.user = s?.user ?? null;
  session.accessToken = s?.access_token ?? null;
}

let _inited = false;

/**
 * Boot the session store. Safe to call more than once (no-op after the
 * first). Never throws and never blocks the caller on network.
 */
export function initSession() {
  if (_inited) return;
  _inited = true;

  if (!isAuthConfigured()) {
    // No Supabase project configured — anonymous mode, provider stays null.
    session.loading = false;
    return;
  }

  // Desktop: begin listening for the paraform://auth-callback deep-link so an
  // OAuth / magic-link round-trip completed in the system browser lands back
  // in the app. No-op in the browser build.
  if (isDesktop()) { startDesktopOAuthListener().catch(() => {}); }

  // Token provider for lib/ clients: always read the latest session so
  // supabase-js's internal refresh keeps the token fresh for us.
  setAuthTokenProvider(async () => {
    try {
      const { data } = await supabase.auth.getSession();
      return data?.session?.access_token ?? null;
    } catch {
      return null;
    }
  });

  // Initial snapshot (also restores a persisted session from localStorage),
  // then live updates for sign-in / sign-out / token refresh.
  supabase.auth
    .getSession()
    .then(({ data }) => {
      _apply(data?.session ?? null);
      if (session.user) refreshAccount();
    })
    .catch(() => {})
    .finally(() => { session.loading = false; });

  supabase.auth.onAuthStateChange((_event, s) => {
    _apply(s);
    session.loading = false;
    if (session.user) refreshAccount();
  });
}

/**
 * Send a magic-link email. Resolves to `{ error: string|null }`.
 * @param {string} email
 */
export async function signInWithOtp(email) {
  if (!isAuthConfigured()) return { error: 'Sign-in is not configured on this deployment.' };
  try {
    // Desktop redirects to the custom scheme; the browser to its own origin.
    const emailRedirectTo = isDesktop()
      ? DESKTOP_REDIRECT
      : (typeof window !== 'undefined' ? window.location.origin : undefined);
    const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo } });
    return { error: error ? error.message : null };
  } catch (e) {
    return { error: e?.message || String(e) };
  }
}

/**
 * OAuth sign-in with GitHub (full-page redirect). Resolves to
 * `{ error: string|null }` — on success the browser navigates away.
 */
export async function signInWithGithub() {
  if (!isAuthConfigured()) return { error: 'Sign-in is not configured on this deployment.' };
  try {
    if (isDesktop()) {
      // Get the authorize URL WITHOUT navigating the WebView, then open it in
      // the system browser. The provider redirects to paraform://auth-callback,
      // which the deep-link listener (startDesktopOAuthListener) completes.
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider: 'github',
        options: { redirectTo: DESKTOP_REDIRECT, skipBrowserRedirect: true },
      });
      if (error) return { error: error.message };
      if (data?.url) await openInSystemBrowser(data.url);
      return { error: null };
    }
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'github',
      options: {
        redirectTo: typeof window !== 'undefined' ? window.location.origin : undefined,
      },
    });
    return { error: error ? error.message : null };
  } catch (e) {
    return { error: e?.message || String(e) };
  }
}

/** Sign out and clear the local session immediately. */
export async function signOut() {
  try { await supabase.auth.signOut(); } catch { /* network failure — still clear locally */ }
  _apply(null);
  session.plan = 'free';
  session.usage = null;
}
