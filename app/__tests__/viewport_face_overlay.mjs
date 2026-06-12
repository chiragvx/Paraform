/**
 * Tests for the face-conforming highlight overlay:
 *   - app/picking/face_overlay.js — FaceHighlightOverlay
 *
 * Run via:  node app/__tests__/viewport_face_overlay.mjs
 */

import assert from 'node:assert/strict';
import * as THREE from 'three';

// Stub global `window` if missing — face_overlay subscribes to window resize
// for LineMaterial resolution sync.
if (typeof globalThis.window === 'undefined') {
    globalThis.window = { addEventListener() {}, removeEventListener() {}, innerWidth: 1024, innerHeight: 768 };
}

const { FaceHighlightOverlay } = await import('../picking/face_overlay.js');

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
    console.log(`\n  ${pass} passed, ${fail} failed`);
    if (fail > 0) process.exit(1);
}

// Triangle face geometry sample.
const FACE_GEO = {
    vertices: [
        0, 0, 0,
        10, 0, 0,
        0, 10, 0,
    ],
    indices: [0, 1, 2],
};

const EDGE_GEO = {
    points: [
        0, 0, 0,
        5, 0, 0,
        10, 0, 0,
        15, 0, 0,
    ],
};

function makeOverlay() {
    const scene = new THREE.Scene();
    const overlay = new FaceHighlightOverlay({ scene });
    return { scene, overlay };
}

// ── Construction ────────────────────────────────────────────────────────────
suite('FaceHighlightOverlay', () => {
    test('constructs and attaches its group to the scene', () => {
        const { scene, overlay } = makeOverlay();
        assert.ok(scene.children.includes(overlay.group));
        overlay.dispose();
    });

    test('rejects construction without a scene', () => {
        assert.throws(() => new FaceHighlightOverlay({}), /missing scene/);
    });

    test('showHover is a no-op until geometry is set', () => {
        const { overlay } = makeOverlay();
        overlay.showHover('face:f1:box:+Z', 'face');
        assert.equal(overlay.group.children.length, 0);
        overlay.dispose();
    });

    test('setGeometry then showHover adds a face mesh to the overlay group', () => {
        const { overlay } = makeOverlay();
        overlay.setGeometry({
            faces: { 'face:f1:box:+Z': FACE_GEO },
            edges: {},
        });
        overlay.showHover('face:f1:box:+Z', 'face');
        assert.equal(overlay.group.children.length, 1);
        const mesh = overlay.group.children[0];
        assert.ok(mesh.isMesh);
        assert.ok(mesh.geometry.attributes.position.count === 3);
        overlay.dispose();
    });

    test('clearHover removes the hover mesh but leaves selection intact', () => {
        const { overlay } = makeOverlay();
        overlay.setGeometry({
            faces: { 'face:f1:box:+Z': FACE_GEO, 'face:f1:box:-Z': FACE_GEO },
            edges: {},
        });
        overlay.showHover('face:f1:box:+Z', 'face');
        overlay.setSelected([{ key: 'face:f1:box:-Z', kind: 'face' }]);
        assert.equal(overlay.group.children.length, 2);
        overlay.clearHover();
        assert.equal(overlay.group.children.length, 1);
        overlay.dispose();
    });

    test('setSelected replaces the previous selection set', () => {
        const { overlay } = makeOverlay();
        overlay.setGeometry({
            faces: { a: FACE_GEO, b: FACE_GEO, c: FACE_GEO },
            edges: {},
        });
        overlay.setSelected([{ key: 'a', kind: 'face' }, { key: 'b', kind: 'face' }]);
        assert.equal(overlay.group.children.length, 2);
        overlay.setSelected([{ key: 'c', kind: 'face' }]);
        assert.equal(overlay.group.children.length, 1);
        overlay.dispose();
    });

    test('edge picks render a screen-space thick line along the polyline', () => {
        const { overlay } = makeOverlay();
        overlay.setGeometry({ faces: {}, edges: { 'edge:f1:box:e[0]': EDGE_GEO } });
        overlay.showHover('edge:f1:box:e[0]', 'edge');
        assert.equal(overlay.group.children.length, 1);
        const line = overlay.group.children[0];
        // Line2 instances are Mesh-derived but render as fat screen-space lines
        // via LineGeometry's per-segment instancing.
        assert.ok(line.isLine2 || line.isMesh);
        const geo = line.geometry;
        // LineGeometry stores per-segment instance start/end attributes. For
        // a 4-point polyline that's 3 segments.
        const segCount = (geo.attributes.instanceStart && geo.attributes.instanceStart.count)
            || (geo.attributes.position && geo.attributes.position.count);
        assert.ok(segCount >= 3, `expected ≥3 segments, got ${segCount}`);
        overlay.dispose();
    });

    test('unknown keys silently no-op (the picker may run ahead of geometry)', () => {
        const { overlay } = makeOverlay();
        overlay.setGeometry({ faces: { a: FACE_GEO }, edges: {} });
        overlay.showHover('does-not-exist', 'face');
        assert.equal(overlay.group.children.length, 0);
        overlay.setSelected([{ key: 'also-missing', kind: 'face' }]);
        assert.equal(overlay.group.children.length, 0);
        overlay.dispose();
    });

    test('setGeometry invalidates cached BufferGeometries and clears overlays', () => {
        const { overlay } = makeOverlay();
        overlay.setGeometry({ faces: { a: FACE_GEO }, edges: {} });
        overlay.setSelected([{ key: 'a', kind: 'face' }]);
        assert.equal(overlay.group.children.length, 1);
        // New regen replaces geometry — cached overlays drop.
        overlay.setGeometry({ faces: { b: FACE_GEO }, edges: {} });
        assert.equal(overlay.group.children.length, 0);
        // Re-selecting the new key works against fresh geometry.
        overlay.setSelected([{ key: 'b', kind: 'face' }]);
        assert.equal(overlay.group.children.length, 1);
        overlay.dispose();
    });

    test('mesh sits at renderOrder 999/1000 so it draws above the body', () => {
        const { overlay } = makeOverlay();
        overlay.setGeometry({ faces: { a: FACE_GEO }, edges: {} });
        overlay.showHover('a', 'face');
        const hover = overlay.group.children[0];
        assert.equal(hover.renderOrder, 999);
        overlay.setSelected([{ key: 'a', kind: 'face' }]);
        const sel = overlay.group.children.find(c => c !== hover);
        assert.equal(sel.renderOrder, 1000);
        overlay.dispose();
    });

    test('overlay meshes are not raycastable (won\'t shadow picker)', () => {
        const { overlay } = makeOverlay();
        overlay.setGeometry({ faces: { a: FACE_GEO }, edges: {} });
        overlay.showHover('a', 'face');
        const mesh = overlay.group.children[0];
        // raycast was overridden to a no-op
        assert.equal(typeof mesh.raycast, 'function');
        // Calling raycast with a noop signature should not throw and should
        // contribute nothing to a hits array.
        const hits = [];
        mesh.raycast({}, hits);
        assert.equal(hits.length, 0);
        overlay.dispose();
    });

    test('hover + select on the same key — both render (select wins z-order)', () => {
        const { overlay } = makeOverlay();
        overlay.setGeometry({ faces: { a: FACE_GEO }, edges: {} });
        overlay.showHover('a', 'face');
        overlay.setSelected([{ key: 'a', kind: 'face' }]);
        assert.equal(overlay.group.children.length, 2);
        const orders = overlay.group.children.map(c => c.renderOrder).sort((a, b) => a - b);
        assert.deepEqual(orders, [999, 1000]);
        overlay.dispose();
    });

    test('dispose detaches the group and frees materials', () => {
        const { scene, overlay } = makeOverlay();
        overlay.setGeometry({ faces: { a: FACE_GEO }, edges: {} });
        overlay.setSelected([{ key: 'a', kind: 'face' }]);
        overlay.dispose();
        assert.ok(!scene.children.includes(overlay.group));
    });
});

await runAll();
