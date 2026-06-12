/**
 * Small lookup helpers used by multiple invariants.
 *
 * Spec: tracker/16-invariant-library.md.
 *
 * No external deps; the materials DB ships as a JSON literal so this module
 * loads cleanly from plain Node test runs without a kernel round-trip.
 *
 * Catalog access is wrapped (rather than imported directly) so tests can
 * inject a stub via `setCatalogProviderForInvariants(fn)` and avoid pulling
 * in lib/document/* (which transitively imports three.js).
 */

import MATERIALS from './materials.json' with { type: 'json' };

// ── Materials ───────────────────────────────────────────────────────────────

/**
 * Look up a material by id, name, or alias (case-insensitive).
 * Returns the full record or `null`.
 *
 * @param {string} nameOrId
 * @returns {object|null}
 */
export function getMaterial(nameOrId) {
    if (!nameOrId || typeof nameOrId !== 'string') return null;
    const needle = nameOrId.trim().toLowerCase();
    if (!needle) return null;
    for (const m of MATERIALS) {
        if (!m) continue;
        if (m.id && m.id.toLowerCase() === needle) return m;
        if (m.name && m.name.toLowerCase() === needle) return m;
        if (Array.isArray(m.aliases)) {
            for (const a of m.aliases) {
                if (typeof a === 'string' && a.toLowerCase() === needle) return m;
            }
        }
    }
    return null;
}

/** Full materials DB (read-only-style; clones for safety on the caller). */
export function allMaterials() {
    return MATERIALS.slice();
}

/**
 * Material name → coarse family bucket the thread-engagement multiplier
 * keys off ('steel', 'aluminum', 'plastic'). Falls back to 'steel' for an
 * unknown material so an unconfigured part still gets *some* check.
 *
 * @param {string} materialName
 * @returns {'steel'|'aluminum'|'plastic'}
 */
export function materialFamilyBucket(materialName) {
    const m = getMaterial(materialName);
    if (!m) return 'steel';
    const f = (m.family || '').toLowerCase();
    if (f === 'aluminum' || f === 'aluminium') return 'aluminum';
    if (f === 'plastic') return 'plastic';
    // stainless / steel / titanium / brass / copper all get the metal multiplier.
    return 'steel';
}

/**
 * Combine the materials DB + active profile's threadEngagementMultiplier
 * map into a single number. Mirrors the convention in
 * `src/lib/dfm/checks.js::threadEngagement` so the two layers agree.
 *
 * @param {string} materialName
 * @param {object|null} profile  — resolved DFM profile object (or null)
 * @returns {number}
 */
export function getThreadMultiplier(materialName, profile) {
    const bucket = materialFamilyBucket(materialName);
    const multipliers = (profile && profile.threadEngagementMultiplier) || {
        steel: 1.0, aluminum: 1.5, plastic: 2.0,
    };
    const v = multipliers[bucket];
    return Number.isFinite(v) ? v : (multipliers.steel ?? 1.0);
}

// ── Catalog (injectable) ────────────────────────────────────────────────────

let _catalogProvider = null;

/** Test-only: install a fake `fetchCatalog() → Promise<entry[]>`. */
export function setCatalogProviderForInvariants(fn) {
    _catalogProvider = fn;
}

/** Test-only: revert to the real client. */
export function resetCatalogProviderForInvariants() {
    _catalogProvider = null;
}

async function fetchCatalog() {
    if (_catalogProvider) return _catalogProvider();
    // Lazy import so plain-Node tests that never touch the catalog don't
    // drag the kernel-client transitive graph (three.js, store, etc).
    const mod = await import('../library/standard.js');
    return mod.fetchCatalog();
}

/**
 * Resolve a catalog entry by id. Returns the entry or `null`.
 *
 * Defensive: a failed catalog fetch returns `null`, not an exception, so
 * the calling invariant can downgrade to "not applicable".
 *
 * @param {string} entryId
 * @returns {Promise<object|null>}
 */
export async function findStandardPartEntry(entryId) {
    if (!entryId || typeof entryId !== 'string') return null;
    let entries;
    try {
        entries = await fetchCatalog();
    } catch {
        return null;
    }
    if (!Array.isArray(entries)) return null;
    return entries.find((e) => e && e.id === entryId) || null;
}

// ── Document store (injectable) ─────────────────────────────────────────────

let _docProvider = null;

/**
 * Test-only: install a fake document provider. The provider returns a
 * plain `doc` object with `features` and (optionally) `components`,
 * `parameters`, `material` (default-material).
 */
export function setDocProviderForInvariants(fn) {
    _docProvider = fn;
}

export function resetDocProviderForInvariants() {
    _docProvider = null;
}

/**
 * Return the current document snapshot (or `null` if unreachable).
 * @returns {Promise<object|null>}
 */
export async function getDoc() {
    if (_docProvider) {
        try { return _docProvider(); } catch { return null; }
    }
    try {
        const mod = await import('../../../lib/document/index.js');
        const store = mod.getDocumentStore && mod.getDocumentStore();
        if (!store || typeof store.getState !== 'function') return null;
        return store.getState() || null;
    } catch {
        return null;
    }
}

/** Reset all invariants injection hatches at once. */
export function resetAllInvariantsProvidersForTests() {
    _catalogProvider = null;
    _docProvider = null;
}
