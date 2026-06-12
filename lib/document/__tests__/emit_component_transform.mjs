/**
 * Phase 3 — component-placement emit tests.
 *
 * Verifies that `emitDocument` bakes each leaf feature's composed component
 * transform into the kernel geometry via `body.moved(Location(...))`, while
 * root-owned features stay byte-identical (identity → no `.moved(...)`).
 *
 * Run via:  node lib/document/__tests__/emit_component_transform.mjs
 */

import assert from 'node:assert/strict';
import {
    makeFeature, makeComponent,
    addFeatureChange, addComponentChange,
    DocumentStore,
} from '../index.js';
import { emitDocument, composeComponentTransform } from '../emit.js';

/** Count non-overlapping occurrences of `needle` in `hay`. */
function countOf(hay, needle) {
    let n = 0, i = 0;
    while ((i = hay.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
    return n;
}

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

function buildDoc(...changes) {
    const store = new DocumentStore();
    for (const ch of changes) store.commit(ch);
    return store.doc;
}

// ── (a) root box → no transform (byte-identical) ─────────────────────────────
test('root-owned box emits with NO .moved / Location', () => {
    const box = makeFeature('Box', { length: 10, width: 10, height: 10 });
    // componentId defaults to 'root'
    assert.equal(box.componentId, 'root');
    const doc = buildDoc(addFeatureChange(box));
    const { code } = emitDocument(doc);
    assert.equal(code.includes('.moved('), false, 'root body must not be wrapped in .moved(...)');
    assert.equal(code.includes('Location('), false, 'root body must not get a Location');
    // bodies dict references the bare var
    assert.match(code, new RegExp(`"${box.id}": n_${box.id}\\b`));
});

// ── (b) child component at [50,0,0] → translated box ─────────────────────────
test('child-component box emits .moved(Location((50,0,0)))', () => {
    const child = makeComponent({
        id: 'child', name: 'Child', parentId: 'root',
        origin: { position: [50, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    });
    const box = makeFeature('Box', { length: 10, width: 10, height: 10 }, {}, { componentId: 'child' });
    const doc = buildDoc(addComponentChange(child), addFeatureChange(box));
    const { code } = emitDocument(doc);
    // The bodies dict must place the box at (50,0,0). Translation-only path
    // emits a single-arg Location.
    assert.match(code, new RegExp(`"${box.id}": n_${box.id}\\.moved\\(Location\\(\\(50, 0, 0\\)\\)\\)`));
});

// ── nested child-of-child composes both translations ────────────────────────
test('nested child composes both translations (50 + 20 = 70 on X)', () => {
    const child = makeComponent({
        id: 'child', name: 'Child', parentId: 'root',
        origin: { position: [50, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    });
    const grand = makeComponent({
        id: 'grand', name: 'Grand', parentId: 'child',
        origin: { position: [20, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    });
    const box = makeFeature('Box', { length: 4, width: 4, height: 4 }, {}, { componentId: 'grand' });
    const doc = buildDoc(addComponentChange(child), addComponentChange(grand), addFeatureChange(box));

    const t = composeComponentTransform(doc, 'grand');
    assert.deepEqual(t.position, [70, 0, 0], 'composed translation should sum to 70 on X');
    assert.equal(t.identity, false);

    const { code } = emitDocument(doc);
    assert.match(code, new RegExp(`"${box.id}": n_${box.id}\\.moved\\(Location\\(\\(70, 0, 0\\)\\)\\)`));
});

// ── rotation composes; emits a two-arg Location in DEGREES ───────────────────
test('child rotation emits Location with degrees (radians→degrees)', () => {
    const child = makeComponent({
        id: 'rot', name: 'Rot', parentId: 'root',
        // 90° about Z, expressed in radians as the document stores it
        origin: { position: [0, 0, 0], rotation: [0, 0, Math.PI / 2], scale: [1, 1, 1] },
    });
    const box = makeFeature('Box', { length: 10, width: 10, height: 10 }, {}, { componentId: 'rot' });
    const doc = buildDoc(addComponentChange(child), addFeatureChange(box));

    const t = composeComponentTransform(doc, 'rot');
    assert.equal(t.rotationDeg[2], 90, 'PI/2 radians must convert to 90 degrees');

    const { code } = emitDocument(doc);
    // Two-arg Location: position tuple + degree tuple.
    assert.match(code, new RegExp(`n_${box.id}\\.moved\\(Location\\(\\(0, 0, 0\\), \\(0, 0, 90\\)\\)\\)`));
});

// ── rotation + translation compose (frame-aware, not naive sum) ──────────────
test('parent rotation rotates child translation into the parent frame', () => {
    // Parent rotated 90° about Z, child offset +10 on X in the parent's
    // local frame → the child should land at world (0, 10, 0).
    const parent = makeComponent({
        id: 'p', name: 'P', parentId: 'root',
        origin: { position: [0, 0, 0], rotation: [0, 0, Math.PI / 2], scale: [1, 1, 1] },
    });
    const childComp = makeComponent({
        id: 'c', name: 'C', parentId: 'p',
        origin: { position: [10, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    });
    const box = makeFeature('Box', {}, {}, { componentId: 'c' });
    const doc = buildDoc(addComponentChange(parent), addComponentChange(childComp), addFeatureChange(box));

    const t = composeComponentTransform(doc, 'c');
    // x' = cos90*10 - sin90*0 = 0 ; y' = sin90*10 + cos90*0 = 10
    assert.deepEqual(t.position, [0, 10, 0], 'child offset must be rotated into the parent frame');
    assert.equal(t.rotationDeg[2], 90);
});

// ── non-unit scale is tolerated (ignored), not a crash ───────────────────────
test('non-unit component scale does not crash and is ignored', () => {
    const child = makeComponent({
        id: 's', name: 'S', parentId: 'root',
        origin: { position: [5, 0, 0], rotation: [0, 0, 0], scale: [2, 2, 2] },
    });
    const box = makeFeature('Box', {}, {}, { componentId: 's' });
    const doc = buildDoc(addComponentChange(child), addFeatureChange(box));
    let code;
    assert.doesNotThrow(() => { code = emitDocument(doc).code; });
    // Placement still happens (translation), scale silently dropped.
    assert.match(code, new RegExp(`n_${box.id}\\.moved\\(Location\\(\\(5, 0, 0\\)\\)\\)`));
});

// ── StandardPart placement is baked exactly ONCE (no double-transform) ───────
// Regression: placeLibraryPart writes the solved mate pose into BOTH the
// component origin AND the StandardPart's `transform`. The component-origin
// bake (placeBodyExpr) is the canonical placement; the emitter must NOT also
// apply its self-transform, or the body lands at ~2× the mate point while the
// connector node (component origin, applied once) stays put — "snaps but the
// body is far away."
test('component-owned StandardPart bakes placement once, not twice', () => {
    const comp = makeComponent({
        id: 'nut1', name: 'M5 T-Nut', parentId: 'root',
        origin: { position: [110, 50, 125], rotation: [0, 0, 0], scale: [1, 1, 1] },
    });
    // Mirror placeLibraryPart: the feature transform duplicates the origin.
    const sp = makeFeature('StandardPart',
        { entryId: 'tnut-hntr5-m5', transform: { position: [110, 50, 125], rotation: [0, 0, 0] } },
        {}, { componentId: 'nut1' });
    const doc = buildDoc(addComponentChange(comp), addFeatureChange(sp));
    const { code } = emitDocument(doc);

    // The placement coordinates appear exactly once — via the component bake.
    assert.equal(countOf(code, '110, 50, 125'), 1,
        `placement baked ${countOf(code, '110, 50, 125')}×, expected exactly 1`);
    // And it's the placeBodyExpr Location wrap, not the old translate() path.
    assert.match(code, new RegExp(`n_${sp.id}\\.moved\\(Location\\(\\(110, 50, 125\\)\\)\\)`));
    assert.equal(code.includes('.translate((110'), false,
        'must not also self-translate the standard part');
});

// ── root-owned StandardPart still self-places (the bake is identity) ──────────
test('root-owned StandardPart self-places via its transform', () => {
    const sp = makeFeature('StandardPart',
        { entryId: 'tnut-hntr5-m5', transform: { position: [7, 8, 9], rotation: [0, 0, Math.PI / 2] } },
        {});   // componentId defaults to 'root' → component bake is identity
    assert.equal(sp.componentId, 'root');
    const doc = buildDoc(addFeatureChange(sp));
    const { code } = emitDocument(doc);
    // Self-places with a single Location (rotation in degrees), applied once.
    assert.match(code, new RegExp(`n_${sp.id}\\.moved\\(Location\\(\\(7, 8, 9\\), \\(0, 0, 90\\)\\)\\)`));
    assert.equal(countOf(code, '7, 8, 9'), 1);
});

// ── determinism: same doc → identical emit ───────────────────────────────────
test('emit is deterministic for a placed doc', () => {
    const child = makeComponent({
        id: 'd', name: 'D', parentId: 'root',
        origin: { position: [3, 4, 5], rotation: [0, 0, 0], scale: [1, 1, 1] },
    });
    const box = makeFeature('Box', {}, {}, { componentId: 'd' });
    const doc = buildDoc(addComponentChange(child), addFeatureChange(box));
    const a = emitDocument(doc).code;
    const b = emitDocument(doc).code;
    assert.equal(a, b);
});

runAll();
