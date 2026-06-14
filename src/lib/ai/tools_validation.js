/**
 * Validation & self-correction tools.
 *
 *   compile_status  — did the current document compile on the kernel? returns
 *                     the error string so the model can repair its own build.
 *   mass_properties — volume / mass / centroid / bbox for a body in one call.
 *   self_critique   — the pre-"done" gate: compile + invariants + open
 *                     requirements → a single ok / fix-needed verdict.
 *
 * Also exports `compileCurrent()` for the agent loop, which uses it as an
 * automatic self-repair safety net (see agent.js): after the model mutates the
 * document, the loop compiles and, on failure, feeds the kernel error back so
 * the model fixes it instead of leaving a broken model.
 *
 * The kernel is the arbiter — these never assert, they ask the kernel.
 */

import { getDocumentExecutor, getDocumentStore } from '../../../lib/document/index.js';
import { measure } from '../measure/api.js';
import { runAllInvariants } from '../invariants/runner.js';
import { getAIContext } from './context.js';
import { N, S, fail } from './tools_util.js';

// g/cm³ for the materials the assistant talks about; default to PLA.
const DENSITY = {
    PLA: 1.24, PETG: 1.27, ABS: 1.04, ASA: 1.07, TPU: 1.21,
    NYLON: 1.14, 'PA-CF': 1.16, RESIN: 1.15,
    ALUMINUM: 2.70, ALUMINIUM: 2.70, STEEL: 7.85, BRASS: 8.5, TITANIUM: 4.43,
};

// An error that means "we couldn't reach / there is no kernel" — NOT a geometry
// bug. The self-repair net must never ask the model to "fix" the model because
// the kernel is missing, unreachable, rate-limited, or running in mock mode;
// that would loop forever on a perfectly valid design.
function isInfraError(error) {
    const e = String(error || '').toLowerCase();
    return /no kernel client|not configured|no endpoint|configure|mock|unreachable|failed to fetch|networkerror|network error|econnrefused|enotfound|timed? ?out|timeout|aborted|auth|unauthor|401|403|429|rate.?limit|service unavailable|503|502|504/.test(e);
}

/**
 * Compile the current document on the kernel and classify the outcome. Used by
 * the compile_status tool and the agent loop's self-repair net. Never throws.
 * Returns one of:
 *   { ok:true }                      — compiled cleanly
 *   { ok:true, skipped:true, reason} — couldn't verify (no/unreachable kernel)
 *   { ok:true, stale:true }          — a newer compile is in flight
 *   { ok:false, error }              — a REAL geometry compile failure
 */
export async function compileCurrent() {
    try {
        const store = getDocumentStore && getDocumentStore();
        const exec = getDocumentExecutor && getDocumentExecutor();
        if (!store || !exec || typeof exec.executeDocument !== 'function') return { ok: true, skipped: true, reason: 'no kernel executor' };
        const r = await exec.executeDocument(store.doc);
        if (!r) return { ok: true, skipped: true, reason: 'no compile result' };
        if (r.stale) {
            const le = typeof exec.lastError === 'function' ? exec.lastError() : null;
            if (le && !isInfraError(le)) return { ok: false, error: le, stale: true };
            return { ok: true, stale: true };
        }
        if (r.ok) return { ok: true };
        // Geometry failure vs. infrastructure absence.
        if (isInfraError(r.error)) return { ok: true, skipped: true, reason: r.error };
        return { ok: false, error: r.error || 'kernel compile failed' };
    } catch (e) {
        const msg = (e && e.message) || String(e);
        // A thrown transport/abort error is infra, not a geometry bug.
        if (isInfraError(msg)) return { ok: true, skipped: true, reason: msg };
        return { ok: false, error: `compile check failed: ${msg}` };
    }
}

export const VALIDATION_TOOLS = [
    {
        name: 'compile_status',
        description: 'Check whether the current model actually compiles on the kernel, and get the error if it does not. Call this after a risky edit (a fillet that might overrun a wall, a boolean of distant bodies) to catch a failure and fix it. The agent also auto-checks this for you after edits.',
        input_schema: { type: 'object', properties: {} },
        handler: async () => {
            const r = await compileCurrent();
            if (r.ok && r.skipped) return { ok: true, compiles: null, note: `could not verify on the kernel: ${r.reason}` };
            if (r.ok) return { ok: true, compiles: true, note: r.stale ? 'a newer compile is in flight' : 'compiles cleanly' };
            return { ok: true, compiles: false, error: r.error };
        },
    },
    {
        name: 'mass_properties',
        description: 'Volume, mass (for a chosen material), centroid and bounding box of a body, measured on the compiled geometry. Use to answer "how heavy is this?" or to check a weight budget. Pass the body feature id.',
        input_schema: {
            type: 'object',
            properties: {
                featureId: S('Body feature id to measure'),
                material: S('Material for the mass estimate (e.g. PLA, PETG, aluminium). Default PLA.'),
            },
            required: ['featureId'],
        },
        handler: async (i) => {
            if (!i.featureId) return fail('mass_properties needs featureId');
            try {
                const res = await measure([
                    { type: 'volume', featureId: i.featureId },
                    { type: 'centroid', featureId: i.featureId },
                    { type: 'bbox', featureId: i.featureId },
                ]);
                const arr = Array.isArray(res) ? res : [res];
                const vol = arr[0] && Number.isFinite(arr[0].volume) ? arr[0].volume : null;
                const centroid = (arr[1] && arr[1].centroid) || null;
                const bbox = arr[2] ? { min: arr[2].min, max: arr[2].max, size: arr[2].size } : null;
                const matKey = (i.material || 'PLA').toUpperCase().replace(/\s+/g, '');
                const density = DENSITY[matKey] || null;
                const out = {
                    ok: true,
                    volume_mm3: vol,
                    centroid,
                    bbox,
                    material: i.material || 'PLA',
                };
                if (vol != null && density) {
                    out.mass_g = +((vol / 1000) * density).toFixed(2);
                    out.density_g_cm3 = density;
                } else if (vol != null) {
                    out.note = `Unknown density for "${i.material}" — reporting volume only.`;
                }
                return out;
            } catch (e) { return fail(e); }
        },
    },
    {
        name: 'self_critique',
        description: 'Run a final self-check before you tell the user you are done: does it compile, do the invariants pass, are the logged requirements met? Returns ok or fix-needed plus the specific failures. If fix-needed, repair before claiming success.',
        input_schema: { type: 'object', properties: {} },
        handler: async () => {
            const failures = [];
            const compile = await compileCurrent();
            if (!compile.ok && compile.error) failures.push(`compile: ${compile.error}`);
            let invPass = null;
            try {
                const inv = await runAllInvariants({ measure });
                invPass = !!inv.pass;
                for (const e of (inv.errors || [])) {
                    const msg = (e.result && e.result.message) || 'invariant failed';
                    failures.push(`invariant ${e.id || e.category || ''}: ${msg}`);
                }
            } catch (e) { failures.push(`invariants check failed: ${(e && e.message) || e}`); }
            const ctx = getAIContext();
            const failedReqs = ctx.requirements.filter((r) => r.status === 'failed');
            for (const r of failedReqs) failures.push(`requirement not met: ${r.text}`);
            const openReqs = ctx.requirements.filter((r) => r.status === 'unknown').map((r) => r.text);
            return {
                ok: true,
                verdict: failures.length ? 'fix-needed' : 'ok',
                failures,
                openRequirements: openReqs,
                compileOk: compile.ok,
                invariantsPass: invPass,
            };
        },
    },
];

export default VALIDATION_TOOLS;
