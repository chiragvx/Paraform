/**
 * DFM runner (spec tracker/11-cheap-dfm.md).
 *
 * The runner is the entry point everything outside `src/lib/dfm/` should
 * call. It owns:
 *
 *   - profile id → profile object resolution,
 *   - aggregation of per-check results (pass / warnings / errors),
 *   - the optional `watchChecks` subscription that re-runs on every
 *     kernel render via the document bridge.
 *
 * Never throws — kernel failures bubble through as per-check
 * `severity: 'error'` results.
 */

import { getProfile, DEFAULT_PROFILE_ID, PROFILES } from './profiles.js';
import {
    allChecks,
    // Imported so the registry stays bundled even if a downstream tool tree-
    // shakes by name; the runner itself iterates via CHECK_REGISTRY in
    // allChecks(). The 4 spec-13 relational checks are registered there.
    CHECK_REGISTRY,
    setMeasureForTests,
    resetMeasureForTests,
} from './checks.js';
import { createMeasureSession } from '../measure/api.js';

// Sanity: assert the spec-13 relational checks are present in the registry
// at module load. Cheap belt-and-braces against a refactor that drops one
// of them from the export object.
const REQUIRED_RELATIONAL_CHECKS = [
    'bearingBoreFit', 'shaftBearingFit', 'clearanceHoleSize', 'threadEngagement',
];
for (const name of REQUIRED_RELATIONAL_CHECKS) {
    if (typeof CHECK_REGISTRY[name] !== 'function') {
        // eslint-disable-next-line no-console
        console.warn(`[dfm] relational check '${name}' missing from CHECK_REGISTRY`);
    }
}

/** Set of valid profile ids (used to validate the runner input). */
const PROFILE_IDS = new Set(Object.keys(PROFILES));

/**
 * Runs all checks enabled by the profile against `featureId`. Returns:
 *
 *   {
 *     pass:      boolean,        // true when no warnings AND no errors
 *     warnings:  CheckResult[],  // severity:'warning' entries
 *     errors:    CheckResult[],  // severity:'error'   entries
 *     checks:    { [name]: CheckResult },
 *     profileId: string,
 *   }
 *
 * @param {string} featureId
 * @param {string} [profileId='3d-print']
 * @param {object} [opts]  — forwarded to allChecks (e.g. `{ filletRadius }`).
 * @returns {Promise<object>}
 */
export async function runChecks(featureId, profileId = DEFAULT_PROFILE_ID, opts = {}) {
    const profile = getProfile(profileId);
    const resolvedId = PROFILE_IDS.has(profileId) ? profileId : DEFAULT_PROFILE_ID;

    if (!featureId) {
        return {
            pass: false,
            warnings: [],
            errors: [{
                name: 'runner',
                ok: false,
                severity: 'error',
                message: 'no featureId supplied',
            }],
            checks: {},
            profileId: resolvedId,
        };
    }

    // Wrap the entire wave in a DataLoader-style session so every check's
    // `await callMeasure(query)` lands in one batched POST instead of ~15
    // individual round-trips. Only install the session if no provider is
    // already in place — tests inject their own per-query stub via
    // `setMeasureForTests` and we must not shadow it.
    //
    // NOTE: `_measureProvider` in checks.js is module-global — if two
    // `runChecks()` runs overlap, the second `setMeasureForTests` would
    // clobber the first. Per-query correctness is preserved (results are
    // independent and positional), but a check from run A may have its
    // query flushed via run B's session — harmless given the LRU cache +
    // per-query result contract.
    const session = createMeasureSession();
    const prevProvider = setMeasureForTests(session.measure);
    const sessionInstalled = !prevProvider;
    if (!sessionInstalled) {
        // A provider (test stub) was already installed — restore it
        // immediately so the checks see the stub, not our session.
        setMeasureForTests(prevProvider);
    }
    try {
        const aggregate = await allChecks(featureId, profile, opts);
        return { ...aggregate, profileId: resolvedId };
    } catch (e) {
        // allChecks is built to not throw, but defend in depth so the UI
        // never sees an unhandled rejection.
        return {
            pass: false,
            warnings: [],
            errors: [{
                name: 'runner',
                ok: false,
                severity: 'error',
                message: `runner failed: ${(e && e.message) || String(e)}`,
            }],
            checks: {},
            profileId: resolvedId,
        };
    } finally {
        // Only tear down the provider if we installed our own session.
        if (sessionInstalled) resetMeasureForTests();
    }
}

/**
 * Lightweight reactive wrapper. Subscribes to the document bridge's render
 * tick (when available) and re-invokes `runChecks` on each tick. Returns an
 * `unsubscribe` function. Safe to call without a bridge — in that case the
 * callback fires once with the initial result and never again.
 *
 * Intentionally v1 / minimal: callers in a Svelte 5 component can also just
 * wrap `runChecks` in `$effect` and watch `bridge.lastCompileMs` themselves.
 *
 * @param {string} featureId
 * @param {string} profileId
 * @param {(result: object) => void} callback
 * @param {object} [opts]
 * @returns {() => void} unsubscribe
 */
export function watchChecks(featureId, profileId, callback, opts = {}) {
    let cancelled = false;
    let lastCompile = -1;

    const tick = async () => {
        if (cancelled) return;
        const r = await runChecks(featureId, profileId, opts);
        if (!cancelled) callback(r);
    };

    // Fire once immediately.
    tick();

    const bridge = (typeof globalThis !== 'undefined' && globalThis.__paraformBridge)
        || null;

    if (!bridge || typeof bridge.subscribe !== 'function') {
        // No bridge to listen on — return a no-op unsubscribe.
        return () => { cancelled = true; };
    }

    // Pollable fallback: re-tick when the bridge reports a new render.
    // We piggy-back on the same `lastCompileMs` field the measure cache uses.
    const off = bridge.subscribe(() => {
        if (cancelled) return;
        const stamp = bridge.lastCompileMs ?? 0;
        if (stamp === lastCompile) return;
        lastCompile = stamp;
        tick();
    });

    return () => {
        cancelled = true;
        if (typeof off === 'function') off();
    };
}
