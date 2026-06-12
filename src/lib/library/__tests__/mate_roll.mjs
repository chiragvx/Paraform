/**
 * Rotate-to-fit — mate roll + computeRolledOrigin.
 *
 * Run via:
 *   node src/lib/library/__tests__/mate_roll.mjs
 *
 * Proves the keyboard rotate-to-fit math: solveMateTransform's `opts.roll`
 * spins a part about the mate axis while keeping its connector seated, and
 * computeRolledOrigin accumulates roll on a mated component (re-solving) and
 * spins free placements about +Z.
 */

import assert from 'node:assert/strict';

import {
    solveMateTransform, __test__,
} from '../mate_solver.js';
import { computeRolledOrigin } from '../orient.js';

const { _rotApply, _eulerXYZToR } = __test__;

let _pass = 0, _fail = 0;
function t(name, fn) {
    try { fn(); console.log(`  ok  ${name}`); _pass++; }
    catch (e) { console.error(`  FAIL ${name}\n    ${e?.stack || e?.message || e}`); _fail++; }
}
const approx = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const approxV = (a, b, eps = 1e-4) =>
    approx(a[0], b[0], eps) && approx(a[1], b[1], eps) && approx(a[2], b[2], eps);

// Rotate a direction by an Euler XYZ triple (same convention as the solver).
function dirByEuler(euler, v) {
    return _rotApply(_eulerXYZToR(euler[0], euler[1], euler[2]), v);
}

console.log('── rotate-to-fit — mate roll ──');

// A planar host facing +Z at the origin; a part connector facing +Z at origin.
const hostPlanar = { kind: 'planar', axis: [0, 0, 1], origin: [0, 0, 0] };
const partPlanar = { kind: 'planar', gender: 'neutral', axis: [0, 0, 1], origin: [0, 0, 0] };

t('roll=0 leaves the base mate untouched', () => {
    const a = solveMateTransform(hostPlanar, partPlanar);
    const b = solveMateTransform(hostPlanar, partPlanar, { roll: 0 });
    assert.ok(approxV(a.position, b.position));
    assert.ok(approxV(a.euler, b.euler));
});

t('roll spins a marker about the mate axis (+Z)', () => {
    // A part connector with an in-plane "key" offset so roll is observable.
    const part = { kind: 'planar', gender: 'neutral', axis: [0, 0, 1], origin: [10, 0, 0] };
    const base = solveMateTransform(hostPlanar, part);              // key lands somewhere
    const turned = solveMateTransform(hostPlanar, part, { roll: Math.PI / 2 });
    // The connector origin must still sit on the host origin in BOTH solves
    // (the mate stays seated): position + R·partOrigin === hostOrigin.
    const seatedBase = dirByEuler(base.euler, part.origin).map((c, i) => c + base.position[i]);
    const seatedTurn = dirByEuler(turned.euler, part.origin).map((c, i) => c + turned.position[i]);
    assert.ok(approxV(seatedBase, [0, 0, 0]), `base seated ${seatedBase}`);
    assert.ok(approxV(seatedTurn, [0, 0, 0]), `turned seated ${seatedTurn}`);
    // A +90° roll about +Z must rotate the part's local +X marker by 90° in
    // the world XY plane relative to the base orientation.
    const baseX = dirByEuler(base.euler, [1, 0, 0]);
    const turnX = dirByEuler(turned.euler, [1, 0, 0]);
    // Cross product z-component sign tells rotation direction; magnitude ~ sin90.
    const crossZ = baseX[0] * turnX[1] - baseX[1] * turnX[0];
    assert.ok(approx(Math.abs(crossZ), 1, 1e-3), `expected 90° spin, crossZ=${crossZ}`);
});

console.log('\n── rotate-to-fit — computeRolledOrigin ──');

t('free placement spins about +Z and keeps position', () => {
    const doc = {
        components: { c1: { origin: { position: [5, 7, 0], rotation: [0, 0, 0] } } },
        connectors: {},
        mates: {},
    };
    const res = computeRolledOrigin(doc, 'c1', Math.PI / 2);
    assert.equal(res.regime, 'free');
    assert.ok(approxV(res.origin.position, [5, 7, 0]));
    // +90° about Z maps local +X → +Y.
    const x = dirByEuler(res.origin.rotation, [1, 0, 0]);
    assert.ok(approxV(x, [0, 1, 0]), `+X→${x}`);
});

t('mated component re-solves with accumulated roll + reports mateId', () => {
    const doc = {
        components: { c1: { origin: { position: [0, 0, 0], rotation: [0, 0, 0] } } },
        connectors: {
            host1: { id: 'host1', parent: 'root', kind: 'planar', axis: [0, 0, 1], origin: [0, 0, 0] },
            part1: { id: 'part1', parent: 'c1', kind: 'planar', gender: 'neutral', axis: [0, 0, 1], origin: [10, 0, 0] },
        },
        mates: {
            m1: {
                id: 'm1', componentId: 'c1',
                hostConnectorRef: { connectorId: 'host1' },
                partConnectorRef: { connectorId: 'part1' },
                offset: null,
            },
        },
    };
    const res = computeRolledOrigin(doc, 'c1', Math.PI / 2);
    assert.equal(res.regime, 'mated');
    assert.equal(res.mateId, 'm1');
    assert.ok(approx(res.roll, Math.PI / 2));
    // Simulate persisting the roll, then roll again → accumulates to π.
    doc.mates.m1.offset = { roll: res.roll };
    const res2 = computeRolledOrigin(doc, 'c1', Math.PI / 2);
    assert.ok(approx(res2.roll, Math.PI));
});

t('missing component → null (defensive)', () => {
    assert.equal(computeRolledOrigin({ components: {} }, 'nope', 1), null);
});

t('channel-mated nut flips about the face normal, stays seated, keeps slide', () => {
    // A 2020 slot port on the +X face (world frame, host parented to root) and
    // a t-nut whose rail port currently sits at slide=+40 along the run.
    const slot = {
        id: 'slot1', parent: 'root', kind: 'slot', gender: 'neutral',
        axis: [0, 0, 1], origin: [10, 0, 125], normal: [1, 0, 0],
        topology: 'line', profile: 'tslot-2020',
        extent: { from: -117, to: 117 },
        metadata: { seatDepth: 1.0 },
    };
    const rail = {
        id: 'part1', parent: 'c1', kind: 'rail', gender: 'neutral',
        axis: [1, 0, 0], origin: [0, 0, 1], normal: [0, 0, 1],
        topology: 'line', profile: 'tslot-2020',
    };
    // Seed c1 at the solved slide=40 pose so _currentSlide's projection (no
    // persisted offset.slide) has to recover 40 from the live geometry.
    const seeded = solveMateTransform(
        { kind: slot.kind, axis: slot.axis, origin: slot.origin, normal: slot.normal,
          topology: 'line', extent: slot.extent, seatDepth: 1.0 },
        rail, { slide: 40 });
    const doc = {
        components: { c1: { id: 'c1', parentId: 'root', origin: {
            position: seeded.position.slice(), rotation: seeded.euler.slice() } } },
        connectors: { slot1: slot, part1: rail },
        mates: {
            m1: {
                id: 'm1', componentId: 'c1',
                hostConnectorRef: { connectorId: 'slot1' },
                partConnectorRef: { connectorId: 'part1' },
                offset: null,
            },
        },
    };
    const res = computeRolledOrigin(doc, 'c1', Math.PI);
    assert.equal(res.regime, 'mated', 'channel mates must re-solve, not free-spin');
    assert.ok(approx(res.roll, Math.PI));
    assert.ok(approx(res.slide, 40, 1e-3), `slide preserved: ${res.slide}`);
    // Still seated: origin + R·partOrigin lands on the channel seat point
    // [10−seatDepth, 0, 125+40], and the slide axis reversed (flip), with the
    // thread normal still facing out of the +X face.
    const R = _eulerXYZToR(res.origin.rotation[0], res.origin.rotation[1], res.origin.rotation[2]);
    const ro = _rotApply(R, rail.origin);
    const seat = [res.origin.position[0] + ro[0], res.origin.position[1] + ro[1], res.origin.position[2] + ro[2]];
    assert.ok(approxV(seat, [9, 0, 165], 1e-3), `seat ${seat}`);
    assert.ok(approxV(_rotApply(R, [1, 0, 0]), [0, 0, -1], 1e-3), 'slide axis flipped along run');
    assert.ok(approxV(_rotApply(R, [0, 0, 1]), [1, 0, 0], 1e-3), 'thread still faces out of the +X face');
});

console.log(`\n  ${_pass} passed, ${_fail} failed`);
if (_fail > 0) process.exit(1);
