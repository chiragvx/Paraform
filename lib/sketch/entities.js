/**
 * Sketch entities — typed 2D primitives.
 *
 * Entities are pure data. Each carries an `id`, a `kind` from `ENTITY_KIND`,
 * a `construction` flag, and `params` whose schema depends on the kind.
 *
 * Cross-entity references use ids: a Line stores `{ startId, endId }` rather
 * than embedded point objects. This keeps mutations cheap (move a shared
 * point → every line referencing it follows) and lets the solver flatten
 * the entity set into a flat DOF vector without duplicating coordinates.
 *
 * Coordinate system: 2D, y-up. Angles in radians, CCW positive.
 * Units: millimetres (configurable per sketch via SketchData.units).
 *
 * Pure data. No DOM, no solver coupling.
 */

// ── Kinds ─────────────────────────────────────────────────────────────────────
export const ENTITY_KIND = Object.freeze({
    POINT:           'point',
    LINE:            'line',
    CIRCLE:          'circle',
    ARC:             'arc',
    ELLIPSE:         'ellipse',
    ELLIPTICAL_ARC:  'elliptical-arc',
    SPLINE:          'spline',
    SLOT_LINEAR:     'slot-linear',     // capsule between two centre points
    SLOT_ARC:        'slot-arc',        // arc-shaped slot
    RECTANGLE:       'rectangle',       // axis-aligned, expanded into 4 lines on commit
    POLYGON:         'polygon',         // regular N-gon
    TEXT:            'text',
});

const ENTITY_KIND_SET = new Set(Object.values(ENTITY_KIND));

// ── Id generation ─────────────────────────────────────────────────────────────
let _counter = 0;
const _now36 = () => Date.now().toString(36);

export function newEntityId(prefix = 'ent') {
    return `${prefix}_${_now36()}_${(++_counter).toString(36)}`;
}

// ── Factories ─────────────────────────────────────────────────────────────────
// All return frozen objects with predictable shapes. Callers should not mutate
// returned entities — use `withParams(e, patch)` to derive a new one.

/**
 * 2D point at (x, y).
 * @param {number} x
 * @param {number} y
 * @param {object} [opts]
 */
export function makePoint(x, y, { construction = false, id = null } = {}) {
    return Object.freeze({
        id: id || newEntityId('p'),
        kind: ENTITY_KIND.POINT,
        construction: !!construction,
        params: Object.freeze({ x: +x, y: +y }),
    });
}

/**
 * Line segment from `startId` to `endId`. Both must reference existing Points.
 */
export function makeLine(startId, endId, { construction = false, id = null } = {}) {
    if (!startId || !endId) throw new Error('makeLine: missing endpoint id');
    return Object.freeze({
        id: id || newEntityId('l'),
        kind: ENTITY_KIND.LINE,
        construction: !!construction,
        params: Object.freeze({ startId, endId }),
    });
}

/**
 * Full circle centred at `centerId` with `radius`.
 */
export function makeCircle(centerId, radius, { construction = false, id = null } = {}) {
    if (!centerId) throw new Error('makeCircle: missing centerId');
    if (!Number.isFinite(radius) || radius <= 0) throw new Error('makeCircle: bad radius');
    return Object.freeze({
        id: id || newEntityId('c'),
        kind: ENTITY_KIND.CIRCLE,
        construction: !!construction,
        params: Object.freeze({ centerId, radius: +radius }),
    });
}

/**
 * Arc centred at `centerId`, sweeping CCW from `startAngle` (rad) for
 * `sweepAngle` (rad). `sweepAngle` may be negative for CW arcs.
 */
export function makeArc(centerId, radius, startAngle, sweepAngle, { construction = false, id = null } = {}) {
    if (!centerId) throw new Error('makeArc: missing centerId');
    if (!Number.isFinite(radius) || radius <= 0) throw new Error('makeArc: bad radius');
    if (!Number.isFinite(startAngle)) throw new Error('makeArc: bad startAngle');
    if (!Number.isFinite(sweepAngle) || sweepAngle === 0) throw new Error('makeArc: bad sweepAngle');
    return Object.freeze({
        id: id || newEntityId('a'),
        kind: ENTITY_KIND.ARC,
        construction: !!construction,
        params: Object.freeze({ centerId, radius: +radius, startAngle: +startAngle, sweepAngle: +sweepAngle }),
    });
}

/**
 * Ellipse centred at `centerId`. `rotation` rotates the major axis from +X (rad).
 */
export function makeEllipse(centerId, majorRadius, minorRadius, rotation = 0, { construction = false, id = null } = {}) {
    if (!centerId) throw new Error('makeEllipse: missing centerId');
    if (!Number.isFinite(majorRadius) || majorRadius <= 0) throw new Error('makeEllipse: bad majorRadius');
    if (!Number.isFinite(minorRadius) || minorRadius <= 0) throw new Error('makeEllipse: bad minorRadius');
    return Object.freeze({
        id: id || newEntityId('el'),
        kind: ENTITY_KIND.ELLIPSE,
        construction: !!construction,
        params: Object.freeze({ centerId, majorRadius: +majorRadius, minorRadius: +minorRadius, rotation: +rotation }),
    });
}

/**
 * Elliptical arc — like an ellipse but bounded by a parametric range.
 * `startParam`/`endParam` are in radians (0..2π around the parametric ellipse).
 */
export function makeEllipticalArc(centerId, majorRadius, minorRadius, rotation, startParam, endParam, { construction = false, id = null } = {}) {
    if (!centerId) throw new Error('makeEllipticalArc: missing centerId');
    return Object.freeze({
        id: id || newEntityId('ela'),
        kind: ENTITY_KIND.ELLIPTICAL_ARC,
        construction: !!construction,
        params: Object.freeze({
            centerId,
            majorRadius: +majorRadius,
            minorRadius: +minorRadius,
            rotation: +rotation,
            startParam: +startParam,
            endParam: +endParam,
        }),
    });
}

/**
 * Cubic B-spline through control points (by id). `degree` defaults to 3.
 * `closed` makes a periodic spline (last control point connects to first).
 * If `knots` is omitted, the solver/emitter assigns a uniform clamped knot vector.
 */
export function makeSpline(controlPointIds, { degree = 3, closed = false, knots = null, construction = false, id = null } = {}) {
    if (!Array.isArray(controlPointIds) || controlPointIds.length < degree + 1) {
        throw new Error(`makeSpline: need at least ${degree + 1} control points for degree ${degree}`);
    }
    return Object.freeze({
        id: id || newEntityId('sp'),
        kind: ENTITY_KIND.SPLINE,
        construction: !!construction,
        params: Object.freeze({
            controlPointIds: Object.freeze(controlPointIds.slice()),
            degree: +degree,
            closed: !!closed,
            knots: knots ? Object.freeze(knots.slice()) : null,
        }),
    });
}

/**
 * Straight slot — capsule shape defined by two centre points and a radius.
 * The slot has two straight sides parallel to the centre line, capped by
 * semicircular arcs of `radius` at each end.
 */
export function makeSlotLinear(centerStartId, centerEndId, radius, { construction = false, id = null } = {}) {
    if (!centerStartId || !centerEndId) throw new Error('makeSlotLinear: missing centre id');
    if (!Number.isFinite(radius) || radius <= 0) throw new Error('makeSlotLinear: bad radius');
    return Object.freeze({
        id: id || newEntityId('slk'),
        kind: ENTITY_KIND.SLOT_LINEAR,
        construction: !!construction,
        params: Object.freeze({ centerStartId, centerEndId, radius: +radius }),
    });
}

/**
 * Arc slot — annular sector with semicircular caps.
 * The centre line follows an arc of `centerRadius` from `startAngle` for
 * `sweepAngle`; the slot has half-width `radius` perpendicular to that arc.
 */
export function makeSlotArc(centerId, centerRadius, startAngle, sweepAngle, radius, { construction = false, id = null } = {}) {
    if (!centerId) throw new Error('makeSlotArc: missing centerId');
    if (!Number.isFinite(radius) || radius <= 0) throw new Error('makeSlotArc: bad radius');
    return Object.freeze({
        id: id || newEntityId('sla'),
        kind: ENTITY_KIND.SLOT_ARC,
        construction: !!construction,
        params: Object.freeze({
            centerId,
            centerRadius: +centerRadius,
            startAngle: +startAngle,
            sweepAngle: +sweepAngle,
            radius: +radius,
        }),
    });
}

/**
 * Axis-aligned rectangle defined by two opposite corner points.
 * Expanded into 4 lines + auto H/V constraints during emit (see commit-rect tool).
 */
export function makeRectangle(cornerStartId, cornerEndId, { construction = false, id = null } = {}) {
    if (!cornerStartId || !cornerEndId) throw new Error('makeRectangle: missing corner id');
    return Object.freeze({
        id: id || newEntityId('rect'),
        kind: ENTITY_KIND.RECTANGLE,
        construction: !!construction,
        params: Object.freeze({ cornerStartId, cornerEndId }),
    });
}

/**
 * Regular N-sided polygon. `inscribed: true` means the polygon's vertices
 * lie on the circle of `radius`; `false` (default) circumscribes the circle
 * (the inscribed circle is tangent to each side).
 */
export function makePolygon(centerId, radius, sides, { rotation = 0, inscribed = false, construction = false, id = null } = {}) {
    if (!centerId) throw new Error('makePolygon: missing centerId');
    if (!Number.isFinite(radius) || radius <= 0) throw new Error('makePolygon: bad radius');
    if (!Number.isInteger(sides) || sides < 3) throw new Error('makePolygon: sides must be ≥ 3');
    return Object.freeze({
        id: id || newEntityId('poly'),
        kind: ENTITY_KIND.POLYGON,
        construction: !!construction,
        params: Object.freeze({ centerId, radius: +radius, sides: sides|0, rotation: +rotation, inscribed: !!inscribed }),
    });
}

/**
 * Sketch text. Positioned by an anchor point; `alignment` ∈ {'left','center','right'}.
 */
export function makeText(positionId, text, height, { font = 'sans', alignment = 'left', construction = false, id = null } = {}) {
    if (!positionId) throw new Error('makeText: missing positionId');
    if (!Number.isFinite(height) || height <= 0) throw new Error('makeText: bad height');
    return Object.freeze({
        id: id || newEntityId('txt'),
        kind: ENTITY_KIND.TEXT,
        construction: !!construction,
        params: Object.freeze({ positionId, text: String(text), height: +height, font, alignment }),
    });
}

// ── Inspection ────────────────────────────────────────────────────────────────

/**
 * Return every entity id that `entity` directly references.
 * Used by the constraint solver and the cascade-delete tool.
 */
export function referencedIds(entity) {
    if (!entity) return [];
    const p = entity.params || {};
    switch (entity.kind) {
        case ENTITY_KIND.POINT:           return [];
        case ENTITY_KIND.LINE:            return [p.startId, p.endId];
        case ENTITY_KIND.CIRCLE:          return [p.centerId];
        case ENTITY_KIND.ARC:             return [p.centerId];
        case ENTITY_KIND.ELLIPSE:         return [p.centerId];
        case ENTITY_KIND.ELLIPTICAL_ARC:  return [p.centerId];
        case ENTITY_KIND.SPLINE:          return p.controlPointIds ? p.controlPointIds.slice() : [];
        case ENTITY_KIND.SLOT_LINEAR:     return [p.centerStartId, p.centerEndId];
        case ENTITY_KIND.SLOT_ARC:        return [p.centerId];
        case ENTITY_KIND.RECTANGLE:       return [p.cornerStartId, p.cornerEndId];
        case ENTITY_KIND.POLYGON:         return [p.centerId];
        case ENTITY_KIND.TEXT:            return [p.positionId];
        default:                          return [];
    }
}

/** True iff `kind` names a valid entity kind. */
export function isValidKind(kind) { return ENTITY_KIND_SET.has(kind); }

/** Validate a single entity's shape. Throws on the first violation. */
export function validateEntity(entity) {
    if (!entity || !entity.id) throw new Error('validateEntity: missing id');
    if (!isValidKind(entity.kind)) throw new Error(`validateEntity: bad kind "${entity.kind}"`);
    if (!entity.params || typeof entity.params !== 'object') throw new Error('validateEntity: missing params');
}

/**
 * Build a new entity by patching the params of an existing one. Returns a
 * fresh frozen entity; the original is untouched.
 */
export function withParams(entity, patch) {
    validateEntity(entity);
    return Object.freeze({
        ...entity,
        params: Object.freeze({ ...entity.params, ...patch }),
    });
}

/** True iff the entity is closed (a Circle, Ellipse, closed Spline, etc.) */
export function isClosed(entity) {
    if (!entity) return false;
    switch (entity.kind) {
        case ENTITY_KIND.CIRCLE:
        case ENTITY_KIND.ELLIPSE:
        case ENTITY_KIND.RECTANGLE:
        case ENTITY_KIND.POLYGON:
        case ENTITY_KIND.SLOT_LINEAR:
        case ENTITY_KIND.SLOT_ARC:
            return true;
        case ENTITY_KIND.SPLINE:
            return !!entity.params.closed;
        default:
            return false;
    }
}
