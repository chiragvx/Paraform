/**
 * Plane math — convert a SketchData planeRef into a world-space basis and
 * round-trip points between plane-local (2D) and world (3D) coordinates.
 *
 * No Three.js dependency — pure math. Callers pass in any vec-like and we
 * read .x/.y/.z (or [0]/[1]/[2]) defensively.
 *
 * A SketchPlane is described by:
 *   origin  Vec3      where (0, 0) of the sketch lives in world space
 *   xAxis   Vec3      unit vector along the sketch's +X
 *   yAxis   Vec3      unit vector along the sketch's +Y
 *   normal  Vec3      xAxis × yAxis
 *
 * The standard stock planes:
 *   XY → origin (0,0,0), xAxis (1,0,0), yAxis (0,1,0), normal (0,0,1)
 *   XZ → origin (0,0,0), xAxis (1,0,0), yAxis (0,0,1), normal (0,-1,0)
 *   YZ → origin (0,0,0), xAxis (0,1,0), yAxis (0,0,1), normal (1,0,0)
 *
 * Face- and construction-plane refs are placeholders here — for v1 they
 * fall back to XY. The Phase 1B descriptor → world-plane resolver lands
 * later (kernel-side, queried at sketch-edit time).
 */

const STOCK_PLANES = Object.freeze({
    XY: {
        origin: [0, 0, 0],
        xAxis:  [1, 0, 0],
        yAxis:  [0, 1, 0],
        normal: [0, 0, 1],
    },
    XZ: {
        origin: [0, 0, 0],
        xAxis:  [1, 0, 0],
        yAxis:  [0, 0, 1],
        normal: [0, -1, 0],
    },
    YZ: {
        origin: [0, 0, 0],
        xAxis:  [0, 1, 0],
        yAxis:  [0, 0, 1],
        normal: [1, 0, 0],
    },
});

/**
 * Resolve a SketchData.planeRef to a usable world-space basis.
 *
 * @param {object} planeRef — { kind: 'stock'|'construction'|'face', ... }
 * @returns {{origin:[number,number,number], xAxis:[number,number,number], yAxis:[number,number,number], normal:[number,number,number]}}
 */
export function resolvePlane(planeRef) {
    if (!planeRef || planeRef.kind === 'stock') {
        const name = (planeRef && planeRef.name) || 'XY';
        return STOCK_PLANES[name] || STOCK_PLANES.XY;
    }
    if (planeRef.kind === 'face' && Array.isArray(planeRef.origin) && Array.isArray(planeRef.normal)) {
        // Build a right-handed basis with `normal` as +Z and a stable
        // in-plane `xAxis`. The picker cached origin + normal at click
        // time; we use those directly so the editor opens immediately.
        return faceBasis(planeRef.origin, planeRef.normal);
    }
    // TODO Phase 1B: descriptor-based resolution against the kernel topology
    // when no cache is available. For now we fall back to XY so the editor
    // still opens rather than crashing.
    return STOCK_PLANES.XY;
}

/** Build a sketch-plane basis from a world-space origin + normal. */
function faceBasis(origin, normal) {
    const n = normalize(vec(normal));
    // Pick the world axis least aligned with `n` as a seed for x.
    const seed = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    const x = normalize(cross(seed, n));   // in-plane, perpendicular to n
    const y = normalize(cross(n, x));      // completes the right-handed basis
    return {
        origin: vec(origin),
        xAxis:  x,
        yAxis:  y,
        normal: n,
    };
}

// ── Vec helpers (defensive on input shape) ──────────────────────────────────

function vec(v) {
    if (!v) return [0, 0, 0];
    if (Array.isArray(v)) return [+v[0] || 0, +v[1] || 0, +v[2] || 0];
    return [+v.x || 0, +v.y || 0, +v.z || 0];
}

function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function scale(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross(a, b) {
    return [a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0]];
}
function length(a) { return Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]); }
function normalize(a) {
    const n = length(a) || 1;
    return [a[0] / n, a[1] / n, a[2] / n];
}

export const VEC = { vec, add, sub, scale, dot, cross, length, normalize };

// ── 2D ↔ 3D coordinate transforms ───────────────────────────────────────────

/**
 * Convert a sketch-local 2D point (u, v) to a world 3D point.
 * world = origin + u * xAxis + v * yAxis
 *
 * @param {{x:number,y:number}|[number,number]} pt2
 * @param {object} plane — resolved via resolvePlane
 * @returns {[number, number, number]}
 */
export function localToWorld(pt2, plane) {
    const u = Array.isArray(pt2) ? +pt2[0] : +pt2.x;
    const v = Array.isArray(pt2) ? +pt2[1] : +pt2.y;
    const ox = plane.origin, ax = plane.xAxis, ay = plane.yAxis;
    return [
        ox[0] + u * ax[0] + v * ay[0],
        ox[1] + u * ax[1] + v * ay[1],
        ox[2] + u * ax[2] + v * ay[2],
    ];
}

/**
 * Convert a world 3D point to sketch-local 2D coordinates. The point is
 * silently projected onto the sketch plane — callers that need to know if
 * the input was off-plane should compare `length(pt - localToWorld(result))`.
 *
 * @param {[number,number,number]|{x,y,z}} pt3
 * @param {object} plane
 * @returns {{x:number,y:number}}
 */
export function worldToLocal(pt3, plane) {
    const p = vec(pt3);
    const d = sub(p, plane.origin);
    return {
        x: dot(d, plane.xAxis),
        y: dot(d, plane.yAxis),
    };
}

/**
 * Project a world point onto the plane (perpendicular drop), returning the
 * closest world point on the plane. Useful for snapping the cursor when the
 * ray hits off the plane.
 */
export function projectOnPlane(pt3, plane) {
    const local = worldToLocal(pt3, plane);
    return localToWorld(local, plane);
}

/**
 * Signed perpendicular distance from a world point to the plane.
 * Positive means in the direction of `plane.normal`.
 */
export function signedDistance(pt3, plane) {
    const d = sub(vec(pt3), plane.origin);
    return dot(d, plane.normal);
}

// ── Camera helpers (Three.js-friendly but no THREE import) ──────────────────

/**
 * Recommended camera position for a top-down view of the plane.
 * Sits `distance` mm along `+normal` looking toward the origin, with
 * `yAxis` as the camera's up vector so positive sketch-Y points up.
 */
export function topDownCameraTarget(plane, distance = 200) {
    const eye = add(plane.origin, scale(plane.normal, distance));
    return {
        position: eye,
        target:   plane.origin.slice(),
        up:       plane.yAxis.slice(),
    };
}
