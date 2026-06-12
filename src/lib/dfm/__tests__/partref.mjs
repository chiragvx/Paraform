/**
 * Spec 13 — partRef data plumbing.
 *
 * Zero-dep round-trip tests for `feature.params.partRef`. The shape is
 * documented in lib/document/types.js (above FEATURE_TYPES) and the field
 * is loose — these tests just verify that the document store treats it
 * like any other param (round-trips through toJSON/fromJSON, merges
 * cleanly under setFeatureParams).
 *
 * Run with:  node src/lib/dfm/__tests__/partref.mjs
 */

import assert from 'node:assert/strict';
import {
    makeFeature,
    addFeatureChange,
    setParamsChange,
    DocumentStore,
} from '../../../../lib/document/index.js';

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
            console.log(`    ${e.message}`);
        }
    }
    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail > 0) process.exit(1);
}

// Sample partRef payload — matches the documented shape in types.js.
const PARTREF = {
    entryId:  'bearing-608',
    role:     'bore',
    fitClass: 'H7/g6',
};

test('Cylinder with partRef stores the field as-is on params', () => {
    const store = new DocumentStore();
    const f = makeFeature('Cylinder', { radius: 11, height: 7, partRef: PARTREF });
    store.commit(addFeatureChange(f));

    const live = store.doc.features[f.id];
    assert.equal(live.params.radius, 11);
    assert.deepEqual(live.params.partRef, PARTREF);
});

test('partRef survives toJSON → fromJSON round-trip', () => {
    const store = new DocumentStore();
    const f = makeFeature('Cylinder', { radius: 11, height: 7, partRef: PARTREF });
    store.commit(addFeatureChange(f));

    const json = store.toJSON();
    const restored = new DocumentStore();
    restored.fromJSON(json);

    const live = restored.doc.features[f.id];
    assert.ok(live, 'feature must exist after restore');
    assert.deepEqual(live.params.partRef, PARTREF);
    assert.equal(live.params.partRef.entryId, 'bearing-608');
    assert.equal(live.params.partRef.role, 'bore');
    assert.equal(live.params.partRef.fitClass, 'H7/g6');
});

test('setFeatureParams patching just partRef.fitClass preserves entryId/role', () => {
    const store = new DocumentStore();
    const f = makeFeature('Cylinder', { radius: 11, height: 7, partRef: PARTREF });
    store.commit(addFeatureChange(f));

    // Patch *just* fitClass — caller must spread the existing partRef.
    const cur = store.doc.features[f.id].params.partRef;
    const nextPartRef = { ...cur, fitClass: 'H7/k6' };
    store.commit(setParamsChange(f.id, { partRef: nextPartRef }));

    const updated = store.doc.features[f.id].params.partRef;
    assert.equal(updated.entryId, 'bearing-608');
    assert.equal(updated.role, 'bore');
    assert.equal(updated.fitClass, 'H7/k6');

    // Other params untouched.
    assert.equal(store.doc.features[f.id].params.radius, 11);
    assert.equal(store.doc.features[f.id].params.height, 7);
});

test('Hole feature accepts partRef with role=clearance', () => {
    const store = new DocumentStore();
    const f = makeFeature('Hole', {
        diameter: 3.4,
        depth:    10,
        partRef: { entryId: 'iso4762-m3-16', role: 'clearance', fitClass: null },
    });
    store.commit(addFeatureChange(f));

    const json = store.toJSON();
    const restored = new DocumentStore();
    restored.fromJSON(json);

    const pr = restored.doc.features[f.id].params.partRef;
    assert.equal(pr.entryId, 'iso4762-m3-16');
    assert.equal(pr.role, 'clearance');
    assert.equal(pr.fitClass, null);
});

test('partRef can be cleared by setting it to null', () => {
    const store = new DocumentStore();
    const f = makeFeature('Cylinder', { radius: 11, height: 7, partRef: PARTREF });
    store.commit(addFeatureChange(f));
    store.commit(setParamsChange(f.id, { partRef: null }));

    assert.equal(store.doc.features[f.id].params.partRef, null);
    // The rest of the params survive.
    assert.equal(store.doc.features[f.id].params.radius, 11);
});

test('feature created without partRef has params.partRef === undefined', () => {
    const store = new DocumentStore();
    const f = makeFeature('Cylinder', { radius: 5, height: 10 });
    store.commit(addFeatureChange(f));
    assert.equal(store.doc.features[f.id].params.partRef, undefined);
});

runAll();
