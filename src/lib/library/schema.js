/**
 * Spec 18 v1 — component library schema.
 *
 * A PartRecord is the on-disk shape of every atomic / composite library
 * entry under `src/lib/library/parts/` and `.../composite/`. The loader
 * (`./index.js`) reads these via `import.meta.glob` at build time;
 * the snap-mate solver and AI fetch hook consume them at runtime.
 *
 * Atomic vs composite:
 *   - Atomic     — single body (parametric snippet, GLB, or wraps a
 *                  standard-parts catalog entry). `members` is omitted.
 *   - Composite  — built by placing other PartRecords with mate
 *                  transforms. `members` is required; `build` is null.
 *
 * Categories (closed set for v1):
 *   fastener, nut, washer, standoff, bracket, bearing, pulley, rail, misc.
 *
 * Connectors are *always* defined in the part's local frame (mm). On
 * placement, the mate solver lifts them into world coordinates via the
 * component's transform.
 *
 * Connector interface contracts (Phase 2):
 *   Each connector entry MAY additionally carry two optional string fields
 *   used by `replaceComponent` (swap-with-rebind) and by the mate solver:
 *
 *     role        — a stable, part-author-chosen name for what this connector
 *                   *does* on the part, e.g. "mount-pattern", "output-shaft",
 *                   "horn-spline". Roles are matched first when re-binding a
 *                   swapped part: a new part connector with the same `role`
 *                   inherits the old mate. Free-form; no closed vocabulary.
 *
 *     interfaceId — a standardized compatibility id shared across parts that
 *                   physically interchange, e.g. "servo-mount-9g" (SG90 +
 *                   MG90S), "servo-mount-standard" (MG996R), "spline-25T".
 *                   When BOTH connectors in a candidate mate declare an
 *                   interfaceId, compatibility is decided *solely* by id
 *                   equality (see mate_solver.connectorsCompatible) — this
 *                   takes precedence over the kind/gender/size heuristic.
 *
 *   Both fields are optional. Connectors without them behave exactly as
 *   before (kind/gender/size compatibility), so existing parts/tests are
 *   unaffected.
 */

export const PART_CATEGORIES = Object.freeze([
    'fastener', 'nut', 'washer', 'standoff', 'bracket',
    'bearing',  'pulley', 'rail',  'extrusion', 'misc',
]);

export const PART_SOURCES = Object.freeze([
    'parametric', 'glb', 'standard-part', 'composite',
]);

// Port model v2 — closed sets for the optional richer-mating connector fields.
export const PORT_TOPOLOGIES = Object.freeze([
    'point', 'axis', 'line', 'plane', 'grid',
]);
export const PORT_FITS = Object.freeze([
    'clearance', 'transition', 'press', 'detent', 'thread',
]);

/**
 * Defensive validator — returns `{ ok, errors }`. Used by tests and by
 * the loader for a load-time sanity pass. Not on the hot path.
 *
 * @param {object} rec
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validatePartRecord(rec) {
    const errors = [];
    if (!rec || typeof rec !== 'object') {
        return { ok: false, errors: ['not an object'] };
    }
    if (typeof rec.id !== 'string' || !rec.id) errors.push('missing id');
    if (typeof rec.name !== 'string' || !rec.name) errors.push('missing name');
    if (!PART_CATEGORIES.includes(rec.category)) {
        errors.push(`bad category: ${rec.category}`);
    }
    if (!PART_SOURCES.includes(rec.source)) {
        errors.push(`bad source: ${rec.source}`);
    }
    if (!Array.isArray(rec.connectors)) {
        errors.push('connectors must be an array');
    } else {
        // Interface-contract fields (Phase 2) are optional, but if present
        // must be strings. We don't require them — connectors without them
        // fall back to kind/gender/size compatibility.
        for (const c of rec.connectors) {
            if (!c || typeof c !== 'object') continue;
            if (c.role !== undefined && typeof c.role !== 'string') {
                errors.push(`connector ${c.id || '?'}: role must be a string`);
            }
            if (c.interfaceId !== undefined && typeof c.interfaceId !== 'string') {
                errors.push(`connector ${c.id || '?'}: interfaceId must be a string`);
            }
            // Port model v2 — optional richer-mating fields (see schema.js head).
            if (c.topology !== undefined && !PORT_TOPOLOGIES.includes(c.topology)) {
                errors.push(`connector ${c.id || '?'}: bad topology ${c.topology}`);
            }
            if (c.fit !== undefined && !PORT_FITS.includes(c.fit)) {
                errors.push(`connector ${c.id || '?'}: bad fit ${c.fit}`);
            }
            if (c.profile !== undefined && typeof c.profile !== 'string') {
                errors.push(`connector ${c.id || '?'}: profile must be a string`);
            }
            if (c.normal !== undefined && (!Array.isArray(c.normal) || c.normal.length !== 3)) {
                errors.push(`connector ${c.id || '?'}: normal must be a 3-vector`);
            }
            if (c.extent !== undefined && (typeof c.extent !== 'object' || c.extent === null ||
                typeof c.extent.from !== 'number' || typeof c.extent.to !== 'number')) {
                errors.push(`connector ${c.id || '?'}: extent must be { from, to }`);
            }
        }
    }
    if (!Array.isArray(rec.tags))     errors.push('tags must be an array');
    if (!Array.isArray(rec.keywords)) errors.push('keywords must be an array');
    if (rec.source === 'composite') {
        if (!Array.isArray(rec.members) || rec.members.length === 0) {
            errors.push('composite needs members[]');
        }
    }
    if (rec.boundingBox) {
        const bb = rec.boundingBox;
        if (!Array.isArray(bb.min) || bb.min.length !== 3) errors.push('bbox.min');
        if (!Array.isArray(bb.max) || bb.max.length !== 3) errors.push('bbox.max');
    }
    return { ok: errors.length === 0, errors };
}

/**
 * Build a default identity transform for a composite member, in the
 * shape the placeLibraryPart op expects.
 */
export function memberTransform({
    position = [0, 0, 0],
    rotation = [0, 0, 0],
    scale    = [1, 1, 1],
} = {}) {
    return {
        position: position.slice(),
        rotation: rotation.slice(),
        scale:    scale.slice(),
    };
}
