/**
 * Sketch intersections — pure 2D geometry.
 *
 * Used by the Trim tool to find every place a clicked entity crosses
 * another entity. Returns hits as plain objects so the caller can sort
 * them along the parent entity's parameter axis (t for lines, θ for
 * circles/arcs) and split at the right places.
 *
 * No DOM, no Three.js. Pair-wise primitive functions plus a high-level
 * `findIntersections(sketch, entityId)` walker.
 *
 *   intersectLineLine(a, b, c, d)
 *     Treats both as infinite lines (Trim wants the algebraic intersection
 *     regardless of whether either segment actually reaches it). Returns
 *     null when parallel.
 *
 *   intersectLineCircle(la, lb, centre, r)
 *     Two-root quadratic. Returns an array of up to two points along the
 *     line — tangent case returns a single point.
 *
 *   intersectCircleCircle(c1, r1, c2, r2)
 *     Standard radical-line construction. Returns 0, 1, or 2 points.
 */

/** @typedef {{x:number, y:number}} Pt */

// ── Line × Line ──────────────────────────────────────────────────────────

/**
 * Algebraic intersection of two (extended) lines. Returns null when the
 * direction vectors are parallel.
 */
export function intersectLineLine(a, b, c, d) {
    const denom = (a.x - b.x) * (c.y - d.y) - (a.y - b.y) * (c.x - d.x);
    if (Math.abs(denom) < 1e-12) return null;
    const t = ((a.x - c.x) * (c.y - d.y) - (a.y - c.y) * (c.x - d.x)) / denom;
    return { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
}

// ── Line × Circle ────────────────────────────────────────────────────────

/**
 * Solve `|line(s) − centre|² = r²` for s, then map back to (x, y). Returns
 * 0/1/2 intersection points along the infinite line. Caller filters by
 * arc/circle sweep range as needed.
 */
export function intersectLineCircle(la, lb, centre, r) {
    const dx = lb.x - la.x;
    const dy = lb.y - la.y;
    const fx = la.x - centre.x;
    const fy = la.y - centre.y;
    const A = dx * dx + dy * dy;
    if (A < 1e-12) return [];
    const B = 2 * (dx * fx + dy * fy);
    const C = fx * fx + fy * fy - r * r;
    const disc = B * B - 4 * A * C;
    if (disc < -1e-9) return [];
    if (disc < 1e-9) {
        const s = -B / (2 * A);
        return [{ x: la.x + s * dx, y: la.y + s * dy }];
    }
    const sd = Math.sqrt(disc);
    const s1 = (-B - sd) / (2 * A);
    const s2 = (-B + sd) / (2 * A);
    return [
        { x: la.x + s1 * dx, y: la.y + s1 * dy },
        { x: la.x + s2 * dx, y: la.y + s2 * dy },
    ];
}

// ── Circle × Circle ─────────────────────────────────────────────────────

export function intersectCircleCircle(c1, r1, c2, r2) {
    const dx = c2.x - c1.x;
    const dy = c2.y - c1.y;
    const d  = Math.sqrt(dx * dx + dy * dy);
    if (d < 1e-12)       return [];      // concentric
    if (d > r1 + r2 + 1e-9) return [];   // far apart
    if (d < Math.abs(r1 - r2) - 1e-9) return [];   // one inside the other
    const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
    const h2 = r1 * r1 - a * a;
    const h = h2 > 0 ? Math.sqrt(h2) : 0;
    const xm = c1.x + (dx * a) / d;
    const ym = c1.y + (dy * a) / d;
    const rx = -(dy * h) / d;
    const ry =  (dx * h) / d;
    if (h < 1e-9) return [{ x: xm, y: ym }];        // tangent
    return [
        { x: xm + rx, y: ym + ry },
        { x: xm - rx, y: ym - ry },
    ];
}

// ── Parameterisation helpers ─────────────────────────────────────────────

/**
 * Project `point` onto the line through (a, b) and return its parameter t
 * such that `point = a + t * (b - a)`. Useful for sorting intersection
 * points along a line and choosing which segment a click lands in.
 */
export function lineParam(point, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-12) return 0;
    return ((point.x - a.x) * dx + (point.y - a.y) * dy) / len2;
}

/**
 * Angle of `point` around the centre, normalised to [0, 2π). Useful for
 * sorting intersection points around a circle and choosing which arc
 * segment a click lands in.
 */
export function circleParam(point, centre) {
    const a = Math.atan2(point.y - centre.y, point.x - centre.x);
    return (a + 2 * Math.PI) % (2 * Math.PI);
}

/**
 * Same as `circleParam` but offsets so that the arc's startAngle maps to 0
 * and the angles run [0, |sweep|]. Returns null when the point is outside
 * the arc's sweep range. Sign of sweep matters — negative sweeps go CW.
 */
export function arcParam(point, centre, startAngle, sweepAngle) {
    const a = Math.atan2(point.y - centre.y, point.x - centre.x);
    let delta = a - startAngle;
    while (delta < -Math.PI) delta += 2 * Math.PI;
    while (delta >  Math.PI) delta -= 2 * Math.PI;
    // Bring `delta` into the same rotational direction as the sweep.
    if (sweepAngle >= 0 && delta < 0) delta += 2 * Math.PI;
    if (sweepAngle <  0 && delta > 0) delta -= 2 * Math.PI;
    // Reject anything outside the arc's range
    if (sweepAngle >= 0 && (delta < -1e-9 || delta > sweepAngle + 1e-9)) return null;
    if (sweepAngle <  0 && (delta >  1e-9 || delta < sweepAngle - 1e-9)) return null;
    return delta;
}

// ── Sketch walker ────────────────────────────────────────────────────────

/**
 * For a given entity in the sketch, find every other entity it crosses
 * and return the intersection point + a parameter telling where on the
 * source entity the hit happened.
 *
 *   For Line targets the parameter is t ∈ [0, 1] for hits on the segment;
 *   hits outside the segment are still reported (Trim wants them) but the
 *   caller can filter.
 *   For Circle / Arc targets the parameter is the angle around the centre,
 *   measured from +X in radians.
 *
 * @param {object} sketch
 * @param {string} entityId
 * @returns {Array<{ otherId: string, point: Pt, param: number }>}
 */
export function findIntersections(sketch, entityId) {
    const e = sketch.entities[entityId];
    if (!e) return [];

    const out = [];
    for (const otherId of sketch.entityOrder) {
        if (otherId === entityId) continue;
        const o = sketch.entities[otherId];
        if (!o) continue;
        const hits = pairIntersect(sketch, e, o);
        for (const p of hits) {
            const param = paramOnEntity(sketch, e, p);
            if (param == null || !Number.isFinite(param)) continue;
            out.push({ otherId, point: p, param });
        }
    }
    return out;
}

/** Find raw points where `a` and `b` cross, regardless of their kinds. */
function pairIntersect(sketch, a, b) {
    // Lines / Circles / Arcs all decompose into "centre + extents" or
    // "two endpoints". Rectangles, polygons, slots, and splines are deferred.
    if (isLine(a) && isLine(b))       return llHits(sketch, a, b);
    if (isLine(a) && isCircular(b))   return lcHits(sketch, a, b);
    if (isCircular(a) && isLine(b))   return lcHits(sketch, b, a);
    if (isCircular(a) && isCircular(b)) return ccHits(sketch, a, b);
    return [];
}

const isLine     = (e) => e && e.kind === 'line';
const isCircle   = (e) => e && e.kind === 'circle';
const isArc      = (e) => e && e.kind === 'arc';
const isCircular = (e) => isCircle(e) || isArc(e);

function llHits(sketch, l1, l2) {
    const a = sketch.entities[l1.params.startId];
    const b = sketch.entities[l1.params.endId];
    const c = sketch.entities[l2.params.startId];
    const d = sketch.entities[l2.params.endId];
    if (!a || !b || !c || !d) return [];
    const p = intersectLineLine(a.params, b.params, c.params, d.params);
    return p ? [p] : [];
}

function lcHits(sketch, lineE, circE) {
    const a = sketch.entities[lineE.params.startId];
    const b = sketch.entities[lineE.params.endId];
    const c = sketch.entities[circE.params.centerId];
    if (!a || !b || !c) return [];
    const hits = intersectLineCircle(a.params, b.params, c.params, circE.params.radius);
    // Filter by arc sweep if the circular target is an Arc
    if (isArc(circE)) {
        return hits.filter(p =>
            arcParam(p, c.params, circE.params.startAngle, circE.params.sweepAngle) != null);
    }
    return hits;
}

function ccHits(sketch, e1, e2) {
    const c1 = sketch.entities[e1.params.centerId];
    const c2 = sketch.entities[e2.params.centerId];
    if (!c1 || !c2) return [];
    const hits = intersectCircleCircle(c1.params, e1.params.radius, c2.params, e2.params.radius);
    let out = hits;
    // Filter each side by its own sweep range
    if (isArc(e1)) out = out.filter(p => arcParam(p, c1.params, e1.params.startAngle, e1.params.sweepAngle) != null);
    if (isArc(e2)) out = out.filter(p => arcParam(p, c2.params, e2.params.startAngle, e2.params.sweepAngle) != null);
    return out;
}

function paramOnEntity(sketch, e, point) {
    if (isLine(e)) {
        const a = sketch.entities[e.params.startId];
        const b = sketch.entities[e.params.endId];
        if (!a || !b) return null;
        return lineParam(point, a.params, b.params);
    }
    if (isCircle(e)) {
        const c = sketch.entities[e.params.centerId];
        if (!c) return null;
        return circleParam(point, c.params);
    }
    if (isArc(e)) {
        const c = sketch.entities[e.params.centerId];
        if (!c) return null;
        return arcParam(point, c.params, e.params.startAngle, e.params.sweepAngle);
    }
    return null;
}
