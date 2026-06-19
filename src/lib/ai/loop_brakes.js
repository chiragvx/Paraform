/**
 * Loop brakes — convergence guards for the agent loop.
 *
 * Two failure modes seen on real builds, each gets a guard:
 *
 * 1. EDIT CHURN — re-editing one part's SCRIPT in circles (editBuildScript →
 *    recompile → measure → "not right" → editBuildScript …). Counted per
 *    (tool,target); soft nudge then hard block on that one target.
 *
 * 2. POSITIONING FLAIL — trying to place a part RELATIVE to another by hand,
 *    with addMove/addRotate, which transform a body about the WORLD origin (not
 *    the part's pivot). A hinged part (laptop-stand back-support that should sit
 *    at a hinge and tilt 25°) sends the model into a move-rotate-move-undo spiral
 *    that never converges — it once burned ~30 calls and still got it wrong. The
 *    deterministic answer is mate_parts (seat the connectors) then drive_joint
 *    (set the hinge angle). This guard counts repositioning of one target ACROSS
 *    the whole move/rotate/mate family (so alternating tools can't dodge it) and,
 *    after a few attempts, BLOCKS the manual move/rotate trap while leaving the
 *    deterministic mate_parts / drive_joint path open — funnelling the model onto
 *    the tools that actually work.
 */

// Edit tools that act on a single identifiable target (script/param churn).
export const EDIT_TOOLS = new Set([
    'editBuildScript', 'setFeatureParams', 'deleteFeature', 'setComponentTransform',
]);
export const EDIT_SOFT_LIMIT = 5;   // same (tool,target) this many times → one steering nudge
export const EDIT_HARD_LIMIT = 9;   // …and this many → block further edits to that target

// Positioning tools: any attempt to place a part. Counted PER TARGET (tool-
// agnostic) so move+rotate+mate on one part accumulate together.
export const POSITIONING_TOOLS = new Set([
    'addMove', 'addRotate', 'mate_parts', 'add_mate',
]);
// The trap — transforms about the world origin, never converges on a pivot. These
// get hard-blocked once the funnel trips; mate_parts / drive_joint never do.
export const MANUAL_POSITIONING = new Set(['addMove', 'addRotate']);
export const POS_SOFT_LIMIT = 3;    // repositioned this many times → steer to mate/drive
export const POS_HARD_LIMIT = 6;    // …and this many → block manual move/rotate on that part

/** The id an edit / placement is "about", so churn can be counted per target. */
export function editTargetOf(input) {
    if (!input || typeof input !== 'object') return '';
    return String(input.featureId || input.componentId || input.partConnectorId
        || input.id || input.oldComponentId || '');
}

const EDIT_SOFT_NOTE = (target, c) =>
    `[automatic check] You have edited ${target} ${c} times this turn. If you are fighting its placement, STOP nudging coordinates by hand — build the part at the origin and SEAT it with connectors + mate_parts, which solves the position exactly. Otherwise accept the current state and move to the next part.`;
const EDIT_HARD_NOTE = (target, c) =>
    `[automatic check] You have edited ${target} ${c} times this turn — that is the flailing spiral, not progress. Further hand-edits to ${target} are now disabled. Position parts deterministically: build each at the origin, declareConnector where they touch, and mate_parts to seat them. If the placement is already good enough, leave it and move on.`;
const EDIT_BLOCK_NOTE = (tool, target) =>
    `edit blocked: "${tool}" has changed ${target} ${EDIT_HARD_LIMIT}+ times this turn (oscillation guard). Stop hand-tuning it. Build the part at the origin and SEAT it with connectors + mate_parts, or accept the current state and move on. Further edits to ${target} are disabled for this turn.`;

const POS_SOFT_NOTE = (target, c) =>
    `[automatic check] You have repositioned ${target} ${c} times this turn with manual move/rotate. addMove/addRotate transform about the WORLD origin, not a pivot — they will NOT put a part on a hinge and this never converges. Do it deterministically instead: mate_parts the two connectors that touch (this seats them and, for a hinge, creates a revolute joint), then drive_joint(jointId, angle) to set the tilt/open angle. Find the jointId in the mate_parts result or via list_joints.`;
const POS_HARD_NOTE = (target) =>
    `[automatic check] Manual repositioning of ${target} is now DISABLED — you are in the move/rotate/undo spiral that never converges. Position it the deterministic way: mate_parts the connectors that meet (seats the part; for a hinge it makes a revolute joint), then drive_joint(jointId, <degrees>) for the angle. Declare connectors first with declareConnector if the part has none.`;
const POS_BLOCK_NOTE = (tool, target) =>
    `blocked: "${tool}" hand-positions ${target} about the world origin and you are in the non-converging move/rotate spiral. Use the deterministic path instead — mate_parts the connectors that touch (seats the part; a hinge becomes a revolute joint), then drive_joint(jointId, <degrees>) to set the angle. list_joints / list_connectors show the ids. Manual move/rotate of ${target} is disabled for this turn.`;

/**
 * A stateful per-turn guard. `check(tool, input)` is called BEFORE dispatching a
 * tool and returns one of:
 *   { action:'allow' }
 *   { action:'nudge', note, hard? }   — dispatch, then inject `note` as a steer
 *   { action:'block', note }          — DO NOT dispatch; synthesize a failed
 *                                        result carrying `note` (.error)
 */
export function makeOscillationGuard() {
    const editCounts = new Map();
    const editNudged = new Set();
    const editBlocked = new Set();
    const posCounts = new Map();        // target → total positioning attempts
    const posNudged = new Set();
    const posFunnelled = new Set();     // targets whose MANUAL positioning is blocked

    return {
        check(tool, input) {
            const target = editTargetOf(input);

            // ── Positioning funnel ───────────────────────────────────────────
            if (POSITIONING_TOOLS.has(tool) && target) {
                if (MANUAL_POSITIONING.has(tool) && posFunnelled.has(target)) {
                    return { action: 'block', target, note: POS_BLOCK_NOTE(tool, target) };
                }
                const c = (posCounts.get(target) || 0) + 1;
                posCounts.set(target, c);
                if (c >= POS_HARD_LIMIT) {
                    posFunnelled.add(target);              // manual move/rotate now off for this part
                    return { action: 'nudge', target, hard: true, note: POS_HARD_NOTE(target) };
                }
                if (c >= POS_SOFT_LIMIT && !posNudged.has(target)) {
                    posNudged.add(target);
                    return { action: 'nudge', target, note: POS_SOFT_NOTE(target, c) };
                }
                return { action: 'allow' };
            }

            // ── Edit churn ───────────────────────────────────────────────────
            if (EDIT_TOOLS.has(tool) && target) {
                const sig = `${tool}:${target}`;
                if (editBlocked.has(sig)) return { action: 'block', target, note: EDIT_BLOCK_NOTE(tool, target) };
                const c = (editCounts.get(sig) || 0) + 1;
                editCounts.set(sig, c);
                if (c >= EDIT_HARD_LIMIT) {
                    editBlocked.add(sig);
                    return { action: 'nudge', target, hard: true, note: EDIT_HARD_NOTE(target, c) };
                }
                if (c >= EDIT_SOFT_LIMIT && !editNudged.has(sig)) {
                    editNudged.add(sig);
                    return { action: 'nudge', target, note: EDIT_SOFT_NOTE(target, c) };
                }
            }
            return { action: 'allow' };
        },
    };
}
