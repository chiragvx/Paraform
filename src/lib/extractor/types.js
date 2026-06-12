/**
 * Typed Constraint records for the deterministic spec extractor (Phase 2b
 * Layer 1). See tracker/15-deterministic-extractor.md.
 *
 * Every constraint carries a `_c` tag so it can be serialised, transported
 * over the LLM wire as JSON, and routed by the downstream consumer
 * (spec 08 repair loop / spec 09 assumptions manifest) without `instanceof`
 * gymnastics.
 *
 * The shapes are intentionally narrow. If a subparser cannot fill a field,
 * it should leave it `null` and emit an AmbiguityNote rather than guess.
 * Defaults (e.g. "aluminum" → 6061) are applied at consumer time, not here,
 * so a downstream override stays cheap.
 *
 * No imports, no Node-specific APIs — these run in the browser eventually.
 */

/** Tagged-union discriminator values. */
export const CONSTRAINT_KIND = Object.freeze({
    DIMENSION:      'dimension',
    PART_SELECTION: 'part_selection',
    FIT_CLASS:      'fit_class',
    MATERIAL:       'material',
    SPATIAL:        'spatial',
    TOLERANCE:      'tolerance',
    PROCESS:        'process',
    KINEMATIC:      'kinematic',
    LOAD:           'load',
});

/** Recognised dimension axis labels. `null` = unlabelled scalar (still typed). */
export const DIMENSION_AXIS = Object.freeze({
    LENGTH:    'length',
    WIDTH:     'width',
    HEIGHT:    'height',
    DIAMETER:  'diameter',
    RADIUS:    'radius',
    THICKNESS: 'thickness',
    DEPTH:     'depth',
    PITCH:     'pitch',
    SPEED:     'speed',
});

/** Known catalog prefixes — match the JSON catalog file `id` prefixes. */
export const CATALOG_PREFIX = Object.freeze({
    ISO4762:  'iso4762',  // SHCS
    ISO4032:  'iso4032',  // hex nuts
    ISO7089:  'iso7089',  // washers
    ISO273:   'iso273',   // clearance holes (we use catalogPrefix for hole role)
    BEARING:  'bearing',
});

/** Fit role labels for part-selection constraints. */
export const FASTENER_ROLE = Object.freeze({
    CLEARANCE: 'clearance',
    TAP:       'tap',
    BORE:      'bore',
    SHAFT:     'shaft',
    THREAD:    'thread',
});

// ── Constraint factories ────────────────────────────────────────────────────
//
// Each factory returns a plain object so the record is JSON-serialisable
// straight off the wire. They exist as functions (not just literal shapes)
// so the call site is greppable and so we get a single place to evolve
// shape changes.

/**
 * @param {string|null} axis  one of DIMENSION_AXIS values, or null
 * @param {number} value
 * @param {string} unit  e.g. 'mm', 'in', 'mm/s'
 */
export function dimension(axis, value, unit) {
    return { _c: CONSTRAINT_KIND.DIMENSION, axis, value, unit };
}

/**
 * @param {string} catalogPrefix  e.g. 'iso4762', 'bearing'
 * @param {string} nominalSize    e.g. 'M3', '608'
 * @param {number} qty            count of parts in this callout
 * @param {string|null} role      e.g. 'clearance', 'tap', null if bare
 * @param {number|null} [length]  optional length-in-mm (M3×16 → 16)
 */
export function partSelection(catalogPrefix, nominalSize, qty, role, length = null) {
    return {
        _c: CONSTRAINT_KIND.PART_SELECTION,
        catalogPrefix, nominalSize, qty, role,
        length: length == null ? null : Number(length),
    };
}

/**
 * @param {string} cls   e.g. 'H7/g6', 'press', 'slide'
 * @param {{target?:string|null, mate?:string|null}} [between]
 */
export function fitClass(cls, between = null) {
    return { _c: CONSTRAINT_KIND.FIT_CLASS, class: cls, between };
}

/**
 * @param {string} material  the lexicon-canonical key, e.g. 'aluminum', '6061'
 * @param {string|null} [grade]
 * @param {string|null} [process]
 */
export function material(material, grade = null, process = null) {
    return { _c: CONSTRAINT_KIND.MATERIAL, material, grade, process };
}

/**
 * @param {string} target  e.g. 'holes', 'edges', 'corners', 'faces'
 * @param {string} datum   e.g. 'each-corner', 'centered', 'top-face'
 * @param {number|null} [offset]  mm
 * @param {number|null} [count]
 */
export function spatial(target, datum, offset = null, count = null) {
    return { _c: CONSTRAINT_KIND.SPATIAL, target, datum, offset, count };
}

/**
 * @param {string} target  e.g. 'all', 'last-dimension', 'specific-axis'
 * @param {number|null} plus
 * @param {number|null} minus
 * @param {string} unit
 * @param {object} [extra]  optional { axis, itGrade, nominalSize, ambiguous }
 */
export function tolerance(target, plus, minus, unit = 'mm', extra = {}) {
    return {
        _c: CONSTRAINT_KIND.TOLERANCE,
        target,
        plus,
        minus,
        unit,
        ...extra,
    };
}

/**
 * @param {string} process  e.g. '3d-print', 'cnc-mill', 'injection-mold'
 * @param {string|null} [profile]
 */
export function process(process, profile = null) {
    return { _c: CONSTRAINT_KIND.PROCESS, process, profile };
}

/**
 * @param {string} mechanism  e.g. 'scara', 'cartesian', 'delta', 'gantry'
 * @param {number|null} [dof]
 */
export function kinematic(mechanism, dof = null) {
    return { _c: CONSTRAINT_KIND.KINEMATIC, mechanism, dof };
}

/**
 * @param {number} payload
 * @param {string} mode  'static' | 'cyclic' | 'dynamic'
 * @param {string} unit  'N' | 'kg'
 */
export function load(payload, mode, unit = 'N') {
    return { _c: CONSTRAINT_KIND.LOAD, payload, mode, unit };
}

/**
 * AmbiguityNote — flagged for the assumptions manifest (spec 09).
 *
 * @param {string} kind   e.g. 'material-grade', 'fastener-length'
 * @param {string} detail human-readable note
 * @param {string|null} [field]
 */
export function ambiguity(kind, detail, field = null) {
    return { kind, detail, field };
}
