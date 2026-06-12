/**
 * Spec 18 v2 / Phase 3 — feature recognition from raw geometry.
 *
 * `recognizeRail(geometry)` decides whether a body looks like an aluminum
 * extrusion / linear rail. The signal is shape, not metadata:
 *
 *   1. The body's AABB has one clearly-dominant axis (long-axis length ≥
 *      `MIN_ELONGATION` × the next-longest extent). Cubes / brackets fail
 *      this and bail out.
 *   2. Most kernel-shipped faces have normals perpendicular to that long
 *      axis (i.e. they're the rail's running walls). Cap faces at the
 *      two ends, plus t-slot channel walls, all satisfy this.
 *   3. The cross-section bbox falls into a small catalog of known
 *      profiles (20×20, 20×40, 30×30, 40×40 mm). Unknown cross-sections
 *      get reported as `profile: 'unknown'` so downstream code can still
 *      treat them as rails (just without channel-width hints).
 *
 * Output (shape stable across versions; v1 fields marked):
 *
 *   {
 *     axis:        [nx, ny, nz],         // unit vector, world frame (v1)
 *     origin:      [x, y, z],            // midpoint of the body's long axis (v1)
 *     length:      number,               // mm along the axis (v1)
 *     profile:     '20x20'|'20x40'|'30x30'|'40x40'|'unknown',  // v1
 *     crossSection:[w, h],               // cross-section bbox in mm (v1)
 *     channelWidth: number|null,         // t-slot channel width mm (v1)
 *     score:       number,               // 0..1 — confidence (v1)
 *   }
 *
 * Returns `null` when the body doesn't look like a rail.
 *
 * The function is PURE — no DOM, no THREE, no document store access.
 * Tests in `__tests__/recognize.mjs` feed it synthetic geometry blobs.
 */

const MIN_ELONGATION = 2.5;      // long axis must be ≥ 2.5× the next extent
const PERPENDICULAR_THRESHOLD = 0.6;  // ≥60% of face normals must be ⊥ to long axis

const KNOWN_PROFILES = [
    { id: '20x20', w: 20, h: 20, channelWidth: 6.0 },
    { id: '20x40', w: 20, h: 40, channelWidth: 6.0 },
    { id: '30x30', w: 30, h: 30, channelWidth: 8.0 },
    { id: '40x40', w: 40, h: 40, channelWidth: 8.0 },
];
const PROFILE_TOL_MM = 2.0;       // allow ±2 mm slop on each cross-section side

/**
 * @param {{faces?:object}} geometry  — bridge.geometry-shaped blob
 * @param {object} [opts]
 * @param {number} [opts.minElongation]
 * @returns {object|null}  rail descriptor or null
 */
export function recognizeRail(geometry, opts = {}) {
    if (!geometry || !geometry.faces) return null;
    const minElongation = opts.minElongation || MIN_ELONGATION;

    const faces = Object.values(geometry.faces).filter(Boolean);
    if (faces.length < 4) return null;       // not enough surfaces

    const bbox = _aabbFromFaces(faces);
    if (!bbox) return null;
    const extents = [
        bbox.max[0] - bbox.min[0],
        bbox.max[1] - bbox.min[1],
        bbox.max[2] - bbox.min[2],
    ];
    // Sort axis indices by extent descending.
    const idx = [0, 1, 2].sort((a, b) => extents[b] - extents[a]);
    const longIdx = idx[0];
    const longLen = extents[longIdx];
    const secondLen = extents[idx[1]];
    if (secondLen < 1e-6) return null;
    if (longLen / secondLen < minElongation) return null;

    // Normal-direction histogram: count faces whose normal is perpendicular
    // to the long axis.
    const axisVec = [0, 0, 0]; axisVec[longIdx] = 1;
    let perpCount = 0, totalNormals = 0;
    for (const f of faces) {
        const n = Array.isArray(f.normal) ? f.normal : null;
        if (!n) continue;
        totalNormals++;
        const dot = Math.abs(n[longIdx]);
        if (dot < 0.15) perpCount++;          // |n · long| < 0.15 → roughly ⊥
    }
    if (totalNormals === 0) return null;
    const perpRatio = perpCount / totalNormals;
    if (perpRatio < PERPENDICULAR_THRESHOLD) return null;

    // Cross-section dims (the two non-long-axis extents, sorted small→large).
    const crossW = Math.min(extents[idx[1]], extents[idx[2]]);
    const crossH = Math.max(extents[idx[1]], extents[idx[2]]);
    const profile = _matchProfile(crossW, crossH);

    // Origin: midpoint of the body's long axis.
    const origin = [
        (bbox.min[0] + bbox.max[0]) * 0.5,
        (bbox.min[1] + bbox.max[1]) * 0.5,
        (bbox.min[2] + bbox.max[2]) * 0.5,
    ];

    // Score: blend of elongation strength + perpendicular-normal share +
    // profile match. Capped at 1.0.
    const elongScore = Math.min(1, (longLen / secondLen) / (minElongation * 2));
    const perpScore  = perpRatio;
    const profileScore = profile.id === 'unknown' ? 0.5 : 1.0;
    const score = Math.max(0, Math.min(1, 0.4 * elongScore + 0.3 * perpScore + 0.3 * profileScore));

    return {
        axis: axisVec,
        origin,
        length: longLen,
        profile: profile.id,
        crossSection: [crossW, crossH],
        channelWidth: profile.channelWidth,
        score,
    };
}

// ── helpers ────────────────────────────────────────────────────────────────

function _aabbFromFaces(faces) {
    let minX =  Infinity, minY =  Infinity, minZ =  Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    let any = false;
    for (const f of faces) {
        const v = f.vertices;
        if (!v || v.length < 3) continue;
        for (let i = 0; i + 2 < v.length; i += 3) {
            const x = v[i], y = v[i + 1], z = v[i + 2];
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
            if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
            any = true;
        }
    }
    if (!any) return null;
    return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

function _matchProfile(w, h) {
    for (const p of KNOWN_PROFILES) {
        const fits = (Math.abs(p.w - w) <= PROFILE_TOL_MM && Math.abs(p.h - h) <= PROFILE_TOL_MM)
                  || (Math.abs(p.w - h) <= PROFILE_TOL_MM && Math.abs(p.h - w) <= PROFILE_TOL_MM);
        if (fits) return p;
    }
    return { id: 'unknown', w, h, channelWidth: null };
}
