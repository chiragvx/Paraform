/**
 * Cerebras provider — Cerebras Cloud serves an **OpenAI-compatible**
 * `/chat/completions` API (native tool calling included), so this provider is a
 * thin re-tag of the OpenAI provider (./openai.js): identical tool shape,
 * history serialisation, and SSE handling. The only differences are the `name`
 * (echoed to the proxy for routing) and the `provider` field stamped on the
 * body, which tells b123d_server/ai_proxy.py to forward to the Cerebras base
 * URL (https://api.cerebras.ai/v1) with the user's Cerebras key.
 *
 * Cerebras' draw is speed (wafer-scale inference) on a generous free tier
 * (~1M tokens/day). Its public models are text-only, so the agent loop's
 * vision gate (agent.js modelSupportsVision) correctly degrades to numeric
 * verification — same as gpt-oss on any other OpenAI-compatible host.
 */

import { openaiProvider } from './openai.js';

/** Reuse the OpenAI body builder, then re-tag the provider for proxy routing. */
function buildBody(args) {
    const { path, body } = openaiProvider.buildBody(args);
    body.provider = 'cerebras';
    return { path, body };
}

export const cerebrasProvider = Object.freeze({
    ...openaiProvider,
    name: 'cerebras',
    buildBody,
});

export default cerebrasProvider;
