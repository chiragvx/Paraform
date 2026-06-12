/**
 * Snap pipeline — Fusion-grade.
 *
 * Inputs:
 *   - cursor world position (already projected onto the sketch plane)
 *   - the live SketchData
 *   - optional drawing anchor (set while drawing the 2nd point of a Line, etc.)
 *
 * Outputs:
 *   - snapped 2D point (in sketch-local coords)
 *   - a `kind` tag the renderer uses to draw the appropriate marker
 *   - extras: hit entity id, angle multiple, intersecting lines, etc.
 *
 * Priority (highest first — first hit wins):
 *   1. Vertex          — endpoint of an existing Point
 *   2. Midpoint        — midpoint of an existing Line
 *   3. Intersection    — computed crossing of two existing Lines
 *   4. On-curve        — point ON an existing Line (perpendicular foot)
 *   5. Ortho           — locks to horizontal or vertical from the anchor
 *   6. Angle multiple  — locks the cursor angle from the anchor to N×5° / N×15° / N×45° / 90°
 *   7. Grid            — round to nearest grid step
 *
 * Tolerances are expressed in world units (mm). Callers pass the current
 * pixel-tolerance scaled by the camera so the snap radius stays roughly
 * constant on screen across zoom levels.
 */

import { ENTITY_KIND } from '../../lib/sketch/entities.js';
import { CONSTRAINT_KIND } from '../../lib/sketch/constraints.js';

/** @typedef {{x:number, y:number}} Pt */

const SNAP_KINDS = Object.freeze({
    VERTEX:        'vertex',
    MIDPOINT:      'midpoint',
    INTERSECT:     'intersect',
    ON_LINE:       'on-line',
    ON_CIRCLE:     'on-circle',
    TANGENT:       'tangent',
    ORTHO:         'ortho',
    ANGLE:         'angle',
    GRID:          'grid',
    NONE:          'none',
});
export { SNAP_KINDS };

// ── Distance helpers ────────────────────────────────────────────────────────
function dist2(a, b) { const dx = a.x - b.x, dy = a.y - b.y; return dx * dx + dy * dy; }
function dist(a, b) { return Math.sqrt(dist2(a, b)); }
function roundTo(v, step) {
    if (!Number.isFinite(step) || step <= 0) return v;
    return Math.round(v / step) * step;
}

// ── Per-kind hit-testers ────────────────────────────────────────────────────

function findVertex(cursor, sketch, tol, excludeId) {
    let best = null, bestD = tol * tol;
    for (const id of sketch.entityOrder) {
        if (id === excludeId) continue;
        const e = sketch.entities[id];
        if (!e || e.kind !== ENTITY_KIND.POINT) continue;
        const d = dist2(cursor, e.params);
        if (d < bestD) { best = { id, point: { x: e.params.x, y: e.params.y } }; bestD = d; }
    }
    return best;
}

function findMidpoint(cursor, sketch, tol) {
    let best = null, bestD = tol * tol;
    for (const id of sketch.entityOrder) {
        const e = sketch.entities[id];
        if (!e || e.kind !== ENTITY_KIND.LINE) continue;
        const a = sketch.entities[e.params.startId];
        const b = sketch.entities[e.params.endId];
        if (!a || !b) continue;
        const m = { x: 0.5 * (a.params.x + b.params.x), y: 0.5 * (a.params.y + b.params.y) };
        const d = dist2(cursor, m);
        if (d < bestD) { best = { lineId: id, point: m }; bestD = d; }
    }
    return best;
}

function findIntersection(cursor, sketch, tol) {
    const lines = [];
    for (const id of sketch.entityOrder) {
        const e = sketch.entities[id];
        if (!e || e.kind !== ENTITY_KIND.LINE) continue;
        const a = sketch.entities[e.params.startId];
        const b = sketch.entities[e.params.endId];
        if (a && b) lines.push({ id, a: a.params, b: b.params });
    }
    let best = null, bestD = tol * tol;
    for (let i = 0; i < lines.length; i++) {
        for (let j = i + 1; j < lines.length; j++) {
            const p = lineIntersection(lines[i].a, lines[i].b, lines[j].a, lines[j].b);
            if (!p) continue;
            const d = dist2(cursor, p);
            if (d < bestD) { best = { ids: [lines[i].id, lines[j].id], point: p }; bestD = d; }
        }
    }
    return best;
}

/** Intersection of segment AB with segment CD (extended to full lines). Returns null on parallel. */
function lineIntersection(a, b, c, d) {
    const x1 = a.x, y1 = a.y, x2 = b.x, y2 = b.y;
    const x3 = c.x, y3 = c.y, x4 = d.x, y4 = d.y;
    const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
    if (Math.abs(denom) < 1e-9) return null;
    const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom;
    return { x: x1 + t * (x2 - x1), y: y1 + t * (y2 - y1) };
}

function findOnLine(cursor, sketch, tol) {
    let best = null, bestD = tol * tol;
    for (const id of sketch.entityOrder) {
        const e = sketch.entities[id];
        if (!e || e.kind !== ENTITY_KIND.LINE) continue;
        const a = sketch.entities[e.params.startId];
        const b = sketch.entities[e.params.endId];
        if (!a || !b) continue;
        const proj = projectPointOnSegment(cursor, a.params, b.params);
        if (!proj) continue;
        const d = dist2(cursor, proj);
        if (d < bestD) { best = { lineId: id, point: proj }; bestD = d; }
    }
    return best;
}

/**
 * Find the nearest Circle/Arc whose rim is within `tol` of the cursor.
 * Returns the closest point on the rim so the cursor snaps cleanly onto it.
 */
function findOnCircle(cursor, sketch, tol) {
    let best = null, bestD = tol;
    for (const id of sketch.entityOrder) {
        const e = sketch.entities[id];
        if (!e || (e.kind !== ENTITY_KIND.CIRCLE && e.kind !== ENTITY_KIND.ARC)) continue;
        const c = sketch.entities[e.params.centerId];
        if (!c) continue;
        const dx = cursor.x - c.params.x, dy = cursor.y - c.params.y;
        const d  = Math.sqrt(dx * dx + dy * dy);
        if (d < 1e-9) continue;
        const rimDist = Math.abs(d - e.params.radius);
        if (rimDist < bestD) {
            const scale = e.params.radius / d;
            best = {
                circleId: id,
                point:    { x: c.params.x + dx * scale, y: c.params.y + dy * scale },
                rimDist,
            };
            bestD = rimDist;
        }
    }
    return best;
}

function projectPointOnSegment(p, a, b) {
    const vx = b.x - a.x, vy = b.y - a.y;
    const wx = p.x - a.x, wy = p.y - a.y;
    const len2 = vx * vx + vy * vy;
    if (len2 < 1e-12) return null;
    const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / len2));
    return { x: a.x + t * vx, y: a.y + t * vy };
}

// ── Ortho / Angle snap from anchor ──────────────────────────────────────────

const ANGLE_STOPS_DEG = [0, 5, 10, 15, 30, 45, 60, 75, 90, 105, 120, 135, 150, 165, 180,
                         195, 210, 225, 240, 255, 270, 285, 300, 315, 330, 345];

function orthoOrAngle(cursor, anchor, tolPerp, angleTolDeg) {
    const dx = cursor.x - anchor.x;
    const dy = cursor.y - anchor.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 1e-6) return null;

    // Ortho first (sub-case of angle but with its own visual hint)
    if (Math.abs(dy) <= tolPerp && Math.abs(dx) >= Math.abs(dy)) {
        return { kind: 'ortho', axis: 'h', point: { x: cursor.x, y: anchor.y } };
    }
    if (Math.abs(dx) <= tolPerp && Math.abs(dy) >= Math.abs(dx)) {
        return { kind: 'ortho', axis: 'v', point: { x: anchor.x, y: cursor.y } };
    }

    // Angle multiples — round cursor angle to the closest stop within tolerance
    const ang   = Math.atan2(dy, dx) * 180 / Math.PI;       // -180..180
    const norm  = (ang + 360) % 360;
    let bestStop = null, bestDelta = angleTolDeg + 1;
    for (const stop of ANGLE_STOPS_DEG) {
        let delta = Math.abs(stop - norm);
        if (delta > 180) delta = 360 - delta;
        if (delta < bestDelta) { bestDelta = delta; bestStop = stop; }
    }
    if (bestStop != null && bestDelta <= angleTolDeg) {
        const rad = bestStop * Math.PI / 180;
        return {
            kind: 'angle',
            angleDeg: bestStop,
            point: { x: anchor.x + dist * Math.cos(rad), y: anchor.y + dist * Math.sin(rad) },
        };
    }
    return null;
}

// ── Composite ──────────────────────────────────────────────────────────────

/**
 * Run the full snap pipeline on `cursor` (2D sketch-local coords).
 *
 * @param {Pt} cursor
 * @param {object} sketchData
 * @param {object} [opts]
 * @param {Pt|null} [opts.anchor]       — set while drawing the 2nd+ point
 * @param {number}  [opts.gridSize]     — defaults to 1 mm
 * @param {number}  [opts.snapRadius]   — world-unit tolerance for vertex/etc
 * @param {number}  [opts.orthoTol]     — perpendicular distance for ortho
 * @param {number}  [opts.angleTolDeg]  — angle deviation tolerance
 * @param {string|null} [opts.excludeId]
 * @returns {{ kind: string, point: Pt, extra?: any }}
 */
export function snap(cursor, sketchData, opts = {}) {
    const {
        anchor       = null,
        gridSize     = 1,
        snapRadius   = 4,
        orthoTol     = 4,
        angleTolDeg  = 3,
        excludeId    = null,
    } = opts;

    // 1. Vertex
    const vtx = findVertex(cursor, sketchData, snapRadius, excludeId);
    if (vtx) return { kind: SNAP_KINDS.VERTEX, point: vtx.point, extra: { entityId: vtx.id } };

    // 2. Midpoint
    const mid = findMidpoint(cursor, sketchData, snapRadius);
    if (mid) return { kind: SNAP_KINDS.MIDPOINT, point: mid.point, extra: { lineId: mid.lineId } };

    // 3. Intersection
    const xx = findIntersection(cursor, sketchData, snapRadius);
    if (xx) return { kind: SNAP_KINDS.INTERSECT, point: xx.point, extra: { lineIds: xx.ids } };

    // 4. On-curve (only if we have an anchor — otherwise it can be jumpy)
    //    Tangent-to-circle wins over generic on-line when both are in range
    //    because a line ending on a circle's rim almost always means tangency.
    if (anchor) {
        const onc = findOnCircle(cursor, sketchData, snapRadius);
        if (onc) return {
            kind: SNAP_KINDS.TANGENT, point: onc.point,
            extra: { circleId: onc.circleId, kind: 'tangent' },
        };
        const onl = findOnLine(cursor, sketchData, snapRadius);
        if (onl) return { kind: SNAP_KINDS.ON_LINE, point: onl.point, extra: { lineId: onl.lineId } };
    }

    // 5/6. Ortho or angle multiple (only with anchor)
    if (anchor) {
        const oa = orthoOrAngle(cursor, anchor, orthoTol, angleTolDeg);
        if (oa) return { kind: oa.kind === 'ortho' ? SNAP_KINDS.ORTHO : SNAP_KINDS.ANGLE, point: oa.point, extra: oa };
    }

    // 7. Grid (or none)
    if (gridSize > 0) {
        return { kind: SNAP_KINDS.GRID, point: { x: roundTo(cursor.x, gridSize), y: roundTo(cursor.y, gridSize) } };
    }
    return { kind: SNAP_KINDS.NONE, point: cursor };
}

// ── Constraint inference ────────────────────────────────────────────────────

/**
 * Derive auto-constraints from a snap event. Returns an array of
 * pending-constraint descriptors the tool can hand to addConstraint.
 *
 * Examples:
 *   snap kind = vertex  → COINCIDENT(newPoint, existingPoint)
 *   snap kind = midpoint→ MIDPOINT(newPoint, lineId)
 *   snap kind = on-line → POINT_ON_LINE(newPoint, lineId)
 *   snap kind = ortho h → HORIZONTAL(newLine)
 *   snap kind = ortho v → VERTICAL(newLine)
 *
 * @param {string} snapKind
 * @param {object} snapExtra
 * @returns {Array<{kind:string, args:any[]}>}
 */
export function inferConstraints(snapKind, snapExtra = {}) {
    switch (snapKind) {
        case SNAP_KINDS.MIDPOINT:
            return [{ kind: 'midpoint',       args: [snapExtra.lineId] }];
        case SNAP_KINDS.ON_LINE:
            return [{ kind: 'point-on-line',  args: [snapExtra.lineId] }];
        case SNAP_KINDS.ON_CIRCLE:
            return [{ kind: 'point-on-circle', args: [snapExtra.circleId] }];
        case SNAP_KINDS.TANGENT:
            return [{ kind: 'tangent',        args: [snapExtra.circleId] }];
        case SNAP_KINDS.ORTHO:
            return [{ kind: snapExtra.axis === 'h' ? 'horizontal' : 'vertical', args: [] }];
        default:
            return [];
    }
}

// ── Live "what-will-happen" inference for an in-progress draw ───────────────
//
// While the user is drawing a line (anchor → cursor) we want to surface every
// constraint that WOULD be applied if they clicked right now. The snap result
// already covers ortho / coincident-vertex / midpoint / tangent / point-on-X.
//
// `inferGeometricForLine` adds the relational constraints that aren't covered
// by snap because they depend on comparing the in-progress edge to *every*
// other line in the sketch: parallel / perpendicular / equal-length.

const TWO_PI = Math.PI * 2;

function lineEndpoints(sketch, line) {
    const a = sketch.entities[line.params.startId];
    const b = sketch.entities[line.params.endId];
    if (!a || !b) return null;
    return [a.params, b.params];
}

function normalizeAngle(a) { return ((a % Math.PI) + Math.PI) % Math.PI; }

/**
 * Return the smallest angle (radians, in [0, π/2]) between two directions
 * encoded as raw angles in radians.
 */
function angleDelta(a, b) {
    const d = Math.abs(normalizeAngle(a) - normalizeAngle(b));
    return Math.min(d, Math.PI - d);
}

/**
 * Examine the anchor→cursor edge against existing lines in the sketch and
 * return a list of inferred-constraint descriptors. Each descriptor has the
 * shape:
 *     { kind: 'parallel' | 'perpendicular' | 'equal-length' | 'horizontal' |
 *             'vertical', refId?: string, note?: string }
 *
 * The caller (usually a tool) decides which descriptors to actually convert
 * into real constraints when the user clicks. Glyph rendering uses the same
 * list to draw the H / V / ∥ / ⊥ / = icons next to the cursor.
 *
 * Pure: never mutates the sketch.
 *
 * @param {{x:number,y:number}} anchor
 * @param {{x:number,y:number}} cursor
 * @param {object} sketch
 * @param {object} [opts]
 * @param {number} [opts.angleTolDeg=3]   — angle tolerance for ∥ / ⊥
 * @param {number} [opts.lengthRelTol=0.02] — relative length tolerance for =
 * @param {string|null} [opts.excludeLineId] — skip this line (e.g. the one
 *   being edited)
 * @returns {Array<{kind:string, refId?:string, note?:string}>}
 */
export function inferGeometricForLine(anchor, cursor, sketch, opts = {}) {
    const {
        angleTolDeg   = 3,
        lengthRelTol  = 0.02,
        excludeLineId = null,
    } = opts;
    const out = [];
    if (!anchor || !cursor) return out;
    const dx = cursor.x - anchor.x;
    const dy = cursor.y - anchor.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) return out;
    const angle = Math.atan2(dy, dx);
    const angleTolRad = (angleTolDeg * Math.PI) / 180;

    // Self-check: horizontal / vertical (anchor-aware variants of ortho)
    const absA = Math.abs(normalizeAngle(angle));
    if (Math.min(absA, Math.PI - absA) <= angleTolRad) {
        out.push({ kind: 'horizontal', note: 'H' });
    } else if (Math.abs(absA - Math.PI / 2) <= angleTolRad) {
        out.push({ kind: 'vertical', note: 'V' });
    }

    // Relational: ∥ / ⊥ / equal-length against every existing line
    let bestPar = null, bestParD = angleTolRad;
    let bestPer = null, bestPerD = angleTolRad;
    let bestEq  = null, bestEqD  = lengthRelTol * len;
    for (const id of sketch.entityOrder) {
        if (id === excludeLineId) continue;
        const e = sketch.entities[id];
        if (!e || e.kind !== ENTITY_KIND.LINE) continue;
        const ends = lineEndpoints(sketch, e);
        if (!ends) continue;
        const [pA, pB] = ends;
        const eDx = pB.x - pA.x, eDy = pB.y - pA.y;
        const eLen = Math.hypot(eDx, eDy);
        if (eLen < 1e-6) continue;
        const eAng = Math.atan2(eDy, eDx);

        // Parallel: angle delta ≈ 0 (mod π)
        const dPar = angleDelta(angle, eAng);
        if (dPar < bestParD && dPar > 1e-9) {
            // Skip if the line is itself ~horizontal/vertical: ortho hint
            // would double-fire — we already added H/V above.
            const eIsOrtho =
                Math.min(angleDelta(eAng, 0), angleDelta(eAng, Math.PI / 2)) <= angleTolRad;
            if (!eIsOrtho) { bestParD = dPar; bestPar = id; }
        }
        // Perpendicular: angle delta ≈ π/2
        const dPer = Math.abs(dPar - Math.PI / 2);
        if (dPer < bestPerD) { bestPerD = dPer; bestPer = id; }
        // Equal length
        const dEq = Math.abs(eLen - len);
        if (dEq < bestEqD) { bestEqD = dEq; bestEq = id; }
    }
    // Only emit ∥ if we did NOT already emit H/V — keeps glyph stack short.
    const haveOrtho = out.some(r => r.kind === 'horizontal' || r.kind === 'vertical');
    if (bestPar && !haveOrtho) out.push({ kind: 'parallel', refId: bestPar, note: '∥' });
    // ⊥ remains useful even with H/V (perpendicular to a non-axis line).
    if (bestPer)               out.push({ kind: 'perpendicular', refId: bestPer, note: '⊥' });
    if (bestEq)                out.push({ kind: 'equal-length', refId: bestEq, note: '=' });
    return out;
}

/**
 * Combine snap-derived inferences (vertex/midpoint/tangent/etc.) with the
 * geometric-comparison inferences (∥ / ⊥ / =). Returns a flat array of
 * `{ kind, note, refId? }` records suitable for the glyph layer.
 *
 * @param {object} snapResult — output of `snap(...)`
 * @param {{x:number,y:number}|null} anchor   — current draw anchor (line, etc.)
 * @param {{x:number,y:number}} cursor        — snapped cursor in sketch-local
 * @param {object} sketch
 * @param {object} [opts]                     — passed through to inferGeometricForLine
 */
export function inferDrawHints(snapResult, anchor, cursor, sketch, opts = {}) {
    const hints = [];
    if (snapResult) {
        switch (snapResult.kind) {
            case SNAP_KINDS.VERTEX:
                hints.push({ kind: 'coincident', note: '⊙' });
                break;
            case SNAP_KINDS.MIDPOINT:
                hints.push({ kind: 'midpoint', note: '●', refId: snapResult.extra?.lineId });
                break;
            case SNAP_KINDS.ON_LINE:
                hints.push({ kind: 'point-on-line', note: '|', refId: snapResult.extra?.lineId });
                break;
            case SNAP_KINDS.ON_CIRCLE:
                hints.push({ kind: 'point-on-circle', note: '○', refId: snapResult.extra?.circleId });
                break;
            case SNAP_KINDS.TANGENT:
                hints.push({ kind: 'tangent', note: 'T', refId: snapResult.extra?.circleId });
                break;
            case SNAP_KINDS.INTERSECT:
                hints.push({ kind: 'intersect', note: '×' });
                break;
            default:
                break;
        }
        // Ortho already implies horizontal/vertical, but the in-progress
        // line tool is the better source. We still surface a glyph for ortho
        // when there's no anchor-based source (e.g. the first click).
        if (!anchor && snapResult.kind === SNAP_KINDS.ORTHO) {
            const ax = snapResult.extra?.axis;
            hints.push({ kind: ax === 'h' ? 'horizontal' : 'vertical', note: ax === 'h' ? 'H' : 'V' });
        }
    }
    if (anchor) {
        const geo = inferGeometricForLine(anchor, cursor, sketch, opts);
        // Avoid duplicating coincident/etc. records, then concat.
        for (const g of geo) {
            // Filter dupes by kind + refId to keep the glyph row compact.
            const dup = hints.some(h => h.kind === g.kind && (h.refId || null) === (g.refId || null));
            if (!dup) hints.push(g);
        }
    }
    return hints;
}

/** Constraint-kind tags exported for callers that want to map note → CONSTRAINT_KIND. */
export const HINT_TO_CONSTRAINT_KIND = Object.freeze({
    'horizontal':       CONSTRAINT_KIND.HORIZONTAL,
    'vertical':         CONSTRAINT_KIND.VERTICAL,
    'parallel':         CONSTRAINT_KIND.PARALLEL,
    'perpendicular':    CONSTRAINT_KIND.PERPENDICULAR,
    'equal-length':     CONSTRAINT_KIND.EQUAL_LENGTH,
    'coincident':       CONSTRAINT_KIND.COINCIDENT,
    'midpoint':         CONSTRAINT_KIND.MIDPOINT,
    'point-on-line':    CONSTRAINT_KIND.POINT_ON_LINE,
    'point-on-circle':  CONSTRAINT_KIND.POINT_ON_CIRCLE,
    'tangent':          CONSTRAINT_KIND.TANGENT,
});
