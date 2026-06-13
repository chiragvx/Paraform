/**
 * Tests for mcp/handlers.mjs — the core of the ParaForm MCP server.
 *
 * Run via:
 *   node --import ./src/lib/commands/__tests__/_register.mjs \
 *        mcp/__tests__/handlers.mjs
 *
 * Covers:
 *   1. listTools includes every AGENT_TOOL plus the three paraform_* verbs,
 *      in MCP shape (inputSchema, not input_schema).
 *   2. callTool drives the SAME document store the in-studio chat agent uses
 *      (addBox + get_document_summary round-trip).
 *   3. paraform_reset_document clears the workspace.
 *   4. paraform_save_document + paraform_load_document round-trip through a
 *      .paraform.json file — the studio's native format.
 *   5. callTool never throws on bad input.
 *   6. Library-backed tools (search_library) work without a kernel.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { listTools, callTool } from '../handlers.mjs';
import { resetDocumentStore, getDocumentStore } from '../../lib/document/index.js';

let _pass = 0, _fail = 0;
async function t(name, fn) {
    try {
        await fn();
        console.log(`  ok  ${name}`);
        _pass++;
    } catch (e) {
        console.error(`  FAIL ${name}\n    ${e?.stack || e?.message || e}`);
        _fail++;
    }
}

console.log('── MCP handlers (Claude connector) ──');

await t('listTools: every tool has MCP shape (inputSchema, not input_schema)', () => {
    const tools = listTools();
    assert.ok(Array.isArray(tools) && tools.length >= 25, `expected ≥ 25 tools, got ${tools.length}`);
    const seen = new Set();
    for (const tool of tools) {
        assert.equal(typeof tool.name, 'string');
        assert.ok(tool.name.length > 0);
        assert.ok(!seen.has(tool.name), `duplicate tool ${tool.name}`);
        seen.add(tool.name);
        assert.equal(typeof tool.description, 'string');
        assert.ok(tool.description.length > 0, `${tool.name} description non-empty`);
        assert.ok(tool.inputSchema && tool.inputSchema.type === 'object',
            `${tool.name} inputSchema must be an object schema`);
        // MCP uses `inputSchema`, not the Anthropic-style `input_schema`.
        assert.ok(!('input_schema' in tool), `${tool.name} must not carry input_schema`);
    }
    // Spot-check a representative slice.
    for (const required of [
        'addBox', 'addCylinder', 'placeLibraryPart', 'search_library',
        'get_document_summary', 'measure', 'run_invariants',
        'paraform_reset_document', 'paraform_save_document', 'paraform_load_document',
    ]) {
        assert.ok(seen.has(required), `missing expected tool '${required}'`);
    }
});

await t("callTool('addBox', …) mutates the SAME document store as the chat agent", async () => {
    resetDocumentStore();
    const before = Object.keys(getDocumentStore().doc.features).length;
    const { result } = await callTool('addBox', { length: 12, width: 8, height: 4 });
    assert.equal(result.ok, true, `addBox failed: ${JSON.stringify(result)}`);
    assert.ok(result.featureId, 'returned a featureId');
    const after = getDocumentStore().doc.features;
    assert.equal(Object.keys(after).length, before + 1);
    assert.equal(after[result.featureId].type, 'Box');
    assert.equal(after[result.featureId].params.length, 12);
});

await t("callTool('get_document_summary', {}) reflects the built features", async () => {
    const { result } = await callTool('get_document_summary', {});
    assert.equal(result.ok, true);
    assert.ok(result.featureCount >= 1);
    assert.ok(result.bodies.length >= 1);
});

await t('paraform_reset_document clears the workspace', async () => {
    await callTool('addBox', { length: 5, width: 5, height: 5 });
    assert.ok(Object.keys(getDocumentStore().doc.features).length > 0);
    const { result } = await callTool('paraform_reset_document', {});
    assert.equal(result.ok, true);
    assert.equal(Object.keys(getDocumentStore().doc.features).length, 0,
        'all features cleared after reset');
});

await t('paraform_save_document + paraform_load_document round-trip a .paraform.json', async () => {
    // Build a small assembly.
    resetDocumentStore();
    await callTool('addBox', { length: 40, width: 20, height: 5 });
    await callTool('addCylinder', { radius: 6, height: 12 });
    const summaryBefore = (await callTool('get_document_summary', {})).result;
    assert.equal(summaryBefore.featureCount, 2);

    // Save it.
    const tmpFile = path.join(os.tmpdir(), `paraform-mcp-test-${process.pid}-${Date.now()}.paraform.json`);
    const saveRes = (await callTool('paraform_save_document', { filePath: tmpFile })).result;
    try {
        assert.equal(saveRes.ok, true, `save failed: ${JSON.stringify(saveRes)}`);
        const written = await fs.readFile(tmpFile, 'utf8');
        const json = JSON.parse(written);
        assert.equal(json.version, 5, 'native v5 schema');
        assert.ok(Array.isArray(json.changelog) && json.changelog.length > 0);

        // Wipe and load it back.
        resetDocumentStore();
        assert.equal(Object.keys(getDocumentStore().doc.features).length, 0);
        const loadRes = (await callTool('paraform_load_document', { filePath: tmpFile })).result;
        assert.equal(loadRes.ok, true, `load failed: ${JSON.stringify(loadRes)}`);
        const summaryAfter = (await callTool('get_document_summary', {})).result;
        assert.equal(summaryAfter.featureCount, 2, 'features restored from disk');
        const types = summaryAfter.features.map((f) => f.type).sort();
        assert.deepEqual(types, ['Box', 'Cylinder']);
    } finally {
        try { await fs.unlink(tmpFile); } catch { /* best effort */ }
    }
});

await t('paraform_save_document: missing filePath returns ok:false (no throw)', async () => {
    const { result } = await callTool('paraform_save_document', {});
    assert.equal(result.ok, false);
    assert.match(result.error, /filePath/);
});

await t('callTool: unknown tool returns ok:false without throwing', async () => {
    const { result } = await callTool('nope_not_a_tool', {});
    assert.equal(result.ok, false);
    assert.match(result.error, /unknown tool/);
});

await t('search_library works headlessly (no kernel, no network)', async () => {
    const { result } = await callTool('search_library', { query: 'sg90 servo', limit: 3 });
    assert.equal(result.ok, true, `search_library failed: ${JSON.stringify(result)}`);
    assert.ok(Array.isArray(result.hits));
    assert.ok(result.hits.length >= 1, 'at least one hit for sg90 servo');
});

console.log(`\n${_pass} passed, ${_fail} failed`);
process.exit(_fail === 0 ? 0 : 1);
