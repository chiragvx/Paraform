/**
 * Feature-tree search — Onshape-style prefix filters.
 *
 * Parses a search string into a predicate over features. Supports the
 * plain-text case (substring match against name / type label) and a small
 * set of `:` prefix filters:
 *
 *   :type <token>   only features whose type label or raw type contains <token>
 *                   (case-insensitive). e.g. `:type fill` matches Fillet.
 *   :errors         features that have warnings (treated as errors for the
 *                   purposes of the UI filter).
 *   :suppressed     features with enabled === false.
 *   :variable       Parameter / Equation features only.
 *
 * Multiple filters compose with AND. A free-text token mixed with a prefix
 * filter further narrows the result. Empty query → predicate returns true
 * for everything.
 *
 * This file is intentionally framework-free: the consumer is the
 * FeatureTree, but the test suite can call `parseSearch()` and
 * `matchFeature()` directly.
 */
import { typeLabel } from './schemas.js';

/**
 * Parse a raw query string into a structured filter object.
 *
 *   parseSearch('')                 → { text:'', filters:{} }
 *   parseSearch(':type fillet')     → { text:'', filters:{ type:'fillet' } }
 *   parseSearch(':errors hole')     → { text:'hole', filters:{ errors:true } }
 *   parseSearch(':suppressed')      → { text:'', filters:{ suppressed:true } }
 *
 * @param {string} raw
 * @returns {{ text: string, filters: { type?: string, errors?: boolean, suppressed?: boolean, variable?: boolean } }}
 */
export function parseSearch(raw) {
    const q = (raw || '').trim();
    if (!q) return { text: '', filters: {} };

    const tokens = q.split(/\s+/);
    const filters = {};
    const free = [];

    for (let i = 0; i < tokens.length; i++) {
        const tok = tokens[i];
        const low = tok.toLowerCase();
        if (low === ':errors' || low === ':error') {
            filters.errors = true;
        } else if (low === ':suppressed') {
            filters.suppressed = true;
        } else if (low === ':variable' || low === ':variables' || low === ':param' || low === ':params') {
            filters.variable = true;
        } else if (low === ':type' || low.startsWith(':type=')) {
            // Two forms supported: `:type fillet` and `:type=fillet`
            if (low.startsWith(':type=')) {
                filters.type = tok.slice(':type='.length).toLowerCase();
            } else if (i + 1 < tokens.length) {
                filters.type = tokens[++i].toLowerCase();
            }
        } else if (low.startsWith(':')) {
            // Unknown prefix filter — keep the raw token as free text so the
            // user sees something rather than silently dropping their query.
            free.push(tok);
        } else {
            free.push(tok);
        }
    }
    return { text: free.join(' ').toLowerCase(), filters };
}

/**
 * Test a feature against the parsed search shape. Returns true when the
 * feature should be visible in the tree.
 *
 * @param {object} feature        a v4 Feature
 * @param {{text:string, filters:object}} parsed
 */
export function matchFeature(feature, parsed) {
    if (!feature) return false;
    const { text, filters } = parsed || { text: '', filters: {} };

    // ── Prefix filters (AND-composed) ───────────────────────────────────────
    if (filters.errors) {
        const hasErrors = Array.isArray(feature.warnings) && feature.warnings.length > 0;
        if (!hasErrors) return false;
    }
    if (filters.suppressed) {
        if (feature.enabled !== false) return false;
    }
    if (filters.variable) {
        if (feature.type !== 'Parameter' && feature.type !== 'Equation') return false;
    }
    if (filters.type) {
        const tl = String(typeLabel(feature.type) || '').toLowerCase();
        const rt = String(feature.type || '').toLowerCase();
        if (!tl.includes(filters.type) && !rt.includes(filters.type)) return false;
    }

    // ── Free text matches name OR type label ────────────────────────────────
    if (text) {
        const name = String(feature.name || '').toLowerCase();
        const tl   = String(typeLabel(feature.type) || '').toLowerCase();
        const rt   = String(feature.type || '').toLowerCase();
        if (!name.includes(text) && !tl.includes(text) && !rt.includes(text)) return false;
    }
    return true;
}

/**
 * Convenience: filter an array of feature ids against a parsed search.
 *
 * @param {string[]} ids
 * @param {object} featuresById   doc.features map
 * @param {{text:string, filters:object}} parsed
 */
export function filterFeatureIds(ids, featuresById, parsed) {
    const out = [];
    for (const id of ids) {
        const f = featuresById[id];
        if (f && matchFeature(f, parsed)) out.push(id);
    }
    return out;
}
