/**
 * Headless ConnectorOverlay tests — node-building + compatibility coloring.
 * three.js core (Scene/Camera/Geometry math) runs without a WebGL context.
 *
 *   node app/viewport/__tests__/connector_overlay.mjs
 */
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { ConnectorOverlay } from '../connector_overlay.js';

let _pass = 0, _fail = 0;
function t(name, fn) {
    try { fn(); console.log(`  ok  ${name}`); _pass++; }
    catch (e) { console.error(`  FAIL ${name}\n    ${e?.stack || e?.message || e}`); _fail++; }
}
const approxV = (a, b, eps = 1e-6) =>
    Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps && Math.abs(a[2] - b[2]) <= eps;

// Connectors are parent:null → worldConnectorFor returns them in world frame.
const DOC = {
    connectors: {
        'slot-x': {
            id: 'slot-x', parent: null, kind: 'slot', gender: 'neutral',
            topology: 'line', axis: [0, 0, 1], origin: [10, 0, 125], normal: [1, 0, 0],
            extent: { from: -117, to: 117 }, profile: 'tslot-2020', fit: 'detent',
            mates_with: ['rail', 'slot'], size: { nominal: 'M5', unit: 'mm' },
        },
        'thr': {
            id: 'thr', parent: null, kind: 'thread', gender: 'female',
            axis: [0, 0, 1], origin: [200, 0, 0], mates_with: ['thread'],
            interfaceId: 'thread-M5', size: { nominal: 'M5', unit: 'mm' },
        },
    },
};

const RAIL_PROBE = {
    id: 'nut-rail', kind: 'rail', gender: 'neutral', topology: 'line',
    axis: [1, 0, 0], normal: [0, 0, 1], profile: 'tslot-2020', fit: 'detent',
    mates_with: ['rail', 'slot'], size: { nominal: 'M5', unit: 'mm' },
};

function makeOverlay() {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, 1.5, 1, 5000);
    camera.position.set(10, 0, 600);          // look straight at the channel
    camera.lookAt(10, 0, 125);
    camera.updateMatrixWorld(true);
    const ov = new ConnectorOverlay({ scene, camera, docProvider: () => DOC });
    ov.setVisible(true);
    ov.rebuild();
    return ov;
}

console.log('── ConnectorOverlay (headless) ──');

t('slot connector builds a channel node with extent endpoints', () => {
    const ov = makeOverlay();
    const e = ov._byId.get('slot-x');
    assert.ok(e && e.isSlot, 'slot is a channel node');
    assert.ok(approxV(e.seg[0], [10, 0, 8]),   `p0 ${e.seg[0]}`);   // 125 - 117
    assert.ok(approxV(e.seg[1], [10, 0, 242]), `p1 ${e.seg[1]}`);   // 125 + 117
    assert.equal(e.balls.length, 3);                                 // ends + middle
});

t('point connector builds a single-ball node, no segment', () => {
    const ov = makeOverlay();
    const e = ov._byId.get('thr');
    assert.ok(e && !e.isSlot);
    assert.equal(e.seg, null);
    assert.equal(e.balls.length, 1);
    assert.ok(approxV(e.point, [200, 0, 0]));
});

t('probe colours the matching slot green, mismatching thread grey', () => {
    const ov = makeOverlay();
    ov.setCompatibilityProbe([RAIL_PROBE]);
    assert.equal(ov._byId.get('slot-x').state, 'compatible');
    assert.equal(ov._byId.get('thr').state, 'incompatible');
    assert.equal(ov._byId.get('slot-x').balls[0].material.color.getHex(), 0x35e06a);
});

t('clearing the probe reverts to idle', () => {
    const ov = makeOverlay();
    ov.setCompatibilityProbe([RAIL_PROBE]);
    ov.setCompatibilityProbe(null);
    assert.equal(ov._byId.get('slot-x').state, 'idle');
});

t('setHighlighted promotes one node to highlighted state', () => {
    const ov = makeOverlay();
    ov.setHighlighted('slot-x');
    assert.equal(ov._byId.get('slot-x').state, 'highlighted');
    assert.equal(ov._byId.get('thr').state, 'idle');
});

t('pickCompatibleAtCursor at the channel returns the slot, excludes thread', () => {
    const ov = makeOverlay();
    ov.setCompatibilityProbe([RAIL_PROBE]);
    // Project the channel midpoint to screen px, then pick there.
    const cam = ov.camera;
    const v = new THREE.Vector3(10, 0, 125).project(cam);
    const view = { width: 900, height: 600 };
    const cursor = { x: (v.x * 0.5 + 0.5) * view.width, y: (-v.y * 0.5 + 0.5) * view.height };
    const hit = ov.pickCompatibleAtCursor(cursor, cam, view, 30);
    assert.ok(hit && hit.connector.id === 'slot-x', `got ${hit && hit.connector.id}`);
});

console.log(`\n  ${_pass} passed, ${_fail} failed`);
if (_fail > 0) process.exit(1);
