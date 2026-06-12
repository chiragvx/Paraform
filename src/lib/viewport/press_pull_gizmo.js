/**
 * Press-Pull drag-handle gizmo (E3 v2).
 *
 * Pure-math, DOM-free core. The Viewport.svelte wiring constructs a
 * `PressPullGizmo` per selected face and feeds it pointer ray data; the
 * gizmo returns a signed offset distance along the face normal that the
 * caller debounces into kernel calls and finally commits as a
 * `addPushPullFace` feature on mouse-up.
 *
 * The math:
 *   - The drag plane is the plane containing the face normal and the
 *     camera-up-projected screen-right axis (i.e. the plane that contains
 *     the normal line and faces the camera most directly).
 *   - The drag start records the ray-plane intersection at pointer-down.
 *   - Each subsequent move intersects the same plane; the offset along
 *     the normal is the dot of (current_hit − start_hit) with the
 *     normalized face normal.
 *
 * This keeps the user's drag feel "glued" to the ray-plane intersection
 * regardless of camera angle, while constraining the result to a 1-DOF
 * offset along the face normal.
 *
 * Also exports the inline gizmo geometry helpers for callers that want
 * to render the arrow without TransformControls (we don't need the full
 * 6-DOF widget — just an arrow).
 */

const EPSILON = 1e-9;

/** Normalize a [x,y,z] in place into a new array. */
function normalize(v) {
    const [x, y, z] = v;
    const len = Math.sqrt(x * x + y * y + z * z);
    if (len < EPSILON) return [0, 0, 0];
    return [x / len, y / len, z / len];
}

function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function scale(v, s) { return [v[0] * s, v[1] * s, v[2] * s]; }
function cross(a, b) {
    return [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ];
}

/**
 * Intersect a ray with a plane.
 * @param {[number,number,number]} rayOrigin
 * @param {[number,number,number]} rayDir       (need not be unit)
 * @param {[number,number,number]} planePoint
 * @param {[number,number,number]} planeNormal  (need not be unit)
 * @returns {[number,number,number] | null} hit point in world coords, or null on parallel/back.
 */
export function intersectRayPlane(rayOrigin, rayDir, planePoint, planeNormal) {
    const denom = dot(rayDir, planeNormal);
    if (Math.abs(denom) < EPSILON) return null;
    const t = dot(sub(planePoint, rayOrigin), planeNormal) / denom;
    if (!Number.isFinite(t)) return null;
    return add(rayOrigin, scale(rayDir, t));
}

/**
 * Pick the best drag plane for an arrow gizmo whose axis = `normal`.
 * We choose the plane that contains the normal and is most front-facing
 * to the camera, i.e. its plane-normal is `normal × (cameraDir × normal)`
 * picked to align with the camera direction.
 *
 * If the camera dir is parallel to the face normal, fall back to using
 * world-up as the secondary axis (avoid a degenerate plane).
 *
 * @returns {[number,number,number]} the plane normal (unit), suitable for
 *   `intersectRayPlane`.
 */
export function dragPlaneNormal(faceNormal, cameraDir, worldUp = [0, 0, 1]) {
    const n = normalize(faceNormal);
    const c = normalize(cameraDir);
    // Side axis perpendicular to the normal, lying in the plane spanned
    // by n and c. If n ‖ c, use worldUp.
    let side = cross(n, c);
    if (Math.sqrt(dot(side, side)) < 1e-6) {
        side = cross(n, normalize(worldUp));
        if (Math.sqrt(dot(side, side)) < 1e-6) {
            // Final fallback: use world +X.
            side = cross(n, [1, 0, 0]);
        }
    }
    side = normalize(side);
    // The drag plane contains n and side. Its normal is n × side.
    const planeN = normalize(cross(n, side));
    return planeN;
}

/**
 * Compute the offset distance (mm, signed) along the face normal from a
 * pointer ray, given a previously-captured drag-start hit.
 *
 * @param {object} opts
 * @param {[number,number,number]} opts.faceCentroid  - world coords
 * @param {[number,number,number]} opts.faceNormal    - need not be unit
 * @param {[number,number,number]} opts.dragPlaneN    - plane normal (from dragPlaneNormal)
 * @param {[number,number,number]} opts.startHit      - hit captured on pointer-down
 * @param {[number,number,number]} opts.rayOrigin
 * @param {[number,number,number]} opts.rayDir
 * @returns {number} signed offset along faceNormal. Returns 0 on miss.
 */
export function offsetFromDrag(opts) {
    const { faceCentroid, faceNormal, dragPlaneN, startHit, rayOrigin, rayDir } = opts;
    const hit = intersectRayPlane(rayOrigin, rayDir, faceCentroid, dragPlaneN);
    if (!hit) return 0;
    const delta = sub(hit, startHit);
    const n = normalize(faceNormal);
    return dot(delta, n);
}

/**
 * Stateful gizmo controller.
 *
 * Lifecycle:
 *   const giz = new PressPullGizmo({ faceCentroid, faceNormal });
 *   giz.beginDrag({ rayOrigin, rayDir, cameraDir });
 *   const d1 = giz.updateDrag({ rayOrigin, rayDir });   // live offset
 *   const d2 = giz.updateDrag({ rayOrigin, rayDir });   // live offset
 *   const final = giz.endDrag();                          // returns last offset
 *
 * `commitDistance` is the value to pass to `addPushPullFace`.
 *
 * The class is DOM/three-free: callers convert THREE.Vector3 ↔ tuples at
 * the boundary. This is what makes it testable from node.
 */
export class PressPullGizmo {
    constructor({ faceCentroid, faceNormal, snap = 0 }) {
        if (!Array.isArray(faceCentroid) || faceCentroid.length !== 3) {
            throw new Error('PressPullGizmo: faceCentroid required as [x,y,z]');
        }
        if (!Array.isArray(faceNormal) || faceNormal.length !== 3) {
            throw new Error('PressPullGizmo: faceNormal required as [x,y,z]');
        }
        this.faceCentroid = faceCentroid.slice();
        this.faceNormal = normalize(faceNormal);
        // snap in mm; 0 means continuous.
        this.snap = typeof snap === 'number' && snap > 0 ? snap : 0;
        this._dragPlaneN = null;
        this._startHit = null;
        this._currentOffset = 0;
        this._dragging = false;
    }

    /** Returns true iff the user is currently in a drag. */
    get isDragging() { return this._dragging; }

    /** Current live offset (mm) along the face normal. */
    get currentOffset() {
        const o = this._currentOffset;
        if (this.snap > 0) {
            return Math.round(o / this.snap) * this.snap;
        }
        return o;
    }

    /** Position of the arrow tip given the current offset. */
    get arrowTip() {
        return add(this.faceCentroid, scale(this.faceNormal, this.currentOffset));
    }

    /**
     * Start a drag. Captures the drag plane and the initial hit.
     * @returns {boolean} true if the drag started cleanly.
     */
    beginDrag({ rayOrigin, rayDir, cameraDir }) {
        this._dragPlaneN = dragPlaneNormal(this.faceNormal, cameraDir);
        const hit = intersectRayPlane(rayOrigin, rayDir, this.faceCentroid, this._dragPlaneN);
        if (!hit) {
            this._dragging = false;
            return false;
        }
        this._startHit = hit;
        this._currentOffset = 0;
        this._dragging = true;
        return true;
    }

    /**
     * Update the live drag offset.
     * @returns {number} signed offset (mm) along the face normal, after snapping.
     */
    updateDrag({ rayOrigin, rayDir }) {
        if (!this._dragging) return 0;
        const raw = offsetFromDrag({
            faceCentroid: this.faceCentroid,
            faceNormal: this.faceNormal,
            dragPlaneN: this._dragPlaneN,
            startHit: this._startHit,
            rayOrigin,
            rayDir,
        });
        this._currentOffset = raw;
        return this.currentOffset;
    }

    /**
     * Complete the drag. Returns the final (snapped) offset; caller is
     * responsible for translating that to `addPushPullFace(face, distance)`.
     */
    endDrag() {
        const final = this.currentOffset;
        this._dragging = false;
        return final;
    }

    /** Bail out of an in-flight drag without committing. */
    cancelDrag() {
        this._dragging = false;
        this._currentOffset = 0;
    }
}

/**
 * Move-Face 3-arrow gizmo controller (E3 v2 follow-up #2).
 *
 * When a face is selected for a Move Face op, we show three arrows:
 *   - normal (face outward normal)
 *   - tangent U (any in-plane axis perpendicular to normal)
 *   - tangent V (= normal × U)
 *
 * The user can drag any arrow; the gizmo emits a translation vector for
 * the JS layer to pass to `addMoveFace(face, [vx,vy,vz], { tangent })`.
 *
 * v1 of this gizmo treats each arrow independently: only one is active
 * at a time. The result is a vector decomposed as:
 *   - normal arrow drag → `vector = [n * d, 0]` (the legacy normal-only path)
 *   - tangent arrow drag → `vector = [0,0,0]`, `tangent = u * d` (or v * d)
 *
 * Test surface: the math for picking `tangentU` / `tangentV` from a normal
 * + a sensible up-hint is fully unit-testable.
 */
export function buildMoveFaceFrame(faceNormal, worldUp = [0, 0, 1]) {
    const n = normalize(faceNormal);
    // Pick a tangent U: prefer worldUp ⊥-projected; if that's degenerate
    // (face normal ≈ world up), use world +X.
    const up = normalize(worldUp);
    let u = sub(up, scale(n, dot(up, n)));
    if (Math.sqrt(dot(u, u)) < 1e-6) {
        u = sub([1, 0, 0], scale(n, dot([1, 0, 0], n)));
        if (Math.sqrt(dot(u, u)) < 1e-6) {
            u = sub([0, 1, 0], scale(n, dot([0, 1, 0], n)));
        }
    }
    u = normalize(u);
    const v = normalize(cross(n, u));
    return { normal: n, tangentU: u, tangentV: v };
}

/**
 * Convert a Move-Face gizmo result into the params the JS op needs.
 *
 * @param {object} opts
 * @param {'normal'|'tangentU'|'tangentV'} opts.axis  - which arrow was dragged
 * @param {number} opts.distance  - signed mm offset along the axis
 * @param {object} opts.frame     - from buildMoveFaceFrame
 * @returns {{ vector: number[], tangent?: number[] }}
 *   Ready to spread into `addMoveFace(face, vector, { tangent })`.
 */
export function moveFaceParamsFromDrag({ axis, distance, frame }) {
    if (!frame) throw new Error('moveFaceParamsFromDrag: frame required');
    if (!Number.isFinite(distance)) throw new Error('moveFaceParamsFromDrag: numeric distance required');
    if (axis === 'normal') {
        const v = scale(frame.normal, distance);
        return { vector: v };
    }
    if (axis === 'tangentU') {
        const t = scale(frame.tangentU, distance);
        return { vector: [0, 0, 0], tangent: t };
    }
    if (axis === 'tangentV') {
        const t = scale(frame.tangentV, distance);
        return { vector: [0, 0, 0], tangent: t };
    }
    throw new Error(`moveFaceParamsFromDrag: unknown axis ${axis}`);
}

// Internal helpers exposed for testing.
export const __internals = { normalize, dot, cross, sub, add, scale };
