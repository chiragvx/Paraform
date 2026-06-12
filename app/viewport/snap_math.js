/**
 * Pure geometry helpers for the assembly snap UX. No THREE, no DOM — so the
 * slide-along-channel and screen-space-pick math can be unit-tested headlessly
 * (see __tests__/snap_math.mjs). The viewport modules (connector_overlay.js,
 * snap_drag.js) import these.
 */

export function clamp(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
}

/**
 * Parameter `t` of the point on an infinite line (lineP + t·lineDir) closest
 * to an infinite ray (rayO + s·rayD). `lineDir` and `rayD` must be unit.
 * Returns null when the two are (near-)parallel — the singular case the caller
 * should fall back from. This is the classic closest-points-of-two-lines.
 *
 * @returns {number|null} t along the line (mm if lineDir is unit)
 */
export function closestParamOnLine(rayO, rayD, lineP, lineDir) {
    const w = [rayO[0] - lineP[0], rayO[1] - lineP[1], rayO[2] - lineP[2]];
    const b = _dot(rayD, lineDir);
    const d = _dot(rayD, w);
    const e = _dot(lineDir, w);
    const denom = 1 - b * b;                 // a = c = 1 since both unit
    if (denom < 1e-6) return null;
    return (e - b * d) / denom;
}

/**
 * 2-D distance from point P to segment AB (all in screen px). Used to let the
 * cursor magnetize to *anywhere along* a rendered channel, not just its ends.
 */
export function pointSegmentDist2D(px, py, ax, ay, bx, by) {
    const abx = bx - ax, aby = by - ay;
    const apx = px - ax, apy = py - ay;
    const len2 = abx * abx + aby * aby;
    let t = len2 > 1e-9 ? (apx * abx + apy * aby) / len2 : 0;
    t = clamp(t, 0, 1);
    const cx = ax + t * abx, cy = ay + t * aby;
    return Math.hypot(px - cx, py - cy);
}

/**
 * Snap a free-placement ground position (mm, Z-up; z≈0) for a library drop.
 *   - origin lock: within `originMm` of the world origin → exactly [0,0,0],
 *     so "drop it at center" is easy to hit.
 *   - grid lock: while `ctrl` is held, round X/Y to the nearest `gridMm`
 *     increment (KSP/CAD-style incremental placement). Z is preserved.
 *
 * Pure — returns a fresh triple; never mutates the input.
 *
 * @param {number[]} pos          — [x,y,z] cursor-on-ground position (mm)
 * @param {{ ctrl?:boolean, gridMm?:number, originMm?:number }} [opts]
 * @returns {number[]}
 */
export function snapGroundPosition(pos, opts = {}) {
    if (!Array.isArray(pos) || pos.length < 2) return [0, 0, 0];
    const gridMm = opts.gridMm || 10;
    const originMm = opts.originMm || 6;
    let x = pos[0], y = pos[1];
    const z = pos[2] || 0;
    if (opts.ctrl) {
        x = Math.round(x / gridMm) * gridMm;
        y = Math.round(y / gridMm) * gridMm;
    } else if (Math.hypot(x, y) <= originMm) {
        return [0, 0, z];
    }
    return [x, y, z];
}

export function normalize3(v) {
    const m = Math.hypot(v[0], v[1], v[2]);
    if (m < 1e-9) return [0, 0, 1];
    return [v[0] / m, v[1] / m, v[2] / m];
}

function _dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
