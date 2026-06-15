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

// Body-emitting feature types (mirror of tools_dfm.js BODY_EMITTING). A
// "primitive" body is one whose creating feature is a raw primitive — a part
// shaped only by Box/Cylinder/Sphere/Torus reads as box-like, not as the
// requested artifact. Shaped parts come from profile/boolean/organic ops.
const PRIMITIVE_TYPES = new Set(['Box', 'Cylinder', 'Sphere', 'Torus']);
const SHAPING_TYPES = new Set([
    'Extrude', 'Revolve', 'Sweep', 'Loft', 'Fillet', 'Chamfer', 'Shell',
    'Hole', 'Union', 'Cut', 'Intersect', 'Split', 'Mirror', 'Draft',
    'LinearPattern', 'CircularPattern', 'PathPattern',
    'PushPullFace', 'MoveFace', 'OffsetFace', 'DeleteFace',
]);

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
    {
        name: 'design_review',
        description:
            'The GESTALT + FUNCTION critique — the gate that fails a cosmetic "box dog". Run this near "done" on a NOVEL articulated artifact (robot / creature / machine), AFTER you have captured views with capture_views so you can judge the visuals. ' +
            'Unlike self_critique (which checks manufacturing validity — manifold, no interference, walls), design_review asks "is this actually the thing that was requested, and does it FUNCTION?" It scores a rubric: ' +
            'readsAsRequested (does it look like the artifact, not an abstract box pile?), hasRequiredJoints (every joint in the morphology spec has an actuator + a mount), proportionsSane, notJustPrimitives (parts are shaped to function, not raw boxes/cylinders), ventsPresent (over heat sources), serviceable (replaceable parts reachable). ' +
            'It computes the deterministic checks itself (cross-checking the morphology spec against the invariants and counting primitive-only vs shaped bodies) and INSTRUCTS you to judge the genuinely visual ones from your captured views. ' +
            'Returns { verdict:"ok"|"fix-needed", checks:{...}, failures:[...], guidance }. If fix-needed, FIX the design before claiming success — do not ship a cosmetic model when a functional machine was asked for. Never throws.',
        input_schema: {
            type: 'object',
            properties: {
                note: S('Optional: what you are checking, or which captured view you are judging against (e.g. "front + iso of the quadruped").'),
            },
        },
        handler: async (input) => {
            const note = input && typeof input.note === 'string' ? input.note.trim() : '';
            // Rubric checks. null = "the model must judge this from captured views";
            // true/false = the scaffold could decide it deterministically.
            const checks = {
                readsAsRequested: null,   // visual — model judges
                hasRequiredJoints: null,  // deterministic when morphology declared
                proportionsSane: null,    // visual — model judges
                notJustPrimitives: null,  // deterministic from feature tree
                ventsPresent: null,       // best-effort deterministic
                serviceable: null,        // deferred to invariants/visual
            };
            const failures = [];
            const guidanceLines = [];

            // ── Morphology cross-check (overlaps i-functional-complete) ──────────
            const ctx = getAIContext();
            const morph = (ctx && typeof ctx.morphology !== 'undefined') ? ctx.morphology : null;

            // Document body inventory — primitive-only vs shaped.
            let doc = null;
            try { doc = getDocumentStore && getDocumentStore().doc; } catch { /* none */ }
            const features = (doc && doc.features) || {};
            const order = (doc && doc.featureOrder && doc.featureOrder.length)
                ? doc.featureOrder
                : Object.keys(features);
            let primitiveBodies = 0;
            let shapedBodies = 0;
            let hasVentLikeHoles = false;
            for (const fid of order) {
                const f = features[fid];
                if (!f || f.enabled === false) continue;
                if (PRIMITIVE_TYPES.has(f.type)) primitiveBodies++;
                else if (SHAPING_TYPES.has(f.type)) {
                    shapedBodies++;
                    // A pattern of holes is the usual vent signature.
                    if ((f.type === 'Hole' || /Pattern/.test(f.type))) hasVentLikeHoles = true;
                }
            }
            const totalBodies = primitiveBodies + shapedBodies;

            // notJustPrimitives — deterministic. Shaped parts must dominate; a
            // model that is ALL raw primitives (or has none at all) fails.
            if (totalBodies === 0) {
                checks.notJustPrimitives = false;
                failures.push('No bodies in the document — nothing has been built.');
                guidanceLines.push('Build the structural parts before reviewing.');
            } else if (shapedBodies === 0) {
                checks.notJustPrimitives = false;
                failures.push(`Every body is a raw primitive (${primitiveBodies} box/cylinder/sphere, 0 shaped). This reads as a "box dog", not a functional part.`);
                guidanceLines.push('Shape each part to its function: extrude/loft profiles, cut mounting holes, fillet load paths, shell the body. A leg is not a cylinder; a chassis is not a box.');
            } else {
                checks.notJustPrimitives = true;
            }

            // hasRequiredJoints — needs the morphology spec. Reuse run_invariants
            // for the joint/component truth, then cross-check declared joints.
            let invErrors = [];
            let invWarnings = [];
            try {
                const inv = await runAllInvariants({ measure });
                invErrors = inv.errors || [];
                invWarnings = inv.warnings || [];
            } catch (e) {
                guidanceLines.push(`Could not run invariants: ${(e && e.message) || e} — judge function from your captured views.`);
            }
            // Surface joint-reference / interference failures verbatim (the
            // functional-completeness signal the agent must act on).
            for (const e of invErrors) {
                const id = e.id || e.category || '';
                if (/joint|interference|functional|mobility|constraint/i.test(`${id}`)) {
                    const msg = (e.result && e.result.message) || `invariant ${id} failed`;
                    failures.push(`functional invariant ${id}: ${msg}`);
                }
            }

            if (!morph) {
                // Degraded mode — no mechanism was ever declared. We cannot prove
                // the artifact is articulated, so we cannot pass the function gate.
                checks.hasRequiredJoints = false;
                failures.push('No morphology/mechanism was declared (plan_mechanism was never run), so the articulation cannot be verified.');
                guidanceLines.push('If this is a static object, that is fine — but if the request was a robot/creature/machine, run plan_mechanism to declare the joints + actuators, then build a mount and a structural link for each joint.');
            } else {
                const joints = Array.isArray(morph.joints) ? morph.joints : [];
                const moving = joints.filter((j) => j && j.type !== 'fixed');
                const undriven = moving.filter((j) => !j.drivenBy);
                const unlinked = joints.filter((j) => !j || !j.parentLink || !j.childLink);
                const jointInvFailed = invErrors.some((e) => /joint|functional|interference|mobility/i.test(`${e.id || e.category || ''}`));
                if (moving.length === 0) {
                    checks.hasRequiredJoints = false;
                    failures.push(`Morphology "${morph.archetype || 'artifact'}" declares ${joints.length} joint(s) but none are actuated (all fixed) — a ${morph.archetype || 'machine'} that does not move is cosmetic.`);
                } else if (undriven.length || unlinked.length || jointInvFailed) {
                    checks.hasRequiredJoints = false;
                    if (undriven.length) failures.push(`${undriven.length} actuated joint(s) have no driving actuator: ${undriven.map((j) => j.id).join(', ')}.`);
                    if (unlinked.length) failures.push(`${unlinked.length} joint(s) do not connect two links (missing parent/child): ${unlinked.map((j) => j && j.id).join(', ')}.`);
                    if (jointInvFailed) failures.push('A joint/interference invariant failed — see functional invariant entries above.');
                    guidanceLines.push('Every declared joint needs an actuator placed (placeLibraryPart a servo), a mount that hosts it, and a structural link on both sides. Bind structure to the skeleton.');
                } else {
                    checks.hasRequiredJoints = true;
                }
            }

            // ventsPresent — best-effort. If the morphology / invariants imply heat
            // sources (a controller/battery/servo skeleton) we expect vents; we can
            // only positively detect hole-patterns deterministically, so a missing
            // signal is guidance, not a hard fail unless a robot was requested.
            if (hasVentLikeHoles) {
                checks.ventsPresent = true;
            } else if (morph) {
                checks.ventsPresent = null;
                guidanceLines.push('Confirm vents/openings sit over heat sources (controller, battery, driven servos). No hole/vent pattern was detected in the feature tree — if there are powered components, add a vent_grille / hole pattern over them.');
            }

            // serviceable — deferred to the serviceability invariant + your view.
            if (invErrors.some((e) => /serviceab|access|replace/i.test(`${e.id || e.category || ''}`))) {
                checks.serviceable = false;
                failures.push('A serviceability invariant failed — a replaceable part is blocked or not fastened.');
            }

            // ── Visual judgments the scaffold cannot make — instruct the model ───
            guidanceLines.push(
                'VISUAL JUDGMENT (do this from your captured views — if you have not captured views, call capture_views first):',
                '- readsAsRequested: does the silhouette read as the requested artifact, or as an abstract pile of boxes/cylinders? If box-like, reshape.',
                '- proportionsSane: are the proportions plausible vs the archetype pattern (body/limb ratios, joint spacing)? If a leg is as fat as the body, fix it.',
            );

            // Verdict: any deterministic failure → fix-needed. The visual checks
            // are left null for the model to fill in and act on; if it judges them
            // bad it must NOT claim success.
            const verdict = failures.length ? 'fix-needed' : 'ok';
            const guidance = verdict === 'fix-needed'
                ? `This design is not ready. ${failures.length} issue(s) must be fixed. ${guidanceLines.join(' ')}`
                : `Deterministic checks passed. You must still judge the VISUAL rubric (readsAsRequested, proportionsSane) from your captured views and only claim success if it genuinely reads as the requested artifact. ${guidanceLines.join(' ')}`;

            return {
                ok: true,
                verdict,
                checks,
                failures,
                guidance,
                morphologyDeclared: !!morph,
                bodyCounts: { primitive: primitiveBodies, shaped: shapedBodies, total: totalBodies },
                note: note || undefined,
            };
        },
    },
];

export default VALIDATION_TOOLS;
