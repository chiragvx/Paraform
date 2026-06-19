/**
 * Agent loop — drives a tool-using model turn over the typed document ops,
 * through the provider abstraction (./providers/) so the backend is switchable.
 * Gemini is the default working path; Anthropic stays selectable in settings.
 *
 *   runAgentTurn({ userMessage, history, onEvent, signal, endpoint }) → { history }
 *
 * The loop (provider-agnostic):
 *   1. Append the user message to the NORMALIZED history (neutral entries —
 *      see providers/index.js).
 *   2. Ask the provider to build the request body; stream it through the proxy.
 *   3. Parse the assistant turn (text + toolCalls). Record it on history.
 *   4. If there are toolCalls, run dispatchTool for each, append tool results,
 *      and loop again.
 *   5. Stop when the provider reports `stop` (no further tool round-trip) or
 *      there are no toolCalls. Cap at MAX_ITERATIONS.
 *
 * Events emitted via `onEvent` (unchanged names so ChatPanel needs no rework):
 *   { type:'text', text }                 — assistant prose (streamed deltas)
 *   { type:'tool_call', name, input }      — a tool was invoked
 *   { type:'tool_result', name, result }   — its result
 *   { type:'usage', usage }                — token usage for a model call
 *   { type:'done' }                        — the turn finished
 *   { type:'error', error }                — fatal error (loop aborts)
 *
 * Returns the updated normalized history so the caller can persist it for the
 * next turn. Provider + model + max_tokens come from settings.
 */

import { AGENT_TOOLS, dispatchTool, documentSummary, sceneDigest } from './tools.js';
import { GENERATOR_TOOLS } from './tools_generators.js';
import { MECHANISM_TOOLS } from './tools_mechanism.js';
import { SYSTEM_PROMPT } from './system_prompt.js';
import { streamChat } from './provider.js';
import { getProvider, DEFAULT_PROVIDER } from './providers/index.js';
import { readSettings } from '../../../app/settings/index.js';
import { getAIContext } from './context.js';
import { compileCurrent } from './tools_validation.js';
import { runVisionCritique, visionCriticActive } from './vision_critic.js';
import { getPlanGraph } from './plan/graph.js';
import { seedPlanGraph } from './plan/decompose.js';
import { syncPlanGraphToDoc } from './plan/sync.js';

// ── Per-turn tool triage ─────────────────────────────────────────────────────
// The full surface is ~146 tools (~30k tokens). Sending all of them every turn
// is expensive AND degrades tool selection (the model has to find the right one
// in a 146-item list — exactly where weak/mid models hallucinate or mis-pick).
// We send a RELEVANT subset instead, with NO caching dependency:
//   - every non-generator tool stays on (the workflow / edit / assembly /
//     verify / plan surface is always available),
//   - the 70 parametric generators are GATED by keyword: a generator is offered
//     only when the conversation actually mentions it (a few structural staples
//     stay always-on so common "glue" parts are reachable).
// dispatchTool still resolves against ALL tools, so nothing breaks if a gated
// tool is somehow invoked — it just isn't advertised when irrelevant.
const _GENERATOR_NAMES = new Set(GENERATOR_TOOLS.map((t) => t.name));
// Structural staples a build commonly needs even when unnamed — kept always-on.
const _ALWAYS_GENERATORS = new Set([
    'addGear', 'addBracket', 'addMountingPlate', 'addStandoff', 'addScrewBoss',
    'addProjectBox', 'addLid', 'addPCBTray',
]);
/** Keywords for a generator, derived from its name (addBatteryHolder → battery, holder). */
function _toolKeywords(name) {
    return name
        .replace(/^add/, '')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/_/g, ' ')
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length >= 3);
}
// Mechanism/linkage planning tools (e.g. plan_mechanism, ~4k tokens alone) are
// only needed for things that MOVE. Their NAMES can't be keyword-derived
// (plan_mechanism would falsely match the very common word "plan"), so they are
// gated on SEMANTIC cues instead.
const _MECHANISM_NAMES = new Set(MECHANISM_TOOLS.map((t) => t.name));
const _MECHANISM_CUES = [
    'mechanism', 'linkage', 'servo', 'motor', 'actuat', 'robot', ' arm', 'joint',
    'revolute', 'prismatic', 'walk', 'gait', 'four-bar', 'crank', 'rocker',
    'steer', 'gearbox', 'rotate', 'rotating', 'hinge', 'gripper', 'leg', 'wheel',
];

/**
 * Pick the tools to advertise this turn. `convText` is the running conversation
 * text (all user/goal messages joined) so a generator named in the request stays
 * offered across the whole turn sequence, not just the turn it was mentioned.
 */
export function selectAgentTools(all, convText) {
    const text = String(convText || '').toLowerCase();
    return all.filter((tool) => {
        if (_GENERATOR_NAMES.has(tool.name)) {
            if (_ALWAYS_GENERATORS.has(tool.name)) return true;  // staple → always on
            return _toolKeywords(tool.name).some((w) => text.includes(w));
        }
        if (_MECHANISM_NAMES.has(tool.name)) {
            return _MECHANISM_CUES.some((w) => text.includes(w));  // only for moving things
        }
        return true;                                             // everything else → always on
    });
}

export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';
export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-4-8';
// OpenAI-compatible GPT-OSS — the core path. The `openai/` prefix matches the
// model id most aggregators use (Groq / OpenRouter / Together / Fireworks).
// Point a self-hosted/OpenAI endpoint at a bare `gpt-oss-120b` via settings.
export const DEFAULT_OPENAI_MODEL = 'nvidia/nemotron-3-ultra-550b-a55b:free';
// Cerebras Cloud (OpenAI-compatible, wafer-scale speed, free tier). gpt-oss-120b
// is its production tool-calling model — the safe default for the agent loop.
export const DEFAULT_CEREBRAS_MODEL = 'gpt-oss-120b';
// NVIDIA NIM (OpenAI-compatible). The model id is user-typed in Settings so they
// can test the catalog; this is just the fallback when the field is left blank.
export const DEFAULT_NVIDIA_MODEL = 'meta/llama-3.3-70b-instruct';
// 0G Compute Router (OpenAI-compatible, decentralized inference). The model id
// is user-typed in Settings (use an id from GET /v1/models, e.g. glm-5,
// deepseek-v4-pro, qwen3.7-max); this is the fallback when the field is left
// blank. Pick a tool-calling model — the router 400s if `tools` go to a model
// that lacks them, and returns "upstream provider request failed" for an
// unknown id.
export const DEFAULT_ZEROG_MODEL = 'minimax-m3';
export const DEFAULT_MAX_TOKENS = 32768;
// High ceiling for TESTING — lets long multi-step builds (with self-repair,
// verify-then-fix, and the see→act→re-check vision loop, which each consume
// iterations) run to completion without tripping the cap. Still bounded so a
// genuine runaway can't loop forever; the per-error repair cap and the
// duplicate-failing-call guard are the tighter, smarter brakes. Lower this for
// production once cost/quota tuning matters.
export const MAX_ITERATIONS = 500;
// How many times the loop will auto-feed the SAME compile error back for repair
// before giving up and asking the user. Prevents thrashing on an unfixable build.
const MAX_REPAIRS_PER_ERROR = 2;

// Auto / focus mode: when on, the agent doesn't accept the model's first "I'm
// done" — it nudges it to keep working until the whole request is genuinely
// complete (one nudge per stop; if it stops again with no work in between, we
// accept it's finished). Bounded so it can't nudge forever in one turn.
const MAX_AUTO_CONTINUES = 50;
const AUTO_NUDGE = "[auto mode] FIRST check the clarify→plan→approve gate: if the user's request is still ambiguous (variant, parts it must fit, key parameters, electronics, mounting) OR you have not yet presented a part-hierarchy plan that the user APPROVED, then the correct next step is to ASK the Stage-0 clarifying questions or PRESENT the plan for sign-off and stop — do NOT start building past an unanswered clarification or an unapproved plan. Only once intent is clear and the plan is approved does the rest of this apply: Do not stop yet unless the user's ORIGINAL request is fully complete and verified. Re-read what they asked for and check: is every part of it built, mated/assembled, and verified (measure / run_invariants / self_critique, and capture_views if it should look right)? If the request is a STATIC/passive part (laptop stand, holder, bracket, mount, enclosure, organizer — no moving joints, no electronics), it is DONE when it is correctly sized, strong/stable enough for its load, and printable — do NOT add servos, motors, or any actuators/electronics to it; that would be a bug. ONLY if the request genuinely MOVES, ARTICULATES, or HOUSES ELECTRONICS is it a functional machine that must not be a stack of bare primitives: in that case did you plan_mechanism (every joint → an actuator + a structural mount), place the real actuators/electronics, build the structural parts (parametrically, via build_part_recipe or code), verify motion clearance (run_invariants), and pass design_review? If anything is unfinished or unverified, CONTINUE now — do the next concrete step yourself without asking. Only if it is genuinely 100% done, briefly confirm what you delivered and stop.";

// Visual-verify gate. The field's strongest accuracy lever (CAD Skills / Zoo
// both MANDATE it; ablations show a large quality regression without it): never
// let the agent finish having built geometry it never LOOKED at. If real
// geometry changed this turn and no capture_views has run since, we force one
// reminder before accepting "done". Bounded so it can't loop.
const MAX_VISUAL_NUDGES = 1;
const VISUAL_GATE_NUDGE = "[automatic check] You built or changed geometry this turn but have not visually verified it. Call capture_views now and LOOK at the renders (front/right/top/iso) — check orientation, proportions, symmetry, parts clipping or floating, oversized fillets. A render is DIAGNOSTIC, not proof: convert any visual concern into a measure call (e.g. holes look off-centre → measure the centres) before you claim it's correct. Then finish with your summary.";
// NOTE: a TEXT-ONLY builder with a vision critic is NOT nudged to look — the
// loop captures + critiques on its behalf (see the stop-gate in runAgentTurn),
// because a weak model can't be trusted to call capture_views on its own.

// ── Dynamic per-turn context ──────────────────────────────────────────────────
//
// The viewport selection lives in a singleton the AI layer can read, but we keep
// the dependency soft (a dynamic import) so a headless / kernel-only context
// never trips on the picking module. Resolved once, read each turn.
let _pickMod = null;
import('../../../lib/picking/selection.js').then((m) => { _pickMod = m; }).catch(() => { _pickMod = null; });

/** One-line description of what the user has picked in the viewport, or ''. */
function selectionSummary() {
    try {
        if (!_pickMod || typeof _pickMod.getPickingSelection !== 'function') return '';
        const sel = _pickMod.getPickingSelection();
        const arr = (sel && typeof sel.toArray === 'function') ? sel.toArray() : [];
        if (!arr.length) return '';
        const items = arr.slice(0, 8).map((e) => {
            const d = (e && e.descriptor) || {};
            return `${d.kind || '?'} on ${d.feature || '?'}`;
        });
        return [
            '# Live viewport selection',
            `- The user has ${arr.length} item(s) PICKED right now: ${items.join('; ')}.`,
            '- When they say "this", "that", "here", act on the selection with the *_selected_* tools (fillet_selected_edges / chamfer_selected_edges / hole_on_selected_face / push_pull_selected_face / offset_selected_face), or call get_selection for detail.',
            '- Do NOT ask "which edge/face?" when something is already selected — resolve the deixis and confirm what you acted on.',
        ].join('\n');
    } catch { return ''; }
}

/** Build the system prompt for this turn = base + design context + selection. */
function buildSystem(visionCapable = true, criticAvailable = false) {
    let block = '';
    try {
        const ctx = getAIContext();
        let knownIds;
        try {
            const summ = documentSummary();
            knownIds = new Set([
                ...(summ.features || []).map((f) => f.id),
                ...(summ.components || []).map((c) => c.id),
            ]);
        } catch { knownIds = undefined; }
        block = ctx.contextBlock(knownIds) || '';
    } catch { block = ''; }
    let scene = '';
    try { scene = sceneDigest() || ''; } catch { scene = ''; }
    const sel = selectionSummary();
    // Vision guidance depends on what the active model can do:
    //  - can see            → keep SYSTEM_PROMPT's "look now" mandate (no override)
    //  - blind + has critic → DO capture_views: a vision reviewer looks for it
    //  - blind, no critic   → don't waste a step capturing; verify numerically
    let noVision = '';
    if (!visionCapable && criticAvailable) {
        noVision = '# Vision: you cannot see images yourself, BUT a vision reviewer can. After you build or change geometry, CALL capture_views — a separate vision model will inspect the renders (front/right/top/iso) and report concrete problems (a bare box that should be a shaped part, missing holes/pockets/fillets, parts clipping, wrong proportions/orientation) back to you as text. Treat that feedback as authoritative for APPEARANCE, fix what it flags, and ALSO verify dimensions/fit NUMERICALLY (measure, mass_properties, run_invariants, self_critique).';
    } else if (!visionCapable) {
        noVision = '# Heads-up: the CURRENT model cannot SEE images. Do NOT call capture_views to "look" or verify appearance — it cannot help you and the render can\'t be shown to you. Verify everything NUMERICALLY instead: measure (bbox / interference / manifold / centroid / distance / normal), mass_properties, run_invariants, self_critique, and check_assembly_constraints for assemblies. Reason about orientation and placement from those numbers and the "Current bodies" digest.';
    }
    return [SYSTEM_PROMPT, block, scene, sel, noVision].filter(Boolean).join('\n\n');
}

/** Normalise a kernel error so repeated attempts on the SAME failure dedupe. */
function errorSignature(error) {
    return String(error || '').toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 160);
}

function truncate(s, n) {
    const str = String(s == null ? '' : s);
    return str.length > n ? str.slice(0, n) + '…' : str;
}

/**
 * Return a view of the history with all image parts removed. A TEXT-ONLY model
 * must never receive image input or the provider rejects the entire request
 * ("No endpoints found that support image input") — this strips user-attached
 * reference images AND any captured renders from the body we send it. The
 * original `messages` array is untouched (kept intact for a vision-capable
 * escalation path and for the critic, which reads renders directly).
 */
function stripImagesFromHistory(history) {
    let changed = false;
    const out = history.map((e) => {
        if (e && e.images && e.images.length) { changed = true; const { images, ...rest } = e; return rest; }
        return e;
    });
    return changed ? out : history;
}

// Tools that observe state or write only conversation/context/export — NONE of
// these change the geometry, so the self-repair net skips the compile check
// after them (it only fires when real geometry was mutated).
const NON_MUTATING_TOOLS = new Set([
    'get_document_summary', 'list_components', 'search_library', 'measure', 'run_invariants',
    'get_selection', 'compile_status', 'mass_properties', 'self_critique',
    'check_printability', 'recommend_material', 'compute_clearance', 'estimate_print',
    'find_compatible_connectors', 'list_connectors', 'generate_bom',
    'get_context', 'propose_brief', 'name_feature', 'record_decision', 'explain_decision',
    'add_requirement', 'verify_requirement', 'set_units',
    'export_for_print', 'export_parts',
    'capture_views', 'web_search', 'web_fetch',
    'plan_assembly', 'check_assembly_constraints',
    // Functional-design pipeline — planning/analysis tools that record a spec to
    // the design context but never mutate geometry (so they skip the compile-check).
    'plan_mechanism', 'plan_serviceability', 'design_review', 'mine_patterns',
]);
// NOTE: plan_skeleton_envelope and build_part_recipe are deliberately NOT here —
// the first can drop an advisory massing box and the second creates a real
// scripted body, so both must trip the self-repair compile-check like any build.
// NOTE: add_mate and declareConnector are deliberately NOT in this set. They
// mutate the assembly (placement / snap contract), so a build-breaking mate or
// a connector that makes the model fail to compile must trip the self-repair
// compile-check below — assembly failures self-heal exactly like geometry
// failures. (plan_assembly / check_assembly_constraints are pure analysis and
// stay observe-only.)

/** Pull { providerName, model, maxTokens, apiKey, baseUrl } from settings. */
function resolveModelConfig() {
    let providerName = DEFAULT_PROVIDER;
    let geminiModel = DEFAULT_GEMINI_MODEL;
    let anthropicModel = DEFAULT_ANTHROPIC_MODEL;
    let openaiModel = DEFAULT_OPENAI_MODEL;
    let cerebrasModel = DEFAULT_CEREBRAS_MODEL;
    let nvidiaModel = DEFAULT_NVIDIA_MODEL;
    let zerogModel = DEFAULT_ZEROG_MODEL;
    let maxTokens = DEFAULT_MAX_TOKENS;
    let escalationModel = '';
    let ai = {};
    try {
        const s = readSettings();
        ai = (s && s.ai) || {};
        if (typeof ai.provider === 'string' && ai.provider.trim()) providerName = ai.provider.trim();
        if (typeof ai.geminiModel === 'string' && ai.geminiModel.trim()) geminiModel = ai.geminiModel.trim();
        if (typeof ai.anthropicModel === 'string' && ai.anthropicModel.trim()) anthropicModel = ai.anthropicModel.trim();
        if (typeof ai.openaiModel === 'string' && ai.openaiModel.trim()) openaiModel = ai.openaiModel.trim();
        if (typeof ai.cerebrasModel === 'string' && ai.cerebrasModel.trim()) cerebrasModel = ai.cerebrasModel.trim();
        if (typeof ai.nvidiaModel === 'string' && ai.nvidiaModel.trim()) nvidiaModel = ai.nvidiaModel.trim();
        if (typeof ai.zerogModel === 'string' && ai.zerogModel.trim()) zerogModel = ai.zerogModel.trim();
        // Opt-in stronger model for HARD steps (self-repair / repeated-failure).
        // Empty = disabled (default), so the deliberate free-model lock stands
        // until the user sets one; it then drives only the difficulty-escalated
        // iterations, not every turn — Zoo's "pick the best spatial reasoner for
        // the hard part" discipline, scoped to where it pays.
        if (typeof ai.escalationModel === 'string' && ai.escalationModel.trim()) escalationModel = ai.escalationModel.trim();
        // Back-compat: an older `model` key applies to whichever provider it names.
        if (typeof ai.model === 'string' && ai.model.trim()) {
            if (ai.model.startsWith('gemini')) geminiModel = ai.model.trim();
            else if (ai.model.startsWith('claude')) anthropicModel = ai.model.trim();
            else if (ai.model.includes('gpt')) openaiModel = ai.model.trim();
        }
        if (Number.isFinite(ai.maxTokens) && ai.maxTokens > 0) maxTokens = ai.maxTokens;
    } catch { /* settings unavailable — use defaults */ }
    // 'mock' / 'anthropic' / unknown provider falls back to the default real
    // provider here; the chat surface always wants a real, supported backend.
    // (Claude was removed as a selectable chat provider — see settings/schema.js.)
    if (!['gemini', 'openai', 'cerebras', 'nvidia', 'zerog'].includes(providerName)) providerName = DEFAULT_PROVIDER;
    const model = providerName === 'anthropic' ? anthropicModel
        : providerName === 'openai' ? openaiModel
        : providerName === 'cerebras' ? cerebrasModel
        : providerName === 'nvidia' ? nvidiaModel
        : providerName === 'zerog' ? zerogModel
        : geminiModel;
    // Optional bring-your-own key for the selected provider, stored in the
    // browser and forwarded to the user's own proxy (see provider.js headers).
    const keyField = providerName === 'anthropic' ? 'anthropicApiKey'
        : providerName === 'openai' ? 'openaiApiKey'
        : providerName === 'cerebras' ? 'cerebrasApiKey'
        : providerName === 'nvidia' ? 'nvidiaApiKey'
        : providerName === 'zerog' ? 'zerogApiKey'
        : 'geminiApiKey';
    const apiKey = (typeof ai[keyField] === 'string' && ai[keyField].trim()) ? ai[keyField].trim() : null;
    const baseUrl = (providerName === 'openai' && typeof ai.openaiBaseUrl === 'string' && ai.openaiBaseUrl.trim())
        ? ai.openaiBaseUrl.trim() : null;
    // Never escalate to the same model we're already on (no-op) — treat that as
    // disabled so the loop doesn't think it has an escalation lever it lacks.
    if (escalationModel && escalationModel === model) escalationModel = '';
    return { providerName, model, maxTokens, apiKey, baseUrl, escalationModel };
}

/**
 * Whether a provider+model can actually accept IMAGE input. The vision loop
 * (capture_views → inject renders → "look") only makes sense for a model that
 * can see; sending an image to a text-only model (e.g. open-weight gpt-oss)
 * makes the provider reject the whole request ("No endpoints found that support
 * image input"). Gemini / Anthropic chat models are multimodal. For an
 * OpenAI-compatible id we whitelist the known-vision families and DEFAULT TO
 * TEXT-ONLY for anything unrecognised — skipping a render degrades gracefully;
 * a hard image-endpoint error does not.
 */
function modelSupportsVision(providerName, model) {
    if (providerName === 'gemini' || providerName === 'anthropic') return true;
    const m = String(model || '').toLowerCase();
    if (!m) return false;
    if (m.includes('gpt-oss')) return false;   // open-weight gpt-oss: text-only
    // minimax-m3 (0G router) is natively multimodal (text+image+video→text) and
    // accepts OpenAI image_url content blocks — give that builder real eyes.
    return /vision|4o|gpt-4\.1|gpt-5|[^a-z]o3|[^a-z]o4|llava|pixtral|-vl|internvl|gemini|claude|minimax-m3/.test(m);
}

/**
 * Is the active model a known-WEAK tool driver — capable of emitting tool calls
 * but unreliable at the multi-step clarify→plan→approve→build sequence (it tends
 * to narrate the protocol in prose and skip the actual plan_* / propose_brief
 * tools, then flounder at build time)? These are advised against, not refused,
 * so a free-tier user is never locked out — the hard correctness rail is the
 * tool-layer build gate, which is model-agnostic. Conservative on purpose: only
 * flag families we've actually watched fail this way (see the GPT-OSS-120B
 * blender transcript), so a capable model is never wrongly warned.
 */
export function isWeakDriver(providerName, model) {
    const m = String(model || '').toLowerCase();
    if (!m) return false;
    if (/gpt-oss|gemma/.test(m)) return true;
    // Small open instruct models (≤ ~13B) rarely sustain the pipeline.
    if (/(^|[^0-9])(1|2|3|7|8|9|11|13)b([^0-9]|$)/.test(m) && /llama|qwen|mistral|phi/.test(m)) return true;
    return false;
}

const WEAK_DRIVER_ADVISORY = "⚠️ Heads-up: the current AI model is a lightweight one that often struggles to carry a multi-part build through the plan→approve→build workflow (it may stall or produce rough geometry). For a complex assembly like this, consider switching to a stronger model in AI settings, or set an escalation model so the hard steps run on it. I'll keep going regardless.";

// Tools that observe but don't mutate the document — used to distinguish a
// turn that actually built something from one that only inspected state.
const READ_ONLY_TOOLS = new Set([
    'get_document_summary', 'list_components', 'measure', 'search_library', 'run_invariants',
]);

/**
 * Build a concise fallback completion line from a turn's tool results, for the
 * case where the model produced no closing prose. Prefers naming the things
 * that were created/changed; falls back to a read acknowledgement.
 *
 * @param {Array<{name:string, result:any}>} toolResults
 * @returns {string} a one-line summary (empty string if nothing to say)
 */
export function summarizeTurn(toolResults) {
    const calls = Array.isArray(toolResults) ? toolResults : [];
    if (calls.length === 0) return 'Done.';

    const ok = (r) => !(r && r.ok === false);
    const mutations = calls.filter((c) => !READ_ONLY_TOOLS.has(c.name));
    const failures = calls.filter((c) => !ok(c.result));

    if (failures.length) {
        const f = failures[0];
        const msg = (f.result && (f.result.error || f.result.summary)) || 'failed';
        const more = failures.length > 1 ? ` (+${failures.length - 1} more)` : '';
        return `${f.name} failed: ${msg}${more}.`;
    }

    if (mutations.length) {
        // Describe what was built/changed, e.g. "Done — addBox, addHole (2 ops)."
        const parts = mutations.map((c) => {
            const r = c.result || {};
            const label = r.summary || r.name || r.featureId || r.componentId || c.name;
            return String(label);
        });
        // Dedupe while preserving order, cap the list so the line stays short.
        const seen = new Set();
        const uniq = [];
        for (const p of parts) { if (!seen.has(p)) { seen.add(p); uniq.push(p); } }
        const shown = uniq.slice(0, 3).join(', ');
        const extra = uniq.length > 3 ? `, +${uniq.length - 3} more` : '';
        const count = mutations.length;
        return `Done — ${shown}${extra} (${count} op${count === 1 ? '' : 's'}).`;
    }

    // Only read-only tools ran and the model said nothing.
    const names = [...new Set(calls.map((c) => c.name))].slice(0, 3).join(', ');
    return `Reviewed the model (${names}). No changes were needed.`;
}

/**
 * Run one agent turn.
 *
 * @param {{
 *   userMessage: string,
 *   history?: Array<object>,   // normalized neutral history (see providers/index.js)
 *   onEvent?: (ev:object)=>void,
 *   signal?: AbortSignal,
 *   endpoint?: string,
 * }} args
 * @returns {Promise<{ history: Array }>}
 */
export async function runAgentTurn({ userMessage, images, history = [], onEvent = () => {}, signal, endpoint, autoMode = false } = {}) {
    const emit = (ev) => { try { onEvent(ev); } catch { /* UI handler must not break the loop */ } };
    const { providerName, model, maxTokens, apiKey, baseUrl, escalationModel } = resolveModelConfig();
    const provider = getProvider(providerName);
    // Does the active model accept image input? Gates the capture→look loop so
    // a render is never sent to a text-only model (which errors the request).
    const baseVision = modelSupportsVision(providerName, model);
    const escVision = escalationModel ? modelSupportsVision(providerName, escalationModel) : false;
    // Known-weak tool driver? Used to surface a one-time advisory the first time
    // the build gate bites this turn (the gate firing is the signal the request
    // is non-trivial — exactly where a weak model tends to fall apart).
    const weakDriver = isWeakDriver(providerName, model);
    // Vision critic: a multimodal reviewer (Gemma via AI Studio) that LOOKS at
    // capture_views renders on behalf of a blind builder and feeds back a text
    // critique. Only meaningful when the builder can't already see; resolved once.
    const criticOn = (() => { try { return visionCriticActive(); } catch { return false; } })();

    // Copy so we don't mutate the caller's history.
    const messages = history.slice();
    const hasImages = Array.isArray(images) && images.length > 0;
    if ((userMessage != null && String(userMessage).length > 0) || hasImages) {
        const entry = { role: 'user', text: userMessage != null ? String(userMessage) : '' };
        if (hasImages) entry.images = images.filter((im) => im && im.dataBase64);
        messages.push(entry);
        try { getAIContext().bumpTurn(); } catch { /* context optional */ }
    }

    // Per-turn tool triage: advertise only the relevant subset (all non-generator
    // tools + generators the conversation actually names). Derived from the full
    // user-message text so a part named earlier stays available across the turn.
    const convText = messages.filter((m) => m && m.role === 'user').map((m) => m.text || '').join(' ');
    const tools = provider.toolsForProvider(selectAgentTools(AGENT_TOOLS, convText));

    // Track turn-level activity so we can synthesize a completion message when
    // the model ends a turn silently (tool chips but no final prose — observed
    // live: a turn that ran only get_document_summary and said nothing). Without
    // this the chat shows a dead turn with no assistant bubble.
    let sawAssistantText = false;       // any non-blank text emitted this turn
    const turnToolResults = [];         // [{ name, result }] for the summary
    const repairAttempts = new Map();   // error signature → times auto-fed back
    const failingCalls = new Map();     // tool+input signature → consecutive fails
    let visionInjections = 0;           // bound the capture→look loop per turn
    let autoContinues = 0;              // auto-mode "keep going" nudges used this turn
    let nudgedLastStop = false;         // we nudged on a stop and no work has happened since
    let builtGeometryThisTurn = false;  // any real geometry/assembly mutation this turn
    let capturedAfterBuild = false;     // capture_views ran since the last mutation (visual gate)
    let visualGateNudges = 0;           // bound the "look before you finish" gate per turn
    let escalated = false;              // a hard step escalated us to the stronger model this turn
    let weakDriverWarned = false;       // emitted the weak-model advisory once this turn

    // Send a set of renders to the vision critic (Gemma) and inject its TEXT
    // verdict as the next builder turn. Returns true if a critique was injected.
    // Used both when the model calls capture_views itself AND when the loop
    // captures on its behalf (a blind builder can't be trusted to look).
    async function critiqueRenders(frames) {
        const views = [...new Set(frames.map((c) => c.view).filter(Boolean))];
        emit({ type: 'tool_call', name: 'vision_critique', input: { views, images: frames.length } });
        let critique = null;
        try { critique = await runVisionCritique({ images: frames, goal: userMessage, signal, endpoint }); }
        catch (e) { critique = { ok: false, error: (e && e.message) || String(e) }; }
        emit({ type: 'tool_result', name: 'vision_critique',
            result: (critique && critique.ok)
                ? { ok: true, model: critique.model, critique: critique.critique }
                : { ok: false, error: (critique && critique.error) || 'vision critic unavailable' } });
        if (critique && critique.ok && critique.critique) {
            const lead = `[vision reviewer · ${critique.model}] I looked at the render${frames.length === 1 ? '' : 's'}${views.length ? ` (${views.join(', ')})` : ''} of what you built:\n\n${critique.critique}\n\n`;
            const tail = critique.looksGood
                ? 'If you agree it matches the request, verify the key dimensions with measure and then finish with your summary.'
                : 'These are concrete visual problems you cannot see yourself — treat them as authoritative. Fix them now (reshape bare primitives into real parts, add the missing features, correct any clipping / proportions / orientation), confirm fit with measure, then I will look again.';
            messages.push({ role: 'user', text: lead + tail });
            return true;
        }
        return false;
    }

    try {
        for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
            if (signal && signal.aborted) {
                emit({ type: 'error', error: 'cancelled' });
                return { history: messages };
            }

            // Difficulty escalation: once a hard step (self-repair / repeated
            // failure) has tripped, drive the rest of the turn with the stronger
            // model if one is configured. The base model still handles the easy
            // majority of steps; the strong model is spent only where it pays.
            const activeModel = (escalated && escalationModel) ? escalationModel : model;
            const activeVision = (escalated && escalationModel) ? escVision : baseVision;
            // The critic only does work when the ACTIVE model is blind (a
            // vision-capable model looks for itself; escalating to one disables it).
            const criticForBlind = criticOn && !activeVision;

            // A text-only model must NOT receive image parts (user-attached refs
            // or captured renders) — the provider rejects the whole request
            // ("No endpoints found that support image input"). Send it a
            // stripped history; the full `messages` keeps images for the critic
            // and any vision-capable escalation.
            const bodyHistory = activeVision ? messages : stripImagesFromHistory(messages);
            const { body } = provider.buildBody({
                system: buildSystem(activeVision, criticForBlind),
                history: bodyHistory,
                tools,
                model: activeModel,
                maxTokens,
                stream: true,
            });

            // Stream the assistant turn; forward text deltas live and collect
            // the final parsed result through the provider's stream handler.
            let result = { text: '', toolCalls: [], stop: true };
            const handler = provider.makeStreamHandler({
                onText: (text) => { if (text && String(text).trim()) sawAssistantText = true; emit({ type: 'text', text }); },
                onToolCalls: () => {},
                onStop: (r) => { result = r; },
                onUsage: (usage) => emit({ type: 'usage', usage }),
            });
            await streamChat(body, (payload) => handler(payload), { endpoint, signal, apiKey, baseUrl });
            if (typeof handler.finalize === 'function') handler.finalize();

            // Record the assistant turn on the normalized history.
            provider.appendAssistantTurn(messages, { text: result.text, toolCalls: result.toolCalls });

            if (result.stop || !result.toolCalls || result.toolCalls.length === 0) {
                // Visual-verify gate (independent of auto mode): don't accept
                // "done" when geometry was built this turn but never looked at.
                if (builtGeometryThisTurn && !capturedAfterBuild && !(signal && signal.aborted)) {
                    // Blind builder + critic: DON'T trust a weak model to call
                    // capture_views. Capture the renders ourselves and run the
                    // critic, then feed its verdict back. Bounded by visionInjections.
                    if (criticForBlind && visionInjections < 4) {
                        emit({ type: 'tool_call', name: 'capture_views', input: {} });
                        const cap = await dispatchTool('capture_views', {});
                        const imgs = (cap && Array.isArray(cap._images)) ? cap._images : [];
                        emit({ type: 'tool_result', name: 'capture_views',
                            result: cap && cap.ok ? { ok: true, views: cap.views, note: cap.note } : cap });
                        capturedAfterBuild = true;   // we've looked; don't re-trigger forever
                        if (imgs.length) {
                            visionInjections++;
                            if (await critiqueRenders(imgs)) continue;
                        }
                        // No viewport / critic unavailable → fall through, accept "done".
                    } else if (activeVision && visualGateNudges < MAX_VISUAL_NUDGES) {
                        // Vision-capable model: nudge IT to look (it can see).
                        visualGateNudges++;
                        messages.push({ role: 'user', text: VISUAL_GATE_NUDGE });
                        continue;
                    }
                }
                // Seed the design-intent map from the goal for a build that never
                // used the plan_* tools (weak builders rarely do) — so the Plan
                // map reflects what was built even without the model driving it.
                // Empty-graph-only (never clobbers an AI/user plan); best-effort.
                if (builtGeometryThisTurn) {
                    try {
                        const pg = getPlanGraph();
                        if (pg && typeof pg.allNodes === 'function' && pg.allNodes().length === 0) {
                            seedPlanGraph(pg, String(userMessage || '').trim() || 'Design');
                            try { syncPlanGraphToDoc(); } catch { /* doc sync optional */ }
                        }
                    } catch { /* plan seed is best-effort, never breaks the turn */ }
                }
                // Auto / focus mode: don't accept the first "I'm done". Nudge the
                // model to keep going until the goal is genuinely complete. One
                // nudge per stop — if it stops AGAIN right after (nudgedLastStop
                // still set, i.e. it did no work in response), we accept it's
                // finished. Reset whenever it makes progress (issues tool calls).
                if (autoMode && !nudgedLastStop && autoContinues < MAX_AUTO_CONTINUES && !(signal && signal.aborted)) {
                    nudgedLastStop = true;
                    autoContinues++;
                    messages.push({ role: 'user', text: AUTO_NUDGE });
                    continue;
                }
                // Some models end a turn with tool chips but no closing prose
                // (e.g. a turn that only read state). Never leave the turn mute:
                // synthesize a one-line completion from what actually happened.
                if (!sawAssistantText && (result.text == null || !String(result.text).trim())) {
                    const fallback = summarizeTurn(turnToolResults);
                    if (fallback) emit({ type: 'text', text: fallback });
                }
                emit({ type: 'done' });
                return { history: messages };
            }

            // The model issued tool calls → it's doing work, so a later "done"
            // deserves a fresh auto-mode nudge.
            nudgedLastStop = false;

            // Execute each tool call and collect normalized results.
            const toolResults = [];
            const capturedImages = [];        // vision frames to feed the model
            let mutatedGeometry = false;     // a geometry op succeeded this iteration
            let repeatedFailureNote = null;   // the model keeps repeating a failing call
            for (const tc of result.toolCalls) {
                emit({ type: 'tool_call', name: tc.name, input: tc.input });
                let r = await dispatchTool(tc.name, tc.input || {});

                // A vision tool (capture_views) returns image bytes under
                // `_images`. Pull them out for the model to SEE on the next step
                // and strip them from the textual result so the base64 never
                // bloats the tool-result channel.
                if (r && Array.isArray(r._images) && r._images.length) {
                    for (const im of r._images) {
                        if (im && im.dataBase64) capturedImages.push({ mediaType: im.mediaType || 'image/jpeg', dataBase64: im.dataBase64, view: im.view });
                    }
                    const slim = { ...r };
                    delete slim._images;
                    r = slim;
                }

                emit({ type: 'tool_result', name: tc.name, result: r });
                toolResults.push({ id: tc.id, name: tc.name, result: r });
                turnToolResults.push({ name: tc.name, result: r });

                // Build gate fired (clarify→plan→approve not satisfied). This is
                // the signal that the request is a real multi-part build: surface
                // the weak-model advisory once, and treat it as a hard step so a
                // configured escalation model drives the planning/recovery.
                if (r && r.gated) {
                    if (weakDriver && !weakDriverWarned) {
                        weakDriverWarned = true;
                        emit({ type: 'text', text: WEAK_DRIVER_ADVISORY });
                    }
                    if (escalationModel) escalated = true;
                }

                const failed = r && r.ok === false;
                // Visual-gate bookkeeping: a successful capture satisfies the
                // gate; any successful mutation re-arms it (new geometry needs a
                // fresh look).
                if (!failed && tc.name === 'capture_views') capturedAfterBuild = true;
                if (!failed && !NON_MUTATING_TOOLS.has(tc.name)) {
                    mutatedGeometry = true;
                    builtGeometryThisTurn = true;
                    capturedAfterBuild = false;
                }
                if (failed) {
                    // Detect the model hammering the SAME failing call. After a
                    // few identical failures, nudge it to change approach.
                    let sig = tc.name;
                    try { sig += ':' + JSON.stringify(tc.input || {}); } catch { /* unserialisable */ }
                    const c = (failingCalls.get(sig) || 0) + 1;
                    failingCalls.set(sig, c);
                    if (c >= 3 && !repeatedFailureNote) {
                        repeatedFailureNote = `[automatic check] You have called "${tc.name}" with the same arguments and gotten the same error ${c} times. Stop repeating it — try a different approach, fix the inputs, or tell me plainly what is blocking you.`;
                    }
                }
            }

            // Feed the results back as the next user turn.
            provider.appendToolResults(messages, toolResults);

            // ── Vision injection ─────────────────────────────────────────────
            // If a tool produced renders of the model, attach them as a real
            // image message so the model can actually look at what it built.
            // ONLY for a vision-capable model — sending images to a text-only
            // model (e.g. gpt-oss) makes the provider reject the whole request
            // ("No endpoints found that support image input"). For a text-only
            // model the renders are simply dropped (the slim text tool-result is
            // still appended), and the turn proceeds with numeric verification.
            if (capturedImages.length && activeVision && visionInjections < 4) {
                visionInjections++;
                const views = [...new Set(capturedImages.map((c) => c.view).filter(Boolean))];
                messages.push({
                    role: 'user',
                    text: `Here ${capturedImages.length === 1 ? 'is a render' : `are ${capturedImages.length} renders`} of the current model${views.length ? ` (${views.join(', ')})` : ''}. Look at them to verify what was actually built — orientation, proportions, anything clipping or wrong — then continue.`,
                    images: capturedImages.map((c) => ({ mediaType: c.mediaType, dataBase64: c.dataBase64 })),
                });
                continue; // next iteration: the model sees the images
            }
            // ── Vision CRITIC (blind builder) ────────────────────────────────
            // The active model can't see, but a critic is configured: hand the
            // renders to the multimodal reviewer (Gemma) and inject its text
            // critique as the next user turn, so the blind builder can act on
            // what it cannot see. Bounded by the same visionInjections budget.
            else if (capturedImages.length && criticForBlind && visionInjections < 4) {
                visionInjections++;
                if (await critiqueRenders(capturedImages)) continue; // builder acts on the critique
                // Critic unavailable/failed → don't block the build; fall through
                // to the numeric self-repair net below.
            }

            // ── Self-repair safety net ───────────────────────────────────────
            // If real geometry changed, verify it still compiles on the kernel.
            // On failure, feed the kernel error straight back so the model fixes
            // its OWN mistake instead of leaving a broken model — bounded per
            // error so it can't thrash forever.
            if (mutatedGeometry && !(signal && signal.aborted)) {
                let status;
                try { status = await compileCurrent(); } catch { status = { ok: true }; }
                if (status && status.ok === false && status.error) {
                    emit({ type: 'tool_result', name: 'compile_check', result: { ok: false, error: status.error } });
                    const sig = errorSignature(status.error);
                    const n = (repairAttempts.get(sig) || 0) + 1;
                    repairAttempts.set(sig, n);
                    // A failing compile is a hard step — escalate to the stronger
                    // model (if configured) for the repair and the rest of the turn.
                    if (escalationModel) escalated = true;
                    // "No bodies" means the document is EMPTY (e.g. an addComponent
                    // shell with no geometry, or the only body was deleted). The
                    // generic "remove the offending feature" advice is exactly
                    // wrong here — following it deletes the last body and loops.
                    // Steer toward ADDING a real body instead (this is the
                    // delete-thrash seen in the blender transcript).
                    const emptyDoc = /produced no bodies|no bodies|empty document/i.test(String(status.error || ''));
                    if (emptyDoc) {
                        messages.push({ role: 'user', text:
                            `[automatic check] The document has NO solid bodies yet, so it cannot compile:\n${truncate(status.error, 300)}\n` +
                            `Do NOT delete anything — there is nothing to remove. ADD the first real body of the part now (a primitive like addBox/addCylinder, or the matching generator), placed inside the component you created. Then verify with compile_status.` });
                    } else if (n <= MAX_REPAIRS_PER_ERROR) {
                        messages.push({ role: 'user', text:
                            `[automatic check] The kernel could NOT compile the model after your last operation:\n${truncate(status.error, 600)}\n` +
                            `This was almost certainly caused by what you just did. Repair it now: adjust the offending feature's parameters (setFeatureParams) or remove it (deleteFeature / suppressFeature) and rebuild a working version. Do not ask me — fix it, then verify with compile_status or measure. If it truly cannot be done, say so plainly.` });
                    } else {
                        messages.push({ role: 'user', text:
                            `[automatic check] The model STILL fails to compile after ${n - 1} automatic repair attempts on the same error:\n${truncate(status.error, 400)}\n` +
                            `Stop trying to auto-fix it. In one short message, tell me what is broken and what you would change to resolve it.` });
                    }
                    continue; // loop so the model sees the failure and repairs
                }
            }

            if (repeatedFailureNote) {
                // The model is stuck repeating a failing call — a hard step.
                if (escalationModel) escalated = true;
                messages.push({ role: 'user', text: repeatedFailureNote });
            }
        }

        emit({ type: 'error', error: `reached the ${MAX_ITERATIONS}-step tool limit without finishing` });
        return { history: messages };
    } catch (e) {
        if (e && (e.name === 'AbortError' || (signal && signal.aborted))) {
            emit({ type: 'error', error: 'cancelled' });
        } else {
            emit({ type: 'error', error: (e && e.message) || String(e) });
        }
        return { history: messages };
    }
}
