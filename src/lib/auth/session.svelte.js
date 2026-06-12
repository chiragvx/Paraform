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
import { setAuthTokenProvider } from '../../../lib/auth_token.js';

export const session = $state({
  user: null,
  accessToken: null,
  loading: true,
});

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
    .then(({ data }) => { _apply(data?.session ?? null); })
    .catch(() => {})
    .finally(() => { session.loading = false; });

  supabase.auth.onAuthStateChange((_event, s) => {
    _apply(s);
    session.loading = false;
  });
}

/**
 * Send a magic-link email. Resolves to `{ error: string|null }`.
 * @param {string} email
 */
export async function signInWithOtp(email) {
  if (!isAuthConfigured()) return { error: 'Sign-in is not configured on this deployment.' };
  try {
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: typeof window !== 'undefined' ? window.location.origin : undefined,
      },
    });
    return { error: error ? error.message : null };
  } catch (e) {
    return { error: e?.message || String(e) };
  }
}

/**
 * OAuth sign-in with Google (full-page redirect). Resolves to
 * `{ error: string|null }` — on success the browser navigates away.
 */
export async function signInWithGoogle() {
  if (!isAuthConfigured()) return { error: 'Sign-in is not configured on this deployment.' };
  try {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
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
}
