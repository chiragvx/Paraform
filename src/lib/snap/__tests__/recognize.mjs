/**
 * Spec 18 v2 / Phase 3 — recognize.js tests.
 *
 * Run via:
 *   node --import ./src/lib/commands/__tests__/_register.mjs \
 *        src/lib/snap/__tests__/recognize.mjs
 *
 * Validates rail-shape recognition + that `deriveConnectorsFromGeometry`
 * emits the matching `rail` connector. Geometry blobs are synthesized
 * directly — no kernel round-trip.
 */

import assert from 'node:assert/strict';

import { recognizeRail } from '../recognize.js';
import { deriveConnectorsFromGeometry } from '../derive.js';

let _pass = 0, _fail = 0;
function t(name, fn) {
    try { fn(); console.log(`  ok  ${name}`); _pass++; }
    catch (e) { console.error(`  FAIL ${name}\n    ${e?.stack || e?.message || e}`); _fail++; }
}

// Build a synthetic rail-like body: 6 face entries forming the AABB of a
// long extrusion along the chosen axis. Each face carries a normal +
// matching vertices so the AABB pass + perpendicular-normal histogram
// both succeed.
function buildRailFaces({ length, width, height, axis }) {
    // axis ∈ 'x' | 'y' | 'z'
    const halfL = length / 2;
    const halfW = width / 2;
    const halfH = height / 2;
    const verts = (corners) => corners.flat();
    let faces;
    if (axis === 'x') {
        faces = {
            'F+X': { vertices: verts([[halfL, -halfW, -halfH],[halfL, halfW, -halfH],[halfL, halfW, halfH],[halfL, -halfW, halfH]]),
                     indices: [0,1,2, 0,2,3], normal: [1, 0, 0], center: [halfL, 0, 0] },
            'F-X': { vertices: verts([[-halfL, -halfW, -halfH],[-halfL, halfW, -halfH],[-halfL, halfW, halfH],[-halfL, -halfW, halfH]]),
                     indices: [0,1,2, 0,2,3], normal: [-1, 0, 0], center: [-halfL, 0, 0] },
            'F+Y': { vertices: verts([[-halfL, halfW, -halfH],[halfL, halfW, -halfH],[halfL, halfW, halfH],[-halfL, halfW, halfH]]),
                     indices: [0,1,2, 0,2,3], normal: [0, 1, 0], center: [0, halfW, 0] },
            'F-Y': { vertices: verts([[-halfL, -halfW, -halfH],[halfL, -halfW, -halfH],[halfL, -halfW, halfH],[-halfL, -halfW, halfH]]),
                     indices: [0,1,2, 0,2,3], normal: [0, -1, 0], center: [0, -halfW, 0] },
            'F+Z': { vertices: verts([[-halfL, -halfW, halfH],[halfL, -halfW, halfH],[halfL, halfW, halfH],[-halfL, halfW, halfH]]),
                     indices: [0,1,2, 0,2,3], normal: [0, 0, 1], center: [0, 0, halfH] },
            'F-Z': { vertices: verts([[-halfL, -halfW, -halfH],[halfL, -halfW, -halfH],[halfL, halfW, -halfH],[-halfL, halfW, -halfH]]),
                     indices: [0,1,2, 0,2,3], normal: [0, 0, -1], center: [0, 0, -halfH] },
        };
    } else if (axis === 'z') {
        faces = {
            'F+Z': { vertices: verts([[-halfW, -halfH, halfL],[halfW, -halfH, halfL],[halfW, halfH, halfL],[-halfW, halfH, halfL]]),
                     indices: [0,1,2, 0,2,3], normal: [0, 0, 1], center: [0, 0, halfL] },
            'F-Z': { vertices: verts([[-halfW, -halfH, -halfL],[halfW, -halfH, -halfL],[halfW, halfH, -halfL],[-halfW, halfH, -halfL]]),
                     indices: [0,1,2, 0,2,3], normal: [0, 0, -1], center: [0, 0, -halfL] },
            'F+X': { vertices: verts([[halfW, -halfH, -halfL],[halfW, halfH, -halfL],[halfW, halfH, halfL],[halfW, -halfH, halfL]]),
                     indices: [0,1,2, 0,2,3], normal: [1, 0, 0], center: [halfW, 0, 0] },
            'F-X': { vertices: verts([[-halfW, -halfH, -halfL],[-halfW, halfH, -halfL],[-halfW, halfH, halfL],[-halfW, -halfH, halfL]]),
                     indices: [0,1,2, 0,2,3], normal: [-1, 0, 0], center: [-halfW, 0, 0] },
            'F+Y': { vertices: verts([[-halfW, halfH, -halfL],[halfW, halfH, -halfL],[halfW, halfH, halfL],[-halfW, halfH, halfL]]),
                     indices: [0,1,2, 0,2,3], normal: [0, 1, 0], center: [0, halfH, 0] },
            'F-Y': { vertices: verts([[-halfW, -halfH, -halfL],[halfW, -halfH, -halfL],[halfW, -halfH, halfL],[-halfW, -halfH, halfL]]),
                     indices: [0,1,2, 0,2,3], normal: [0, -1, 0], center: [0, -halfH, 0] },
        };
    } else {
        throw new Error('axis must be x or z');
    }
    return { faces };
}

console.log('── recognize.js — rail/extrusion detection ──');

t('cube is NOT a rail (no dominant axis)', () => {
    const geom = buildRailFaces({ length: 20, width: 20, height: 20, axis: 'x' });
    assert.equal(recognizeRail(geom), null);
});

t('elongated 20×20 along X recognized as a rail', () => {
    const geom = buildRailFaces({ length: 300, width: 20, height: 20, axis: 'x' });
    const r = recognizeRail(geom);
    assert.ok(r, 'expected rail descriptor, got null');
    assert.deepEqual(r.axis, [1, 0, 0]);
    assert.equal(r.profile, '20x20');
    assert.equal(r.channelWidth, 6.0);
    assert.equal(r.length, 300);
});

t('rail along Z reports +Z axis', () => {
    const geom = buildRailFaces({ length: 500, width: 30, height: 30, axis: 'z' });
    const r = recognizeRail(geom);
    assert.ok(r);
    assert.deepEqual(r.axis, [0, 0, 1]);
    assert.equal(r.profile, '30x30');
});

t('rail origin is body centroid', () => {
    const geom = buildRailFaces({ length: 200, width: 20, height: 20, axis: 'x' });
    const r = recognizeRail(geom);
    assert.deepEqual(r.origin, [0, 0, 0]);
});

t('unknown cross-section flagged but still classified as rail', () => {
    const geom = buildRailFaces({ length: 200, width: 17, height: 31, axis: 'x' });
    const r = recognizeRail(geom);
    assert.ok(r);
    assert.equal(r.profile, 'unknown');
    assert.equal(r.channelWidth, null);
});

t('20x40 profile recognized either orientation', () => {
    // 20-wide, 40-tall
    const a = recognizeRail(buildRailFaces({ length: 300, width: 20, height: 40, axis: 'x' }));
    // 40-wide, 20-tall (same profile, swapped axes)
    const b = recognizeRail(buildRailFaces({ length: 300, width: 40, height: 20, axis: 'x' }));
    assert.equal(a.profile, '20x40');
    assert.equal(b.profile, '20x40');
});

t('elongation below threshold rejects', () => {
    // 2:1 isn't enough — minElongation defaults to 2.5.
    const geom = buildRailFaces({ length: 40, width: 20, height: 20, axis: 'x' });
    assert.equal(recognizeRail(geom), null);
});

t('score is in [0,1] and higher for known profile', () => {
    const known   = recognizeRail(buildRailFaces({ length: 300, width: 20, height: 20, axis: 'x' }));
    const unknown = recognizeRail(buildRailFaces({ length: 300, width: 17, height: 31, axis: 'x' }));
    assert.ok(known.score >= 0 && known.score <= 1);
    assert.ok(unknown.score >= 0 && unknown.score <= 1);
    assert.ok(known.score > unknown.score, 'known profile should score higher');
});

// ── derive.js integration ──────────────────────────────────────────────────
console.log('');

t('derive: rail-shaped geometry produces a rail connector', () => {
    const geom = buildRailFaces({ length: 300, width: 20, height: 20, axis: 'x' });
    const conns = deriveConnectorsFromGeometry(geom);
    const rails = conns.filter((c) => c.kind === 'rail');
    assert.equal(rails.length, 1, `expected 1 rail connector, got ${rails.length}`);
    assert.deepEqual(rails[0].axis, [1, 0, 0]);
    assert.equal(rails[0].metadata?.profile, '20x20');
    assert.equal(rails[0].inducedJoint, 'prismatic');
});

t('derive: rail connector accepts shaft/rail mates', () => {
    const geom = buildRailFaces({ length: 300, width: 20, height: 20, axis: 'x' });
    const conns = deriveConnectorsFromGeometry(geom);
    const rail = conns.find((c) => c.kind === 'rail');
    assert.ok(rail.mates_with.includes('shaft'));
    assert.ok(rail.mates_with.includes('rail'));
});

t('derive: cube produces face planars but no rail connector', () => {
    const geom = buildRailFaces({ length: 20, width: 20, height: 20, axis: 'x' });
    const conns = deriveConnectorsFromGeometry(geom);
    const rails = conns.filter((c) => c.kind === 'rail');
    assert.equal(rails.length, 0);
    // 6 face planars should still come through.
    const planars = conns.filter((c) => c.kind === 'planar');
    assert.equal(planars.length, 6);
});

t('derive: includeRail=false suppresses rail emission', () => {
    const geom = buildRailFaces({ length: 300, width: 20, height: 20, axis: 'x' });
    const conns = deriveConnectorsFromGeometry(geom, { includeRail: false });
    assert.equal(conns.filter((c) => c.kind === 'rail').length, 0);
});

// ── Report ─────────────────────────────────────────────────────────────────
console.log(`\n${_pass} pass, ${_fail} fail`);
if (_fail > 0) process.exit(1);
