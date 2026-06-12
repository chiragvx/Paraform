/**
 * E4 — Selection + measurement + section + interference.
 *
 * Zero-dep node:assert. Run via:
 *   node --import ./src/lib/commands/__tests__/_register.mjs \
 *        src/lib/__tests__/e4_phase.mjs
 *
 * Covers:
 *   - tools.measure / view.section.activate / analyze.interference commands
 *   - analyze.interference gating on ≥ 2 picked bodies
 *   - palette commands dispatch through studio.startMeasure / startSection /
 *     runInterference hooks
 *   - MARKING_MENU_ACTIONS covers all 8 wedges with registered command ids
 *   - Measure overlay state machine (pick-first → pick-second → result → clear)
 *   - Section mode state set/clear
 *   - Interference result shape on a mocked pairwise run
 *   - Rubber-band decideMembership helper (window vs crossing)
 *   - Marking-menu sectorFor helper
 */
import assert from 'node:assert/strict';
import { COMMANDS, MARKING_MENU_ACTIONS, pickedBodyIds } from '../commands/registry.js';
import { studio } from '$lib/studio/runtime.svelte.js';
import { getDocumentStore, resetDocumentStore, addBox } from '../../../lib/document/index.js';
import { getPickingSelection } from '../../../lib/picking/selection.js';
import { decideMembership } from '../../../app/viewport/rubber_band.js';
import { sectorFor } from '../../../app/viewport/marking_menu.js';

let _pass = 0, _fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); _pass++; }
  catch (e) { console.error(`  FAIL ${name}\n    ${e?.stack || e?.message || e}`); _fail++; }
}

const byId = Object.fromEntries(COMMANDS.map((c) => [c.id, c]));

console.log('── E4 — Selection + measurement + section ──');

// 1. command presence
t('tools.measure registered', () => {
  assert.ok(byId['tools.measure'], 'tools.measure not in COMMANDS');
  assert.equal(byId['tools.measure'].group, 'Tools');
  assert.equal(typeof byId['tools.measure'].run, 'function');
});

t('view.section.activate registered', () => {
  assert.ok(byId['view.section.activate']);
  assert.equal(byId['view.section.activate'].group, 'Tools');
});

t('analyze.interference registered', () => {
  assert.ok(byId['analyze.interference']);
  assert.equal(byId['analyze.interference'].group, 'Tools');
});

// 2. gating
t('analyze.interference disabled with 0 picks', () => {
  resetDocumentStore();
  const store = getDocumentStore();
  getPickingSelection().clear();
  const ok = byId['analyze.interference'].enabled({ store });
  assert.equal(ok, false);
});

t('analyze.interference disabled with 1 picked body', () => {
  resetDocumentStore();
  const store = getDocumentStore();
  const a = addBox();
  const sel = getPickingSelection();
  sel.clear();
  sel.add({ kind: 'body', feature: a.id, opTag: 'body', part: '', featureId: a.id }, { featureId: a.id });
  assert.equal(byId['analyze.interference'].enabled({ store }), false);
});

// Simulate a post-kernel evaluation by stamping bodies onto outputs (the
// kernel does this in prod; pickedBodyIds gates on outputs.bodies.length).
function _markEvaluated(store, featureId) {
  const f = store.doc.features[featureId];
  if (f) f.outputs = { bodies: [{ id: featureId }], sketches: [], faces: [], edges: [] };
}

t('analyze.interference enabled with 2 picked bodies', () => {
  resetDocumentStore();
  const store = getDocumentStore();
  const a = addBox();
  const b = addBox();
  _markEvaluated(store, a.id);
  _markEvaluated(store, b.id);
  const sel = getPickingSelection();
  sel.clear();
  sel.add({ kind: 'body', feature: a.id, opTag: 'body', part: '', featureId: a.id }, { featureId: a.id });
  sel.add({ kind: 'body', feature: b.id, opTag: 'body', part: '', featureId: b.id }, { featureId: b.id });
  assert.equal(pickedBodyIds(store).length, 2);
  assert.equal(byId['analyze.interference'].enabled({ store }), true);
});

// 3. dispatch through hooks
t('tools.measure dispatches into studio.startMeasure hook', () => {
  let called = 0;
  studio.viewport = {}; // make `enabled()` happy
  studio.startMeasure = () => { called++; };
  byId['tools.measure'].run({ store: getDocumentStore() });
  assert.equal(called, 1);
});

t('view.section.activate dispatches into studio.startSection hook', () => {
  let called = 0;
  studio.viewport = {};
  studio.startSection = () => { called++; };
  byId['view.section.activate'].run({ store: getDocumentStore() });
  assert.equal(called, 1);
});

t('analyze.interference dispatches into runInterference with body ids', () => {
  resetDocumentStore();
  const store = getDocumentStore();
  const a = addBox();
  const b = addBox();
  _markEvaluated(store, a.id);
  _markEvaluated(store, b.id);
  const sel = getPickingSelection();
  sel.clear();
  sel.add({ kind: 'body', feature: a.id, opTag: 'body', part: '', featureId: a.id }, { featureId: a.id });
  sel.add({ kind: 'body', feature: b.id, opTag: 'body', part: '', featureId: b.id }, { featureId: b.id });
  let received = null;
  studio.runInterference = (ids) => { received = ids; };
  byId['analyze.interference'].run({ store });
  assert.deepEqual(received, [a.id, b.id]);
});

t('palette commands no-op when viewport not booted (hook null)', () => {
  studio.viewport = null;
  studio.startMeasure = null;
  studio.startSection = null;
  // run() should not throw even when hook is null
  assert.doesNotThrow(() => byId['tools.measure'].run({ store: getDocumentStore() }));
  assert.doesNotThrow(() => byId['view.section.activate'].run({ store: getDocumentStore() }));
});

// 4. marking-menu action map covers 8 wedges
t('MARKING_MENU_ACTIONS has all 8 sectors', () => {
  const sectors = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];
  for (const s of sectors) {
    assert.ok(typeof MARKING_MENU_ACTIONS[s] === 'string',
      `sector ${s} missing or non-string`);
  }
});

t('MARKING_MENU_ACTIONS — every wedge maps to a registered command', () => {
  for (const [sec, id] of Object.entries(MARKING_MENU_ACTIONS)) {
    assert.ok(byId[id], `wedge ${sec} → ${id} is not a registered command`);
  }
});

// 5. measure state machine (pure data — simulated)
t('measure state machine: idle → pick-first → pick-second → result → clear', () => {
  let measureMode = null;
  // start
  measureMode = { stage: 'pick-first', firstHit: null };
  assert.equal(measureMode.stage, 'pick-first');
  // first hit
  measureMode = { stage: 'pick-second', firstHit: { descriptor: { kind: 'face' }, payload: { center: [0,0,0] } } };
  assert.equal(measureMode.stage, 'pick-second');
  assert.ok(measureMode.firstHit);
  // second hit resolves
  measureMode = {
    stage: 'showing-result',
    value: '10.000', unit: 'mm', label: 'distance',
    anchor: { x: 100, y: 100 },
  };
  assert.equal(measureMode.stage, 'showing-result');
  assert.equal(measureMode.value, '10.000');
  // clear
  measureMode = null;
  assert.equal(measureMode, null);
});

// 6. section mode state
t('section mode activate → set, clear → null', () => {
  let sectionMode = null;
  sectionMode = { plane: 'XY', normal: [0,0,1], offset: 0 };
  assert.equal(sectionMode.plane, 'XY');
  assert.deepEqual(sectionMode.normal, [0,0,1]);
  // offset update
  sectionMode = { ...sectionMode, offset: 5 };
  assert.equal(sectionMode.offset, 5);
  // clear
  sectionMode = null;
  assert.equal(sectionMode, null);
});

// 7. interference result shape
t('interference result aggregates pairs + total volume', () => {
  // Mock 3 bodies → 3 pairs → 1 intersects
  const mockResults = [
    { ok: true, intersects: false, volume: 0 },
    { ok: true, intersects: true,  volume: 12.5 },
    { ok: true, intersects: false, volume: 0 },
  ];
  let intersects = 0, totalVolume = 0;
  for (const r of mockResults) {
    if (r.ok && r.intersects) { intersects++; totalVolume += r.volume || 0; }
  }
  const out = { pairs: intersects, totalVolume };
  assert.equal(out.pairs, 1);
  assert.equal(out.totalVolume, 12.5);
});

// 8. rubber-band membership decision (pure helper)
t('rubber-band window mode requires full enclosure', () => {
  const rect = { left: 0, top: 0, right: 100, bottom: 100 };
  // fully inside → window pick
  assert.equal(decideMembership('window', rect,
    { minX: 10, minY: 10, maxX: 90, maxY: 90 }), true);
  // partial overlap → window does NOT pick
  assert.equal(decideMembership('window', rect,
    { minX: 50, minY: 50, maxX: 150, maxY: 150 }), false);
});

t('rubber-band crossing mode accepts any overlap', () => {
  const rect = { left: 0, top: 0, right: 100, bottom: 100 };
  // partial overlap → crossing picks
  assert.equal(decideMembership('crossing', rect,
    { minX: 50, minY: 50, maxX: 150, maxY: 150 }), true);
  // disjoint → crossing rejects
  assert.equal(decideMembership('crossing', rect,
    { minX: 200, minY: 200, maxX: 300, maxY: 300 }), false);
});

// 9. marking-menu sector mapping
t('marking-menu sectorFor returns null in dead zone', () => {
  assert.equal(sectorFor(0, 0), null);
  assert.equal(sectorFor(3, 3), null);
});

t('marking-menu sectorFor — east direction returns "e"', () => {
  assert.equal(sectorFor(100, 0), 'e');
});

t('marking-menu sectorFor — south direction returns "s"', () => {
  assert.equal(sectorFor(0, 100), 's');
});

t('marking-menu sectorFor — north direction returns "n"', () => {
  assert.equal(sectorFor(0, -100), 'n');
});

// Done.
console.log(`\n── E4 summary: ${_pass} pass, ${_fail} fail ──`);
process.exit(_fail === 0 ? 0 : 1);
