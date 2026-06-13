/**
 * Provider transport — talks to the Flask `/ai/chat` proxy, which forwards the
 * pre-built body to the selected upstream (Gemini or Anthropic) with the
 * server-held API key. The browser never sees the key (see
 * b123d_server/ai_proxy.py).
 *
 * This module is now provider-agnostic: it owns only HTTP + SSE framing. The
 * shape of the request body and the meaning of each SSE `data:` payload belong
 * to the provider modules in ./providers/. The body always carries a
 * `provider` field + `stream` flag so the proxy can route upstream.
 *
 * Endpoint resolution mirrors lib/document/kernel_client.js exactly so the AI
 * proxy is reached at the same base URL as the kernel.
 *
 * Call shapes:
 *   sendChat(body)                       → Promise<rawJson>   (non-streaming)
 *   streamChat(body, onData)             → Promise<void>      (SSE; onData per payload)
 *   checkAiHealth()                      → Promise<healthJson|null>
 *
 * `sendMessages` / `streamMessages` are kept as thin Anthropic-shaped aliases
 * for back-compat with callers (e.g. the repair client's legacy path) that
 * still build an Anthropic-style body and expect a parsed Message back.
 */

import { defaultEngineUrl } from '../../../lib/platform/runtime.js';
import { getAuthToken } from '../../../lib/auth_token.js';
import { anthropicProvider } from './providers/anthropic.js';

// ── Endpoint resolution (mirrors kernel_client.js) ───────────────────────────

const DEFAULT_ENDPOINT = (() => {
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

/** Resolve the AI proxy base URL — overridable via opts for tests. */
export function aiBaseUrl(override) {
    return (override || DEFAULT_ENDPOINT || '').replace(/\/+$/, '');
}

function _fetch() {
    return (typeof fetch !== 'undefined') ? fetch.bind(globalThis) : null;
}

/**
 * JSON headers + `Authorization: Bearer <token>` when a session exists.
 *
 * Bring-your-own credentials: when the caller passes a user-entered `apiKey`
 * (and, for OpenAI-compatible hosts, a `baseUrl`), forward them to the proxy as
 * `X-Provider-Api-Key` / `X-Provider-Base-Url`. The proxy uses them in place of
 * its server env key for this request. Sent as headers (not the JSON body) so
 * they stay out of any request-body logging.
 */
async function _headers({ apiKey, baseUrl } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    const token = await getAuthToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    if (apiKey) headers['X-Provider-Api-Key'] = apiKey;
    if (baseUrl) headers['X-Provider-Base-Url'] = baseUrl;
    return headers;
}

// ── Health ───────────────────────────────────────────────────────────────────

/**
 * GET /ai/health → per-provider readiness, or null on transport failure.
 * New shape: { ok, anthropic:{configured}, gemini:{configured}, default }.
 * The chat panel uses it to decide whether the selected provider is ready.
 */
export async function checkAiHealth({ endpoint } = {}) {
    const base = aiBaseUrl(endpoint);
    const f = _fetch();
    if (!base || !f) return null;
    try {
        const res = await f(`${base}/ai/health`, { method: 'GET' });
        if (!res || !res.ok) return null;
        return await res.json();
    } catch {
        return null;
    }
}

// ── Generic chat transport ───────────────────────────────────────────────────

/**
 * POST /ai/chat (non-streaming) and return the raw upstream JSON. Throws on a
 * transport error or an error envelope.
 *
 * @param {object} body  — provider-built body ({ provider, model, stream, ... })
 * @param {{ endpoint?:string, signal?:AbortSignal }} [opts]
 * @returns {Promise<object>}
 */
export async function sendChat(body, { endpoint, signal, apiKey, baseUrl } = {}) {
    const base = aiBaseUrl(endpoint);
    const f = _fetch();
    if (!base) throw new Error('AI proxy endpoint not configured');
    if (!f) throw new Error('no fetch implementation available');

    const res = await f(`${base}/ai/chat`, {
        method: 'POST',
        headers: await _headers({ apiKey, baseUrl }),
        body: JSON.stringify({ ...body, stream: false }),
        signal,
    });
    const json = await _safeJson(res);
    if (!res.ok) throw new Error(_describeError(json, res.status));
    if (json && json.type === 'error') throw new Error(_describeError(json, res.status));
    return json;
}

/**
 * POST /ai/chat (streaming) and invoke `onData(payload)` for each SSE `data:`
 * payload string the proxy relays. Caller supplies a provider stream handler.
 *
 * @param {object} body
 * @param {(payload:string)=>void} onData
 * @param {{ endpoint?:string, signal?:AbortSignal }} [opts]
 * @returns {Promise<void>}
 */
export async function streamChat(body, onData = () => {}, { endpoint, signal, apiKey, baseUrl } = {}) {
    const base = aiBaseUrl(endpoint);
    const f = _fetch();
    if (!base) throw new Error('AI proxy endpoint not configured');
    if (!f) throw new Error('no fetch implementation available');

    const res = await f(`${base}/ai/chat`, {
        method: 'POST',
        headers: await _headers({ apiKey, baseUrl }),
        body: JSON.stringify({ ...body, stream: true }),
        signal,
    });

    if (!res.ok) {
        const json = await _safeJson(res);
        throw new Error(_describeError(json, res.status));
    }

    if (!res.body || typeof res.body.getReader !== 'function') {
        // Environment without a streaming body (some test fetch mocks): read the
        // whole text and split it into SSE events in one shot.
        const text = await res.text();
        for (const chunk of String(text).split('\n\n')) {
            const payload = _payloadFromEvent(chunk);
            if (payload != null) onData(payload);
        }
        return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
            const rawEvent = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const payload = _payloadFromEvent(rawEvent);
            if (payload != null) onData(payload);
        }
    }
    if (buffer.trim()) {
        const payload = _payloadFromEvent(buffer);
        if (payload != null) onData(payload);
    }
}

/** Extract the concatenated `data:` payload from one SSE event chunk. */
function _payloadFromEvent(rawEvent) {
    const dataLines = [];
    for (const line of String(rawEvent).split('\n')) {
        if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length === 0) return null;
    const payload = dataLines.join('');
    return payload || null;
}

// ── Back-compat Anthropic-shaped aliases ─────────────────────────────────────
//
// Older callers (repair/llm_client.js legacy path) build an Anthropic-style
// body { model, max_tokens, system, messages, tools } and expect a parsed
// Anthropic Message back. We keep that contract working by stamping
// provider:'anthropic' and reshaping the response.

/**
 * Non-streaming Anthropic call. Returns the assembled Message
 * ({ content:[blocks], stop_reason, usage }).
 */
export async function sendMessages(body, opts = {}) {
    const json = await sendChat({ ...body, provider: body.provider || 'anthropic' }, opts);
    return json;
}

/**
 * Streaming Anthropic call. Drives the Anthropic provider stream handler and
 * returns the assembled Message, forwarding text deltas to `onDelta`.
 */
export async function streamMessages(body, onDelta = () => {}, opts = {}) {
    let result = { text: '', toolCalls: [], stop: true };
    let usage = null;
    const handler = anthropicProvider.makeStreamHandler({
        onText: (text) => { try { onDelta({ type: 'text', text }); } catch {} },
        onToolCalls: (calls) => { for (const c of calls) { try { onDelta({ type: 'tool_use_start', name: c.name }); } catch {} } },
        onStop: (r) => { result = r; },
        onUsage: (u) => { usage = u; },
    });
    await streamChat({ ...body, provider: body.provider || 'anthropic' }, (payload) => handler(payload), opts);
    handler.finalize();
    return {
        role: 'assistant',
        content: [
            ...(result.text ? [{ type: 'text', text: result.text }] : []),
            ...result.toolCalls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.input })),
        ],
        stop_reason: result.stop ? 'end_turn' : 'tool_use',
        usage,
    };
}

// ── Error helpers ──────────────────────────────────────────────────────────

async function _safeJson(res) {
    try { return await res.json(); }
    catch { return null; }
}

function _describeError(json, status) {
    // Auth / quota envelopes from the proxy ({ok:false, code:...}) get
    // human-readable wording so the chat panel can surface them directly.
    if (status === 401) return 'Sign in to use the AI assistant.';
    if (status === 429) {
        const count = json && Number.isFinite(json.count) ? json.count : null;
        const cap   = json && Number.isFinite(json.cap)   ? json.cap   : null;
        const quota = (count != null && cap != null) ? ` (${count}/${cap})` : '';
        return `Daily AI limit reached${quota}. Upgrade for more.`;
    }
    if (json && json.error) {
        if (typeof json.error === 'string') return json.error;
        if (json.error.message) return json.error.message;
    }
    if (status === 503) return 'AI provider API key not configured';
    return `AI proxy request failed (HTTP ${status})`;
}
