/**
 * OpenAI-compatible provider — the Chat Completions implementation of the
 * provider interface (see ./index.js for the contract).
 *
 * This is the path for OpenAI's open-weight **GPT-OSS** models
 * (gpt-oss-120b / gpt-oss-20b) and any other model served behind an
 * OpenAI-compatible `/chat/completions` endpoint (Groq, OpenRouter, Together,
 * Fireworks, vLLM, Ollama, …). GPT-OSS supports native function/tool calling in
 * the standard OpenAI shape, so the agent loop drives it exactly like the
 * Gemini/Anthropic providers.
 *
 * The actual upstream base URL + API key live on the Flask proxy
 * (b123d_server/ai_proxy.py: OPENAI_BASE_URL / OPENAI_API_KEY) so the browser
 * never holds a key and you can point at whichever host serves GPT-OSS.
 *
 * Normalized history (neutral {role,text,toolCalls,toolResults}) serialises to
 * the OpenAI `messages` shape:
 *   - assistant turns → { role:'assistant', content:text|null,
 *       tool_calls:[{ id, type:'function', function:{ name, arguments } }] }
 *   - tool results    → one { role:'tool', tool_call_id, content } per result
 */

const UPSTREAM_PATH = '/chat/completions';

/** Canonical tools → OpenAI function-tool shape. */
function toolsForProvider(agentTools) {
    return (agentTools || []).map((t) => ({
        type: 'function',
        function: {
            name: t.name,
            description: t.description,
            // OpenAI accepts the full JSON-Schema; pass input_schema through.
            // Tools with no inputs still get a valid empty object schema.
            parameters: t.input_schema || { type: 'object', properties: {} },
        },
    }));
}

/** Serialise one neutral history entry into OpenAI message(s). Returns an array. */
function toWireMessages(entry) {
    if (!entry) return [];
    if (entry.role === 'assistant') {
        const msg = { role: 'assistant', content: entry.text ? entry.text : null };
        const calls = entry.toolCalls || [];
        if (calls.length) {
            msg.tool_calls = calls.map((tc, i) => ({
                id: tc.id || `call_${i}`,
                type: 'function',
                function: { name: tc.name, arguments: JSON.stringify(tc.input || {}) },
            }));
        }
        return [msg];
    }
    // role === 'user'
    if (entry.toolResults && entry.toolResults.length) {
        return entry.toolResults.map((r, i) => ({
            role: 'tool',
            tool_call_id: r.id || `call_${i}`,
            content: typeof r.result === 'string' ? r.result : JSON.stringify(r.result),
        }));
    }
    return [{ role: 'user', content: entry.text != null ? String(entry.text) : '' }];
}

function buildBody({ system, history = [], tools, model, maxTokens, stream }) {
    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    for (const entry of history) messages.push(...toWireMessages(entry));
    const body = {
        provider: 'openai',
        model,
        messages,
        tools,
        tool_choice: 'auto',
        temperature: 0,
        max_tokens: maxTokens,
        stream: !!stream,
    };
    // Ask for a usage block on the final streamed chunk where supported.
    if (stream) body.stream_options = { include_usage: true };
    return { path: UPSTREAM_PATH, body };
}

function appendAssistantTurn(history, { text, toolCalls }) {
    history.push({ role: 'assistant', text: text || '', toolCalls: toolCalls || [] });
}

function appendToolResults(history, results) {
    history.push({ role: 'user', toolResults: results || [] });
}

/** Parse a tool_calls array from a message into normalized tool calls. */
function _parseToolCalls(rawCalls) {
    const toolCalls = [];
    for (const tc of rawCalls || []) {
        if (!tc || tc.type !== undefined && tc.type !== 'function') continue;
        const fn = tc.function || {};
        let input = {};
        try { input = fn.arguments ? JSON.parse(fn.arguments) : {}; } catch { input = {}; }
        toolCalls.push({ id: tc.id || null, name: fn.name, input });
    }
    return toolCalls;
}

/**
 * Parse a non-streaming Chat Completion.
 * @returns {{ text:string, toolCalls:Array<{id,name,input}>, stop:boolean, usage?:object }}
 */
function parseResponse(json) {
    const choice = json && json.choices && json.choices[0];
    const msg = (choice && choice.message) || {};
    const text = typeof msg.content === 'string' ? msg.content : '';
    const toolCalls = _parseToolCalls(msg.tool_calls);
    return { text, toolCalls, stop: toolCalls.length === 0, usage: json && json.usage };
}

/**
 * Build an SSE handler for the OpenAI streaming protocol. Each `data:` payload
 * is a chat.completion.chunk with choices[].delta. Tool calls stream as
 * delta.tool_calls[] fragments keyed by `index`; the first fragment carries the
 * id + function.name, later fragments append function.arguments. The terminal
 * `data: [DONE]` is ignored (handled by streamChat); a final usage-only chunk
 * (stream_options.include_usage) carries totals.
 */
function makeStreamHandler({ onText = () => {}, onToolCalls = () => {}, onStop = () => {}, onUsage = () => {} } = {}) {
    let text = '';
    const toolAcc = {}; // index → { id, name, args }
    let usage = null;

    function handle(payload) {
        if (!payload || payload === '[DONE]') return;
        let chunk;
        try { chunk = JSON.parse(payload); } catch { return; }
        if (chunk.usage) usage = chunk.usage;
        const choice = chunk.choices && chunk.choices[0];
        if (!choice) return;
        const delta = choice.delta || {};
        if (typeof delta.content === 'string' && delta.content) {
            text += delta.content;
            onText(delta.content);
        }
        for (const tc of delta.tool_calls || []) {
            const idx = Number.isInteger(tc.index) ? tc.index : 0;
            const slot = toolAcc[idx] || (toolAcc[idx] = { id: null, name: '', args: '' });
            if (tc.id) slot.id = tc.id;
            const fn = tc.function || {};
            if (fn.name) slot.name = fn.name;
            if (typeof fn.arguments === 'string') slot.args += fn.arguments;
        }
    }

    function finalize() {
        const toolCalls = Object.keys(toolAcc)
            .map(Number)
            .sort((a, b) => a - b)
            .map((idx) => {
                const slot = toolAcc[idx];
                let input = {};
                try { input = slot.args ? JSON.parse(slot.args) : {}; } catch { input = {}; }
                return { id: slot.id, name: slot.name, input };
            })
            .filter((c) => c.name);
        return { text, toolCalls };
    }

    handle.finalize = function doFinalize() {
        if (usage) onUsage(usage);
        const { text: t, toolCalls } = finalize();
        if (toolCalls.length) onToolCalls(toolCalls);
        const stop = toolCalls.length === 0;
        onStop({ text: t, toolCalls, stop });
        return { text: t, toolCalls, stop };
    };

    return handle;
}

export const openaiProvider = Object.freeze({
    name: 'openai',
    upstreamPath: UPSTREAM_PATH,
    toolsForProvider,
    buildBody,
    appendAssistantTurn,
    appendToolResults,
    parseResponse,
    makeStreamHandler,
});

export default openaiProvider;
