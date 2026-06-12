/**
 * Hit-testing sketch entities at a cursor (2D sketch-local).
 *
 * Returns the entity closest to the cursor whose nearest distance is within
 * tolerance. Tolerance is given in world units (mm); the caller is expected
 * to scale by the camera so the picker "feels" the same at every zoom.
 *
 * Priority is "spatially nearest" — no kind preference. Points are picked
 * with their own radius; Lines / Circles / Rectangles / Polygons are picked
 * by distance to their stroke.
 */

import { ENTITY_KIND } from '../../lib/sketch/entities.js';
import { slotLinearPath, splinePath } from '../../lib/sketch/sketch_shapes.js';

/** @typedef {{x:number, y:number}} Pt */
/** @typedef {{ id: string, kind: string, distance: number, point?: Pt }} PickResult */

// ── Distance helpers ────────────────────────────────────────────────────────

function dist(a, b) { const dx = a.x - b.x, dy = a.y - b.y; return Math.sqrt(dx * dx + dy * dy); }

function distPointToSegment(p, a, b) {
    const vx = b.x - a.x, vy = b.y - a.y;
    const wx = p.x - a.x, wy = p.y - a.y;
    const len2 = vx * vx + vy * vy;
    if (len2 < 1e-12) return dist(p, a);
    const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / len2));
    return dist(p, { x: a.x + t * vx, y: a.y + t * vy });
}

function distPointToCircleStroke(p, center, r) {
    const d = dist(p, center);
    return Math.abs(d - r);
}

function distPointToArcStroke(p, center, r, startAngle, sweepAngle) {
    // Nearest point on the arc — project onto the circle, clamp to arc range
    const ang = Math.atan2(p.y - center.y, p.x - center.x);
    const sweep = sweepAngle;
    const startN = ((startAngle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    const endN   = startN + sweep;
    // Normalize ang to be near startN within ±2π so we can compare cleanly
    let a = ang;
    while (a < startN - 0.01) a += 2 * Math.PI;
    while (a > endN + 0.01)   a -= 2 * Math.PI;
    const clamped = sweep > 0
        ? Math.max(startN, Math.min(endN, a))
        : Math.min(startN, Math.max(endN, a));
    const fx = center.x + r * Math.cos(clamped);
    const fy = center.y + r * Math.sin(clamped);
    return dist(p, { x: fx, y: fy });
}

function distPointToPolyline(p, points) {
    if (points.length < 2) return Infinity;
    let best = Infinity;
    for (let i = 0; i + 1 < points.length; i++) {
        const d = distPointToSegment(p, points[i], points[i + 1]);
        if (d < best) best = d;
    }
    return best;
}

// ── Per-kind testers ────────────────────────────────────────────────────────

function entityDistance(cursor, e, sketch) {
    switch (e.kind) {
        case ENTITY_KIND.POINT:
            return dist(cursor, e.params);
        case ENTITY_KIND.LINE: {
            const a = sketch.entities[e.params.startId];
            const b = sketch.entities[e.params.endId];
            if (!a || !b) return Infinity;
            return distPointToSegment(cursor, a.params, b.params);
        }
        case ENTITY_KIND.CIRCLE: {
            const c = sketch.entities[e.params.centerId];
            if (!c) return Infinity;
            return distPointToCircleStroke(cursor, c.params, e.params.radius);
        }
        case ENTITY_KIND.ARC: {
            const c = sketch.entities[e.params.centerId];
            if (!c) return Infinity;
            return distPointToArcStroke(cursor, c.params, e.params.radius,
                e.params.startAngle, e.params.sweepAngle);
        }
        case ENTITY_KIND.RECTANGLE: {
            const a = sketch.entities[e.params.cornerStartId];
            const b = sketch.entities[e.params.cornerEndId];
            if (!a || !b) return Infinity;
            const pts = [
                { x: a.params.x, y: a.params.y },
                { x: b.params.x, y: a.params.y },
                { x: b.params.x, y: b.params.y },
                { x: a.params.x, y: b.params.y },
                { x: a.params.x, y: a.params.y },
            ];
            return distPointToPolyline(cursor, pts);
        }
        case ENTITY_KIND.POLYGON: {
            const c = sketch.entities[e.params.centerId];
            if (!c) return Infinity;
            const n = e.params.sides, r = e.params.radius, rot = e.params.rotation;
            const pts = [];
            for (let i = 0; i <= n; i++) {
                const a = rot + (2 * Math.PI * i) / n;
                pts.push({ x: c.params.x + r * Math.cos(a), y: c.params.y + r * Math.sin(a) });
            }
            return distPointToPolyline(cursor, pts);
        }
        case ENTITY_KIND.SLOT_LINEAR: {
            const a = sketch.entities[e.params.centerStartId];
            const b = sketch.entities[e.params.centerEndId];
            if (!a || !b) return Infinity;
            const pts = slotLinearPath(a.params, b.params, e.params.radius);
            // Close the outline so the picker measures every segment
            pts.push(pts[0]);
            return distPointToPolyline(cursor, pts);
        }
        case ENTITY_KIND.SPLINE: {
            const ids = e.params.controlPointIds || [];
            const ctrl = [];
            for (const id of ids) {
                const p = sketch.entities[id];
                if (p) ctrl.push(p.params);
            }
            if (ctrl.length < 2) return Infinity;
            const pts = splinePath(ctrl, { closed: !!e.params.closed });
            if (e.params.closed && pts.length) pts.push(pts[0]);
            return distPointToPolyline(cursor, pts);
        }
        case ENTITY_KIND.ELLIPSE:
        case ENTITY_KIND.SLOT_ARC:
            // TODO better fitting later — for v1 fall back to centre distance
            // so the entity can at least be selected
            if (e.params.centerId) {
                const c = sketch.entities[e.params.centerId];
                if (c) return dist(cursor, c.params);
            }
            return Infinity;
        default:
            return Infinity;
    }
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Find the nearest entity within `tolerance` world units of `cursor`.
 * Construction entities are pickable too — the editor decides whether to
 * filter them out.
 *
 * @param {Pt} cursor
 * @param {object} sketchData
 * @param {object} [opts]
 * @param {number} [opts.tolerance]            — world-unit threshold (mm)
 * @param {string|null} [opts.excludeId]
 * @param {(e: object) => boolean} [opts.filter]
 * @returns {PickResult|null}
 */
export function pickEntity(cursor, sketchData, opts = {}) {
    const { tolerance = 4, excludeId = null, filter = null } = opts;
    let best = null;
    for (const id of sketchData.entityOrder) {
        if (id === excludeId) continue;
        const e = sketchData.entities[id];
        if (!e) continue;
        if (filter && !filter(e)) continue;
        const d = entityDistance(cursor, e, sketchData);
        if (d > tolerance) continue;
        if (!best || d < best.distance) best = { id, kind: e.kind, distance: d };
    }
    return best;
}

/**
 * Same as `pickEntity` but returns *every* entity inside the tolerance.
 * Useful for area-select previews (Phase 2).
 */
export function pickEntities(cursor, sketchData, opts = {}) {
    const { tolerance = 4 } = opts;
    const hits = [];
    for (const id of sketchData.entityOrder) {
        const e = sketchData.entities[id];
        if (!e) continue;
        const d = entityDistance(cursor, e, sketchData);
        if (d <= tolerance) hits.push({ id, kind: e.kind, distance: d });
    }
    hits.sort((a, b) => a.distance - b.distance);
    return hits;
}

/**
 * Pick *only* a Point entity within a tighter tolerance.
 * Returns its id + position, or null.
 */
export function pickPoint(cursor, sketchData, opts = {}) {
    const { tolerance = 3, excludeId = null } = opts;
    return pickEntity(cursor, sketchData, {
        tolerance, excludeId,
        filter: (e) => e.kind === ENTITY_KIND.POINT,
    });
}
