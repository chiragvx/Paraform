/**
 * Constraint → ops mapper. Pure function. Layer between the deterministic
 * extractor (spec 15) and the document operation layer (lib/document/operations.js).
 *
 * Input: an `ExtractResult` (or just its `constraints[]`) as produced by
 * `src/lib/extractor/index.js`.
 *
 * Output: an op-list — plain JSON descriptors of the form:
 *
 *   { kind: 'addBox',         params: { length, width, height, centered } }
 *   { kind: 'addCylinder',    params: { radius, height, centered } }
 *   { kind: 'addStandardPart',params: { entryId, qty } }
 *   { kind: 'setMaterial',    params: { material, grade, target } }
 *   { kind: 'setProcess',     params: { process } }
 *   { kind: 'setFitClass',    params: { class, between } }
 *   { kind: 'setTolerance',   params: { target, plus, minus, unit } }
 *
 * The mapper is intentionally conservative — it never invents values the
 * extractor didn't give it. Anything that can't be mapped flows back as
 * `unmapped[]` so the repair loop can decide whether to escalate.
 *
 * The mapper is pure and side-effect-free; the loop applies the ops via
 * `applyOps()` (see ./loop.js).
 */

import { CONSTRAINT_KIND, DIMENSION_AXIS } from '../extractor/types.js';
import { findPart as _findPart } from '../library/index.js';

/**
 * Spec 18 library fallback — pure / synchronous. Tries to match a
 * PartSelection constraint against the library by joining the
 * constraint's `catalogPrefix`, `nominalSize`, and `length` into a
 * search string and asking `findPart`. Returns the top PartRecord or
 * null. If the library isn't loaded yet (`loadLibrary` not awaited),
 * `findPart` returns an empty array and the fallback bails out cleanly.
 */
function _libraryFallback(constraint) {
    const parts = [];
    if (constraint.nominalSize) parts.push(String(constraint.nominalSize));
    if (constraint.length)      parts.push(String(constraint.length));
    if (constraint.role)        parts.push(String(constraint.role));
    if (constraint.catalogPrefix) parts.push(String(constraint.catalogPrefix));
    const q = parts.join(' ');
    try {
        const hits = _findPart(q);
        if (hits && hits.length > 0) return hits[0].part;
    } catch { /* ignore */ }
    return null;
}

const MM_PER_INCH = 25.4;

function toMm(value, unit) {
    if (!Number.isFinite(value)) return null;
    if (!unit || unit === 'mm') return value;
    if (unit === 'in' || unit === 'inch') return value * MM_PER_INCH;
    if (unit === 'cm') return value * 10;
    if (unit === 'm') return value * 1000;
    return value; // unknown unit — pass through; caller can flag
}

/**
 * Project a flat list of `DimensionConstraint` records into a box-like
 * {length, width, height} triple, ignoring any non-XYZ dimensions
 * (diameter, pitch, etc.). Returns `null` if fewer than two of {L,W,H}
 * are present (then we don't have enough to ship a box).
 */
function collectBoxDims(dims) {
    const acc = { length: null, width: null, height: null };
    const unlabelled = [];
    for (const d of dims) {
        const mm = toMm(d.value, d.unit);
        if (!Number.isFinite(mm)) continue;
        switch (d.axis) {
            case DIMENSION_AXIS.LENGTH:    acc.length = mm; break;
            case DIMENSION_AXIS.WIDTH:     acc.width  = mm; break;
            case DIMENSION_AXIS.HEIGHT:    acc.height = mm; break;
            case DIMENSION_AXIS.THICKNESS: acc.height = acc.height ?? mm; break;
            case DIMENSION_AXIS.DEPTH:     acc.height = acc.height ?? mm; break;
            case null:
            case undefined:
                unlabelled.push(mm); break;
            default: break; // ignore diameter/radius/etc.
        }
    }
    // Fill missing slots in L→W→H order from unlabelled scalars (e.g.
    // "60×40×3 mm" parses as three unlabelled dims).
    if (unlabelled.length >= 3 && acc.length == null && acc.width == null && acc.height == null) {
        return { length: unlabelled[0], width: unlabelled[1], height: unlabelled[2] };
    }
    const filled = Object.values(acc).filter((v) => v != null).length;
    if (filled < 2) return null;
    // If only two filled, default the missing one to the smallest (plate).
    if (acc.length == null) acc.length = unlabelled[0] ?? acc.width  ?? acc.height;
    if (acc.width  == null) acc.width  = unlabelled[0] ?? acc.length ?? acc.height;
    if (acc.height == null) acc.height = unlabelled[0] ?? Math.min(acc.length, acc.width);
    return acc;
}

/**
 * Extract a single diameter dimension (mm), if present.
 */
function findDiameter(dims) {
    for (const d of dims) {
        if (d.axis === DIMENSION_AXIS.DIAMETER) return toMm(d.value, d.unit);
        if (d.axis === DIMENSION_AXIS.RADIUS) {
            const r = toMm(d.value, d.unit);
            return r == null ? null : r * 2;
        }
    }
    return null;
}

/**
 * Decide an entryId for a part-selection constraint. We follow the
 * extractor's `catalogPrefix` + `nominalSize` + optional `length`.
 * E.g. iso4762 + M3 + 16 → 'iso4762-m3-16'. Bearing 608 → 'bearing-608'.
 */
function entryIdFor(part) {
    const { catalogPrefix, nominalSize, length } = part;
    const size = String(nominalSize || '').toLowerCase();
    if (!catalogPrefix || !size) return null;
    if (length != null && Number.isFinite(Number(length))) {
        return `${catalogPrefix}-${size}-${length}`;
    }
    return `${catalogPrefix}-${size}`;
}

/**
 * Top-level mapper. Returns:
 *
 *   {
 *     ops:        Op[],                  // ordered op-list to apply
 *     unmapped:   Constraint[],          // constraints we couldn't map
 *     coverage:   { mapped: n, total: m },
 *   }
 *
 * Order of emitted ops:
 *   1. addBox / addCylinder / addStandardPart (geometry first)
 *   2. setMaterial (depends on a body to attach to)
 *   3. setProcess, setFitClass, setTolerance (metadata; order-insensitive)
 *
 * @param {{ constraints?: object[] } | object[]} input
 */
export function constraintsToOps(input) {
    const constraints = Array.isArray(input)
        ? input
        : (input && Array.isArray(input.constraints) ? input.constraints : []);

    /** @type {object[]} */
    const ops = [];
    /** @type {object[]} */
    const unmapped = [];

    // Bucket constraints by tag.
    const dims      = constraints.filter((c) => c._c === CONSTRAINT_KIND.DIMENSION);
    const parts     = constraints.filter((c) => c._c === CONSTRAINT_KIND.PART_SELECTION);
    const materials = constraints.filter((c) => c._c === CONSTRAINT_KIND.MATERIAL);
    const fits      = constraints.filter((c) => c._c === CONSTRAINT_KIND.FIT_CLASS);
    const tols      = constraints.filter((c) => c._c === CONSTRAINT_KIND.TOLERANCE);
    const procs     = constraints.filter((c) => c._c === CONSTRAINT_KIND.PROCESS);
    const spatials  = constraints.filter((c) => c._c === CONSTRAINT_KIND.SPATIAL);

    let bodyEmitted = false;

    // 1. Try to emit a Box from XYZ dims first.
    const boxDims = collectBoxDims(dims);
    if (boxDims) {
        ops.push({
            kind: 'addBox',
            params: {
                length: boxDims.length,
                width:  boxDims.width,
                height: boxDims.height,
                centered: true,
            },
            tag: 'body',
        });
        bodyEmitted = true;
    } else {
        // Fall back to a cylinder if we have a diameter and one other axial dim.
        const dia = findDiameter(dims);
        const heightDim = dims.find((d) =>
            d.axis === DIMENSION_AXIS.HEIGHT ||
            d.axis === DIMENSION_AXIS.LENGTH ||
            d.axis === DIMENSION_AXIS.THICKNESS);
        if (dia != null && heightDim) {
            const h = toMm(heightDim.value, heightDim.unit);
            ops.push({
                kind: 'addCylinder',
                params: { radius: dia / 2, height: h, centered: true },
                tag: 'body',
            });
            bodyEmitted = true;
        }
    }

    // 2. Standard parts — try the kernel catalog first, fall back to the
    //    Spec 18 library when the constraint resolves to a known library
    //    part (e.g. an M4 SHCS with a length hint).
    for (const p of parts) {
        const entryId = entryIdFor(p);
        const qty = Number.isFinite(p.qty) ? Math.max(1, p.qty | 0) : 1;
        if (entryId) {
            ops.push({
                kind: 'addStandardPart',
                params: { entryId, qty, role: p.role || null },
                tag: 'part',
            });
            continue;
        }
        // Spec 18 v1 fallback — look up by name / keywords.
        const libHit = _libraryFallback(p);
        if (libHit) {
            ops.push({
                kind: 'placeLibraryPart',
                params: { partId: libHit.id, mate: {} },
                tag: 'part',
            });
            continue;
        }
        unmapped.push(p);
    }

    // 3. Material (set on the most recently emitted body).
    for (const m of materials) {
        if (!bodyEmitted) { unmapped.push(m); continue; }
        ops.push({
            kind: 'setMaterial',
            params: {
                material: m.material,
                grade: m.grade || null,
                target: 'lastBody',
            },
            tag: 'meta',
        });
    }

    // 4. Process, fit class, tolerance — metadata, applied to doc.
    for (const p of procs) {
        ops.push({
            kind: 'setProcess',
            params: { process: p.process, profile: p.profile || null },
            tag: 'meta',
        });
    }
    for (const f of fits) {
        ops.push({
            kind: 'setFitClass',
            params: { class: f.class, between: f.between || null },
            tag: 'meta',
        });
    }
    for (const t of tols) {
        ops.push({
            kind: 'setTolerance',
            params: {
                target: t.target,
                plus: t.plus,
                minus: t.minus,
                unit: t.unit,
            },
            tag: 'meta',
        });
    }

    // 5. Spatial constraints don't have a clean structural op in v1 —
    // surface as unmapped so the LLM / human can handle them.
    for (const s of spatials) unmapped.push(s);

    return {
        ops,
        unmapped,
        coverage: {
            mapped: constraints.length - unmapped.length,
            total:  constraints.length,
        },
    };
}
