/**
 * Planner tool layer — gives the agent a connector-seam-aware build plan
 * BEFORE it starts mutating the document.
 *
 *   PLANNER_TOOLS — array of { name, description, input_schema, handler }
 *
 * The studio's decomposition seams are SEMANTIC, not part-agnostic: a component
 * is a real sub-assembly node and a connector is a real attachment boundary
 * (CLAUDE.md "The connector contract"). So `plan_assembly` doesn't chop a goal
 * into arbitrary chunks — it returns the canonical assembly order as a list of
 * typed steps (decompose → place/build → declareConnector → mate → verify),
 * with a verify after every mate and a final whole-assembly verify. The agent
 * calls this once at the top of a complex multi-part task to get a checklist it
 * can execute step by step.
 *
 * Pure planning only: this tool reads nothing and mutates nothing — it never
 * touches the document store or the kernel, so it can't fail on infrastructure
 * and is safe to call any time. Like every tool handler here it NEVER throws —
 * try/catch → { ok:false, error }.
 */

import { N, S, B, ARR, fail } from './tools_util.js';
import { buildAssemblyPlan, summarizePlan } from './planner.js';

const TOOLS = [
    {
        name: 'plan_assembly',
        description:
            'Plan a complex multi-part model BEFORE you build it. Returns an ordered, connector-seam-aware checklist of typed steps in the canonical assembly order: decompose the goal into a sub-assembly tree → for each part PLACE it (library) or BUILD it (custom primitives/sketch) → declareConnector on every custom-built part → mate parts at their connectors → verify after each mate → a final whole-assembly verify (no interference, mates solved, induced joints correct). ' +
            'Pass `parts` once you know the part list (each: name, source "library" or "build", and its mates [{ to, via }]); omit `parts` to get a TEMPLATE plan skeleton you fill in. Read-only — it plans, it does not modify the document. Call this first on any multi-part assembly, then execute the steps.',
        input_schema: {
            type: 'object',
            properties: {
                goal: S('The multi-part goal in one line, e.g. "M5 bolt-and-nut clamping two plates" or "SG90 servo bracket bolted to a base".'),
                parts: {
                    type: 'array',
                    description: 'Optional ordered part list. Omit for a fill-in template plan. Each part: { name, source, mates }.',
                    items: {
                        type: 'object',
                        properties: {
                            name: S('Stable part name (e.g. "bolt", "nut", "bracket"). Used to reference it in mates.'),
                            source: S('Where the part comes from: "library" (place a catalog/library part) or "build" (model it from primitives/sketch — it will need its connectors declared).', { enum: ['library', 'build'] }),
                            mates: {
                                type: 'array',
                                description: 'Seams joining this part to others. Each: { to: other part name, via: connector kind/profile e.g. "thread", "slot" }.',
                                items: {
                                    type: 'object',
                                    properties: {
                                        to: S('Name of the part this one mates to.'),
                                        via: S('The connector kind or profile the seam uses (e.g. "thread", "bore", "slot", "rail", "tslot-2020").'),
                                    },
                                },
                            },
                        },
                        required: ['name'],
                    },
                },
            },
            required: ['goal'],
        },
        handler: (i) => {
            try {
                const input = i || {};
                if (!input.goal || typeof input.goal !== 'string' || !input.goal.trim()) {
                    return { ok: false, error: 'plan_assembly needs a non-empty goal string describing the multi-part model.' };
                }
                const parts = Array.isArray(input.parts) ? input.parts : undefined;
                const plan = buildAssemblyPlan({ goal: input.goal, parts });
                const summary = summarizePlan(plan);
                return { ok: true, plan, summary };
            } catch (e) {
                return fail(e);
            }
        },
    },
];

export const PLANNER_TOOLS = TOOLS;

export default PLANNER_TOOLS;
