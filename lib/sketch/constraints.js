/**
 * Sketch constraints — typed dimensional and geometric constraints.
 *
 * Each constraint is pure data: a `kind` from CONSTRAINT_KIND, the set of
 * entity-ids it constrains, and (for dimensional constraints) the target value
 * which may be a literal or an expression string referencing Document
 * parameters (e.g. `"=wall * 2 + 1"`).
 *
 * The constraint set is shared with the v3 solver (lib/sketch_solver.js) so
 * existing sketches migrate over without re-authoring. New constraint kinds
 * (SYMMETRIC, HORIZONTAL_DISTANCE, VERTICAL_DISTANCE, POINT_ON_LINE,
 * POINT_ON_CIRCLE, EQUAL_DISTANCE) are additive — they are no-ops in the v3
 * solver until the PlaneGCS swap lands.
 */

import { newEntityId } from './entities.js';

// ── Kinds ─────────────────────────────────────────────────────────────────────
export const CONSTRAINT_KIND = Object.freeze({
    // Geometric (no numeric target)
    COINCIDENT:         'coincident',          // point-point or point-on-entity
    HORIZONTAL:         'horizontal',          // line is horizontal
    VERTICAL:           'vertical',            // line is vertical
    PARALLEL:           'parallel',            // line ∥ line
    PERPENDICULAR:      'perpendicular',       // line ⊥ line
    TANGENT:            'tangent',             // line/arc tangent to circle/arc/ellipse
    EQUAL_LENGTH:       'equal-length',        // two lines equal
    EQUAL_RADIUS:       'equal-radius',        // two circles/arcs equal
    MIDPOINT:           'midpoint',            // point sits at midpoint of a line
    SYMMETRIC:          'symmetric',           // two entities symmetric about a line
    POINT_ON_LINE:      'point-on-line',       // point lies on line
    POINT_ON_CIRCLE:    'point-on-circle',     // point lies on circle/arc

    // Dimensional (numeric/expression target)
    FIXED_DISTANCE:     'fixed-distance',      // distance between two points (or line length)
    FIXED_ANGLE:        'fixed-angle',         // angle between two lines
    FIXED_RADIUS:       'fixed-radius',        // circle/arc radius
    FIXED_POINT:        'fixed-point',         // pin a point at given (x, y)
    HORIZONTAL_DISTANCE:'h-distance',          // x-difference between two points
    VERTICAL_DISTANCE:  'v-distance',          // y-difference between two points
    EQUAL_DISTANCE:     'equal-distance',      // two distances equal
});

const CONSTRAINT_KIND_SET = new Set(Object.values(CONSTRAINT_KIND));

/**
 * True iff `kind` carries a numeric/expression target in the `value` field.
 *
 * FIXED_POINT is *not* dimensional in this sense: its target lives in `extra`
 * (`{x, y}`) rather than `value`, because pinning a point in 2D requires two
 * numbers, not one. UI code that wants to know "does this constraint show an
 * editable scalar dimension?" should use `isDimensional`; code that wants to
 * know "does this constraint reduce DOF?" should treat FIXED_POINT as DOF-
 * reducing regardless.
 */
export function isDimensional(kind) {
    return (
        kind === CONSTRAINT_KIND.FIXED_DISTANCE      ||
        kind === CONSTRAINT_KIND.FIXED_ANGLE         ||
        kind === CONSTRAINT_KIND.FIXED_RADIUS        ||
        kind === CONSTRAINT_KIND.HORIZONTAL_DISTANCE ||
        kind === CONSTRAINT_KIND.VERTICAL_DISTANCE   ||
        kind === CONSTRAINT_KIND.EQUAL_DISTANCE
    );
}

// ── Factory ───────────────────────────────────────────────────────────────────
/**
 * Generic constraint factory. Callers should prefer the kind-specific helpers
 * (`coincident`, `parallel`, etc.) which assert the right arity and shape.
 *
 * @param {string} kind            — CONSTRAINT_KIND.*
 * @param {string[]} entityIds     — ids of the entities this constraint binds
 * @param {object} [opts]
 * @param {number|string|null} [opts.value]   — for dimensional constraints
 * @param {object} [opts.extra]               — any kind-specific extra fields
 */
export function makeConstraint(kind, entityIds, { value = null, extra = null, id = null } = {}) {
    if (!CONSTRAINT_KIND_SET.has(kind)) throw new Error(`makeConstraint: bad kind "${kind}"`);
    if (!Array.isArray(entityIds) || entityIds.some(x => !x)) {
        throw new Error('makeConstraint: bad entityIds');
    }
    if (isDimensional(kind) && value == null) {
        throw new Error(`makeConstraint: ${kind} requires a value`);
    }
    return Object.freeze({
        id: id || newEntityId('cn'),
        kind,
        entityIds: Object.freeze(entityIds.slice()),
        value,
        extra: extra ? Object.freeze({ ...extra }) : null,
    });
}

// ── Geometric helpers ─────────────────────────────────────────────────────────
export const coincident       = (idA, idB)               => makeConstraint(CONSTRAINT_KIND.COINCIDENT,    [idA, idB]);
export const horizontal       = (lineId)                 => makeConstraint(CONSTRAINT_KIND.HORIZONTAL,    [lineId]);
export const vertical         = (lineId)                 => makeConstraint(CONSTRAINT_KIND.VERTICAL,      [lineId]);
export const parallel         = (line1Id, line2Id)       => makeConstraint(CONSTRAINT_KIND.PARALLEL,      [line1Id, line2Id]);
export const perpendicular    = (line1Id, line2Id)       => makeConstraint(CONSTRAINT_KIND.PERPENDICULAR, [line1Id, line2Id]);
export const tangent          = (idA, idB)               => makeConstraint(CONSTRAINT_KIND.TANGENT,       [idA, idB]);
export const equalLength      = (line1Id, line2Id)       => makeConstraint(CONSTRAINT_KIND.EQUAL_LENGTH,  [line1Id, line2Id]);
export const equalRadius      = (cir1Id, cir2Id)         => makeConstraint(CONSTRAINT_KIND.EQUAL_RADIUS,  [cir1Id, cir2Id]);
export const midpoint         = (pointId, lineId)        => makeConstraint(CONSTRAINT_KIND.MIDPOINT,      [pointId, lineId]);
export const symmetric        = (idA, idB, mirrorLineId) => makeConstraint(CONSTRAINT_KIND.SYMMETRIC,     [idA, idB, mirrorLineId]);
export const pointOnLine      = (pointId, lineId)        => makeConstraint(CONSTRAINT_KIND.POINT_ON_LINE, [pointId, lineId]);
export const pointOnCircle    = (pointId, circleOrArcId) => makeConstraint(CONSTRAINT_KIND.POINT_ON_CIRCLE,[pointId, circleOrArcId]);

// ── Dimensional helpers ───────────────────────────────────────────────────────
export const fixedDistance    = (idA, idB, value)        => makeConstraint(CONSTRAINT_KIND.FIXED_DISTANCE,     [idA, idB], { value });
export const fixedAngle       = (line1Id, line2Id, value)=> makeConstraint(CONSTRAINT_KIND.FIXED_ANGLE,        [line1Id, line2Id], { value });
export const fixedRadius      = (circleId, value)        => makeConstraint(CONSTRAINT_KIND.FIXED_RADIUS,       [circleId], { value });
export const fixedPoint       = (pointId, x, y)          => makeConstraint(CONSTRAINT_KIND.FIXED_POINT,        [pointId], { value: null, extra: { x: +x, y: +y } });
export const horizontalDist   = (idA, idB, value)        => makeConstraint(CONSTRAINT_KIND.HORIZONTAL_DISTANCE,[idA, idB], { value });
export const verticalDist     = (idA, idB, value)        => makeConstraint(CONSTRAINT_KIND.VERTICAL_DISTANCE,  [idA, idB], { value });
export const equalDistance    = (idA, idB, idC, idD)     => makeConstraint(CONSTRAINT_KIND.EQUAL_DISTANCE,     [idA, idB, idC, idD], { value: 0 });

// ── Inspection ────────────────────────────────────────────────────────────────
export function isValidKind(kind) { return CONSTRAINT_KIND_SET.has(kind); }

/**
 * Validate a constraint's shape. Throws on the first violation.
 */
export function validateConstraint(c) {
    if (!c || !c.id) throw new Error('validateConstraint: missing id');
    if (!isValidKind(c.kind)) throw new Error(`validateConstraint: bad kind "${c.kind}"`);
    if (!Array.isArray(c.entityIds) || c.entityIds.length === 0) {
        throw new Error('validateConstraint: missing entityIds');
    }
    if (isDimensional(c.kind) && c.value == null && c.kind !== CONSTRAINT_KIND.FIXED_POINT) {
        throw new Error(`validateConstraint: ${c.kind} requires a value`);
    }
    // Arity check
    const expectedArity = ARITY[c.kind];
    if (expectedArity && c.entityIds.length !== expectedArity) {
        throw new Error(`validateConstraint: ${c.kind} expects ${expectedArity} entity ids, got ${c.entityIds.length}`);
    }
}

/** Required number of entity ids per constraint kind. Used by validateConstraint. */
const ARITY = Object.freeze({
    [CONSTRAINT_KIND.COINCIDENT]:         2,
    [CONSTRAINT_KIND.HORIZONTAL]:         1,
    [CONSTRAINT_KIND.VERTICAL]:           1,
    [CONSTRAINT_KIND.PARALLEL]:           2,
    [CONSTRAINT_KIND.PERPENDICULAR]:      2,
    [CONSTRAINT_KIND.TANGENT]:            2,
    [CONSTRAINT_KIND.EQUAL_LENGTH]:       2,
    [CONSTRAINT_KIND.EQUAL_RADIUS]:       2,
    [CONSTRAINT_KIND.MIDPOINT]:           2,
    [CONSTRAINT_KIND.SYMMETRIC]:          3,
    [CONSTRAINT_KIND.POINT_ON_LINE]:      2,
    [CONSTRAINT_KIND.POINT_ON_CIRCLE]:    2,
    [CONSTRAINT_KIND.FIXED_DISTANCE]:     2,
    [CONSTRAINT_KIND.FIXED_ANGLE]:        2,
    [CONSTRAINT_KIND.FIXED_RADIUS]:       1,
    [CONSTRAINT_KIND.FIXED_POINT]:        1,
    [CONSTRAINT_KIND.HORIZONTAL_DISTANCE]:2,
    [CONSTRAINT_KIND.VERTICAL_DISTANCE]:  2,
    [CONSTRAINT_KIND.EQUAL_DISTANCE]:     4,
});

/**
 * Did the constraint's target value reference a Document parameter?
 * The convention is the same as the rest of the document model: a string
 * prefixed with `=` is an expression (`"=wall * 2"`), anything else is a
 * literal number.
 */
export function isExpression(value) {
    return typeof value === 'string' && value.startsWith('=');
}
