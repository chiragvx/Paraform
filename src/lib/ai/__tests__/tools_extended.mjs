/**
 * Extended AI tool-layer tests — the capabilities added in the "next-level"
 * pass: sketch authoring, viewport-deixis tools, connector declaration (9-rule
 * enforcement), DFM/print data tools, the design-context memory, and alias
 * resolution in dispatchTool. Also confirms graceful degradation when no kernel
 * client is configured (the test environment).
 *
 * Run via:
 *   node --import ./src/lib/commands/__tests__/_register.mjs \
 *        src/lib/ai/__tests__/tools_extended.mjs
 */
import assert from 'node:assert/strict';

import { AGENT_TOOLS, dispatchTool, documentSummary } from '$lib/ai/tools.js';
import { getAIContext } from '$lib/ai/context.js';
import { resetDocumentStore } from '../../../../lib/document/index.js';

let _pass = 0, _fail = 0;
async function t(name, fn) {
    try { await fn(); console.log(`  ok  ${name}`); _pass++; }
    catch (e) { console.error(`  FAIL ${name}\n    ${e?.stack || e?.message || e}`); _fail++; }
}

console.log('── Extended AI tool layer ──');

await t('AGENT_TOOLS: new tools are present, schemas valid, names unique', () => {
    const names = new Set(AGENT_TOOLS.map((x) => x.name));
    const expected = [
        'addSketch', 'addSweep', 'addLoft', 'suppressFeature',
        'get_selection', 'fillet_selected_edges', 'hole_on_selected_face', 'push_pull_selected_face',
        'propose_brief', 'name_feature', 'get_context', 'record_decision', 'explain_decision', 'add_requirement',
        'compile_status', 'mass_properties', 'self_critique',
        'check_printability', 'export_for_print', 'recommend_material', 'compute_clearance', 'estimate_print',
        'declareConnector', 'find_compatible_connectors', 'list_connectors', 'generate_bom',
    ];
    for (const n of expected) assert.ok(names.has(n), `missing tool ${n}`);
    // No duplicates across the aggregated surface.
    assert.equal(names.size, AGENT_TOOLS.length, 'duplicate tool name in AGENT_TOOLS');
    for (const tool of AGENT_TOOLS) {
        assert.equal(typeof tool.name, 'string');
        assert.equal(typeof tool.description, 'string');
        assert.ok(tool.input_schema && tool.input_schema.type === 'object', `${tool.name} bad schema`);
    }
});

await t('addSketch builds a profile and addExtrude consumes it', async () => {
    resetDocumentStore();
    const sk = await dispatchTool('addSketch', { plane: 'XY', entities: [{ kind: 'rect', x1: -20, y1: -10, x2: 20, y2: 10 }] });
    assert.equal(sk.ok, true, sk.error);
    assert.ok(sk.featureId, 'sketch returned a featureId');
    assert.equal(sk.sketchFeatureId, sk.featureId);
    const ex = await dispatchTool('addExtrude', { sketchFeatureId: sk.sketchFeatureId, amount: 5 });
    assert.equal(ex.ok, true, ex.error);
    const summ = documentSummary();
    assert.ok(summ.features.some((f) => f.type === 'Sketch'), 'a Sketch feature exists');
    assert.ok(summ.features.some((f) => f.type === 'Extrude'), 'an Extrude feature exists');
});

await t('addSketch rejects an empty / all-invalid profile without throwing', async () => {
    resetDocumentStore();
    const empty = await dispatchTool('addSketch', { entities: [] });
    assert.equal(empty.ok, false);
    const bad = await dispatchTool('addSketch', { entities: [{ kind: 'circle', cx: 0, cy: 0 }] }); // no radius
    assert.equal(bad.ok, false);
});

await t('alias resolution: name a feature, then refer to it by name', async () => {
    resetDocumentStore();
    getAIContext().reset();
    const box = await dispatchTool('addBox', { length: 10, width: 10, height: 10 });
    assert.equal(box.ok, true);
    const named = await dispatchTool('name_feature', { id: box.featureId, name: 'baseplate' });
    assert.equal(named.ok, true);
    // Edit by the human name — dispatch must resolve "baseplate" → the real id.
    const edit = await dispatchTool('setFeatureParams', { featureId: 'baseplate', paramsPatch: { height: 20 } });
    assert.equal(edit.ok, true, edit.error);
    assert.equal(edit.featureId, box.featureId, 'alias resolved to the real feature id');
});

await t('declareConnector enforces the contract (rejects missing gender / size)', async () => {
    resetDocumentStore();
    const box = await dispatchTool('addBox', { length: 10, width: 10, height: 10 });
    // Missing gender → rejected (no neutral-by-default).
    const noGender = await dispatchTool('declareConnector', {
        featureId: box.featureId, kind: 'bore', size: { nominal: 3, unit: 'mm' },
        origin: [0, 0, 10], axis: [0, 0, 1], inducedJoint: 'fixed',
    });
    assert.equal(noGender.ok, false, 'missing gender must be rejected');
    // Valid → ok, locked connector created.
    const good = await dispatchTool('declareConnector', {
        featureId: box.featureId, kind: 'bore', gender: 'female', size: { nominal: 3, unit: 'mm' },
        origin: [5, 5, 10], axis: [0, 0, 1], inducedJoint: 'fixed',
    });
    assert.equal(good.ok, true, good.error);
    assert.ok(good.connectorId, 'connector created');
    // The agent surface must NOT expose connector mutation.
    const names = new Set(AGENT_TOOLS.map((x) => x.name));
    assert.ok(!names.has('updateConnector') && !names.has('removeConnector'), 'connector mutation must stay hidden');
});

await t('get_selection returns ok with empty selection (no viewport in tests)', async () => {
    const r = await dispatchTool('get_selection', {});
    assert.equal(r.ok, true);
    assert.equal(r.count, 0);
    // A deixis tool with nothing picked must fail gracefully, not throw.
    const fil = await dispatchTool('fillet_selected_edges', { radius: 1 });
    assert.equal(fil.ok, false);
    assert.ok(/no edge/i.test(fil.error), 'helpful message');
});

await t('DFM data tools return sane values without a kernel', async () => {
    const press = await dispatchTool('compute_clearance', { fit: 'press', process: 'fdm' });
    assert.equal(press.ok, true);
    assert.ok(press.perSideMm < 0, 'press fit is an interference (negative)');
    const slide = await dispatchTool('compute_clearance', { fit: 'slide' });
    assert.equal(slide.ok, true);
    assert.ok(slide.perSideMm > 0);
    const mat = await dispatchTool('recommend_material', { intent: 'outdoor bracket exposed to sun and UV' });
    assert.equal(mat.ok, true);
    assert.equal(mat.pick, 'ASA');
});

await t('check_printability / mass_properties degrade gracefully without a kernel', async () => {
    resetDocumentStore();
    await dispatchTool('addBox', { length: 10, width: 10, height: 10 });
    const pr = await dispatchTool('check_printability', {});
    assert.equal(pr.ok, true, 'check_printability never throws');
    assert.ok(['red', 'yellow', 'green'].includes(pr.verdict));
    // mass_properties without a kernel returns ok:false (no crash) — graceful.
    const summ = documentSummary();
    const mp = await dispatchTool('mass_properties', { featureId: summ.bodies[0], material: 'PLA' });
    assert.ok(mp && typeof mp.ok === 'boolean', 'mass_properties returns a result object');
});

await t('self_critique never throws and returns a verdict', async () => {
    const sc = await dispatchTool('self_critique', {});
    assert.equal(sc.ok, true);
    assert.ok(['ok', 'fix-needed'].includes(sc.verdict));
});

await t('design-context memory: brief, decisions, requirements round-trip', async () => {
    getAIContext().reset();
    const b = await dispatchTool('propose_brief', { function: 'Pi 4 desk cradle', material: 'PETG' });
    assert.equal(b.ok, true);
    await dispatchTool('record_decision', { what: 'wall = 2.8mm', why: 'sturdy snap-fit at 0.4mm nozzle' });
    const why = await dispatchTool('explain_decision', { topic: 'wall' });
    assert.equal(why.ok, true);
    assert.ok(why.decision && /2\.8/.test(why.decision.what), 'decision recalled');
    const req = await dispatchTool('add_requirement', { text: 'under 200 g', kind: 'mass', comparator: '<=', value: 200, unit: 'g' });
    assert.equal(req.ok, true);
    const ctx = await dispatchTool('get_context', {});
    assert.equal(ctx.ok, true);
    assert.ok(ctx.brief && /cradle/i.test(ctx.brief.function), 'brief stored');
    assert.ok(ctx.requirements.some((r) => /200/.test(r.text)), 'requirement stored');
});

console.log(`\n${_pass} passed, ${_fail} failed`);
if (_fail) process.exit(1);
