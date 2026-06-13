#!/usr/bin/env node
/**
 * ParaForm MCP server (stdio transport).
 *
 * Dep-free implementation of the Model Context Protocol over newline-delimited
 * JSON-RPC 2.0 on stdin/stdout. Designed to be spawned by Claude Desktop:
 *
 *   {
 *     "mcpServers": {
 *       "paraform": {
 *         "command": "node",
 *         "args": ["<abs path>/mcp/server.mjs"]
 *       }
 *     }
 *   }
 *
 * Users connect Claude (Opus / Sonnet on their existing subscription) to this
 * server and drive ParaForm tools directly — no Anthropic API key required.
 *
 * Methods implemented:
 *   - initialize                  → capabilities + serverInfo
 *   - notifications/initialized   (no reply)
 *   - ping                        → {}
 *   - tools/list                  → { tools: […] }
 *   - tools/call                  → { content: [{type:'text', text}], isError }
 *   - shutdown / exit             clean exit
 *
 * Anything written to stdout MUST be a JSON-RPC frame; logging goes to stderr.
 */

import { listTools, callTool } from './handlers.mjs';

const SERVER_INFO = { name: 'paraform', version: '0.1.0' };
const PROTOCOL_VERSION = '2024-11-05';

function log(...parts) {
    const line = parts.map((p) => typeof p === 'string' ? p : JSON.stringify(p)).join(' ');
    process.stderr.write(`[paraform-mcp] ${line}\n`);
}

function send(message) {
    process.stdout.write(JSON.stringify(message) + '\n');
}
function ok(id, result) { send({ jsonrpc: '2.0', id, result }); }
function err(id, code, message, data) {
    send({ jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } });
}

async function handleMessage(msg) {
    // A request has an id; a notification doesn't. Only requests get replies.
    const isRequest = msg && msg.id !== undefined && msg.id !== null;
    const id = isRequest ? msg.id : null;

    try {
        switch (msg && msg.method) {
            case 'initialize': {
                if (!isRequest) return;
                return ok(id, {
                    protocolVersion: PROTOCOL_VERSION,
                    capabilities: { tools: { listChanged: false } },
                    serverInfo: SERVER_INFO,
                });
            }
            case 'notifications/initialized':
                return; // notification, no reply
            case 'ping':
                if (!isRequest) return;
                return ok(id, {});
            case 'tools/list':
                if (!isRequest) return;
                return ok(id, { tools: listTools() });
            case 'tools/call': {
                if (!isRequest) return;
                const params = msg.params || {};
                const name = params.name;
                const args = params.arguments || {};
                if (typeof name !== 'string' || !name) {
                    return err(id, -32602, 'Invalid params: name is required');
                }
                const { result } = await callTool(name, args);
                const isError = !!(result && result.ok === false);
                return ok(id, {
                    content: [{ type: 'text', text: JSON.stringify(result) }],
                    isError,
                });
            }
            case 'shutdown':
                if (isRequest) ok(id, null);
                return;
            case 'exit':
                process.exit(0);
                return;
            default:
                if (!isRequest) return; // ignore unknown notifications
                return err(id, -32601, `Method not found: ${msg && msg.method}`);
        }
    } catch (e) {
        if (isRequest) err(id, -32603, `Internal error: ${(e && e.message) || String(e)}`);
        else log('handler error on notification:', (e && e.message) || e);
    }
}

// ── stdin reader: newline-delimited JSON-RPC ──────────────────────────────────
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); }
        catch (e) {
            log('parse error:', e.message, '— first 200 chars:', line.slice(0, 200));
            continue;
        }
        // Don't await — JSON-RPC permits out-of-order responses, and slow
        // handlers (e.g. library load) shouldn't block other messages.
        handleMessage(msg).catch((e) => log('handler crash:', (e && e.message) || e));
    }
});
process.stdin.on('end', () => process.exit(0));

log(`ready — protocol ${PROTOCOL_VERSION}, ${listTools().length} tools registered`);
