/**
 * Web research tools — let the model look things up on the internet (standard
 * part dimensions, material datasheets, design references, anything it needs).
 * The browser can't fetch arbitrary sites (CORS), so these proxy through the
 * Flask server's /ai/web_search and /ai/web_fetch endpoints (b123d_server/
 * web_research.py), which do the fetch server-side with SSRF protection.
 *
 * Both never throw — a transport/proxy failure returns { ok:false, error } so
 * the model can fall back to its own knowledge.
 */

import { aiBaseUrl } from './provider.js';
import { getAuthToken } from '../../../lib/auth_token.js';
import { N, S } from './tools_util.js';

/** POST a JSON body to a proxy path and return the parsed JSON (defensive). */
async function proxyPost(path, body) {
    const base = aiBaseUrl();
    if (!base) return { ok: false, error: 'AI proxy endpoint not configured' };
    if (typeof fetch === 'undefined') return { ok: false, error: 'no fetch implementation available' };
    try {
        const headers = { 'Content-Type': 'application/json' };
        try { const tok = await getAuthToken(); if (tok) headers.Authorization = `Bearer ${tok}`; } catch { /* no auth */ }
        const res = await fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
        if (!res || !res.ok) return { ok: false, error: `web request failed (HTTP ${res ? res.status : '??'})` };
        const json = await res.json();
        return (json && typeof json === 'object') ? json : { ok: false, error: 'malformed response' };
    } catch (e) {
        return { ok: false, error: `web request failed: ${(e && e.message) || e}` };
    }
}

export const WEB_TOOLS = [
    {
        name: 'web_search',
        description: 'Search the web and get back result titles, URLs, and snippets. Use it to research real-world facts you need for a design — standard part dimensions, thread specs, material properties, bolt patterns, reference designs. Follow a promising hit with web_fetch to read the page.',
        input_schema: {
            type: 'object',
            properties: {
                query: S('What to search for'),
                limit: N('Max results to return (default 5, max 10)'),
            },
            required: ['query'],
        },
        handler: (i) => proxyPost('/ai/web_search', { query: String(i.query || ''), limit: Math.max(1, Math.min(10, num(i.limit, 5))) }),
    },
    {
        name: 'web_fetch',
        description: 'Fetch a web page (by full http/https URL) and return its readable text. Use after web_search to read a result in detail. Returns the page title and extracted text (truncated to maxChars).',
        input_schema: {
            type: 'object',
            properties: {
                url: S('Full http(s) URL to fetch'),
                maxChars: N('Max characters of text to return (default 6000, max 20000)'),
            },
            required: ['url'],
        },
        handler: (i) => proxyPost('/ai/web_fetch', { url: String(i.url || ''), maxChars: Math.max(500, Math.min(20000, num(i.maxChars, 6000))) }),
    },
];

// Local num() — tools_util exports it but we keep web self-contained for the
// two clamps above without widening the import surface.
function num(v, fallback) { const n = Number(v); return Number.isFinite(n) ? n : fallback; }

export default WEB_TOOLS;
