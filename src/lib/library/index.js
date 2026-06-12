/**
 * Spec 18 v1 — component library loader.
 *
 * Reads every JSON record under `./parts/**` at build time via Vite's
 * `import.meta.glob`. Flattens category-grouped arrays (e.g.
 * `fasteners.json` exporting an array of 16 records) into a single
 * PartRecord[]. Composite records (under `./parts/composite/`) are
 * shaped identically to atomic records — the loader doesn't
 * distinguish them; consumers read `record.source === 'composite'`.
 *
 * Node-side fallback (tests, headless tools): when `import.meta.glob`
 * is unavailable, the loader walks the filesystem with `node:fs`.
 *
 *   loadLibrary()                — returns the cached PartRecord[]
 *   findPart(query, { context }) — keyword/tag search, returns ranked hits
 *   getPartById(id), listByCategory(category), listCategories()
 *
 * The KSP-style mate-context filter: if the caller passes
 * `context.hostConnector`, the loader filters to PartRecords that have at
 * least one connector compatible with the host (via mate_solver).
 */

import { validatePartRecord } from './schema.js';
import { expandPortsInPlace } from './profiles.js';

// Phase 2 — swap-with-rebind. Re-exported here so callers (AI tool layer, UI
// affordance) have a single library entry point.
export { replaceComponent, matchConnectorForRebind } from './replace.js';

// ── Library load ────────────────────────────────────────────────────────────

let _libraryCache = null;
let _idIndex = null;
let _byCategory = null;

/**
 * Discover every part record. Synchronous when Vite's glob is available;
 * falls back to async Node fs walk otherwise. Returns a flat PartRecord[].
 *
 * Records authored as a JSON array are spread; records authored as a
 * single object are pushed as-is. Records that fail validation are
 * skipped with a console.warn — the library keeps loading.
 *
 * @returns {Promise<PartRecord[]>}
 */
export async function loadLibrary() {
    if (_libraryCache) return _libraryCache;

    const records = [];

    // Vite path (browser / `vite build`):
    let viteModules = null;
    try {
        // eslint-disable-next-line no-undef
        viteModules = import.meta.glob('./parts/**/*.json', { eager: true });
    } catch {
        viteModules = null;
    }
    if (viteModules && Object.keys(viteModules).length > 0) {
        for (const [path, mod] of Object.entries(viteModules)) {
            const payload = (mod && mod.default !== undefined) ? mod.default : mod;
            _ingest(payload, path, records);
        }
    } else {
        // Node fallback — walk fs.
        const fs = await import('node:fs/promises');
        const url = await import('node:url');
        const path = await import('node:path');
        const here = path.dirname(url.fileURLToPath(import.meta.url));
        const partsDir = path.join(here, 'parts');
        const stack = [partsDir];
        while (stack.length) {
            const cur = stack.pop();
            let ents;
            try { ents = await fs.readdir(cur, { withFileTypes: true }); }
            catch { continue; }
            for (const ent of ents) {
                const full = path.join(cur, ent.name);
                if (ent.isDirectory()) { stack.push(full); continue; }
                if (!ent.name.endsWith('.json')) continue;
                try {
                    const txt = await fs.readFile(full, 'utf8');
                    const payload = JSON.parse(txt);
                    _ingest(payload, full, records);
                } catch (err) {
                    console.warn(`[library] failed to read ${full}:`, err?.message || err);
                }
            }
        }
    }

    _libraryCache = records;
    _rebuildIndices();
    return records;
}

// ── Verified-vs-placeholder gate ────────────────────────────────────────────
//
// Some on-disk records are still crude single-primitive placeholders (an
// L-bracket authored as `Box(20,20,3)`, a GT2 pulley as a plain cylinder) or
// reference a part with no kernel builder. They load fine for tests, but the
// studio palette and the AI's `search_library` should surface only parts that
// build to real, dimensionally-correct geometry. Records from these source
// files (and the composites, which are assembled from the placeholder
// brackets) are stamped `_unverified` and hidden from `listVisible()`.
//
// To promote a file to verified, give its parts real geometry (a kernel
// builder or a `build_from_id` delegate, as `extrusions.json` does) and drop
// its basename here.
const _UNVERIFIED_FILES = new Set([
    'brackets.json',   // crude Box placeholders
    'misc.json',       // TODO-stub hinges/clips/etc.
    'pulleys.json',    // TODO-stub cylinders
    'rails.json',      // TODO-stub boxes
    'washers.json',    // standard-part ids with no kernel builder
]);

/** True when a record's source file ships placeholder (non-buildable) geometry. */
function _isUnverifiedPath(path) {
    const norm = String(path).replace(/\\/g, '/');
    if (norm.includes('/composite/')) return true;   // composites use placeholder members
    const base = norm.split('/').pop();
    return _UNVERIFIED_FILES.has(base);
}

function _ingest(payload, path, out) {
    const items = Array.isArray(payload) ? payload : [payload];
    const unverified = _isUnverifiedPath(path);
    for (const rec of items) {
        const v = validatePartRecord(rec);
        if (!v.ok) {
            console.warn(`[library] invalid record in ${path}:`, v.errors.join('; '));
            continue;
        }
        // Port-model v2 — generate slot ports for T-slot extrusions so every
        // length carries its channels without per-length authoring.
        expandPortsInPlace(rec);
        // Stamp placeholder records so the palette / AI search can hide them
        // while tests + direct getPartById placement still resolve them.
        if (unverified) rec._unverified = true;
        out.push(rec);
    }
}

function _rebuildIndices() {
    _idIndex = new Map();
    _byCategory = new Map();
    for (const rec of _libraryCache || []) {
        _idIndex.set(rec.id, rec);
        const cat = rec.category;
        if (!_byCategory.has(cat)) _byCategory.set(cat, []);
        _byCategory.get(cat).push(rec);
    }
}

/** Test seam — clear the cache so the next loadLibrary() re-reads. */
export function _resetLibraryCacheForTests() {
    _libraryCache = null;
    _idIndex = null;
    _byCategory = null;
}

/**
 * Test seam — inject one or more synthetic PartRecords into the in-memory
 * library so `getPartById` / `findPart` resolve them without touching the
 * on-disk catalog (owned by another agent). Initialises the cache if empty.
 *
 * @param {object|object[]} records
 */
export function _registerPartsForTests(records) {
    const items = Array.isArray(records) ? records : [records];
    if (!_libraryCache) _libraryCache = [];
    if (!_idIndex) _idIndex = new Map();
    if (!_byCategory) _byCategory = new Map();
    for (const rec of items) {
        if (!rec || !rec.id) continue;
        if (!_idIndex.has(rec.id)) _libraryCache.push(rec);
        _idIndex.set(rec.id, rec);
        const cat = rec.category || 'misc';
        if (!_byCategory.has(cat)) _byCategory.set(cat, []);
        if (!_byCategory.get(cat).some((r) => r.id === rec.id)) {
            _byCategory.get(cat).push(rec);
        }
    }
}

// ── Public read API ────────────────────────────────────────────────────────

/**
 * @param {string} id
 * @returns {PartRecord|null}
 */
export function getPartById(id) {
    if (!_libraryCache) return null;
    return _idIndex.get(id) || null;
}

/**
 * @param {string} category — one of PART_CATEGORIES.
 * @returns {PartRecord[]}
 */
export function listByCategory(category) {
    if (!_libraryCache) return [];
    return (_byCategory.get(category) || []).slice();
}

/**
 * @returns {string[]} sorted unique category names actually present.
 */
export function listCategories() {
    if (!_libraryCache) return [];
    return Array.from(_byCategory.keys()).sort();
}

/**
 * @returns {PartRecord[]} a defensive copy of every loaded part.
 */
export function listAll() {
    if (!_libraryCache) return [];
    return _libraryCache.slice();
}

/** True for parts that build to real geometry (not a placeholder stub). */
export function isVerifiedPart(rec) {
    return !!rec && rec._unverified !== true;
}

/**
 * Like {@link listAll} but excludes placeholder/unbuildable records — the set
 * the studio palette and AI library search should present to users.
 * @returns {PartRecord[]}
 */
export function listVisible() {
    if (!_libraryCache) return [];
    return _libraryCache.filter(isVerifiedPart);
}

/**
 * @returns {string[]} sorted categories that have at least one verified part.
 */
export function listVisibleCategories() {
    if (!_libraryCache) return [];
    const cats = new Set();
    for (const rec of _libraryCache) {
        if (isVerifiedPart(rec)) cats.add(rec.category);
    }
    return Array.from(cats).sort();
}

// ── Keyword / tag search ───────────────────────────────────────────────────

/**
 * Tokenise a query string into lowercased non-empty terms. Splits on
 * whitespace and common punctuation; keeps M3/M4-style tokens intact.
 */
function _tokenise(q) {
    if (!q || typeof q !== 'string') return [];
    return q.toLowerCase()
        .split(/[\s,;.+()/\\]+/)
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
}

/**
 * Find parts matching `query`. Optional `context.hostConnector` filters
 * to parts with at least one connector compatible with the host.
 *
 * Ranking: 4× per tag hit, 2× per keyword hit, 1× per name substring hit.
 * Ties broken by category then id (deterministic).
 *
 * @param {string} query
 * @param {{ context?: { hostConnector?: object } }} [opts]
 * @returns {{ part: PartRecord, score: number, suggestedMate?: object }[]}
 */
export function findPart(query, opts = {}) {
    if (!_libraryCache) return [];
    const ctx = (opts && opts.context) || {};
    const host = ctx.hostConnector || null;
    const tokens = _tokenise(query);

    // ESM: mate_solver is eagerly imported at module-init time via the
    // top-level await below. No cyclical import (mate_solver doesn't import
    // ./index.js).
    const connectorsCompatible = host
        ? (_mateSolverModule?.connectorsCompatible || null)
        : null;

    const hits = [];
    for (const rec of _libraryCache) {
        let score = 0;
        const tagSet     = new Set((rec.tags     || []).map((t) => String(t).toLowerCase()));
        const kwSet      = new Set((rec.keywords || []).map((t) => String(t).toLowerCase()));
        const nameLower  = String(rec.name || '').toLowerCase();
        const catLower   = String(rec.category || '').toLowerCase();
        // Empty-query → everyone gets a base score.
        if (tokens.length === 0) {
            score = 1;
        } else {
            for (const tok of tokens) {
                if (tagSet.has(tok)) score += 4;
                if (kwSet.has(tok))  score += 2;
                if (nameLower.includes(tok)) score += 1;
                if (catLower === tok) score += 3;
            }
        }
        if (score <= 0) continue;

        // Context filter — only keep parts with at least one connector
        // compatible with the host.
        let suggestedMate = null;
        if (host && connectorsCompatible) {
            let kept = false;
            for (const c of rec.connectors || []) {
                if (connectorsCompatible(host, c)) {
                    suggestedMate = { partConnectorId: c.id, hostConnectorId: host.id || null };
                    kept = true;
                    break;
                }
            }
            if (!kept) continue;
        }

        hits.push({ part: rec, score, suggestedMate });
    }

    // Stable rank: score desc, then category asc, then id asc.
    hits.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (a.part.category !== b.part.category) {
            return a.part.category < b.part.category ? -1 : 1;
        }
        return a.part.id < b.part.id ? -1 : 1;
    });
    return hits;
}

// ── Eager mate_solver bind so findPart can stay synchronous ─────────────────
let _mateSolverModule = null;
try {
    // Top-level await is supported in ESM modules under Vite + modern Node.
    _mateSolverModule = await import('./mate_solver.js');
} catch {
    _mateSolverModule = null;
}
