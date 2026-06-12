/**
 * Sketch patterns — replicate entities along a vector (Linear) or around
 * a centre (Circular).
 *
 *   linearPattern(sketch, entityIds, { direction, count, spacing })
 *     Translates each copy by `i * spacing * direction` for i = 1..count-1.
 *     The original entities stay put; the result is `(count - 1)` new
 *     entities per input.
 *
 *   circularPattern(sketch, entityIds, { centre, count, stepAngle })
 *     Rotates each copy by `i * stepAngle` around `centre`. Arcs, circles,
 *     and polygons rotate as wholes (their own internal angles update too).
 *
 * Shared-point identity is preserved *per copy*: if two of the input
 * entities share a Point, the i-th copy of both will share the same
 * replicated Point id. The original Points are never moved.
 *
 * Supported kinds (v1):
 *   Linear:   Point, Line, Circle, Arc, Rectangle, Polygon
 *   Circular: Point, Line, Circle, Arc, Polygon  (Rectangle skipped —
 *             the schema requires axis-aligned and rotation breaks that)
 *
 * Unsupported kinds (Ellipse, EllipticalArc, Spline, SlotLinear, SlotArc,
 * Text) are returned in `skipped`.
 */

import {
    ENTITY_KIND, makePoint, makeLine, makeCircle, makeArc, makeRectangle, makePolygon,
} from './entities.js';
import { addEntity } from './sketch_data.js';

/**
 * Replicate entities along a direction vector.
 *
 * @param {object} sketch
 * @param {string[]} entityIds
 * @param {object} opts
 * @param {{x:number, y:number}} opts.direction  Direction (re-normalised internally).
 * @param {number} opts.count                    Total instances incl. the original (≥ 2).
 * @param {number} opts.spacing                  Distance between consecutive copies (mm).
 * @returns {{newIds: string[], skipped: string[], copies: number}|null}
 */
export function linearPattern(sketch, entityIds, { direction, count, spacing } = {}) {
    if (!direction || !Number.isFinite(direction.x) || !Number.isFinite(direction.y)) return null;
    const len = Math.hypot(direction.x, direction.y);
    if (len < 1e-9) return null;
    const ux = direction.x / len, uy = direction.y / len;
    if (!Number.isInteger(count) || count < 2)        return null;
    if (!Number.isFinite(spacing) || spacing <= 0)    return null;

    const transformPoint = (orig, i) => ({
        x: orig.x + i * spacing * ux,
        y: orig.y + i * spacing * uy,
    });
    return replicate(sketch, entityIds, count, {
        transformPoint,
        transformArcLike: (params /*, i*/) => ({
            // Translation preserves all radii/angles
            radius:     params.radius,
            startAngle: params.startAngle,
            sweepAngle: params.sweepAngle,
        }),
        transformPolygonRotation: (orig /*, i*/) => orig,
        supportRectangle: true,
    });
}

/**
 * Replicate entities by rotating around a centre.
 *
 * @param {object} sketch
 * @param {string[]} entityIds
 * @param {object} opts
 * @param {{x:number, y:number}} opts.centre
 * @param {number} opts.count        Total instances incl. the original.
 * @param {number} opts.stepAngle    Angle between copies (radians). Positive = CCW.
 */
export function circularPattern(sketch, entityIds, { centre, count, stepAngle } = {}) {
    if (!centre || !Number.isFinite(centre.x) || !Number.isFinite(centre.y)) return null;
    if (!Number.isInteger(count) || count < 2)         return null;
    if (!Number.isFinite(stepAngle) || stepAngle === 0) return null;

    const transformPoint = (orig, i) => {
        const cos = Math.cos(i * stepAngle);
        const sin = Math.sin(i * stepAngle);
        const dx = orig.x - centre.x, dy = orig.y - centre.y;
        return {
            x: centre.x + cos * dx - sin * dy,
            y: centre.y + sin * dx + cos * dy,
        };
    };
    return replicate(sketch, entityIds, count, {
        transformPoint,
        transformArcLike: (params, i) => ({
            radius:     params.radius,
            startAngle: params.startAngle + i * stepAngle,
            sweepAngle: params.sweepAngle,
        }),
        transformPolygonRotation: (orig, i) => orig + i * stepAngle,
        supportRectangle: false,   // schema requires axis-aligned
    });
}

// ── Internal: per-copy replicator ────────────────────────────────────────────

function replicate(sketch, entityIds, count, transforms) {
    const { transformPoint, transformArcLike, transformPolygonRotation, supportRectangle } = transforms;
    const newIds   = [];
    const skipped  = [];

    // Validate inputs once so we can flag every bad id at the top
    const valid = [];
    for (const id of entityIds) {
        const e = sketch.entities[id];
        if (!e) { skipped.push(id); continue; }
        if (!isSupported(e.kind, supportRectangle)) { skipped.push(id); continue; }
        valid.push(id);
    }

    // For each copy i = 1..count-1, replicate every valid entity. Maintain a
    // per-copy point map so shared-point identity is preserved within each copy.
    for (let i = 1; i < count; i++) {
        const pointMap = new Map();
        const getCopyPoint = (origId) => {
            if (pointMap.has(origId)) return pointMap.get(origId);
            const o = sketch.entities[origId];
            if (!o || o.kind !== ENTITY_KIND.POINT) return null;
            const np = transformPoint(o.params, i);
            const fresh = addEntity(sketch, makePoint(np.x, np.y, { construction: o.construction }));
            pointMap.set(origId, fresh.id);
            return fresh.id;
        };

        for (const id of valid) {
            const e = sketch.entities[id];
            switch (e.kind) {
                case ENTITY_KIND.POINT: {
                    const np = getCopyPoint(id);
                    if (np) newIds.push(np);
                    break;
                }
                case ENTITY_KIND.LINE: {
                    const sa = getCopyPoint(e.params.startId);
                    const sb = getCopyPoint(e.params.endId);
                    if (!sa || !sb) break;
                    const nl = addEntity(sketch, makeLine(sa, sb, { construction: e.construction }));
                    newIds.push(nl.id);
                    break;
                }
                case ENTITY_KIND.CIRCLE: {
                    const nc = getCopyPoint(e.params.centerId);
                    if (!nc) break;
                    const arc = transformArcLike(e.params, i);
                    const nci = addEntity(sketch, makeCircle(nc, arc.radius, { construction: e.construction }));
                    newIds.push(nci.id);
                    break;
                }
                case ENTITY_KIND.ARC: {
                    const nc = getCopyPoint(e.params.centerId);
                    if (!nc) break;
                    const arc = transformArcLike(e.params, i);
                    const na = addEntity(sketch, makeArc(
                        nc, arc.radius, arc.startAngle, arc.sweepAngle,
                        { construction: e.construction }));
                    newIds.push(na.id);
                    break;
                }
                case ENTITY_KIND.RECTANGLE: {
                    const sa = getCopyPoint(e.params.cornerStartId);
                    const sb = getCopyPoint(e.params.cornerEndId);
                    if (!sa || !sb) break;
                    const nr = addEntity(sketch, makeRectangle(sa, sb, { construction: e.construction }));
                    newIds.push(nr.id);
                    break;
                }
                case ENTITY_KIND.POLYGON: {
                    const nc = getCopyPoint(e.params.centerId);
                    if (!nc) break;
                    const newRot = transformPolygonRotation(e.params.rotation || 0, i);
                    const np = addEntity(sketch, makePolygon(nc, e.params.radius, e.params.sides, {
                        rotation:    newRot,
                        inscribed:   !!e.params.inscribed,
                        construction: e.construction,
                    }));
                    newIds.push(np.id);
                    break;
                }
                default:
                    // Already filtered in `valid`; ignore.
            }
        }
    }

    return { newIds, skipped, copies: count - 1 };
}

function isSupported(kind, supportRectangle) {
    switch (kind) {
        case ENTITY_KIND.POINT:
        case ENTITY_KIND.LINE:
        case ENTITY_KIND.CIRCLE:
        case ENTITY_KIND.ARC:
        case ENTITY_KIND.POLYGON:
            return true;
        case ENTITY_KIND.RECTANGLE:
            return supportRectangle;
        default:
            return false;
    }
}
