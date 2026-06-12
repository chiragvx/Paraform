/**
 * Sketch shape helpers — derive polyline outlines from parametric entities.
 *
 * Used by the renderer (to draw the outline) and the hit-tester (to measure
 * distance from cursor to the outline). Pure 2D, no Three.js / DOM.
 *
 *   slotLinearPath(a, b, r, [segments])
 *     Outline of a centre-to-centre linear slot — two straight sides
 *     parallel to AB at perpendicular distance `r`, plus semicircular caps
 *     at A and B. Returns a closed polyline {x,y}[].
 *
 *   splinePath(controlPoints, [opts])
 *     Smooth polyline approximation of a cubic spline that interpolates
 *     every control point. Uses uniform Catmull-Rom (clamped endpoints for
 *     open splines, wrapped for closed). Two-point input degrades to a
 *     straight line.
 */

/**
 * Build the outline polyline of a linear (centre-to-centre) slot.
 *
 * Layout (with A→B along +u and N being the +CCW perpendicular):
 *   1. Top side:  from A+rN → B+rN
 *   2. Cap at B:  semicircle around B from +N through +u back to -N
 *   3. Bottom:    from B-rN → A-rN
 *   4. Cap at A:  semicircle around A from -N through -u back to +N
 *
 * The path closes back on itself (last point equals first).
 *
 * @param {{x:number, y:number}} a
 * @param {{x:number, y:number}} b
 * @param {number} r          half-width of the slot
 * @param {number} [segments] cap subdivision count (default 16 per cap)
 * @returns {Array<{x:number,y:number}>}
 */
export function slotLinearPath(a, b, r, segments = 16) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) {
        // Degenerate slot — render as a full circle around A
        const pts = [];
        for (let i = 0; i <= segments * 2; i++) {
            const t = (i / (segments * 2)) * 2 * Math.PI;
            pts.push({ x: a.x + r * Math.cos(t), y: a.y + r * Math.sin(t) });
        }
        return pts;
    }
    const ux = dx / len, uy = dy / len;
    const nx = -uy,      ny =  ux;          // +CCW perpendicular

    const pts = [];
    // 1. Top side: A+rN → B+rN
    pts.push({ x: a.x + r * nx, y: a.y + r * ny });
    pts.push({ x: b.x + r * nx, y: b.y + r * ny });
    // 2. Cap at B: starting at B+rN, bulge in +u direction, end at B-rN
    for (let i = 1; i <= segments; i++) {
        const t = (i / segments) * Math.PI;
        const c = Math.cos(t), s = Math.sin(t);
        pts.push({
            x: b.x + r * ( c * nx + s * ux),
            y: b.y + r * ( c * ny + s * uy),
        });
    }
    // 3. Bottom side: B-rN → A-rN (automatically pushed by last cap point + next)
    pts.push({ x: a.x - r * nx, y: a.y - r * ny });
    // 4. Cap at A: starting at A-rN, bulge in -u direction, end at A+rN
    for (let i = 1; i <= segments; i++) {
        const t = (i / segments) * Math.PI;
        const c = Math.cos(t), s = Math.sin(t);
        pts.push({
            x: a.x + r * (-c * nx - s * ux),
            y: a.y + r * (-c * ny - s * uy),
        });
    }
    return pts;
}

// ── Spline ──────────────────────────────────────────────────────────────────

/**
 * Evaluate one Catmull-Rom cubic section, returning the point at parameter
 * `t ∈ [0, 1]` on the segment between p1 and p2 (with p0, p3 as tangent
 * controllers).
 */
function evalCatmullRom(p0, p1, p2, p3, t) {
    const t2 = t * t, t3 = t2 * t;
    return {
        x: 0.5 * ((2 * p1.x) +
                  (-p0.x + p2.x) * t +
                  (2*p0.x - 5*p1.x + 4*p2.x - p3.x) * t2 +
                  (-p0.x + 3*p1.x - 3*p2.x + p3.x) * t3),
        y: 0.5 * ((2 * p1.y) +
                  (-p0.y + p2.y) * t +
                  (2*p0.y - 5*p1.y + 4*p2.y - p3.y) * t2 +
                  (-p0.y + 3*p1.y - 3*p2.y + p3.y) * t3),
    };
}

/**
 * Build the polyline approximation of a spline through `controlPoints`.
 *
 * Open splines clamp the first/last points by duplicating them as the
 * Catmull-Rom ghost neighbours, which makes the curve interpolate the
 * endpoints (matches build123d's `Spline()` behaviour). Closed splines
 * wrap so the result is a cyclic loop.
 *
 *   2 points  → straight line
 *   3+ points → smooth Catmull-Rom curve
 *
 * @param {Array<{x:number,y:number}>} controlPoints
 * @param {object} [opts]
 * @param {number}  [opts.segments]  subdivisions per section (default 16)
 * @param {boolean} [opts.closed]    wrap the control points cyclically
 * @returns {Array<{x:number,y:number}>}
 */
export function splinePath(controlPoints, { segments = 16, closed = false } = {}) {
    const n = controlPoints.length;
    if (n < 2) return [];
    if (n === 2) {
        return [{ ...controlPoints[0] }, { ...controlPoints[1] }];
    }
    const get = (i) => closed
        ? controlPoints[((i % n) + n) % n]
        : controlPoints[Math.max(0, Math.min(n - 1, i))];

    const out = [];
    const sections = closed ? n : n - 1;
    for (let i = 0; i < sections; i++) {
        const p0 = get(i - 1), p1 = get(i), p2 = get(i + 1), p3 = get(i + 2);
        // First point of each section: include only on the very first section
        // (subsequent sections start at the previous section's last point).
        const jStart = i === 0 ? 0 : 1;
        for (let j = jStart; j <= segments; j++) {
            out.push(evalCatmullRom(p0, p1, p2, p3, j / segments));
        }
    }
    return out;
}
