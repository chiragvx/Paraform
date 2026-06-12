/**
 * Query resolver — evaluates a Query against an executed document's topology.
 *
 * The resolver is the bridge between the symbolic query DSL and the concrete
 * entity descriptors the kernel emitted for the current rebuild. Given:
 *
 *   - a Query (see queries.js)
 *   - a TopologyIndex (feature id → { faces[], edges[], vertices[] })
 *
 * the resolver returns the list of matching TopologyEntry records. Ordering
 * is deterministic: by the descriptor's canonical string ascending unless the
 * caller requests reverse.
 *
 * TopologyEntry shape
 * ───────────────────
 *   {
 *     descriptor: Descriptor,
 *     centerRounded?:  [x,y,z],
 *     normalRounded?:  [x,y,z],   // face: surface normal at centroid
 *     tangentRounded?: [x,y,z],   // edge: tangent at midpoint
 *     area?:           number,
 *     length?:         number,
 *     surfaceType?:    'planar'|'cylindrical'|'spherical'|'conical'|'toroidal'|'other',
 *     closed?:         boolean,
 *   }
 *
 * TopologyIndex shape
 * ───────────────────
 *   Map<FeatureId, { face: TopologyEntry[], edge: TopologyEntry[], vertex: TopologyEntry[] }>
 *
 * The kernel produces a TopologyIndex on every rebuild and attaches it to the
 * response payload. The client wraps it with `buildIndex(topologyJson)` and
 * passes it to `resolve(query, index)`.
 */

import { stringify, equals, descendsFrom } from './descriptor.js';

// ── QueryResolutionError ─────────────────────────────────────────────────────

/**
 * Thrown by `resolve()` when a query's `expect` modifier is violated —
 * 'exactly-one' resolved 0 or >1 entries, or 'at-least-one' resolved 0.
 *
 * Carries the offending candidate list so callers (op handlers, error UI)
 * can surface a disambiguator picker without re-resolving.
 *
 * @property {Descriptor[]} candidates — descriptors that were resolved
 *           (may be empty when expect was 'exactly-one' / 'at-least-one'
 *           and zero results came back).
 * @property {string}       expect     — the failing expect modifier.
 * @property {object}       query      — the query record that failed.
 */
export class QueryResolutionError extends Error {
    constructor(message, { candidates = [], expect = null, query = null } = {}) {
        super(message);
        this.name = 'QueryResolutionError';
        this.candidates = candidates;
        this.expect = expect;
        this.query = query;
    }
}

// ── Index construction ───────────────────────────────────────────────────────

/**
 * Build a TopologyIndex from a server-emitted topology payload. The wire
 * format is `{ nodes: [{ featureId, faces: [...], edges: [...], vertices: [...] }, ...] }`.
 * Each entry must carry `descriptor` (already a JSON-cloned Descriptor) plus
 * any of the geometry hints.
 *
 * The returned Map is keyed by feature id; the values are pre-bucketed by
 * entity kind so feature-entities queries are O(1).
 */
export function buildIndex(topologyJson) {
    /** @type {Map<string, {face: any[], edge: any[], vertex: any[]}>} */
    const map = new Map();
    if (!topologyJson || !Array.isArray(topologyJson.nodes)) return map;
    for (const node of topologyJson.nodes) {
        if (!node.featureId) continue;
        map.set(node.featureId, {
            face:   (node.faces    || []).slice(),
            edge:   (node.edges    || []).slice(),
            vertex: (node.vertices || []).slice(),
        });
    }
    return map;
}

/** Return all entries of `kind` produced by `featureId` (empty array if none). */
export function entriesForFeature(index, featureId, kind) {
    const bucket = index.get(featureId);
    if (!bucket) return [];
    return bucket[kind] || [];
}

// ── Resolver core ────────────────────────────────────────────────────────────

/**
 * Resolve a query against the topology index. Returns a deterministic-ordered
 * list of TopologyEntry records.
 *
 * @param {Query}     q     — see queries.js
 * @param {TopologyIndex} index
 * @returns {TopologyEntry[]}
 */
export function resolve(q, index) {
    if (!q) return [];
    const entries = _resolveCore(q, index);
    _enforceExpect(q, entries);
    return entries;
}

/**
 * Inner resolver: walks the query tree without enforcing top-level `expect`.
 * Sub-queries' `expect` is *not* enforced either — only the outermost
 * `resolve()` call enforces, so a nested 'exactly-one' inside a qFilter
 * doesn't pre-fail. (Sub-queries are typically left at null; if a caller
 * wants strictness on a sub-query they should call `resolve()` on it
 * directly.)
 */
function _resolveCore(q, index) {
    switch (q._q) {
        case 'descriptor': {
            const target = stringify(q.value);
            // Search the feature's bucket for an exact descriptor match.
            const candidates = entriesForFeature(index, q.value.feature, q.kind);
            return candidates.filter(e => stringify(e.descriptor) === target);
        }
        case 'feature-entities': {
            return sortStable(entriesForFeature(index, q.feature, q.kind));
        }
        case 'op': {
            const entries = entriesForFeature(index, q.feature, q.kind);
            return sortStable(entries.filter(e => {
                if (e.descriptor.opTag !== q.opTag) return false;
                if (q.part != null && e.descriptor.part !== String(q.part)) return false;
                return true;
            }));
        }
        case 'union': {
            const seen = new Set();
            const out  = [];
            for (const sub of q.queries) {
                for (const e of _resolveCore(sub, index)) {
                    const k = stringify(e.descriptor);
                    if (!seen.has(k)) { seen.add(k); out.push(e); }
                }
            }
            return sortStable(out);
        }
        case 'subtract': {
            const base    = _resolveCore(q.base,    index);
            const exclude = new Set(_resolveCore(q.exclude, index).map(e => stringify(e.descriptor)));
            return base.filter(e => !exclude.has(stringify(e.descriptor)));
        }
        case 'nth': {
            const list = _resolveCore(q.source, index);
            const arr  = q.reverse ? list.slice().reverse() : list;
            let i = q.index;
            if (i < 0) i = arr.length + i;
            if (i < 0 || i >= arr.length) return [];
            return [arr[i]];
        }
        case 'filter': {
            const list = _resolveCore(q.source, index);
            const pred = compilePredicate(q.predicate);
            return list.filter(pred);
        }
        case 'direction': {
            const list = _resolveCore(q.source, index);
            return list.filter(e => entryHasDirection(e, q.axis, q.strict));
        }
        case 'descends-from': {
            const list = _resolveCore(q.source, index);
            return list.filter(e => descendsFrom(e.descriptor, q.ancestor));
        }
        case 'datum': {
            // Datums reuse the feature-bucket scan and filter to entries
            // whose descriptor.part matches the resolved cardinal tag.
            const entries = entriesForFeature(index, q.feature, q.kind);
            return sortStable(entries.filter(e => e.descriptor && e.descriptor.part === q.resolvedPart));
        }
        default:
            throw new Error(`resolve: unknown query kind "${q._q}"`);
    }
}

/**
 * Enforce the `expect` modifier on a resolved entry list. Throws
 * QueryResolutionError on violation; no-op on legacy null / 'all'.
 */
function _enforceExpect(q, entries) {
    const exp = q && q.expect;
    if (exp == null || exp === 'all') return;
    const candidates = entries.map(e => e.descriptor);
    if (exp === 'exactly-one') {
        if (entries.length === 1) return;
        if (entries.length === 0) {
            throw new QueryResolutionError(
                `query expected exactly one match but resolved zero entries`,
                { candidates, expect: exp, query: q });
        }
        const list = candidates.map(stringify).join(', ');
        throw new QueryResolutionError(
            `query expected exactly one match but resolved ${entries.length}: [${list}]`,
            { candidates, expect: exp, query: q });
    }
    if (exp === 'at-least-one') {
        if (entries.length >= 1) return;
        throw new QueryResolutionError(
            `query expected at least one match but resolved zero entries`,
            { candidates, expect: exp, query: q });
    }
}

/**
 * Resolve to the descriptor strings only — cheaper, used by the regen
 * scheduler when geometry hints aren't needed.
 */
export function resolveKeys(q, index) {
    return resolve(q, index).map(e => stringify(e.descriptor));
}

// ── Predicates ───────────────────────────────────────────────────────────────

/**
 * Compile a serialisable predicate spec into a JS function. The spec shape
 * is the one produced by PRED.* in queries.js — keep this evaluator in sync.
 */
function compilePredicate(spec) {
    if (!spec || typeof spec !== 'object') return () => true;
    switch (spec.type) {
        case 'planar':
            return e => e.surfaceType === 'planar';
        case 'cylindrical':
            return e => e.surfaceType === 'cylindrical';
        case 'closed':
            return e => !!e.closed;
        case 'opTag':
            return e => e.descriptor && e.descriptor.opTag === spec.tag;
        case 'opTagIn': {
            const set = new Set(spec.tags || []);
            return e => e.descriptor && set.has(e.descriptor.opTag);
        }
        case 'partMatches': {
            const re = new RegExp(spec.regex);
            return e => e.descriptor && re.test(e.descriptor.part);
        }
        case 'not': {
            const inner = compilePredicate(spec.inner);
            return e => !inner(e);
        }
        case 'and': {
            const ps = (spec.preds || []).map(compilePredicate);
            return e => ps.every(p => p(e));
        }
        case 'or': {
            const ps = (spec.preds || []).map(compilePredicate);
            return e => ps.some(p => p(e));
        }
        default:
            throw new Error(`compilePredicate: unknown spec type "${spec.type}"`);
    }
}

// ── Direction matching ───────────────────────────────────────────────────────

const AXIS_VECS = Object.freeze({
    '+X': [+1, 0, 0],  '-X': [-1, 0, 0],
    '+Y': [0, +1, 0],  '-Y': [0, -1, 0],
    '+Z': [0, 0, +1],  '-Z': [0, 0, -1],
});

const EPS_STRICT = 1e-6;
const EPS_LOOSE  = 1e-2;   // ~0.6° tolerance

function entryHasDirection(entry, axis, strict) {
    const v = entry.normalRounded || entry.tangentRounded;
    if (!v) return false;
    const a = AXIS_VECS[axis];
    if (!a) return false;
    // Dot product, expecting unit vectors but normalising just in case.
    const len = Math.hypot(v[0], v[1], v[2]) || 1;
    const dot = (v[0] * a[0] + v[1] * a[1] + v[2] * a[2]) / len;
    const target = 1;
    return Math.abs(dot - target) < (strict ? EPS_STRICT : EPS_LOOSE);
}

// ── Sorting ──────────────────────────────────────────────────────────────────

/**
 * Stable sort by the descriptor's canonical string. Makes resolver output
 * deterministic across runs — important for tests, replays, and Nth queries.
 */
function sortStable(entries) {
    const arr = entries.slice();
    arr.sort((a, b) => {
        const sa = stringify(a.descriptor);
        const sb = stringify(b.descriptor);
        return sa < sb ? -1 : sa > sb ? 1 : 0;
    });
    return arr;
}
