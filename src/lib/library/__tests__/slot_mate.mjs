/**
 * Port-model v2 — T-slot snap-fit vertical.
 *
 * Run via:
 *   node --import ./src/lib/commands/__tests__/_register.mjs \
 *        src/lib/library/__tests__/slot_mate.mjs
 *
 * Proves the one thing the old point-connector model couldn't do: an M5 t-nut
 * snaps *into* a 2020 extrusion channel (on a face, not the centerline) with a
 * slide DOF. Covers slot-port generation, profile-aware compatibility, the
 * two-axis slot solve, slide clamping, and the induced prismatic joint.
 */

import assert from 'node:assert/strict';

import { slotPortsForExtrusion, expandPortsInPlace, profileIdForRecord } from '../profiles.js';
import {
    connectorsCompatible, solveMateTransform, inducedJointFromMate, worldConnectorFor,
} from '../mate_solver.js';
import { makeConnector } from '../../../../lib/document/types.js';

let _pass = 0, _fail = 0;
function t(name, fn) {
    try { fn(); console.log(`  ok  ${name}`); _pass++; }
    catch (e) { console.error(`  FAIL ${name}\n    ${e?.stack || e?.message || e}`); _fail++; }
}
const approx = (a, b, eps = 1e-3) => Math.abs(a - b) <= eps;
const approxV = (a, b, eps = 1e-3) => approx(a[0], b[0], eps) && approx(a[1], b[1], eps) && approx(a[2], b[2], eps);

// Apply a 4×4 row-major SE(3) rotation block to a direction vector.
function rotDir(M, v) {
    return [
        M[0] * v[0] + M[1] * v[1] + M[2] * v[2],
        M[4] * v[0] + M[5] * v[1] + M[6] * v[2],
        M[8] * v[0] + M[9] * v[1] + M[10] * v[2],
    ];
}

// A 250 mm 2020 extrusion record (shape the loader sees), MIN-aligned on Z.
const EXT_2020_250 = {
    id: 'lib-part-ext-2020-250',
    name: '2020 T-slot extrusion, 250 mm',
    category: 'extrusion',
    source: 'parametric',
    connectors: [
        { id: 'end-bottom', kind: 'bore', gender: 'female', axis: [0, 0, -1], origin: [0, 0, 0],
          mates_with: ['bore', 'shaft'], interfaceId: 'profile-2020', role: 'extrusion-end',
          size: { nominal: 20, unit: 'mm' } },
        { id: 'end-top', kind: 'bore', gender: 'female', axis: [0, 0, 1], origin: [0, 0, 250],
          mates_with: ['bore', 'shaft'], interfaceId: 'profile-2020', role: 'extrusion-end',
          size: { nominal: 20, unit: 'mm' } },
    ],
    boundingBox: { min: [-10, -10, 0], max: [10, 10, 250] },
};

// The M5 t-nut's slide port (mirrors parts/nuts.json after the v2 upgrade).
function tnutRailPort() {
    return makeConnector({
        id: 'rail-slide', parent: 'lib-part-tnut-m5-2020', kind: 'rail', gender: 'neutral',
        size: { nominal: 'M5', unit: 'mm' },
        axis: [1, 0, 0], origin: [0, 0, 1], normal: [0, 0, 1],
        topology: 'line', profile: 'tslot-2020', fit: 'detent',
        mates_with: ['rail', 'slot'], inducedJoint: 'prismatic',
    });
}

console.log('── port-model v2 — t-slot snap-fit vertical ──');

t('2020 extrusion generates one slot port per face (4)', () => {
    const ports = slotPortsForExtrusion(EXT_2020_250);
    assert.equal(ports.length, 4);
    assert.ok(ports.every((p) => p.kind === 'slot' && p.topology === 'line'));
    assert.ok(ports.every((p) => p.profile === 'tslot-2020'));
    assert.ok(ports.every((p) => p.inducedJoint === 'prismatic'));
});

t('profileIdForRecord reads the end-connector interfaceId', () => {
    assert.equal(profileIdForRecord(EXT_2020_250), 'tslot-2020');
});

t('the +X slot port sits on the +X face surface at mid-run', () => {
    const ports = slotPortsForExtrusion(EXT_2020_250);
    const px = ports.find((p) => approxV(p.normal, [1, 0, 0]));
    assert.ok(px, '+X port exists');
    assert.ok(approxV(px.origin, [10, 0, 125]), `origin ${px.origin}`);
    assert.deepEqual(px.axis, [0, 0, 1]);                 // runs along the length
    assert.ok(approx(px.extent.from, -117) && approx(px.extent.to, 117)); // 125 - endMargin(8)
});

t('expandPortsInPlace adds slots to a record (idempotent)', () => {
    const rec = JSON.parse(JSON.stringify(EXT_2020_250));
    expandPortsInPlace(rec);
    const slots = rec.connectors.filter((c) => c.kind === 'slot');
    assert.equal(slots.length, 4);
    expandPortsInPlace(rec);                              // second call is a no-op
    assert.equal(rec.connectors.filter((c) => c.kind === 'slot').length, 4);
});

t('t-nut rail port mates the extrusion slot (profile fast-path)', () => {
    const slot = slotPortsForExtrusion(EXT_2020_250).find((p) => approxV(p.normal, [1, 0, 0]));
    assert.equal(connectorsCompatible(slot, tnutRailPort()), true);
});

t('t-nut rail port does NOT mate the extrusion end-bore', () => {
    const endBore = makeConnector({ kind: 'bore', gender: 'female', axis: [0, 0, 1], origin: [0, 0, 250],
        mates_with: ['bore', 'shaft'], interfaceId: 'profile-2020', size: { nominal: 20, unit: 'mm' } });
    assert.equal(connectorsCompatible(endBore, tnutRailPort()), false);
});

t('slot mate lands the t-nut IN the +X channel, not the centerline', () => {
    const slot = slotPortsForExtrusion(EXT_2020_250).find((p) => approxV(p.normal, [1, 0, 0]));
    const solved = solveMateTransform(slot, tnutRailPort());
    // x ≈ 8 (just inside the x=10 face), centered on Y, mid-run on Z.
    assert.ok(approx(solved.position[0], 8), `x=${solved.position[0]} (expected ~8, NOT 0)`);
    assert.ok(approx(solved.position[1], 0), `y=${solved.position[1]}`);
    assert.ok(approx(solved.position[2], 125), `z=${solved.position[2]}`);
    assert.ok(Math.abs(solved.position[0]) > 1, 'must not be at the centerline');
});

t('slot mate orients nut: slide→run(+Z), out/thread→face(+X)', () => {
    const slot = slotPortsForExtrusion(EXT_2020_250).find((p) => approxV(p.normal, [1, 0, 0]));
    const { matrix } = solveMateTransform(slot, tnutRailPort());
    assert.ok(approxV(rotDir(matrix, [1, 0, 0]), [0, 0, 1]), 'slide axis +X → world +Z');
    assert.ok(approxV(rotDir(matrix, [0, 0, 1]), [1, 0, 0]), 'thread axis +Z → world +X');
});

t('slot mate induces a prismatic joint with channel limits', () => {
    const slot = slotPortsForExtrusion(EXT_2020_250).find((p) => approxV(p.normal, [1, 0, 0]));
    const solved = solveMateTransform(slot, tnutRailPort());
    assert.equal(solved.joint.kind, 'prismatic');
    assert.ok(approxV(solved.joint.axis, [0, 0, 1]));
    assert.ok(approx(solved.joint.limits.lower, -117) && approx(solved.joint.limits.upper, 117));
    assert.equal(inducedJointFromMate(slot, tnutRailPort()), 'prismatic');
});

t('slide parameter moves the nut along the run, clamped to extent', () => {
    const slot = slotPortsForExtrusion(EXT_2020_250).find((p) => approxV(p.normal, [1, 0, 0]));
    const mid  = solveMateTransform(slot, tnutRailPort(), { slide: 0 });
    const fwd  = solveMateTransform(slot, tnutRailPort(), { slide: 50 });
    assert.ok(approx(fwd.position[2] - mid.position[2], 50), 'slides +50 mm along Z');
    const past = solveMateTransform(slot, tnutRailPort(), { slide: 1000 });
    assert.ok(approx(past.position[2], 125 + 117), 'clamped to z = mid + extent.to');
});

// ── Euler convention: the solver's euler triple MUST reproduce its own matrix
// when composed the way the document's consumers compose it — THREE.Euler
// order 'XYZ' (R = Rx·Ry·Rz), mirrored by emit.js (kernel bake) and
// snap_frames.js (drag preview). The slot solve produces a COMPOUND rotation
// (slide +X→+Z, thread +Z→+X, i.e. 180° about (1,0,1)/√2) — exactly the case
// where the old Rz·Ry·Rx euler recovery baked the part mis-oriented.
function eulerXYZToR_THREE(x, y, z) {
    const cx = Math.cos(x), sx = Math.sin(x);
    const cy = Math.cos(y), sy = Math.sin(y);
    const cz = Math.cos(z), sz = Math.sin(z);
    return [
        cy * cz,                -cy * sz,                sy,
        cx * sz + sx * sy * cz,  cx * cz - sx * sy * sz, -sx * cy,
        sx * sz - cx * sy * cz,  sx * cz + cx * sy * sz,  cx * cy,
    ];
}
function rot3(R, v) {
    return [
        R[0] * v[0] + R[1] * v[1] + R[2] * v[2],
        R[3] * v[0] + R[4] * v[1] + R[5] * v[2],
        R[6] * v[0] + R[7] * v[1] + R[8] * v[2],
    ];
}

t('solved euler reproduces the matrix under THREE-XYZ composition (kernel-bake convention)', () => {
    const slot = slotPortsForExtrusion(EXT_2020_250).find((p) => approxV(p.normal, [1, 0, 0]));
    const solved = solveMateTransform(slot, tnutRailPort());
    const R = eulerXYZToR_THREE(solved.euler[0], solved.euler[1], solved.euler[2]);
    for (const basis of [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) {
        const fromEuler  = rot3(R, basis);
        const fromMatrix = rotDir(solved.matrix, basis);
        assert.ok(approxV(fromEuler, fromMatrix),
            `basis ${basis}: euler→${fromEuler} vs matrix→${fromMatrix}`);
    }
});

// ── Roll about the face normal: flips the nut in place inside the channel.
t('roll=π flips the nut along the run, keeps it seated, preserves slide', () => {
    const slot = slotPortsForExtrusion(EXT_2020_250).find((p) => approxV(p.normal, [1, 0, 0]));
    const base    = solveMateTransform(slot, tnutRailPort(), { slide: 40 });
    const flipped = solveMateTransform(slot, tnutRailPort(), { slide: 40, roll: Math.PI });
    // Slide axis reverses; seating normal (thread out) is preserved.
    assert.ok(approxV(rotDir(flipped.matrix, [1, 0, 0]), [0, 0, -1]), 'slide +X → world −Z');
    assert.ok(approxV(rotDir(flipped.matrix, [0, 0, 1]), [1, 0, 0]),  'thread +Z stays world +X');
    // The connector stays seated at the same world point in both solves:
    // position + R·partOrigin is identical.
    const seat = (s) => {
        const r = rotDir(s.matrix, [0, 0, 1]);  // partOrigin = [0,0,1]
        return [s.position[0] + r[0], s.position[1] + r[1], s.position[2] + r[2]];
    };
    assert.ok(approxV(seat(base), seat(flipped)), `seat ${seat(base)} vs ${seat(flipped)}`);
    assert.ok(approx(seat(flipped)[2], 165), 'seat sits at slide=40 above mid-run (125+40)');
});

// ── Moved host: worldConnectorFor must carry the host component's placement
// (and the v2 port fields) into the world frame. This is the frame
// placeLibraryPart now solves against — the old code used the raw stored
// (component-local) frame, landing parts offset by the host's placement.
t('worldConnectorFor on a moved extrusion shifts the slot port + keeps v2 fields', () => {
    const slot = slotPortsForExtrusion(EXT_2020_250).find((p) => approxV(p.normal, [1, 0, 0]));
    const doc = {
        components: {
            ext1: { id: 'ext1', parentId: 'root', origin: { position: [100, 50, 0], rotation: [0, 0, 0] } },
        },
        connectors: {},
    };
    const placed = { ...slot, parent: 'ext1' };
    const w = worldConnectorFor(doc, placed);
    assert.ok(approxV(w.origin, [110, 50, 125]), `origin ${w.origin} (local [10,0,125] + [100,50,0])`);
    assert.ok(approxV(w.axis, [0, 0, 1]));
    assert.ok(approxV(w.normal, [1, 0, 0]));
    assert.equal(w.profile, 'tslot-2020');
    assert.ok(approx(w.extent.from, -117) && approx(w.extent.to, 117));
    assert.ok(approx(w.seatDepth, 1.0));
    // The solve against the WORLD frame lands the nut beside the moved rail.
    const solved = solveMateTransform(w, tnutRailPort(), { slide: -30 });
    const r = rotDir(solved.matrix, [0, 0, 1]);
    const seat = [solved.position[0] + r[0], solved.position[1] + r[1], solved.position[2] + r[2]];
    assert.ok(approxV(seat, [110 - 1.0, 50, 95]), `seat ${seat}`);
});

console.log(`\n  ${_pass} passed, ${_fail} failed`);
if (_fail > 0) process.exit(1);
