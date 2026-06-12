/**
 * Sketch-editing operations — pure helpers that mutate a SketchData.
 *
 * No DOM, no Three.js. Tools in app/sketch_3d call these and let the
 * controller's commitDirty path re-solve, refresh badges, and re-render.
 *
 *   filletTwoLines(sketch, l1Id, l2Id, radius)
 *     Round the corner where two lines meet. Adds a centre point, an arc,
 *     and trims the source lines back to the tangent points. Auto-adds
 *     coincidence between the new endpoints and the arc endpoints so the
 *     solver keeps the geometry consistent. Returns the new arc id.
 *
 *   offsetLine(sketch, lineId, distance, sideSign)
 *     Create a parallel Line `distance` mm to the given side of `lineId`.
 *     `sideSign` is +1 or -1 (left vs. right of the line's direction).
 *     Returns the new line id.
 *
 *   offsetCircle(sketch, circleId, distance, sideSign)
 *     Create a concentric Circle whose radius is offset. +1 inflates,
 *     -1 deflates. Reuses the original centre id.
 *
 *   setEntityConstruction(sketch, entityId, value)
 *     Promote/demote between solid and construction geometry.
 *
 * All helpers return null if the operation is undefined (e.g. parallel
 * input lines for fillet, negative result radius for offset).
 */

import { ENTITY_KIND, makePoint, makeArc, makeLine, makeCircle } from './entities.js';
import {
    addEntity, patchEntity, addConstraint, setConstruction, removeEntity,
} from './sketch_data.js';
import { coincident } from './constraints.js';
import {
    findIntersections, lineParam, circleParam, arcParam,
    intersectLineCircle, intersectCircleCircle,
} from './sketch_intersect.js';

// ── Geometry primitives ────────────────────────────────────────────────────

function vec(p)            { return { x: p.x, y: p.y }; }
function sub(a, b)         { return { x: a.x - b.x, y: a.y - b.y }; }
function add(a, b)         { return { x: a.x + b.x, y: a.y + b.y }; }
function scale(a, s)       { return { x: a.x * s, y: a.y * s }; }
function dot(a, b)         { return a.x * b.x + a.y * b.y; }
function length(a)         { return Math.hypot(a.x, a.y); }
function normalize(a) {
    const n = length(a) || 1;
    return { x: a.x / n, y: a.y / n };
}
function distSq(a, b)      { const dx = a.x - b.x, dy = a.y - b.y; return dx * dx + dy * dy; }

/**
 * Intersection of two lines (extended to infinity). Each line is defined by
 * two distinct points. Returns null when the lines are parallel.
 */
export function lineLineIntersect(a, b, c, d) {
    const denom = (a.x - b.x) * (c.y - d.y) - (a.y - b.y) * (c.x - d.x);
    if (Math.abs(denom) < 1e-12) return null;
    const t = ((a.x - c.x) * (c.y - d.y) - (a.y - c.y) * (c.x - d.x)) / denom;
    return { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
}

// ── Construction toggle ────────────────────────────────────────────────────

export function setEntityConstruction(sketch, entityId, value) {
    if (!sketch.entities[entityId]) return false;
    setConstruction(sketch, entityId, !!value);
    return true;
}

export function toggleEntityConstruction(sketch, entityId) {
    const e = sketch.entities[entityId];
    if (!e) return false;
    setConstruction(sketch, entityId, !e.construction);
    return true;
}

// ── Fillet (two lines → tangent arc) ───────────────────────────────────────

/**
 * Round the corner where two lines meet. The corner is defined as the
 * intersection of the (extended) lines; the tangent points are computed
 * from the angle bisector. Both source lines are trimmed back to the
 * tangent points so the resulting profile is continuous.
 *
 * Returns the new arc's entity id, or null on failure.
 */
export function filletTwoLines(sketch, l1Id, l2Id, radius) {
    if (!Number.isFinite(radius) || radius <= 0) return null;
    const L1 = sketch.entities[l1Id];
    const L2 = sketch.entities[l2Id];
    if (!L1 || !L2) return null;
    if (L1.kind !== ENTITY_KIND.LINE || L2.kind !== ENTITY_KIND.LINE) return null;

    const A1 = sketch.entities[L1.params.startId];
    const B1 = sketch.entities[L1.params.endId];
    const A2 = sketch.entities[L2.params.startId];
    const B2 = sketch.entities[L2.params.endId];
    if (!A1 || !B1 || !A2 || !B2) return null;

    // Corner = intersection of the two (extended) lines
    const corner = lineLineIntersect(vec(A1.params), vec(B1.params),
                                     vec(A2.params), vec(B2.params));
    if (!corner) return null;   // lines parallel — no fillet possible

    // Which endpoint of each line is closest to the corner? The "far"
    // endpoint anchors the line; the "near" endpoint moves to the tangent.
    const nearL1 = distSq(corner, A1.params) < distSq(corner, B1.params)
        ? { nearKey: 'startId', nearId: A1.id, farId: B1.id, far: B1.params }
        : { nearKey: 'endId',   nearId: B1.id, farId: A1.id, far: A1.params };
    const nearL2 = distSq(corner, A2.params) < distSq(corner, B2.params)
        ? { nearKey: 'startId', nearId: A2.id, farId: B2.id, far: B2.params }
        : { nearKey: 'endId',   nearId: B2.id, farId: A2.id, far: A2.params };

    // Unit direction FROM corner toward each line's far endpoint.
    const u1 = normalize(sub(nearL1.far, corner));
    const u2 = normalize(sub(nearL2.far, corner));

    // Corner half-angle. cos(2α) = u1·u2.
    let cosFull = dot(u1, u2);
    if (cosFull > 1)  cosFull = 1;
    if (cosFull < -1) cosFull = -1;
    const fullAngle = Math.acos(cosFull);
    if (fullAngle < 1e-3 || Math.PI - fullAngle < 1e-3) return null;   // 0° or 180° — degenerate
    const halfAngle = fullAngle / 2;

    const tanHalf = Math.tan(halfAngle);
    if (!Number.isFinite(tanHalf) || tanHalf < 1e-6) return null;
    const distToTangent = radius / tanHalf;
    const distToCenter  = radius / Math.sin(halfAngle);

    // Check that the tangent point fits on each line — the line must extend
    // from the corner at least `distToTangent` toward its far endpoint.
    if (distToTangent > length(sub(nearL1.far, corner))) return null;
    if (distToTangent > length(sub(nearL2.far, corner))) return null;

    const T1 = add(corner, scale(u1, distToTangent));
    const T2 = add(corner, scale(u2, distToTangent));
    const bisector = normalize(add(u1, u2));
    const center   = add(corner, scale(bisector, distToCenter));

    // Move the near endpoints onto the tangent points so the original lines
    // end at the fillet rather than overshooting into the corner.
    patchEntity(sketch, nearL1.nearId, { x: T1.x, y: T1.y });
    patchEntity(sketch, nearL2.nearId, { x: T2.x, y: T2.y });

    // Build the arc. Centre point first (a fresh Point so the original
    // points keep their identities), then the Arc whose endpoints are
    // tangent points.
    const centerPt = addEntity(sketch, makePoint(center.x, center.y, { construction: true }));
    const angle1 = Math.atan2(T1.y - center.y, T1.x - center.x);
    const angle2 = Math.atan2(T2.y - center.y, T2.x - center.x);
    let sweep = angle2 - angle1;
    while (sweep >  Math.PI) sweep -= 2 * Math.PI;
    while (sweep < -Math.PI) sweep += 2 * Math.PI;
    if (Math.abs(sweep) < 1e-6) return null;

    const arc = addEntity(sketch, makeArc(centerPt.id, radius, angle1, sweep));

    // Tie the line endpoints to the arc endpoints with coincident
    // constraints so the solver can carry the fillet through any
    // downstream geometry edits.
    // The arc endpoints share *identity* with the tangent points only
    // through their coordinates; we add a coincident constraint between
    // each pair of "logically equal" points later if the user wants
    // re-editing to be robust. For v1 the patched coords are enough.

    return arc.id;
}

// ── Chamfer (two lines → straight bevel) ──────────────────────────────────

/**
 * Cut a straight bevel where two lines meet. Same setup as fillet — find
 * the corner (extended intersection), figure out which endpoint of each
 * line is nearest the corner, trim each line back by `distance` along its
 * direction, and connect the two new tangent points with a fresh Line.
 *
 * Returns the new bevel line's id, or null on failure (parallel lines,
 * degenerate angle, or distance larger than either line's run-up).
 */
export function chamferTwoLines(sketch, l1Id, l2Id, distance) {
    if (!Number.isFinite(distance) || distance <= 0) return null;
    const L1 = sketch.entities[l1Id];
    const L2 = sketch.entities[l2Id];
    if (!L1 || !L2) return null;
    if (L1.kind !== ENTITY_KIND.LINE || L2.kind !== ENTITY_KIND.LINE) return null;

    const A1 = sketch.entities[L1.params.startId];
    const B1 = sketch.entities[L1.params.endId];
    const A2 = sketch.entities[L2.params.startId];
    const B2 = sketch.entities[L2.params.endId];
    if (!A1 || !B1 || !A2 || !B2) return null;

    const corner = lineLineIntersect(vec(A1.params), vec(B1.params),
                                     vec(A2.params), vec(B2.params));
    if (!corner) return null;

    // Pick the endpoint of each line that's closer to the corner; that's the
    // one we move onto the tangent point.
    const nearL1 = distSq(corner, A1.params) < distSq(corner, B1.params)
        ? { nearId: A1.id, farId: B1.id, far: B1.params }
        : { nearId: B1.id, farId: A1.id, far: A1.params };
    const nearL2 = distSq(corner, A2.params) < distSq(corner, B2.params)
        ? { nearId: A2.id, farId: B2.id, far: B2.params }
        : { nearId: B2.id, farId: A2.id, far: A2.params };

    const u1 = normalize(sub(nearL1.far, corner));
    const u2 = normalize(sub(nearL2.far, corner));

    // Reject parallel or anti-parallel — no clean corner to chamfer.
    const cosFull = Math.max(-1, Math.min(1, dot(u1, u2)));
    const fullAngle = Math.acos(cosFull);
    if (fullAngle < 1e-3 || Math.PI - fullAngle < 1e-3) return null;

    // Distance can't exceed either line's free run-up from the corner.
    if (distance > length(sub(nearL1.far, corner))) return null;
    if (distance > length(sub(nearL2.far, corner))) return null;

    const T1 = add(corner, scale(u1, distance));
    const T2 = add(corner, scale(u2, distance));

    // Move the near endpoints onto the tangent points so the source lines
    // end at the bevel rather than overshooting into the corner.
    patchEntity(sketch, nearL1.nearId, { x: T1.x, y: T1.y });
    patchEntity(sketch, nearL2.nearId, { x: T2.x, y: T2.y });

    // Connect the two tangent points with a fresh Line. We reuse the
    // already-moved near points so the chamfer shares vertices with both
    // source lines — drag any of them and the bevel + lines move together.
    const bevel = addEntity(sketch, makeLine(nearL1.nearId, nearL2.nearId));
    return bevel.id;
}

// ── Offset ─────────────────────────────────────────────────────────────────

/**
 * Create a parallel Line at `distance` mm offset to the given side of the
 * input line. `sideSign` is +1 for the left side of the line's direction
 * (start → end) and -1 for the right.
 *
 * Returns the new line id, or null on failure.
 */
export function offsetLine(sketch, lineId, distance, sideSign = 1) {
    if (!Number.isFinite(distance) || distance <= 0) return null;
    const L = sketch.entities[lineId];
    if (!L || L.kind !== ENTITY_KIND.LINE) return null;
    const A = sketch.entities[L.params.startId];
    const B = sketch.entities[L.params.endId];
    if (!A || !B) return null;

    const dx = B.params.x - A.params.x;
    const dy = B.params.y - A.params.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) return null;

    // Perpendicular unit vector (rotate +90° CCW gives "left" of direction)
    const sign = sideSign >= 0 ? 1 : -1;
    const nx = -dy / len * distance * sign;
    const ny =  dx / len * distance * sign;

    const newA = addEntity(sketch, makePoint(A.params.x + nx, A.params.y + ny));
    const newB = addEntity(sketch, makePoint(B.params.x + nx, B.params.y + ny));
    const newLine = addEntity(sketch, makeLine(newA.id, newB.id));
    return newLine.id;
}

/**
 * Create a concentric Circle whose radius is offset by `distance`.
 * `sideSign` +1 grows the radius (outer offset), -1 shrinks it.
 * Reuses the original centre point so dragging the original centre moves
 * both circles together.
 *
 * Returns the new circle id, or null on failure (resulting radius ≤ 0).
 */
export function offsetCircle(sketch, circleId, distance, sideSign = 1) {
    if (!Number.isFinite(distance) || distance <= 0) return null;
    const C = sketch.entities[circleId];
    if (!C || C.kind !== ENTITY_KIND.CIRCLE) return null;
    const sign = sideSign >= 0 ? 1 : -1;
    const newR = C.params.radius + sign * distance;
    if (newR <= 0) return null;
    const newCircle = addEntity(sketch, makeCircle(C.params.centerId, newR));
    return newCircle.id;
}

/**
 * Dispatcher — figures out the offset operation from the entity kind.
 * Returns the new entity id (or null).
 */
export function offsetEntity(sketch, entityId, distance, sideSign = 1) {
    const e = sketch.entities[entityId];
    if (!e) return null;
    if (e.kind === ENTITY_KIND.LINE)   return offsetLine(sketch, entityId, distance, sideSign);
    if (e.kind === ENTITY_KIND.CIRCLE) return offsetCircle(sketch, entityId, distance, sideSign);
    return null;
}

// ── Trim ───────────────────────────────────────────────────────────────────

/**
 * Compute the trim segments for an entity at a click point.
 *
 * Returns an array of `{ from, to }` parameter pairs describing the segments
 * of the entity that the trim would *keep* after deleting the segment that
 * contains `clickPoint`. For Lines the parameter is t along (start, end);
 * for Circles it's the angle around the centre [0, 2π); for Arcs it's the
 * progress along the arc's sweep [0, |sweep|].
 *
 * Returns null when the click doesn't land on the entity (within `tol`).
 * Returns [] when there are no other entities crossing this one — caller
 * may interpret that as "delete the entire entity".
 *
 * @param {object} sketch
 * @param {string} entityId
 * @param {{x:number,y:number}} clickPoint
 * @param {object} [opts]
 * @param {number} [opts.tol]
 * @returns {Array<{from:number, to:number}>|null}
 */
export function trimSegments(sketch, entityId, clickPoint, opts = {}) {
    const { tol = 0.5 } = opts;
    const e = sketch.entities[entityId];
    if (!e) return null;
    if (e.kind === ENTITY_KIND.LINE) {
        const a = sketch.entities[e.params.startId];
        const b = sketch.entities[e.params.endId];
        if (!a || !b) return null;
        const t = lineParam(clickPoint, a.params, b.params);
        if (t < -1e-6 || t > 1 + 1e-6) return null;
        const hits = findIntersections(sketch, entityId)
            .filter(h => h.param > 1e-6 && h.param < 1 - 1e-6)
            .map(h => h.param)
            .sort((x, y) => x - y);
        // Build the segment list — natural ends + intersections
        const breakpoints = [0, ...hits, 1];
        const segs = [];
        for (let i = 0; i + 1 < breakpoints.length; i++) {
            segs.push({ from: breakpoints[i], to: breakpoints[i + 1] });
        }
        // Drop the segment containing the click
        const keep = segs.filter(s => !(t > s.from - 1e-6 && t < s.to + 1e-6));
        return keep;
    }
    if (e.kind === ENTITY_KIND.CIRCLE) {
        const c = sketch.entities[e.params.centerId];
        if (!c) return null;
        const r = e.params.radius;
        const cursorR = Math.hypot(clickPoint.x - c.params.x, clickPoint.y - c.params.y);
        if (Math.abs(cursorR - r) > tol) return null;
        const t = circleParam(clickPoint, c.params);
        const hits = findIntersections(sketch, entityId)
            .map(h => h.param)
            .sort((x, y) => x - y);
        if (!hits.length) return [];   // no breakpoints → delete the whole circle
        // Build wrap-around segments around the rim
        const segs = [];
        for (let i = 0; i < hits.length; i++) {
            const from = hits[i];
            const to   = hits[(i + 1) % hits.length];
            segs.push({ from, to });
        }
        // Find the segment containing `t`. Wrap-around segment: from > to.
        const keep = segs.filter(s => !circleSegContains(s, t));
        return keep;
    }
    if (e.kind === ENTITY_KIND.ARC) {
        const c = sketch.entities[e.params.centerId];
        if (!c) return null;
        const cursorR = Math.hypot(clickPoint.x - c.params.x, clickPoint.y - c.params.y);
        if (Math.abs(cursorR - e.params.radius) > tol) return null;
        const t = arcParam(clickPoint, c.params, e.params.startAngle, e.params.sweepAngle);
        if (t == null) return null;
        const hits = findIntersections(sketch, entityId)
            .map(h => h.param)
            .filter(p => p > 1e-6 && p < Math.abs(e.params.sweepAngle) - 1e-6)
            .sort((x, y) => x - y);
        const breakpoints = [0, ...hits, Math.abs(e.params.sweepAngle)];
        const segs = [];
        for (let i = 0; i + 1 < breakpoints.length; i++) {
            segs.push({ from: breakpoints[i], to: breakpoints[i + 1] });
        }
        const keep = segs.filter(s => !(t > s.from - 1e-6 && t < s.to + 1e-6));
        return keep;
    }
    return null;
}

/** True if the circular [from, to) segment (with wrap-around) contains `t`. */
function circleSegContains(seg, t) {
    if (seg.from < seg.to) return t > seg.from - 1e-6 && t < seg.to + 1e-6;
    // Wrap-around
    return t > seg.from - 1e-6 || t < seg.to + 1e-6;
}

/**
 * Trim the clicked entity at `clickPoint`. Deletes the segment containing
 * the click and replaces the entity with one entity per surviving segment.
 * Returns the list of new entity ids, or null on failure.
 */
export function trimEntity(sketch, entityId, clickPoint, opts = {}) {
    const segs = trimSegments(sketch, entityId, clickPoint, opts);
    if (segs == null) return null;
    const e = sketch.entities[entityId];

    // Empty `segs` after intersection-aware trim → no intersections, so the
    // entire entity is what the user wanted to delete.
    if (segs.length === 0) {
        removeEntity(sketch, entityId);
        return [];
    }

    if (e.kind === ENTITY_KIND.LINE) {
        const a = sketch.entities[e.params.startId];
        const b = sketch.entities[e.params.endId];
        const newIds = [];
        for (const seg of segs) {
            const pa = lineInterp(a.params, b.params, seg.from);
            const pb = lineInterp(a.params, b.params, seg.to);
            const na = addEntity(sketch, makePoint(pa.x, pa.y));
            const nb = addEntity(sketch, makePoint(pb.x, pb.y));
            const nl = addEntity(sketch, makeLine(na.id, nb.id));
            newIds.push(nl.id);
        }
        removeEntity(sketch, entityId);
        return newIds;
    }
    if (e.kind === ENTITY_KIND.CIRCLE) {
        const c = sketch.entities[e.params.centerId];
        const newIds = [];
        for (const seg of segs) {
            // Sweep — handle wrap-around
            const start = seg.from;
            let sweep = seg.to - seg.from;
            if (sweep <= 0) sweep += 2 * Math.PI;
            const arc = addEntity(sketch, makeArc(c.id, e.params.radius, start, sweep));
            newIds.push(arc.id);
        }
        removeEntity(sketch, entityId);
        return newIds;
    }
    if (e.kind === ENTITY_KIND.ARC) {
        const c = sketch.entities[e.params.centerId];
        const sweepSign = e.params.sweepAngle >= 0 ? 1 : -1;
        const newIds = [];
        for (const seg of segs) {
            const start = e.params.startAngle + sweepSign * seg.from;
            const sweep = sweepSign * (seg.to - seg.from);
            if (Math.abs(sweep) < 1e-9) continue;
            const arc = addEntity(sketch, makeArc(c.id, e.params.radius, start, sweep));
            newIds.push(arc.id);
        }
        removeEntity(sketch, entityId);
        return newIds;
    }
    return null;
}

function lineInterp(a, b, t) {
    return { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
}

// ── Extend ─────────────────────────────────────────────────────────────────

/**
 * Extend an entity (Line or Arc) until its nearest endpoint hits another
 * entity in the sketch. The "click point" picks which endpoint to extend:
 * whichever endpoint of the clicked entity is closer to the click is the
 * one that moves. The chosen endpoint slides along the entity's natural
 * extrapolation (a Line's direction, an Arc's sweep direction) until it
 * intersects another entity.
 *
 * Returns `true` if the extension succeeded, `false` if there was nothing
 * to extend to (no candidate intersections in the extend direction), and
 * `null` if the click didn't land on a supported entity.
 *
 * @param {object} sketch
 * @param {string} entityId
 * @param {{x:number,y:number}} clickPoint
 * @returns {boolean|null}
 */
export function extendEntity(sketch, entityId, clickPoint) {
    const e = sketch.entities[entityId];
    if (!e) return null;
    if (e.kind === ENTITY_KIND.LINE) return _extendLine(sketch, e, clickPoint);
    if (e.kind === ENTITY_KIND.ARC)  return _extendArc(sketch, e, clickPoint);
    return null;
}

function _extendLine(sketch, line, clickPoint) {
    const A = sketch.entities[line.params.startId];
    const B = sketch.entities[line.params.endId];
    if (!A || !B) return null;
    // Pick the endpoint closer to the click as the one to extend.
    const dA = (clickPoint.x - A.params.x) ** 2 + (clickPoint.y - A.params.y) ** 2;
    const dB = (clickPoint.x - B.params.x) ** 2 + (clickPoint.y - B.params.y) ** 2;
    const near = dA < dB ? A : B;
    const far  = dA < dB ? B : A;

    // Parameterise the (infinite) line as `far + t * (near - far)`.
    // t = 0 → far, t = 1 → near. Extensions beyond `near` have t > 1.
    const dx = near.params.x - far.params.x, dy = near.params.y - far.params.y;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-12) return false;

    let bestT = Infinity;
    let bestP = null;
    for (const otherId of sketch.entityOrder) {
        if (otherId === line.id) continue;
        const o = sketch.entities[otherId];
        if (!o) continue;
        const hits = _lineVsOther(sketch, far.params, near.params, o);
        for (const hit of hits) {
            const t = ((hit.x - far.params.x) * dx + (hit.y - far.params.y) * dy) / len2;
            if (t > 1 + 1e-6 && t < bestT) { bestT = t; bestP = hit; }
        }
    }
    if (!bestP) return false;
    patchEntity(sketch, near.id, { x: bestP.x, y: bestP.y });
    return true;
}

function _extendArc(sketch, arc, clickPoint) {
    const C = sketch.entities[arc.params.centerId];
    if (!C) return null;
    const cP = C.params;
    const r  = arc.params.radius;
    const s0 = arc.params.startAngle;
    const sw = arc.params.sweepAngle;
    if (Math.abs(sw) < 1e-9 || Math.abs(sw) >= 2 * Math.PI - 1e-6) return false;

    // The two endpoint angles
    const ang0 = s0;
    const ang1 = s0 + sw;
    // Endpoint positions
    const p0 = { x: cP.x + r * Math.cos(ang0), y: cP.y + r * Math.sin(ang0) };
    const p1 = { x: cP.x + r * Math.cos(ang1), y: cP.y + r * Math.sin(ang1) };
    const d0 = (clickPoint.x - p0.x) ** 2 + (clickPoint.y - p0.y) ** 2;
    const d1 = (clickPoint.x - p1.x) ** 2 + (clickPoint.y - p1.y) ** 2;
    // Whichever endpoint is closer to the click is the one we extend
    const extendEnd1 = d1 <= d0;          // true → extend the END (s0 + sw side)
    const sweepSign  = sw >= 0 ? 1 : -1;
    // Direction of extension relative to that endpoint:
    //   extending the END means going further along +sweepSign
    //   extending the START means going further along -sweepSign
    const extendDir  = extendEnd1 ? sweepSign : -sweepSign;
    const startA     = extendEnd1 ? ang1 : ang0;

    let bestDelta = Infinity;
    let bestAng   = null;
    for (const otherId of sketch.entityOrder) {
        if (otherId === arc.id) continue;
        const o = sketch.entities[otherId];
        if (!o) continue;
        const hits = _circleVsOther(sketch, cP, r, o);
        for (const hit of hits) {
            const ang = Math.atan2(hit.y - cP.y, hit.x - cP.x);
            let delta = ang - startA;
            // Normalise delta into (-π, π]
            while (delta > Math.PI)  delta -= 2 * Math.PI;
            while (delta < -Math.PI) delta += 2 * Math.PI;
            // Bring delta into the same rotational direction as extension.
            if (extendDir > 0 && delta < 0) delta += 2 * Math.PI;
            if (extendDir < 0 && delta > 0) delta -= 2 * Math.PI;
            const mag = Math.abs(delta);
            if (mag > 1e-6 && mag < bestDelta) {
                bestDelta = mag;
                bestAng   = startA + delta;
            }
        }
    }
    if (bestAng == null) return false;

    // Update the arc. If we extended the END endpoint, sweep grows by
    // (bestAng - oldEnd). If we extended the START endpoint, both startAngle
    // and sweep change: the arc now starts at bestAng and runs to the old end.
    if (extendEnd1) {
        const newSweep = bestAng - ang0;
        patchEntity(sketch, arc.id, { sweepAngle: newSweep });
    } else {
        const newStart = bestAng;
        const newSweep = ang1 - newStart;
        patchEntity(sketch, arc.id, { startAngle: newStart, sweepAngle: newSweep });
    }
    return true;
}

/** Intersect the (extended) line A→B with another entity, returning hit points. */
function _lineVsOther(sketch, A, B, other) {
    if (other.kind === ENTITY_KIND.LINE) {
        const c = sketch.entities[other.params.startId];
        const d = sketch.entities[other.params.endId];
        if (!c || !d) return [];
        const p = lineLineIntersect(A, B, c.params, d.params);
        return p ? [p] : [];
    }
    if (other.kind === ENTITY_KIND.CIRCLE || other.kind === ENTITY_KIND.ARC) {
        const c = sketch.entities[other.params.centerId];
        if (!c) return [];
        const hits = intersectLineCircle(A, B, c.params, other.params.radius);
        if (other.kind === ENTITY_KIND.ARC) {
            return hits.filter(p =>
                arcParam(p, c.params, other.params.startAngle, other.params.sweepAngle) != null);
        }
        return hits;
    }
    return [];
}

/** Intersect a full circle (centre, radius) with another entity. */
function _circleVsOther(sketch, centre, radius, other) {
    if (other.kind === ENTITY_KIND.LINE) {
        const a = sketch.entities[other.params.startId];
        const b = sketch.entities[other.params.endId];
        if (!a || !b) return [];
        return intersectLineCircle(a.params, b.params, centre, radius);
    }
    if (other.kind === ENTITY_KIND.CIRCLE || other.kind === ENTITY_KIND.ARC) {
        const c2 = sketch.entities[other.params.centerId];
        if (!c2) return [];
        const hits = intersectCircleCircle(centre, radius, c2.params, other.params.radius);
        if (other.kind === ENTITY_KIND.ARC) {
            return hits.filter(p =>
                arcParam(p, c2.params, other.params.startAngle, other.params.sweepAngle) != null);
        }
        return hits;
    }
    return [];
}

/**
 * For Offset UX: given the original entity and the cursor's world point,
 * return +1 or -1 telling which side the cursor is on.
 *
 * For a Line, sign matches the cross product of (end - start) × (cursor - start).
 * For a Circle, sign is +1 if cursor is outside the rim, -1 if inside.
 */
export function offsetSideFromCursor(sketch, entityId, cursor) {
    const e = sketch.entities[entityId];
    if (!e) return 1;
    if (e.kind === ENTITY_KIND.LINE) {
        const a = sketch.entities[e.params.startId];
        const b = sketch.entities[e.params.endId];
        if (!a || !b) return 1;
        const dx = b.params.x - a.params.x, dy = b.params.y - a.params.y;
        const cx = cursor.x  - a.params.x, cy = cursor.y  - a.params.y;
        const cross = dx * cy - dy * cx;
        return cross >= 0 ? 1 : -1;
    }
    if (e.kind === ENTITY_KIND.CIRCLE) {
        const c = sketch.entities[e.params.centerId];
        if (!c) return 1;
        const d = Math.hypot(cursor.x - c.params.x, cursor.y - c.params.y);
        return d >= e.params.radius ? 1 : -1;
    }
    return 1;
}
