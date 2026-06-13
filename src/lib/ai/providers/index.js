/**
 * Provider abstraction — one switchable LLM backend behind a common interface.
 *
 * Phase 2 makes the AI stack provider-agnostic so the agent loop (agent.js) and
 * the repair client (repair/llm_client.js) drive any backend through the same
 * shape. Gemini is the DEFAULT working path; Anthropic stays selectable in
 * settings.
 *
 * Normalized history representation (what agent.js holds):
 *   Array<{
 *     role: 'user' | 'assistant',
 *     text?: string,                                  // assistant/user prose
 *     toolCalls?: Array<{ id, name, input }>,         // assistant tool requests
 *     toolResults?: Array<{ id, name, result }>,      // user-side tool results
 *   }>
 * Each provider serialises this neutral history to its own wire shape inside
 * `buildBody`, so the loop never sees Anthropic- or Gemini-specific structures.
 *
 * ── Provider interface ────────────────────────────────────────────────────────
 * Every provider module exports a frozen object implementing:
 *
 *   name: string
 *     — short id ('anthropic' | 'gemini'); echoed to the proxy for routing.
 *
 *   toolsForProvider(AGENT_TOOLS): object[]
 *     — translate the canonical tool list (from ai/tools.js, shaped
 *       { name, description, input_schema }) into the provider's tool defs.
 *
 *   buildBody({ system, history, model, maxTokens, stream }): { path, body }
 *     — produce the request body the proxy forwards upstream, plus a `path`
 *       hint (the provider-specific upstream sub-path). `history` is the
 *       normalized array above. The proxy actually routes by
 *       provider+model+stream, so `path` is advisory/documentary.
 *
 *   appendAssistantTurn(history, { text, toolCalls }): void
 *     — push the assistant's reply (prose + any tool requests) onto history.
 *
 *   appendToolResults(history, results): void
 *     — push the tool results (Array<{ id, name, result }>) onto history as the
 *       next user turn, in the provider's wire shape.
 *
 *   parseResponse(json): { text, toolCalls: Array<{id,name,input}>, stop: boolean }
 *     — parse a non-streaming upstream response. `stop` is true when the model
 *       has finished (no further tool round-trip expected).
 *
 *   makeStreamHandler({ onText, onToolCalls, onStop }): (dataPayload: string) => void
 *     — return a function fed each raw SSE `data:` payload string; it accumulates
 *       partial text / tool-call JSON and invokes the callbacks with normalized
 *       events. onToolCalls receives Array<{id,name,input}>; onStop receives
 *       { text, toolCalls }.
 *
 * @typedef {Object} AiProvider
 */

import { anthropicProvider } from './anthropic.js';
import { geminiProvider } from './gemini.js';
import { openaiProvider } from './openai.js';

/**
 * Default provider id — OpenAI-compatible GPT-OSS is the core path (open-weight,
 * widely available, native tool calling). Gemini + Anthropic stay selectable.
 */
export const DEFAULT_PROVIDER = 'openai';

const _byName = new Map([
    [anthropicProvider.name, anthropicProvider],
    [geminiProvider.name, geminiProvider],
    [openaiProvider.name, openaiProvider],
]);

/**
 * Resolve a provider implementation by name. Unknown / missing names fall back
 * to the default (gemini) so a stale settings value never breaks the loop.
 *
 * @param {string} [name]
 * @returns {AiProvider}
 */
export function getProvider(name) {
    const key = (typeof name === 'string' && name.trim()) ? name.trim().toLowerCase() : DEFAULT_PROVIDER;
    return _byName.get(key) || _byName.get(DEFAULT_PROVIDER);
}

export { anthropicProvider, geminiProvider, openaiProvider };
