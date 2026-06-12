/**
 * Face picker — given a raycast hit on the v4 body group, resolve the closest
 * face in the kernel's topology output and return its descriptor.
 *
 * Two layers:
 *
 *   pickNearestFace(localPoint, hitNormal, topology, [opts])
 *     Pure-math. Iterates every face entry across every body in the
 *     topology, scoring by `distance + α · (1 − normal·hit)` and returning
 *     the best match. No DOM, no Three.js — testable in isolation.
 *
 *   pickFaceFromCursor({ camera, raycaster, ndc, bodyGroup, topology })
 *     Thin Three.js wrapper around the raycaster. Casts a ray from the
 *     camera through the cursor NDC, hits the bodyGroup recursively, then
 *     hands the local-frame hit point + normal to pickNearestFace.
 *
 * The topology shape is the v4 emitter's `_extract_topology_v4` output:
 *   { nodes: [{ featureId, faces: [{ descriptor, centerRounded,
 *               normalRounded, area, surfaceType }], edges: [...] }] }
 *
 * Returns shape:
 *   {
 *     descriptor: { kind, feature, opTag, part, parents },
 *     featureId:  string,
 *     center:     [x, y, z],   // local-frame center from the kernel
 *     normal:     [nx, ny, nz],
 *     distance:   number,      // distance from hit to face center
 *     score:      number,      // composite score (lower = better)
 *   } | null
 */

/** @typedef {{ kind: string, feature: string, opTag: string, part: string, parents?: any[] }} Descriptor */
/** @typedef {{ descriptor: Descriptor, centerRounded: number[], normalRounded: number[], area?: number, surfaceType?: string }} FaceEntry */
/** @typedef {{ nodes: Array<{ featureId: string, faces: FaceEntry[], edges: any[] }> }} Topology */

// Default scoring weight: how much a normal-misalignment "costs" relative
// to physical distance. Higher = preferring faces whose normal aligns with
// the click direction even at the cost of a bit more distance.
const DEFAULT_NORMAL_WEIGHT = 5.0;

// Faces whose normal points away from the click (back-faces) are skipped
// unless every face fails the test — then we fall back to the best one.
const BACKFACE_DOT_CUTOFF = -0.05;

/**
 * Find the face from `topology` whose `centerRounded` is closest to
 * `localPoint`, with a soft bonus for facing the same direction as
 * `hitNormal`. Returns `null` if the topology has no faces.
 *
 * @param {[number, number, number]} localPoint   Point in the body group's local frame.
 * @param {[number, number, number]} hitNormal    Surface normal at the hit (local frame).
 * @param {Topology} topology
 * @param {object} [opts]
 * @param {number} [opts.normalWeight]  How much a misaligned normal costs (default 5.0).
 * @param {number} [opts.maxDistance]   Reject faces farther than this from the hit.
 */
export function pickNearestFace(localPoint, hitNormal, topology, opts = {}) {
    if (!topology || !Array.isArray(topology.nodes)) return null;
    const normalWeight = opts.normalWeight ?? DEFAULT_NORMAL_WEIGHT;
    const maxDist      = opts.maxDistance ?? Infinity;
    const hitN         = normalize3(hitNormal);

    let best       = null;
    let bestScore  = Infinity;
    let backfaceBest = null;
    let backfaceScore = Infinity;

    for (const node of topology.nodes) {
        // The kernel emits one of two shapes depending on the doc version:
        //   - v4 (Phase 1B): node.faces is the face list, with `centerRounded`
        //     + `normalRounded` + `descriptor`.
        //   - v3 (legacy):   node.bodies[0].faces with `center` + `normal`
        //     (no descriptor, no rounded suffix).
        // We accept both shapes so the picker keeps working across the v3→v4
        // transition while the kernel is gradually upgraded.
        const faces = node.faces ?? node.bodies?.[0]?.faces ?? [];
        const nodeId = node.featureId || node.nodeId || null;
        for (const face of faces) {
            const c = face.centerRounded || face.center;
            const n = face.normalRounded || face.normal;
            if (!Array.isArray(c) || c.length < 3) continue;
            const d = dist3(localPoint, c);
            if (d > maxDist) continue;
            const nUnit = Array.isArray(n) ? normalize3(n) : [0, 0, 1];
            const dotN = dot3(nUnit, hitN);
            // Normal-misalignment penalty: 0 when perfectly aligned, up to
            // 2 * normalWeight when anti-aligned.
            const penalty = normalWeight * (1 - dotN);
            const score = d + penalty;

            const entry = {
                descriptor: face.descriptor || null,
                featureId:  nodeId,
                center:     c.slice(),
                normal:     nUnit,
                distance:   d,
                score,
            };

            if (dotN < BACKFACE_DOT_CUTOFF) {
                // Back-face — only keep as a fallback
                if (score < backfaceScore) { backfaceBest = entry; backfaceScore = score; }
                continue;
            }
            if (score < bestScore) { best = entry; bestScore = score; }
        }
    }
    return best || backfaceBest || null;
}

/**
 * Cast a ray from `camera` through NDC `ndc` (`{x, y}` ∈ [-1, 1]²), find
 * the first intersection with `bodyGroup` recursively, then resolve the
 * closest face in `topology`. `raycaster` is reused across calls to avoid
 * GC churn.
 *
 * Required Three.js types:
 *   - camera: THREE.Camera
 *   - raycaster: THREE.Raycaster
 *   - bodyGroup: THREE.Object3D (the v4 body wrapper attached to the scene)
 *
 * @param {object} args
 * @param {object} args.camera
 * @param {object} args.raycaster
 * @param {{x:number, y:number}} args.ndc
 * @param {object} args.bodyGroup
 * @param {Topology} args.topology
 * @param {object} [args.opts]
 */
export function pickFaceFromCursor({ camera, raycaster, ndc, bodyGroup, topology, opts = {} }) {
    if (!camera || !raycaster || !bodyGroup || !topology) return null;

    raycaster.setFromCamera({ x: ndc.x, y: ndc.y }, camera);
    const hits = raycaster.intersectObject(bodyGroup, true);
    if (!hits || !hits.length) return null;
    const hit = hits[0];
    if (!hit || !hit.point) return null;

    const worldHit = [hit.point.x, hit.point.y, hit.point.z];

    let worldNormal = [0, 0, 1];
    if (hit.face && hit.face.normal && hit.object) {
        const n = [hit.face.normal.x, hit.face.normal.y, hit.face.normal.z];
        // Rotate the triangle's local normal up through the hit object's
        // world transform (rotation-only — translation doesn't apply to
        // direction vectors).
        const objRot = matrix4ToArray(hit.object.matrixWorld, { rotationOnly: true });
        worldNormal = normalize3(applyMat4Direction(objRot, n));
    }

    // The kernel emits topology in build123d's native frame (mm, Z-up).
    // The bridge wraps the GLB in a group whose `matrixWorld` carries the
    // rotation needed to undo glTF's Y-up export plus a uniform mm-as-mm
    // scale. Use that exact rotation to project topology centres into the
    // same world frame the raycaster reports — no dual-frame guessing.
    const xform = bodyToWorldXform(bodyGroup);
    const match = pickNearestFaceXform(worldHit, worldNormal, topology, xform, opts);
    if (!match) return null;
    return {
        ...match,
        worldHit,
    };
}

// Identity transform kept for the pure-math tests that call
// `pickNearestFace` / `pickNearestEdge` with no body group.
const IDENTITY_XFORM = { point: (v) => v.slice(), direction: (v) => v.slice() };
// FLIP_YZ used to be one of two guessed candidates; preserved only as a
// constant for legacy callers (no production code path uses it any more).
const FLIP_YZ_XFORM = {
    point:     (v) => [v[0], -v[1], -v[2]],
    direction: (v) => [v[0], -v[1], -v[2]],
};

/**
 * Build the transform that maps a build123d-frame (topology) vector into
 * the world frame the raycaster reports. Extracts just the rotation part
 * of `bodyGroup.matrixWorld` — the translation is absorbed by the matching
 * (both the world hit and the rotated centre are anchored at the body)
 * and the uniform mm-as-mm scale is invariant under the comparison since
 * topology centres are already in build123d millimetres (build123d's
 * glTF export ships mm-as-meters, exactly cancelled by the bridge wrap's
 * ×1000 scale, leaving rotation as the only delta).
 *
 * Falls through to the identity transform when `bodyGroup` has no matrix
 * (bare THREE.Group in tests, or undefined).
 */
function bodyToWorldXform(bodyGroup) {
    const elems = bodyGroup && bodyGroup.matrixWorld && bodyGroup.matrixWorld.elements;
    if (!elems) return IDENTITY_XFORM;
    // Extract column-major rotation columns and normalise to discard scale.
    const c0x = elems[0],  c0y = elems[1],  c0z = elems[2];
    const c1x = elems[4],  c1y = elems[5],  c1z = elems[6];
    const c2x = elems[8],  c2y = elems[9],  c2z = elems[10];
    const sx = Math.hypot(c0x, c0y, c0z) || 1;
    const sy = Math.hypot(c1x, c1y, c1z) || 1;
    const sz = Math.hypot(c2x, c2y, c2z) || 1;
    const r00 = c0x / sx, r10 = c0y / sx, r20 = c0z / sx;
    const r01 = c1x / sy, r11 = c1y / sy, r21 = c1z / sy;
    const r02 = c2x / sz, r12 = c2y / sz, r22 = c2z / sz;
    const apply = (v) => [
        r00 * v[0] + r01 * v[1] + r02 * v[2],
        r10 * v[0] + r11 * v[1] + r12 * v[2],
        r20 * v[0] + r21 * v[1] + r22 * v[2],
    ];
    return { point: apply, direction: apply };
}

// ── Edge picking ────────────────────────────────────────────────────────────

/**
 * Find the edge from `topology` whose midpoint is closest to `worldHit`.
 *
 * Edges don't have a single normal — a face has one, but an edge sits
 * between two. We score by raw distance and apply the same dual-frame
 * matching the face picker uses, so picks survive the bridge's
 * world↔build123d transform without coordinate drift.
 *
 * Returns null if the topology has no edges. Returned shape mirrors
 * pickFaceFromCursor:
 *
 *   { descriptor, featureId, center, tangent, distance, score, worldHit }
 *
 * @param {object} args
 * @param {object} args.camera
 * @param {object} args.raycaster
 * @param {{x:number, y:number}} args.ndc
 * @param {object} args.bodyGroup
 * @param {Topology} args.topology
 */
export function pickEdgeFromCursor({ camera, raycaster, ndc, bodyGroup, topology, opts = {} }) {
    if (!camera || !raycaster || !bodyGroup || !topology) return null;

    raycaster.setFromCamera({ x: ndc.x, y: ndc.y }, camera);
    const hits = raycaster.intersectObject(bodyGroup, true);
    if (!hits || !hits.length) return null;
    const hit = hits[0];
    if (!hit || !hit.point) return null;

    const worldHit = [hit.point.x, hit.point.y, hit.point.z];

    const xform = bodyToWorldXform(bodyGroup);
    const match = pickNearestEdgeXform(worldHit, topology, xform, opts);
    if (!match) return null;
    return { ...match, worldHit };
}

function closerOfEdge(a, b) {
    if (!a) return b;
    if (!b) return a;
    return a.distance <= b.distance ? a : b;
}

/**
 * Pure-math edge lookup. Iterates `node.edges` across the topology and
 * returns the closest one to `worldHit` under `xform`. Accepts both v3
 * (`node.bodies[0].edges`) and v4 (`node.edges`) shapes.
 */
function pickNearestEdgeXform(worldHit, topology, xform, opts = {}) {
    if (!topology || !Array.isArray(topology.nodes)) return null;
    const maxDist = opts.maxDistance ?? Infinity;

    let best = null;
    let bestDist = Infinity;

    for (const node of topology.nodes) {
        const edges  = node.edges ?? node.bodies?.[0]?.edges ?? [];
        const nodeId = node.featureId || node.nodeId || null;
        for (const edge of edges) {
            const c = edge.centerRounded || edge.center;
            if (!Array.isArray(c) || c.length < 3) continue;
            const wc = xform.point(c);
            const d  = dist3(worldHit, wc);
            if (d > maxDist) continue;
            if (d < bestDist) {
                const t = edge.tangentRounded || edge.tangent;
                const wt = Array.isArray(t) ? normalize3(xform.direction(t)) : [0, 0, 1];
                bestDist = d;
                best = {
                    descriptor: edge.descriptor || null,
                    featureId:  nodeId,
                    center:     wc,
                    tangent:    wt,
                    distance:   d,
                    score:      d,
                };
            }
        }
    }
    return best;
}

/**
 * Pure-math version exposed for tests — same shape as `pickNearestFace`.
 */
export function pickNearestEdge(localPoint, topology, opts = {}) {
    return pickNearestEdgeXform(localPoint, topology, IDENTITY_XFORM, opts);
}

function closerOf(a, b) {
    if (!a) return b;
    if (!b) return a;
    return a.score <= b.score ? a : b;
}

/**
 * Same shape as `pickNearestFace`, but applies `xform` to every topology
 * centre + normal before comparing. Lets us try multiple candidate frame
 * mappings without duplicating the iteration logic.
 */
function pickNearestFaceXform(worldHit, worldNormalHit, topology, xform, opts = {}) {
    if (!topology || !Array.isArray(topology.nodes)) return null;
    const normalWeight = opts.normalWeight ?? DEFAULT_NORMAL_WEIGHT;
    const maxDist      = opts.maxDistance ?? Infinity;

    let best = null,         bestScore = Infinity;
    let backfaceBest = null, backfaceScore = Infinity;

    for (const node of topology.nodes) {
        const faces  = node.faces ?? node.bodies?.[0]?.faces ?? [];
        const nodeId = node.featureId || node.nodeId || null;
        for (const face of faces) {
            const c = face.centerRounded || face.center;
            const n = face.normalRounded || face.normal;
            if (!Array.isArray(c) || c.length < 3) continue;

            const wc = xform.point(c);
            const wn = Array.isArray(n) ? normalize3(xform.direction(n)) : [0, 0, 1];

            const d = dist3(worldHit, wc);
            if (d > maxDist) continue;
            const dotN = dot3(wn, worldNormalHit);
            const penalty = normalWeight * (1 - dotN);
            const score   = d + penalty;
            const entry   = {
                descriptor: face.descriptor || null,
                featureId:  nodeId,
                center:     wc,
                normal:     wn,
                distance:   d,
                score,
            };
            if (dotN < BACKFACE_DOT_CUTOFF) {
                if (score < backfaceScore) { backfaceBest = entry; backfaceScore = score; }
                continue;
            }
            if (score < bestScore) { best = entry; bestScore = score; }
        }
    }
    return best || backfaceBest || null;
}

// ── Vec helpers ────────────────────────────────────────────────────────────

function dist3(a, b) {
    const dx = a[0] - b[0];
    const dy = a[1] - b[1];
    const dz = a[2] - b[2];
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function dot3(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

function normalize3(v) {
    const m = Math.hypot(v[0], v[1], v[2]);
    if (m < 1e-12) return [0, 0, 0];
    return [v[0] / m, v[1] / m, v[2] / m];
}

// ── Matrix helpers (column-major, matches Three.js layout) ─────────────────

function matrix4ToArray(matrixLike, { invert = false, rotationOnly = false } = {}) {
    const e = (matrixLike && matrixLike.elements) || IDENTITY16;
    let m = e.slice(0, 16);
    if (invert) m = invertMat4(m);
    if (rotationOnly) {
        m[12] = 0; m[13] = 0; m[14] = 0;
    }
    return m;
}

/** Treat `m` as a 4×4 column-major matrix; apply to a 3-vector as a point. */
function applyMat4(m, v) {
    const [x, y, z] = v;
    return [
        m[0] * x + m[4] * y + m[8]  * z + m[12],
        m[1] * x + m[5] * y + m[9]  * z + m[13],
        m[2] * x + m[6] * y + m[10] * z + m[14],
    ];
}

/** Same shape but treats v as a direction (ignores translation column). */
function applyMat4Direction(m, v) {
    const [x, y, z] = v;
    return [
        m[0] * x + m[4] * y + m[8]  * z,
        m[1] * x + m[5] * y + m[9]  * z,
        m[2] * x + m[6] * y + m[10] * z,
    ];
}

/** 4×4 column-major matrix invert. Translated from gl-matrix. */
function invertMat4(m) {
    const a00 = m[0],  a01 = m[1],  a02 = m[2],  a03 = m[3];
    const a10 = m[4],  a11 = m[5],  a12 = m[6],  a13 = m[7];
    const a20 = m[8],  a21 = m[9],  a22 = m[10], a23 = m[11];
    const a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];

    const b00 = a00 * a11 - a01 * a10;
    const b01 = a00 * a12 - a02 * a10;
    const b02 = a00 * a13 - a03 * a10;
    const b03 = a01 * a12 - a02 * a11;
    const b04 = a01 * a13 - a03 * a11;
    const b05 = a02 * a13 - a03 * a12;
    const b06 = a20 * a31 - a21 * a30;
    const b07 = a20 * a32 - a22 * a30;
    const b08 = a20 * a33 - a23 * a30;
    const b09 = a21 * a32 - a22 * a31;
    const b10 = a21 * a33 - a23 * a31;
    const b11 = a22 * a33 - a23 * a32;

    let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if (!det) return IDENTITY16.slice();
    det = 1 / det;

    return [
        (a11 * b11 - a12 * b10 + a13 * b09) * det,
        (a02 * b10 - a01 * b11 - a03 * b09) * det,
        (a31 * b05 - a32 * b04 + a33 * b03) * det,
        (a22 * b04 - a21 * b05 - a23 * b03) * det,
        (a12 * b08 - a10 * b11 - a13 * b07) * det,
        (a00 * b11 - a02 * b08 + a03 * b07) * det,
        (a32 * b02 - a30 * b05 - a33 * b01) * det,
        (a20 * b05 - a22 * b02 + a23 * b01) * det,
        (a10 * b10 - a11 * b08 + a13 * b06) * det,
        (a01 * b08 - a00 * b10 - a03 * b06) * det,
        (a30 * b04 - a31 * b02 + a33 * b00) * det,
        (a21 * b02 - a20 * b04 - a23 * b00) * det,
        (a11 * b07 - a10 * b09 - a12 * b06) * det,
        (a00 * b09 - a01 * b07 + a02 * b06) * det,
        (a31 * b01 - a30 * b03 - a32 * b00) * det,
        (a20 * b03 - a21 * b01 + a22 * b00) * det,
    ];
}

const IDENTITY16 = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
