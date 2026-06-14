/**
 * Conversation-memory tools — give the assistant a durable, queryable design
 * context across turns: a structured brief, English-name → id bindings ("the
 * bracket" = box_3), a decision log it can explain later, a requirements ledger
 * it stays accountable to, and the working units.
 *
 * All state lives in the design-context singleton (./context.js), which is
 * serialised with the chat session and injected (compactly) into the system
 * prompt every turn. These tools are how the model READS and WRITES it.
 */

import { getAIContext } from './context.js';
import { N, S } from './tools_util.js';

export const CONTEXT_TOOLS = [
    {
        name: 'propose_brief',
        description: 'Record a structured design brief distilled from a vague request: what the part is FOR, key dimensions, fits, material, process, target printer. Surface inferred defaults so the user can correct them. Build this for a non-trivial new design before modelling, and keep it as the spec you check against.',
        input_schema: {
            type: 'object',
            properties: {
                function: S('What the part/assembly is for, in one line'),
                dimensions: { type: 'object', additionalProperties: true, description: 'Key dimensions you are designing to (mm)' },
                fits: { type: 'object', additionalProperties: true, description: 'Fits/clearances that matter' },
                material: S('Target material (e.g. PLA, PETG, ASA, aluminium)'),
                process: S('Manufacturing process', { enum: ['fdm', 'sla', 'sls', 'cnc', 'other'] }),
                targetPrinter: S('Target printer / build volume if known'),
                notes: S('Any assumptions you made and their basis'),
            },
            required: ['function'],
        },
        handler: (i) => {
            const brief = getAIContext().setBrief({
                function: i.function,
                dimensions: i.dimensions || null,
                fits: i.fits || null,
                material: i.material || null,
                process: i.process || null,
                targetPrinter: i.targetPrinter || null,
                notes: i.notes || null,
            });
            return { ok: true, brief, summary: 'Recorded design brief' };
        },
    },
    {
        name: 'name_feature',
        description: 'Bind a human name ("baseplate", "the left arm") to a feature or component id so the user can refer to it in plain language later and you can resolve it. Any later tool that takes an id will also accept this name.',
        input_schema: {
            type: 'object',
            properties: {
                id: S('Feature or component id to name'),
                name: S('The human name to bind to it'),
            },
            required: ['id', 'name'],
        },
        handler: (i) => {
            const ok = getAIContext().alias(i.name, i.id);
            return ok ? { ok: true, summary: `Named ${i.id} "${i.name}"` } : { ok: false, error: 'name_feature needs a non-empty id and name' };
        },
    },
    {
        name: 'get_context',
        description: 'Read the persistent design context: the brief, the name→id bindings, the decision log, the requirements ledger, and the working units. Use it to recall what was decided ("what wall thickness did we settle on?") without re-asking.',
        input_schema: { type: 'object', properties: {} },
        handler: () => ({ ok: true, ...getAIContext().snapshot() }),
    },
    {
        name: 'record_decision',
        description: 'Log a design decision and WHY you made it (e.g. "walls 2.8mm — sturdy snap-fit at 0.4mm nozzle"). Lets you truthfully answer "why?" later. Record load-bearing choices as you make them.',
        input_schema: {
            type: 'object',
            properties: {
                what: S('The decision (e.g. "wall = 2.8mm")'),
                why: S('The reason / source for it'),
            },
            required: ['what'],
        },
        handler: (i) => {
            const ok = getAIContext().recordDecision(i.what, i.why);
            return ok ? { ok: true, summary: `Logged decision: ${i.what}` } : { ok: false, error: 'record_decision needs a non-empty "what"' };
        },
    },
    {
        name: 'explain_decision',
        description: 'Look up the recorded reason for a past decision by topic ("walls", "M3", "fillet") to answer a "why?" question truthfully from the log instead of guessing.',
        input_schema: {
            type: 'object',
            properties: { topic: S('What to look up (a keyword from the decision)') },
            required: ['topic'],
        },
        handler: (i) => {
            const d = getAIContext().findDecision(i.topic);
            return d ? { ok: true, decision: d } : { ok: true, decision: null, note: `No recorded decision matching "${i.topic}".` };
        },
    },
    {
        name: 'add_requirement',
        description: 'Add a measurable requirement from the conversation to the ledger ("under 200 g", "fits an M3 bolt", "<=120mm wide") so you re-verify it after edits. Only add EXPLICIT, measurable requirements the user actually stated.',
        input_schema: {
            type: 'object',
            properties: {
                text: S('The requirement in plain words'),
                kind: S('Kind of requirement', { enum: ['dimension', 'mass', 'fit', 'clearance', 'count', 'note'] }),
                comparator: S('Comparator if numeric', { enum: ['<=', '>=', '==', '~'] }),
                value: N('Numeric target if applicable'),
                unit: S('Unit (default mm)'),
                target: S('Feature/component the requirement applies to, if specific'),
            },
            required: ['text'],
        },
        handler: (i) => {
            const rec = getAIContext().addRequirement(i);
            return rec ? { ok: true, requirement: rec, summary: `Logged requirement: ${rec.text}` } : { ok: false, error: 'add_requirement needs non-empty text' };
        },
    },
    {
        name: 'verify_requirement',
        description: 'Update a ledger requirement\'s status after you measured the geometry. status: met / failed / unknown. Pass the measured value so it is recorded.',
        input_schema: {
            type: 'object',
            properties: {
                id: S('Requirement id (from add_requirement / get_context)'),
                status: S('Outcome', { enum: ['met', 'failed', 'unknown'] }),
                measured: N('The measured value, if any'),
            },
            required: ['id', 'status'],
        },
        handler: (i) => {
            const ok = getAIContext().setRequirementStatus(i.id, i.status, i.measured);
            return ok ? { ok: true, summary: `Requirement ${i.id}: ${i.status}` } : { ok: false, error: `no requirement with id ${i.id}` };
        },
    },
    {
        name: 'set_units',
        description: 'Record the working unit if the user works in something other than mm (the model itself is always mm internally — this is a note for the conversation).',
        input_schema: {
            type: 'object',
            properties: { units: S('Unit, e.g. mm, cm, in') },
            required: ['units'],
        },
        handler: (i) => { getAIContext().setUnits(i.units); return { ok: true, summary: `Units: ${i.units}` }; },
    },
];

export default CONTEXT_TOOLS;
