/**
 * Zero-dep test runner for lib/document.
 *
 * Run with:  node lib/document/__tests__/run.mjs
 *
 * No vitest dependency — uses Node's built-in `assert/strict`. When the
 * project eventually adopts vitest (Phase 1E), these tests transplant by
 * renaming `test(...)` to vitest's `test(...)` and importing from 'vitest'.
 */

import assert from 'node:assert/strict';
import {
    emptyDocument, makeFeature, makeParameter,
    bodyRef, refFeatureId,
    addFeatureChange, removeFeatureChange, setParamsChange, setEnabledChange,
    addParameterChange, updateParameterChange,
    reorderFeatureChange,
    foldChangelog, applyChange,
    DocumentStore,
    topoOrder, parallelGroups, downstream, upstream, cycles, edges, dependenciesOf,
    migrateV3TreeToV4, ensureV4,
} from '../index.js';

// ── tiny test harness ────────────────────────────────────────────────────────
const _tests = [];
let _currentSuite = '';
function suite(name, fn) { _currentSuite = name; fn(); _currentSuite = ''; }
function test(name, fn)  { _tests.push({ suite: _currentSuite, name, fn }); }
async function runAll() {
    let pass = 0, fail = 0;
    for (const t of _tests) {
        try {
            await t.fn();
            pass++;
            console.log(`  \x1b[32m✓\x1b[0m ${t.suite ? t.suite + ' › ' : ''}${t.name}`);
        } catch (e) {
            fail++;
            console.log(`  \x1b[31m✗\x1b[0m ${t.suite ? t.suite + ' › ' : ''}${t.name}`);
            console.log(`    ${e.message}`);
            if (e.actual !== undefined || e.expected !== undefined) {
                console.log(`    actual:   ${JSON.stringify(e.actual)}`);
                console.log(`    expected: ${JSON.stringify(e.expected)}`);
            }
        }
    }
    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail > 0) process.exit(1);
}

// ── emptyDocument / makeFeature ───────────────────────────────────────────────
suite('factories', () => {
    test('emptyDocument has v5 and empty collections', () => {
        const doc = emptyDocument();
        assert.equal(doc.version, 5);
        assert.equal(doc.units, 'mm');
        assert.deepEqual(doc.features, {});
        assert.deepEqual(doc.featureOrder, []);
        assert.deepEqual(doc.parameters, {});
        assert.deepEqual(doc.changelog, []);
        assert.equal(doc.head, -1);
    });

    test('makeFeature rejects unknown types', () => {
        assert.throws(() => makeFeature('NotAFeature'), /Unknown feature type/);
    });

    test('makeFeature initialises outputs to empty arrays', () => {
        const f = makeFeature('Box', { length: 10 });
        assert.equal(f.type, 'Box');
        assert.equal(f.enabled, true);
        assert.deepEqual(f.outputs, { bodies: [], sketches: [], faces: [], edges: [] });
        assert.equal(typeof f.id, 'string');
    });

    test('makeParameter carries name/value/unit/equation', () => {
        const p = makeParameter('wall', 3, 'mm', 'wall * 2');
        assert.equal(p.name, 'wall');
        assert.equal(p.value, 3);
        assert.equal(p.unit, 'mm');
        assert.equal(p.equation, 'wall * 2');
    });

    test('refFeatureId extracts the upstream id', () => {
        const f = makeFeature('Box');
        assert.equal(refFeatureId(bodyRef(f.id)), f.id);
        assert.equal(refFeatureId({ kind: 'plane', ref: 'XY' }), null);
        assert.equal(refFeatureId(null), null);
    });
});

// ── changelog + fold ──────────────────────────────────────────────────────────
suite('fold', () => {
    test('empty changelog folds to empty document', () => {
        const doc = foldChangelog([], -1);
        assert.equal(doc.featureOrder.length, 0);
        assert.equal(doc.head, -1);
    });

    test('add-feature change inserts a feature and updates featureOrder', () => {
        const f = makeFeature('Box', { length: 10 });
        const ch = addFeatureChange(f);
        const doc = foldChangelog([ch], 0);
        assert.equal(doc.features[f.id].type, 'Box');
        assert.deepEqual(doc.featureOrder, [f.id]);
    });

    test('remove-feature change is idempotent for missing ids', () => {
        const doc = emptyDocument();
        applyChange(doc, removeFeatureChange('does-not-exist'));
        assert.deepEqual(doc.features, {});
    });

    test('set-params patches feature.params (merge, not replace)', () => {
        const f = makeFeature('Box', { length: 10, width: 5 });
        const ch1 = addFeatureChange(f);
        const ch2 = setParamsChange(f.id, { length: 20 });
        const doc = foldChangelog([ch1, ch2], 1);
        assert.equal(doc.features[f.id].params.length, 20);
        assert.equal(doc.features[f.id].params.width, 5);
    });

    test('refold from head=-1 produces an empty doc even with changelog present', () => {
        const f = makeFeature('Box');
        const doc = foldChangelog([addFeatureChange(f)], -1);
        assert.deepEqual(doc.featureOrder, []);
        assert.equal(doc.head, -1);
    });

    test('reorder-feature moves UI order without altering features map', () => {
        const a = makeFeature('Box'), b = makeFeature('Cylinder'), c = makeFeature('Sphere');
        const doc = foldChangelog([
            addFeatureChange(a), addFeatureChange(b), addFeatureChange(c),
            reorderFeatureChange(c.id, 0),
        ], 3);
        assert.deepEqual(doc.featureOrder, [c.id, a.id, b.id]);
    });

    test('set-enabled flips the enabled flag', () => {
        const f = makeFeature('Box');
        const doc = foldChangelog([
            addFeatureChange(f),
            setEnabledChange(f.id, false),
        ], 1);
        assert.equal(doc.features[f.id].enabled, false);
    });
});

// ── DAG operations ────────────────────────────────────────────────────────────
suite('dag', () => {
    function build3FeatureChain() {
        const sketch  = makeFeature('Sketch');
        const extrude = makeFeature('Extrude', { amount: 10 });
        extrude.inputs = { sketch: bodyRef(sketch.id) };
        const fillet  = makeFeature('Fillet', { radius: 1 });
        fillet.inputs = { body: bodyRef(extrude.id) };
        const doc = foldChangelog([
            addFeatureChange(sketch),
            addFeatureChange(extrude),
            addFeatureChange(fillet),
        ], 2);
        return { doc, ids: [sketch.id, extrude.id, fillet.id] };
    }

    test('edges enumerates direct dependencies', () => {
        const { doc, ids } = build3FeatureChain();
        const e = edges(doc);
        assert.equal(e.length, 2);
        assert.ok(e.some(x => x.from === ids[0] && x.to === ids[1]));
        assert.ok(e.some(x => x.from === ids[1] && x.to === ids[2]));
    });

    test('topoOrder returns linear chain in dep order', () => {
        const { doc, ids } = build3FeatureChain();
        assert.deepEqual(topoOrder(doc), ids);
    });

    test('parallelGroups stratifies the chain into 3 layers', () => {
        const { doc, ids } = build3FeatureChain();
        const groups = parallelGroups(doc);
        assert.equal(groups.length, 3);
        assert.deepEqual(groups[0], [ids[0]]);
        assert.deepEqual(groups[1], [ids[1]]);
        assert.deepEqual(groups[2], [ids[2]]);
    });

    test('parallelGroups groups two independent features into one layer', () => {
        const a = makeFeature('Box');
        const b = makeFeature('Cylinder');
        const doc = foldChangelog([addFeatureChange(a), addFeatureChange(b)], 1);
        const groups = parallelGroups(doc);
        assert.equal(groups.length, 1);
        assert.equal(groups[0].length, 2);
    });

    test('downstream includes transitive consumers', () => {
        const { doc, ids } = build3FeatureChain();
        const ds = downstream(doc, ids[0]);
        assert.equal(ds.size, 2);
        assert.ok(ds.has(ids[1]));
        assert.ok(ds.has(ids[2]));
    });

    test('upstream walks back through producers', () => {
        const { doc, ids } = build3FeatureChain();
        const us = upstream(doc, ids[2]);
        assert.equal(us.size, 2);
        assert.ok(us.has(ids[0]));
        assert.ok(us.has(ids[1]));
    });

    test('topoOrder returns null on a self-cycle', () => {
        const a = makeFeature('Fillet');
        a.inputs = { body: bodyRef(a.id) };  // pathological — references self
        const doc = foldChangelog([addFeatureChange(a)], 0);
        assert.equal(topoOrder(doc), null);
        assert.ok(cycles(doc).has(a.id));
    });

    test('topoOrder ignores disabled features', () => {
        const a = makeFeature('Box');
        const b = makeFeature('Fillet', { radius: 1 });
        b.inputs = { body: bodyRef(a.id) };
        const doc = foldChangelog([
            addFeatureChange(a),
            addFeatureChange(b),
            setEnabledChange(b.id, false),
        ], 2);
        assert.deepEqual(topoOrder(doc), [a.id]);
    });

    test('dependenciesOf is the inverse of edges() by adjacency', () => {
        const { doc, ids } = build3FeatureChain();
        const deps = dependenciesOf(doc);
        assert.deepEqual([...deps.get(ids[0])], []);
        assert.deepEqual([...deps.get(ids[1])], [ids[0]]);
        assert.deepEqual([...deps.get(ids[2])], [ids[1]]);
    });
});

// ── DocumentStore ─────────────────────────────────────────────────────────────
suite('store', () => {
    test('commit advances head and notifies subscribers', () => {
        const store = new DocumentStore();
        let last;
        store.subscribe((doc, evt) => { last = evt; });
        const f = makeFeature('Box');
        store.commit(addFeatureChange(f));
        assert.equal(store.doc.head, 0);
        assert.equal(store.doc.features[f.id].type, 'Box');
        assert.match(last, /add Box/);
    });

    test('undo decrements head and pushes to redo', () => {
        const store = new DocumentStore();
        const f = makeFeature('Box');
        store.commit(addFeatureChange(f));
        assert.ok(store.canUndo());
        store.undo();
        assert.equal(store.doc.head, -1);
        assert.deepEqual(store.doc.featureOrder, []);
        assert.ok(store.canRedo());
        store.redo();
        assert.equal(store.doc.head, 0);
        assert.ok(store.doc.features[f.id]);
    });

    test('committing after undo clears redo (linear history)', () => {
        const store = new DocumentStore();
        const f1 = makeFeature('Box');
        store.commit(addFeatureChange(f1));
        store.undo();
        assert.ok(store.canRedo());
        const f2 = makeFeature('Cylinder');
        store.commit(addFeatureChange(f2));
        assert.equal(store.canRedo(), false);
    });

    test('commitBatch is atomic — rejects all on partial failure', () => {
        const store = new DocumentStore();
        const f = makeFeature('Box');
        const good = addFeatureChange(f);
        // Second change references a feature id that does not exist → throws
        const bad  = setParamsChange('nonexistent', { length: 1 });
        assert.throws(() => store.commitBatch([good, bad]));
        // After rollback the store must be empty (good was undone)
        assert.equal(store.doc.head, -1);
        assert.equal(Object.keys(store.doc.features).length, 0);
    });

    test('toJSON/fromJSON round-trips identity', () => {
        const store = new DocumentStore();
        const a = makeFeature('Box', { length: 12 });
        const b = makeFeature('Cylinder', { radius: 3 });
        b.inputs = { body: bodyRef(a.id) };
        store.commit(addFeatureChange(a));
        store.commit(addFeatureChange(b));
        const json = store.toJSON();
        const store2 = new DocumentStore();
        store2.fromJSON(json);
        assert.equal(store2.doc.features[a.id].params.length, 12);
        assert.equal(store2.doc.features[b.id].inputs.body.featureId, a.id);
    });

    test('setHead moves backward and forward consistently', () => {
        const store = new DocumentStore();
        for (let i = 0; i < 5; i++) store.commit(addFeatureChange(makeFeature('Box', { i })));
        assert.equal(store.doc.head, 4);
        store.setHead(2);
        assert.equal(store.doc.head, 2);
        assert.equal(Object.keys(store.doc.features).length, 3);
    });

    test('determinism — folding the same changelog twice yields equal docs', () => {
        const store = new DocumentStore();
        const f1 = makeFeature('Box'), f2 = makeFeature('Cylinder');
        store.commit(addFeatureChange(f1));
        store.commit(addFeatureChange(f2));
        store.commit(setParamsChange(f1.id, { length: 99 }));
        const json = store.toJSON();
        const a = foldChangelog(json.changelog, json.head);
        const b = foldChangelog(json.changelog, json.head);
        assert.deepEqual(a.features, b.features);
        assert.deepEqual(a.featureOrder, b.featureOrder);
    });

    test('parameter add + update flow through the store', () => {
        const store = new DocumentStore();
        const p = makeParameter('wall', 3);
        store.commit(addParameterChange(p));
        store.commit(updateParameterChange(p.id, { value: 5 }));
        assert.equal(store.doc.parameters[p.id].value, 5);
    });
});

// ── v3 → v4 migration ─────────────────────────────────────────────────────────
suite('migrate', () => {
    function makeV3Tree(nodes = [], parameters = []) {
        return {
            version: 3,
            units: 'mm',
            parameters,
            nodes,
            playheadIndex: -1,
            bodies: {},
            sketches: {},
            constructionGeometry: [],
            components: [],
            metadata: { createdAt: 1, updatedAt: 2, title: 'legacy' },
        };
    }

    test('preserves v3 node ids as v4 feature ids', () => {
        const tree = makeV3Tree([
            { id: 'box_x', type: 'Box', name: 'Base', enabled: true, params: { length: 10 } },
        ]);
        const doc = migrateV3TreeToV4(tree);
        assert.ok(doc.features['box_x']);
        assert.equal(doc.features['box_x'].params.length, 10);
    });

    test('infers dependency edge from Fillet.params.body → upstream feature', () => {
        const tree = makeV3Tree([
            { id: 'box_x',    type: 'Box',    enabled: true, params: { length: 10 } },
            { id: 'fillet_x', type: 'Fillet', enabled: true, params: { body: 'box_x', radius: 2 } },
        ]);
        const doc = migrateV3TreeToV4(tree);
        const fillet = doc.features['fillet_x'];
        assert.equal(fillet.inputs.body?.featureId, 'box_x');
        // And the DAG must agree
        assert.deepEqual(topoOrder(doc), ['box_x', 'fillet_x']);
    });

    test('infers target+tools refs for Cut', () => {
        const tree = makeV3Tree([
            { id: 'a', type: 'Box',      enabled: true, params: {} },
            { id: 'b', type: 'Cylinder', enabled: true, params: {} },
            { id: 'c', type: 'Cut',      enabled: true, params: { target: 'a', tools: ['b'] } },
        ]);
        const doc = migrateV3TreeToV4(tree);
        const cut = doc.features['c'];
        assert.equal(cut.inputs.target?.featureId, 'a');
        assert.equal(cut.inputs.tools.length, 1);
        assert.equal(cut.inputs.tools[0].featureId, 'b');
    });

    test('preserves parameters and metadata patch', () => {
        const tree = makeV3Tree([], [
            { id: 'p1', name: 'wall', value: 3, unit: 'mm' },
        ]);
        const doc = migrateV3TreeToV4(tree);
        assert.ok(doc.parameters['p1']);
        assert.equal(doc.parameters['p1'].value, 3);
        assert.equal(doc.metadata.title, 'legacy');
    });

    test('ensureV4 is idempotent on already-migrated documents', () => {
        const tree = makeV3Tree([
            { id: 'box_y', type: 'Box', enabled: true, params: {} },
        ]);
        const doc1 = ensureV4(tree);
        const doc2 = ensureV4(doc1);
        // Post-Foundation-6 emptyDocument/foldChangelog stamp version 5;
        // ensureV4 tolerates forward shape (returns input unchanged).
        assert.ok(doc2.version === 4 || doc2.version === 5);
        assert.ok(doc2.features['box_y']);
    });

    test('migration drops broken refs (target points to nothing) rather than crashing', () => {
        const tree = makeV3Tree([
            { id: 'orphan', type: 'Fillet', enabled: true, params: { body: 'missing-id', radius: 1 } },
        ]);
        const doc = migrateV3TreeToV4(tree);
        const f = doc.features['orphan'];
        // The bad ref must not appear in inputs
        assert.equal(f.inputs.body, undefined);
    });
});

runAll();
