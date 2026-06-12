/**
 * Phase 1 — AI tool layer tests.
 *
 * Run via:
 *   node --import ./src/lib/commands/__tests__/_register.mjs \
 *        src/lib/ai/__tests__/tools.mjs
 *
 * Covers:
 *   1. Every AGENT_TOOLS entry has a valid name/description/input_schema.
 *   2. dispatchTool('addBox', {...}) → { ok:true, featureId } and the feature
 *      lands in the document store.
 *   3. dispatchTool rejects unknown tools and missing-required-field input
 *      without throwing.
 *   4. get_document_summary reflects the created feature.
 */
import assert from 'node:assert/strict';

import { AGENT_TOOLS, dispatchTool, documentSummary } from '$lib/ai/tools.js';
import { resetDocumentStore, getDocumentStore } from '../../../../lib/document/index.js';

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

console.log('── Phase 1 — AI tool layer ──');

await t('AGENT_TOOLS: every tool has a valid name/description/input_schema', () => {
    assert.ok(Array.isArray(AGENT_TOOLS), 'AGENT_TOOLS is an array');
    assert.ok(AGENT_TOOLS.length >= 20, `expected >= 20 tools, got ${AGENT_TOOLS.length}`);
    const seen = new Set();
    for (const tool of AGENT_TOOLS) {
        assert.equal(typeof tool.name, 'string');
        assert.ok(tool.name.length > 0, 'name non-empty');
        assert.ok(!seen.has(tool.name), `duplicate tool name ${tool.name}`);
        seen.add(tool.name);
        assert.equal(typeof tool.description, 'string');
        assert.ok(tool.description.length > 0, `${tool.name} description non-empty`);
        const s = tool.input_schema;
        assert.ok(s && typeof s === 'object', `${tool.name} has input_schema`);
        assert.equal(s.type, 'object', `${tool.name} input_schema.type === 'object'`);
        assert.ok(s.properties && typeof s.properties === 'object', `${tool.name} has properties`);
        if (s.required !== undefined) {
            assert.ok(Array.isArray(s.required), `${tool.name} required is an array`);
            for (const r of s.required) {
                assert.ok(s.properties[r], `${tool.name} required '${r}' is declared in properties`);
            }
        }
    }
    // Spot-check that the high-value tools are all present.
    for (const required of [
        'addBox', 'addCylinder', 'addSphere', 'addExtrude', 'addRevolve',
        'addFillet', 'addChamfer', 'addShell', 'addHole',
        'addUnion', 'addCut', 'addIntersect',
        'addLinearPattern', 'addCircularPattern', 'addMirror',
        'addStandardPart', 'placeLibraryPart', 'replace_component', 'add_mate',
        'addDocumentParameter', 'setDocumentParameter', 'setFeatureParams',
        'deleteFeature', 'addComponent',
        'get_document_summary', 'list_components', 'search_library',
        'measure', 'run_invariants',
    ]) {
        assert.ok(seen.has(required), `missing expected tool '${required}'`);
    }
});

await t("dispatchTool('addBox', {...}) returns ok and creates a feature", async () => {
    resetDocumentStore();
    const before = Object.keys(getDocumentStore().doc.features).length;
    const res = await dispatchTool('addBox', { length: 10, width: 10, height: 10 });
    assert.equal(res.ok, true, `expected ok, got ${JSON.stringify(res)}`);
    assert.ok(res.featureId, 'result carries a featureId');
    const after = getDocumentStore().doc.features;
    assert.equal(Object.keys(after).length, before + 1, 'one feature was added');
    assert.ok(after[res.featureId], 'the returned featureId exists in the store');
    assert.equal(after[res.featureId].type, 'Box');
    assert.equal(after[res.featureId].params.length, 10);
});

await t('dispatchTool: unknown tool returns ok:false without throwing', async () => {
    const res = await dispatchTool('nope_not_a_tool', {});
    assert.equal(res.ok, false);
    assert.match(res.error, /unknown tool/);
});

await t('dispatchTool: missing required field returns ok:false', async () => {
    const res = await dispatchTool('addBox', { length: 10 }); // width/height missing
    assert.equal(res.ok, false);
    assert.match(res.error, /missing required field/);
});

await t('dispatchTool: type mismatch returns ok:false', async () => {
    const res = await dispatchTool('addBox', { length: 'ten', width: 10, height: 10 });
    assert.equal(res.ok, false);
    assert.match(res.error, /must be a number/);
});

await t('get_document_summary reflects the created feature', async () => {
    resetDocumentStore();
    const r = await dispatchTool('addBox', { length: 20, width: 5, height: 3 });
    assert.equal(r.ok, true);
    const summary = documentSummary();
    assert.equal(summary.ok, true);
    assert.equal(summary.featureCount, 1);
    assert.ok(summary.bodies.includes(r.featureId), 'box is in the bodies list');
    const f = summary.features.find((x) => x.id === r.featureId);
    assert.ok(f, 'feature present in summary');
    assert.equal(f.type, 'Box');
    assert.equal(f.params.length, 20);
});

await t('replace_component: swap SG90→MG90S keeps the placement (servo-mount-9g rebinds)', async () => {
    resetDocumentStore();
    const { loadLibrary } = await import('../../library/index.js');
    await loadLibrary();
    // Place an SG90 servo as a free component.
    const placed = await dispatchTool('placeLibraryPart', { partId: 'lib-part-servo-sg90' });
    assert.equal(placed.ok, true, `place failed: ${JSON.stringify(placed)}`);
    const oldId = placed.componentId;
    assert.ok(oldId, 'placement returned a componentId');
    // Swap it for an MG90S (shares interfaceId servo-mount-9g + spline-SG90).
    const swap = await dispatchTool('replace_component', {
        oldComponentId: oldId, newPartId: 'lib-part-servo-mg90s',
    });
    assert.equal(swap.ok, true, `swap failed: ${JSON.stringify(swap)}`);
    assert.ok(swap.newComponentId, 'swap returned a newComponentId');
    assert.ok(Array.isArray(swap.unresolved), 'unresolved is an array');
    // The old component should be gone from the document.
    const comps = getDocumentStore().doc.components;
    assert.ok(!comps[oldId], 'old component removed after swap');
    assert.ok(comps[swap.newComponentId], 'new component present after swap');
});

await t('replace_component: unknown component returns ok:false without throwing', async () => {
    const res = await dispatchTool('replace_component', {
        oldComponentId: 'not-a-real-component', newPartId: 'lib-part-servo-mg90s',
    });
    assert.equal(res.ok, false);
    assert.ok(typeof res.error === 'string' && res.error.length, 'carries an error string');
});

console.log(`\n${_pass} passed, ${_fail} failed`);
process.exit(_fail === 0 ? 0 : 1);
