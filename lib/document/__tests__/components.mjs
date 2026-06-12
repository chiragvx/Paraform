/**
 * Foundation 6 / commit 2 — Feature.componentId + active-component plumbing.
 *
 * Zero-dep: runs with `node lib/document/__tests__/components.mjs`.
 *
 * Covers:
 *   1.  makeFeature() defaults componentId to 'root'.
 *   2.  makeFeature(..., { componentId }) honours the explicit arg.
 *   3.  componentPathFor on the implicit 'root' returns ['root'].
 *   4.  componentPathFor walks a synthetic nested component tree.
 *   5.  componentPathFor on an unknown id is defensive (returns ['root']).
 *   6.  store.featuresInComponent('root') returns only root-owned features.
 *   7.  store.featureOrderInComponent matches doc.featureOrder filtered to one cid.
 *   8.  setActiveComponentProvider: addBox stamps the active component.
 *   9.  No provider → addBox stamps 'root' (default fallback).
 *   10. Explicit `{componentId}` on addBox overrides provider.
 *   11. Folding a legacy changelog (feature without componentId) back-fills 'root'.
 */

import assert from 'node:assert/strict';
import {
    DocumentStore,
    makeFeature,
    makeComponent,
    componentPathFor,
    addBox,
    setActiveComponentProvider,
    resetDocumentStore,
    addFeatureChange,
} from '../index.js';

const _tests = [];
function test(name, fn) { _tests.push({ name, fn }); }

async function runAll() {
    let pass = 0, fail = 0;
    for (const t of _tests) {
        try {
            await t.fn();
            console.log(`  ok  ${t.name}`);
            pass++;
        } catch (err) {
            console.error(`  FAIL ${t.name}`);
            console.error('     ', err && err.message || err);
            fail++;
        }
    }
    console.log(`\n  ${pass} passed, ${fail} failed (${_tests.length} total)`);
    if (fail) process.exitCode = 1;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('makeFeature defaults componentId to root', () => {
    const f = makeFeature('Box', { length: 1, width: 1, height: 1 });
    assert.equal(f.componentId, 'root');
});

test('makeFeature honours explicit componentId', () => {
    const f = makeFeature('Box', {}, {}, { componentId: 'leftPlate' });
    assert.equal(f.componentId, 'leftPlate');
});

test('componentPathFor(root) returns [root]', () => {
    const store = new DocumentStore();
    assert.deepEqual(componentPathFor(store.doc, 'root'), ['root']);
    assert.deepEqual(store.componentPathFor('root'), ['root']);
});

test('componentPathFor walks a synthetic nested component tree', () => {
    const store = new DocumentStore();
    // Synthetic tree: root → assembly → leftPlate
    store.doc.components.assembly  = makeComponent({ id: 'assembly',  name: 'Assembly',   parentId: 'root' });
    store.doc.components.leftPlate = makeComponent({ id: 'leftPlate', name: 'Left Plate', parentId: 'assembly' });
    assert.deepEqual(componentPathFor(store.doc, 'leftPlate'), ['root', 'assembly', 'leftPlate']);
    assert.deepEqual(store.componentPathFor('assembly'),       ['root', 'assembly']);
});

test('componentPathFor on an unknown id defensively returns [root]', () => {
    const store = new DocumentStore();
    assert.deepEqual(componentPathFor(store.doc, 'doesNotExist'), ['root']);
    assert.deepEqual(componentPathFor(store.doc, undefined),      ['root']);
    assert.deepEqual(componentPathFor(null, 'whatever'),          ['root']);
});

test('featuresInComponent filters by componentId', () => {
    const store = resetDocumentStore();
    setActiveComponentProvider(null);  // clear any installed provider
    // Two features in root, one in leftPlate
    store.doc.components.leftPlate = makeComponent({ id: 'leftPlate', parentId: 'root' });
    const fA = makeFeature('Box', { length: 1, width: 1, height: 1 }, {}, { componentId: 'root' });
    const fB = makeFeature('Box', { length: 2, width: 2, height: 2 }, {}, { componentId: 'leftPlate' });
    const fC = makeFeature('Box', { length: 3, width: 3, height: 3 }, {}, { componentId: 'root' });
    store.commit(addFeatureChange(fA));
    store.commit(addFeatureChange(fB));
    store.commit(addFeatureChange(fC));

    const rootFeats = store.featuresInComponent('root');
    assert.equal(rootFeats.length, 2);
    assert.deepEqual(rootFeats.map(f => f.id), [fA.id, fC.id]);

    const leftFeats = store.featuresInComponent('leftPlate');
    assert.equal(leftFeats.length, 1);
    assert.equal(leftFeats[0].id, fB.id);
});

test('featureOrderInComponent returns ids in featureOrder order', () => {
    const store = resetDocumentStore();
    setActiveComponentProvider(null);
    store.doc.components.partA = makeComponent({ id: 'partA', parentId: 'root' });
    const f1 = makeFeature('Box', {}, {}, { componentId: 'root' });
    const f2 = makeFeature('Box', {}, {}, { componentId: 'partA' });
    const f3 = makeFeature('Box', {}, {}, { componentId: 'root' });
    store.commit(addFeatureChange(f1));
    store.commit(addFeatureChange(f2));
    store.commit(addFeatureChange(f3));
    assert.deepEqual(store.featureOrderInComponent('root'),  [f1.id, f3.id]);
    assert.deepEqual(store.featureOrderInComponent('partA'), [f2.id]);
});

test('setActiveComponentProvider: addBox stamps the active component', () => {
    resetDocumentStore();
    let active = 'root';
    setActiveComponentProvider(() => active);
    try {
        const b1 = addBox({ length: 1, width: 1, height: 1 });
        assert.equal(b1.componentId, 'root');

        active = 'wingAssembly';
        const b2 = addBox({ length: 1, width: 1, height: 1 });
        assert.equal(b2.componentId, 'wingAssembly');
    } finally {
        setActiveComponentProvider(null);
    }
});

test('no provider installed → addBox falls back to root', () => {
    resetDocumentStore();
    setActiveComponentProvider(null);
    const b = addBox({ length: 1, width: 1, height: 1 });
    assert.equal(b.componentId, 'root');
});

test('explicit {componentId} on addBox overrides the provider', () => {
    resetDocumentStore();
    setActiveComponentProvider(() => 'wingAssembly');
    try {
        const b = addBox({ length: 1, width: 1, height: 1, componentId: 'cabin' });
        assert.equal(b.componentId, 'cabin');
    } finally {
        setActiveComponentProvider(null);
    }
});

test('fold back-fills componentId on legacy features missing the field', async () => {
    // Simulate a v4/early-v5 changelog where the feature was committed without
    // a componentId. Fold should populate it defensively to 'root'.
    const { foldChangelog, newChangeId, CHANGE_KIND } = await import('../index.js');
    const legacyFeature = {
        id: 'feat_legacy_1',
        type: 'Box',
        name: 'Box',
        enabled: true,
        // NOTE: no componentId — this is the legacy shape.
        inputs: {},
        params: { length: 10, width: 10, height: 10 },
        outputs: { bodies: [], sketches: [], faces: [], edges: [] },
        warnings: [],
        notes: '',
        createdAt: Date.now(),
    };
    const change = {
        id: newChangeId(),
        parent: null,
        timestamp: Date.now(),
        kind: CHANGE_KIND.ADD_FEATURE,
        payload: { feature: legacyFeature, insertAt: null },
        label: 'add Box',
    };
    const doc = foldChangelog([change], 0);
    assert.equal(doc.features['feat_legacy_1'].componentId, 'root');
});

runAll();
