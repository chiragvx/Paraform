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

import { AGENT_TOOLS, dispatchTool, documentSummary } from './tools.js';
import { SYSTEM_PROMPT } from './system_prompt.js';
import { streamChat } from './provider.js';
import { getProvider, DEFAULT_PROVIDER } from './providers/index.js';
import { readSettings } from '../../../app/settings/index.js';
import { getAIContext } from './context.js';
import { compileCurrent } from './tools_validation.js';

export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';
export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-4-8';
// OpenAI-compatible GPT-OSS — the core path. The `openai/` prefix matches the
// model id most aggregators use (Groq / OpenRouter / Together / Fireworks).
// Point a self-hosted/OpenAI endpoint at a bare `gpt-oss-120b` via settings.
export const DEFAULT_OPENAI_MODEL = 'openai/gpt-oss-120b';
export const DEFAULT_MAX_TOKENS = 4096;
// Raised from 12: the self-repair safety net, verify-then-fix loops, and the
// see→act→re-check vision loop (capture_views) all consume iterations, so a
// genuine multi-step build needs headroom. Still bounded against runaways.
export const MAX_ITERATIONS = 20;
// How many times the loop will auto-feed the SAME compile error back for repair
// before giving up and asking the user. Prevents thrashing on an unfixable build.
const MAX_REPAIRS_PER_ERROR = 2;

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
function buildSystem() {
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
    const sel = selectionSummary();
    return [SYSTEM_PROMPT, block, sel].filter(Boolean).join('\n\n');
}

/** Normalise a kernel error so repeated attempts on the SAME failure dedupe. */
function errorSignature(error) {
    return String(error || '').toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 160);
}

function truncate(s, n) {
    const str = String(s == null ? '' : s);
    return str.length > n ? str.slice(0, n) + '…' : str;
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
    'export_for_print', 'declareConnector', 'add_mate',
    'capture_views', 'web_search', 'web_fetch',
]);

/** Pull { providerName, model, maxTokens, apiKey, baseUrl } from settings. */
function resolveModelConfig() {
    let providerName = DEFAULT_PROVIDER;
    let geminiModel = DEFAULT_GEMINI_MODEL;
    let anthropicModel = DEFAULT_ANTHROPIC_MODEL;
    let openaiModel = DEFAULT_OPENAI_MODEL;
    let maxTokens = DEFAULT_MAX_TOKENS;
    let ai = {};
    try {
        const s = readSettings();
        ai = (s && s.ai) || {};
        if (typeof ai.provider === 'string' && ai.provider.trim()) providerName = ai.provider.trim();
        if (typeof ai.geminiModel === 'string' && ai.geminiModel.trim()) geminiModel = ai.geminiModel.trim();
        if (typeof ai.anthropicModel === 'string' && ai.anthropicModel.trim()) anthropicModel = ai.anthropicModel.trim();
        if (typeof ai.openaiModel === 'string' && ai.openaiModel.trim()) openaiModel = ai.openaiModel.trim();
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
    if (!['gemini', 'openai'].includes(providerName)) providerName = DEFAULT_PROVIDER;
    const model = providerName === 'anthropic' ? anthropicModel
        : providerName === 'openai' ? openaiModel
        : geminiModel;
    // Optional bring-your-own key for the selected provider, stored in the
    // browser and forwarded to the user's own proxy (see provider.js headers).
    const keyField = providerName === 'anthropic' ? 'anthropicApiKey'
        : providerName === 'openai' ? 'openaiApiKey'
        : 'geminiApiKey';
    const apiKey = (typeof ai[keyField] === 'string' && ai[keyField].trim()) ? ai[keyField].trim() : null;
    const baseUrl = (providerName === 'openai' && typeof ai.openaiBaseUrl === 'string' && ai.openaiBaseUrl.trim())
        ? ai.openaiBaseUrl.trim() : null;
    return { providerName, model, maxTokens, apiKey, baseUrl };
}

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
export async function runAgentTurn({ userMessage, images, history = [], onEvent = () => {}, signal, endpoint } = {}) {
    const emit = (ev) => { try { onEvent(ev); } catch { /* UI handler must not break the loop */ } };
    const { providerName, model, maxTokens, apiKey, baseUrl } = resolveModelConfig();
    const provider = getProvider(providerName);
    const tools = provider.toolsForProvider(AGENT_TOOLS);

    // Copy so we don't mutate the caller's history.
    const messages = history.slice();
    const hasImages = Array.isArray(images) && images.length > 0;
    if ((userMessage != null && String(userMessage).length > 0) || hasImages) {
        const entry = { role: 'user', text: userMessage != null ? String(userMessage) : '' };
        if (hasImages) entry.images = images.filter((im) => im && im.dataBase64);
        messages.push(entry);
        try { getAIContext().bumpTurn(); } catch { /* context optional */ }
    }

    // Track turn-level activity so we can synthesize a completion message when
    // the model ends a turn silently (tool chips but no final prose — observed
    // live: a turn that ran only get_document_summary and said nothing). Without
    // this the chat shows a dead turn with no assistant bubble.
    let sawAssistantText = false;       // any non-blank text emitted this turn
    const turnToolResults = [];         // [{ name, result }] for the summary
    const repairAttempts = new Map();   // error signature → times auto-fed back
    const failingCalls = new Map();     // tool+input signature → consecutive fails
    let visionInjections = 0;           // bound the capture→look loop per turn

    try {
        for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
            if (signal && signal.aborted) {
                emit({ type: 'error', error: 'cancelled' });
                return { history: messages };
            }

            const { body } = provider.buildBody({
                system: buildSystem(),
                history: messages,
                tools,
                model,
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

                const failed = r && r.ok === false;
                if (!failed && !NON_MUTATING_TOOLS.has(tc.name)) mutatedGeometry = true;
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
            if (capturedImages.length && visionInjections < 4) {
                visionInjections++;
                const views = [...new Set(capturedImages.map((c) => c.view).filter(Boolean))];
                messages.push({
                    role: 'user',
                    text: `Here ${capturedImages.length === 1 ? 'is a render' : `are ${capturedImages.length} renders`} of the current model${views.length ? ` (${views.join(', ')})` : ''}. Look at them to verify what was actually built — orientation, proportions, anything clipping or wrong — then continue.`,
                    images: capturedImages.map((c) => ({ mediaType: c.mediaType, dataBase64: c.dataBase64 })),
                });
                continue; // next iteration: the model sees the images
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
                    if (n <= MAX_REPAIRS_PER_ERROR) {
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
