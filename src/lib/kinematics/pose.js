/**
 * Pose timeline — spec 17 v1 slice.
 *
 * A "pose" is a named snapshot of joint parameters. The timeline lets you
 * interpolate linearly between two saved poses and run the interference
 * check at sampled intermediate steps to detect swept overlap.
 *
 * Pure data + functions; no store / Svelte coupling so the module is
 * trivially testable.
 */

import { checkInterferenceAtPose } from './interference.js';

/**
 * Create a Pose record.
 *
 * @param {string} name
 * @param {Record<string, number>} jointValues — { jointId → value }
 * @returns {{ id:string, name:string, values:Record<string,number>, createdAt:number }}
 */
export function makePose(name, jointValues = {}) {
    return {
        id: `pose_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`,
        name: String(name || 'pose'),
        values: { ...(jointValues || {}) },
        createdAt: Date.now(),
    };
}

/**
 * Linearly interpolate between two poses at parameter `t∈[0,1]`. Joints
 * present in either pose are interpolated; missing entries default to 0.
 */
export function interpolatePose(a, b, t) {
    const tt = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0));
    const out = {};
    const keys = new Set([
        ...Object.keys((a && a.values) || {}),
        ...Object.keys((b && b.values) || {}),
    ]);
    for (const k of keys) {
        const va = Number((a && a.values && a.values[k]) || 0);
        const vb = Number((b && b.values && b.values[k]) || 0);
        out[k] = va + (vb - va) * tt;
    }
    return out;
}

/**
 * Sample N+1 poses uniformly along the trajectory `a → b` (inclusive
 * endpoints) and run the interference check at each. Returns the per-
 * sample report and a top-level `ok` summary.
 *
 * @param {Document} doc
 * @param {Pose} a
 * @param {Pose} b
 * @param {{ samples?: number, eps?: number }} [opts]
 */
export function sampleTrajectory(doc, a, b, { samples = 10, eps = 0 } = {}) {
    const n = Math.max(1, Math.floor(samples));
    const steps = [];
    let anyHit = false;
    for (let i = 0; i <= n; i++) {
        const t = i / n;
        const pose = interpolatePose(a, b, t);
        const report = checkInterferenceAtPose(doc, pose, { eps });
        steps.push({ t, pose, ok: report.ok, hits: report.hits, pairsTested: report.pairsTested });
        if (!report.ok) anyHit = true;
    }
    return { ok: !anyHit, steps };
}

/**
 * Trivial pose collection — UI panels can hold a `{name → Pose}` map and
 * call this helper to play it. v1 keeps the collection out of the
 * document changelog (poses live in panel state); promoting to a stored
 * timeline is a follow-up.
 */
export class PoseLibrary {
    constructor() {
        this.poses = new Map();
    }
    add(name, jointValues) {
        const pose = makePose(name, jointValues);
        this.poses.set(pose.id, pose);
        return pose;
    }
    remove(id) { this.poses.delete(id); }
    list() { return [...this.poses.values()]; }
    get(id) { return this.poses.get(id) || null; }
}
