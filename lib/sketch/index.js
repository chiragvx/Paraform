/**
 * lib/sketch — Phase 1C public surface.
 *
 * This module is the v4 sketch system: typed entities, typed constraints,
 * the SketchData container, the Document-feature bridge, and the build123d
 * emitter. The legacy `sketch_editor.js` + `sketch_solver.js` still drive
 * the live UI in main.js; this module is the replacement they will eventually
 * be wired through.
 *
 * Solver swap:
 *   The solver is intentionally NOT a member of this surface. The solver is
 *   pluggable behind `lib/sketch/solver.js` (next step) so the existing
 *   Newton+LM and the eventual PlaneGCS WASM live on the same interface.
 */

export {
    ENTITY_KIND,
    newEntityId,
    makePoint, makeLine, makeCircle, makeArc,
    makeEllipse, makeEllipticalArc, makeSpline,
    makeSlotLinear, makeSlotArc,
    makeRectangle, makePolygon, makeText,
    referencedIds, isValidKind as isValidEntityKind, validateEntity,
    withParams, isClosed,
} from './entities.js';

export {
    CONSTRAINT_KIND,
    makeConstraint,
    coincident, horizontal, vertical, parallel, perpendicular, tangent,
    equalLength, equalRadius, midpoint, symmetric,
    pointOnLine, pointOnCircle,
    fixedDistance, fixedAngle, fixedRadius, fixedPoint,
    horizontalDist, verticalDist, equalDistance,
    isDimensional, isExpression,
    isValidKind as isValidConstraintKind, validateConstraint,
} from './constraints.js';

export {
    SOLVE_STATUS,
    stockPlane, constructionPlane, facePlane,
    makeSketchData,
    addEntity, removeEntity, patchEntity, setConstruction,
    addConstraint, removeConstraint, setConstraintValue,
    entityCount, constraintCount, entitiesOrdered, constraintsOrdered,
    hasClosedLoop, validateSketch,
} from './sketch_data.js';

export {
    makeSketchFeature, sketchDataOf,
    addSketchChange, updateSketchChange,
    isSketchFeature,
} from './feature.js';

export {
    planeExpr, emitSketchPython, summarizeSketch,
} from './emit.js';

// Phase 1C — pluggable solver facade
export {
    solve as solveSketch,
    registerSolver, setSolver, getActiveSolver, availableSolvers,
    newtonSolver,
} from './solver/index.js';
