/**
 * Numerical Jacobian for a kinematic chain — spec 17 v3.
 *
 * Given a serial chain of joints (the path from a root component down
 * to the end-effector component) and a pose, return the 6×N Jacobian
 * that maps small joint-parameter changes to small end-effector pose
 * changes:
 *
 *     [ Δp ]      [ J_v ]
 *     [    ]  ≈   [     ] · Δq
 *     [ Δω ]      [ J_ω ]
 *
 * Rows 0..2 are linear velocity (mm per joint unit);
 * rows 3..5 are angular velocity (rad per joint unit) — for now this
 * is approximated by the finite-difference change in the rotated unit
 * x-axis projected to small-angle rotation. v1 position-only IK never
 * touches the angular rows, but they are emitted for follow-up work.
 *
 * Finite differences are central (±h) for stability. The default step
 * is 1e-4 in the joint's native unit (degrees for revolute, mm for
 * prismatic). Analytical Jacobian is a follow-up.
 */

import { solveForwardKinematics, mat4ApplyPoint } from './solver.js';

/**
 * Resolve a serial chain of joints from a root component down to an
 * end-effector component. Walks `tree.parentJoint` upward and returns
 * the list of joints in root-to-leaf order. Only revolute/prismatic
 * joints count toward the DOF list; `fixed` joints are included in
 * the chain (so FK runs correctly) but skipped when picking DOF.
 *
 * @returns {{ joints: Joint[], dofJoints: Joint[] }}
 */
export function resolveChain(doc, endEffectorId) {
    const joints = (doc && doc.joints) || {};
    const parentByChild = new Map();
    for (const j of Object.values(joints)) {
        if (!j || !j.child) continue;
        if (!parentByChild.has(j.child)) parentByChild.set(j.child, j);
    }
    const chain = [];
    let cur = endEffectorId;
    const guard = new Set();
    while (cur && parentByChild.has(cur)) {
        if (guard.has(cur)) break; // cycle safety
        guard.add(cur);
        const j = parentByChild.get(cur);
        chain.unshift(j);
        cur = j.parent;
    }
    const dofJoints = chain.filter(j => j.kind === 'revolute' || j.kind === 'prismatic');
    return { joints: chain, dofJoints };
}

/**
 * Run FK at a pose and return the end-effector position in world.
 * Uses the component's local origin (origin maps to local [0,0,0]).
 */
export function endEffectorPosition(doc, pose, endEffectorId) {
    const fk = solveForwardKinematics(doc, pose);
    const T = fk.transforms.get(endEffectorId);
    if (!T) return [0, 0, 0];
    return mat4ApplyPoint(T, [0, 0, 0]);
}

/**
 * Return the end-effector's rotated unit-x axis in world frame
 * (used as a poor-man's orientation proxy for the 3 angular rows
 * of the Jacobian).
 */
function endEffectorAxisX(doc, pose, endEffectorId) {
    const fk = solveForwardKinematics(doc, pose);
    const T = fk.transforms.get(endEffectorId);
    if (!T) return [1, 0, 0];
    const o = mat4ApplyPoint(T, [0, 0, 0]);
    const x = mat4ApplyPoint(T, [1, 0, 0]);
    return [x[0] - o[0], x[1] - o[1], x[2] - o[2]];
}

/**
 * Central-difference numerical Jacobian.
 *
 * @param {Document} doc
 * @param {Joint[]}  dofJoints   chain joints contributing a DOF.
 * @param {Record<string,number>} pose
 * @param {string}   endEffectorId
 * @param {{ h?: number, orientation?: boolean }} [opts]
 * @returns {number[][]}  6×N row-major Jacobian. Rows 0..2 = linear,
 *                       3..5 = angular proxy (zeros if !orientation).
 */
export function computeJacobian(doc, dofJoints, pose, endEffectorId, opts = {}) {
    const h = Number.isFinite(opts.h) ? opts.h : 1e-4;
    const wantOri = !!opts.orientation;
    const N = dofJoints.length;
    const J = new Array(6);
    for (let r = 0; r < 6; r++) J[r] = new Array(N).fill(0);

    for (let i = 0; i < N; i++) {
        const j = dofJoints[i];
        const q0 = pose[j.id] ?? 0;
        const poseUp = { ...pose, [j.id]: q0 + h };
        const poseDn = { ...pose, [j.id]: q0 - h };
        const pUp = endEffectorPosition(doc, poseUp, endEffectorId);
        const pDn = endEffectorPosition(doc, poseDn, endEffectorId);
        const inv2h = 1 / (2 * h);
        J[0][i] = (pUp[0] - pDn[0]) * inv2h;
        J[1][i] = (pUp[1] - pDn[1]) * inv2h;
        J[2][i] = (pUp[2] - pDn[2]) * inv2h;
        if (wantOri) {
            const aUp = endEffectorAxisX(doc, poseUp, endEffectorId);
            const aDn = endEffectorAxisX(doc, poseDn, endEffectorId);
            J[3][i] = (aUp[0] - aDn[0]) * inv2h;
            J[4][i] = (aUp[1] - aDn[1]) * inv2h;
            J[5][i] = (aUp[2] - aDn[2]) * inv2h;
        }
    }
    return J;
}
