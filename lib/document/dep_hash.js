/**
 * Incremental-recompile engine (Phase G4) — per-feature dependency hashing.
 *
 * The compile pipeline emits ONE build123d script and the kernel re-execs the
 * whole thing on any edit. The 2-tier content-addressed cache turns *redundant*
 * whole-document recompiles into a replay, but a real edit to feature N still
 * pays a full 1..N rebuild. Incremental recompile fixes that: every feature
 * gets a **dependency hash** = a stable fingerprint of its own type+params PLUS
 * the hashes of everything upstream of it. Two consequences fall out:
 *
 *   • Editing feature N changes N's hash AND every downstream feature's hash
 *     (they fold N's hash into theirs), but leaves all UPSTREAM hashes
 *     unchanged. So the unchanged prefix is identified precisely.
 *   • The kernel can memoise each feature's body by this hash (see emit.js
 *     `incremental` mode + harness `_ckpt_*`): unchanged features deserialise a
 *     cached BREP instead of recomputing the expensive OCCT operation; only the
 *     edited feature and its downstream actually recompute.
 *
 * This module is the pure, kernel-agnostic half: it computes the hashes and the
 * reuse/recompute plan. It has no THREE / kernel / DOM deps, so it is fully
 * unit-testable.
 */
import { topoOrder, dependenciesOf, downstream } from './dag.js';

/** cyrb53 — small, fast, stable 53-bit string hash (matches executor.js style). */
function cyrb53(str, seed = 0) {
    let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
    for (let i = 0; i < str.length; i++) {
        const ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** Deterministic JSON with sorted keys, so {a,b} and {b,a} hash identically. */
function stableStringify(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/**
 * Compute the dependency hash of every feature, in topo order so each feature's
 * upstream hashes are known when it's processed. Returns a Map id → hash.
 * Disabled features are skipped (they don't emit a body).
 *
 * @param {Document} doc
 * @returns {Map<string, string>}
 */
export function featureDepHashes(doc) {
    const order = topoOrder(doc) || Object.keys(doc.features || {});
    const deps = dependenciesOf(doc);
    const hashes = new Map();
    for (const id of order) {
        const f = doc.features[id];
        if (!f || f.enabled === false) continue;
        const upstream = [...(deps.get(id) || [])]
            .filter((u) => hashes.has(u))
            .sort()
            .map((u) => hashes.get(u));
        const self = `${f.type}|${stableStringify(f.params || {})}`;
        hashes.set(id, cyrb53(`${self}|${upstream.join(',')}`));
    }
    return hashes;
}

/**
 * Given the dep-hashes from a PREVIOUS emit and the current document, partition
 * features into those whose body can be reused (hash unchanged) and those that
 * must recompute (new feature, edited, or downstream of an edit).
 *
 * @param {Map<string,string>|Object<string,string>|null} prevHashes
 * @param {Document} doc
 * @returns {{ reuse: string[], recompute: string[], hashes: Map<string,string> }}
 */
export function incrementalPlan(prevHashes, doc) {
    const cur = featureDepHashes(doc);
    const get = prevHashes instanceof Map
        ? (id) => prevHashes.get(id)
        : (id) => (prevHashes ? prevHashes[id] : undefined);
    const reuse = [];
    const recompute = [];
    for (const [id, h] of cur) {
        const prev = get(id);
        if (prev !== undefined && prev === h) reuse.push(id);
        else recompute.push(id);
    }
    return { reuse, recompute, hashes: cur };
}

/**
 * The set of features that must recompute when `changedFeatureIds` are edited:
 * the changed features plus everything transitively downstream of them.
 *
 * @param {Document} doc
 * @param {Iterable<string>} changedFeatureIds
 * @returns {Set<string>}
 */
export function affectedFeatures(doc, changedFeatureIds) {
    const set = new Set();
    for (const id of changedFeatureIds) {
        if (!doc.features[id]) continue;
        set.add(id);
        for (const d of downstream(doc, id)) set.add(d);
    }
    return set;
}

/** Serialise a hash Map to a plain object for caching across emits / JSON. */
export function hashesToObject(hashes) {
    const out = {};
    if (hashes instanceof Map) for (const [k, v] of hashes) out[k] = v;
    return out;
}
