/**
 * auth_token.js — framework-free auth-token plumbing.
 *
 * lib/ modules (kernel client, measure client) must not import Svelte or
 * supabase directly. Instead, the app's session store registers a provider
 * here at boot (src/lib/auth/session.svelte.js → setAuthTokenProvider), and
 * every kernel/AI fetch calls `await getAuthToken()` to pick up the current
 * access token. When no provider is registered (tests, anonymous mode,
 * Supabase unconfigured) the token is null and requests go out unchanged.
 */

let _provider = null;

/**
 * Register the function that yields the current access token.
 * @param {(() => string|null|Promise<string|null>)|null} fn
 */
export function setAuthTokenProvider(fn) {
    _provider = (typeof fn === 'function') ? fn : null;
}

/**
 * Resolve the current access token, or null when signed out / unconfigured.
 * Always async-safe: the provider may return a value or a Promise; errors
 * are swallowed (a broken token provider must never break a kernel call).
 * @returns {Promise<string|null>}
 */
export async function getAuthToken() {
    if (!_provider) return null;
    try {
        const token = await _provider();
        return token || null;
    } catch {
        return null;
    }
}
