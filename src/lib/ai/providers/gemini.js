/**
 * Gemini provider — Google Generative Language API (v1beta) implementation of
 * the provider interface (see ./index.js for the contract).
 *
 * Verified wire format:
 *   - endpoints: …/v1beta/models/{model}:generateContent and
 *     …/v1beta/models/{model}:streamGenerateContent?alt=sse
 *   - body: { contents:[{role:'user'|'model', parts:[ {text} | {functionCall} |
 *     {functionResponse} ]}], systemInstruction:{parts:[{text}]},
 *     tools:[{functionDeclarations:[{name,description,parameters}]}],
 *     generationConfig:{maxOutputTokens, temperature} }
 *   - tool schema: `parameters` is the same JSON-Schema subset as Anthropic's
 *     `input_schema`; we rename and strip to type/description/properties/
 *     required/items/enum so Gemini does not reject extra keywords.
 *   - model → functionCall: candidates[0].content.parts[] may carry
 *     {functionCall:{name, id?, args}}. No special stop reason for tools —
 *     detect by presence of functionCall parts. finishReason is "STOP" etc.
 *   - tool results: append {role:'user', parts:[{functionResponse:{name, id?,
 *     response:{...}}}]}. `response` must be an object (scalars wrapped).
 */

const STREAM_SUFFIX = ':streamGenerateContent?alt=sse';
const NONSTREAM_SUFFIX = ':generateContent';

/** JSON-Schema keys Gemini's `parameters` accepts. Strip the rest. */
const SCHEMA_KEYS = ['type', 'description', 'properties', 'required', 'items', 'enum'];

/** Recursively project a JSON-Schema node onto the Gemini-accepted subset. */
function sanitizeSchema(schema) {
    if (!schema || typeof schema !== 'object') return schema;
    const out = {};
    for (const k of SCHEMA_KEYS) {
        if (schema[k] === undefined) continue;
        if (k === 'properties' && schema.properties && typeof schema.properties === 'object') {
            out.properties = {};
            for (const [name, sub] of Object.entries(schema.properties)) {
                out.properties[name] = sanitizeSchema(sub);
            }
        } else if (k === 'items') {
            out.items = sanitizeSchema(schema.items);
        } else {
            out[k] = schema[k];
        }
    }
    return out;
}

/** Translate canonical tools → a single Gemini tool with functionDeclarations. */
function toolsForProvider(agentTools) {
    const functionDeclarations = (agentTools || []).map((t) => {
        const decl = { name: t.name, description: t.description };
        // Gemini rejects an empty-object parameters with no properties on some
        // models; only attach parameters when the tool actually takes input.
        const params = sanitizeSchema(t.input_schema);
        if (params && params.properties && Object.keys(params.properties).length > 0) {
            decl.parameters = params;
        }
        return decl;
    });
    return [{ functionDeclarations }];
}

/** Serialise one neutral history entry into a Gemini `content` object. */
function toContent(entry) {
    if (!entry) return null;
    if (entry.role === 'assistant') {
        const parts = [];
        if (entry.text) parts.push({ text: entry.text });
        for (const tc of entry.toolCalls || []) {
            const fc = { name: tc.name, args: tc.input || {} };
            if (tc.id) fc.id = tc.id;
            parts.push({ functionCall: fc });
        }
        if (parts.length === 0) parts.push({ text: '' });
        return { role: 'model', parts };
    }
    // role === 'user'
    if (entry.toolResults && entry.toolResults.length) {
        const parts = entry.toolResults.map((r) => {
            const response = (r.result && typeof r.result === 'object' && !Array.isArray(r.result))
                ? r.result
                : { result: r.result };
            const fr = { name: r.name, response };
            if (r.id) fr.id = r.id;
            return { functionResponse: fr };
        });
        return { role: 'user', parts };
    }
    // Vision: a user turn carrying images → Gemini inlineData parts.
    if (entry.images && entry.images.length) {
        const parts = [];
        if (entry.text) parts.push({ text: String(entry.text) });
        for (const img of entry.images) {
            if (!img || !img.dataBase64) continue;
            parts.push({ inlineData: { mimeType: img.mediaType || 'image/png', data: img.dataBase64 } });
        }
        if (parts.length) return { role: 'user', parts };
    }
    return { role: 'user', parts: [{ text: entry.text != null ? String(entry.text) : '' }] };
}

function buildBody({ system, history = [], tools, model, maxTokens, stream }) {
    const contents = history.map(toContent).filter(Boolean);
    const body = {
        provider: 'gemini',
        model,
        stream: !!stream,
        contents,
        tools,
        generationConfig: { maxOutputTokens: maxTokens, temperature: 0 },
    };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    const suffix = stream ? STREAM_SUFFIX : NONSTREAM_SUFFIX;
    return { path: `/v1beta/models/${model}${suffix}`, body };
}

function appendAssistantTurn(history, { text, toolCalls }) {
    history.push({ role: 'assistant', text: text || '', toolCalls: toolCalls || [] });
}

function appendToolResults(history, results) {
    history.push({ role: 'user', toolResults: results || [] });
}

/** Pull text + functionCalls out of a GenerateContentResponse candidate. */
function _extractParts(parts) {
    let text = '';
    const toolCalls = [];
    for (const p of parts || []) {
        if (typeof p.text === 'string') text += p.text;
        else if (p.functionCall) {
            toolCalls.push({
                id: p.functionCall.id || null,
                name: p.functionCall.name,
                input: p.functionCall.args || {},
            });
        }
    }
    return { text, toolCalls };
}

/**
 * Parse a non-streaming GenerateContentResponse.
 * @returns {{ text:string, toolCalls:Array<{id,name,input}>, stop:boolean, usage?:object }}
 */
function parseResponse(json) {
    const cand = json && json.candidates && json.candidates[0];
    const parts = (cand && cand.content && cand.content.parts) || [];
    const { text, toolCalls } = _extractParts(parts);
    // No special tool stop reason — a turn continues only if tool calls exist.
    const stop = toolCalls.length === 0;
    return { text, toolCalls, stop, usage: json && json.usageMetadata };
}

/**
 * Build an SSE handler. Each Gemini `data:` payload is a full
 * GenerateContentResponse chunk; we accumulate text deltas, collect any
 * functionCall parts, and track the latest usageMetadata.
 */
function makeStreamHandler({ onText = () => {}, onToolCalls = () => {}, onStop = () => {}, onUsage = () => {} } = {}) {
    let text = '';
    const toolCalls = [];
    let usage = null;

    function handle(payload) {
        if (!payload || payload === '[DONE]') return;
        let chunk;
        try { chunk = JSON.parse(payload); } catch { return; }
        if (chunk.usageMetadata) usage = chunk.usageMetadata;
        const cand = chunk.candidates && chunk.candidates[0];
        if (!cand) return;
        const parts = (cand.content && cand.content.parts) || [];
        for (const p of parts) {
            if (typeof p.text === 'string' && p.text) {
                text += p.text;
                onText(p.text);
            } else if (p.functionCall) {
                toolCalls.push({
                    id: p.functionCall.id || null,
                    name: p.functionCall.name,
                    input: p.functionCall.args || {},
                });
            }
        }
        // finishReason marks the end of the candidate; we still finalize on
        // stream end (handle.finalize) so partial last-chunk text is included.
    }

    handle.finalize = function finalize() {
        if (usage) onUsage(usage);
        if (toolCalls.length) onToolCalls(toolCalls);
        const stop = toolCalls.length === 0;
        onStop({ text, toolCalls, stop });
        return { text, toolCalls, stop };
    };

    return handle;
}

export const geminiProvider = Object.freeze({
    name: 'gemini',
    streamSuffix: STREAM_SUFFIX,
    nonStreamSuffix: NONSTREAM_SUFFIX,
    toolsForProvider,
    buildBody,
    appendAssistantTurn,
    appendToolResults,
    parseResponse,
    makeStreamHandler,
    sanitizeSchema,
});

export default geminiProvider;
