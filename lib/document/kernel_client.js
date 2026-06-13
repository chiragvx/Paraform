/**
 * HttpKernelClient — speaks the existing `b123d_server` `/execute` protocol.
 *
 * Implements the `executeCode(code)` interface the DocumentExecutor expects.
 * Matches the wire format used by the v3 TreeExecutor so the same Python
 * sidecar (`b123d_server/server.py`) accepts both:
 *
 *   POST {endpoint}/execute
 *   body: { "code": "<emitted python>" }
 *   →  { ok: bool, glb?: base64, topology?: {nodes:[...]}, error?: str }
 *
 * Endpoint resolution mirrors TreeExecutor: env var, window global, or the
 * platform default (`http://127.0.0.1:7823` for Tauri desktop, empty for the
 * pure-web build).
 *
 * Falls back to a mock client when no endpoint is configured — the mock
 * returns `ok: false, error: 'mock-mode'` so the executor's `failed` event
 * surfaces visibly rather than the bridge silently doing nothing.
 */

import { defaultEngineUrl } from '../platform/runtime.js';
import { getAuthToken } from '../auth_token.js';

const DEFAULT_ENDPOINT = (() => {
    // Priority (highest first):
    //   1. Vite env var  (`VITE_ENGINE_URL=…  npm run dev`)
    //   2. Local kernel when the page itself is on localhost (so plain
    //      `vite` against http://localhost:1420 reaches a sidecar on :7823
    //      without any env config — the common dev case).
    //   3. window global (production HTML's tunnel default)
    //   4. Platform default (Tauri desktop sidecar)
    if (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_ENGINE_URL) {
        return import.meta.env.VITE_ENGINE_URL;
    }
    if (typeof window !== 'undefined') {
        const host = (window.location && window.location.hostname) || '';
        if (host === 'localhost' || host === '127.0.0.1') {
            return 'http://localhost:7823';
        }
        if (window.__PARAFORM_ENGINE_URL__) return window.__PARAFORM_ENGINE_URL__;
    }
    try { return defaultEngineUrl(); }
    catch { return ''; }
})();

if (typeof window !== 'undefined' && typeof console !== 'undefined') {
    console.info(`[kernel] endpoint: ${DEFAULT_ENDPOINT || '(none — mock mode)'}`);
}

export class HttpKernelClient {
    /**
     * @param {object} [opts]
     * @param {string} [opts.endpoint]   — defaults to env / window / desktop sidecar
     * @param {number} [opts.timeout]    — abort the request after this many ms
     * @param {typeof fetch} [opts.fetchImpl] — overridable for tests
     */
    constructor({ endpoint = DEFAULT_ENDPOINT, timeout = 90000, fetchImpl = null } = {}) {
        this.endpoint = endpoint || '';
        this.timeout  = timeout;
        this._fetch   = fetchImpl || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);

        // Kernel version metadata captured from the most recent successful
        // `/execute` response. Foundation 2 (determinism) wires this so the
        // UI can surface build123d / OCCT versions and naming-contract
        // mismatches without a separate round-trip. `null` until the first
        // response lands.
        this._lastKernelVersion = null;

        // Session-scoped cache for `getVersion()` so repeat callers don't
        // re-hit the endpoint. Holds the resolved value (object or null) or
        // a pending Promise to dedupe concurrent calls.
        this._versionCache = null;
    }

    setEndpoint(url) {
        this.endpoint = url || '';
        // Endpoint change invalidates the cached version handshake.
        this._versionCache = null;
    }
    isConfigured()   { return !!this.endpoint; }
    get name()       { return 'http'; }

    /** Latest kernelVersion block from the last successful `/execute`. */
    get lastKernelVersion() { return this._lastKernelVersion; }

    /**
     * Fetch and cache `GET {endpoint}/version`. Side-effect-free: does not
     * mutate `lastKernelVersion` or any other state observable through the
     * normal `executeCode` path. Returns `null` if the endpoint is not
     * configured, the fetch fails, or the server responds non-200.
     */
    async getVersion() {
        if (this._versionCache !== null) {
            return await this._versionCache;
        }
        if (!this.endpoint || !this._fetch) {
            this._versionCache = Promise.resolve(null);
            return null;
        }
        const url = this.endpoint.replace(/\/+$/, '') + '/version';
        const pending = (async () => {
            try {
                const res = await this._fetch(url, { method: 'GET' });
                if (!res || !res.ok) return null;
                const ct = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
                if (!ct.includes('application/json')) return null;
                const json = await res.json();
                return json ?? null;
            } catch {
                return null;
            }
        })();
        this._versionCache = pending;
        const resolved = await pending;
        // Replace the pending promise with the resolved value so future
        // awaits skip the microtask hop.
        this._versionCache = Promise.resolve(resolved);
        return resolved;
    }

    /**
     * Post the emitted Python source to the kernel. Returns the same shape
     * the DocumentExecutor expects: `{ ok, glb?, topology?, error? }`.
     *
     * When `opts.formats` includes 'step', 'stl' or 'brep' the kernel also
     * runs build123d's corresponding export and the response carries each
     * blob as an ArrayBuffer keyed by format name (`{ step, stl, brep }`).
     *
     * @param {string} code
     * @param {object} [opts]
     * @param {string[]} [opts.formats]
     */
    async executeCode(code, opts = {}) {
        if (!this.endpoint) {
            return { ok: false, error: 'no kernel endpoint configured', mock: true };
        }
        if (!this._fetch) {
            return { ok: false, error: 'no fetch implementation available' };
        }

        // Per-call timeout override (opts.timeout). The boot/first compile
        // passes a shorter bound so an unreachable-but-configured endpoint
        // surfaces an error in seconds instead of blocking on the full default.
        const timeoutMs = Number.isFinite(opts.timeout) ? opts.timeout : this.timeout;
        const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;

        try {
            const url = this.endpoint.replace(/\/+$/, '') + '/execute';
            const body = { code };
            if (Array.isArray(opts.formats) && opts.formats.length) {
                body.formats = opts.formats;
            }
            // Tessellation chord-deviation tolerance (mm). Lower → smoother
            // curves, more tris. The server clamps to a safe band.
            if (Number.isFinite(opts.deflection)) {
                body.deflection = opts.deflection;
            }
            const headers = { 'Content-Type': 'application/json' };
            const token = await getAuthToken();
            if (token) headers.Authorization = `Bearer ${token}`;
            const res = await this._fetch(url, {
                method:  'POST',
                headers,
                body:    JSON.stringify(body),
                signal:  ctrl ? ctrl.signal : undefined,
            });
            if (timer) clearTimeout(timer);

            if (!res.ok) {
                // Auth / quota errors come back as JSON envelopes
                // ({ok:false, code:'auth_required'|'rate_limited', ...}) —
                // map them to friendly messages in the usual {ok,error} shape.
                if (res.status === 401 || res.status === 429) {
                    const json = await res.json().catch(() => null);
                    return { ok: false, code: json?.code, error: _friendlyAuthError(res.status, json, 'kernel') };
                }
                const text = await res.text().catch(() => '');
                return { ok: false, error: `HTTP ${res.status}${text ? ': ' + text : ''}` };
            }

            const ct = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
            if (ct.includes('application/json')) {
                const json = await res.json();
                if (typeof json.glb === 'string' && json.glb.length) {
                    json.glb = base64ToArrayBuffer(json.glb);
                }
                // Decode optional export blobs the same way (base64 → ArrayBuffer).
                for (const fmt of ['step', 'stl', 'brep']) {
                    if (typeof json[fmt] === 'string' && json[fmt].length) {
                        json[fmt] = base64ToArrayBuffer(json[fmt]);
                    }
                }
                // Stash the kernel version block (Foundation 2). The server
                // includes a `kernelVersion` object on every `/execute`
                // response; we keep the most recent one so the bridge / UI
                // can surface it without a separate `/version` round-trip.
                if (json && json.ok) {
                    this._lastKernelVersion = json.kernelVersion ?? null;
                }
                return { ok: !!json.ok, ...json };
            }

            // Non-JSON response: assume binary GLB
            const buf = await res.arrayBuffer();
            return { ok: true, glb: buf };
        } catch (err) {
            if (timer) clearTimeout(timer);
            return { ok: false, error: err && err.message ? err.message : String(err) };
        }
    }
}

/**
 * Map a 401/429 JSON envelope from the kernel into a human-readable message.
 * Exported for reuse by the measure client (same server, same envelope).
 *
 * @param {number} status        — 401 or 429
 * @param {object|null} json     — parsed response body, if any
 * @param {'kernel'|'ai'} kind   — which surface to word the message for
 */
export function _friendlyAuthError(status, json, kind = 'kernel') {
    if (status === 401) {
        return kind === 'ai'
            ? 'Sign in to use the AI assistant.'
            : 'Sign in to use the CAD kernel.';
    }
    const count = json && Number.isFinite(json.count) ? json.count : null;
    const cap   = json && Number.isFinite(json.cap)   ? json.cap   : null;
    const quota = (count != null && cap != null) ? ` (${count}/${cap})` : '';
    return kind === 'ai'
        ? `Daily AI limit reached${quota}. Upgrade for more.`
        : `Daily compute limit reached${quota}. Upgrade for more.`;
}

/**
 * Decode a base64 string into an ArrayBuffer. Mirrors the helper inside
 * TreeExecutor so behaviour is identical.
 */
function base64ToArrayBuffer(b64) {
    const bin = atob(b64);
    const buf = new ArrayBuffer(bin.length);
    const view = new Uint8Array(buf);
    for (let i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i);
    return buf;
}

// ── Mock client (tests + offline UX) ─────────────────────────────────────────

/**
 * Build a deterministic mock client that returns predefined responses in
 * order. Useful for tests and the "no backend configured" demo path.
 *
 * @param {Array<object>|((code: string) => object)} responses
 */
export function makeMockKernelClient(responses) {
    let i = 0;
    const calls = [];
    return {
        name: 'mock',
        calls,
        async executeCode(code) {
            calls.push(code);
            if (typeof responses === 'function') return responses(code);
            const next = responses[i++] ?? responses[responses.length - 1] ?? { ok: true };
            return typeof next === 'function' ? next(code) : next;
        },
    };
}
