/**
 * snap_frames round-trip tests — the frame-correct drag math.
 *   node app/viewport/__tests__/snap_frames.mjs
 *
 * Models the real scene graph: a subgroup at identity under a GLB wrap
 * (×1000 + Y-up→Z-up rotation), component placement baked at W0. Asserts that
 * driving the subgroup to a target world pose actually lands the component
 * there, and that reading it back round-trips.
 */
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
    composeMatrix, decomposePose, localForWorldPose,
    componentWorldFromObject, liveConnectorWorld,
} from '../snap_frames.js';

let _pass = 0, _fail = 0;
function t(name, fn) {
    try { fn(); console.log(`  ok  ${name}`); _pass++; }
    catch (e) { console.error(`  FAIL ${name}\n    ${e?.stack || e?.message || e}`); _fail++; }
}
const approxV = (a, b, eps = 1e-6) =>
    Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps && Math.abs(a[2] - b[2]) <= eps;

// The GLB wrap: ×1000 scale + +π/2 about X (Y-up → Z-up), like bridge.js.
function wrap() {
    const m = new THREE.Matrix4();
    const r = new THREE.Matrix4().makeRotationX(Math.PI / 2);
    const s = new THREE.Matrix4().makeScale(1000, 1000, 1000);
    return m.multiply(r).multiply(s);
}

console.log('── snap_frames (drag frame math) ──');

t('drive subgroup to a world pose → component lands exactly there', () => {
    const P = wrap();
    const Pinv = P.clone().invert();
    // Subgroup at rest: its own matrix is identity, so objStart = P.
    const objStart = P.clone();
    const objStartInv = objStart.clone().invert();
    // Component baked at a non-origin pose.
    const W0 = composeMatrix([37, -12, 80], [0, 0, Math.PI / 4]);
    const W0inv = W0.clone().invert();
    // Target world pose (what the mate solver returns).
    const Wnew = composeMatrix([200, 5, 30], [Math.PI / 2, 0, 0]);

    const objLocal = localForWorldPose(Pinv, objStart, W0inv, Wnew);
    const objWorld = P.clone().multiply(objLocal);            // subgroup new world
    const got = componentWorldFromObject(objWorld, objStartInv, W0);

    const a = decomposePose(got);
    const b = decomposePose(Wnew);
    assert.ok(approxV(a.position, b.position, 1e-3), `pos ${a.position} vs ${b.position}`);
    assert.ok(approxV(a.rotation, b.rotation, 1e-3), `rot ${a.rotation} vs ${b.rotation}`);
});

t('live connector world = Wnew · localOrigin after the drive', () => {
    const P = wrap();
    const Pinv = P.clone().invert();
    const objStart = P.clone();
    const objStartInv = objStart.clone().invert();
    const W0 = composeMatrix([10, 0, 0], [0, 0, 0]);
    const W0inv = W0.clone().invert();
    const Wnew = composeMatrix([100, 0, 0], [0, 0, 0]);

    // A connector at component-local [2,0,1] → its baked world origin = W0·L.
    const L = [2, 0, 1];
    const worldOrigin = new THREE.Vector3(...L).applyMatrix4(W0);

    const objLocal = localForWorldPose(Pinv, objStart, W0inv, Wnew);
    const objWorld = P.clone().multiply(objLocal);
    const live = liveConnectorWorld(objWorld, objStartInv, [worldOrigin.x, worldOrigin.y, worldOrigin.z]);

    const expected = new THREE.Vector3(...L).applyMatrix4(Wnew);   // connector at Wnew
    assert.ok(approxV([live.x, live.y, live.z], [expected.x, expected.y, expected.z], 1e-3),
        `live ${[live.x, live.y, live.z]} vs ${[expected.x, expected.y, expected.z]}`);
});

t('at rest (objWorld == objStart) component world == W0', () => {
    const P = wrap();
    const objStart = P.clone();
    const objStartInv = objStart.clone().invert();
    const W0 = composeMatrix([5, 6, 7], [0, 0.3, 0]);
    const got = componentWorldFromObject(objStart.clone(), objStartInv, W0);
    const a = decomposePose(got), b = decomposePose(W0);
    assert.ok(approxV(a.position, b.position, 1e-3) && approxV(a.rotation, b.rotation, 1e-3));
});

console.log(`\n  ${_pass} passed, ${_fail} failed`);
if (_fail > 0) process.exit(1);
