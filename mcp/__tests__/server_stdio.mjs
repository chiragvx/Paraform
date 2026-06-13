/**
 * End-to-end stdio integration test for mcp/server.mjs.
 *
 * Spawns the server as a child process and exchanges real JSON-RPC 2.0 frames
 * over stdin/stdout, mirroring what Claude Desktop does. Catches wire-protocol
 * regressions that handlers.mjs alone can't see (framing, capabilities, ids,
 * shutdown).
 *
 * Run via:
 *   node mcp/__tests__/server_stdio.mjs
 *
 * No --import loader needed — the server itself uses only relative imports.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(__dirname, '..', 'server.mjs');

let _pass = 0, _fail = 0;
async function t(name, fn) {
    try { await fn(); console.log(`  ok  ${name}`); _pass++; }
    catch (e) { console.error(`  FAIL ${name}\n    ${e?.stack || e?.message || e}`); _fail++; }
}

/** Build a JSON-RPC client driving the spawned server over stdio. */
function spawnClient() {
    const child = spawn(process.execPath, [SERVER], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
    });
    const pending = new Map(); // id → {resolve, reject}
    let buffer = '';
    let nextId = 1;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
        buffer += chunk;
        let nl;
        while ((nl = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line) continue;
            let msg;
            try { msg = JSON.parse(line); } catch { continue; }
            if (msg.id != null && pending.has(msg.id)) {
                const { resolve, reject } = pending.get(msg.id);
                pending.delete(msg.id);
                if (msg.error) reject(new Error(`${msg.error.code}: ${msg.error.message}`));
                else resolve(msg.result);
            }
        }
    });
    child.stderr.on('data', () => { /* stderr is for logs; ignore */ });

    function request(method, params) {
        const id = nextId++;
        const frame = { jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) };
        return new Promise((resolve, reject) => {
            pending.set(id, { resolve, reject });
            child.stdin.write(JSON.stringify(frame) + '\n');
            // 5s safety cap — every roundtrip should be sub-second.
            setTimeout(() => {
                if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout waiting for ${method}`)); }
            }, 5000).unref();
        });
    }
    function notify(method, params) {
        const frame = { jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) };
        child.stdin.write(JSON.stringify(frame) + '\n');
    }
    async function close() {
        try { notify('exit'); } catch { /* ignore */ }
        child.stdin.end();
        await new Promise((resolve) => child.once('exit', resolve));
    }
    return { request, notify, close };
}

console.log('── MCP server stdio integration ──');

await t('initialize returns serverInfo + tools capability', async () => {
    const c = spawnClient();
    try {
        const r = await c.request('initialize', {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'integration-test', version: '0' },
        });
        assert.ok(r.protocolVersion, 'has protocolVersion');
        assert.equal(r.serverInfo.name, 'paraform');
        assert.ok(r.capabilities.tools, 'declares the tools capability');
        c.notify('notifications/initialized');
    } finally { await c.close(); }
});

await t('tools/list includes addBox and the paraform_* verbs in MCP shape', async () => {
    const c = spawnClient();
    try {
        await c.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } });
        c.notify('notifications/initialized');
        const r = await c.request('tools/list');
        const names = r.tools.map((t) => t.name);
        for (const n of ['addBox', 'addCylinder', 'paraform_save_document', 'paraform_load_document']) {
            assert.ok(names.includes(n), `tools/list missing ${n}`);
        }
        // MCP shape: every tool exposes inputSchema, not the Anthropic input_schema.
        for (const t of r.tools) {
            assert.ok(t.inputSchema, `${t.name} has inputSchema`);
            assert.ok(!('input_schema' in t), `${t.name} must not carry input_schema`);
        }
    } finally { await c.close(); }
});

await t('tools/call addBox returns text content with the dispatch result', async () => {
    const c = spawnClient();
    try {
        await c.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } });
        c.notify('notifications/initialized');
        const r = await c.request('tools/call', {
            name: 'addBox',
            arguments: { length: 10, width: 10, height: 10 },
        });
        assert.ok(Array.isArray(r.content) && r.content.length === 1);
        assert.equal(r.content[0].type, 'text');
        const payload = JSON.parse(r.content[0].text);
        assert.equal(payload.ok, true, `addBox dispatch failed: ${r.content[0].text}`);
        assert.ok(payload.featureId);
        assert.notEqual(r.isError, true, 'isError must be false on success');
    } finally { await c.close(); }
});

await t('tools/call on a failed dispatch (missing required field) sets isError:true', async () => {
    const c = spawnClient();
    try {
        await c.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } });
        c.notify('notifications/initialized');
        const r = await c.request('tools/call', {
            name: 'addBox',
            arguments: { length: 10 }, // width + height missing
        });
        assert.equal(r.isError, true, 'isError set when dispatch returns ok:false');
        const payload = JSON.parse(r.content[0].text);
        assert.equal(payload.ok, false);
        assert.match(payload.error, /missing required field/);
    } finally { await c.close(); }
});

await t('ping returns {} (keepalive)', async () => {
    const c = spawnClient();
    try {
        await c.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } });
        const r = await c.request('ping');
        assert.deepEqual(r, {});
    } finally { await c.close(); }
});

console.log(`\n${_pass} passed, ${_fail} failed`);
process.exit(_fail === 0 ? 0 : 1);
