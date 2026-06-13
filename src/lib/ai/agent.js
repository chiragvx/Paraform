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

import { AGENT_TOOLS, dispatchTool } from './tools.js';
import { SYSTEM_PROMPT } from './system_prompt.js';
import { streamChat } from './provider.js';
import { getProvider, DEFAULT_PROVIDER } from './providers/index.js';
import { readSettings } from '../../../app/settings/index.js';

export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';
export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-4-8';
// OpenAI-compatible GPT-OSS — the core path. The `openai/` prefix matches the
// model id most aggregators use (Groq / OpenRouter / Together / Fireworks).
// Point a self-hosted/OpenAI endpoint at a bare `gpt-oss-120b` via settings.
export const DEFAULT_OPENAI_MODEL = 'openai/gpt-oss-120b';
export const DEFAULT_MAX_TOKENS = 4096;
export const MAX_ITERATIONS = 12;

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
    // 'mock' / unknown provider falls back to the default real provider here;
    // the chat surface always wants a real backend.
    if (!['gemini', 'anthropic', 'openai'].includes(providerName)) providerName = DEFAULT_PROVIDER;
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
export async function runAgentTurn({ userMessage, history = [], onEvent = () => {}, signal, endpoint } = {}) {
    const emit = (ev) => { try { onEvent(ev); } catch { /* UI handler must not break the loop */ } };
    const { providerName, model, maxTokens, apiKey, baseUrl } = resolveModelConfig();
    const provider = getProvider(providerName);
    const tools = provider.toolsForProvider(AGENT_TOOLS);

    // Copy so we don't mutate the caller's history.
    const messages = history.slice();
    if (userMessage != null && String(userMessage).length > 0) {
        messages.push({ role: 'user', text: String(userMessage) });
    }

    // Track turn-level activity so we can synthesize a completion message when
    // the model ends a turn silently (tool chips but no final prose — observed
    // live: a turn that ran only get_document_summary and said nothing). Without
    // this the chat shows a dead turn with no assistant bubble.
    let sawAssistantText = false;       // any non-blank text emitted this turn
    const turnToolResults = [];         // [{ name, result }] for the summary

    try {
        for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
            if (signal && signal.aborted) {
                emit({ type: 'error', error: 'cancelled' });
                return { history: messages };
            }

            const { body } = provider.buildBody({
                system: SYSTEM_PROMPT,
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
            for (const tc of result.toolCalls) {
                emit({ type: 'tool_call', name: tc.name, input: tc.input });
                const r = await dispatchTool(tc.name, tc.input || {});
                emit({ type: 'tool_result', name: tc.name, result: r });
                toolResults.push({ id: tc.id, name: tc.name, result: r });
                turnToolResults.push({ name: tc.name, result: r });
            }

            // Feed the results back as the next user turn and loop.
            provider.appendToolResults(messages, toolResults);
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
