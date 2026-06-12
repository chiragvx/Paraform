/**
 * Spec 17 v2 — true triangle-mesh interference.
 *
 * v1 in `interference.js` used per-component AABBs as a stand-in for true
 * geometric overlap. v2 adds the next layer up: build a triangle BVH per
 * component (via `three-mesh-bvh`) and run pairwise mesh-against-mesh
 * triangle intersection. Returns the *list of intersecting triangle
 * pairs* with worldspace centroids — enough to drive the contact-region
 * overlay in the viewport. CSG (boolean intersection body) is a separate
 * follow-up; we deliberately stop short of that.
 *
 * Coordinate convention: triangle positions in `componentMeshes` are
 * component-local (mm, Z-up). World transforms come from FK
 * (`solveForwardKinematics`) — exactly the same 4×4 row-major Float64Array
 * matrices the AABB path consumes.
 *
 * Shape of `componentMeshes` (caller-supplied):
 *
 *   {
 *     [componentId]: {
 *       // flat triangle list — three vertices per triangle, length % 9 === 0
 *       positions: Float32Array | number[],
 *       // optional index buffer; if absent, vertices are non-indexed
 *       index?: Uint32Array | number[],
 *     }
 *   }
 *
 * This matches what the kernel's per-face geometry produces after
 * concatenation — see `bridge.geometry` in [lib/document/bridge.js].
 *
 * Public API:
 *   - `buildComponentBVH(componentMeshes)` → Map<id, { geometry, bvh }>
 *     (cached: pass the same object back in to skip rebuilds)
 *   - `findIntersectingTriangles(entryA, entryB, transformA, transformB, opts?)`
 *     → { pairs: [...], aabbOverlap: boolean }
 *   - `aabbOverlap` is re-exported from `./interference.js`.
 *   - `mat4ToThreeMatrix(mat4Float64Array)` — helper for callers wiring
 *     into three.js scene graphs.
 *
 * Pure ESM. Imports three.js + three-mesh-bvh at module top level; both
 * load cleanly under node (verified — used by tests).
 */

import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { aabbOverlap, transformAABB, registerMeshDetailHook } from './interference.js';

export { aabbOverlap };

// Wire detailed mode into checkInterferenceAtPose. Caching is keyed by
// the componentMeshes object, so repeated calls reuse BVHs.
registerMeshDetailHook((aId, bId, fkTransforms, componentMeshes) => {
    const bvhMap = buildComponentBVH(componentMeshes);
    const entryA = bvhMap.get(aId);
    const entryB = bvhMap.get(bId);
    if (!entryA || !entryB) return { pairs: [] };
    const tA = fkTransforms.get(aId);
    const tB = fkTransforms.get(bId);
    if (!tA || !tB) return { pairs: [] };
    return findIntersectingTriangles(entryA, entryB, tA, tB);
});

// Per-build cache, keyed by the *componentMeshes* object identity. Caller
// can pass the same object across many pose evaluations without
// rebuilding the BVH per call.
const _bvhCache = new WeakMap();

/**
 * Convert a row-major Float64Array(16) Mat4 into a THREE.Matrix4.
 * Our solver stores `m[r*4+c]`; three.js stores column-major in `.elements`.
 */
export function mat4ToThreeMatrix(m) {
    const out = new THREE.Matrix4();
    // row-major (r,c) → column-major elements[c*4+r]
    const e = out.elements;
    for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 4; c++) {
            e[c * 4 + r] = m[r * 4 + c];
        }
    }
    return out;
}

/**
 * Build a triangle BVH per component. Returns a Map<id, { geometry, bvh,
 * triangleCount, localBox }>. Geometry is a THREE.BufferGeometry that
 * owns the position attribute; BVH is the `three-mesh-bvh` MeshBVH.
 *
 * Cached against the componentMeshes object — reusing the same object on
 * subsequent calls returns the cached map without rebuilding.
 *
 * Missing / empty / malformed entries are silently skipped (consistent
 * with the AABB path).
 */
export function buildComponentBVH(componentMeshes) {
    if (!componentMeshes) return new Map();
    const cached = _bvhCache.get(componentMeshes);
    if (cached) return cached;

    const out = new Map();
    for (const id of Object.keys(componentMeshes)) {
        const src = componentMeshes[id];
        if (!src || !src.positions) continue;
        const positions = src.positions instanceof Float32Array
            ? src.positions
            : new Float32Array(src.positions);
        if (positions.length < 9) continue;
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        if (src.index) {
            const idx = src.index instanceof Uint32Array
                ? src.index
                : new Uint32Array(src.index);
            geo.setIndex(new THREE.BufferAttribute(idx, 1));
        }
        let bvh;
        try {
            bvh = new MeshBVH(geo);
        } catch (e) {
            // Degenerate geometry — skip
            continue;
        }
        geo.boundsTree = bvh;
        // Local-frame AABB for fast broad-phase against transformed boxes.
        geo.computeBoundingBox();
        const bb = geo.boundingBox;
        const localBox = bb ? {
            min: [bb.min.x, bb.min.y, bb.min.z],
            max: [bb.max.x, bb.max.y, bb.max.z],
        } : null;
        const triCount = geo.index
            ? geo.index.count / 3
            : positions.length / 9;
        out.set(id, { geometry: geo, bvh, triangleCount: triCount, localBox });
    }
    _bvhCache.set(componentMeshes, out);
    return out;
}

/**
 * Read triangle `i` of a geometry into the three Vector3 outs.
 */
function readTriangle(geo, i, vA, vB, vC) {
    const pos = geo.getAttribute('position');
    if (geo.index) {
        const idx = geo.index;
        const a = idx.getX(i * 3 + 0);
        const b = idx.getX(i * 3 + 1);
        const c = idx.getX(i * 3 + 2);
        vA.fromBufferAttribute(pos, a);
        vB.fromBufferAttribute(pos, b);
        vC.fromBufferAttribute(pos, c);
    } else {
        vA.fromBufferAttribute(pos, i * 3 + 0);
        vB.fromBufferAttribute(pos, i * 3 + 1);
        vC.fromBufferAttribute(pos, i * 3 + 2);
    }
}

/**
 * Find all triangle pairs (triA, triB) where the world-space triangles
 * intersect.
 *
 * @param {{geometry, bvh, localBox}} entryA  from buildComponentBVH
 * @param {{geometry, bvh, localBox}} entryB
 * @param {Float64Array|number[]} transformA  4×4 row-major (FK output)
 * @param {Float64Array|number[]} transformB
 * @param {{ maxPairs?: number }} [opts]
 * @returns {{ pairs: Array<{
 *     triA: number, triB: number,
 *     centroidA: [number,number,number],
 *     centroidB: [number,number,number],
 *     contact: [number,number,number],
 * }>, aabbOverlap: boolean }}
 */
export function findIntersectingTriangles(entryA, entryB, transformA, transformB, opts = {}) {
    const { maxPairs = 5000 } = opts;
    if (!entryA || !entryB) return { pairs: [], aabbOverlap: false };

    // Broad phase — transformed AABB overlap. If the AABBs don't even
    // touch, the BVH walk is pure overhead.
    const worldA = entryA.localBox ? transformAABB(entryA.localBox, transformA) : null;
    const worldB = entryB.localBox ? transformAABB(entryB.localBox, transformB) : null;
    const overlap = worldA && worldB ? aabbOverlap(worldA, worldB) : true;
    if (!overlap) return { pairs: [], aabbOverlap: false };

    // BVH against BVH — three-mesh-bvh's bvhcast walks B's BVH using A's
    // matrix. We feed it the relative matrix `Tab = A⁻¹ · B` so all of
    // B's triangles arrive expressed in A's local frame, where A's BVH
    // can intersect them.
    const matA = mat4ToThreeMatrix(transformA);
    const matB = mat4ToThreeMatrix(transformB);
    const matAInv = new THREE.Matrix4().copy(matA).invert();
    const relMat = new THREE.Matrix4().multiplyMatrices(matAInv, matB);

    const pairs = [];
    const vA0 = new THREE.Vector3(), vA1 = new THREE.Vector3(), vA2 = new THREE.Vector3();
    const vB0 = new THREE.Vector3(), vB1 = new THREE.Vector3(), vB2 = new THREE.Vector3();

    // bvhcast: walk A's BVH against B's BVH. `relMat` is B → A.
    entryA.bvh.bvhcast(entryB.bvh, relMat, {
        intersectsTriangles(triangleA, triangleB, iA, iB) {
            if (pairs.length >= maxPairs) return true; // abort
            if (!triangleA.intersectsTriangle(triangleB)) return false;

            // Pull the original local-frame triangles to compute
            // worldspace centroids (the callback's triangleA/triangleB
            // are in A's frame).
            readTriangle(entryA.geometry, iA, vA0, vA1, vA2);
            readTriangle(entryB.geometry, iB, vB0, vB1, vB2);
            const cA = vA0.clone().add(vA1).add(vA2).multiplyScalar(1 / 3).applyMatrix4(matA);
            const cB = vB0.clone().add(vB1).add(vB2).multiplyScalar(1 / 3).applyMatrix4(matB);
            pairs.push({
                triA: iA,
                triB: iB,
                centroidA: [cA.x, cA.y, cA.z],
                centroidB: [cB.x, cB.y, cB.z],
                contact: [(cA.x + cB.x) / 2, (cA.y + cB.y) / 2, (cA.z + cB.z) / 2],
            });
            return false; // keep walking
        },
    });

    return { pairs, aabbOverlap: true };
}

/**
 * Convenience: per-pose pairwise mesh interference across a document.
 * Mirrors `checkInterferenceAtPose` but in mesh-detail mode. Caller
 * supplies the per-component triangle data; we build/reuse BVHs and run
 * the FK once.
 */
export function checkMeshInterferenceAtPose(doc, componentMeshes, fkTransforms, opts = {}) {
    const { skipParentChild = true, maxPairs = 5000 } = opts;
    const bvhMap = buildComponentBVH(componentMeshes);
    const ids = Array.from(bvhMap.keys());
    const joints = (doc && doc.joints) || {};
    const adjacent = new Set();
    for (const jid of Object.keys(joints)) {
        const j = joints[jid];
        if (!j || !j.parent || !j.child) continue;
        const key = j.parent < j.child ? `${j.parent}|${j.child}` : `${j.child}|${j.parent}`;
        adjacent.add(key);
    }
    const hits = [];
    let pairsTested = 0;
    for (let i = 0; i < ids.length; i++) {
        for (let k = i + 1; k < ids.length; k++) {
            const a = ids[i], b = ids[k];
            if (skipParentChild) {
                const key = a < b ? `${a}|${b}` : `${b}|${a}`;
                if (adjacent.has(key)) continue;
            }
            const tA = fkTransforms.get(a);
            const tB = fkTransforms.get(b);
            if (!tA || !tB) continue;
            pairsTested++;
            const res = findIntersectingTriangles(
                bvhMap.get(a), bvhMap.get(b), tA, tB, { maxPairs },
            );
            if (res.pairs.length > 0) {
                hits.push({ a, b, pairs: res.pairs });
            }
        }
    }
    return { ok: hits.length === 0, hits, pairsTested };
}
