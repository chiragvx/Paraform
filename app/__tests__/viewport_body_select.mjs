/**
 * Tests for the body-level selection / highlight stack:
 *   - app/picking/body_highlight.js — BodyHighlightLayer + selectionToObjects
 *
 * Bridge tagging (lib/document/bridge.js) is GLB-parse-dependent and tested
 * inline by the bridge's own integration suite. Here we verify the
 * highlight layer's state-machine behavior with mock Three.js Object3Ds.
 *
 * Run via:  node app/__tests__/viewport_body_select.mjs
 */

import assert from 'node:assert/strict';
import * as THREE from 'three';
import { BodyHighlightLayer, selectionToObjects } from '../picking/body_highlight.js';
import { PickingSelection } from '../../lib/picking/selection.js';
import { bodyRef } from '../../lib/document/types.js';

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

function makeMesh(featureId, name = 'mesh') {
    const m = new THREE.Mesh(
        new THREE.BoxGeometry(1, 1, 1),
        new THREE.MeshStandardMaterial({ color: 0x808080, name: 'orig' }),
    );
    m.name = name;
    m.userData.featureId  = featureId;
    m.userData.descriptor = bodyRef(featureId);
    return m;
}

function makeBodyGroup(featureId) {
    const wrap = new THREE.Group();
    wrap.name = '__v4_glb_wrap__';
    wrap.userData.featureId  = featureId;
    wrap.userData.descriptor = bodyRef(featureId);
    wrap.add(makeMesh(featureId, 'mesh-a'));
    wrap.add(makeMesh(featureId, 'mesh-b'));
    return wrap;
}

// ── BodyHighlightLayer ──────────────────────────────────────────────────────
suite('BodyHighlightLayer', () => {
    test('setSelected swaps in the blue material on every mesh under the group', () => {
        const layer = new BodyHighlightLayer();
        const wrap  = makeBodyGroup('feat-1');
        const origs = [];
        wrap.traverse(n => { if (n.isMesh) origs.push(n.material); });

        layer.setSelected([wrap]);

        const swapped = [];
        wrap.traverse(n => { if (n.isMesh) swapped.push(n.material); });
        assert.equal(swapped.length, 2);
        swapped.forEach(mat => assert.notEqual(mat.name, 'orig'));
        // All meshes share the layer's single tint material.
        assert.equal(swapped[0], swapped[1]);
        // Verify color
        assert.equal('#' + swapped[0].color.getHexString(), '#3f8dff');
        layer.dispose();
    });

    test('clearSelection restores the original materials', () => {
        const layer = new BodyHighlightLayer();
        const wrap  = makeBodyGroup('feat-1');
        const origs = [];
        wrap.traverse(n => { if (n.isMesh) origs.push(n.material); });
        layer.setSelected([wrap]);
        layer.clearSelection();
        const restored = [];
        wrap.traverse(n => { if (n.isMesh) restored.push(n.material); });
        assert.deepEqual(restored, origs);
        layer.dispose();
    });

    test('setHovered tints in the warm hover color, but selected wins when both apply', () => {
        const layer = new BodyHighlightLayer();
        const wrap  = makeBodyGroup('feat-1');
        layer.setHovered([wrap]);
        const hovered = wrap.children[0].material;
        const hoverHex = hovered.color.getHexString();
        // Fusion-subtle: warmer than the original 0x808080 base, less saturated than orange.
        assert.notEqual(hoverHex, '808080');
        // Now select the same group — selection should win, blue replaces warm.
        layer.setSelected([wrap]);
        const selected = wrap.children[0].material;
        assert.equal('#' + selected.color.getHexString(), '#3f8dff');
        layer.dispose();
    });

    test('removing a body from hover restores it (if not selected)', () => {
        const layer = new BodyHighlightLayer();
        const wrap  = makeBodyGroup('feat-1');
        const orig  = wrap.children[0].material;
        layer.setHovered([wrap]);
        assert.notEqual(wrap.children[0].material, orig);
        layer.clearHover();
        assert.equal(wrap.children[0].material, orig);
        layer.dispose();
    });

    test('removing from hover does NOT restore a selected body', () => {
        const layer = new BodyHighlightLayer();
        const wrap  = makeBodyGroup('feat-1');
        layer.setSelected([wrap]);
        layer.setHovered([wrap]);
        layer.clearHover();
        // Should remain blue (selected).
        assert.equal('#' + wrap.children[0].material.color.getHexString(), '#3f8dff');
        layer.dispose();
    });

    test('tint materials have polygonOffset enabled so edges stay visible', () => {
        const layer = new BodyHighlightLayer();
        const wrap  = makeBodyGroup('feat-1');
        layer.setSelected([wrap]);
        const mat = wrap.children[0].material;
        assert.equal(mat.polygonOffset, true);
        assert.ok(mat.polygonOffsetFactor > 0);
        layer.dispose();
    });

    test('tint does not touch non-Mesh children (LineSegments edge overlay)', () => {
        const layer = new BodyHighlightLayer();
        const wrap  = makeBodyGroup('feat-1');
        // Add a fake LineSegments child mimicking the bridge's edge overlay.
        const lineGeom = new THREE.BufferGeometry();
        lineGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
        const lineMat = new THREE.LineBasicMaterial({ color: 0x000000, name: 'edge' });
        const lines = new THREE.LineSegments(lineGeom, lineMat);
        wrap.children[0].add(lines);

        layer.setSelected([wrap]);
        // Edge line material must remain untouched (still the 'edge' material).
        assert.equal(lines.material.name, 'edge');
        layer.dispose();
    });

    test('setSelected with a different group restores the previous group', () => {
        const layer = new BodyHighlightLayer();
        const a = makeBodyGroup('feat-a');
        const b = makeBodyGroup('feat-b');
        const origA = a.children[0].material;
        layer.setSelected([a]);
        assert.notEqual(a.children[0].material, origA);
        layer.setSelected([b]);
        // a restored
        assert.equal(a.children[0].material, origA);
        // b tinted
        assert.equal('#' + b.children[0].material.color.getHexString(), '#3f8dff');
        layer.dispose();
    });
});

// ── selectionToObjects ──────────────────────────────────────────────────────
suite('selectionToObjects', () => {
    test('returns [] when no descriptors are selected', () => {
        const sel = new PickingSelection();
        const wrap = makeBodyGroup('feat-1');
        assert.deepEqual(selectionToObjects(sel, wrap), []);
    });

    test('returns the wrap when one of its meshes matches a selected descriptor', () => {
        const sel = new PickingSelection();
        sel.add(bodyRef('feat-1'));
        const wrap = makeBodyGroup('feat-1');
        const objs = selectionToObjects(sel, wrap);
        assert.deepEqual(objs, [wrap]);
    });

    test('accepts both new (featureId) and legacy (feature) descriptor shapes', () => {
        const sel = new PickingSelection();
        // Legacy shape used by face/edge picker payloads.
        sel.add({ kind: 'face', feature: 'feat-1', opTag: 'Box', part: 'feat-1' });
        const wrap = makeBodyGroup('feat-1');
        const objs = selectionToObjects(sel, wrap);
        assert.deepEqual(objs, [wrap]);
    });

    test('matches by feature id even if descriptor kind differs (face vs body)', () => {
        const sel = new PickingSelection();
        sel.add({ kind: 'edge', feature: 'feat-1', opTag: 'X', part: 'feat-1' });
        const wrap = makeBodyGroup('feat-1');
        const objs = selectionToObjects(sel, wrap);
        assert.equal(objs.length, 1);
    });

    test('returns nothing for a feature id that doesn\'t exist in the scene', () => {
        const sel = new PickingSelection();
        sel.add(bodyRef('feat-missing'));
        const wrap = makeBodyGroup('feat-other');
        assert.deepEqual(selectionToObjects(sel, wrap), []);
    });
});

await runAll();
