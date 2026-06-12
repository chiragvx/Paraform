/**
 * Foundation 6 / commit 2B — component-aware picker tests.
 *
 * Asserts that pick-derived refs (face + edge) carry a `componentPath`
 * resolved either from an explicit payload value or, when absent, from the
 * live DocumentStore's `doc.features[fid].componentId` walked via
 * `componentPathFor`.
 *
 * Run via:  node lib/picking/__tests__/component_aware.mjs
 */

import assert from 'node:assert/strict';
import { entryToEdgeRef, entryToFaceRef } from '../refs.js';
import { resetDocumentStore, getDocumentStore } from '../../document/store.js';
import { makeComponent } from '../../document/types.js';

const _tests = [];
let _suite = '';
function suite(name, fn) { _suite = name; fn(); _suite = ''; }
function test(name, fn)  { _tests.push({ suite: _suite, name, fn }); }
async function runAll() {
    let pass = 0, fail = 0;
    for (const t of _tests) {
        try { await t.fn(); pass++; console.log(`  \x1b[32m✓\x1b[0m ${t.suite ? t.suite + ' › ' : ''}${t.name}`); }
        catch (e) { fail++; console.log(`  \x1b[31m✗\x1b[0m ${t.suite ? t.suite + ' › ' : ''}${t.name}`); console.log(`    ${e.message}`); }
    }
    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail > 0) process.exit(1);
}

// ── Fixture helpers ─────────────────────────────────────────────────────────
function makeEntry(featureId, { center = [1, 2, 3], normal = [0, 0, 1], part = '+Z', componentPath } = {}) {
    const payload = { center, normal, featureId };
    if (componentPath) payload.componentPath = componentPath;
    return {
        descriptor: { kind: 'face', feature: featureId, opTag: 'box', part },
        key:        `face:${featureId}:box:${part}`,
        payload,
    };
}

/** Wire up a synthetic doc with `root` + `leftPlate` components and two
 *  features — one in each component — so the resolver has a non-trivial path
 *  to walk. The rest of the system doesn't yet create non-root features, but
 *  the picker must already resolve correctly when it eventually does. */
function seedStore() {
    const store = resetDocumentStore(null);
    const doc = store.doc;
    doc.components.leftPlate = makeComponent({
        id:       'leftPlate',
        name:     'Left Plate',
        parentId: 'root',
    });
    doc.features['box_root_1'] = {
        id: 'box_root_1', type: 'Box', name: 'Box (root)',
        enabled: true, componentId: 'root',
        inputs: {}, params: {}, outputs: { bodies: [], sketches: [], faces: [], edges: [] },
        warnings: [], notes: '', createdAt: 0,
    };
    doc.features['box_left_1'] = {
        id: 'box_left_1', type: 'Box', name: 'Box (left)',
        enabled: true, componentId: 'leftPlate',
        inputs: {}, params: {}, outputs: { bodies: [], sketches: [], faces: [], edges: [] },
        warnings: [], notes: '', createdAt: 0,
    };
    return store;
}

// ── Tests ───────────────────────────────────────────────────────────────────
suite('entryToFaceRef.componentPath', () => {
    test('root feature resolves to ["root"]', () => {
        seedStore();
        const ref = entryToFaceRef(makeEntry('box_root_1'));
        assert.ok(ref);
        assert.deepEqual(ref.componentPath, ['root']);
    });

    test('non-root feature resolves to ["root", "<id>"] via componentPathFor', () => {
        seedStore();
        const ref = entryToFaceRef(makeEntry('box_left_1'));
        assert.ok(ref);
        assert.deepEqual(ref.componentPath, ['root', 'leftPlate']);
    });

    test('explicit payload.componentPath wins over a store lookup', () => {
        seedStore();
        // featureId points at the root box, but the payload claims a
        // deeper path — the wiring layer is allowed to override the
        // store-derived value and refs.js must honour it.
        const ref = entryToFaceRef(makeEntry('box_root_1', {
            componentPath: ['root', 'leftPlate', 'bracket'],
        }));
        assert.deepEqual(ref.componentPath, ['root', 'leftPlate', 'bracket']);
    });
});

suite('entryToEdgeRef.componentPath', () => {
    test('edge entry for a non-root feature still resolves the path', () => {
        seedStore();
        const ref = entryToEdgeRef({
            descriptor: { kind: 'edge', feature: 'box_left_1', opTag: 'box', part: '+X+Z' },
            key:        'edge:box_left_1:box:+X+Z',
            payload:    { center: [0, 0, 5], normal: [0, 0, 1], featureId: 'box_left_1' },
        });
        assert.ok(ref);
        assert.deepEqual(ref.componentPath, ['root', 'leftPlate']);
    });

    test('unknown featureId (e.g. just-deleted feature) falls back to ["root"]', () => {
        seedStore();
        const ref = entryToEdgeRef(makeEntry('box_ghost_999'));
        assert.ok(ref);
        assert.deepEqual(ref.componentPath, ['root']);
    });
});

suite('componentPath isolation', () => {
    test('mutating the returned componentPath does not affect the source doc', () => {
        const store = seedStore();
        const ref = entryToFaceRef(makeEntry('box_left_1'));
        ref.componentPath.push('synthetic');
        // Re-derive and confirm the doc still maps to the original path.
        const ref2 = entryToFaceRef(makeEntry('box_left_1'));
        assert.deepEqual(ref2.componentPath, ['root', 'leftPlate']);
        // Store-side component map untouched.
        assert.ok(store.doc.components.leftPlate);
        assert.equal(store.doc.components.leftPlate.parentId, 'root');
    });
});

await runAll();
