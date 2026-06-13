/**
 * MCP handler core — pure functions used by the stdio server.
 *
 * Exposes:
 *   listTools()          → MCP-shaped tool catalog (inputSchema, not input_schema)
 *   callTool(name, args) → { result } — the raw dispatch payload, never throws
 *
 * Reuses the same AGENT_TOOLS + dispatchTool the in-app chat agent runs, so
 * Claude (over MCP) drives the editor through the EXACT same typed-op layer as
 * the in-studio chat. Adds three ParaForm-only verbs around it:
 *   paraform_reset_document   — start a fresh document
 *   paraform_save_document    — write the in-memory doc to a .paraform.json
 *                               file the studio can open directly
 *   paraform_load_document    — replace the in-memory doc with a saved file
 *
 * The component library is loaded lazily on the first tool call so the server
 * starts up instantly; tools that don't need the library (addBox etc.) are
 * not blocked by the load.
 */

import fs from 'node:fs/promises';

import { AGENT_TOOLS, dispatchTool } from '../src/lib/ai/tools.js';
import { getDocumentStore, resetDocumentStore } from '../lib/document/index.js';
import { loadLibrary } from '../src/lib/library/index.js';

let _libraryReady = null;
async function _ensureLibrary() {
    if (!_libraryReady) _libraryReady = loadLibrary();
    return _libraryReady;
}

/** ParaForm-specific MCP verbs that wrap the document store, not AGENT_TOOLS. */
const EXTRA_TOOLS = Object.freeze([
    {
        name: 'paraform_reset_document',
        description: 'Clear the workspace and start a fresh, empty document. Call this at the start of a new build, or to discard the current document and start over.',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'paraform_save_document',
        description: 'Save the current document to a file the ParaForm studio can open. The file path should end in ".paraform.json" — the studio\'s native format. After saving, tell the user the file path so they can open it in the studio (File → Open).',
        inputSchema: {
            type: 'object',
            properties: {
                filePath: { type: 'string', description: 'Absolute file path to save to (will be created or overwritten). Should end in ".paraform.json".' },
            },
            required: ['filePath'],
        },
    },
    {
        name: 'paraform_load_document',
        description: 'Replace the in-memory document with the contents of a saved .paraform.json file so you can extend or modify an existing build.',
        inputSchema: {
            type: 'object',
            properties: {
                filePath: { type: 'string', description: 'Absolute path to the .paraform.json file to load.' },
            },
            required: ['filePath'],
        },
    },
    {
        // Read-only accessor used internally by the remote/hosted gateway to
        // serve the .paraform.json download. Safe to expose to Claude too —
        // it's just `get_document_summary` but with the full v5 JSON instead
        // of a compact summary.
        name: 'paraform_get_document_json',
        description: 'Return the full document as a v5 .paraform.json object (the studio\'s native format). Used by the hosted MCP gateway to serve the download URL — you don\'t normally need to call this directly; use paraform_save_document instead.',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        // Intercepted by the hosted gateway: binds THIS Claude conversation to
        // a live ParaForm studio tab the user has open. After a successful
        // attach, every subsequent build tool you call mutates the user's open
        // studio document in real time (live editing) instead of a private
        // server-side copy.
        //
        // How the user gets a code: open the ParaForm studio → click
        // "Connect Claude" → a 6-letter code is shown. The user reads it to
        // you and you call this tool.
        //
        // Over stdio (developer machine) there is no studio to attach to —
        // this returns an explanatory error.
        name: 'paraform_attach',
        description: 'Attach this Claude conversation to a live ParaForm studio session, so subsequent build tools mutate the user\'s open studio in real time. The user gets the code from the studio\'s "Connect Claude" button. Call this with that code.',
        inputSchema: {
            type: 'object',
            properties: {
                code: { type: 'string', description: '6-letter pairing code shown in the studio (e.g. "ABCDEF").' },
            },
            required: ['code'],
        },
    },
]);

/** Translate AGENT_TOOLS (Anthropic-shaped) into MCP tool descriptors. */
function _agentToolsAsMcp() {
    return AGENT_TOOLS.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.input_schema,
    }));
}

/** The full MCP tool catalog Claude sees on tools/list. */
export function listTools() {
    return [..._agentToolsAsMcp(), ...EXTRA_TOOLS];
}

/**
 * Dispatch one MCP tool call. NEVER throws — catches and returns an error
 * payload so the server stays alive even on a malformed request.
 *
 * @returns {Promise<{ result: object }>}
 */
export async function callTool(name, args = {}) {
    // Library is needed for placeLibraryPart / search_library / addStandardPart.
    try { await _ensureLibrary(); } catch { /* tools that don't need it still work */ }

    if (name === 'paraform_reset_document') {
        try {
            resetDocumentStore();
            return { result: { ok: true, summary: 'Document reset to empty.' } };
        } catch (e) {
            return { result: { ok: false, error: `reset failed: ${(e && e.message) || e}` } };
        }
    }

    if (name === 'paraform_save_document') {
        const filePath = typeof args.filePath === 'string' ? args.filePath : '';
        if (!filePath) return { result: { ok: false, error: 'filePath is required' } };
        try {
            const json = getDocumentStore().toJSON();
            await fs.writeFile(filePath, JSON.stringify(json, null, 2), 'utf8');
            const featureCount = (json.changelog || []).filter((c) => c && c.kind === 'addFeature').length;
            return { result: { ok: true, summary: `Saved document (${featureCount} feature${featureCount === 1 ? '' : 's'}) to ${filePath}. Tell the user to open it in the ParaForm studio.`, filePath } };
        } catch (e) {
            return { result: { ok: false, error: `save failed: ${(e && e.message) || e}` } };
        }
    }

    if (name === 'paraform_attach') {
        // Reached only when running over stdio (no gateway in front to
        // intercept). The hosted remote_server.mjs handles it directly.
        return { result: { ok: false, error: 'paraform_attach is only supported when connected via the hosted (remote) MCP gateway — over stdio there is no studio to attach to.' } };
    }

    if (name === 'paraform_get_document_json') {
        try {
            const document = getDocumentStore().toJSON();
            return { result: { ok: true, document } };
        } catch (e) {
            return { result: { ok: false, error: `serialize failed: ${(e && e.message) || e}` } };
        }
    }

    if (name === 'paraform_load_document') {
        const filePath = typeof args.filePath === 'string' ? args.filePath : '';
        if (!filePath) return { result: { ok: false, error: 'filePath is required' } };
        try {
            const text = await fs.readFile(filePath, 'utf8');
            const json = JSON.parse(text);
            getDocumentStore().fromJSON(json);
            return { result: { ok: true, summary: `Loaded document from ${filePath}`, filePath } };
        } catch (e) {
            return { result: { ok: false, error: `load failed: ${(e && e.message) || e}` } };
        }
    }

    // Otherwise route to the standard chat-agent tool layer.
    const r = await dispatchTool(name, args);
    return { result: r };
}
