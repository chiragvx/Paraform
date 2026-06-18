/**
 * Parametric domain generators — op + emit + AI-tool-shape tests.
 *
 * Covers the family added alongside the gear/casing generators: pulley,
 * sprocket, T-slot extrusion, screw boss, standoff. For each we assert:
 *   (a) the typed op builds a feature of the registered type with normalised
 *       params (so an unknown type can't slip through makeFeature),
 *   (b) the emitter produces fail-safe Python that assigns n_<id> and degrades
 *       to a primitive in an `except` branch (the document always compiles),
 *   (c) emit is deterministic (identical params → identical Python),
 *   (d) emitDocument over the whole feature renders WITHOUT "unknown feature
 *       type" (the EMITTERS wiring is complete),
 *   (e) the AI tool surface exposes each generator in the standard shape with
 *       the right required fields, and the handler builds the part,
 *   (f) JS-side sanity warnings fire on bad params.
 *
 * Plain `node` asserts, relative imports — no loader needed.
 * Run via:  node lib/document/__tests__/generators.mjs
 */

import assert from 'node:assert/strict';
import { makeFeature, emitDocument } from '../index.js';
import {
    addPulley, addSprocket, addTSlotExtrusion, addScrewBoss, addStandoff,
} from '../operations.js';
import { getDocumentStore, resetDocumentStore } from '../store.js';
import {
    emitPulleyPython, emitSprocketPython, emitTSlotPython,
    emitScrewBossPython, emitStandoffPython,
} from '../generators.js';
import { GENERATOR_TOOLS } from '../../../src/lib/ai/tools_generators.js';

let _pass = 0, _fail = 0;
async function t(name, fn) {
    try { await fn(); console.log(`  ok  ${name}`); _pass++; }
    catch (e) { console.error(`  FAIL ${name}\n    ${e?.stack || e?.message || e}`); _fail++; }
}
const tool = (name) => GENERATOR_TOOLS.find((x) => x.name === name);

console.log('── Parametric domain generators (pulley / sprocket / t-slot / boss / standoff) ──');

// ── AI tool surface shape ────────────────────────────────────────────────────
await t('GENERATOR_TOOLS exposes all five generators in the standard shape', () => {
    const names = GENERATOR_TOOLS.map((x) => x.name).sort();
    assert.deepEqual(names, ['addPulley', 'addScrewBoss', 'addSprocket', 'addStandoff', 'addTSlotExtrusion']);
    for (const x of GENERATOR_TOOLS) {
        assert.equal(typeof x.handler, 'function', `${x.name} handler`);
        assert.ok(x.input_schema && x.input_schema.type === 'object', `${x.name} schema`);
        assert.ok(x.description && x.description.length > 40, `${x.name} description`);
    }
});

await t('required fields match the intended primary parameters', () => {
    assert.deepEqual(tool('addPulley').input_schema.required, ['diameter']);
    assert.deepEqual(tool('addSprocket').input_schema.required, ['teeth']);
    assert.deepEqual(tool('addTSlotExtrusion').input_schema.required, ['size', 'length']);
    assert.deepEqual(tool('addScrewBoss').input_schema.required, ['height']);
    assert.deepEqual(tool('addStandoff').input_schema.required, ['size', 'height']);
});

// ── Pulley ───────────────────────────────────────────────────────────────────
await t('addPulley: builds a Pulley feature; V-belt groove + flanges + bore', () => {
    resetDocumentStore();
    const f = addPulley({ diameter: 40, width: 16, bore: 8, pulleyType: 'vbelt', setScrew: 3 });
    assert.equal(f.type, 'Pulley');
    assert.equal(f.params.diameter, 40);
    assert.equal(f.params.pulleyType, 'vbelt');
    const py = emitPulleyPython(f);
    assert.ok(py.includes(`n_${f.id} = Cylinder`), 'hub cylinder');
    assert.match(py, /revolve\(make_face\(Polyline/);        // V groove
    assert.match(py, /except Exception as _pulley_err_/);    // fail-safe
    assert.match(py, /- Cylinder.*\(0, 90, 0\)/);            // radial set-screw hole
});

await t('addPulley: round belt → torus groove; flat → no groove', () => {
    const round = emitPulleyPython(makeFeature('Pulley', { diameter: 30, width: 10, pulleyType: 'round' }));
    assert.match(round, /Torus\(/);
    const flat = emitPulleyPython(makeFeature('Pulley', { diameter: 30, width: 10, pulleyType: 'flat' }));
    assert.ok(!/revolve\(/.test(flat) && !/Torus\(/.test(flat), 'flat pulley has no groove');
});

await t('addPulley: bore ≥ diameter warns', () => {
    resetDocumentStore();
    const f = addPulley({ diameter: 20, bore: 25 });
    assert.ok((f.warnings || []).some((w) => /bore/.test(w)));
});

// ── Sprocket ───────────────────────────────────────────────────────────────
await t('addSprocket: builds a Sprocket; carves N roller seats + bore + bolts', () => {
    resetDocumentStore();
    const f = addSprocket({ teeth: 17, chainPitch: 12.7, bore: 10, boltCount: 4, boltCircleDiameter: 30 });
    assert.equal(f.type, 'Sprocket');
    assert.equal(f.params.teeth, 17);
    const py = emitSprocketPython(f);
    assert.match(py, /for _k in range\(17\)/);               // 17 roller seats
    assert.match(py, /for _j in range\(4\)/);                // 4 bolt holes
    assert.match(py, /except Exception as _sprk_err_/);      // fail-safe
});

await t('addSprocket: rollerDiameter ≥ chainPitch warns', () => {
    resetDocumentStore();
    const f = addSprocket({ teeth: 12, chainPitch: 8, rollerDiameter: 9 });
    assert.ok((f.warnings || []).some((w) => /roller/i.test(w)));
});

// ── T-slot extrusion ─────────────────────────────────────────────────────────
await t('addTSlotExtrusion: builds bar + centre bore + four face slots', () => {
    resetDocumentStore();
    const f = addTSlotExtrusion({ size: 20, length: 250 });
    assert.equal(f.type, 'TSlotExtrusion');
    assert.equal(f.params.length, 250);
    const py = emitTSlotPython(f);
    assert.match(py, /extrude\(Rectangle\(/);                // square bar
    assert.match(py, /_slot_x_/);                            // X-face slots
    assert.match(py, /_slot_y_/);                            // Y-face slots
    assert.match(py, /except Exception as _tslot_err_/);     // fail-safe
});

await t('addTSlotExtrusion: slots:false → no channels', () => {
    const f = makeFeature('TSlotExtrusion', { size: 30, length: 100, slots: false });
    const py = emitTSlotPython(f);
    assert.ok(!/_slot_x_/.test(py), 'no slots emitted');
});

// ── Screw boss ───────────────────────────────────────────────────────────────
await t('addScrewBoss: M3 boss sizes pilot, cuts the hole, adds ribs', () => {
    resetDocumentStore();
    const f = addScrewBoss({ screwSize: 'M3', height: 10, ribs: 3, baseFillet: 1 });
    assert.equal(f.type, 'ScrewBoss');
    const py = emitScrewBossPython(f);
    assert.ok(py.includes('Cylinder(1.25,'), 'M3 → 2.5mm pilot (r=1.25)');   // pilot hole
    assert.match(py, /for _k in range\(3\)/);                // 3 ribs
    assert.match(py, /fillet\(/);                            // base fillet
    assert.match(py, /except Exception as _boss_err_/);      // fail-safe
});

// ── Standoff ───────────────────────────────────────────────────────────────
await t('addStandoff: hex uses RegularPolygon, round uses Cylinder, both bored', () => {
    resetDocumentStore();
    const hex = addStandoff({ shape: 'hex', size: 6, height: 12, bore: 3 });
    assert.equal(hex.type, 'Standoff');
    const hpy = emitStandoffPython(hex);
    assert.match(hpy, /RegularPolygon\(/);
    assert.match(hpy, /- Cylinder\(1\.5,/);                  // Ø3 bore → r=1.5
    const rpy = emitStandoffPython(makeFeature('Standoff', { shape: 'round', size: 8, height: 10, bore: 4 }));
    assert.ok(rpy.includes('n_') && /Cylinder\(4,/.test(rpy), 'round Ø8 → r=4 body');
    assert.match(rpy, /except Exception as _stdoff_err_/);   // fail-safe
});

// ── Determinism + full-document emit ─────────────────────────────────────────
await t('emit is deterministic for every generator (identical params → identical Python)', () => {
    const cases = [
        ['Pulley', { diameter: 40, width: 16, bore: 8, pulleyType: 'vbelt' }, emitPulleyPython],
        ['Sprocket', { teeth: 17, chainPitch: 12.7, bore: 10 }, emitSprocketPython],
        ['TSlotExtrusion', { size: 20, length: 250 }, emitTSlotPython],
        ['ScrewBoss', { screwSize: 'M3', height: 10, ribs: 3 }, emitScrewBossPython],
        ['Standoff', { shape: 'hex', size: 6, height: 12 }, emitStandoffPython],
    ];
    for (const [type, params, fn] of cases) {
        // Same feature (same id) emitted twice — the cache key depends on this.
        const f = makeFeature(type, params);
        assert.equal(fn(f), fn(f), `${type} emit not deterministic`);
    }
});

await t('emitDocument renders every generator without "unknown feature type"', () => {
    resetDocumentStore();
    addPulley({ diameter: 40, width: 16, bore: 8, pulleyType: 'vbelt' });
    addSprocket({ teeth: 17, chainPitch: 12.7, bore: 10 });
    addTSlotExtrusion({ size: 20, length: 250 });
    addScrewBoss({ screwSize: 'M3', height: 10, ribs: 3 });
    addStandoff({ shape: 'hex', size: 6, height: 12, bore: 3 });
    const { code } = emitDocument(getDocumentStore().doc);
    assert.ok(!/unknown feature type/.test(code), 'an emitter is unwired');
    assert.ok(!/emit failed for/.test(code), 'an emitter threw');
    for (const tag of ['Pulley', 'Sprocket', 'T-slot extrusion', 'Screw boss', 'Standoff']) {
        assert.ok(code.includes(tag), `missing ${tag} in emitted code`);
    }
});

await t('AI handler path builds the part (addStandoff via GENERATOR_TOOLS)', () => {
    resetDocumentStore();
    const r = tool('addStandoff').handler({ shape: 'round', size: 8, height: 10, bore: 4 });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(r.featureId);
    assert.equal(getDocumentStore().doc.features[r.featureId].type, 'Standoff');
});

console.log(`\n${_pass} passed, ${_fail} failed`);
if (_fail > 0) process.exit(1);
