/**
 * AABB interference check at a pose — spec 17 v1 slice.
 *
 * v1 limitation (documented in tracker/17): we use axis-aligned bounding
 * boxes around per-component geometry as a stand-in for true OBB/triangle
 * interference. AABB tested in world frame after applying the FK
 * transforms gives meaningful self-collision signal for the common case
 * (planar/right-angle robot chains where component AABBs are reasonably
 * tight). True OBB / kernel-side triangle test is the follow-up.
 *
 * Each component's bbox lives at `component.bbox = { min:[x,y,z], max:[x,y,z] }`
 * in component-local coords. Missing → component contributes nothing and
 * is silently skipped.
 */

import { solveForwardKinematics, mat4ApplyPoint } from './solver.js';

/**
 * Transform a local AABB by a Mat4 and return the world-frame AABB
 * (axis-aligned wrap of the eight transformed corners).
 */
export function transformAABB(local, mat) {
    if (!local || !local.min || !local.max) return null;
    const [x0, y0, z0] = local.min;
    const [x1, y1, z1] = local.max;
    const corners = [
        [x0, y0, z0], [x1, y0, z0], [x0, y1, z0], [x1, y1, z0],
        [x0, y0, z1], [x1, y0, z1], [x0, y1, z1], [x1, y1, z1],
    ];
    let mnX = Infinity, mnY = Infinity, mnZ = Infinity;
    let mxX = -Infinity, mxY = -Infinity, mxZ = -Infinity;
    for (const c of corners) {
        const [tx, ty, tz] = mat4ApplyPoint(mat, c);
        if (tx < mnX) mnX = tx; if (ty < mnY) mnY = ty; if (tz < mnZ) mnZ = tz;
        if (tx > mxX) mxX = tx; if (ty > mxY) mxY = ty; if (tz > mxZ) mxZ = tz;
    }
    return { min: [mnX, mnY, mnZ], max: [mxX, mxY, mxZ] };
}

/** True if two AABBs overlap (strict, non-touching counts as overlap if EPS=0). */
export function aabbOverlap(a, b, eps = 0) {
    if (!a || !b) return false;
    return (
        a.min[0] <= b.max[0] - eps && a.max[0] >= b.min[0] + eps &&
        a.min[1] <= b.max[1] - eps && a.max[1] >= b.min[1] + eps &&
        a.min[2] <= b.max[2] - eps && a.max[2] >= b.min[2] + eps
    );
}

/**
 * Check pairwise component interference at a pose.
 *
 * Skips pairs where one is the parent (in the kinematic tree) of the other —
 * a parent joint by construction connects two components that may share an
 * AABB neighbourhood at the joint origin without representing real
 * interference.
 *
 * @param {Document} doc
 * @param {Record<string, number>} [pose]
 * @param {{ eps?: number, skipParentChild?: boolean, detailed?: boolean,
 *           componentMeshes?: Record<string, {positions:any, index?:any}> }} [opts]
 * @returns {{ ok: boolean, hits: Array<{a:string,b:string,pairs?:Array}>,
 *             pairsTested:number, fk?: any }}
 *
 * When `opts.detailed` is true AND `opts.componentMeshes` is supplied, the
 * AABB phase is treated as a broad-phase pre-filter; for every AABB hit we
 * also run the triangle-mesh interference (`interference_mesh.js`) and
 * attach the triangle-pair list to each hit entry. Pairs with no real
 * triangle overlap are pruned. When the mesh module isn't wired (no
 * meshes supplied), the function falls back silently to AABB-only.
 */
export function checkInterferenceAtPose(doc, pose = {}, opts = {}) {
    const { eps = 0, skipParentChild = true, detailed = false, componentMeshes = null } = opts || {};
    const fk = solveForwardKinematics(doc, pose);
    const components = (doc && doc.components) || {};
    const joints = (doc && doc.joints) || {};

    // Build parent-child set from joints for filtering.
    const adjacentPairs = new Set();
    for (const jid of Object.keys(joints)) {
        const j = joints[jid];
        if (!j || !j.parent || !j.child) continue;
        const key = j.parent < j.child ? `${j.parent}|${j.child}` : `${j.child}|${j.parent}`;
        adjacentPairs.add(key);
    }

    // Gather world AABBs for components that have a local bbox.
    const worldBoxes = [];
    for (const cid of Object.keys(components)) {
        const comp = components[cid];
        const local = comp && comp.bbox;
        if (!local) continue;
        const mat = fk.transforms.get(cid);
        if (!mat) continue;
        worldBoxes.push({ id: cid, box: transformAABB(local, mat) });
    }

    const hits = [];
    let pairsTested = 0;
    for (let i = 0; i < worldBoxes.length; i++) {
        for (let j = i + 1; j < worldBoxes.length; j++) {
            const a = worldBoxes[i], b = worldBoxes[j];
            if (skipParentChild) {
                const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
                if (adjacentPairs.has(key)) continue;
            }
            pairsTested++;
            if (aabbOverlap(a.box, b.box, eps)) {
                hits.push({ a: a.id, b: b.id });
            }
        }
    }

    // Detailed mode: re-run mesh interference over the AABB-positive
    // pairs. Done lazily (dynamic import) so node tests that only need
    // AABB don't pay the three.js cost.
    if (detailed && componentMeshes && hits.length > 0) {
        // Synchronous via require-style is awkward in ESM; the mesh
        // module is small and already importable from node, so the
        // caller passes us its API instead, or we resolve lazily via
        // a helper exported from interference_mesh.js. We use a
        // top-level helper attached at runtime to avoid a cyclic
        // import (interference_mesh imports from interference.js).
        if (typeof _meshDetailHook === 'function') {
            const detailedHits = [];
            for (const h of hits) {
                const detail = _meshDetailHook(h.a, h.b, fk.transforms, componentMeshes);
                if (detail && detail.pairs && detail.pairs.length > 0) {
                    detailedHits.push({ ...h, pairs: detail.pairs });
                }
            }
            return {
                ok: detailedHits.length === 0,
                hits: detailedHits,
                pairsTested,
                aabbHits: hits.length,
                fk,
            };
        }
    }

    return { ok: hits.length === 0, hits, pairsTested, fk };
}

// ── Mesh-detail hook installation ──────────────────────────────────────────
// `interference_mesh.js` calls `registerMeshDetailHook` at import time so
// `checkInterferenceAtPose({ detailed: true })` can opt in without a
// circular ESM import.
let _meshDetailHook = null;
export function registerMeshDetailHook(fn) { _meshDetailHook = fn; }
export function getMeshDetailHook() { return _meshDetailHook; }
