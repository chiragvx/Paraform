/**
 * DocumentExecutor — drives a Document through the kernel and notifies
 * subscribers of progress / completion / failure.
 *
 * The executor is intentionally transport-agnostic: it talks to a *kernel
 * client* that exposes a single `executeCode(code)` method. The default
 * implementation in the app posts to `/api/execute` (matching the legacy
 * `lib/tree/executor.js` shape) but tests can inject a mock client and
 * verify the executor's behaviour without a backend.
 *
 * Lifecycle per call:
 *   1. `executeDocument(doc)` is invoked (typically by a debounced subscriber
 *      on the DocumentStore).
 *   2. We bump a generation counter and remember it — any older in-flight
 *      response will be discarded on arrival ("stale generation" guard).
 *   3. `emitDocument(doc)` produces Python source.
 *   4. The kernel client executes the source and returns `{ ok, glb, topology, error }`.
 *   5. We dispatch `executed` (success) or `failed` to subscribers.
 *
 * Subscribers receive events:
 *   { type: 'start',     generation, doc }
 *   { type: 'emit',      generation, code, leafIds }
 *   { type: 'executed',  generation, result, doc }    // result.topology + glb
 *   { type: 'failed',    generation, error, doc }
 *   { type: 'stale',     generation, doc }            // newer call superseded
 *   { type: 'cancelled', generation }
 */

import { emitDocument } from './emit.js';

/** Default kernel client placeholder — caller MUST inject a real one. */
const NULL_CLIENT = Object.freeze({
    name: 'null',
    async executeCode() {
        return { ok: false, glb: null, topology: null, error: 'no kernel client configured' };
    },
});

export class DocumentExecutor {
    /**
     * @param {object} [opts]
     * @param {{ executeCode: (code: string) => Promise<{ok:boolean, glb?:any, topology?:any, error?:string}> }} [opts.client]
     *        Object implementing `executeCode(code)`. Defaults to a no-op client.
     */
    constructor({ client = NULL_CLIENT } = {}) {
        this.client = client;
        this._subs = new Set();
        this._generation = 0;
        this._lastResult = null;
        this._lastError = null;
        this._inFlight = 0;
        // OCCT chord-deviation tessellation tolerance (mm). Lower = smoother
        // curves + more triangles. Wired from settings via setTessellationDeflection.
        // 0.1 mm is the historical default, before this knob existed.
        this._tessellationDeflection = 0.1;
        // Callback that returns the current TopologyIndex (or null) to thread
        // through emit. The bridge wires this to read `bridge.topologyIndex`
        // so query inputs resolve against the most recent successful render.
        // Default: no provider → emit sees null → falls back to fingerprints.
        this._topologyIndexProvider = () => null;

        // ── Content-addressed result cache ───────────────────────────────────
        // Maps a hash of (emitted code + tessellation deflection) to the kernel
        // result it produced. Identical emitted Python at the same chord
        // tolerance yields byte-identical geometry, so a hit lets
        // `executeDocument` skip the HTTP round-trip AND the OCCT exec /
        // tessellation / GLB export entirely — replaying the cached
        // {glb, topology, geometry} synchronously. This is the path that turns
        // the dominant class of compiles into a <10 ms operation:
        //   • undo / redo and history scrubbing,
        //   • toggling a parameter to a value seen before (or back and forth),
        //   • moving a component and moving it back,
        //   • metadata-only commits — rename, colour, visibility, selection —
        //     that re-emit the SAME Python yet currently pay a full kernel call.
        // A *novel* model still costs a real kernel round-trip; nothing can make
        // OCCT booleans + BRepMesh < 10 ms. The cache attacks redundancy, which
        // is where the editing-session latency actually lives.
        //
        // Only ok:true results are cached (a transient network/kernel error must
        // never become sticky). Bounded LRU so a long session can't grow the
        // GLB-holding map without limit — each entry can carry a multi-MB GLB.
        /** @type {Map<string, object>} */
        this._resultCache    = new Map();
        this._resultCacheMax = 24;
        this._cacheHits      = 0;
        this._cacheMisses    = 0;
    }

    /** Replace the kernel client (e.g. when the transport URL changes). */
    setClient(client) {
        this.client = client || NULL_CLIENT;
        // A different kernel endpoint could produce different geometry for the
        // same code — drop cached results so we never serve another kernel's
        // output. (Same-version kernels are deterministic, so this is belt-and-
        // suspenders, but cheap.)
        this.clearResultCache();
    }

    /**
     * Set a provider that returns the current TopologyIndex for emit-time
     * query resolution. Called once per `executeDocument`. The provider may
     * return `null` (e.g. before the first successful render) — emit treats
     * that as the degraded path.
     */
    setTopologyIndexProvider(fn) {
        this._topologyIndexProvider = (typeof fn === 'function') ? fn : (() => null);
    }

    /** Set the chord-deviation tolerance sent with each kernel call (mm). */
    setTessellationDeflection(mm) {
        if (Number.isFinite(mm) && mm > 0) this._tessellationDeflection = mm;
    }
    getTessellationDeflection() { return this._tessellationDeflection; }

    // ── Result cache ─────────────────────────────────────────────────────────

    /**
     * Compact cache key from the emitted code. Deflection is folded in because
     * the same code at draft vs ultra tessellates to different meshes — a key
     * collision there would render the wrong smoothness. cyrb53 keeps the key a
     * short string so the map stores hashes, not multi-KB copies of the code;
     * the code length is mixed in to make collisions astronomically unlikely.
     */
    _resultCacheKey(code) {
        return `${this._tessellationDeflection}|${code.length}|${_cyrb53(code)}`;
    }

    /** LRU get — returns the cached result or null, touching it as MRU. */
    _resultCacheGet(key) {
        const hit = this._resultCache.get(key);
        if (hit === undefined) return null;
        // Re-insert to move this entry to the most-recently-used end (Map
        // preserves insertion order, so the first key is always the LRU).
        this._resultCache.delete(key);
        this._resultCache.set(key, hit);
        return hit;
    }

    /** LRU put — stores the result and evicts the oldest past the cap. */
    _resultCachePut(key, result) {
        if (this._resultCache.has(key)) this._resultCache.delete(key);
        this._resultCache.set(key, result);
        while (this._resultCache.size > this._resultCacheMax) {
            const oldest = this._resultCache.keys().next().value;
            this._resultCache.delete(oldest);
        }
    }

    /** Drop every cached result (endpoint change, manual invalidation). */
    clearResultCache() {
        this._resultCache.clear();
    }

    /**
     * Cache hit/miss counters + occupancy. Read by the viewport HUD so a
     * compile served from cache can be badged (and so the hit rate is
     * observable when tuning the cap). Plain snapshot; not reactive.
     */
    cacheStats() {
        return {
            hits:   this._cacheHits,
            misses: this._cacheMisses,
            size:   this._resultCache.size,
            max:    this._resultCacheMax,
        };
    }

    /** Subscribe to executor events. Returns an unsubscribe fn. */
    subscribe(fn) {
        this._subs.add(fn);
        return () => this._subs.delete(fn);
    }
    _dispatch(event) {
        for (const fn of this._subs) {
            try { fn(event); }
            catch (e) { console.error('[DocumentExecutor subscriber]', e); }
        }
    }

    /**
     * Run the document through the kernel. Returns a Promise resolving to the
     * kernel result (or rejecting if the executor is cancelled mid-flight).
     *
     * @param {Document} doc
     * @returns {Promise<{ok:boolean, glb?:any, topology?:any, error?:string, generation:number, stale:boolean}>}
     */
    async executeDocument(doc) {
        const generation = ++this._generation;
        this._dispatch({ type: 'start', generation, doc });

        let emitted;
        try {
            let topologyIndex = null;
            try { topologyIndex = this._topologyIndexProvider() || null; }
            catch (e) { topologyIndex = null; }
            // Phase G4 — incremental recompile. This is the LIVE interactive
            // compile path, so opt into checkpoint emit: each body-producing
            // feature is wrapped in a `_ckpt_get`/`_ckpt_put` guard keyed by its
            // dependency hash (own type+params + upstream hashes). On the server
            // (harness `_ckpt_*`) an unchanged feature deserialises its memoised
            // BREP instead of recomputing the OCCT op, so a single-feature edit
            // recomputes only the changed feature + its downstream. Fail-safe:
            // any cache miss/copy failure recomputes → identical geometry. The
            // export path (exporter.js) deliberately stays non-incremental.
            emitted = emitDocument(doc, { topologyIndex, incremental: true });
        } catch (err) {
            this._lastError = err.message;
            this._dispatch({ type: 'failed', generation, error: err.message, doc });
            return { ok: false, error: err.message, generation, stale: false };
        }
        this._dispatch({ type: 'emit', generation, code: emitted.code, leafIds: emitted.leafIds });

        // ── Content-addressed cache hit ──────────────────────────────────────
        // Identical emitted code at the same deflection ⇒ identical geometry, so
        // replay the cached result and skip the network + OCCT entirely. The
        // `executed` event fires synchronously here (no await on this path), so
        // the bridge measures `lastCompileMs` as just emit + hash — the <10 ms
        // win — and renders from the cached GLB. Served as a fresh wrapper so
        // the `cached` flag never mutates the canonical cached object (future
        // hits must stay pristine).
        const cacheKey = this._resultCacheKey(emitted.code);
        const cached = this._resultCacheGet(cacheKey);
        if (cached) {
            this._cacheHits++;
            this._lastResult = cached;
            this._lastError = null;
            const served = { ...cached, cached: true };
            this._dispatch({ type: 'executed', generation, result: served, doc, cached: true });
            return { ...served, generation, stale: false };
        }
        this._cacheMisses++;

        this._inFlight++;
        let result;
        try {
            const execOpts = { deflection: this._tessellationDeflection };
            // First compile of the session (the boot/restore self-kick): cap the
            // wait so an unreachable kernel surfaces an "offline" error in
            // seconds rather than blocking the viewport on the full default
            // timeout. Subsequent (user-triggered, possibly heavy) compiles keep
            // the client's generous default.
            if (generation === 1) execOpts.timeout = 20000;
            result = await this.client.executeCode(emitted.code, execOpts);
        } catch (err) {
            this._inFlight--;
            this._lastError = err.message;
            // If a newer call superseded this one, signal stale rather than failed
            if (generation !== this._generation) {
                this._dispatch({ type: 'stale', generation, doc });
                return { ok: false, error: err.message, generation, stale: true };
            }
            this._dispatch({ type: 'failed', generation, error: err.message, doc });
            return { ok: false, error: err.message, generation, stale: false };
        }
        this._inFlight--;

        // Stale-generation guard — discard out-of-order responses.
        if (generation !== this._generation) {
            this._dispatch({ type: 'stale', generation, doc });
            return { ...result, generation, stale: true };
        }

        if (result && result.ok) {
            // Cache only successful results, and only here — past the
            // stale-generation guard above — so a superseded response never
            // enters the cache (and never renders).
            this._resultCachePut(cacheKey, result);
            this._lastResult = result;
            this._lastError = null;
            this._dispatch({ type: 'executed', generation, result, doc });
        } else {
            this._lastError = (result && result.error) || 'kernel returned not-ok';
            this._dispatch({ type: 'failed', generation, error: this._lastError, doc });
        }
        return { ...result, generation, stale: false };
    }

    /** Cancel any in-flight execution by bumping the generation. */
    cancel() {
        const generation = ++this._generation;
        this._dispatch({ type: 'cancelled', generation });
    }

    /** Last successful render result (or null). */
    lastResult() { return this._lastResult; }
    /** Last error string (or null). */
    lastError()  { return this._lastError; }
    /** Number of in-flight executions. */
    inFlight()   { return this._inFlight; }
}

/**
 * cyrb53 — a fast, well-distributed 53-bit non-cryptographic string hash.
 * Used to fingerprint emitted code for the result cache. Not security-
 * sensitive; chosen for speed (a few hundred ns on KB-scale code) and a
 * collision rate negligible for the ≤24 live cache entries.
 * Public-domain implementation by bryc.
 */
function _cyrb53(str, seed = 0) {
    let h1 = 0xdeadbeef ^ seed;
    let h2 = 0x41c6ce57 ^ seed;
    for (let i = 0, ch; i < str.length; i++) {
        ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
    h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
    h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

// ── Module-level singleton (lazy) ─────────────────────────────────────────────
let _executor = null;
export function getDocumentExecutor() {
    if (!_executor) _executor = new DocumentExecutor();
    return _executor;
}
export function resetDocumentExecutor() {
    _executor = new DocumentExecutor();
    return _executor;
}
