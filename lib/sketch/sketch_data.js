/**
 * SketchData — the container that holds entities + constraints + metadata for
 * a single sketch. Pure data. JSON-serialisable.
 *
 * SketchData is the payload that becomes `Feature.params.sketch` when the
 * sketch is wrapped as a v4 Document feature (see feature.js). The Document
 * stores it inside the changelog like any other feature payload, so sketch
 * edits flow through `commit()`/`undo()`/`redo()` naturally.
 *
 * The container also tracks:
 *   - the planeRef (XY/XZ/YZ, a construction plane, or a face descriptor)
 *   - degrees-of-freedom & solver status from the most recent solve
 *   - the solver name and version (so we know which solver produced the
 *     current numeric state)
 */

import { newEntityId } from './entities.js';
import { validateEntity, referencedIds } from './entities.js';
import { validateConstraint } from './constraints.js';

// ── Solver-status enum (parallel to the existing JS solver) ──────────────────
export const SOLVE_STATUS = Object.freeze({
    UNSOLVED:      'unsolved',     // never run since last edit
    SOLVED:        'solved',       // converged
    UNDER:         'under',        // under-constrained (DOF > 0)
    OVER:          'over',         // conflicting/over-constrained
    CONFLICTING:   'conflicting',  // solver detected redundant or contradictory
    FAILED:        'failed',       // solver gave up (max iterations etc)
});

// ── Plane reference shapes ────────────────────────────────────────────────────
// A sketch lives on a plane. The planeRef is one of:
//   { kind: 'stock', name: 'XY' | 'XZ' | 'YZ', offset?: number }
//   { kind: 'construction', id: <constructionPlaneId> }
//   { kind: 'face', descriptor: Descriptor }     // sketch on a planar face
//
// `offset` (mm) shifts a stock plane along its own normal — e.g. Plane.XY with
// offset 20 sits at Z=20, so a profile sketched there lands on the top face of a
// 20mm-tall body instead of at the world origin.
export function stockPlane(name, offset = 0) {
    if (!['XY', 'XZ', 'YZ'].includes(name)) throw new Error(`stockPlane: bad name ${name}`);
    const o = Number(offset);
    return Object.freeze(
        Number.isFinite(o) && o !== 0 ? { kind: 'stock', name, offset: o } : { kind: 'stock', name },
    );
}
export function constructionPlane(id) {
    if (!id) throw new Error('constructionPlane: missing id');
    return Object.freeze({ kind: 'construction', id });
}
/**
 * Build a face-anchored plane reference.
 *
 * `descriptor` is the canonical name (so the planeRef survives regen).
 * `origin` / `normal` are optional pick-time caches: when present they let
 * the JS-side resolver build a real plane basis without re-querying the
 * kernel, and the emitter inlines a `Plane(origin=…, z_dir=…)` instead of
 * calling a kernel-side `resolve_face_plane`. The cache is treated as
 * informational — the descriptor stays the canonical identity.
 */
export function facePlane(descriptor, origin = null, normal = null) {
    if (!descriptor || descriptor.kind !== 'face') throw new Error('facePlane: needs a face descriptor');
    const ref = { kind: 'face', descriptor };
    if (Array.isArray(origin) && origin.length === 3) ref.origin = origin.slice();
    if (Array.isArray(normal) && normal.length === 3) ref.normal = normal.slice();
    return Object.freeze(ref);
}

// ── Sketch container factory ──────────────────────────────────────────────────
/**
 * Create a fresh empty SketchData on the given plane.
 *
 * @param {object} planeRef — from stockPlane / constructionPlane / facePlane
 * @param {object} [opts]
 * @param {string} [opts.id]
 * @param {string} [opts.name]
 */
export function makeSketchData(planeRef, { id = null, name = 'Sketch' } = {}) {
    if (!planeRef || !planeRef.kind) throw new Error('makeSketchData: missing planeRef');
    return {
        id:             id || newEntityId('sk'),
        name,
        planeRef,
        entities:       {},          // id → Entity (all frozen)
        entityOrder:    [],          // authored order — for UI display
        constraints:    {},          // id → Constraint (all frozen)
        constraintOrder:[],
        solveStatus:    SOLVE_STATUS.UNSOLVED,
        dof:            -1,          // populated post-solve; -1 = unknown
        solverInfo:     null,        // { name, version, iterations, residual, elapsedMs }
        warnings:       [],          // [{ severity, message, entityId? }]
        createdAt:      Date.now(),
        updatedAt:      Date.now(),
    };
}

// ── Entity operations ─────────────────────────────────────────────────────────

export function addEntity(sketch, entity) {
    validateEntity(entity);
    if (sketch.entities[entity.id]) {
        throw new Error(`addEntity: id collision ${entity.id}`);
    }
    // Verify any referenced ids already exist in the sketch.
    for (const ref of referencedIds(entity)) {
        if (!sketch.entities[ref]) {
            throw new Error(`addEntity: ${entity.kind} references missing entity ${ref}`);
        }
    }
    sketch.entities[entity.id] = entity;
    sketch.entityOrder.push(entity.id);
    sketch.updatedAt = Date.now();
    sketch.solveStatus = SOLVE_STATUS.UNSOLVED;
    return entity;
}

export function removeEntity(sketch, entityId) {
    if (!sketch.entities[entityId]) return false;
    // Cascade: also remove every entity that references this one, and every
    // constraint that mentions it. This keeps the sketch internally consistent
    // — leaving dangling references would crash the emitter.
    const cascade = new Set([entityId]);
    let changed = true;
    while (changed) {
        changed = false;
        for (const id of Object.keys(sketch.entities)) {
            if (cascade.has(id)) continue;
            const e = sketch.entities[id];
            for (const ref of referencedIds(e)) {
                if (cascade.has(ref)) { cascade.add(id); changed = true; break; }
            }
        }
    }
    for (const id of cascade) {
        delete sketch.entities[id];
        const idx = sketch.entityOrder.indexOf(id);
        if (idx >= 0) sketch.entityOrder.splice(idx, 1);
    }
    // Drop affected constraints
    for (const cid of Object.keys(sketch.constraints)) {
        const c = sketch.constraints[cid];
        if (c.entityIds.some(eid => cascade.has(eid))) {
            delete sketch.constraints[cid];
            const ci = sketch.constraintOrder.indexOf(cid);
            if (ci >= 0) sketch.constraintOrder.splice(ci, 1);
        }
    }
    sketch.updatedAt = Date.now();
    sketch.solveStatus = SOLVE_STATUS.UNSOLVED;
    return true;
}

/**
 * Replace an entity with one whose params have been patched. Used by both
 * the solver (to write back DOF results) and the UI (drag handles).
 */
export function patchEntity(sketch, entityId, paramPatch) {
    const e = sketch.entities[entityId];
    if (!e) throw new Error(`patchEntity: missing ${entityId}`);
    sketch.entities[entityId] = Object.freeze({
        ...e,
        params: Object.freeze({ ...e.params, ...paramPatch }),
    });
    sketch.updatedAt = Date.now();
    sketch.solveStatus = SOLVE_STATUS.UNSOLVED;
    return sketch.entities[entityId];
}

/** Toggle the construction flag on an entity. */
export function setConstruction(sketch, entityId, isConstruction) {
    const e = sketch.entities[entityId];
    if (!e) throw new Error(`setConstruction: missing ${entityId}`);
    sketch.entities[entityId] = Object.freeze({ ...e, construction: !!isConstruction });
    sketch.updatedAt = Date.now();
    return sketch.entities[entityId];
}

// ── Constraint operations ─────────────────────────────────────────────────────

export function addConstraint(sketch, constraint) {
    validateConstraint(constraint);
    if (sketch.constraints[constraint.id]) {
        throw new Error(`addConstraint: id collision ${constraint.id}`);
    }
    // Verify every referenced entity exists.
    for (const eid of constraint.entityIds) {
        if (!sketch.entities[eid]) {
            throw new Error(`addConstraint: references missing entity ${eid}`);
        }
    }
    sketch.constraints[constraint.id] = constraint;
    sketch.constraintOrder.push(constraint.id);
    sketch.updatedAt = Date.now();
    sketch.solveStatus = SOLVE_STATUS.UNSOLVED;
    return constraint;
}

export function removeConstraint(sketch, constraintId) {
    if (!sketch.constraints[constraintId]) return false;
    delete sketch.constraints[constraintId];
    const idx = sketch.constraintOrder.indexOf(constraintId);
    if (idx >= 0) sketch.constraintOrder.splice(idx, 1);
    sketch.updatedAt = Date.now();
    sketch.solveStatus = SOLVE_STATUS.UNSOLVED;
    return true;
}

/**
 * Mark / unmark a dimensional constraint as "driven" (reference-only).
 * Driven constraints are display-only: the solver SHOULD skip them when
 * computing residuals, but the constraint stays in the sketch so the UI
 * still renders its dimension chip. Use this for inspection dims.
 */
export function setConstraintDriven(sketch, constraintId, driven) {
    const c = sketch.constraints[constraintId];
    if (!c) throw new Error(`setConstraintDriven: missing ${constraintId}`);
    sketch.constraints[constraintId] = Object.freeze({ ...c, driven: !!driven });
    sketch.updatedAt = Date.now();
    return sketch.constraints[constraintId];
}

/** Patch the target value of a dimensional constraint. */
export function setConstraintValue(sketch, constraintId, value) {
    const c = sketch.constraints[constraintId];
    if (!c) throw new Error(`setConstraintValue: missing ${constraintId}`);
    sketch.constraints[constraintId] = Object.freeze({ ...c, value });
    sketch.updatedAt = Date.now();
    sketch.solveStatus = SOLVE_STATUS.UNSOLVED;
    return sketch.constraints[constraintId];
}

// ── Inspection ────────────────────────────────────────────────────────────────

export function entityCount(sketch)     { return sketch.entityOrder.length; }
export function constraintCount(sketch) { return sketch.constraintOrder.length; }

export function entitiesOrdered(sketch) {
    return sketch.entityOrder.map(id => sketch.entities[id]).filter(Boolean);
}
export function constraintsOrdered(sketch) {
    return sketch.constraintOrder.map(id => sketch.constraints[id]).filter(Boolean);
}

/** True iff the sketch has at least one closed loop suitable for extrude/revolve. */
export function hasClosedLoop(sketch) {
    // Any closed entity (Circle/Ellipse/Polygon/Rectangle/Slot/closed Spline) qualifies on its own.
    for (const e of Object.values(sketch.entities)) {
        if (e.construction) continue;
        if (['circle','ellipse','rectangle','polygon','slot-linear','slot-arc'].includes(e.kind)) return true;
        if (e.kind === 'spline' && e.params.closed) return true;
    }
    // Lines/arcs forming a closed chain — quick endpoint-coincidence check.
    // Build a multimap point-id → degree. Every endpoint must have even degree
    // (≥2). This is a necessary, not sufficient, condition — but a good
    // cheap heuristic for daily use.
    const degree = new Map();
    let hadLineOrArc = false;
    for (const e of Object.values(sketch.entities)) {
        if (e.construction) continue;
        if (e.kind === 'line') {
            hadLineOrArc = true;
            for (const id of [e.params.startId, e.params.endId]) {
                degree.set(id, (degree.get(id) || 0) + 1);
            }
        } else if (e.kind === 'arc') {
            hadLineOrArc = true;
            // Arc endpoints aren't stored as point ids in this model; treat the
            // arc as contributing to its centre-anchored "chain" via constraints.
            // For now, mark arc presence so the caller knows to look closer.
        }
    }
    if (!hadLineOrArc) return false;
    if (degree.size === 0) return false;
    for (const d of degree.values()) if (d < 2) return false;
    return true;
}

/**
 * Validate the entire sketch — referenced ids exist, constraints have valid
 * shape, no dangling references. Returns a list of issues; empty array = OK.
 */
export function validateSketch(sketch) {
    const issues = [];
    if (!sketch || !sketch.id) {
        issues.push({ severity: 'error', message: 'missing sketch id' });
        return issues;
    }
    for (const e of Object.values(sketch.entities)) {
        try { validateEntity(e); }
        catch (err) { issues.push({ severity: 'error', entityId: e.id, message: err.message }); }
        for (const ref of referencedIds(e)) {
            if (!sketch.entities[ref]) {
                issues.push({ severity: 'error', entityId: e.id, message: `dangling ref ${ref}` });
            }
        }
    }
    for (const c of Object.values(sketch.constraints)) {
        try { validateConstraint(c); }
        catch (err) { issues.push({ severity: 'error', message: `constraint ${c.id}: ${err.message}` }); }
        for (const eid of (c.entityIds || [])) {
            if (!sketch.entities[eid]) {
                issues.push({ severity: 'error', message: `constraint ${c.id} references missing entity ${eid}` });
            }
        }
    }
    return issues;
}
