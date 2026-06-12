/**
 * Topological descriptor format — Phase 1B foundation.
 *
 * A *descriptor* is a deterministic, hashable identifier for a single
 * topological entity (face/edge/vertex) produced by a feature. Both the
 * kernel (Python, b123d_server) and the client (JS) emit and consume
 * descriptors. They are the unit of identity that survives parameter
 * changes — the heart of the topological-naming solution.
 *
 * Design principles
 * ─────────────────
 * 1. **Hierarchical.** A downstream descriptor wraps upstream descriptors,
 *    so lineage is preserved. e.g. a fillet face carries the edge descriptor
 *    it was applied to. Editing an upstream parameter that shifts geometry
 *    leaves the descriptor structure intact; only the geometry payload moves.
 *
 * 2. **Symbolic, not spatial.** Descriptors do not embed coordinates. They
 *    embed *direction tags* (`+X`, `-Z`, `axis`, `radial`) and *ordinal tags*
 *    (`[0]`, `[1]`) that the kernel can re-emit identically across rebuilds
 *    as long as the topology of the parent feature is unchanged.
 *
 * 3. **String-encodable.** Descriptors round-trip through JSON intact. The
 *    canonical string form (`stringify`) is also the cache key for compares,
 *    map keys, and naming evidence in the changelog.
 *
 * 4. **Cheap to compare.** Two descriptors are equal iff their canonical
 *    strings are equal. No deep tree walks in the hot path.
 *
 * Descriptor shape
 * ────────────────
 *   {
 *     kind:      'face' | 'edge' | 'vertex',
 *     feature:   FeatureId,           // owning feature (the producer)
 *     opTag:     string,              // operation tag — see OP_TAGS below
 *     part:      string,              // ordinal within the op result
 *                                     //   face: '+Z', '-X', 'side[0]', 'fillet', …
 *                                     //   edge: '+X+Z', 'ring[0]', 'spine[3]', …
 *                                     //   vertex: '+X+Y+Z', 'apex', …
 *     parents:   Descriptor[],        // upstream descriptors this entity was
 *                                     // derived from (empty for primitives)
 *     hash:      string,              // SHA1-style digest of the canonical
 *                                     // string — set lazily; not load-bearing
 *   }
 *
 * Canonical string form (single line, no whitespace)
 * ──────────────────────────────────────────────────
 *   <kind>:<feature>:<opTag>:<part>[(<parent1>,<parent2>,...)]
 *
 * Example: a face produced by filleting the +X+Z edge of a Box `box_x` with
 * a `Fillet` feature `fill_a`:
 *
 *   face:fill_a:blend:fillet(edge:box_x:box:+X+Z)
 *
 * The kernel emits these strings inside the harness, attaches them to the
 * topology map returned to the client, and on the next rebuild matches the
 * same strings back to the freshly produced topology.
 */

// ── Tags ──────────────────────────────────────────────────────────────────────
// `kind` enumerates the topological dimension.
export const ENTITY_KIND = Object.freeze({
    FACE:   'face',
    EDGE:   'edge',
    VERTEX: 'vertex',
});

// `opTag` names the operation that produced the entity within a feature.
// The kernel agrees on these tags. New ops must be added here AND in
// b123d_server/naming.py.
export const OP_TAGS = Object.freeze({
    // primitives
    BOX:        'box',
    CYL:        'cyl',
    SPHERE:     'sphere',
    TORUS:      'torus',
    // sketch-based
    EXTRUDE:    'extrude',
    REVOLVE:    'revolve',
    SWEEP:      'sweep',
    LOFT:       'loft',
    // modify
    FILLET:     'fillet',
    CHAMFER:    'chamfer',
    SHELL:      'shell',
    DRAFT:      'draft',
    HOLE:       'hole',
    THREAD:     'thread',
    OFFSET:     'offset',
    // boolean
    UNION:      'union',
    CUT:        'cut',
    INTERSECT:  'intersect',
    SPLIT:      'split',
    // pattern / mirror — instance index lives in `part`
    LIN_PAT:    'linpat',
    CIR_PAT:    'cirpat',
    PATH_PAT:   'pathpat',
    MIRROR:     'mirror',
    // transform passthrough
    XFORM:      'xform',
    // sketch
    SKETCH:     'sketch',
    PROJECT:    'project',
});

// ── Factories ─────────────────────────────────────────────────────────────────

/**
 * Build a descriptor. Use `face`/`edge`/`vertex` rather than calling this
 * directly — they pin the `kind` field correctly.
 *
 * @param {string} kind     — 'face' | 'edge' | 'vertex'
 * @param {string} feature  — id of the producing feature
 * @param {string} opTag    — see OP_TAGS
 * @param {string} part     — ordinal tag (e.g. '+Z', 'side[0]', 'blend')
 * @param {Descriptor[]} [parents]
 */
export function descriptor(kind, feature, opTag, part, parents = []) {
    if (!ENTITY_KIND[kind.toUpperCase()] && !Object.values(ENTITY_KIND).includes(kind)) {
        throw new Error(`descriptor: bad kind "${kind}"`);
    }
    if (!feature || typeof feature !== 'string') throw new Error('descriptor: missing feature id');
    if (!opTag   || typeof opTag   !== 'string') throw new Error('descriptor: missing opTag');
    if (part === undefined || part === null)     throw new Error('descriptor: missing part');
    return Object.freeze({
        kind,
        feature,
        opTag,
        part: String(part),
        parents: Object.freeze(parents.map(p => Object.isFrozen(p) ? p : descriptor(p.kind, p.feature, p.opTag, p.part, p.parents))),
    });
}

export const face   = (feature, opTag, part, parents) => descriptor(ENTITY_KIND.FACE,   feature, opTag, part, parents);
export const edge   = (feature, opTag, part, parents) => descriptor(ENTITY_KIND.EDGE,   feature, opTag, part, parents);
export const vertex = (feature, opTag, part, parents) => descriptor(ENTITY_KIND.VERTEX, feature, opTag, part, parents);

// ── Canonical string form ────────────────────────────────────────────────────

/**
 * Render a descriptor to its canonical single-line string form. The kernel
 * emits these strings and uses them as keys when matching reborn topology.
 *
 * Stable across runs and machines. Used as Map key + hash input.
 *
 * @param {Descriptor} d
 * @returns {string}
 */
export function stringify(d) {
    if (!d) return '';
    let head = `${d.kind}:${d.feature}:${d.opTag}:${d.part}`;
    if (d.parents && d.parents.length) {
        head += '(' + d.parents.map(stringify).join(',') + ')';
    }
    return head;
}

/**
 * Parse the canonical string back into a Descriptor object. Strict; throws
 * on malformed input. Used when loading naming evidence from disk / wire.
 *
 * @param {string} s
 * @returns {Descriptor}
 */
export function parse(s) {
    if (!s || typeof s !== 'string') throw new Error('parse: empty descriptor');
    // Find the first top-level '(' that opens the parents list.
    let depth = 0;
    let parenStart = -1;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c === '(' && depth === 0) { parenStart = i; break; }
        if (c === '(') depth++;
        else if (c === ')') depth--;
    }
    let head = s, parentStr = '';
    if (parenStart >= 0) {
        if (s[s.length - 1] !== ')') throw new Error(`parse: missing closing paren: ${s}`);
        head = s.slice(0, parenStart);
        parentStr = s.slice(parenStart + 1, s.length - 1);
    }
    const parts = head.split(':');
    if (parts.length !== 4) throw new Error(`parse: expected kind:feature:op:part, got "${head}"`);
    const [kind, feature, opTag, part] = parts;
    const parents = parentStr ? splitTopLevelCommas(parentStr).map(parse) : [];
    return descriptor(kind, feature, opTag, part, parents);
}

function splitTopLevelCommas(s) {
    const out = [];
    let depth = 0, start = 0;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c === '(') depth++;
        else if (c === ')') depth--;
        else if (c === ',' && depth === 0) {
            out.push(s.slice(start, i));
            start = i + 1;
        }
    }
    out.push(s.slice(start));
    return out;
}

// ── Equality + hashing ───────────────────────────────────────────────────────

/**
 * Strict equality — two descriptors are equal iff their canonical strings match.
 */
export function equals(a, b) {
    if (a === b) return true;
    if (!a || !b) return false;
    return stringify(a) === stringify(b);
}

/**
 * 32-bit FNV-1a hash of the canonical string. Cheap, deterministic, suitable
 * for fingerprinting and Map keys. NOT cryptographic. Returned as 8-char hex.
 *
 * @param {Descriptor|string} d
 */
export function hash(d) {
    const str = typeof d === 'string' ? d : stringify(d);
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = (h * 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
}

// ── Lineage walking ──────────────────────────────────────────────────────────

/**
 * Return the deepest ancestor descriptor — useful for "where did this face
 * originally come from?" UI queries.
 */
export function rootAncestor(d) {
    if (!d) return null;
    let cur = d;
    while (cur.parents && cur.parents.length) cur = cur.parents[0];
    return cur;
}

/**
 * True iff descriptor `d` (transitively) carries `ancestor` in its parent chain.
 */
export function descendsFrom(d, ancestor) {
    if (!d || !ancestor) return false;
    if (equals(d, ancestor)) return true;
    for (const p of d.parents || []) {
        if (descendsFrom(p, ancestor)) return true;
    }
    return false;
}

/**
 * Collect every feature id that contributed to this descriptor (the producing
 * feature + every ancestor's producing feature). Used by the regen scheduler
 * to determine which features must be re-evaluated to refresh a given query.
 */
export function lineageFeatures(d) {
    const set = new Set();
    const walk = (x) => {
        if (!x) return;
        set.add(x.feature);
        for (const p of x.parents || []) walk(p);
    };
    walk(d);
    return set;
}
