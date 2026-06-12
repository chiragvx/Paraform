/**
 * Sketch mirror — reflect entities across an axis Line.
 *
 * Used by the Mirror tool. Pre-select entities → pick a Line as the axis →
 * `mirrorEntities(...)` clones every supported entity, reflecting its
 * underlying points across the axis. Shared points are mirrored once and
 * the mirrored copies share the same new Point id (so two adjacent lines
 * stay joined after mirroring).
 *
 * Supported kinds (v1): Point, Line, Circle, Arc.
 *   - Point  → reflected Point
 *   - Line   → Line on the two reflected endpoint ids
 *   - Circle → Circle around the reflected centre, same radius
 *   - Arc    → Arc around the reflected centre. Reflection reverses the
 *              winding direction, so `newStart = 2φ - startAngle` and
 *              `newSweep = -sweepAngle`, where φ is the axis direction.
 *
 * Unsupported in v1 (skipped, reported back to caller): Rectangle,
 * Polygon, Ellipse, EllipticalArc, Spline, SlotLinear, SlotArc, Text.
 *
 * No symmetric constraint is added — the user can pin the pair later via
 * the constraint panel. This matches "Fusion 360 default off"; auto-bind
 * would over-constrain typical sketches.
 */

import { ENTITY_KIND, makePoint, makeLine, makeCircle, makeArc } from './entities.js';
import { addEntity } from './sketch_data.js';

/**
 * Reflect a 2D point `{x, y}` across the line through points `a` and `b`.
 * Returns a fresh `{x, y}`. Degenerate axis (a ≈ b) is identity.
 */
export function reflectPoint(p, a, b) {
    const vx = b.x - a.x, vy = b.y - a.y;
    const vv = vx * vx + vy * vy;
    if (vv < 1e-12) return { x: p.x, y: p.y };
    const d = ((p.x - a.x) * vx + (p.y - a.y) * vy) / vv;
    const fx = a.x + d * vx, fy = a.y + d * vy;
    return { x: 2 * fx - p.x, y: 2 * fy - p.y };
}

/**
 * Mirror a single entity across an axis Line. Honours shared-point identity
 * by consulting/extending the optional `pointMap` (origPointId → mirroredId).
 *
 * Returns the new entity id, or null if the entity kind is unsupported.
 */
export function mirrorEntity(sketch, entityId, axisLineId, opts = {}) {
    const result = mirrorEntities(sketch, [entityId], axisLineId, opts);
    if (!result || !result.newIds.length) return null;
    return result.newIds[0];
}

/**
 * Mirror many entities at once across an axis Line.
 *
 * The shared-point logic means: if two of the input entities reference the
 * same underlying Point, their mirrored copies will also share that
 * reflected Point — so chains of lines stay joined after the mirror.
 *
 * @param {object} sketch          SketchData
 * @param {string[]} entityIds     Entities to mirror. The axis line is
 *                                 silently filtered out if present.
 * @param {string} axisLineId      Id of the axis (must be an existing Line)
 * @returns {{newIds: string[], skipped: string[], pointMap: Object<string,string>}|null}
 *          null if the axis isn't a usable line (missing endpoints, zero length).
 */
export function mirrorEntities(sketch, entityIds, axisLineId, opts = {}) {
    const axisLine = sketch.entities[axisLineId];
    if (!axisLine || axisLine.kind !== ENTITY_KIND.LINE) return null;
    const a = sketch.entities[axisLine.params.startId];
    const b = sketch.entities[axisLine.params.endId];
    if (!a || !b) return null;
    const ax = a.params, bx = b.params;
    if (Math.hypot(bx.x - ax.x, bx.y - ax.y) < 1e-9) return null;
    const axisAngle = Math.atan2(bx.y - ax.y, bx.x - ax.x);

    const pointMap = new Map();
    const newIds   = [];
    const skipped  = [];

    const getMirroredPoint = (origId) => {
        if (pointMap.has(origId)) return pointMap.get(origId);
        const orig = sketch.entities[origId];
        if (!orig || orig.kind !== ENTITY_KIND.POINT) return null;
        const r = reflectPoint(orig.params, ax, bx);
        const np = addEntity(sketch, makePoint(r.x, r.y, { construction: orig.construction }));
        pointMap.set(origId, np.id);
        return np.id;
    };

    for (const id of entityIds) {
        if (id === axisLineId) { skipped.push(id); continue; }
        const e = sketch.entities[id];
        if (!e) { skipped.push(id); continue; }

        switch (e.kind) {
            case ENTITY_KIND.POINT: {
                const np = getMirroredPoint(id);
                if (np) newIds.push(np);
                else skipped.push(id);
                break;
            }
            case ENTITY_KIND.LINE: {
                const sa = getMirroredPoint(e.params.startId);
                const sb = getMirroredPoint(e.params.endId);
                if (!sa || !sb) { skipped.push(id); break; }
                const nl = addEntity(sketch, makeLine(sa, sb, { construction: e.construction }));
                newIds.push(nl.id);
                break;
            }
            case ENTITY_KIND.CIRCLE: {
                const nc = getMirroredPoint(e.params.centerId);
                if (!nc) { skipped.push(id); break; }
                const nci = addEntity(sketch, makeCircle(nc, e.params.radius, { construction: e.construction }));
                newIds.push(nci.id);
                break;
            }
            case ENTITY_KIND.ARC: {
                const nc = getMirroredPoint(e.params.centerId);
                if (!nc) { skipped.push(id); break; }
                const newStart = 2 * axisAngle - e.params.startAngle;
                const newSweep = -e.params.sweepAngle;
                const na = addEntity(sketch, makeArc(nc, e.params.radius, newStart, newSweep, { construction: e.construction }));
                newIds.push(na.id);
                break;
            }
            default:
                skipped.push(id);
        }
    }

    return { newIds, skipped, pointMap: Object.fromEntries(pointMap) };
}
