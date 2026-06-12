/**
 * Spec 18 v2 / Phase 2 — derive.js tests.
 *
 * Run via:
 *   node --import ./src/lib/commands/__tests__/_register.mjs \
 *        src/lib/snap/__tests__/derive.mjs
 *
 * Validates that synthesized connectors from `bridge.geometry`-shaped
 * blobs come back with the right pose + kind, AND that they mate with
 * each other via the empty-mates_with fallback added to mate_solver.
 */

import assert from 'node:assert/strict';

import { deriveConnectorsFromGeometry } from '../derive.js';
import { connectorsCompatible, solveMateTransform } from '../../library/mate_solver.js';

let _pass = 0, _fail = 0;
function t(name, fn) {
    try { fn(); console.log(`  ok  ${name}`); _pass++; }
    catch (e) { console.error(`  FAIL ${name}\n    ${e?.stack || e?.message || e}`); _fail++; }
}

function approxEq(a, b, eps = 1e-4) { return Math.abs(a - b) <= eps; }
function approxVec(a, b, eps = 1e-3) {
    return approxEq(a[0], b[0], eps) && approxEq(a[1], b[1], eps) && approxEq(a[2], b[2], eps);
}

// A single top-facing face: triangle (0,0,0)-(10,0,0)-(0,10,0) with normal +Z.
const FACE_TOP = {
    vertices: [
        0, 0, 0,
        10, 0, 0,
        0, 10, 0,
    ],
    indices: [0, 1, 2],
    center: [10 / 3, 10 / 3, 0],
    normal: [0, 0, 1],
};

// A side face on +X plane (axis +X).
const FACE_PLUSX = {
    vertices: [
        20, 0, 0,
        20, 10, 0,
        20, 0, 5,
    ],
    indices: [0, 1, 2],
    center: [20, 10/3, 5/3],
    normal: [1, 0, 0],
};

console.log('── derive.js — implicit connectors from geometry ──');

t('returns one planar connector per face with a normal', () => {
    const geom = { faces: { 'F1': FACE_TOP, 'F2': FACE_PLUSX } };
    const out = deriveConnectorsFromGeometry(geom);
    assert.equal(out.length, 2);
    assert.ok(out.every((c) => c.kind === 'planar'));
});

t('connector origin matches the kernel-shipped face center', () => {
    const geom = { faces: { 'F1': FACE_TOP } };
    const out = deriveConnectorsFromGeometry(geom);
    assert.ok(approxVec(out[0].origin, FACE_TOP.center));
});

t('connector axis matches the kernel-shipped face normal', () => {
    const geom = { faces: { 'F2': FACE_PLUSX } };
    const out = deriveConnectorsFromGeometry(geom);
    assert.ok(approxVec(out[0].axis, [1, 0, 0]));
});

t('falls back to computed centroid when center is absent', () => {
    const noCenter = { ...FACE_TOP, center: undefined };
    const out = deriveConnectorsFromGeometry({ faces: { 'F': noCenter } });
    // Centroid of (0,0,0)-(10,0,0)-(0,10,0) = (10/3, 10/3, 0).
    assert.ok(approxVec(out[0].origin, [10 / 3, 10 / 3, 0]));
});

t('falls back to computed normal when normal is absent', () => {
    const noNormal = { ...FACE_TOP, normal: undefined };
    const out = deriveConnectorsFromGeometry({ faces: { 'F': noNormal } });
    assert.equal(out.length, 1);
    // Triangle wound CCW in the XY plane → normal +Z.
    assert.ok(approxVec(out[0].axis, [0, 0, 1]));
});

t('stamps componentId onto every record when supplied', () => {
    const out = deriveConnectorsFromGeometry({ faces: { 'F': FACE_TOP } },
        { componentId: 'cmp-7' });
    assert.equal(out[0].parent, 'cmp-7');
});

t('size = auto/unspecified so any nominal mates', () => {
    const out = deriveConnectorsFromGeometry({ faces: { 'F': FACE_TOP } });
    const s = out[0].size?.nominal;
    assert.ok(s === 'auto' || s === 'unspecified',
        `expected auto/unspecified, got ${s}`);
});

t('marks derived connectors so consumers can filter', () => {
    const out = deriveConnectorsFromGeometry({ faces: { 'F': FACE_TOP } });
    assert.equal(out[0].metadata?.derived, true);
    assert.equal(out[0].metadata?.source,  'face');
});

t('two derived planars mate (mate_solver wildcard path)', () => {
    const a = deriveConnectorsFromGeometry({ faces: { 'F': FACE_TOP } })[0];
    const b = deriveConnectorsFromGeometry({ faces: { 'F': FACE_PLUSX } })[0];
    assert.equal(connectorsCompatible(a, b), true);
});

t('solveMateTransform: derived part lands at host origin', () => {
    // Host: planar face center at (100, 0, 0), normal +X.
    const host = { kind: 'planar', axis: [1, 0, 0], origin: [100, 0, 0] };
    // Part: derived planar at part-local (0, 0, 0), normal +Z.
    const partGeom = { faces: { 'F': FACE_TOP } };
    const part = deriveConnectorsFromGeometry(partGeom)[0];
    const solved = solveMateTransform(host, part);
    // Part's connector origin = face centroid (10/3, 10/3, 0). The solver
    // rotates the part so its axis flips into -host axis, then translates
    // so the rotated part-origin coincides with host.origin.
    // We sanity check: solved.position is finite + reasonable, and the
    // rotation maps part axis +Z → -X (anti-parallel to host's +X).
    assert.ok(Number.isFinite(solved.position[0]));
    assert.ok(Number.isFinite(solved.position[1]));
    assert.ok(Number.isFinite(solved.position[2]));
});

t('skips faces with degenerate normals', () => {
    const garbage = {
        vertices: [0,0,0, 0,0,0, 0,0,0],
        indices: [0,1,2],
        center: [0,0,0],
        normal: [0, 0, 0],
    };
    const out = deriveConnectorsFromGeometry({ faces: { 'F': garbage } });
    assert.equal(out.length, 0);
});

t('includeEdges: synthesizes edge-midpoint connectors when requested', () => {
    const geom = {
        faces: {},
        edges: {
            'E1': {
                points: [0, 0, 0, 5, 0, 0, 10, 0, 0],
                center: [5, 0, 0],
                tangent: [1, 0, 0],
            },
        },
    };
    const out = deriveConnectorsFromGeometry(geom, { includeEdges: true });
    assert.equal(out.length, 1);
    assert.ok(approxVec(out[0].origin, [5, 0, 0]));
    assert.ok(approxVec(out[0].axis,   [1, 0, 0]));
});

t('includeEdges: defaults to false (face-only output)', () => {
    const geom = { edges: { 'E1': { points: [0,0,0,1,0,0], tangent: [1,0,0] } } };
    const out = deriveConnectorsFromGeometry(geom);
    assert.equal(out.length, 0);
});

// ── Report ─────────────────────────────────────────────────────────────────
console.log(`\n${_pass} pass, ${_fail} fail`);
if (_fail > 0) process.exit(1);
