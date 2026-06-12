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
    }

    /** Replace the kernel client (e.g. when the transport URL changes). */
    setClient(client) {
        this.client = client || NULL_CLIENT;
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
        this._inFlight++;
        this._dispatch({ type: 'start', generation, doc });

        let emitted;
        try {
            let topologyIndex = null;
            try { topologyIndex = this._topologyIndexProvider() || null; }
            catch (e) { topologyIndex = null; }
            emitted = emitDocument(doc, { topologyIndex });
        } catch (err) {
            this._inFlight--;
            this._lastError = err.message;
            this._dispatch({ type: 'failed', generation, error: err.message, doc });
            return { ok: false, error: err.message, generation, stale: false };
        }
        this._dispatch({ type: 'emit', generation, code: emitted.code, leafIds: emitted.leafIds });

        let result;
        try {
            result = await this.client.executeCode(emitted.code, {
                deflection: this._tessellationDeflection,
            });
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
