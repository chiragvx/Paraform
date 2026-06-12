/**
 * Repair-loop orchestrator (spec tracker/08-repair-loop.md).
 *
 *   runRepairLoop({ specText, ... }) → { success, ops, doc, failures, iterations, llmCalls }
 *
 * Pipeline:
 *   1. extract(specText) → constraints + ambiguities + residualText
 *   2. constraints → ops via constraint_to_ops.js mapper
 *   3. apply ops to a scratch DocumentStore, "compile" via the supplied
 *      kernel (or the headless skip)
 *   4. run invariants (layer 2) + DFM checks against the result
 *   5. aggregate failures (tagged with source: invariant|dfm|kernel-error)
 *   6. if failures non-empty AND iteration < MAX_ITER → call LLM with
 *      failures, apply returned patch ops, re-check.
 *   7. return aggregate result, plus a per-run telemetry record.
 *
 * The loop is parametrised so it runs cleanly in:
 *   - the headless test (no kernel, no DFM, only invariants),
 *   - the browser studio (full kernel + DFM),
 *   - the eval harness (kernel optional, summary recorded to JSONL).
 */

import { extract } from '../extractor/index.js';
import { constraintsToOps } from './constraint_to_ops.js';
import { callLlmClient } from './llm_client.js';
import { runAllInvariants } from '../invariants/runner.js';
import {
    resetDocumentStore,
    getDocumentStore,
    addBox, addCylinder, addStandardPart,
    addFillet,
    setFeatureParams,
    ingestExtractorAmbiguities,
} from '../../../lib/document/index.js';

/** Default cap. The spec says 3. */
export const DEFAULT_MAX_ITER = 3;

// ── Op application ──────────────────────────────────────────────────────────

/**
 * Apply a list of repair-loop ops to the active DocumentStore. Returns
 * the per-op outcome so callers can audit which ops landed.
 *
 * State that persists across ops within a single call:
 *   - `lastBodyId` — the most recently emitted body feature, so a
 *     subsequent `setMaterial` can target "lastBody" without naming.
 *
 * @param {object[]} ops
 * @returns {{ applied: object[], errors: object[] }}
 */
export function applyOps(ops) {
    const applied = [];
    const errors = [];
    let lastBodyId = null;

    for (const op of ops) {
        try {
            switch (op.kind) {
                case 'addBox': {
                    const f = addBox({
                        length: op.params.length,
                        width:  op.params.width,
                        height: op.params.height,
                        centered: op.params.centered ?? true,
                    });
                    lastBodyId = f.id;
                    applied.push({ op, featureId: f.id });
                    break;
                }
                case 'addCylinder': {
                    const f = addCylinder({
                        radius: op.params.radius,
                        height: op.params.height,
                        centered: op.params.centered ?? true,
                    });
                    lastBodyId = f.id;
                    applied.push({ op, featureId: f.id });
                    break;
                }
                case 'addStandardPart': {
                    const f = addStandardPart(op.params.entryId);
                    applied.push({ op, featureId: f.id });
                    break;
                }
                case 'addFillet': {
                    const target = op.params.target || lastBodyId;
                    if (!target) {
                        errors.push({ op, error: 'no target for addFillet' });
                        break;
                    }
                    const f = addFillet(target, {
                        radius: op.params.radius,
                        edges: op.params.edges || [],
                    });
                    applied.push({ op, featureId: f.id });
                    break;
                }
                case 'setMaterial': {
                    const targetId = (op.params.target === 'lastBody' || !op.params.target)
                        ? lastBodyId
                        : op.params.target;
                    if (!targetId) {
                        errors.push({ op, error: 'no body to attach material to' });
                        break;
                    }
                    const store = getDocumentStore();
                    const f = store.doc.features[targetId];
                    if (!f) {
                        errors.push({ op, error: `feature '${targetId}' missing` });
                        break;
                    }
                    const grade = op.params.grade;
                    const value = grade ? `${op.params.material} ${grade}` : op.params.material;
                    setFeatureParams(targetId, { ...f.params, material: value });
                    applied.push({ op, featureId: targetId, material: value });
                    break;
                }
                case 'setProcess': {
                    // We don't yet have a first-class doc-level field for this;
                    // stash it on metadata so the invariant reads it back via
                    // ctx.profile (the loop hands it through).
                    applied.push({ op, process: op.params.process });
                    break;
                }
                case 'setFitClass':
                case 'setTolerance': {
                    // No structural change in v1 — these are bookkeeping for
                    // the acceptance compiler. Pass through as applied so the
                    // coverage report counts them.
                    applied.push({ op, noop: true });
                    break;
                }
                case 'setFeatureParams': {
                    const { featureId, patch } = op.params;
                    const store = getDocumentStore();
                    const f = store.doc.features[featureId];
                    if (!f) {
                        errors.push({ op, error: `feature '${featureId}' missing` });
                        break;
                    }
                    setFeatureParams(featureId, { ...f.params, ...patch });
                    applied.push({ op, featureId });
                    break;
                }
                default:
                    errors.push({ op, error: `unknown op kind '${op.kind}'` });
                    break;
            }
        } catch (e) {
            errors.push({ op, error: (e && e.message) || String(e) });
        }
    }
    return { applied, errors };
}

// ── Failure aggregation ─────────────────────────────────────────────────────

/**
 * Convert an invariant runner aggregate into the loop's normalised
 * failure shape. Each failure carries a `source` tag so the LLM rule
 * table can dispatch on it.
 */
function failuresFromInvariants(invAgg) {
    const out = [];
    for (const e of invAgg.errors || [])  out.push({ ...e, source: 'invariant', severity: 'error' });
    for (const w of invAgg.warnings || []) out.push({ ...w, source: 'invariant', severity: 'warning' });
    return out;
}

function failuresFromDfm(dfmAgg) {
    const out = [];
    for (const e of dfmAgg.errors || [])  out.push({ ...e, source: 'dfm', severity: 'error' });
    for (const w of dfmAgg.warnings || []) out.push({ ...w, source: 'dfm', severity: 'warning' });
    return out;
}

function failuresFromKernelError(err) {
    if (!err) return [];
    return [{
        id: 'kernel-error',
        source: 'kernel-error',
        severity: 'error',
        category: 'kernel-error',
        result: {
            ok: false,
            severity: 'error',
            message: err.message || String(err),
        },
    }];
}

// ── Default kernel-compile fn (no-op) ───────────────────────────────────────

async function noopCompile(_doc) { return { ok: true }; }

// ── Default DFM runner (skips when no kernel client wired) ──────────────────

async function noopDfm(_doc) {
    return { pass: true, warnings: [], errors: [], byFeature: {} };
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Run the full extract → ops → invariants → LLM-residual loop.
 *
 * @param {{
 *   specText: string,
 *   maxIter?: number,
 *   compile?: (doc: object) => Promise<{ ok: boolean, error?: any }>,
 *   runDfm?:  (doc: object) => Promise<object>,
 *   runInvariants?: (ctx: object) => Promise<object>,
 *   llmClient?: (req: object) => Promise<{ ops: object[], rationale: string }>,
 *   resetDoc?: boolean,
 *   profile?: object,
 *   ingestAmbiguities?: boolean,
 * }} request
 */
export async function runRepairLoop(request) {
    const {
        specText,
        maxIter = DEFAULT_MAX_ITER,
        compile = noopCompile,
        runDfm = noopDfm,
        runInvariants = (ctx) => runAllInvariants(ctx),
        llmClient = callLlmClient,
        resetDoc = true,
        profile = null,
        ingestAmbiguities = true,
    } = request || {};

    if (resetDoc) resetDocumentStore();

    // 1. Extract.
    const ex = extract(specText || '');
    if (ingestAmbiguities && ex.ambiguities && ex.ambiguities.length) {
        try { ingestExtractorAmbiguities(ex); } catch { /* never blocks */ }
    }

    // 2. Constraints → ops.
    const mapped = constraintsToOps(ex);
    let allOps = [...mapped.ops];

    // 3+4+5+6. Apply, compile, check, optionally repair.
    const iterations = [];
    let llmCalls = 0;
    let success = false;
    let lastFailures = [];

    // Iteration 0 = first pass with deterministic ops; subsequent
    // iterations are LLM residual passes.
    for (let i = 0; i < Math.max(1, maxIter); i++) {
        const opsToApply = (i === 0) ? mapped.ops : iterations[i - 1].patchOps || [];
        const applyResult = applyOps(opsToApply);
        const store = getDocumentStore();
        const doc = store.doc;

        let kernelError = null;
        try {
            const cr = await compile(doc);
            if (cr && cr.ok === false) kernelError = cr.error || new Error('compile failed');
        } catch (e) {
            kernelError = e;
        }

        const invAgg = await runInvariants({ doc, profile });
        const dfmAgg = await runDfm(doc);

        const failures = [
            ...failuresFromKernelError(kernelError),
            ...failuresFromInvariants(invAgg),
            ...failuresFromDfm(dfmAgg),
        ];

        const passNow = failures.length === 0
            || failures.every((f) => f.severity !== 'error');

        const iterRecord = {
            iter: i,
            opsApplied: applyResult.applied.length,
            opErrors: applyResult.errors,
            failures,
            passed: passNow,
            llmRationale: null,
            patchOps: [],
        };
        iterations.push(iterRecord);
        lastFailures = failures;

        if (passNow) { success = true; break; }
        if (i >= maxIter - 1) break;

        // 6. Ask the LLM stub for a patch.
        const lastBodyId = Object.values(doc.features || {})
            .filter((f) => ['Box', 'Cylinder', 'Sphere', 'Cone', 'Torus',
                            'Extrude', 'Revolve'].includes(f.type))
            .map((f) => f.id)
            .pop() || null;
        llmCalls++;
        const proposal = await llmClient({
            goal: specText,
            failures,
            context: { doc, residualText: ex.residualText, lastBodyId, iter: i },
        });
        iterRecord.llmRationale = proposal && proposal.rationale;
        iterRecord.patchOps = (proposal && proposal.ops) || [];
        if (iterRecord.patchOps.length === 0) break; // nothing to try; bail
        allOps = allOps.concat(iterRecord.patchOps);
    }

    return {
        success,
        ops: allOps,
        doc: getDocumentStore().doc,
        failures: lastFailures,
        iterations,
        llmCalls,
        coverage: mapped.coverage,
        unmapped: mapped.unmapped,
        residualText: ex.residualText,
        ambiguities: ex.ambiguities,
    };
}
