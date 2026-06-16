/**
 * 0G Compute Router provider — 0G's decentralized inference router
 * (https://router-api.0g.ai/v1) exposes an **OpenAI-compatible**
 * `/chat/completions` API with native tool calling on compatible models, so
 * this provider is a thin re-tag of the OpenAI provider (./openai.js):
 * identical tool shape, history serialisation, and SSE handling. Only the
 * `name` (echoed to the proxy for routing) and the `provider` field stamped on
 * the body differ — the latter tells b123d_server/ai_proxy.py to forward to the
 * 0G router base URL with the user's `sk-…` key (`Authorization: Bearer`).
 *
 * The model id is whatever the user types in Settings (free-text), so they can
 * test any model the router catalogs (e.g. glm-5, deepseek-v4-pro,
 * qwen3.7-max). Use an id from GET /v1/models or browse https://pc.0g.ai — an
 * unknown id comes back as "upstream provider request failed". NOTE: the router
 * also returns 400 if you send `tools` to a model that doesn't support them, so
 * pick a tool-calling model — the agent drives the build through tools. Vision is
 * gated by agent.js modelSupportsVision on the model name, so a text-only model
 * degrades to numeric verification automatically.
 */

import { openaiProvider } from './openai.js';

/** Reuse the OpenAI body builder, then re-tag the provider for proxy routing. */
function buildBody(args) {
    const { path, body } = openaiProvider.buildBody(args);
    body.provider = 'zerog';
    return { path, body };
}

export const zerogProvider = Object.freeze({
    ...openaiProvider,
    name: 'zerog',
    buildBody,
});

export default zerogProvider;
