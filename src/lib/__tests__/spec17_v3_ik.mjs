/**
 * Spec 17 v3 — inverse kinematics.
 *
 * Run via:
 *   node --import ./src/lib/commands/__tests__/_register.mjs \
 *        src/lib/__tests__/spec17_v3_ik.mjs
 *
 * Covers:
 *   1.  linalg: identity, transpose, multiply, invert (3×3 round-trip).
 *   2.  linalg: invert throws on singular.
 *   3.  Jacobian shape (6×N) for a 2-DOF chain.
 *   4.  Jacobian: revolute about Z at end-effector (1,0,0) — ∂p/∂θ ≈ (0,1,0)·(π/180) per degree.
 *   5.  resolveChain returns joints root-to-leaf, DOF count correct.
 *   6.  1-DOF revolute IK reaches a position on its arc (within tol).
 *   7.  1-DOF IK reports converged=true and iterations ≤ maxIter.
 *   8.  2-DOF planar chain reaches reachable target.
 *   9.  2-DOF chain on UNREACHABLE target → converged=false, residual > tol.
 *  10.  Joint-limit clamping prevents overshoot.
 *  11.  3-DOF serial chain in 3D (rev-Z, rev-Y, rev-Z) reaches target.
 *  12.  Damping λ prevents blowup near full-extension singularity.
 *  13.  Zero-DOF chain returns initial pose with residual = distance.
 */
import assert from 'node:assert/strict';
import {
    identity,
    transpose,
    multiply,
    invert,
    add,
    scale,
} from '$lib/kinematics/linalg.js';
import {
    resolveChain,
    computeJacobian,
    endEffectorPosition,
} from '$lib/kinematics/jacobian.js';
import { solveIK } from '$lib/kinematics/ik.js';
import {
    resetDocumentStore,
    getDocumentStore,
    addComponent,
    addJoint,
} from '../../../lib/document/index.js';

let _pass = 0, _fail = 0;
function t(name, fn) {
    try {
        const r = fn();
        if (r && typeof r.then === 'function') {
            return r.then(() => { console.log(`  ok  ${name}`); _pass++; })
                    .catch((e) => { console.error(`  FAIL ${name}\n    ${e?.stack || e?.message || e}`); _fail++; });
        }
        console.log(`  ok  ${name}`);
        _pass++;
    } catch (e) {
        console.error(`  FAIL ${name}\n    ${e?.stack || e?.message || e}`);
        _fail++;
    }
}

function approxEq(a, b, eps = 1e-4) { return Math.abs(a - b) <= eps; }

console.log('── spec 17 v3 — inverse kinematics ──');

// 1. linalg primitives ────────────────────────────────────────────────────────
t('linalg.identity(3) returns 3×3 identity', () => {
    const I = identity(3);
    assert.deepEqual(I, [[1,0,0],[0,1,0],[0,0,1]]);
});

t('linalg.transpose: (2×3)ᵀ has shape (3×2) and values match', () => {
    const A = [[1, 2, 3], [4, 5, 6]];
    const T = transpose(A);
    assert.equal(T.length, 3);
    assert.equal(T[0].length, 2);
    assert.equal(T[0][1], 4);
    assert.equal(T[2][0], 3);
});

t('linalg.multiply: 2×3 · 3×2 yields 2×2 with correct entries', () => {
    const A = [[1, 2, 3], [4, 5, 6]];
    const B = [[7, 8], [9, 10], [11, 12]];
    const C = multiply(A, B);
    // [1*7+2*9+3*11, 1*8+2*10+3*12] = [58, 64]
    assert.equal(C[0][0], 58);
    assert.equal(C[0][1], 64);
    assert.equal(C[1][0], 139);
    assert.equal(C[1][1], 154);
});

t('linalg.invert: 3×3 round-trip A · A⁻¹ ≈ I', () => {
    const A = [[4, 3, 2], [1, 5, 7], [3, 1, 6]];
    const inv = invert(A);
    const I = multiply(A, inv);
    for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) {
            assert.ok(approxEq(I[r][c], r === c ? 1 : 0, 1e-9),
                `I[${r}][${c}]=${I[r][c]}`);
        }
    }
});

t('linalg.invert: throws on singular matrix', () => {
    const S = [[1, 2, 3], [2, 4, 6], [0, 1, 0]]; // row 2 = 2× row 1
    assert.throws(() => invert(S), /singular/);
});

t('linalg.add + scale: A + (-1)*A = 0', () => {
    const A = [[1, 2], [3, 4]];
    const Z = add(A, scale(A, -1));
    assert.equal(Z[0][0], 0); assert.equal(Z[1][1], 0);
});

// 2. resolveChain ─────────────────────────────────────────────────────────────
t('resolveChain: 2-DOF chain returns 2 dofJoints in root-to-leaf order', () => {
    resetDocumentStore();
    addComponent({ name: 'a', parentId: 'root', componentId: 'a' });
    addComponent({ name: 'b', parentId: 'a',    componentId: 'b' });
    const j1 = addJoint({ kind: 'revolute', parent: 'root', child: 'a',
        origin: [0, 0, 0], axis: [0, 0, 1], limits: { min: -180, max: 180 } });
    const j2 = addJoint({ kind: 'revolute', parent: 'a', child: 'b',
        origin: [1, 0, 0], axis: [0, 0, 1], limits: { min: -180, max: 180 } });
    const { joints, dofJoints } = resolveChain(getDocumentStore().doc, 'b');
    assert.equal(joints.length, 2);
    assert.equal(dofJoints.length, 2);
    assert.equal(dofJoints[0].id, j1.id);
    assert.equal(dofJoints[1].id, j2.id);
});

// 3. Jacobian ─────────────────────────────────────────────────────────────────
t('Jacobian: shape is 6×N for a 2-DOF chain', () => {
    resetDocumentStore();
    addComponent({ name: 'a', parentId: 'root', componentId: 'a' });
    addComponent({ name: 'b', parentId: 'a',    componentId: 'b' });
    const j1 = addJoint({ kind: 'revolute', parent: 'root', child: 'a',
        origin: [0, 0, 0], axis: [0, 0, 1], limits: { min: -180, max: 180 } });
    const j2 = addJoint({ kind: 'revolute', parent: 'a', child: 'b',
        origin: [1, 0, 0], axis: [0, 0, 1], limits: { min: -180, max: 180 } });
    const doc = getDocumentStore().doc;
    const { dofJoints } = resolveChain(doc, 'b');
    const pose = { [j1.id]: 0, [j2.id]: 0 };
    const J = computeJacobian(doc, dofJoints, pose, 'b');
    assert.equal(J.length, 6);
    assert.equal(J[0].length, 2);
});

t('Jacobian: 1-DOF revolute about Z — ∂p_y/∂θ at EE offset (1,0,0) ≈ π/180', () => {
    // End-effector component sits at local origin offset (1,0,0) from
    // the joint axis at origin. Rotating the parent joint by 1° about
    // Z moves the EE world position by ≈ π/180 in +y.
    resetDocumentStore();
    addComponent({ name: 'a', parentId: 'root', componentId: 'a' });
    const j1 = addJoint({ kind: 'revolute', parent: 'root', child: 'a',
        origin: [0, 0, 0], axis: [0, 0, 1], limits: { min: -180, max: 180 } });
    const store = getDocumentStore();
    store.doc.components.a.origin.position = [1, 0, 0];
    const { dofJoints } = resolveChain(store.doc, 'a');
    const J = computeJacobian(store.doc, dofJoints, { [j1.id]: 0 }, 'a');
    assert.ok(approxEq(J[1][0], Math.PI / 180, 1e-5),
        `J_y/J_θ = ${J[1][0]}, expected ${Math.PI / 180}`);
    assert.ok(approxEq(J[0][0], 0, 1e-5));
});

// 4. IK — 1-DOF revolute ──────────────────────────────────────────────────────
t('IK 1-DOF revolute: reach (0,1,0) starting from (1,0,0) — converges to 90°', () => {
    resetDocumentStore();
    addComponent({ name: 'a', parentId: 'root', componentId: 'a' });
    const j = addJoint({ kind: 'revolute', parent: 'root', child: 'a',
        origin: [0, 0, 0], axis: [0, 0, 1], limits: { min: -180, max: 180 } });
    const store = getDocumentStore();
    store.doc.components.a.origin.position = [1, 0, 0];
    const r = solveIK({ doc: store.doc, endEffector: 'a', target: [0, 1, 0],
                       initialPose: { [j.id]: 10 }, maxIter: 100, tol: 1e-4 });
    assert.equal(r.converged, true);
    assert.ok(r.residual < 1e-3, `residual=${r.residual}`);
    assert.ok(Math.abs(r.pose[j.id] - 90) < 0.5, `θ=${r.pose[j.id]}`);
});

// 5. IK — 2-DOF planar reachable ──────────────────────────────────────────────
t('IK 2-DOF planar: reaches reachable target (1.2, 0.3, 0) within tol', () => {
    // Two unit-length revolute links about Z. EE = end of link 2.
    resetDocumentStore();
    addComponent({ name: 'l1', parentId: 'root', componentId: 'l1' });
    addComponent({ name: 'l2', parentId: 'l1',   componentId: 'l2' });
    const j1 = addJoint({ kind: 'revolute', parent: 'root', child: 'l1',
        origin: [0, 0, 0], axis: [0, 0, 1], limits: { min: -180, max: 180 } });
    // joint at (1,0,0) in l1 frame; EE = l2 local origin → world.
    const j2 = addJoint({ kind: 'revolute', parent: 'l1', child: 'l2',
        origin: [1, 0, 0], axis: [0, 0, 1], limits: { min: -180, max: 180 } });
    // l2 local origin shift of 1 in x — give l2 an origin offset so the EE is "one further".
    const store = getDocumentStore();
    store.doc.components.l2.origin.position = [1, 0, 0];
    const r = solveIK({ doc: store.doc, endEffector: 'l2', target: [1.2, 0.3, 0],
                       initialPose: { [j1.id]: 10, [j2.id]: 10 }, maxIter: 200, tol: 1e-3 });
    assert.equal(r.converged, true, `not converged: residual=${r.residual}`);
    assert.ok(r.residual < 1e-2);
});

// 6. IK — 2-DOF planar unreachable ────────────────────────────────────────────
t('IK 2-DOF planar: UNREACHABLE target (5,5,0) reports converged=false', () => {
    resetDocumentStore();
    addComponent({ name: 'l1', parentId: 'root', componentId: 'l1' });
    addComponent({ name: 'l2', parentId: 'l1',   componentId: 'l2' });
    const j1 = addJoint({ kind: 'revolute', parent: 'root', child: 'l1',
        origin: [0, 0, 0], axis: [0, 0, 1], limits: { min: -180, max: 180 } });
    const j2 = addJoint({ kind: 'revolute', parent: 'l1', child: 'l2',
        origin: [1, 0, 0], axis: [0, 0, 1], limits: { min: -180, max: 180 } });
    const store = getDocumentStore();
    store.doc.components.l2.origin.position = [1, 0, 0];
    // Max reach = 2; target at (5,5,0) distance ≈ 7.07 — clearly unreachable.
    const r = solveIK({ doc: store.doc, endEffector: 'l2', target: [5, 5, 0],
                       initialPose: { [j1.id]: 0, [j2.id]: 0 }, maxIter: 50, tol: 1e-4 });
    assert.equal(r.converged, false);
    assert.ok(r.residual > 1, `residual too small: ${r.residual}`);
});

// 7. Joint limits ─────────────────────────────────────────────────────────────
t('IK joint-limit clamping: solver respects [-30°, 30°] cap', () => {
    resetDocumentStore();
    addComponent({ name: 'a', parentId: 'root', componentId: 'a' });
    const j = addJoint({ kind: 'revolute', parent: 'root', child: 'a',
        origin: [0, 0, 0], axis: [0, 0, 1], limits: { min: -30, max: 30 } });
    const store = getDocumentStore();
    store.doc.components.a.origin.position = [1, 0, 0];
    // Target at (0,1,0) needs 90° — out of range. Solver should clamp at 30°.
    const r = solveIK({ doc: store.doc, endEffector: 'a', target: [0, 1, 0],
                       initialPose: { [j.id]: 0 }, maxIter: 100, tol: 1e-4 });
    assert.ok(r.pose[j.id] <= 30 + 1e-6, `θ=${r.pose[j.id]} exceeds max`);
    assert.ok(r.pose[j.id] >= -30 - 1e-6);
    // And of course not converged.
    assert.equal(r.converged, false);
});

// 8. 3-DOF serial chain in 3D ─────────────────────────────────────────────────
t('IK 3-DOF (Z, Y, Z) serial chain reaches a reachable 3D target', () => {
    resetDocumentStore();
    addComponent({ name: 'a', parentId: 'root', componentId: 'a' });
    addComponent({ name: 'b', parentId: 'a',    componentId: 'b' });
    addComponent({ name: 'c', parentId: 'b',    componentId: 'c' });
    const j1 = addJoint({ kind: 'revolute', parent: 'root', child: 'a',
        origin: [0, 0, 0], axis: [0, 0, 1], limits: { min: -180, max: 180 } });
    const j2 = addJoint({ kind: 'revolute', parent: 'a', child: 'b',
        origin: [1, 0, 0], axis: [0, 1, 0], limits: { min: -180, max: 180 } });
    const j3 = addJoint({ kind: 'revolute', parent: 'b', child: 'c',
        origin: [1, 0, 0], axis: [0, 0, 1], limits: { min: -180, max: 180 } });
    const store = getDocumentStore();
    store.doc.components.c.origin.position = [1, 0, 0];
    // Target in the workspace.
    const target = [1.5, 0.5, 0.5];
    const r = solveIK({ doc: store.doc, endEffector: 'c', target,
                       initialPose: { [j1.id]: 5, [j2.id]: 5, [j3.id]: 5 },
                       maxIter: 200, tol: 1e-3, lambda: 0.05 });
    assert.equal(r.converged, true, `not converged: residual=${r.residual}`);
    assert.equal(r.dofJointIds.length, 3);
});

// 9. Damping near singularity ─────────────────────────────────────────────────
t('IK damping prevents blowup at full extension singularity', () => {
    // 2-link planar arm fully extended along +x with target slightly along +x
    // — Jacobian is rank-deficient (both link increments collinear with EE
    // motion). Without damping, J·Jᵀ is singular and inversion explodes.
    resetDocumentStore();
    addComponent({ name: 'l1', parentId: 'root', componentId: 'l1' });
    addComponent({ name: 'l2', parentId: 'l1',   componentId: 'l2' });
    const j1 = addJoint({ kind: 'revolute', parent: 'root', child: 'l1',
        origin: [0, 0, 0], axis: [0, 0, 1], limits: { min: -180, max: 180 } });
    const j2 = addJoint({ kind: 'revolute', parent: 'l1', child: 'l2',
        origin: [1, 0, 0], axis: [0, 0, 1], limits: { min: -180, max: 180 } });
    const store = getDocumentStore();
    store.doc.components.l2.origin.position = [1, 0, 0];
    // Start at the extended pose θ1=θ2=0 → EE at (2,0,0). Target (1.9, 0, 0).
    const r = solveIK({ doc: store.doc, endEffector: 'l2', target: [1.9, 0, 0],
                       initialPose: { [j1.id]: 0, [j2.id]: 0 },
                       maxIter: 100, tol: 1e-3, lambda: 0.1 });
    // Should remain finite even if convergence is poor.
    assert.ok(Number.isFinite(r.pose[j1.id]));
    assert.ok(Number.isFinite(r.pose[j2.id]));
    assert.ok(Number.isFinite(r.residual));
    // And not absurd — well under one link length.
    assert.ok(Math.abs(r.pose[j1.id]) < 200);
    assert.ok(Math.abs(r.pose[j2.id]) < 200);
});

// 10. Zero-DOF degenerate ─────────────────────────────────────────────────────
t('IK zero-DOF chain: returns initial pose, residual = target distance', () => {
    resetDocumentStore();
    addComponent({ name: 'a', parentId: 'root', componentId: 'a' });
    // No joints — direct child of root with no movable parent.
    const r = solveIK({ doc: getDocumentStore().doc, endEffector: 'a',
                       target: [3, 4, 0], initialPose: {}, maxIter: 10 });
    assert.equal(r.dofJointIds.length, 0);
    assert.equal(r.iterations, 0);
    assert.ok(approxEq(r.residual, 5, 1e-6), `residual=${r.residual}`);
});

// ── summary ──────────────────────────────────────────────────────────────────
await (async () => {
    // Ensure all queued async t() calls flushed (we wrote them sync).
})();

if (_fail > 0) {
    console.error(`\n${_fail} failure(s), ${_pass} passing`);
    process.exit(1);
} else {
    console.log(`\n${_pass} passing`);
}
