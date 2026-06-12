/**
 * Typed client for the kernel's `/measure` endpoint (spec
 * tracker/07-measure-api.md).
 *
 *   POST {endpoint}/measure
 *   body: { queries: [{ type, ...args }, ...] }
 *   →    { ok: true,  results: [<typed-result>, ...], kernelVersion }
 *   or   { ok: false, error, kernelVersion }
 *
 * Each per-query result is either `{ok: true, ...typedFields}` or
 * `{ok: false, error}`. We surface per-query failures back to the caller
 * unmodified — they do NOT throw. Only transport-level / batch-level
 * failures throw.
 *
 * Result caching:
 *
 *   Key = JSON.stringify(query) + ':' + bridge.lastCompileMs
 *
 * Hits avoid the round-trip entirely. When `bridge.lastCompileMs` changes
 * (a new render landed), the suffix changes and old entries are simply
 * unreachable. We additionally cap the cache at 200 entries (LRU) so a
 * very long session doesn't grow it without bound.
 */

import { getDocumentExecutor } from '../../../lib/document/index.js';
import { getAuthToken } from '../../../lib/auth_token.js';

// ── Cache + telemetry state (module-scoped singletons) ───────────────────────

const CACHE_CAP = 200;

/** @type {Map<string, object>} insertion-order Map → LRU by re-insert. */
const _cache = new Map();

const _stats = { hits: 0, misses: 0 };

// ── Endpoint / fetch plumbing ────────────────────────────────────────────────

/**
 * Resolve the kernel base URL. We piggyback on the singleton executor's
 * configured client so the same env-var / window-global / Tauri-sidecar
 * resolution logic runs in exactly one place.
 */
function getKernelClient() {
    const executor = getDocumentExecutor();
    const client = executor && executor.client;
    if (!client || !client.endpoint) return null;
    return client;
}

/** Find the bridge singleton without forcing the consumer to wire it up. */
function getBridge() {
    // The bridge is exposed via lib/document/bridge.js. We avoid importing
    // it directly here — that module pulls in three.js, which the test
    // environment doesn't have. Instead, callers may set
    // `globalThis.__paraformBridge` (which boot.js already does in dev) OR
    // the executor's client is sufficient for endpoint resolution and we
    // treat a missing bridge as `lastCompileMs = 0` (one big bucket).
    if (typeof globalThis !== 'undefined') {
        if (globalThis.__paraformBridge) return globalThis.__paraformBridge;
    }
    return null;
}

function compileKey() {
    const bridge = getBridge();
    if (bridge && bridge.lastCompileMs != null) return bridge.lastCompileMs;
    return 0;
}

function fetchImpl() {
    // Tests inject globalThis.fetch; prod uses the global.
    if (typeof fetch !== 'undefined') return fetch.bind(globalThis);
    return null;
}

async function postMeasure(queries) {
    const client = getKernelClient();
    if (!client) {
        throw new Error('measure: kernel endpoint not configured (bridge not booted?)');
    }
    const fImpl = fetchImpl();
    if (!fImpl) throw new Error('measure: no fetch implementation available');

    const endpoint = client.endpoint.replace(/\/+$/, '') + '/measure';
    const headers = { 'Content-Type': 'application/json' };
    const token = await getAuthToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fImpl(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ queries }),
    });
    if (!res || !res.ok) {
        const status = res ? res.status : 'no-response';
        let detail = '';
        try { detail = await res.text(); } catch { /* ignore */ }
        throw new Error(`measure HTTP ${status}${detail ? ': ' + detail : ''}`);
    }
    const json = await res.json();
    if (!json || json.ok !== true) {
        const err = (json && json.error) || 'unknown measure error';
        throw new Error(`measure: ${err}`);
    }
    if (!Array.isArray(json.results)) {
        throw new Error('measure: server returned non-array results');
    }
    return json.results;
}

// ── LRU helpers ──────────────────────────────────────────────────────────────

function cacheGet(key) {
    if (!_cache.has(key)) return undefined;
    // Re-insert to mark "most recently used".
    const v = _cache.get(key);
    _cache.delete(key);
    _cache.set(key, v);
    return v;
}

function cacheSet(key, value) {
    if (_cache.has(key)) _cache.delete(key);
    _cache.set(key, value);
    // Evict oldest entries until we're under the cap.
    while (_cache.size > CACHE_CAP) {
        const oldestKey = _cache.keys().next().value;
        _cache.delete(oldestKey);
    }
}

function makeKey(query) {
    return JSON.stringify(query) + ':' + compileKey();
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Run one or more typed queries against the kernel's `/measure` endpoint.
 *
 *   measure({type: 'bbox', featureId: 'box_x'})    → Promise<TypedResult>
 *   measure([{type: 'volume', featureId: 'a'},
 *            {type: 'mass',   featureId: 'a'}])    → Promise<TypedResult[]>
 *
 * Per-query errors come back as `{ok: false, error}` results — no throw.
 * Transport / batch errors throw.
 *
 * @param {object|object[]} queryOrList
 */
export async function measure(queryOrList) {
    const single = !Array.isArray(queryOrList);
    const queries = single ? [queryOrList] : queryOrList;
    if (!queries.length) return single ? null : [];

    // Partition into hits + misses, remembering each query's original index
    // so we can splice cached values back into the right slots.
    const out = new Array(queries.length);
    const missIdx = [];
    const missQueries = [];
    const keys = queries.map(makeKey);

    for (let i = 0; i < queries.length; i++) {
        const cached = cacheGet(keys[i]);
        if (cached !== undefined) {
            _stats.hits++;
            out[i] = cached;
        } else {
            _stats.misses++;
            missIdx.push(i);
            missQueries.push(queries[i]);
        }
    }

    if (missQueries.length > 0) {
        const fresh = await postMeasure(missQueries);
        if (fresh.length !== missQueries.length) {
            throw new Error(
                `measure: server returned ${fresh.length} results for ${missQueries.length} queries`
            );
        }
        for (let j = 0; j < missQueries.length; j++) {
            const i = missIdx[j];
            const result = fresh[j];
            out[i] = result;
            cacheSet(keys[i], result);
        }
    }

    return single ? out[0] : out;
}

/**
 * DataLoader-style coalescing session.
 *
 * Each `session.measure(query)` call enqueues a single query and schedules a
 * microtask flush; all queries enqueued within the same tick are sent as one
 * `POST /measure`. Cache hits short-circuit and never enter the batch.
 *
 * Intended for callers that fan out (e.g. DFM `allChecks`) where the call
 * shape can't easily be refactored to a single `measure([...])` call — each
 * check still writes `await measure(q)` and the session collapses the wave.
 *
 * Single-query input only. Callers that already have an array should call
 * the existing `measure([...])` path directly — sessions are for fan-in.
 *
 * Conditional follow-ups (a second `await session.measure(q2)` after the
 * first resolves) land in the *next* microtask wave, so the cost is 2 POSTs
 * instead of 1 — still strictly better than the unbatched fan-out.
 */
export function createMeasureSession() {
    /** @type {{query: object, key: string, resolve: Function, reject: Function}[]} */
    const pending = [];
    let scheduled = false;

    async function flush() {
        scheduled = false;
        const wave = pending.splice(0);
        if (wave.length === 0) return;

        // Cache-hit short-circuit: resolve hits immediately, batch only misses.
        const missQueries = [];
        const missEntries = [];
        for (const entry of wave) {
            const cached = cacheGet(entry.key);
            if (cached !== undefined) {
                _stats.hits++;
                entry.resolve(cached);
            } else {
                _stats.misses++;
                missQueries.push(entry.query);
                missEntries.push(entry);
            }
        }
        if (missQueries.length === 0) return;

        try {
            const fresh = await postMeasure(missQueries);
            if (fresh.length !== missQueries.length) {
                const err = new Error(
                    `measure: server returned ${fresh.length} results for ${missQueries.length} queries`
                );
                for (const e of missEntries) e.reject(err);
                return;
            }
            for (let i = 0; i < missEntries.length; i++) {
                cacheSet(missEntries[i].key, fresh[i]);
                missEntries[i].resolve(fresh[i]);
            }
        } catch (err) {
            for (const e of missEntries) e.reject(err);
        }
    }

    return {
        /** @param {object} query */
        measure(query) {
            return new Promise((resolve, reject) => {
                pending.push({ query, key: makeKey(query), resolve, reject });
                if (!scheduled) {
                    scheduled = true;
                    queueMicrotask(flush);
                }
            });
        },
    };
}

/** Drop the entire cache. Useful after a manual repair / kernel restart. */
export function invalidateCache() {
    _cache.clear();
}

/** Lightweight telemetry — current cache size + cumulative hits/misses. */
export function getCacheStats() {
    return { entries: _cache.size, hits: _stats.hits, misses: _stats.misses };
}

/**
 * Test-only hatch: reset cache + counters so tests don't bleed state.
 * Not part of the documented surface but harmless in prod.
 */
export function _resetForTests() {
    _cache.clear();
    _stats.hits = 0;
    _stats.misses = 0;
}

// ── Typed result helpers ─────────────────────────────────────────────────────
// Each helper accepts a result envelope and returns the typed payload, or
// `null` when the per-query call failed. Consumers can do:
//
//   const bbox = asBbox(await studio.measure({type:'bbox', featureId:'a'}));
//   if (bbox) { ... }
//

function _payload(result) {
    if (!result || result.ok !== true) return null;
    return result;
}

export function asBbox(result) {
    const p = _payload(result);
    if (!p) return null;
    const { min, max, size } = p;
    if (!Array.isArray(min) || !Array.isArray(max) || !Array.isArray(size)) return null;
    return { min, max, size };
}

export function asVolume(result) {
    const p = _payload(result);
    if (!p || typeof p.volume !== 'number') return null;
    return p.volume;
}

export function asMass(result) {
    const p = _payload(result);
    if (!p || typeof p.mass !== 'number') return null;
    return p.mass;
}

export function asSurfaceArea(result) {
    const p = _payload(result);
    if (!p || typeof p.area !== 'number') return null;
    return p.area;
}

export function asDistance(result) {
    const p = _payload(result);
    if (!p || typeof p.distance !== 'number') return null;
    return p.distance;
}

export function asHoles(result) {
    const p = _payload(result);
    if (!p || !Array.isArray(p.holes)) return null;
    return p.holes;
}

export function asManifold(result) {
    const p = _payload(result);
    if (!p) return null;
    return {
        closed: !!p.closed,
        watertight: !!p.watertight,
        eulerNumber: typeof p.eulerNumber === 'number' ? p.eulerNumber : null,
    };
}

export function asSelfIntersection(result) {
    const p = _payload(result);
    if (!p) return null;
    return { ok: !!p.selfOk, locations: Array.isArray(p.locations) ? p.locations : [] };
}

export function asInterference(result) {
    const p = _payload(result);
    if (!p) return null;
    return {
        intersects: !!p.intersects,
        volume: typeof p.volume === 'number' ? p.volume : null,
    };
}

export function asCentroid(result) {
    const p = _payload(result);
    if (!p || !Array.isArray(p.centroid)) return null;
    return p.centroid;
}

export function asNormal(result) {
    const p = _payload(result);
    if (!p || !Array.isArray(p.normal)) return null;
    return p.normal;
}
