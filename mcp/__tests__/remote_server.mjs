/**
 * Integration test for mcp/remote_server.mjs — the hosted Claude connector.
 *
 * Spawns the gateway on an ephemeral port and drives it via real HTTP/fetch
 * with the Streamable HTTP MCP envelope, asserting:
 *   1. initialize mints + returns an Mcp-Session-Id
 *   2. tools/list works through the gateway (proxied to a child)
 *   3. tools/call mutates per-session state in the child
 *   4. /mcp/download/<id> returns a v5 .paraform.json download
 *   5. paraform_save_document is intercepted: returns a download URL, NOT a
 *      server-side file write
 *   6. separate sessions are fully isolated (no cross-talk)
 *   7. DELETE /mcp tears down a session
 *
 * Run via:  node mcp/__tests__/remote_server.mjs
 * (No --import loader needed — the gateway uses only relative imports.)
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(__dirname, '..', 'remote_server.mjs');

let _pass = 0, _fail = 0;
async function t(name, fn) {
    try { await fn(); console.log(`  ok  ${name}`); _pass++; }
    catch (e) { console.error(`  FAIL ${name}\n    ${e?.stack || e?.message || e}`); _fail++; }
}

/** Pick a free localhost port. */
function freePort() {
    return new Promise((resolve, reject) => {
        const s = net.createServer();
        s.unref();
        s.listen(0, () => { const port = s.address().port; s.close(() => resolve(port)); });
        s.on('error', reject);
    });
}

async function spawnGateway() {
    const port = await freePort();
    const baseUrl = `http://localhost:${port}`;
    const child = spawn(process.execPath, [SERVER], {
        stdio: ['ignore', 'ignore', 'pipe'],
        env: {
            ...process.env,
            PARAFORM_MCP_PORT: String(port),
            PARAFORM_MCP_PUBLIC_URL: baseUrl,
            PARAFORM_MCP_SESSION_IDLE_MS: '600000',
        },
    });
    // Wait for the gateway to log "listening" on stderr.
    let ready = false;
    child.stderr.setEncoding('utf8');
    const readyPromise = new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('gateway did not become ready in time')), 8000);
        child.stderr.on('data', (chunk) => {
            if (!ready && /listening on port/.test(chunk)) {
                ready = true; clearTimeout(t); resolve();
            }
        });
        child.on('exit', (code) => { if (!ready) { clearTimeout(t); reject(new Error(`gateway exited (${code})`)); } });
    });
    await readyPromise;
    return { child, baseUrl };
}

/** Stop the gateway and any children it spawned. */
async function stopGateway(g) {
    g.child.kill();
    await once(g.child, 'exit').catch(() => {});
}

/** Run a single Streamable HTTP MCP session against the gateway. */
function makeMcpClient(baseUrl) {
    let sessionId = null;
    let nextId = 1;
    async function rpc(method, params, { notify = false } = {}) {
        const body = { jsonrpc: '2.0', method };
        if (!notify) body.id = nextId++;
        if (params !== undefined) body.params = params;
        const headers = { 'Content-Type': 'application/json' };
        if (sessionId) headers['Mcp-Session-Id'] = sessionId;
        const res = await fetch(`${baseUrl}/mcp`, { method: 'POST', headers, body: JSON.stringify(body) });
        const newSession = res.headers.get('Mcp-Session-Id');
        if (newSession && !sessionId) sessionId = newSession;
        if (notify) {
            if (res.status !== 202) throw new Error(`notify expected 202, got ${res.status}`);
            return null;
        }
        const text = await res.text();
        let json;
        try { json = JSON.parse(text); } catch { throw new Error(`non-JSON response (${res.status}): ${text.slice(0, 200)}`); }
        if (json.error) throw new Error(`rpc error ${json.error.code}: ${json.error.message}`);
        return { result: json.result, status: res.status };
    }
    async function close() {
        if (!sessionId) return;
        await fetch(`${baseUrl}/mcp`, { method: 'DELETE', headers: { 'Mcp-Session-Id': sessionId } });
    }
    return {
        rpc,
        close,
        get sessionId() { return sessionId; },
    };
}

console.log('── MCP remote server (Streamable HTTP gateway) ──');

let GW;
try {
    GW = await spawnGateway();

    await t('health endpoint responds', async () => {
        const r = await fetch(`${GW.baseUrl}/health`);
        assert.equal(r.status, 200);
        const body = await r.json();
        assert.equal(body.ok, true);
        assert.equal(typeof body.sessions, 'number');
    });

    await t('initialize mints an Mcp-Session-Id and returns serverInfo', async () => {
        const c = makeMcpClient(GW.baseUrl);
        try {
            const { result } = await c.rpc('initialize', {
                protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' },
            });
            assert.ok(c.sessionId, 'gateway returned an Mcp-Session-Id');
            assert.equal(result.serverInfo.name, 'paraform');
            assert.ok(result.capabilities.tools, 'tools capability declared');
            await c.rpc('notifications/initialized', undefined, { notify: true });
        } finally { await c.close(); }
    });

    await t('tools/list proxies through the gateway to the child', async () => {
        const c = makeMcpClient(GW.baseUrl);
        try {
            await c.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } });
            const { result } = await c.rpc('tools/list');
            const names = result.tools.map((t) => t.name);
            for (const n of ['addBox', 'addCylinder', 'paraform_save_document']) {
                assert.ok(names.includes(n), `tools/list missing ${n}`);
            }
        } finally { await c.close(); }
    });

    await t('tools/call addBox mutates per-session state in the child', async () => {
        const c = makeMcpClient(GW.baseUrl);
        try {
            await c.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } });
            const { result } = await c.rpc('tools/call', { name: 'addBox', arguments: { length: 10, width: 10, height: 10 } });
            const payload = JSON.parse(result.content[0].text);
            assert.equal(payload.ok, true, `addBox failed: ${result.content[0].text}`);
            assert.ok(payload.featureId, 'returned featureId');
            // Confirm the same session sees the box on a follow-up.
            const summary = JSON.parse((await c.rpc('tools/call', { name: 'get_document_summary', arguments: {} })).result.content[0].text);
            assert.ok(summary.features.some((f) => f.type === 'Box'), 'Box visible in summary');
        } finally { await c.close(); }
    });

    await t('paraform_save_document is intercepted — returns a download URL, NOT a server file', async () => {
        const c = makeMcpClient(GW.baseUrl);
        try {
            await c.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } });
            await c.rpc('tools/call', { name: 'addBox', arguments: { length: 5, width: 5, height: 5 } });
            // Pass a bogus filePath: the gateway must ignore it and hand back a URL.
            const { result } = await c.rpc('tools/call', { name: 'paraform_save_document', arguments: { filePath: '/should/not/be/written.json' } });
            const payload = JSON.parse(result.content[0].text);
            assert.equal(payload.ok, true);
            assert.ok(payload.url, 'returned a download URL');
            assert.ok(payload.url.includes(`/mcp/download/${c.sessionId}`), `URL points at this session: ${payload.url}`);
            assert.ok(!payload.filePath, 'no server-side filePath returned');
        } finally { await c.close(); }
    });

    await t('GET /mcp/download/<id> returns the live document as .paraform.json', async () => {
        const c = makeMcpClient(GW.baseUrl);
        try {
            await c.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } });
            await c.rpc('tools/call', { name: 'addBox', arguments: { length: 40, width: 20, height: 5 } });
            await c.rpc('tools/call', { name: 'addCylinder', arguments: { radius: 6, height: 12 } });
            const res = await fetch(`${GW.baseUrl}/mcp/download/${c.sessionId}`);
            assert.equal(res.status, 200);
            const dispo = res.headers.get('Content-Disposition') || '';
            assert.match(dispo, /attachment;.*\.paraform\.json/);
            const json = await res.json();
            assert.equal(json.version, 5, 'native v5 schema');
            assert.ok(Array.isArray(json.changelog) && json.changelog.length >= 2, 'changelog has the two features');
        } finally { await c.close(); }
    });

    await t('sessions are isolated: state from session A is invisible to session B', async () => {
        const a = makeMcpClient(GW.baseUrl);
        const b = makeMcpClient(GW.baseUrl);
        try {
            await a.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'A', version: '0' } });
            await b.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'B', version: '0' } });
            assert.notEqual(a.sessionId, b.sessionId, 'distinct session ids');
            // Build a box only in A.
            await a.rpc('tools/call', { name: 'addBox', arguments: { length: 30, width: 30, height: 30 } });
            const aSummary = JSON.parse((await a.rpc('tools/call', { name: 'get_document_summary', arguments: {} })).result.content[0].text);
            const bSummary = JSON.parse((await b.rpc('tools/call', { name: 'get_document_summary', arguments: {} })).result.content[0].text);
            assert.ok(aSummary.features.some((f) => f.type === 'Box'), 'A has the Box');
            assert.equal(bSummary.featureCount, 0, 'B is empty — no leak across sessions');
        } finally { await a.close(); await b.close(); }
    });

    await t('DELETE /mcp with the session header tears the session down', async () => {
        const c = makeMcpClient(GW.baseUrl);
        await c.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } });
        const id = c.sessionId;
        await c.close();
        // Follow-up call with the same id must now be rejected.
        const res = await fetch(`${GW.baseUrl}/mcp`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': id },
            body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/list' }),
        });
        assert.equal(res.status, 400);
        const body = await res.json();
        assert.match(body.error.message, /No active session/);
    });

    // ── Paired-mode (live editing) tests ────────────────────────────────────
    // Simulate a studio: POST /studio/pair, open SSE on /studio/events, dispatch
    // every incoming tool_call against a fresh local document store, POST the
    // result back to /studio/results. Then simulate Claude: initialize → call
    // paraform_attach(code) → call addBox → expect the box to land in OUR doc
    // store (proving the gateway forwarded across).
    async function studioPair(baseUrl) {
        const res = await fetch(`${baseUrl}/studio/pair`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
        });
        if (!res.ok) throw new Error(`pair failed: ${res.status}`);
        return res.json(); // { code, eventsUrl, resultsUrl, mcpUrl, attachPhrase }
    }

    /**
     * Open the SSE stream and run a dispatch function for every tool_call event.
     * Returns { close() } and an `events` array of received tool_call payloads.
     */
    function openStudioStream({ eventsUrl, resultsUrl }, dispatchFn) {
        const url = new URL(eventsUrl);
        const events = [];
        let toolCallsHandled = 0;
        const ready = {};
        ready.promise = new Promise((resolve) => { ready.resolve = resolve; });

        const req = http.request({
            hostname: url.hostname, port: url.port, path: url.pathname + url.search,
            method: 'GET', headers: { Accept: 'text/event-stream' },
        }, (res) => {
            if (res.statusCode !== 200) {
                ready.resolve(new Error(`SSE status ${res.statusCode}`));
                return;
            }
            res.setEncoding('utf8');
            let buf = '';
            res.on('data', async (chunk) => {
                buf += chunk;
                let sep;
                while ((sep = buf.indexOf('\n\n')) !== -1) {
                    const block = buf.slice(0, sep);
                    buf = buf.slice(sep + 2);
                    const lines = block.split('\n');
                    let event = 'message', data = '';
                    for (const line of lines) {
                        if (line.startsWith('event:')) event = line.slice(6).trim();
                        else if (line.startsWith('data:')) data += line.slice(5).trim();
                    }
                    if (event === 'hello') { ready.resolve(); continue; }
                    if (!data) continue;
                    let msg;
                    try { msg = JSON.parse(data); } catch { continue; }
                    if (msg.type !== 'tool_call') continue;
                    events.push(msg);
                    toolCallsHandled++;
                    const result = await dispatchFn(msg.name, msg.arguments || {});
                    await fetch(resultsUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ callId: msg.callId, result }),
                    }).catch(() => { /* the test will surface failures */ });
                }
            });
            res.on('end', () => { /* ok */ });
            res.on('error', () => { /* ok */ });
        });
        req.on('error', (e) => ready.resolve(e));
        req.end();

        return {
            ready: ready.promise,
            events,
            get toolCallsHandled() { return toolCallsHandled; },
            close() { try { req.destroy(); } catch { /* ignore */ } },
        };
    }

    await t('paired mode: paraform_attach binds the Claude session to a studio pairing', async () => {
        const { code, eventsUrl, resultsUrl, attachPhrase, mcpUrl } = await studioPair(GW.baseUrl);
        assert.ok(code && code.length >= 4, `expected a code, got "${code}"`);
        assert.ok(attachPhrase.includes(code), 'attachPhrase carries the code');
        assert.equal(mcpUrl, `${GW.baseUrl}/mcp`);

        const studio = openStudioStream({ eventsUrl, resultsUrl }, async () => ({ ok: true }));
        const r = await studio.ready;
        if (r instanceof Error) throw r;
        try {
            const c = makeMcpClient(GW.baseUrl);
            await c.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } });
            const { result } = await c.rpc('tools/call', { name: 'paraform_attach', arguments: { code } });
            const payload = JSON.parse(result.content[0].text);
            assert.equal(payload.ok, true, `attach failed: ${result.content[0].text}`);
            assert.equal(payload.code, code);
            await c.close();
        } finally { studio.close(); }
    });

    await t('paired mode: tool calls route to the studio and the studio\'s doc store mutates', async () => {
        // Load library + import real dispatchTool so the simulated studio
        // mutates a real per-test document store, exactly like the browser would.
        const { dispatchTool } = await import('../../src/lib/ai/tools.js');
        const { resetDocumentStore, getDocumentStore } = await import('../../lib/document/index.js');
        const { loadLibrary } = await import('../../src/lib/library/index.js');
        await loadLibrary();
        resetDocumentStore();

        const { code, eventsUrl, resultsUrl } = await studioPair(GW.baseUrl);
        const studio = openStudioStream({ eventsUrl, resultsUrl }, (name, args) => dispatchTool(name, args));
        const r = await studio.ready;
        if (r instanceof Error) throw r;
        try {
            const c = makeMcpClient(GW.baseUrl);
            await c.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } });
            const attach = await c.rpc('tools/call', { name: 'paraform_attach', arguments: { code } });
            assert.equal(JSON.parse(attach.result.content[0].text).ok, true);

            // Claude calls addBox — the studio's doc store must gain a Box.
            const before = Object.keys(getDocumentStore().doc.features).length;
            const { result } = await c.rpc('tools/call', { name: 'addBox', arguments: { length: 25, width: 25, height: 25 } });
            const payload = JSON.parse(result.content[0].text);
            assert.equal(payload.ok, true, `addBox via paired studio failed: ${result.content[0].text}`);
            assert.ok(payload.featureId, 'returned a featureId from studio dispatch');

            const after = getDocumentStore().doc.features;
            assert.equal(Object.keys(after).length, before + 1, 'one feature added to studio doc');
            assert.equal(after[payload.featureId].type, 'Box');
            assert.equal(after[payload.featureId].params.length, 25);

            // And the studio observed the call (proves the gateway forwarded it).
            const addBoxCalls = studio.events.filter((e) => e.name === 'addBox');
            assert.equal(addBoxCalls.length, 1, 'studio received exactly one addBox tool_call');

            await c.close();
        } finally { studio.close(); }
    });

    await t('paired mode: invalid code returns ok:false and does NOT attach', async () => {
        const c = makeMcpClient(GW.baseUrl);
        try {
            await c.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } });
            const { result } = await c.rpc('tools/call', { name: 'paraform_attach', arguments: { code: 'NOPENO' } });
            const payload = JSON.parse(result.content[0].text);
            assert.equal(payload.ok, false);
            assert.match(payload.error, /No live studio/);
        } finally { await c.close(); }
    });

    await t('a request with no session id and method != initialize is rejected', async () => {
        const res = await fetch(`${GW.baseUrl}/mcp`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
        });
        assert.equal(res.status, 400);
    });

} finally {
    if (GW) await stopGateway(GW);
}

console.log(`\n${_pass} passed, ${_fail} failed`);
process.exit(_fail === 0 ? 0 : 1);
