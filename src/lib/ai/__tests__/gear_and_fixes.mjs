/**
 * Gear generator + weak-model robustness fixes — regression tests for the
 * issues surfaced by a real "make a 12-tooth gear with M3 screw holes" run that
 * looped and failed:
 *   1. addGear: a one-call parametric spur gear (teeth + bore + bolt circle),
 *      so the model never has to synthesize a gear from primitives.
 *   2. validateInput: an explicit `componentId: null` on an OPTIONAL field is no
 *      longer a type error (the model passed null for "root" and got rejected).
 *   3. pattern guard: a dangling/mistyped featureId is rejected with a clear
 *      message instead of emitting `n_<missing>` → kernel "name not defined";
 *      and circular-patterning a Hole is rejected with the bolt-circle hint.
 *
 * Run via:
 *   node --import ./src/lib/commands/__tests__/_register.mjs \
 *        src/lib/ai/__tests__/gear_and_fixes.mjs
 */
import assert from 'node:assert/strict';

import { AGENT_TOOLS, dispatchTool } from '$lib/ai/tools.js';
import { resetDocumentStore, makeFeature, getDocumentStore } from '../../../../lib/document/index.js';
import { emitGearPython } from '../../../../lib/document/emit.js';

let _pass = 0, _fail = 0;
async function t(name, fn) {
    try { await fn(); console.log(`  ok  ${name}`); _pass++; }
    catch (e) { console.error(`  FAIL ${name}\n    ${e?.stack || e?.message || e}`); _fail++; }
}

console.log('── Gear generator + weak-model robustness fixes ──');

await t('AGENT_TOOLS exposes addGear (required: teeth), and Gear is a body type', () => {
    const g = AGENT_TOOLS.find((x) => x.name === 'addGear');
    assert.ok(g, 'addGear missing from the tool surface');
    assert.deepEqual(g.input_schema.required, ['teeth']);
});

await t('addGear creates a Gear feature — the user request: 12T Ø500×50, bore Ø50, 12× M3 bolts', async () => {
    resetDocumentStore();
    const r = await dispatchTool('addGear', {
        teeth: 12, outerDiameter: 500, thickness: 50, bore: 50,
        boltCount: 12, boltCircleDiameter: 100, boltHoleDiameter: 3, toothFillet: 2,
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(r.featureId);
    const f = getDocumentStore().doc.features[r.featureId];
    assert.equal(f.type, 'Gear');
    assert.equal(f.params.teeth, 12);
    // outerDiameter 500, teeth 12 → module = OD/(teeth+2) = 500/14
    assert.ok(Math.abs(f.params.module - 500 / 14) < 1e-6, `module ${f.params.module}`);
});

await t('gear emit: tapered-tooth profile + bore + bolt loop + fillet + fail-safe fallback', () => {
    const f = makeFeature('Gear', {
        teeth: 12, module: 35.714, thickness: 50, bore: 50,
        boltCount: 12, boltCircleDiameter: 100, boltHoleDiameter: 3, toothFillet: 2,
    });
    const py = emitGearPython(f);
    assert.match(py, /make_face\(Polyline\(\*_pts_/);   // single gear-outline face
    assert.match(py, /extrude\(/);
    assert.match(py, /for _j in range\(12\)/);          // 12 bolt holes
    assert.match(py, /fillet\(/);                       // smooth tooth edges
    assert.match(py, /except Exception as _gear_err_/); // degrades to a bored disk
    assert.ok(py.includes(`n_${f.id} = extrude`));
});

await t('gear emit: no bore / no bolts → still a valid gear with the fallback', () => {
    const f = makeFeature('Gear', { teeth: 20, module: 2, thickness: 10, bore: 0, boltCount: 0, toothFillet: 0 });
    const py = emitGearPython(f);
    assert.match(py, /make_face\(Polyline/);
    assert.ok(!/range\(0\)/.test(py), 'no empty bolt loop should be emitted');
    assert.match(py, /except Exception as _gear_err_/);
});

await t('validateInput: explicit componentId:null on an optional field is accepted (the original failure)', async () => {
    resetDocumentStore();
    const box = await dispatchTool('addBox', { length: 20, width: 20, height: 10 });
    assert.equal(box.ok, true, JSON.stringify(box));
    // This exact shape (componentId: null) used to return "field 'componentId' must be a string".
    const r = await dispatchTool('addCircularPattern', { featureId: box.featureId, count: 6, axis: 'Z', componentId: null });
    assert.equal(r.ok, true, JSON.stringify(r));
});

await t('pattern guard: a dangling/mistyped featureId is rejected (not an undefined-name compile crash)', async () => {
    resetDocumentStore();
    await dispatchTool('addBox', { length: 20, width: 20, height: 10 });
    const r = await dispatchTool('addCircularPattern', { featureId: 'hole_doesnotexist_9', count: 12, axis: 'Z' });
    assert.equal(r.ok, false);
    assert.match(r.error, /no feature with id/);
});

await t('pattern guard: circular-patterning a Hole is rejected with the bolt-circle / addGear hint', async () => {
    resetDocumentStore();
    const box = await dispatchTool('addBox', { length: 40, width: 40, height: 10 });
    const hole = await dispatchTool('addHole', { targetBodyId: box.featureId, diameter: 3, through: true, type: 'simple' });
    assert.equal(hole.ok, true, JSON.stringify(hole));
    const r = await dispatchTool('addCircularPattern', { featureId: hole.featureId, count: 12, axis: 'Z' });
    assert.equal(r.ok, false);
    assert.match(r.error, /Hole|bolt circle|addGear/);
});

console.log(`\n${_pass} passed, ${_fail} failed`);
if (_fail > 0) process.exit(1);
