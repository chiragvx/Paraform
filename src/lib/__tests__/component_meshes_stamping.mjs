/**
 * Bridge-side stamping of `doc.geometry.componentMeshes`.
 *
 * Verifies that when the kernel emits `geometry.componentMeshes` in its
 * response, the DocumentViewportBridge attaches the geometry block to the
 * live doc — the read path Spec 17 v2's interference panel depends on.
 *
 * Run via:
 *   node --import ./src/lib/commands/__tests__/_register.mjs \
 *        src/lib/__tests__/component_meshes_stamping.mjs
 */
import assert from 'node:assert/strict';
import { DocumentViewportBridge } from '../../../lib/document/bridge.js';
import { DocumentStore } from '../../../lib/document/store.js';
import { DocumentExecutor } from '../../../lib/document/executor.js';

let _pass = 0, _fail = 0;
function t(name, fn) {
    try {
        fn();
        console.log(`  ok  ${name}`);
        _pass++;
    } catch (e) {
        console.error(`  FAIL ${name}\n    ${e?.stack || e?.message || e}`);
        _fail++;
    }
}

function makeBridge() {
    const store = new DocumentStore();
    const executor = new DocumentExecutor();
    // Dummy client — bridge ctor wires it but no run is triggered in tests.
    const kernelClient = { executeCode: async () => ({ ok: true }) };
    const bridge = new DocumentViewportBridge({ store, executor, kernelClient });
    return { bridge, store, executor };
}

function fakeResult(componentMeshes) {
    return {
        ok: true,
        glb: null,            // skip _render's GLB path
        topology: { nodes: [] },
        geometry: {
            faces: {},
            edges: {},
            componentMeshes,
        },
    };
}

console.log('component_meshes_stamping');

t('bridge stamps componentMeshes onto doc.geometry on executed event', () => {
    const { bridge, store, executor } = makeBridge();
    const cm = {
        partA: {
            componentId: 'partA',
            positions: [0,0,0, 1,0,0, 0,1,0],
            index:     [0,1,2],
            bounds:    { min: [0,0,0], max: [1,1,0] },
        },
    };
    executor._dispatch({ type: 'executed', generation: 1, result: fakeResult(cm), doc: store.doc });
    assert.ok(store.doc.geometry, 'doc.geometry should be stamped');
    assert.ok(store.doc.geometry.componentMeshes, 'componentMeshes should land on doc.geometry');
    assert.strictEqual(store.doc.geometry.componentMeshes.partA.positions.length, 9);
    bridge.dispose();
});

t('two-component response yields two stamped entries', () => {
    const { bridge, store, executor } = makeBridge();
    const cm = {
        a: { componentId: 'a', positions: [0,0,0, 1,0,0, 0,1,0], index: [0,1,2], bounds: { min:[0,0,0], max:[1,1,0] } },
        b: { componentId: 'b', positions: [2,0,0, 3,0,0, 2,1,0], index: [0,1,2], bounds: { min:[2,0,0], max:[3,1,0] } },
    };
    executor._dispatch({ type: 'executed', generation: 1, result: fakeResult(cm), doc: store.doc });
    const stamped = store.doc.geometry.componentMeshes;
    assert.strictEqual(Object.keys(stamped).length, 2);
    assert.ok(stamped.a && stamped.b);
    bridge.dispose();
});

t('missing componentMeshes leaves doc.geometry without the field but still stamped', () => {
    const { bridge, store, executor } = makeBridge();
    const result = {
        ok: true,
        glb: null,
        topology: { nodes: [] },
        geometry: { faces: {}, edges: {} },
    };
    executor._dispatch({ type: 'executed', generation: 1, result, doc: store.doc });
    assert.ok(store.doc.geometry, 'geometry block is still stamped');
    assert.strictEqual(store.doc.geometry.componentMeshes, undefined);
    bridge.dispose();
});

t('no geometry on result is a no-op (no doc mutation)', () => {
    const { bridge, store, executor } = makeBridge();
    const docGeomBefore = store.doc.geometry;
    executor._dispatch({ type: 'executed', generation: 1, result: { ok: true, glb: null, topology: {} }, doc: store.doc });
    assert.strictEqual(store.doc.geometry, docGeomBefore);
    bridge.dispose();
});

t('bounds are preserved through the stamp', () => {
    const { bridge, store, executor } = makeBridge();
    const cm = {
        x: {
            componentId: 'x',
            positions: [0,0,0, 10,0,0, 0,10,5],
            index: [0,1,2],
            bounds: { min: [0,0,0], max: [10,10,5] },
        },
    };
    executor._dispatch({ type: 'executed', generation: 1, result: fakeResult(cm), doc: store.doc });
    const b = store.doc.geometry.componentMeshes.x.bounds;
    assert.deepStrictEqual(b.min, [0,0,0]);
    assert.deepStrictEqual(b.max, [10,10,5]);
    bridge.dispose();
});

t('subsequent executed event overwrites stamped geometry', () => {
    const { bridge, store, executor } = makeBridge();
    const cm1 = { a: { componentId: 'a', positions: [0,0,0, 1,0,0, 0,1,0], index: [0,1,2] } };
    const cm2 = { b: { componentId: 'b', positions: [9,0,0, 9,1,0, 9,1,1], index: [0,1,2] } };
    executor._dispatch({ type: 'executed', generation: 1, result: fakeResult(cm1), doc: store.doc });
    executor._dispatch({ type: 'executed', generation: 2, result: fakeResult(cm2), doc: store.doc });
    assert.strictEqual(store.doc.geometry.componentMeshes.a, undefined);
    assert.ok(store.doc.geometry.componentMeshes.b);
    bridge.dispose();
});

t('bridge.geometry getter mirrors stamped geometry (parity with doc)', () => {
    const { bridge, store, executor } = makeBridge();
    const cm = { z: { componentId: 'z', positions: [0,0,0, 1,0,0, 0,1,0], index: [0,1,2] } };
    executor._dispatch({ type: 'executed', generation: 1, result: fakeResult(cm), doc: store.doc });
    assert.strictEqual(bridge.geometry, store.doc.geometry, 'bridge.geometry and doc.geometry are the same object');
    bridge.dispose();
});

t('empty componentMeshes ({}) is stamped as an empty object (not dropped)', () => {
    const { bridge, store, executor } = makeBridge();
    executor._dispatch({ type: 'executed', generation: 1, result: fakeResult({}), doc: store.doc });
    assert.ok(store.doc.geometry.componentMeshes);
    assert.strictEqual(Object.keys(store.doc.geometry.componentMeshes).length, 0);
    bridge.dispose();
});

t('stamped componentMeshes shape matches buildComponentBVH consumer contract', async () => {
    // The BVH builder reads `.positions` (array or Float32Array) and
    // optional `.index`. Verify the kernel-shape entries pass through
    // unchanged so the consumer doesn't need to re-normalise.
    const { bridge, store, executor } = makeBridge();
    const cm = {
        cube: {
            componentId: 'cube',
            positions: [0,0,0, 1,0,0, 0,1,0, 0,0,1],
            index:     [0,1,2, 0,1,3],
            bounds:    { min: [0,0,0], max: [1,1,1] },
        },
    };
    executor._dispatch({ type: 'executed', generation: 1, result: fakeResult(cm), doc: store.doc });
    const entry = store.doc.geometry.componentMeshes.cube;
    assert.ok(Array.isArray(entry.positions) || entry.positions instanceof Float32Array);
    assert.ok(Array.isArray(entry.index) || entry.index instanceof Uint32Array);
    bridge.dispose();
});

t('failed event does NOT stamp geometry', () => {
    const { bridge, store, executor } = makeBridge();
    executor._dispatch({ type: 'failed', generation: 1, error: 'kaboom', doc: store.doc });
    assert.strictEqual(store.doc.geometry, undefined);
    bridge.dispose();
});

console.log(`${_pass} passed, ${_fail} failed`);
process.exit(_fail === 0 ? 0 : 1);
