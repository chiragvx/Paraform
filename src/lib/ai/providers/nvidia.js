/**
 * NVIDIA NIM provider — NVIDIA's hosted inference (build.nvidia.com /
 * integrate.api.nvidia.com) and self-hosted NIM containers both expose an
 * **OpenAI-compatible** `/chat/completions` API with native tool calling, so
 * this provider is a thin re-tag of the OpenAI provider (./openai.js): identical
 * tool shape, history serialisation, and SSE handling. Only the `name` (echoed
 * to the proxy for routing) and the `provider` field stamped on the body differ
 * — the latter tells b123d_server/ai_proxy.py to forward to the NVIDIA base URL
 * (https://integrate.api.nvidia.com/v1) with the user's `nvapi-…` key.
 *
 * The model id is whatever the user types in Settings (free-text), so they can
 * test any NIM catalog model (meta/llama-3.3-70b-instruct,
 * nvidia/llama-3.1-nemotron-70b-instruct, deepseek-ai/deepseek-r1, …). Vision is
 * gated by agent.js modelSupportsVision on the model name, so a text-only NIM
 * model degrades to numeric verification automatically.
 */

import { openaiProvider } from './openai.js';

/** Reuse the OpenAI body builder, then re-tag the provider for proxy routing. */
function buildBody(args) {
    const { path, body } = openaiProvider.buildBody(args);
    body.provider = 'nvidia';
    return { path, body };
}

export const nvidiaProvider = Object.freeze({
    ...openaiProvider,
    name: 'nvidia',
    buildBody,
});

export default nvidiaProvider;
