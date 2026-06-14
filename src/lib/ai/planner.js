/**
 * Connector-aware decomposition planner.
 *
 *   buildAssemblyPlan({ goal, parts }) — turn a complex multi-part goal into an
 *                     ordered, connector-seam-aware build plan the agent runs
 *                     step by step.
 *   summarizePlan(plan)                — render a plan as a short markdown
 *                     checklist string.
 *
 * This is the studio's SEMANTIC answer to part-agnostic "fleets of agents"
 * pipelines: our decomposition seams are real. A component is a genuine
 * sub-assembly node and a connector is a genuine attachment boundary (see
 * CLAUDE.md "The connector contract"). So instead of chopping a goal into
 * arbitrary chunks, we walk the canonical assembly order and emit one typed
 * step per real seam:
 *
 *   decompose → for each part { place (library) | build (primitives/sketch) →
 *   declareConnector (custom-built parts only) } → mate parts at their
 *   connectors → verify after every mate → final whole-assembly verify.
 *
 * Steps are typed and carry explicit `dependsOn` edges so the agent (or the
 * orchestrator) knows what must already exist before a step can run. The
 * function is PURE and DETERMINISTIC — no Date / Math.random; step ids are
 * sequential integers assigned in emission order, so the same input yields a
 * byte-identical plan every time.
 *
 * When `parts` is omitted we return a structured TEMPLATE plan — the same
 * typed-step skeleton with placeholder details — that the agent fills in once
 * it has decided on the real part list. The skeleton still encodes the
 * canonical order so a weak model can't reorder the seams.
 */

/**
 * @typedef {object} PlanStep
 * @property {number} step           — sequential integer id (1-based).
 * @property {'decompose'|'place'|'build'|'declareConnector'|'mate'|'verify'} kind
 * @property {string} detail         — one-line human-readable instruction.
 * @property {number[]} dependsOn    — step ids that must complete first.
 * @property {string} [part]         — the part name this step concerns (when scoped to one part).
 */

/** The canonical step ordering — emitted in exactly this sequence. */
export const PLAN_KIND_ORDER = ['decompose', 'place', 'build', 'declareConnector', 'mate', 'verify'];

/** A line/channel kind whose mate induces a slide (prismatic) joint by default. */
const CHANNEL_KINDS = new Set(['slot', 'rail']);

/** Trim a value to a short, safe one-line string for a step detail. */
function oneLine(v, fallback) {
    if (v === undefined || v === null) return fallback;
    const s = String(v).replace(/\s+/g, ' ').trim();
    return s.length ? s : fallback;
}

/** Stable display name for a part entry (deterministic — index-derived fallback). */
function partLabel(p, index) {
    if (p && typeof p.name === 'string' && p.name.trim().length) return p.name.trim();
    return `part_${index + 1}`;
}

/** Did the author declare this part as built from custom geometry (vs placed)? */
function isBuilt(p) {
    return !!p && p.source === 'build';
}

/**
 * Build an ordered, connector-seam-aware assembly plan.
 *
 * @param {object} opts
 * @param {string} opts.goal                  — the user's multi-part goal.
 * @param {Array<{ name?: string, source?: 'library'|'build',
 *                 mates?: Array<{ to?: string, via?: string }> }>} [opts.parts]
 *        — optional explicit part list. Omit it to get a TEMPLATE plan.
 * @returns {{ goal: string, template: boolean, parts: string[], steps: PlanStep[] }}
 */
export function buildAssemblyPlan({ goal, parts } = {}) {
    const goalStr = oneLine(goal, 'unstated assembly goal');
    const steps = [];
    let nextId = 1;
    const add = (kind, detail, dependsOn, extra) => {
        const s = { step: nextId++, kind, detail, dependsOn: dependsOn.slice() };
        if (extra && extra.part) s.part = extra.part;
        steps.push(s);
        return s.step;
    };

    // Step 1 — always: decompose the goal into the sub-assembly tree. Every
    // later step depends (transitively) on the decomposition.
    const decomposeId = add(
        'decompose',
        `Decompose "${goalStr}" into its sub-assembly tree: list each part, whether it is a LIBRARY part (place it) or a CUSTOM part (build it from primitives/sketch), and which connector seams join them.`,
        [],
    );

    // ── TEMPLATE branch ──────────────────────────────────────────────────────
    // No parts supplied → emit a typed-step skeleton the agent fills in. We keep
    // the canonical order so the seams can't be reordered, using two illustrative
    // placeholder parts (one placed, one built) so every kind appears once.
    const isTemplate = !Array.isArray(parts) || parts.length === 0;
    if (isTemplate) {
        const placeId = add(
            'place',
            'For each LIBRARY part: search_library, then placeLibraryPart (mate it to a host connector if a seam is already known).',
            [decomposeId],
        );
        const buildId = add(
            'build',
            'For each CUSTOM part: model it from primitives/sketch (addBox/addCylinder/addExtrude/…).',
            [decomposeId],
        );
        const declId = add(
            'declareConnector',
            'On each CUSTOM-built part, declareConnector at every attachment seam (exact contact point, outward axis, explicit gender/size, inducedJoint). Library parts already carry connectors.',
            [buildId],
        );
        const mateId = add(
            'mate',
            'Mate the parts at their connectors (placeLibraryPart with a hostConnectorId, or add_mate) so each seam is solved and its induced joint declared.',
            [placeId, declId],
        );
        add(
            'verify',
            'After each mate: measure interference at the seam and confirm the mate solved + induced joint is correct.',
            [mateId],
        );
        add(
            'verify',
            'Whole assembly: run_invariants + measure interference across all bodies, confirm every mate solved and joints are correct, then self_critique before declaring done.',
            [mateId],
            null,
        );
        return { goal: goalStr, template: true, parts: [], steps };
    }

    // ── Concrete branch ───────────────────────────────────────────────────────
    // Per-part: place (library) OR build (custom) → declareConnector (custom
    // only). Record the producing step id per part name so mates can depend on
    // both endpoints existing.
    const labels = parts.map((p, i) => partLabel(p, i));
    /** part label → { readyId, built } where readyId is the last step that must exist before a mate. */
    const partState = new Map();

    parts.forEach((p, i) => {
        const label = labels[i];
        if (isBuilt(p)) {
            const buildId = add(
                'build',
                `Build custom part "${label}" from primitives/sketch.`,
                [decomposeId],
                { part: label },
            );
            // Rule: a custom-built part must declare its connectors BEFORE any
            // mate references them (a library part already ships connectors).
            const declId = add(
                'declareConnector',
                `Declare connector(s) on "${label}" at each attachment seam — exact contact point in part-local mm, outward axis, explicit gender/size, inducedJoint.`,
                [buildId],
                { part: label },
            );
            partState.set(label, { readyId: declId, built: true });
        } else {
            const placeId = add(
                'place',
                `Place library part "${label}" (search_library → placeLibraryPart).`,
                [decomposeId],
                { part: label },
            );
            partState.set(label, { readyId: placeId, built: false });
        }
    });

    // Per-part mates, in part order. Each mate depends on BOTH endpoints being
    // ready (placed/built + connectors declared) and on the decomposition.
    const mateStepIds = [];
    parts.forEach((p, i) => {
        const label = labels[i];
        const mates = (p && Array.isArray(p.mates)) ? p.mates : [];
        for (const m of mates) {
            const toLabel = oneLine(m && m.to, '');
            const via = oneLine(m && m.via, '');
            const fromState = partState.get(label);
            const toState = toLabel ? partState.get(toLabel) : null;
            const deps = [decomposeId];
            if (fromState) deps.push(fromState.readyId);
            if (toState) deps.push(toState.readyId);
            const viaTxt = via ? ` via "${via}"` : '';
            const toTxt = toLabel ? `"${toLabel}"` : 'its host';
            const channel = via && CHANNEL_KINDS.has(via.toLowerCase());
            const jointHint = channel
                ? ' (channel seam → prismatic joint)'
                : '';
            const mateId = add(
                'mate',
                `Mate "${label}" to ${toTxt}${viaTxt} at their connectors; confirm the seam is solved and the induced joint is correct${jointHint}.`,
                dedupe(deps),
                { part: label },
            );
            mateStepIds.push(mateId);
            // A verify step after EACH mate — the seam-level interference check.
            add(
                'verify',
                `Verify the "${label}"↔${toTxt} seam: measure interference at the connector and confirm the mate solved with the correct induced joint.`,
                [mateId],
                { part: label },
            );
        }
    });

    // Final whole-assembly verify — depends on every mate (or, if no mates were
    // declared, on every part being ready so a single-part plan still verifies).
    const finalDeps = mateStepIds.length
        ? mateStepIds.slice()
        : [...partState.values()].map((s) => s.readyId);
    add(
        'verify',
        'Verify the whole assembly: run_invariants + measure interference across all bodies, confirm every mate solved and all induced joints are correct, then self_critique before declaring done.',
        dedupe(finalDeps.length ? finalDeps : [decomposeId]),
    );

    return { goal: goalStr, template: false, parts: labels, steps };
}

/** Drop duplicate ids while preserving order (deterministic). */
function dedupe(ids) {
    const seen = new Set();
    const out = [];
    for (const id of ids) {
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(id);
    }
    return out;
}

/**
 * Render a plan as a short markdown checklist string. Pure / deterministic.
 *
 * @param {{ goal?: string, template?: boolean, steps?: PlanStep[] }} plan
 * @returns {string}
 */
export function summarizePlan(plan) {
    if (!plan || !Array.isArray(plan.steps) || !plan.steps.length) {
        return '_(empty plan)_';
    }
    const head = `**Assembly plan${plan.template ? ' (template)' : ''}** — ${oneLine(plan.goal, 'unstated goal')}`;
    const rows = plan.steps.map((s) => {
        const dep = (Array.isArray(s.dependsOn) && s.dependsOn.length)
            ? `  _(after ${s.dependsOn.join(', ')})_`
            : '';
        return `- [ ] **${s.step}. ${s.kind}** — ${s.detail}${dep}`;
    });
    return `${head}\n${rows.join('\n')}`;
}

export default buildAssemblyPlan;
