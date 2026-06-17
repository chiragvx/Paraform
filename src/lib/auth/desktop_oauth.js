/**
 * Desktop (Tauri) OAuth / magic-link bridge.
 *
 * In a browser, Supabase redirects back to `window.location.origin` and the
 * supabase-js client finishes the session automatically. Inside the Tauri
 * shell `window.location.origin` is `tauri://localhost`, which no OAuth
 * provider can redirect to — so the desktop build uses a custom URL scheme
 * (`paraform://auth-callback`) instead:
 *
 *   1. signInWith{OAuth,Otp} is called with redirectTo = DESKTOP_REDIRECT and
 *      skipBrowserRedirect, and we open the returned authorize URL in the
 *      user's real system browser (openUrl).
 *   2. The provider redirects to `paraform://auth-callback?code=…` (PKCE) or
 *      `…#access_token=…&refresh_token=…` (implicit). The OS hands that URL to
 *      the app; tauri-plugin-deep-link (+ single-instance) routes it here.
 *   3. We complete the session: exchangeCodeForSession(code) for PKCE, or
 *      setSession({access_token, refresh_token}) for implicit. Either way
 *      supabase.auth.onAuthStateChange then fires and the gate opens.
 *
 * All Tauri plugin imports are dynamic and guarded by isDesktop(), so the web
 * bundle never loads them.
 */

import { isDesktop } from '../../../lib/platform/runtime.js';
import { supabase } from '../../../lib/supabase.js';

/** Custom-scheme callback the provider redirects to (must be allow-listed in
 *  the Supabase dashboard → Authentication → URL Configuration). */
export const DESKTOP_REDIRECT = 'paraform://auth-callback';

let _listenerStarted = false;

/**
 * Complete a Supabase session from a `paraform://auth-callback…` URL. Handles
 * both the PKCE (`?code=`) and implicit (`#access_token=`) shapes so it works
 * regardless of the client's flowType. Throws on a hard failure.
 */
async function completeFromCallbackUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return; }
  if (!/^paraform:/i.test(u.protocol)) return;

  // PKCE — authorization code in the query string.
  const code = u.searchParams.get('code');
  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) throw error;
    return;
  }

  // Implicit — tokens in the URL fragment.
  const params = new URLSearchParams((u.hash || '').replace(/^#/, ''));
  const access_token = params.get('access_token');
  const refresh_token = params.get('refresh_token');
  if (access_token && refresh_token) {
    const { error } = await supabase.auth.setSession({ access_token, refresh_token });
    if (error) throw error;
    return;
  }

  // Provider returned an error (e.g. user denied) — surface it for logs.
  const err = u.searchParams.get('error_description') || params.get('error_description');
  if (err) throw new Error(err);
}

/**
 * Start listening for OAuth deep-link callbacks. Idempotent; no-op off desktop.
 * Also drains any URL the app was COLD-LAUNCHED with (deep-link arriving while
 * the app was closed).
 */
export async function startDesktopOAuthListener() {
  if (!isDesktop() || _listenerStarted) return;
  _listenerStarted = true;
  try {
    const deepLink = await import('@tauri-apps/plugin-deep-link');
    await deepLink.onOpenUrl(async (urls) => {
      for (const raw of urls || []) {
        try { await completeFromCallbackUrl(raw); }
        catch (e) { console.warn('[desktop-oauth] callback failed:', e?.message || e); }
      }
    });
    // Cold start: the app may have been launched BY the callback URL.
    try {
      const initial = await deepLink.getCurrent();
      for (const raw of initial || []) {
        try { await completeFromCallbackUrl(raw); } catch { /* already logged path */ }
      }
    } catch { /* getCurrent unsupported on some targets — ignore */ }
  } catch (e) {
    console.warn('[desktop-oauth] deep-link listener unavailable:', e?.message || e);
    _listenerStarted = false; // allow a retry if the plugin loads later
  }
}

/** Open an OAuth authorize URL in the user's system browser (desktop only). */
export async function openInSystemBrowser(url) {
  const { openUrl } = await import('@tauri-apps/plugin-opener');
  await openUrl(url);
}
