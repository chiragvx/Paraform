/**
 * Foundation 6 / commit 1 — Component data model + v4→v5 migration tests.
 *
 * Zero-dep: runs with `node lib/document/__tests__/migration.mjs`.
 *
 * Covers:
 *   1. migrateV4ToV5 on a v4 doc adds a `root` component.
 *   2. migrateV4ToV5 on a v5 doc is idempotent.
 *   3. migrateV4ToV5 on a doc without a version is a no-op.
 *   4. Round-trip: v4 JSON → DocumentStore.fromJSON → toJSON yields v5+root.
 *   5. Fresh DocumentStore is v5-shaped at toJSON time, with components.root.
 *   6. emptyDocument() already provides components.root.
 *   7. makeComponent honours id/name/parentId/origin overrides + defaults.
 *   8. Round-trip preserves changelog/head/features identity.
 *   9. migrateV4ToV5 preserves any extra (non-root) components from a partial
 *      v4 payload.
 */

import assert from 'node:assert/strict';
import {
    DocumentStore,
    emptyDocument,
    makeComponent,
    identityTransform,
    migrateV4ToV5,
    addFeatureChange,
    makeFeature,
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

// ── Fixtures ──────────────────────────────────────────────────────────────────
function v4Fixture({ withFeature = false } = {}) {
    const ts = 1700000000000;
    const json = {
        version:  4,
        id:       'doc_test',
        units:    'mm',
        metadata: { createdAt: ts, updatedAt: ts, title: 'Untitled', name: 'My Part' },
        changelog: [],
        head: -1,
    };
    if (withFeature) {
        const feature = makeFeature('Box', { length: 10, width: 10, height: 10 });
        const change = addFeatureChange(feature);
        change.parent = null;
        change.timestamp = ts;
        json.changelog.push(change);
        json.head = 0;
    }
    return json;
}

// ── Tests ─────────────────────────────────────────────────────────────────────
test('migrateV4ToV5 adds a root component to a v4 doc', () => {
    const v4 = v4Fixture();
    const v5 = migrateV4ToV5(v4);
    assert.equal(v5.version, 5);
    assert.ok(v5.components, 'components map present');
    assert.ok(v5.components.root, 'root component present');
    assert.equal(v5.components.root.id, 'root');
    // Name pulled from metadata.name when available
    assert.equal(v5.components.root.name, 'My Part');
    assert.equal(v5.components.root.parentId, null);
    assert.deepEqual(v5.components.root.origin, identityTransform());
    // Did not mutate inbound
    assert.equal(v4.version, 4, 'input v4 doc was not mutated');
});

test('migrateV4ToV5 is idempotent on a v5 doc', () => {
    const v5a = migrateV4ToV5(v4Fixture());
    const v5b = migrateV4ToV5(v5a);
    // Idempotent: re-running on v5 returns input unchanged (no version === 4).
    assert.equal(v5b, v5a, 'identity returned (no-op on v5)');
    assert.equal(v5b.version, 5);
    assert.ok(v5b.components.root);
});

test('migrateV4ToV5 on a doc without version is a no-op', () => {
    const weird = { changelog: [], head: -1 };
    const out = migrateV4ToV5(weird);
    assert.equal(out, weird, 'returns input identity');
    assert.equal(out.version, undefined);
    assert.equal(out.components, undefined);
});

test('migrateV4ToV5 preserves extra components on partial v4 payloads', () => {
    const v4 = v4Fixture();
    v4.components = { sub_a: makeComponent({ id: 'sub_a', name: 'Sub A' }) };
    const v5 = migrateV4ToV5(v4);
    assert.ok(v5.components.root, 'root injected');
    assert.ok(v5.components.sub_a, 'pre-existing component preserved');
    assert.equal(v5.components.sub_a.name, 'Sub A');
});

test('round-trip: v4 JSON → DocumentStore.fromJSON → toJSON yields v5+root', () => {
    const v4 = v4Fixture({ withFeature: true });
    const store = new DocumentStore();
    store.fromJSON(v4);
    const out = store.toJSON();
    assert.equal(out.version, 5, 'serialised as v5');
    assert.ok(out.components, 'components present');
    assert.ok(out.components.root, 'root present');
    // Identity preserved
    assert.equal(out.id, v4.id);
    assert.equal(out.head, v4.head, 'head preserved');
    assert.equal(out.changelog.length, v4.changelog.length, 'changelog length preserved');
    assert.equal(out.changelog[0].id, v4.changelog[0].id, 'changelog entry id preserved');
    // Feature folded out of the changelog
    assert.equal(Object.keys(store.doc.features).length, 1, 'feature folded');
});

test('fresh DocumentStore is v5-shaped with components.root at toJSON time', () => {
    const store = new DocumentStore();
    assert.ok(store.doc.components, 'live doc has components');
    assert.ok(store.doc.components.root, 'live doc has root component');
    const out = store.toJSON();
    assert.equal(out.version, 5);
    assert.ok(out.components.root);
    assert.equal(out.components.root.id, 'root');
    assert.equal(out.components.root.parentId, null);
    assert.deepEqual(out.components.root.origin, identityTransform());
});

test('emptyDocument() already carries components.root', () => {
    const d = emptyDocument();
    assert.equal(d.version, 5);
    assert.ok(d.components);
    assert.ok(d.components.root);
    assert.equal(d.components.root.id, 'root');
});

test('makeComponent honours overrides and defaults', () => {
    const c1 = makeComponent();
    assert.ok(c1.id, 'auto-generated id');
    assert.equal(c1.name, 'Component');
    assert.equal(c1.parentId, null);
    assert.deepEqual(c1.origin, identityTransform());

    const c2 = makeComponent({
        id: 'sub_1',
        name: 'Gearbox',
        parentId: 'root',
        origin: { position: [1, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1] },
    });
    assert.equal(c2.id, 'sub_1');
    assert.equal(c2.name, 'Gearbox');
    assert.equal(c2.parentId, 'root');
    assert.deepEqual(c2.origin.position, [1, 2, 3]);
});

test('DocumentStore preserves a non-root inbound component map', () => {
    const v4 = v4Fixture();
    const v5 = migrateV4ToV5(v4);
    // Inject a sub-component before loading
    v5.components.sub_x = makeComponent({ id: 'sub_x', name: 'Sub X' });
    const store = new DocumentStore();
    store.fromJSON(v5);
    const out = store.toJSON();
    assert.ok(out.components.root, 'root preserved');
    assert.ok(out.components.sub_x, 'sub_x preserved through round-trip');
    assert.equal(out.components.sub_x.name, 'Sub X');
});

test('DocumentStore recovers when components is the legacy [] stub', () => {
    // Legacy v4 docs used `components: []`. Both migrate and store should
    // tolerate this and produce a proper map with root.
    const legacy = v4Fixture();
    legacy.components = [];
    const v5 = migrateV4ToV5(legacy);
    assert.ok(!Array.isArray(v5.components), 'no longer an array');
    assert.ok(v5.components.root, 'root populated');

    const store = new DocumentStore();
    store.fromJSON(legacy);
    assert.ok(store.doc.components && !Array.isArray(store.doc.components), 'live doc is a map');
    assert.ok(store.doc.components.root, 'root present on live doc');
});

await runAll();
