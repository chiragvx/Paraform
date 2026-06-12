/**
 * Standard parts library client (Phase 2.4 / spec 10).
 *
 * Talks to the kernel's `/library` endpoints (shipped by the sibling Python
 * agent):
 *
 *   GET  /library            → { ok, entries: [<lightweight entry>, ...] }
 *   GET  /library/<entryId>  → { ok, entry: {...}, glbBase64: "..." }
 *
 * Entry shape (lightweight): {
 *   id, standard, category, nominalSize, name,
 *   dims: { ... }, metadata: { ... }
 * }
 *
 * v1 categories: 'Fastener', 'Bearing'.
 *
 * ─── Insertion strategy (v2 — StandardPart feature) ─────────────────────────
 *
 * Inserting a standard part now commits a `StandardPart` v4 feature whose
 * `params.entryId` round-trips through the emitter as
 *
 *     n_<fid> = standard_parts.build_from_id("<entryId>")
 *
 * The kernel resolves the catalog entry, builds the body in build123d, the
 * harness GLB-encodes the leaf body, and the existing bridge mount path
 * displays it just like any other primitive. Round-trip through save/reload
 * is automatic — the feature carries only the entry id (and an optional
 * transform), and the kernel rebuilds the geometry on every recompute.
 *
 * The v1 path — three.js GLTFLoader + scene attach + BuildScript stub — has
 * been retired. `fetchEntryGlb` is retained for callers that want to render
 * a preview without committing a feature (e.g. the catalog dialog
 * thumbnails).
 *
 * ─── Caching ────────────────────────────────────────────────────────────────
 *
 * • Catalog: a single module-scoped Promise<entries[]>. Filled lazily on
 *   first call; reused for every subsequent fetchCatalog() call. Reset via
 *   clearCatalogCache() (exposed for tests).
 *
 * • GLBs: a Map<entryId, ArrayBuffer>. At ~20 entries × ~50 KB = ~1 MB
 *   ceiling, eviction is not worth the complexity.
 */

// NOTE: three.js, the studio runtime, and the v4 document module are imported
// lazily inside insertEntry() so the rest of this file (fetchCatalog,
// fetchEntryGlb, the UI helpers) can be exercised from a plain Node test
// without dragging Svelte runes or three.js into module load. Keep
// insertEntry's transitive deps lazy.

// ── Endpoint resolution ─────────────────────────────────────────────────────

async function getEndpoint() {
    try {
        const mod = await import('../../../lib/document/index.js');
        const client = mod.getDocumentExecutor()?.client ?? null;
        if (client && client.endpoint) return client.endpoint.replace(/\/+$/, '');
    } catch { /* fall through */ }
    return '';
}

function getFetch() {
    return (typeof fetch !== 'undefined') ? fetch.bind(globalThis) : null;
}

// ── Caches ──────────────────────────────────────────────────────────────────

let _catalogPromise = null;
const _glbCache = new Map(); // entryId → ArrayBuffer

/** Test-only: forget the cached catalog Promise + GLB cache. */
export function clearCatalogCache() {
    _catalogPromise = null;
    _glbCache.clear();
}

// ── Public: fetch catalog ───────────────────────────────────────────────────

/**
 * Fetches the kernel's standard-parts catalog. Cached per session.
 * @returns {Promise<Array<object>>}
 */
export function fetchCatalog() {
    if (_catalogPromise) return _catalogPromise;
    _catalogPromise = (async () => {
        const endpoint = await getEndpoint();
        const f = getFetch();
        if (!endpoint || !f) {
            throw new Error('no kernel endpoint configured');
        }
        const res = await f(`${endpoint}/library`, { method: 'GET' });
        if (!res || !res.ok) {
            throw new Error(`/library HTTP ${res?.status ?? '???'}`);
        }
        const json = await res.json();
        if (!json || !json.ok || !Array.isArray(json.entries)) {
            throw new Error('malformed /library response');
        }
        return json.entries;
    })();
    // Don't swallow the rejection — let it propagate to callers — but clear
    // the cache so a retry can succeed.
    _catalogPromise.catch(() => { _catalogPromise = null; });
    return _catalogPromise;
}

// ── Public: fetch single entry's GLB ────────────────────────────────────────

/**
 * Fetches a single entry's GLB. Cached per session.
 * @param {string} entryId
 * @returns {Promise<ArrayBuffer>}
 */
export async function fetchEntryGlb(entryId) {
    if (!entryId) throw new Error('fetchEntryGlb: entryId required');
    if (_glbCache.has(entryId)) return _glbCache.get(entryId);

    const endpoint = await getEndpoint();
    const f = getFetch();
    if (!endpoint || !f) throw new Error('no kernel endpoint configured');

    const res = await f(`${endpoint}/library/${encodeURIComponent(entryId)}`, {
        method: 'GET',
    });
    if (!res || !res.ok) {
        throw new Error(`/library/${entryId} HTTP ${res?.status ?? '???'}`);
    }
    const json = await res.json();
    if (!json || !json.ok || typeof json.glbBase64 !== 'string') {
        throw new Error(`malformed /library/${entryId} response`);
    }
    const buf = base64ToArrayBuffer(json.glbBase64);
    _glbCache.set(entryId, buf);
    return buf;
}

function base64ToArrayBuffer(b64) {
    const bin = atob(b64);
    const buf = new ArrayBuffer(bin.length);
    const view = new Uint8Array(buf);
    for (let i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i);
    return buf;
}

// ── Public: insertion ───────────────────────────────────────────────────────

/**
 * Insert a catalog entry into the active document.
 *
 * Spec-10 v2: creates a `StandardPart` v4 feature whose `params.entryId`
 * round-trips through emit.js → `standard_parts.build_from_id(entryId)` →
 * kernel → GLB-encoded body → the standard bridge mount path. No more
 * scene-attached THREE.Group, no more BuildScript stub: the kernel owns the
 * body and the existing v4 render pipeline owns the display, so reloads,
 * exports, and downstream features all work the same as for `addBox`.
 *
 * The JS-side `feature.params.entryId` is the durable record DFM / AI
 * consumers read to know this is a standard part (and which catalog entry).
 *
 * @param {string} entryId
 * @returns {Promise<{ok: boolean, featureId?: string, error?: string}>}
 */
export async function insertEntry(entryId) {
    if (!entryId) return { ok: false, error: 'entryId required' };

    // Look up the entry metadata from the cached catalog for display name.
    // The kernel only needs the id; the entry is just for the timeline label.
    let entry = null;
    try {
        const entries = await fetchCatalog();
        entry = entries.find(e => e.id === entryId) || null;
    } catch { /* catalog miss — fall through with name = entryId */ }

    try {
        const { addStandardPart } = await import('../../../lib/document/index.js');
        const feature = addStandardPart(entryId, { name: entry?.name || entryId });
        return { ok: true, featureId: feature.id };
    } catch (err) {
        console.error('[standard-part] insert failed:', err);
        const msg = (err && err.message) ? err.message : String(err);
        return { ok: false, error: msg };
    }
}

// ── UI helpers ──────────────────────────────────────────────────────────────

/**
 * Sorted, unique list of categories across the given entries.
 * @param {Array<object>} entries
 * @returns {string[]}
 */
export function categoriesOf(entries) {
    const seen = new Set();
    for (const e of entries || []) {
        if (e && typeof e.category === 'string' && e.category.length) {
            seen.add(e.category);
        }
    }
    return Array.from(seen).sort((a, b) => a.localeCompare(b));
}

/**
 * Filter entries by optional `category` (exact match) and `query` (substring
 * match against name + standard + nominalSize + category).
 *
 * @param {Array<object>} entries
 * @param {{ category?: string|null, query?: string }} [opts]
 * @returns {Array<object>}
 */
export function filterEntries(entries, { category = null, query = '' } = {}) {
    const q = (query || '').trim().toLowerCase();
    return (entries || []).filter((e) => {
        if (!e) return false;
        if (category && e.category !== category) return false;
        if (!q) return true;
        const hay = [
            e.name, e.standard, e.nominalSize, e.category, e.id,
        ].filter(Boolean).join(' ').toLowerCase();
        return hay.includes(q);
    });
}
