/**
 * Entity query DSL — Phase 1B foundation, Phase 2a hardening.
 *
 * A *query* is a structured object that describes a set of topological
 * entities (faces/edges/vertices) without referring to any specific geometry.
 * The resolver evaluates a query against an executed document's topology map
 * and returns the matching descriptors.
 *
 * Why a DSL rather than just storing concrete descriptors?
 *   - Robustness to topology change. A descriptor pins an *exact* face. A
 *     query like "every face of feature `box_x` whose normal is +Z" survives
 *     parameter edits that reorder faces or change counts.
 *   - Composable. Queries compose into bigger queries (`qUnion`, `qSubtract`,
 *     `qFilter`). Downstream features can store small composite queries that
 *     express geometric intent.
 *   - Modelled after Onshape's `qFilter`/`qContainsPoint`/`qNthFace`. Their
 *     decade of production use validates the pattern.
 *
 * Query record shape
 * ──────────────────
 * Every query is a plain JSON object with a `_q` tag identifying its kind.
 * They serialize trivially into feature inputs (`feature.inputs.body = query`).
 *
 *   { _q: 'descriptor', kind, value: Descriptor, expect? }
 *   { _q: 'feature-entities', kind: 'face'|'edge'|'vertex', feature: FeatureId, expect? }
 *   { _q: 'op',  kind, feature, opTag, part?, expect? }     // narrowest: by op tag
 *   { _q: 'union', kind, queries: Query[], expect? }
 *   { _q: 'subtract', kind, base: Query, exclude: Query, expect? }
 *   { _q: 'nth', kind, source: Query, index: number, reverse?: bool, expect? }
 *   { _q: 'filter', kind, source: Query, predicate: PredicateSpec, expect? }
 *   { _q: 'direction', kind, source: Query, axis: '+X'|'-X'|'+Y'|'-Y'|'+Z'|'-Z', strict?: bool, expect? }
 *   { _q: 'descends-from', kind, source: Query, ancestor: Descriptor, expect? }
 *   { _q: 'datum', kind, feature: FeatureId, datumKey, resolvedPart, expect? }
 *
 * The `kind` field on every query is the entity kind it produces — used to
 * type-check compositions (you can't union a face query with an edge query).
 *
 * The `expect` field is the Phase-2a strictness modifier. Values:
 *   - 'exactly-one'   — resolver throws QueryResolutionError if n !== 1.
 *   - 'at-least-one'  — resolver throws if n === 0.
 *   - 'all'           — no enforcement; return whatever resolved.
 *   - null            — legacy/unscoped (no enforcement). Default for back-compat.
 *
 * Predicates (filter)
 * ───────────────────
 *   { type: 'planar' }                     — face whose surface is planar
 *   { type: 'cylindrical' }                — face whose surface is cylindrical
 *   { type: 'closed' }                     — edge that is a closed loop
 *   { type: 'opTag', tag: string }         — entity whose opTag matches
 *   { type: 'opTagIn', tags: string[] }
 *   { type: 'partMatches', regex: string } — entity whose `part` matches
 *
 * Predicates are JSON-serialisable so queries survive round-trips. The
 * resolver knows how to evaluate each type.
 */

import { ENTITY_KIND, equals, descendsFrom } from './descriptor.js';

// ── Expect modifier ──────────────────────────────────────────────────────────

/** Valid `expect` modifier values. `null` means "no strictness" (legacy). */
export const EXPECT = Object.freeze({
    EXACTLY_ONE:  'exactly-one',
    AT_LEAST_ONE: 'at-least-one',
    ALL:          'all',
});

const _EXPECT_VALUES = new Set([EXPECT.EXACTLY_ONE, EXPECT.AT_LEAST_ONE, EXPECT.ALL]);

function _normExpect(expect) {
    if (expect == null) return null;
    if (!_EXPECT_VALUES.has(expect)) {
        throw new Error(
            `expect: invalid value "${expect}" — must be one of `
            + `'exactly-one' | 'at-least-one' | 'all' | null`);
    }
    return expect;
}

// ── Constructor helpers ──────────────────────────────────────────────────────

/** Query for a single specific descriptor. Brittle — use sparingly. */
export function qDescriptor(d, { expect = null } = {}) {
    if (!d || !d.kind) throw new Error('qDescriptor: missing descriptor');
    return Object.freeze({ _q: 'descriptor', kind: d.kind, value: d, expect: _normExpect(expect) });
}

/** Every face / edge / vertex produced by a feature. */
export function qFeatureFaces(featureId, { expect = null } = {}) {
    return Object.freeze({ _q: 'feature-entities', kind: ENTITY_KIND.FACE, feature: featureId, expect: _normExpect(expect) });
}
export function qFeatureEdges(featureId, { expect = null } = {}) {
    return Object.freeze({ _q: 'feature-entities', kind: ENTITY_KIND.EDGE, feature: featureId, expect: _normExpect(expect) });
}
export function qFeatureVertices(featureId, { expect = null } = {}) {
    return Object.freeze({ _q: 'feature-entities', kind: ENTITY_KIND.VERTEX, feature: featureId, expect: _normExpect(expect) });
}

/** Narrowest atom: entities of `kind` from `feature` whose opTag (and optional part) match. */
export function qOp(kind, feature, opTag, partOrOpts = null, maybeOpts = undefined) {
    // Back-compat: legacy signature was qOp(kind, feature, opTag, part?). New
    // signature folds `part` into an options bag. Accept both:
    //   qOp('face', 'box_x', 'box', '+Z')
    //   qOp('face', 'box_x', 'box', '+Z', { expect: 'exactly-one' })
    //   qOp('face', 'box_x', 'box', { part: '+Z', expect: 'exactly-one' })
    let part = null;
    let expect = null;
    if (partOrOpts && typeof partOrOpts === 'object' && !Array.isArray(partOrOpts)) {
        part   = partOrOpts.part   ?? null;
        expect = partOrOpts.expect ?? null;
    } else {
        part = partOrOpts;
        if (maybeOpts && typeof maybeOpts === 'object') {
            expect = maybeOpts.expect ?? null;
        }
    }
    return Object.freeze({ _q: 'op', kind, feature, opTag, part, expect: _normExpect(expect) });
}

/** Union of queries — must all share the same `kind`. */
export function qUnion(...args) {
    // Optional trailing { expect } object. Detect by checking the last arg.
    let expect = null;
    let queries = args;
    const last = args[args.length - 1];
    if (last && typeof last === 'object' && !Array.isArray(last) && !last._q
        && (last.expect !== undefined || Object.keys(last).length === 0)) {
        expect = last.expect ?? null;
        queries = args.slice(0, -1);
    }
    const flat = [];
    for (const q of queries) {
        if (!q) continue;
        if (q._q === 'union') flat.push(...q.queries);
        else flat.push(q);
    }
    if (!flat.length) throw new Error('qUnion: at least one query required');
    const kind = flat[0].kind;
    for (const q of flat) if (q.kind !== kind) {
        throw new Error(`qUnion: kind mismatch (${kind} vs ${q.kind})`);
    }
    return Object.freeze({ _q: 'union', kind, queries: Object.freeze(flat), expect: _normExpect(expect) });
}

/** Set subtraction: members of `base` not in `exclude`. */
export function qSubtract(base, exclude, { expect = null } = {}) {
    if (base.kind !== exclude.kind) throw new Error('qSubtract: kind mismatch');
    return Object.freeze({ _q: 'subtract', kind: base.kind, base, exclude, expect: _normExpect(expect) });
}

/**
 * Nth element of a query's result list. `index` is 0-based; negative values
 * index from the end. `reverse: true` sorts descending before indexing.
 * Ordering of results is deterministic per resolver — see notes below.
 */
export function qNth(source, index, { reverse = false, expect = null } = {}) {
    return Object.freeze({ _q: 'nth', kind: source.kind, source, index, reverse, expect: _normExpect(expect) });
}

/** Apply a serialisable predicate to filter a query. */
export function qFilter(source, predicate, { expect = null } = {}) {
    return Object.freeze({ _q: 'filter', kind: source.kind, source, predicate, expect: _normExpect(expect) });
}

/**
 * Filter a face query by normal direction (or an edge query by tangent).
 * `axis` is a cardinal: '+X','-X','+Y','-Y','+Z','-Z'. With `strict: true`
 * only exact axial alignment matches; otherwise within ~ε of the axis.
 */
export function qByDirection(source, axis, { strict = false, expect = null } = {}) {
    return Object.freeze({ _q: 'direction', kind: source.kind, source, axis, strict, expect: _normExpect(expect) });
}

/** Filter to entities that transitively descend from `ancestor`. */
export function qDescendsFrom(source, ancestor, { expect = null } = {}) {
    return Object.freeze({ _q: 'descends-from', kind: source.kind, source, ancestor, expect: _normExpect(expect) });
}

// ── Datum vocabulary ─────────────────────────────────────────────────────────

/**
 * Datum-key shorthand for cardinal corners / faces / edges. The vocabulary
 * resolves to descriptor `part` tags that naming.py emits. Two surface forms
 * are accepted for box vertices:
 *
 *   'corner-+X+Y+Z'          → vertex with part '+X+Y+Z'
 *   'corner-min-min-min'     → vertex with part '-X-Y-Z' (min ↔ '-', max ↔ '+')
 *   'corner-max-min-min'     → vertex with part '+X-Y-Z'
 *
 * Faces and edges accept the explicit cardinal form:
 *
 *   'face-+Z'                → face with part '+Z'
 *   'face-min-z' / 'face-max-z' → face with part '-Z' / '+Z' (shorthand)
 *   'edge-+X+Z'              → edge with part '+X+Z'
 *
 * For non-box geometry (cylinder, sphere, ...) the datum key maps onto that
 * geometry's part-tag vocabulary literally:
 *
 *   'face-top'      → face with part 'top'        (cylinder)
 *   'face-lateral'  → face with part 'lateral'    (cylinder)
 *
 * The canonical form on the query record is the resolved explicit-cardinal
 * `part` string (e.g. '-X-Y-Z'), so two equivalent keys produce the same
 * descriptor at resolve time.
 */

const _MIN_MAX_AXES = ['x', 'y', 'z'];

/** Convert 'min'/'max' shorthand into '-X'/'+X' (etc) given the axis index. */
function _minMaxToCardinal(token, axisIdx) {
    if (token === 'min') return '-' + _MIN_MAX_AXES[axisIdx].toUpperCase();
    if (token === 'max') return '+' + _MIN_MAX_AXES[axisIdx].toUpperCase();
    return null;
}

/**
 * Parse a corner spec like '-X-Y-Z' or 'min-min-min' (with axes in X,Y,Z
 * order) into the explicit cardinal form. Returns null if it doesn't look
 * like a corner spec.
 */
function _parseCornerSpec(spec) {
    if (!spec) return null;
    // Explicit cardinal: '+X+Y+Z' / '-X+Y-Z' (six chars; three sign+axis pairs).
    const cardRe = /^([+-][XYZ])([+-][XYZ])([+-][XYZ])$/;
    const m = spec.match(cardRe);
    if (m) {
        // Normalise to X,Y,Z order so '+Y+X+Z' and '+X+Y+Z' canonicalise alike.
        const parts = [m[1], m[2], m[3]];
        const byAxis = { X: null, Y: null, Z: null };
        for (const p of parts) {
            const axis = p[1];
            if (byAxis[axis] != null) return null;  // duplicate axis → invalid
            byAxis[axis] = p;
        }
        if (!byAxis.X || !byAxis.Y || !byAxis.Z) return null;
        return byAxis.X + byAxis.Y + byAxis.Z;
    }
    // min/max shorthand: 'min-min-min' / 'max-min-max' (three hyphen-joined tokens).
    const tokens = spec.split('-');
    if (tokens.length === 3 && tokens.every(t => t === 'min' || t === 'max')) {
        return _minMaxToCardinal(tokens[0], 0)
             + _minMaxToCardinal(tokens[1], 1)
             + _minMaxToCardinal(tokens[2], 2);
    }
    return null;
}

/**
 * Parse a face/edge axis spec like '+Z', 'min-z', 'max-x' or a free-form
 * literal token like 'top'. Returns the literal part string to match
 * against descriptor.part.
 */
function _parseAxisSpec(spec) {
    if (!spec) return null;
    // Explicit cardinal '+Z' / '-X' for single-axis face.
    const single = spec.match(/^([+-])([XYZ])$/);
    if (single) return spec;
    // Two-cardinal-pair for an edge: '+X+Z'.
    const dual = spec.match(/^([+-][XYZ])([+-][XYZ])$/);
    if (dual) {
        const byAxis = { X: null, Y: null, Z: null };
        for (const p of [dual[1], dual[2]]) {
            const axis = p[1];
            if (byAxis[axis] != null) return null;
            byAxis[axis] = p;
        }
        // Sort by X,Y,Z order so '+Z+X' canonicalises to '+X+Z'.
        const ordered = ['X', 'Y', 'Z'].filter(a => byAxis[a]).map(a => byAxis[a]).join('');
        return ordered;
    }
    // Shorthand 'min-z' / 'max-x'.
    const sh = spec.match(/^(min|max)-([xyz])$/);
    if (sh) {
        const sign = sh[1] === 'min' ? '-' : '+';
        return sign + sh[2].toUpperCase();
    }
    // Otherwise treat as a literal part tag (e.g. 'top', 'lateral', 'apex').
    return spec;
}

/**
 * qDatum(feature, datumKey, { expect = 'exactly-one' } = {}) → Query
 *
 * Resolves to the descriptor for a named datum on a feature. `datumKey` is
 * a string of the form `<kind>-<spec>`:
 *
 *   'corner-+X+Y+Z'         → vertex with part '+X+Y+Z'
 *   'corner-min-min-min'    → vertex with part '-X-Y-Z' (synonym)
 *   'face-+Z'               → face with part '+Z'
 *   'face-top'              → face with part 'top'   (cylinder vocabulary)
 *   'edge-+X+Z'             → edge with part '+X+Z'
 *
 * Default `expect` is `'exactly-one'` — datums are addressed by-name and
 * are expected to resolve uniquely.
 */
export function qDatum(feature, datumKey, { expect = EXPECT.EXACTLY_ONE } = {}) {
    if (!feature || typeof feature !== 'string') {
        throw new Error('qDatum: missing feature id');
    }
    if (!datumKey || typeof datumKey !== 'string') {
        throw new Error('qDatum: missing datumKey');
    }
    const dashIdx = datumKey.indexOf('-');
    if (dashIdx <= 0) {
        throw new Error(`qDatum: bad datumKey "${datumKey}" — expected '<kind>-<spec>'`);
    }
    const head = datumKey.slice(0, dashIdx);
    const tail = datumKey.slice(dashIdx + 1);

    let kind, resolvedPart;
    switch (head) {
        case 'corner':
        case 'vertex': {
            kind = ENTITY_KIND.VERTEX;
            const corner = _parseCornerSpec(tail);
            if (!corner) {
                // Fall back to literal part tag (e.g. 'corner-apex').
                resolvedPart = tail;
            } else {
                resolvedPart = corner;
            }
            break;
        }
        case 'face': {
            kind = ENTITY_KIND.FACE;
            resolvedPart = _parseAxisSpec(tail);
            break;
        }
        case 'edge': {
            kind = ENTITY_KIND.EDGE;
            resolvedPart = _parseAxisSpec(tail);
            break;
        }
        default:
            throw new Error(
                `qDatum: bad datumKey "${datumKey}" — kind "${head}" must be `
                + `one of 'corner' | 'vertex' | 'face' | 'edge'`);
    }

    if (!resolvedPart) {
        throw new Error(`qDatum: failed to parse datumKey "${datumKey}"`);
    }

    return Object.freeze({
        _q: 'datum',
        kind,
        feature,
        datumKey,
        resolvedPart,
        expect: _normExpect(expect),
    });
}

// ── Type guards ──────────────────────────────────────────────────────────────
export function isQuery(x) {
    return !!(x && typeof x === 'object' && typeof x._q === 'string');
}

// ── Pretty printing (debug aid) ──────────────────────────────────────────────
function _expectPrefix(q) {
    if (!q || q.expect == null) return '';
    switch (q.expect) {
        case EXPECT.EXACTLY_ONE:  return 'exactly-one ';
        case EXPECT.AT_LEAST_ONE: return 'at-least-one ';
        case EXPECT.ALL:          return 'all ';
        default:                  return '';
    }
}

export function describeQuery(q) {
    if (!q) return '<empty>';
    const prefix = _expectPrefix(q);
    // When an `expect` modifier is present and the leaf reads naturally
    // with a prose form, render it as e.g. "exactly-one face of box_x".
    // Otherwise fall back to the legacy compact form so existing call sites
    // (debug printouts, tests) keep their format.
    if (prefix && q._q === 'feature-entities') {
        const kind = q.expect === EXPECT.ALL ? `${q.kind}s` : q.kind;
        return `${prefix}${kind} of ${q.feature}`;
    }
    let body;
    switch (q._q) {
        case 'descriptor':       body = `=${q.value ? q.value.feature + ':' + q.value.part : '?'}`; break;
        case 'feature-entities': body = `${q.kind}s(${q.feature})`; break;
        case 'op':               body = `${q.kind}s(${q.feature}/${q.opTag}${q.part != null ? '/' + q.part : ''})`; break;
        case 'union':            body = `union(${q.queries.map(describeQuery).join(', ')})`; break;
        case 'subtract':         body = `${describeQuery(q.base)} \\ ${describeQuery(q.exclude)}`; break;
        case 'nth':              body = `${describeQuery(q.source)}[${q.reverse ? '-' : ''}${q.index}]`; break;
        case 'filter':           body = `${describeQuery(q.source)}|${q.predicate?.type ?? 'pred'}`; break;
        case 'direction':        body = `${describeQuery(q.source)}|dir(${q.axis})`; break;
        case 'descends-from':    body = `${describeQuery(q.source)}|from(${q.ancestor?.feature ?? '?'})`; break;
        case 'datum':            body = `datum(${q.feature}/${q.datumKey} → ${q.kind}:${q.resolvedPart})`; break;
        default:                 body = `<${q._q}>`;
    }
    return prefix ? `${prefix}${body}` : body;
}

// ── Ordinal-ref detection ────────────────────────────────────────────────────

/**
 * Detect feature refs that smell like positional/ordinal references (e.g.
 * `<last>`, `<previous>`, `<head>`, `<2-back>`) anywhere inside a query.
 *
 * The Phase-2a contract is: every feature ref is by stable feature id.
 * Anything with `<` or `>` in it is flagged.
 *
 * @returns {string|null} The first offending ref string, or null if clean.
 */
export function containsOrdinalRef(query) {
    // Allow callers to pass a bare string too — handy for unit tests.
    if (typeof query === 'string') {
        return _looksOrdinal(query) ? query : null;
    }
    if (!query || typeof query !== 'object') return null;
    return _walkForOrdinal(query, new Set());
}

function _looksOrdinal(s) {
    return typeof s === 'string' && (s.includes('<') || s.includes('>'));
}

function _walkForOrdinal(q, seen) {
    if (!q || typeof q !== 'object' || seen.has(q)) return null;
    seen.add(q);
    // Feature ref fields:
    if (typeof q.feature === 'string' && _looksOrdinal(q.feature)) return q.feature;
    // Descriptor value carries a feature too.
    if (q.value && typeof q.value === 'object' && _looksOrdinal(q.value.feature)) {
        return q.value.feature;
    }
    if (q.ancestor && typeof q.ancestor === 'object' && _looksOrdinal(q.ancestor.feature)) {
        return q.ancestor.feature;
    }
    // Recurse into sub-queries.
    for (const key of ['source', 'base', 'exclude']) {
        if (q[key]) {
            const hit = _walkForOrdinal(q[key], seen);
            if (hit) return hit;
        }
    }
    if (Array.isArray(q.queries)) {
        for (const sub of q.queries) {
            const hit = _walkForOrdinal(sub, seen);
            if (hit) return hit;
        }
    }
    return null;
}

// ── Validation ───────────────────────────────────────────────────────────────
/** Walk a query tree and assert internal consistency. Throws on first violation. */
export function validate(q, expectedKind = null) {
    if (!isQuery(q)) throw new Error('validate: not a query');
    if (expectedKind && q.kind !== expectedKind) {
        throw new Error(`validate: expected kind ${expectedKind}, got ${q.kind}`);
    }
    // `expect` shape check — null OK, otherwise must be in the enum.
    if (q.expect != null && !_EXPECT_VALUES.has(q.expect)) {
        throw new Error(`validate: bad expect modifier "${q.expect}"`);
    }
    switch (q._q) {
        case 'descriptor':
            if (!q.value || q.value.kind !== q.kind) throw new Error('descriptor query kind mismatch');
            break;
        case 'union':
            for (const sub of q.queries) validate(sub, q.kind);
            break;
        case 'subtract':
            validate(q.base, q.kind);
            validate(q.exclude, q.kind);
            break;
        case 'nth':
            validate(q.source, q.kind);
            if (!Number.isInteger(q.index)) throw new Error('nth: non-integer index');
            break;
        case 'filter':
        case 'direction':
        case 'descends-from':
            validate(q.source, q.kind);
            break;
        case 'datum':
            if (!q.resolvedPart) throw new Error('datum: missing resolvedPart');
            break;
    }
}

/**
 * Strict validator — the Phase-2a contract for ops emitted by the AI / op
 * schema. Adds two requirements on top of `validate`:
 *
 *   1. The top-level query must carry an explicit `expect` modifier (no
 *      legacy null). Sub-queries are allowed null since their cardinality
 *      is mediated by the outer expectation.
 *   2. No feature ref anywhere in the tree may be a positional / ordinal
 *      reference (`<last>`, `<previous>`, etc.).
 *
 * Throws on first violation with a clear, actionable message.
 */
export function validateStrict(q, expectedKind = null) {
    validate(q, expectedKind);
    if (q.expect == null) {
        throw new Error(
            'validateStrict: top-level query is missing an `expect` modifier '
            + '(must be one of \'exactly-one\' | \'at-least-one\' | \'all\')');
    }
    const ord = containsOrdinalRef(q);
    if (ord) {
        throw new Error(
            `validateStrict: query references positional/ordinal feature "${ord}" — `
            + 'every feature ref must be by stable feature id');
    }
}

// ── Predicate helpers (return predicate specs only — evaluator lives in resolver) ──
export const PRED = {
    planar:         () => ({ type: 'planar' }),
    cylindrical:    () => ({ type: 'cylindrical' }),
    closed:         () => ({ type: 'closed' }),
    opTag:          (tag) => ({ type: 'opTag', tag }),
    opTagIn:        (tags) => ({ type: 'opTagIn', tags }),
    partMatches:    (regex) => ({ type: 'partMatches', regex: typeof regex === 'string' ? regex : regex.source }),

    // Symmetric "everything except" — handy for setting up subtractive queries.
    not: (inner) => ({ type: 'not', inner }),
    and: (...ps) => ({ type: 'and', preds: ps }),
    or:  (...ps) => ({ type: 'or',  preds: ps }),
};
