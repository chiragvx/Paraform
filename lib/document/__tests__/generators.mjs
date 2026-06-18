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
    addPulley, addSprocket, addTSlotExtrusion, addScrewBoss, addStandoff, addFan, parseAirfoil,
    addMountingPlate, addBracket, addThreadedInsertBoss, addNutTrap, addSnapHook,
    addBearingPocket, addMotorMount, addShaftCoupler, addWheel, addTimingPulley,
    addHinge, addProjectBox, addPCBTray, addKnob,
    addFoot, addGusset, addHandle, addShaftHub, addLid, addRackGear,
    addBatteryHolder, addDINRailClip, addCableClip, addGridfinityBin, addTSlotBracket,
    addImpeller, addAuger, addBlowerWheel, addPaddleWheel,
} from '../operations.js';
import { getDocumentStore, resetDocumentStore } from '../store.js';
import {
    emitPulleyPython, emitSprocketPython, emitTSlotPython,
    emitScrewBossPython, emitStandoffPython, emitFanPython,
} from '../generators.js';
import { GENERATOR_TOOLS } from '../../../src/lib/ai/tools_generators.js';
import { setFeatureParams } from '../operations.js';
import { sceneDigest, documentSummary } from '../../../src/lib/ai/tools.js';

let _pass = 0, _fail = 0;
async function t(name, fn) {
    try { await fn(); console.log(`  ok  ${name}`); _pass++; }
    catch (e) { console.error(`  FAIL ${name}\n    ${e?.stack || e?.message || e}`); _fail++; }
}
const tool = (name) => GENERATOR_TOOLS.find((x) => x.name === name);

console.log('── Parametric domain generators (pulley / sprocket / t-slot / boss / standoff) ──');

// ── AI tool surface shape ────────────────────────────────────────────────────
await t('GENERATOR_TOOLS exposes every generator in the standard shape', () => {
    const names = GENERATOR_TOOLS.map((x) => x.name);
    assert.equal(names.length, new Set(names).size, 'duplicate generator tool names');
    assert.equal(names.length, 36, `expected 36 generators, got ${names.length}`);
    for (const expected of [
        'addPulley', 'addFan', 'addFanBlade', 'addMountingPlate', 'addBracket',
        'addThreadedInsertBoss', 'addNutTrap', 'addSnapHook', 'addBearingPocket', 'addMotorMount',
        'addShaftCoupler', 'addWheel', 'addTimingPulley', 'addHinge', 'addProjectBox', 'addPCBTray', 'addKnob',
        'addFoot', 'addGusset', 'addHandle', 'addShaftHub', 'addLid', 'addRackGear',
        'addBatteryHolder', 'addDINRailClip', 'addCableClip', 'addGridfinityBin', 'addTSlotBracket',
        'addImpeller', 'addAuger', 'addBlowerWheel', 'addPaddleWheel',
    ]) assert.ok(names.includes(expected), `missing generator tool ${expected}`);
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

// ── Fan / propeller / EDF rotor ────────────────────────────────────────────────
await t('addFan exposed in the AI tool surface (addFan + addFanBlade), required = diameter', () => {
    const names = GENERATOR_TOOLS.map((x) => x.name);
    assert.ok(names.includes('addFan') && names.includes('addFanBlade'));
    assert.deepEqual(tool('addFan').input_schema.required, ['diameter']);
    assert.deepEqual(tool('addFanBlade').input_schema.required, ['diameter']);
    // the description must steer the model AWAY from box blades
    assert.match(tool('addFan').description, /do not build|never|airfoil/i);
});

await t('parseAirfoil decodes NACA 4-digit + presets, total on junk', () => {
    assert.deepEqual(parseAirfoil('4412'), { m: 0.04, p: 0.4, t: 0.12, code: '4412' });
    assert.equal(parseAirfoil('0012').m, 0);        // symmetric
    assert.equal(parseAirfoil('0012').t, 0.12);
    assert.equal(parseAirfoil('flat').code, 'flat');
    assert.equal(parseAirfoil('cambered').m, 0.04);
    assert.equal(parseAirfoil(undefined).code, '4412');   // default, no throw
    assert.equal(parseAirfoil('garbage').code, '4412');
});

await t('addFan: builds a Fan feature with normalised params + pitch from angle', () => {
    resetDocumentStore();
    const f = addFan({ diameter: 80, bladeCount: 6, airfoil: '4412', bore: 5, setScrew: 3, shroud: true });
    assert.equal(f.type, 'Fan');
    assert.equal(f.params.diameter, 80);
    assert.equal(f.params.bladeCount, 6);
    assert.equal(f.params.camber, 0.04);            // NACA decoded
    assert.equal(f.params.shroud, true);
    assert.ok(f.params.pitch > 0);                  // defaulted to ~diameter
    // pitchAngleDeg path produces a finite pitch
    const g = addFan({ diameter: 100, pitchAngleDeg: 25 });
    assert.ok(g.params.pitch > 0 && Number.isFinite(g.params.pitch));
});

await t('emitFanPython: airfoil loft + 3-tier fail-safe ladder + hub array', () => {
    resetDocumentStore();
    const ff = addFan({ diameter: 80, bladeCount: 5, airfoil: '4412', bore: 5, setScrew: 3, shroud: true });
    const py = emitFanPython(ff);
    assert.ok(py.includes(`n_${ff.id}`), 'assigns the body var');
    assert.match(py, /def _afp_/);                          // NACA airfoil point builder
    assert.match(py, /0\.2969\*_m\.sqrt/);                  // NACA thickness formula present
    assert.match(py, /loft\(_secs\)/);                      // twisted-airfoil loft (tier 1)
    assert.match(py, /_blade_flat_/);                       // extruded fallback (tier 2)
    assert.match(py, /\+Box\(|\+ Box\(|Box\(_TIPR_/);       // box last resort (tier 3)
    assert.match(py, /rotate\(Axis\.Z,360\.0\*_k/);         // blade array about Z
    assert.match(py, /atan2\(_PITCH_/);                     // pitch → twist
    assert.ok(py.includes('# shroud skipped') || /\+_sh_/.test(py), 'shroud emitted');
});

await t('emitFanPython is deterministic (identical params → identical Python)', () => {
    const f = makeFeature('Fan', { diameter: 70, bladeCount: 7, airfoil: '6409', pitch: 90 });
    assert.equal(emitFanPython(f), emitFanPython(f));
});

await t('emitDocument renders a Fan without "unknown feature type"', () => {
    resetDocumentStore();
    addFan({ diameter: 90, bladeCount: 5, airfoil: 'cambered', bore: 6 });
    const { code } = emitDocument(getDocumentStore().doc);
    assert.ok(!/unknown feature type/.test(code), 'Fan emitter is unwired');
    assert.ok(!/emit failed for/.test(code), 'Fan emitter threw');
    assert.ok(code.includes('Fan '), 'missing Fan in emitted code');
});

await t('addFan: hubDiameter ≥ diameter warns; bladeCount < 2 warns', () => {
    resetDocumentStore();
    const f = addFan({ diameter: 50, hubDiameter: 60, bladeCount: 1 });
    const w = (f.warnings || []).join(' ');
    assert.match(w, /hubDiameter/);
    assert.match(w, /bladeCount/);
});

await t('AI handler path builds the fan (addFan via GENERATOR_TOOLS)', () => {
    resetDocumentStore();
    const r = tool('addFan').handler({ diameter: 80, bladeCount: 5, airfoil: '4412' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(getDocumentStore().doc.features[r.featureId].type, 'Fan');
    // addFanBlade fixes bladeCount = 1
    const b = tool('addFanBlade').handler({ diameter: 80, airfoil: '4412' });
    assert.equal(b.ok, true, JSON.stringify(b));
    assert.equal(getDocumentStore().doc.features[b.featureId].params.bladeCount, 1);
});

// ── Discoverability + edit-in-place (the "it made a NEW fan" regression) ───────
await t('every generator body is BODY_EMITTING → shows in the per-turn digest + bodies list', () => {
    // If a generator type is missing from BODY_EMITTING (tools.js / tools_dfm.js),
    // the AI never SEES the existing part in context and rebuilds a duplicate.
    const builders = [
        ['Fan', () => addFan({ diameter: 80, bladeCount: 5 }), /blades/],
        ['Gear', null, null],  // gear built via op elsewhere; covered by Fan path
        ['Pulley', () => addPulley({ diameter: 40 }), /pulley/i],
        ['Sprocket', () => addSprocket({ teeth: 16 }), /sprocket/i],
        ['TSlotExtrusion', () => addTSlotExtrusion({ size: 20, length: 100 }), /T-slot/i],
        ['ScrewBoss', () => addScrewBoss({ height: 8 }), /boss/i],
        ['Standoff', () => addStandoff({ size: 6, height: 10 }), /standoff/i],
    ].filter(([, b]) => b);
    for (const [type, build, re] of builders) {
        resetDocumentStore();
        const f = build();
        const dig = sceneDigest();
        assert.ok(dig.includes(f.id), `${type} body missing from sceneDigest (not in BODY_EMITTING?)`);
        assert.match(dig, re, `${type} digest line lacks its signature params`);
        assert.ok(documentSummary().bodies.includes(f.id), `${type} missing from documentSummary().bodies`);
    }
});

await t('relative edit patches the SAME fan in place (no duplicate) — "make it 12 blades"', () => {
    resetDocumentStore();
    const f = addFan({ diameter: 80, bladeCount: 5, airfoil: '4412' });
    assert.equal(documentSummary().featureCount, 1);
    setFeatureParams(f.id, { bladeCount: 12 });
    assert.equal(documentSummary().featureCount, 1, 'editing should NOT add a second fan');
    assert.equal(getDocumentStore().doc.features[f.id].params.bladeCount, 12);
    assert.match(sceneDigest(), /12 blades/);
});

// ── P0 foundation generators (structural / joining / drivetrain / enclosure) ───
const P0 = [
    ['addMountingPlate', addMountingPlate, { length: 80, width: 50, holeDia: 4, rows: 2, cols: 3, pitchX: 20, pitchY: 30 }, 'MountingPlate', /plate|hole/i],
    ['addBracket', addBracket, { armA: 40, armB: 35, gusset: true }, 'Bracket', /bracket/i],
    ['addThreadedInsertBoss', addThreadedInsertBoss, { insertSize: 'M3', height: 8, ribs: 3 }, 'ThreadedInsertBoss', /insert boss/i],
    ['addNutTrap', addNutTrap, { nutSize: 'M3', entry: 'side' }, 'NutTrap', /nut trap/i],
    ['addSnapHook', addSnapHook, { armLength: 16, hookDepth: 1.5 }, 'SnapHook', /snap hook/i],
    ['addBearingPocket', addBearingPocket, { bearing: '608' }, 'BearingPocket', /bearing pocket/i],
    ['addMotorMount', addMotorMount, { motorType: 'nema17' }, 'MotorMount', /motor mount/i],
    ['addShaftCoupler', addShaftCoupler, { bore1: 5, bore2: 8 }, 'ShaftCoupler', /coupler/i],
    ['addWheel', addWheel, { diameter: 60, spokes: 5 }, 'Wheel', /wheel/i],
    ['addTimingPulley', addTimingPulley, { teeth: 20, beltType: 'GT2' }, 'TimingPulley', /pulley/i],
    ['addHinge', addHinge, { length: 40, pinDia: 3 }, 'Hinge', /hinge/i],
    ['addProjectBox', addProjectBox, { innerLength: 60, innerWidth: 40, innerHeight: 25, bosses: true }, 'ProjectBox', /box/i],
    ['addPCBTray', addPCBTray, { pcbLength: 50, pcbWidth: 30 }, 'PCBTray', /pcb tray/i],
    ['addKnob', addKnob, { diameter: 24, gripType: 'knurl' }, 'Knob', /knob/i],
    // P1
    ['addFoot', addFoot, { diameter: 20, height: 8 }, 'Foot', /foot/i],
    ['addGusset', addGusset, { legA: 30, legB: 30 }, 'Gusset', /gusset/i],
    ['addHandle', addHandle, { span: 80, height: 30 }, 'Handle', /handle/i],
    ['addShaftHub', addShaftHub, { bore: 5, flangeDiameter: 30, boltCount: 4 }, 'ShaftHub', /shaft hub/i],
    ['addLid', addLid, { length: 64, width: 44, lipDepth: 4 }, 'Lid', /lid/i],
    ['addRackGear', addRackGear, { length: 60, module: 2 }, 'RackGear', /rack/i],
    ['addBatteryHolder', addBatteryHolder, { cellType: '18650', cellCount: 3 }, 'BatteryHolder', /18650|holder/i],
    ['addDINRailClip', addDINRailClip, { width: 20, platform: 45 }, 'DINRailClip', /din clip/i],
    ['addCableClip', addCableClip, { cableDia: 6 }, 'CableClip', /cable clip/i],
    ['addGridfinityBin', addGridfinityBin, { gridX: 2, gridY: 1, heightUnits: 3 }, 'GridfinityBin', /gridfinity/i],
    ['addTSlotBracket', addTSlotBracket, { size: 20 }, 'TSlotBracket', /t-slot bracket/i],
    // Rotor / fluid-mover family
    ['addImpeller', addImpeller, { outerDiameter: 80, bladeCount: 7, curve: 'backward' }, 'Impeller', /impeller/i],
    ['addAuger', addAuger, { flightDiameter: 30, length: 80, pitch: 25 }, 'Auger', /auger/i],
    ['addBlowerWheel', addBlowerWheel, { diameter: 50, length: 40 }, 'BlowerWheel', /blower wheel/i],
    ['addPaddleWheel', addPaddleWheel, { diameter: 60, paddleCount: 8 }, 'PaddleWheel', /paddle wheel/i],
];

await t('P0 generators: each builds its feature, exposes an AI tool, and emits a body var', () => {
    for (const [toolName, op, params, type, sceneRe] of P0) {
        resetDocumentStore();
        const f = op(params);
        assert.equal(f.type, type, `${toolName} → ${type}`);
        const tl = tool(toolName);
        assert.ok(tl, `${toolName} missing from GENERATOR_TOOLS`);
        assert.ok(tl.description && tl.description.length > 60, `${toolName} description`);
        // emitDocument renders it cleanly through the EMITTERS wiring
        const { code } = emitDocument(getDocumentStore().doc);
        assert.ok(!/unknown feature type/.test(code), `${toolName}: emitter unwired`);
        assert.ok(!/emit failed for/.test(code), `${toolName}: emitter threw`);
        assert.ok(code.includes(`n_${f.id}`), `${toolName}: no body var emitted`);
        // discoverability: shows in the per-turn digest + bodies list (edit-in-place)
        assert.ok(documentSummary().bodies.includes(f.id), `${toolName}: not in bodies (BODY_EMITTING?)`);
        assert.match(sceneDigest(), sceneRe, `${toolName}: digest lacks signature`);
        // deterministic emit (cache-safe)
        const { code: code2 } = emitDocument(getDocumentStore().doc);
        assert.equal(code, code2, `${toolName}: non-deterministic emit`);
    }
});

await t('P0 generators: standard-size tables resolve (bearing 608, NEMA17 bolt pattern)', () => {
    resetDocumentStore();
    const b = addBearingPocket({ bearing: '608' });   // 8×22×7
    const py = emitDocument(getDocumentStore().doc).code;
    assert.match(py, /11\b/);                          // OD/2 = 11 appears
    resetDocumentStore();
    addMotorMount({ motorType: 'nema17' });            // 31mm bolt square
    assert.match(emitDocument(getDocumentStore().doc).code, /15\.5|31/);
});

await t('every generator TOOL HANDLER runs (catches a missing op import — the gridfinity bug)', () => {
    // The handler path goes tool → index.js import; the direct-op tests above
    // would miss an op that is used in a handler but never imported there.
    for (const [toolName, , params] of P0) {
        resetDocumentStore();
        const r = tool(toolName).handler(params);
        assert.ok(r && r.ok !== false, `${toolName} handler failed: ${JSON.stringify(r)}`);
        assert.ok(r.featureId, `${toolName} handler returned no featureId`);
    }
});

await t('P0 generators: relative edit patches in place (bracket arm, no duplicate)', () => {
    resetDocumentStore();
    const f = addBracket({ armA: 40, armB: 40 });
    assert.equal(documentSummary().featureCount, 1);
    setFeatureParams(f.id, { armA: 80 });
    assert.equal(documentSummary().featureCount, 1, 'editing must not add a second bracket');
    assert.equal(getDocumentStore().doc.features[f.id].params.armA, 80);
});

console.log(`\n${_pass} passed, ${_fail} failed`);
if (_fail > 0) process.exit(1);
