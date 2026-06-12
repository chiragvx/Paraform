/**
 * Invariant runner — Layer 2 of the tiered spec compiler.
 *
 * Spec: tracker/16-invariant-library.md.
 *
 * Mirrors the spec-11 DFM runner pattern (`src/lib/dfm/runner.js`):
 *
 *   runInvariants(scope, target, ctx) — run only the invariants matching
 *      `scope` against a single `target` id. The runner resolves the id to
 *      a feature / component / doc object from the ctx (or the lazy doc
 *      provider) before calling each check.
 *
 *   runAllInvariants(ctx) — walks every scope across the whole document
 *      and aggregates per-scope plus overall.
 *
 * Both entry points NEVER throw. A check that raises (it shouldn't — the
 * library contract is no-throw) is captured as an error result.
 *
 * Aggregate shape:
 *
 *   {
 *     pass: boolean,
 *     warnings: ResultEntry[],
 *     errors:   ResultEntry[],
 *     results:  { [invariantId]: InvariantResult } | per-target maps,
 *   }
 *
 * `ResultEntry` carries the invariant id + scope alongside the result so
 * the UI / repair-loop can route by category without a second lookup.
 */

import {
    INVARIANTS,
    INVARIANTS_BY_ID,
    SCOPE,
    invariantsByScope,
} from './library.js';
import { getDoc } from './lookups.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function safeResultFromError(invariantId, e) {
    return {
        ok: false,
        severity: 'error',
        message: `invariant '${invariantId}' threw: ${(e && e.message) || String(e)}`,
        suggestedFix: 'this is a bug in the invariant check; report it',
        measured: null,
    };
}

function isResultShape(r) {
    return r && typeof r === 'object' && typeof r.severity === 'string';
}

/**
 * Run a single invariant against a target, capturing any throw.
 */
async function runOne(invariant, target, ctx) {
    try {
        const r = await invariant.check(target, ctx);
        if (!isResultShape(r)) {
            return safeResultFromError(invariant.id, new Error('non-result return'));
        }
        return r;
    } catch (e) {
        return safeResultFromError(invariant.id, e);
    }
}

/**
 * Resolve a per-feature or per-component target id from a doc.
 */
function resolveTarget(scope, target, doc) {
    if (scope === SCOPE.PER_DOCUMENT) return doc || null;
    if (!target) return null;
    if (typeof target === 'object') return target; // already resolved
    if (scope === SCOPE.PER_FEATURE) {
        const features = (doc && doc.features) || {};
        return features[target] || null;
    }
    if (scope === SCOPE.PER_COMPONENT) {
        const components = (doc && doc.components) || {};
        return components[target] || null;
    }
    return null;
}

function aggregate(entries) {
    const warnings = [];
    const errors = [];
    const results = {};
    for (const e of entries) {
        results[e.id] = e.result;
        if (e.result.severity === 'warning') warnings.push(e);
        else if (e.result.severity === 'error') errors.push(e);
    }
    return {
        pass: warnings.length === 0 && errors.length === 0,
        warnings,
        errors,
        results,
    };
}

// ── Public API ──────────────────────────────────────────────────────────────

const VALID_SCOPES = new Set(Object.values(SCOPE));

/**
 * Run all invariants registered for `scope` against `target`.
 *
 * @param {string} scope       — one of SCOPE.*
 * @param {string|object} target  — id (resolved via ctx.doc) or pre-resolved object
 * @param {object} [ctx]       — { doc?, measure?, profile? }
 * @returns {Promise<object>}
 */
export async function runInvariants(scope, target, ctx = {}) {
    if (!VALID_SCOPES.has(scope)) {
        // Unknown scope falls back to per-document — surfaces the doc-level
        // invariants as a sensible default. The original (bogus) scope is
        // echoed in the result envelope so callers see they were redirected.
        return {
            pass: false,
            warnings: [],
            errors: [{
                id: 'runner',
                scope,
                result: {
                    ok: false,
                    severity: 'error',
                    message: `unknown scope '${scope}'`,
                },
            }],
            results: {},
        };
    }

    const doc = (ctx && ctx.doc) || await getDoc();
    const resolvedTarget = resolveTarget(scope, target, doc);

    // Even if the target is null, the invariants are defensive — they'll
    // return 'not applicable' (pass). That keeps the runner uniform.
    const ctxForCheck = { ...ctx, doc };
    const invariants = invariantsByScope(scope);

    const entries = await Promise.all(invariants.map(async (inv) => {
        const result = await runOne(inv, resolvedTarget, ctxForCheck);
        return { id: inv.id, scope: inv.scope, category: inv.category, result };
    }));

    return aggregate(entries);
}

/**
 * Walk every scope/target across the whole document and aggregate.
 *
 *   Returns:
 *     {
 *       pass, warnings, errors,
 *       byScope: {
 *         'per-feature':   { [featureId]:   { pass, warnings, errors, results } },
 *         'per-component': { [componentId]: { pass, warnings, errors, results } },
 *         'per-document':  { pass, warnings, errors, results },
 *       },
 *     }
 *
 * @param {object} [ctx] — { doc?, measure?, profile? }
 */
export async function runAllInvariants(ctx = {}) {
    const doc = (ctx && ctx.doc) || await getDoc();
    const ctxForCheck = { ...ctx, doc };

    const allWarnings = [];
    const allErrors = [];

    const byScope = {
        [SCOPE.PER_FEATURE]: {},
        [SCOPE.PER_COMPONENT]: {},
        [SCOPE.PER_DOCUMENT]: null,
    };

    // Per-feature.
    const features = (doc && doc.features) || {};
    const featureIds = Object.keys(features);
    for (const fid of featureIds) {
        const target = features[fid];
        const invariants = invariantsByScope(SCOPE.PER_FEATURE);
        const entries = await Promise.all(invariants.map(async (inv) => {
            const result = await runOne(inv, target, ctxForCheck);
            return { id: inv.id, scope: inv.scope, category: inv.category,
                     targetId: fid, result };
        }));
        const agg = aggregate(entries);
        byScope[SCOPE.PER_FEATURE][fid] = agg;
        for (const w of agg.warnings) allWarnings.push({ ...w, targetId: fid });
        for (const e of agg.errors) allErrors.push({ ...e, targetId: fid });
    }

    // Per-component.
    const components = (doc && doc.components) || {};
    const componentIds = Object.keys(components);
    for (const cid of componentIds) {
        const target = components[cid];
        const invariants = invariantsByScope(SCOPE.PER_COMPONENT);
        const entries = await Promise.all(invariants.map(async (inv) => {
            const result = await runOne(inv, target, ctxForCheck);
            return { id: inv.id, scope: inv.scope, category: inv.category,
                     targetId: cid, result };
        }));
        const agg = aggregate(entries);
        byScope[SCOPE.PER_COMPONENT][cid] = agg;
        for (const w of agg.warnings) allWarnings.push({ ...w, targetId: cid });
        for (const e of agg.errors) allErrors.push({ ...e, targetId: cid });
    }

    // Per-document.
    {
        const invariants = invariantsByScope(SCOPE.PER_DOCUMENT);
        const entries = await Promise.all(invariants.map(async (inv) => {
            const result = await runOne(inv, doc, ctxForCheck);
            return { id: inv.id, scope: inv.scope, category: inv.category, result };
        }));
        const agg = aggregate(entries);
        byScope[SCOPE.PER_DOCUMENT] = agg;
        for (const w of agg.warnings) allWarnings.push(w);
        for (const e of agg.errors) allErrors.push(e);
    }

    return {
        pass: allWarnings.length === 0 && allErrors.length === 0,
        warnings: allWarnings,
        errors: allErrors,
        byScope,
    };
}

// Re-export the static accessors for callers that want them adjacent.
export { INVARIANTS, INVARIANTS_BY_ID, SCOPE } from './library.js';
