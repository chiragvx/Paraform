/**
 * Sketch → build123d Python source emitter.
 *
 * Given a SketchData payload + planeRef, produce Python that builds the
 * corresponding `BuildSketch` context. The emitted source is wrapped by the
 * harness into a callable that returns the resulting sketch object.
 *
 * Generated names:
 *   sk_<sketchId>             — the final sketch object (BuildSketch.sketch)
 *   p_<paramName>             — Document parameter (caller's responsibility)
 *
 * The emitter knows about every entity kind in lib/sketch/entities.js and
 * produces build123d-compatible primitives. Constraints are **not** emitted
 * — the solver runs on the JS side and writes the resolved coordinates back
 * into the entity params before this emitter runs. Sketch geometry that
 * reaches the kernel is always fully constrained or fixed.
 */

import { ENTITY_KIND, isClosed } from './entities.js';

// ── Value coercion ────────────────────────────────────────────────────────────

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Render a JS value as Python source. Strings starting with `=` are raw exprs. */
function py(v) {
    if (v === null || v === undefined) return 'None';
    if (typeof v === 'boolean') return v ? 'True' : 'False';
    if (typeof v === 'number')  return Number.isFinite(v) ? String(v) : '0';
    if (typeof v === 'string')  {
        if (v.startsWith('=')) return v.slice(1);   // raw expression (parameter ref)
        return JSON.stringify(v);
    }
    if (Array.isArray(v)) return `[${v.map(py).join(', ')}]`;
    return JSON.stringify(v);
}

/** Convert a planeRef into a build123d `Plane` expression. */
export function planeExpr(planeRef) {
    if (!planeRef || !planeRef.kind) return 'Plane.XY';
    if (planeRef.kind === 'stock') {
        const base = `Plane.${planeRef.name}`;
        // An offset shifts the plane along its own normal (Plane.XY.offset(20) → Z=20)
        // so the profile lands on/relative to an existing body, not at the origin.
        return planeRef.offset ? `${base}.offset(${py(planeRef.offset)})` : base;
    }
    // Construction planes are emitted as `pl_<id>` by the document Plane emitter
    // (lib/document/emit.js); reference that variable, NOT `p_<id>` (which is the
    // document-parameter namespace).
    if (planeRef.kind === 'construction') return `pl_${planeRef.id}`;
    if (planeRef.kind === 'face') {
        // Phase 1: if the picker cached origin + normal at pick time, emit
        // an inline build123d `Plane(origin=…, z_dir=…)`. This works with
        // the existing kernel without requiring a `resolve_face_plane`
        // helper. The descriptor stays on the planeRef for future
        // regen-safe resolution, but isn't read by the emitter today.
        if (Array.isArray(planeRef.origin) && Array.isArray(planeRef.normal)) {
            const o = planeRef.origin, n = planeRef.normal;
            return `Plane(origin=Vector(${py(o[0])}, ${py(o[1])}, ${py(o[2])}), z_dir=Vector(${py(n[0])}, ${py(n[1])}, ${py(n[2])}))`;
        }
        // Fallback: descriptor-based kernel resolver (not shipped yet).
        const descStr = stringifyDescriptor(planeRef.descriptor);
        return `resolve_face_plane(${py(descStr)})`;
    }
    return 'Plane.XY';
}

/** Local cheap mirror of lib/document/descriptor.js `stringify` — kept here
 *  to avoid a circular import. Must stay in sync with that file's format. */
function stringifyDescriptor(d) {
    if (!d || !d.kind) throw new Error('emit: face plane missing descriptor');
    const head = `${d.kind}:${d.feature}:${d.opTag}:${d.part}`;
    if (d.parents && d.parents.length) {
        return head + '(' + d.parents.map(stringifyDescriptor).join(',') + ')';
    }
    return head;
}

// ── Per-entity emitters ───────────────────────────────────────────────────────
// Each returns a Python expression that evaluates to a single primitive
// suitable for use inside a `BuildSketch` `with` block.

function pointXY(sketch, pointId) {
    const p = sketch.entities[pointId];
    if (!p || p.kind !== ENTITY_KIND.POINT) {
        throw new Error(`emit: pointXY missing point ${pointId}`);
    }
    return [num(p.params.x), num(p.params.y)];
}

const EMITTERS = {

    [ENTITY_KIND.POINT](sketch, e) {
        const [x, y] = pointXY(sketch, e.id);
        // Standalone points become Locations — build123d doesn't have a
        // first-class sketch-point. Emit only if the point isn't used as
        // an anchor by another entity (the call site filters those out).
        return `Locations((${py(x)}, ${py(y)}))`;
    },

    [ENTITY_KIND.LINE](sketch, e) {
        const a = pointXY(sketch, e.params.startId);
        const b = pointXY(sketch, e.params.endId);
        return `Line((${py(a[0])}, ${py(a[1])}), (${py(b[0])}, ${py(b[1])}))`;
    },

    [ENTITY_KIND.CIRCLE](sketch, e) {
        const c = pointXY(sketch, e.params.centerId);
        return `Circle(${py(e.params.radius)}, align=(Align.CENTER, Align.CENTER))` +
               `.locate(Location((${py(c[0])}, ${py(c[1])})))`;
    },

    [ENTITY_KIND.ARC](sketch, e) {
        const c = pointXY(sketch, e.params.centerId);
        return `CenterArc((${py(c[0])}, ${py(c[1])}), ${py(e.params.radius)}, ` +
               `${py(rad2deg(e.params.startAngle))}, ${py(rad2deg(e.params.sweepAngle))})`;
    },

    [ENTITY_KIND.ELLIPSE](sketch, e) {
        const c = pointXY(sketch, e.params.centerId);
        return `Ellipse(${py(e.params.majorRadius)}, ${py(e.params.minorRadius)})` +
               `.rotate(Axis.Z, ${py(rad2deg(e.params.rotation))})` +
               `.locate(Location((${py(c[0])}, ${py(c[1])})))`;
    },

    [ENTITY_KIND.ELLIPTICAL_ARC](sketch, e) {
        const c = pointXY(sketch, e.params.centerId);
        return `EllipticalCenterArc((${py(c[0])}, ${py(c[1])}), ${py(e.params.majorRadius)}, ${py(e.params.minorRadius)}, ` +
               `${py(rad2deg(e.params.startParam))}, ${py(rad2deg(e.params.endParam))}, ` +
               `rotation=${py(rad2deg(e.params.rotation))})`;
    },

    [ENTITY_KIND.SPLINE](sketch, e) {
        const pts = (e.params.controlPointIds || []).map(id => pointXY(sketch, id));
        const ptStr = pts.map(([x, y]) => `(${py(x)}, ${py(y)})`).join(', ');
        return `Spline([${ptStr}])`;
    },

    [ENTITY_KIND.SLOT_LINEAR](sketch, e) {
        const a = pointXY(sketch, e.params.centerStartId);
        const b = pointXY(sketch, e.params.centerEndId);
        const dx = b[0] - a[0], dy = b[1] - a[1];
        const length = Math.hypot(dx, dy);
        const angleDeg = rad2deg(Math.atan2(dy, dx));
        const cx = (a[0] + b[0]) / 2;
        const cy = (a[1] + b[1]) / 2;
        return `SlotCenterToCenter(${py(length)}, ${py(2 * e.params.radius)})` +
               `.rotate(Axis.Z, ${py(angleDeg)})` +
               `.locate(Location((${py(cx)}, ${py(cy)})))`;
    },

    [ENTITY_KIND.SLOT_ARC](sketch, e) {
        const c = pointXY(sketch, e.params.centerId);
        return `SlotArc(arc=CenterArc((${py(c[0])}, ${py(c[1])}), ${py(e.params.centerRadius)}, ` +
               `${py(rad2deg(e.params.startAngle))}, ${py(rad2deg(e.params.sweepAngle))}), ` +
               `height=${py(2 * e.params.radius)})`;
    },

    [ENTITY_KIND.RECTANGLE](sketch, e) {
        const a = pointXY(sketch, e.params.cornerStartId);
        const b = pointXY(sketch, e.params.cornerEndId);
        const w = Math.abs(b[0] - a[0]);
        const h = Math.abs(b[1] - a[1]);
        const cx = (a[0] + b[0]) / 2;
        const cy = (a[1] + b[1]) / 2;
        return `Rectangle(${py(w)}, ${py(h)}, align=(Align.CENTER, Align.CENTER))` +
               `.locate(Location((${py(cx)}, ${py(cy)})))`;
    },

    [ENTITY_KIND.POLYGON](sketch, e) {
        const c = pointXY(sketch, e.params.centerId);
        // build123d's RegularPolygon: `major_radius=True` (default) → radius is to
        // the corners (i.e. *circumscribes* the polygon around the inscribed
        // circle); `major_radius=False` → radius is to the side midpoints
        // (the polygon is *inscribed* in the radius circle). Our `inscribed`
        // flag means "vertices on the circle of `radius`" which is the
        // `major_radius=True` case.
        const majorRadius = e.params.inscribed ? 'True' : 'False';
        return `RegularPolygon(${py(e.params.radius)}, ${py(e.params.sides|0)}, ` +
               `major_radius=${majorRadius}, rotation=${py(rad2deg(e.params.rotation))})` +
               `.locate(Location((${py(c[0])}, ${py(c[1])})))`;
    },

    [ENTITY_KIND.TEXT](sketch, e) {
        const pos = pointXY(sketch, e.params.positionId);
        const alignMap = { left: '(Align.MIN, Align.CENTER)', center: '(Align.CENTER, Align.CENTER)', right: '(Align.MAX, Align.CENTER)' };
        const align = alignMap[e.params.alignment] || alignMap.left;
        return `Text(${py(e.params.text)}, font_size=${py(e.params.height)}, ` +
               `font=${py(e.params.font)}, align=${align})` +
               `.locate(Location((${py(pos[0])}, ${py(pos[1])})))`;
    },
};

// ── Top-level emitter ────────────────────────────────────────────────────────

/**
 * Emit Python source that builds a single sketch on its declared plane.
 * The output is a `with BuildSketch(...) as sk_<id>:` block followed by
 * one statement per non-construction entity. Construction entities and bare
 * points referenced by other entities are omitted (their coords are inlined).
 *
 * @param {object} sketchData
 * @returns {string} Python source
 */
export function emitSketchPython(sketchData) {
    if (!sketchData) throw new Error('emitSketchPython: missing sketchData');
    const plane = planeExpr(sketchData.planeRef);

    // Determine which points are "bare" (not referenced by any other entity)
    // — only bare points need their own emit statement. Anchor points used by
    // lines/arcs/etc. are inlined directly into those emitters.
    const referencedPoints = new Set();
    for (const e of Object.values(sketchData.entities)) {
        if (e.kind === ENTITY_KIND.POINT) continue;
        const params = e.params || {};
        for (const key of Object.keys(params)) {
            if (key.endsWith('Id') && typeof params[key] === 'string') {
                referencedPoints.add(params[key]);
            }
            if (key === 'controlPointIds' && Array.isArray(params[key])) {
                for (const id of params[key]) referencedPoints.add(id);
            }
        }
    }

    // Partition entities. build123d treats Line/Arc/Spline as "edge" primitives
    // that must be wrapped in a `BuildLine` sub-context whose result is then
    // closed into a face with `make_face()`. Closed primitives (Rectangle,
    // Circle, Polygon, Slot, Ellipse) emit directly inside BuildSketch.
    const EDGE_KINDS = new Set([ENTITY_KIND.LINE, ENTITY_KIND.ARC, ENTITY_KIND.SPLINE,
                                ENTITY_KIND.ELLIPTICAL_ARC]);
    const closedExprs = [];
    const edgeExprs   = [];
    for (const id of sketchData.entityOrder) {
        const e = sketchData.entities[id];
        if (!e || e.construction) continue;
        if (e.kind === ENTITY_KIND.POINT && referencedPoints.has(id)) continue;
        const fn = EMITTERS[e.kind];
        if (!fn) continue;
        const expr = fn(sketchData, e);
        if (EDGE_KINDS.has(e.kind)) edgeExprs.push(expr);
        else                        closedExprs.push(expr);
    }

    const lines = [];
    lines.push(`with BuildSketch(${plane}) as sk_${sketchData.id}:`);
    for (const expr of closedExprs) lines.push(`    ${expr}`);
    if (edgeExprs.length) {
        lines.push(`    with BuildLine():`);
        for (const expr of edgeExprs) lines.push(`        ${expr}`);
        lines.push(`    make_face()`);
    }
    if (!closedExprs.length && !edgeExprs.length) lines.push(`    pass`);
    return lines.join('\n');
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function rad2deg(r) { return r * 180 / Math.PI; }

/**
 * For previews / debugging: render the sketch as a structured summary string.
 * Useful for snapshot testing without committing to a brittle Python diff.
 */
export function summarizeSketch(sketchData) {
    const counts = {};
    for (const e of Object.values(sketchData.entities)) {
        counts[e.kind] = (counts[e.kind] || 0) + 1;
    }
    const parts = [`sketch[${sketchData.entityOrder.length}]`];
    for (const [k, n] of Object.entries(counts).sort()) parts.push(`${k}=${n}`);
    if (sketchData.constraintOrder.length) parts.push(`constraints=${sketchData.constraintOrder.length}`);
    return parts.join(' ');
}

// Re-export — handy for external callers that want to render a planeRef without
// dragging in the full emitter.
export { isClosed };
