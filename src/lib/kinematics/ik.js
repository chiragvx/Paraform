/**
 * Inverse kinematics — Damped Least Squares (DLS) — spec 17 v3.
 *
 * Given a serial chain ending at an end-effector component and a
 * target world-space position, iteratively solve for joint parameters
 * that move the end-effector onto the target. Position-only target
 * for v1; the orientation flag is wired for follow-up work.
 *
 * Each iteration:
 *   1. Compute end-effector position at current pose.
 *   2. Build error e (3-vec, position only) = target − current.
 *   3. Build numerical Jacobian J (3×N for position-only).
 *   4. Solve Δq = Jᵀ (J Jᵀ + λ²I)⁻¹ e          (DLS pseudo-inverse).
 *   5. Step: q ← q + Δq, clamped per-joint limits.
 *   6. Stop when |e| < tol, no progress, or maxIter exhausted.
 *
 * The damping λ keeps the inversion well-conditioned at singularities
 * (full extension, axis-aligned losses of rank). A small static λ is
 * sufficient for v1 — adaptive (Levenberg-Marquardt) damping is a
 * follow-up.
 */

import { clampJointValue } from './solver.js';
import { resolveChain, computeJacobian, endEffectorPosition } from './jacobian.js';
import { transpose, multiply, multiplyVec, identity, add, scale, invert } from './linalg.js';

const DEFAULT_OPTS = {
    maxIter: 50,
    tol: 1e-4,
    lambda: 0.01,
    h: 1e-4,
    orientation: false,
};

/**
 * @param {object} args
 * @param {Document} args.doc
 * @param {string}   args.endEffector  componentId of the leaf.
 * @param {[number,number,number]} args.target  world-space target position.
 * @param {Record<string,number>} [args.initialPose]
 * @param {number} [args.maxIter]
 * @param {number} [args.tol]
 * @param {number} [args.lambda]
 * @returns {{ pose, converged, iterations, residual, dofJointIds }}
 */
export function solveIK(args) {
    const opts = { ...DEFAULT_OPTS, ...args };
    const { doc, endEffector, target } = opts;
    if (!doc || !endEffector || !Array.isArray(target)) {
        throw new Error('solveIK: requires { doc, endEffector, target:[x,y,z] }');
    }
    const { dofJoints } = resolveChain(doc, endEffector);
    if (dofJoints.length === 0) {
        const pos = endEffectorPosition(doc, args.initialPose || {}, endEffector);
        const residual = Math.hypot(target[0] - pos[0], target[1] - pos[1], target[2] - pos[2]);
        return {
            pose: { ...(args.initialPose || {}) },
            converged: residual < opts.tol,
            iterations: 0,
            residual,
            dofJointIds: [],
        };
    }

    const pose = { ...(args.initialPose || {}) };
    for (const j of dofJoints) {
        if (!(j.id in pose)) pose[j.id] = 0;
        pose[j.id] = clampJointValue(j, pose[j.id]);
    }

    const N = dofJoints.length;
    const lambdaSq = opts.lambda * opts.lambda;
    let iterations = 0;
    let residual = Infinity;
    let lastResidual = Infinity;
    let converged = false;

    for (let iter = 0; iter < opts.maxIter; iter++) {
        iterations = iter + 1;
        const cur = endEffectorPosition(doc, pose, endEffector);
        const e = [target[0] - cur[0], target[1] - cur[1], target[2] - cur[2]];
        residual = Math.hypot(e[0], e[1], e[2]);
        if (residual < opts.tol) { converged = true; break; }

        // No-progress guard — bail if we plateau (singular / unreachable).
        if (iter > 0 && Math.abs(lastResidual - residual) < opts.tol * 1e-3) {
            break;
        }
        lastResidual = residual;

        // Build 3×N position-only Jacobian.
        const J6 = computeJacobian(doc, dofJoints, pose, endEffector, { h: opts.h, orientation: false });
        const J = [J6[0], J6[1], J6[2]];
        const Jt = transpose(J);                 // N×3
        const JJt = multiply(J, Jt);              // 3×3
        const damped = add(JJt, scale(identity(3), lambdaSq));
        let inv;
        try {
            inv = invert(damped);                 // 3×3
        } catch {
            // Pathological singularity even with damping — bump λ for this step.
            const bumped = add(JJt, scale(identity(3), lambdaSq * 100 + 1e-6));
            inv = invert(bumped);
        }
        const tmp = multiplyVec(inv, e);          // 3
        const dq = multiplyVec(Jt, tmp);          // N

        // Adaptive step shrinkage: if the full step explodes the residual,
        // halve it a few times. Stops singular blowup near full extension.
        let alpha = 1;
        let accepted = false;
        for (let tries = 0; tries < 5; tries++) {
            const trial = { ...pose };
            for (let i = 0; i < N; i++) {
                const j = dofJoints[i];
                trial[j.id] = clampJointValue(j, (pose[j.id] ?? 0) + alpha * dq[i]);
            }
            const np = endEffectorPosition(doc, trial, endEffector);
            const nRes = Math.hypot(target[0] - np[0], target[1] - np[1], target[2] - np[2]);
            if (nRes <= residual * 1.001) {
                for (const j of dofJoints) pose[j.id] = trial[j.id];
                residual = nRes;
                accepted = true;
                break;
            }
            alpha *= 0.5;
        }
        if (!accepted) {
            // Couldn't improve — stuck (likely unreachable). Exit.
            break;
        }
        if (residual < opts.tol) { converged = true; break; }
    }

    return {
        pose,
        converged,
        iterations,
        residual,
        dofJointIds: dofJoints.map(j => j.id),
    };
}
