/**
 * Loop brakes — convergence guards for the agent loop.
 *
 * The failure this exists for: a model "rethinking the layout", re-editing ONE
 * part's coordinates over and over (editBuildScript → recompile → measure →
 * "not right" → editBuildScript …) — a spiral that never converges, produces a
 * bad assembly, AND on un-caching providers re-bills the whole transcript every
 * one of those calls. A simple laptop stand burned 60+ model calls this way.
 *
 * The guard counts edits to the SAME target (tool + the id it acts on). After a
 * SOFT limit it steers the model toward deterministic placement (connectors +
 * mate_parts); after a HARD limit it BLOCKS further edits to that one target so
 * the model is forced to change strategy or move on. It is intentionally
 * per-(tool,target): legitimate work touches many different targets a few times
 * each; only pathological churn hammers one target.
 */

// Edit tools that act on a single identifiable target. Churn on one of these is
// the layout-flailing spiral; read-only and create-new tools are not listed.
export const EDIT_TOOLS = new Set([
    'editBuildScript', 'setFeatureParams', 'addMove', 'addRotate',
    'mate_parts', 'add_mate', 'deleteFeature', 'setComponentTransform',
]);

export const EDIT_SOFT_LIMIT = 5;   // same (tool,target) this many times → one steering nudge
export const EDIT_HARD_LIMIT = 9;   // …and this many → block further edits to that target

/** The id an edit is "about", so churn can be counted per target. */
export function editTargetOf(input) {
    if (!input || typeof input !== 'object') return '';
    return String(input.featureId || input.componentId || input.partConnectorId
        || input.id || input.oldComponentId || '');
}

const SOFT_NOTE = (target, c) =>
    `[automatic check] You have edited ${target} ${c} times this turn. If you are fighting its placement, STOP nudging coordinates by hand — build the part at the origin and SEAT it with connectors + mate_parts (declareConnector → mate_parts), which solves the position exactly. Otherwise accept the current state and move to the next part.`;

const HARD_NOTE = (target, c) =>
    `[automatic check] You have edited ${target} ${c} times this turn — that is the layout-flailing spiral, not progress. Further hand-edits to ${target} are now disabled. Position parts deterministically: build each at the origin, declareConnector where they touch, and mate_parts to seat them. If the placement is already good enough, leave it and move on.`;

const BLOCK_NOTE = (tool, target) =>
    `edit blocked: "${tool}" has changed ${target} ${EDIT_HARD_LIMIT}+ times this turn (oscillation guard). Stop hand-tuning its coordinates. Build each part at the origin and SEAT it with connectors + mate_parts (declareConnector → mate_parts), or accept the current placement and move to the next part. Further edits to ${target} are disabled for this turn.`;

/**
 * A stateful per-turn oscillation guard. `check(tool, input)` is called BEFORE
 * dispatching a tool and returns one of:
 *   { action:'allow' }                       — dispatch normally
 *   { action:'nudge', note, hard? }          — dispatch, then inject `note` as a steer
 *   { action:'block', note }                 — DO NOT dispatch; synthesize a failed
 *                                               result carrying `note` (.error)
 */
export function makeOscillationGuard() {
    const counts = new Map();
    const nudged = new Set();
    const blocked = new Set();
    return {
        check(tool, input) {
            if (!EDIT_TOOLS.has(tool)) return { action: 'allow' };
            const target = editTargetOf(input);
            if (!target) return { action: 'allow' };
            const sig = `${tool}:${target}`;
            if (blocked.has(sig)) return { action: 'block', target, note: BLOCK_NOTE(tool, target) };
            const c = (counts.get(sig) || 0) + 1;
            counts.set(sig, c);
            if (c >= EDIT_HARD_LIMIT) {
                blocked.add(sig);                       // the NEXT edit to this target is blocked
                return { action: 'nudge', target, hard: true, note: HARD_NOTE(target, c) };
            }
            if (c >= EDIT_SOFT_LIMIT && !nudged.has(sig)) {
                nudged.add(sig);
                return { action: 'nudge', target, note: SOFT_NOTE(target, c) };
            }
            return { action: 'allow' };
        },
    };
}
