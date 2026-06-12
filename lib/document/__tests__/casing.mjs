/**
 * Phase 5 — Casing / cover generator emit tests.
 *
 * Builds a document with a component containing a body + two connectors (one
 * fastener/thread, one panel-switch), runs `addCasing(...)`, emits, and asserts
 * the generated Python:
 *   (a) unions the enclosed body,
 *   (b) contains an offset/shell forming the wall,
 *   (c) contains a boss for the fastener connector,
 *   (d) contains a cutout (subtract) for the shaft/switch connector,
 *   (e) emits two split halves,
 *   (f) is deterministic (emit twice → identical),
 *   (g) auto-updates: moving the component / changing the connector relocates
 *       the boss (no stale caching).
 *
 * Run via:  node lib/document/__tests__/casing.mjs
 */

import assert from 'node:assert/strict';
import {
    makeFeature, makeComponent, makeConnector,
    addFeatureChange, addComponentChange, addConnectorChange,
    DocumentStore,
    emitDocument,
    geometryOpFor, cutoutDimsFor, resolveTargets, connectorsForTargets,
} from '../index.js';
import { addCasing } from '../operations.js';
import { getDocumentStore, resetDocumentStore } from '../store.js';

const _tests = [];
function test(name, fn) { _tests.push({ name, fn }); }
async function runAll() {
    let pass = 0, fail = 0;
    for (const t of _tests) {
        try {
            await t.fn();
            pass++;
            console.log(`  \x1b[32m✓\x1b[0m ${t.name}`);
        } catch (e) {
            fail++;
            console.log(`  \x1b[31m✗\x1b[0m ${t.name}`);
            console.log(`    ${e.stack || e.message}`);
        }
    }
    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail > 0) process.exit(1);
}

/** Build a doc with a placed component + a body + a thread + a panel-switch. */
function buildAssemblyDoc({ compPos = [20, 0, 0] } = {}) {
    const store = resetDocumentStore();
    const comp = makeComponent({
        id: 'servo', name: 'Servo', parentId: 'root',
        origin: { position: compPos, rotation: [0, 0, 0], scale: [1, 1, 1] },
    });
    store.commit(addComponentChange(comp));
    const body = makeFeature('Box', { length: 40, width: 20, height: 36 }, {}, { componentId: 'servo' });
    store.commit(addFeatureChange(body));
    // Fastener / thread connector → boss.
    const thread = makeConnector({
        id: 'con_thread_1', parent: 'servo', kind: 'thread', gender: 'female',
        size: { nominal: 'M2', unit: 'mm' }, axis: [0, 0, 1], origin: [10, 0, 0],
        role: 'servo-mount', interfaceId: 'servo-mount-9g',
    });
    store.commit(addConnectorChange(thread));
    // Panel-switch connector → rectangular cutout.
    const sw = makeConnector({
        id: 'con_switch_1', parent: 'servo', kind: 'planar', gender: 'neutral',
        size: { nominal: '19x13', unit: 'mm' }, axis: [1, 0, 0], origin: [20, 0, 18],
        role: 'panel-switch', interfaceId: 'panel-cutout-rocker-19x13',
    });
    store.commit(addConnectorChange(sw));
    return { store, comp, body, thread, sw };
}

// ── helper mapping unit tests ────────────────────────────────────────────────
test('geometryOpFor: thread→boss, panel-switch→rect cutout', () => {
    assert.equal(geometryOpFor({ role: 'servo-mount', kind: 'thread' }).op, 'boss');
    assert.equal(geometryOpFor({ role: 'panel-switch', kind: 'planar' }).op, 'cutout');
    assert.equal(geometryOpFor({ role: 'panel-switch', kind: 'planar' }).shape, 'rect');
    assert.equal(geometryOpFor({ kind: 'shaft' }).op, 'cutout');
    assert.equal(geometryOpFor({ kind: 'planar' }).op, 'skip');
});

test('cutoutDimsFor: panel-cutout-rocker resolves to 19x13 + clearance', () => {
    const d = cutoutDimsFor({ interfaceId: 'panel-cutout-rocker-19x13', size: { nominal: '19x13' } },
        { op: 'cutout', shape: 'rect' }, 1);
    assert.equal(d.shape, 'rect');
    assert.equal(d.w, 21);   // 19 + 2*1
    assert.equal(d.h, 15);   // 13 + 2*1
});

// ── core emit asserts ────────────────────────────────────────────────────────
test('addCasing emits union + offset shell + boss + cutout + split halves', () => {
    const { body } = buildAssemblyDoc();
    const casing = addCasing({ targets: ['servo'], wall: 2, clearance: 1, splitPlane: 'XY' });
    const doc = getDocumentStore().doc;
    const { code } = emitDocument(doc);

    // (a) unions the enclosed body — the placed box var appears in the union.
    assert.ok(code.includes(`_casing_enclosed_${casing.id} = n_${body.id}`),
        'enclosed union must reference the placed enclosed body');

    // (b) offset/shell forming the wall: inner=offset(clearance), outer=offset(clearance+wall), wall = outer-inner.
    assert.match(code, new RegExp(`_casing_inner_${casing.id} = offset\\(.*amount=1\\)`));
    assert.match(code, new RegExp(`_casing_outer_${casing.id} = offset\\(.*amount=3\\)`));
    assert.ok(code.includes(`_casing_${casing.id} = _casing_outer_${casing.id} - _casing_inner_${casing.id}`),
        'wall must be outer - inner');

    // (c) a boss for the fastener (thread) connector — cylinder + pilot, added.
    assert.ok(/screw bosses at fastener\/thread connectors/.test(code), 'boss section emitted');
    assert.ok(/_b = Cylinder\(/.test(code), 'boss cylinder emitted');
    assert.ok(/_pilot = Cylinder\(/.test(code), 'boss pilot hole emitted');

    // (d) a cutout (subtract) for the panel-switch connector — rect prism subtracted.
    assert.ok(/cutouts where shaft\/port\/switch connectors pierce the shell/.test(code), 'cutout section emitted');
    assert.ok(/_cut = Box\(21, 15,/.test(code), 'rect cutout sized 19x13 + clearance');
    assert.match(code, new RegExp(`_casing_${casing.id} = _casing_${casing.id} - _cut`));

    // (e) two split halves.
    assert.ok(code.includes(`n_${casing.id}__top`), 'top half emitted');
    assert.ok(code.includes(`n_${casing.id}__bottom`), 'bottom half emitted');
    assert.match(code, new RegExp(`_casing_${casing.id}\\.split\\(`), 'split call emitted');
});

test('emit is deterministic (emit twice → identical)', () => {
    buildAssemblyDoc();
    addCasing({ targets: ['servo'], wall: 2, clearance: 1, splitPlane: 'XY' });
    const doc = getDocumentStore().doc;
    const a = emitDocument(doc).code;
    const b = emitDocument(doc).code;
    assert.equal(a, b, 'casing emit must be deterministic');
});

test('no split → single body, no split halves', () => {
    buildAssemblyDoc();
    const casing = addCasing({ targets: ['servo'], wall: 2, clearance: 1 });
    const { code } = emitDocument(getDocumentStore().doc);
    assert.ok(!code.includes(`n_${casing.id}__top`), 'no split halves when splitPlane is null');
    assert.ok(code.includes(`n_${casing.id} = _casing_${casing.id}`), 'single casing body assigned');
});

test('auto-update on swap: moving the component relocates the boss', () => {
    // Build at X=20 → boss world origin x = 20 + 10 (connector local) = 30.
    buildAssemblyDoc({ compPos: [20, 0, 0] });
    const casing = addCasing({ targets: ['servo'], wall: 2, clearance: 1 });
    const codeA = emitDocument(getDocumentStore().doc).code;
    assert.ok(codeA.includes('Location((30, 0, 0))'), 'boss at world x=30 with comp@20 + connector@10');

    // Re-build at X=50 → boss world origin x = 50 + 10 = 60. Emitter recomputes
    // from doc.connectors + composeComponentTransform — nothing cached.
    buildAssemblyDoc({ compPos: [50, 0, 0] });
    addCasing({ targets: ['servo'], wall: 2, clearance: 1 });
    const codeB = emitDocument(getDocumentStore().doc).code;
    assert.ok(codeB.includes('Location((60, 0, 0))'), 'boss relocated to world x=60 after component move');
});

test('JS sanity: wall<=0 coerced, warning stamped', () => {
    buildAssemblyDoc();
    const casing = addCasing({ targets: ['servo'], wall: 0, clearance: -5 });
    assert.equal(casing.params.wall, 2, 'wall coerced to default 2');
    assert.equal(casing.params.clearance, 1, 'clearance coerced to default 1');
    assert.ok(casing.warnings.length >= 2, 'warning chips stamped for both coercions');
});

test('addCasing throws on empty targets', () => {
    resetDocumentStore();
    assert.throws(() => addCasing({ targets: [] }), /targets/);
});

test('resolveTargets + connectorsForTargets gather component features + connectors', () => {
    const { body, thread, sw } = buildAssemblyDoc();
    const doc = getDocumentStore().doc;
    const { featureIds, componentIds } = resolveTargets(doc, ['servo']);
    assert.ok(featureIds.includes(body.id), 'body feature gathered');
    assert.ok(componentIds.has('servo'), 'servo component gathered');
    const cons = connectorsForTargets(doc, componentIds);
    const ids = cons.map((c) => c.id);
    assert.ok(ids.includes(thread.id) && ids.includes(sw.id), 'both connectors gathered');
    // deterministic order: sorted by id.
    assert.deepEqual(ids, [...ids].sort(), 'connectors emitted in sorted order');
});

test('degrades defensively: emitted Python wraps fragile steps in try/except', () => {
    buildAssemblyDoc();
    addCasing({ targets: ['servo'], wall: 2, clearance: 1, splitPlane: 'XY' });
    const { code } = emitDocument(getDocumentStore().doc);
    assert.ok(/except Exception/.test(code), 'has try/except guards');
    assert.ok(/falling back to union of enclosed bodies/.test(code), 'has graceful fallback comment');
});

runAll();
