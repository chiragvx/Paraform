#!/usr/bin/env node
/**
 * ParaForm REMOTE MCP server (Streamable HTTP transport).
 *
 * This is the hosted Claude connector. End-users paste the public URL of this
 * server into claude.ai → Settings → Connectors → "Add custom connector" and
 * drive ParaForm directly from their Claude subscription. No npm install, no
 * JSON-config editing, no Node on the user's machine.
 *
 * Architecture: this gateway speaks the MCP Streamable HTTP transport, and for
 * every Claude session it spawns a fresh `mcp/server.mjs` child process. That
 * gives every session its own document store (the in-process singleton stays
 * private per process), so there's ZERO cross-session leak risk and zero
 * refactor of the doc layer. The cost is one Node child process per active
 * session (~50–80 MB); we cap concurrency and idle-time out.
 *
 *   POST   /mcp               → JSON-RPC 2.0 message in, JSON response out.
 *                                On `initialize` we mint a session id and
 *                                return it in the Mcp-Session-Id header.
 *   GET    /mcp               → 405 (no server-initiated stream in v1).
 *   DELETE /mcp               → terminate the session (kills the child).
 *   GET    /mcp/download/<id> → serve the latest .paraform.json for download.
 *                                This is what paraform_save_document hands
 *                                back to the user — a clickable URL the
 *                                studio's File → Open can read directly.
 *   GET    /health            → liveness probe.
 *
 * `paraform_save_document` is intercepted here (NOT forwarded to the child)
 * because writing to the server's filesystem is useless to a remote user.
 * Instead we return `{ ok, url }` pointing at the download endpoint.
 *
 * Dep-free: Node stdlib only (http, child_process, crypto). Deployable as a
 * single-file service to fly.io / Railway / Render / a bare VM. Behind a
 * TLS-terminating reverse proxy (Caddy / nginx / platform) because claude.ai
 * connectors require HTTPS.
 *
 * Env:
 *   PARAFORM_MCP_PORT             default 8080
 *   PARAFORM_MCP_PUBLIC_URL       absolute URL of THIS service for download
 *                                  links (e.g. https://paraform.app). Defaults
 *                                  to http://localhost:<port> for local dev.
 *   PARAFORM_MCP_SESSION_IDLE_MS  default 15 min
 *   PARAFORM_MCP_MAX_SESSIONS     default 200
 */

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STDIO_SERVER = path.join(__dirname, 'server.mjs');

const PORT = Number(process.env.PARAFORM_MCP_PORT || 8080);
const PUBLIC_BASE_URL = (process.env.PARAFORM_MCP_PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const SESSION_IDLE_MS = Number(process.env.PARAFORM_MCP_SESSION_IDLE_MS || 15 * 60 * 1000);
const MAX_SESSIONS = Number(process.env.PARAFORM_MCP_MAX_SESSIONS || 200);
const REQUEST_TIMEOUT_MS = 30_000;
const PAIRING_IDLE_MS = Number(process.env.PARAFORM_MCP_PAIRING_IDLE_MS || 60 * 60 * 1000);
// Pairing codes: 6 chars from an unambiguous alphabet (no 0/O, 1/I/L) so
// users can read them aloud to Claude without confusion.
const PAIR_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const PROTOCOL_VERSION = '2024-11-05';
const SESSION_HEADER = 'mcp-session-id';

function log(...parts) {
    const line = parts.map((p) => typeof p === 'string' ? p : JSON.stringify(p)).join(' ');
    process.stderr.write(`[paraform-mcp-remote] ${line}\n`);
}

function makePairingCode() {
    // 6 chars from PAIR_ALPHABET, biased-uniform via crypto bytes.
    const bytes = new Uint8Array(6);
    const { webcrypto } = global.crypto ? global : require('node:crypto');
    if (global.crypto && global.crypto.getRandomValues) global.crypto.getRandomValues(bytes);
    else require('node:crypto').randomFillSync(bytes);
    let out = '';
    for (let i = 0; i < bytes.length; i++) out += PAIR_ALPHABET[bytes[i] % PAIR_ALPHABET.length];
    return out;
}

// ── Session: one Claude conversation ↔ one stdio child ────────────────────────

class Session {
    constructor(id) {
        this.id = id;
        this.lastUsed = Date.now();
        this.pending = new Map(); // jsonrpcId → { resolve, reject, timer }
        this.buffer = '';
        this.child = spawn(process.execPath, [STDIO_SERVER], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env },
        });
        this.child.stdout.setEncoding('utf8');
        this.child.stdout.on('data', (chunk) => this._onData(chunk));
        this.child.stderr.on('data', () => { /* child logs already go to its own stderr */ });
        this.child.on('exit', (code) => {
            for (const [, p] of this.pending) p.reject(new Error(`child exited (code ${code})`));
            this.pending.clear();
        });
    }
    _onData(chunk) {
        this.buffer += chunk;
        let nl;
        while ((nl = this.buffer.indexOf('\n')) !== -1) {
            const line = this.buffer.slice(0, nl).trim();
            this.buffer = this.buffer.slice(nl + 1);
            if (!line) continue;
            let msg;
            try { msg = JSON.parse(line); } catch { continue; }
            if (msg.id != null && this.pending.has(msg.id)) {
                const { resolve, timer } = this.pending.get(msg.id);
                this.pending.delete(msg.id);
                clearTimeout(timer);
                resolve(msg);
            }
        }
    }
    request(message) {
        this.lastUsed = Date.now();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                if (this.pending.has(message.id)) {
                    this.pending.delete(message.id);
                    reject(new Error('child timed out'));
                }
            }, REQUEST_TIMEOUT_MS);
            timer.unref();
            this.pending.set(message.id, { resolve, reject, timer });
            this.child.stdin.write(JSON.stringify(message) + '\n');
        });
    }
    notify(message) {
        this.lastUsed = Date.now();
        this.child.stdin.write(JSON.stringify(message) + '\n');
    }
    /** Return the live document as a v5 .paraform.json object via the child. */
    async getDocumentJson() {
        const msg = {
            jsonrpc: '2.0',
            id: `internal-${randomUUID()}`,
            method: 'tools/call',
            params: { name: 'paraform_get_document_json', arguments: {} },
        };
        const r = await this.request(msg);
        if (r.error) throw new Error(r.error.message || 'child error');
        const text = r.result && r.result.content && r.result.content[0] && r.result.content[0].text;
        const payload = text ? JSON.parse(text) : {};
        if (!payload.ok) throw new Error(payload.error || 'get_document_json failed');
        return payload.document;
    }
    close() {
        try { this.child.kill(); } catch { /* already gone */ }
        for (const [, p] of this.pending) {
            clearTimeout(p.timer);
            p.reject(new Error('session closed'));
        }
        this.pending.clear();
    }
}

const sessions = new Map(); // id → Session

// ── Pairings: a studio tab ↔ one or more attached Claude MCP sessions ─────────
//
// When the user clicks "Connect Claude" in the studio, the studio POSTs
// /studio/pair to mint a short code, then opens an SSE stream at
// /studio/events?code=<code>. The studio's onmessage handler runs each
// tool_call event through the in-app dispatchTool and POSTs the result back to
// /studio/results. Once a Claude MCP session calls paraform_attach({code}) the
// gateway binds that session to this pairing — every subsequent tools/call is
// forwarded over the SSE stream rather than the child process, giving the
// "Claude builds, studio updates live" UX.

class Pairing {
    constructor(code) {
        this.code = code;
        this.studioRes = null;          // active SSE response (HTTP res)
        this.attachedSessions = new Set(); // mcp session ids attached to this pair
        this.pending = new Map();       // callId → { resolve, reject, timer }
        this.lastUsed = Date.now();
        this.studioInfo = null;         // optional metadata from the studio
    }
    bindStudio(res) {
        if (this.studioRes && !this.studioRes.writableEnded) {
            // A second open kicks the first off so a reload works cleanly.
            try { this.studioRes.end(); } catch { /* ignore */ }
        }
        this.studioRes = res;
        this.lastUsed = Date.now();
    }
    pushToolCall(call) {
        if (!this.studioRes || this.studioRes.writableEnded) return false;
        try {
            this.studioRes.write(`data: ${JSON.stringify(call)}\n\n`);
            this.lastUsed = Date.now();
            return true;
        } catch { return false; }
    }
    resolveResult(callId, result) {
        const entry = this.pending.get(callId);
        if (!entry) return false;
        this.pending.delete(callId);
        clearTimeout(entry.timer);
        entry.resolve(result);
        this.lastUsed = Date.now();
        return true;
    }
    close(reason = 'pairing closed') {
        for (const [, p] of this.pending) {
            clearTimeout(p.timer);
            p.reject(new Error(reason));
        }
        this.pending.clear();
        if (this.studioRes && !this.studioRes.writableEnded) {
            try { this.studioRes.end(); } catch { /* ignore */ }
        }
        this.studioRes = null;
        this.attachedSessions.clear();
    }
}

const pairings = new Map(); // code → Pairing
const sessionToPairing = new Map(); // mcp session id → pairing code

function pairingFor(sessionId) {
    const code = sessionToPairing.get(sessionId);
    return code ? pairings.get(code) : null;
}

const reaper = setInterval(() => {
    const now = Date.now();
    for (const [id, s] of sessions) {
        if (now - s.lastUsed > SESSION_IDLE_MS) {
            log('reaping idle session', id);
            s.close();
            sessions.delete(id);
        }
    }
    for (const [code, p] of pairings) {
        if (now - p.lastUsed > PAIRING_IDLE_MS) {
            log('reaping idle pairing', code);
            p.close('pairing idle');
            for (const sid of p.attachedSessions) sessionToPairing.delete(sid);
            pairings.delete(code);
        }
    }
}, 60_000);
reaper.unref();

// ── HTTP framing helpers ──────────────────────────────────────────────────────

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Mcp-Session-Id, MCP-Protocol-Version, Authorization, X-Pairing-Code',
    'Access-Control-Expose-Headers': 'Mcp-Session-Id',
    'Access-Control-Max-Age': '86400',
};

function sendJson(res, status, body, extra = {}) {
    res.writeHead(status, { 'Content-Type': 'application/json', ...CORS, ...extra });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
}
function send204(res, extra = {}) {
    res.writeHead(204, { ...CORS, ...extra });
    res.end();
}
function readBody(req) {
    return new Promise((resolve, reject) => {
        let buf = '';
        req.setEncoding('utf8');
        req.on('data', (c) => { buf += c; if (buf.length > 4 * 1024 * 1024) { req.destroy(); reject(new Error('payload too large')); } });
        req.on('end', () => resolve(buf));
        req.on('error', reject);
    });
}

function rpcError(id, code, message) {
    return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

// ── Route handlers ────────────────────────────────────────────────────────────

// ── Studio pairing endpoints ─────────────────────────────────────────────────

async function handleStudioPair(req, res) {
    let bodyText = '';
    try { bodyText = await readBody(req); } catch { /* ignore */ }
    let info = {};
    try { info = bodyText ? JSON.parse(bodyText) : {}; } catch { /* ignore */ }

    // Pick a fresh code with bounded retries.
    let code = '';
    for (let i = 0; i < 8 && !code; i++) {
        const c = makePairingCode();
        if (!pairings.has(c)) code = c;
    }
    if (!code) return sendJson(res, 503, { error: 'could not allocate pairing code' });

    const pairing = new Pairing(code);
    pairing.studioInfo = (info && typeof info === 'object') ? info : null;
    pairings.set(code, pairing);
    log('opened pairing', code);

    sendJson(res, 200, {
        ok: true,
        code,
        eventsUrl: `${PUBLIC_BASE_URL}/studio/events?code=${code}`,
        resultsUrl: `${PUBLIC_BASE_URL}/studio/results?code=${code}`,
        mcpUrl: `${PUBLIC_BASE_URL}/mcp`,
        // The human one-liner the user can paste to Claude.
        attachPhrase: `Connect to ParaForm with code ${code}`,
    });
}

function handleStudioEvents(req, res, code) {
    const pairing = pairings.get(code);
    if (!pairing) return sendJson(res, 404, { error: 'pairing not found or expired' });

    res.writeHead(200, {
        ...CORS,
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
    // Initial hello so EventSource readyState flips to OPEN immediately.
    res.write(`event: hello\ndata: ${JSON.stringify({ code, attached: pairing.attachedSessions.size })}\n\n`);
    pairing.bindStudio(res);

    // Heartbeat keeps proxies happy.
    const heartbeat = setInterval(() => {
        if (res.writableEnded) { clearInterval(heartbeat); return; }
        try { res.write(`:ping\n\n`); } catch { /* ignore */ }
    }, 20_000);
    heartbeat.unref();

    req.on('close', () => {
        clearInterval(heartbeat);
        if (pairing.studioRes === res) {
            pairing.studioRes = null;
            // Pending calls fail cleanly so Claude sees an error rather than hanging.
            for (const [, p] of pairing.pending) {
                clearTimeout(p.timer);
                p.reject(new Error('studio disconnected'));
            }
            pairing.pending.clear();
        }
    });
}

async function handleStudioResults(req, res, code) {
    const pairing = pairings.get(code);
    if (!pairing) return sendJson(res, 404, { error: 'pairing not found or expired' });
    let bodyText = '';
    try { bodyText = await readBody(req); } catch (e) {
        return sendJson(res, 413, { error: e.message });
    }
    let body;
    try { body = JSON.parse(bodyText); } catch {
        return sendJson(res, 400, { error: 'invalid JSON' });
    }
    const callId = body && body.callId;
    if (!callId) return sendJson(res, 400, { error: 'callId is required' });
    const ok = pairing.resolveResult(callId, body.result);
    sendJson(res, ok ? 200 : 410, { ok });
}

async function handleDownload(req, res, sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return sendJson(res, 404, { error: 'session not found or expired' });
    try {
        const document = await session.getDocumentJson();
        res.writeHead(200, {
            ...CORS,
            'Content-Type': 'application/json',
            'Content-Disposition': `attachment; filename="paraform-${sessionId.slice(0, 8)}.paraform.json"`,
            'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(document, null, 2));
    } catch (e) {
        sendJson(res, 500, { error: e.message });
    }
}

async function handleMcpPost(req, res) {
    let bodyText;
    try { bodyText = await readBody(req); } catch (e) {
        return sendJson(res, 413, rpcError(null, -32000, e.message));
    }
    let msg;
    try { msg = JSON.parse(bodyText); } catch {
        return sendJson(res, 400, rpcError(null, -32700, 'Parse error'));
    }

    const isInit = msg.method === 'initialize';
    const headerSessionId = String(req.headers[SESSION_HEADER] || '').trim() || null;

    let session;
    let sessionId;
    if (isInit) {
        // The spec lets a client either send no session id (we mint one) or
        // reuse an existing one. We always mint a fresh one on initialize and
        // return it via the header so the client can include it on follow-ups.
        if (sessions.size >= MAX_SESSIONS) {
            return sendJson(res, 503, rpcError(msg.id, -32000, 'server at capacity'));
        }
        sessionId = randomUUID();
        session = new Session(sessionId);
        sessions.set(sessionId, session);
        log('opened session', sessionId, '(active:', sessions.size + ')');
    } else {
        sessionId = headerSessionId;
        session = sessionId ? sessions.get(sessionId) : null;
        if (!session) return sendJson(res, 400, rpcError(msg.id, -32600, 'No active session (call initialize first)'));
    }

    const headers = { 'Mcp-Session-Id': sessionId };

    // ── paraform_attach interception ─────────────────────────────────────────
    // Bind this Claude conversation to a live studio pairing. After a
    // successful attach, every subsequent tools/call in this MCP session is
    // forwarded over the studio's SSE channel (live editing), not the child.
    if (msg.method === 'tools/call'
        && msg.params && msg.params.name === 'paraform_attach'
    ) {
        const rawCode = (msg.params.arguments && msg.params.arguments.code) || '';
        const code = String(rawCode).toUpperCase().replace(/[^A-Z0-9]/g, '');
        const pairing = code && pairings.get(code);
        let result;
        if (!code) {
            result = { ok: false, error: 'paraform_attach requires a `code` argument (the 6-letter code from the studio).' };
        } else if (!pairing) {
            result = { ok: false, error: `No live studio for code ${code}. Ask the user to click "Connect Claude" in the studio and read you the code again.` };
        } else if (!pairing.studioRes) {
            result = { ok: false, error: `The studio for code ${code} is not connected right now. Ask the user to reopen "Connect Claude" in the studio.` };
        } else {
            pairing.attachedSessions.add(sessionId);
            sessionToPairing.set(sessionId, code);
            log('attached session', sessionId, '↔ pairing', code);
            // We keep the child process alive: tools/list / ping / non-mutating
            // observers still go to it. Only tools/call is rerouted to the
            // studio. The child sits idle and gets reaped on session timeout.
            result = { ok: true, code, summary: `Attached to ParaForm studio ${code}. Future build tools will mutate the user's live studio document.` };
        }
        return sendJson(res, 200, {
            jsonrpc: '2.0', id: msg.id,
            result: { content: [{ type: 'text', text: JSON.stringify(result) }], isError: !result.ok },
        }, headers);
    }

    // ── Route to paired studio if attached ───────────────────────────────────
    // For an attached MCP session, every tools/call flows through the studio's
    // SSE channel; tools/list still comes from the child to keep the catalog
    // truthful (we don't have a studio-side tool list snapshot here).
    const pairing = pairingFor(sessionId);
    if (pairing && msg.method === 'tools/call') {
        if (!pairing.studioRes) {
            return sendJson(res, 200, {
                jsonrpc: '2.0', id: msg.id,
                result: { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'Studio disconnected — ask the user to reopen "Connect Claude" in the studio and call paraform_attach again with the new code.' }) }], isError: true },
            }, headers);
        }
        const callId = randomUUID();
        const result = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                if (pairing.pending.has(callId)) {
                    pairing.pending.delete(callId);
                    reject(new Error('studio timed out'));
                }
            }, REQUEST_TIMEOUT_MS);
            timer.unref();
            pairing.pending.set(callId, { resolve, reject, timer });
            const ok = pairing.pushToolCall({
                type: 'tool_call', callId,
                name: msg.params && msg.params.name,
                arguments: (msg.params && msg.params.arguments) || {},
            });
            if (!ok) {
                clearTimeout(timer);
                pairing.pending.delete(callId);
                reject(new Error('failed to push to studio'));
            }
        }).catch((e) => ({ ok: false, error: e.message }));

        const isError = !!(result && result.ok === false);
        return sendJson(res, 200, {
            jsonrpc: '2.0', id: msg.id,
            result: { content: [{ type: 'text', text: JSON.stringify(result) }], isError },
        }, headers);
    }

    // ── paraform_save_document interception ──────────────────────────────────
    // In the unpaired/headless path, writing to a server-side file is useless
    // to the user — they can't reach it. Replace the call with a download URL
    // that streams the latest .paraform.json from this gateway's child.
    //
    // (In paired mode the call has already been routed to the studio above,
    // which prompts the studio's own save UI.)
    if (msg.method === 'tools/call'
        && msg.params && msg.params.name === 'paraform_save_document'
    ) {
        const url = `${PUBLIC_BASE_URL}/mcp/download/${sessionId}`;
        const result = {
            ok: true,
            url,
            summary: `Your ParaForm build is ready. Download the .paraform.json here: ${url} — then open it in the ParaForm studio (File → Open).`,
        };
        return sendJson(res, 200, {
            jsonrpc: '2.0',
            id: msg.id,
            result: { content: [{ type: 'text', text: JSON.stringify(result) }], isError: false },
        }, headers);
    }

    // Notifications: no id, no response body required.
    if (msg.id === undefined || msg.id === null) {
        session.notify(msg);
        res.writeHead(202, { ...CORS, ...headers });
        res.end();
        return;
    }

    try {
        const response = await session.request(msg);
        sendJson(res, 200, response, headers);
    } catch (e) {
        sendJson(res, 500, rpcError(msg.id, -32603, e.message));
    }
}

function handleMcpDelete(req, res) {
    const id = String(req.headers[SESSION_HEADER] || '').trim();
    if (id) {
        if (sessions.has(id)) {
            sessions.get(id).close();
            sessions.delete(id);
            log('closed session', id);
        }
        // Also unbind from any pairing so the studio knows.
        const code = sessionToPairing.get(id);
        if (code) {
            sessionToPairing.delete(id);
            const pairing = pairings.get(code);
            if (pairing) pairing.attachedSessions.delete(id);
        }
    }
    send204(res);
}

// ── Server ────────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') return send204(res);
    const url = new URL(req.url, `http://localhost:${PORT}`);

    if (url.pathname === '/health') {
        return sendJson(res, 200, {
            ok: true, sessions: sessions.size, pairings: pairings.size,
            protocolVersion: PROTOCOL_VERSION,
        });
    }

    const dl = url.pathname.match(/^\/mcp\/download\/([0-9a-fA-F-]{8,})$/);
    if (dl && req.method === 'GET') return handleDownload(req, res, dl[1]);

    // ── Studio pairing endpoints ─────────────────────────────────────────────
    if (url.pathname === '/studio/pair' && req.method === 'POST') return handleStudioPair(req, res);
    if (url.pathname === '/studio/events' && req.method === 'GET') {
        const code = String(url.searchParams.get('code') || '').toUpperCase();
        if (!code) return sendJson(res, 400, { error: 'code is required' });
        return handleStudioEvents(req, res, code);
    }
    if (url.pathname === '/studio/results' && req.method === 'POST') {
        const code = String(url.searchParams.get('code') || '').toUpperCase();
        if (!code) return sendJson(res, 400, { error: 'code is required' });
        return handleStudioResults(req, res, code);
    }

    if (url.pathname === '/mcp' || url.pathname === '/') {
        if (req.method === 'POST') return handleMcpPost(req, res);
        if (req.method === 'DELETE') return handleMcpDelete(req, res);
        if (req.method === 'GET') return sendJson(res, 405, { error: 'No server-initiated stream in v1' });
        return sendJson(res, 405, { error: 'Method Not Allowed' });
    }

    sendJson(res, 404, { error: 'Not found' });
});

const listener = server.listen(PORT, () => {
    const addr = listener.address();
    log(`listening on port ${addr.port} — public URL: ${PUBLIC_BASE_URL}`);
    log(`MCP endpoint:    ${PUBLIC_BASE_URL}/mcp`);
    log(`download prefix: ${PUBLIC_BASE_URL}/mcp/download/<sessionId>`);
    log(`studio pair:     POST ${PUBLIC_BASE_URL}/studio/pair`);
    log(`studio events:   GET  ${PUBLIC_BASE_URL}/studio/events?code=<code>`);
    log(`studio results:  POST ${PUBLIC_BASE_URL}/studio/results?code=<code>`);
});

// Graceful shutdown
function shutdown() {
    log('shutting down — closing', sessions.size, 'session(s)');
    for (const [, s] of sessions) s.close();
    sessions.clear();
    server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
