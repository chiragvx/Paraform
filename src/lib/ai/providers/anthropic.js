/**
 * Anthropic provider — the Messages-API implementation of the provider
 * interface (see ./index.js for the contract).
 *
 * This holds the Anthropic-specific request building, response parsing, SSE
 * accumulation, and tool-result formatting that used to live inline in
 * agent.js / provider.js. The normalized history (neutral {role,text,toolCalls,
 * toolResults} entries) is serialised here into the Anthropic `messages` shape:
 *   - assistant turns become { role:'assistant', content:[{type:'text'},
 *     {type:'tool_use', id, name, input}] }
 *   - tool results become   { role:'user', content:[{type:'tool_result',
 *     tool_use_id, content, is_error}] }
 */

const UPSTREAM_PATH = '/v1/messages';

/** Canonical tools pass straight through — Anthropic's native shape. */
function toolsForProvider(agentTools) {
    return (agentTools || []).map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema,
    }));
}

/** Serialise one neutral history entry into Anthropic message form. */
function toWireMessage(entry) {
    if (!entry) return null;
    if (entry.role === 'assistant') {
        const content = [];
        if (entry.text) content.push({ type: 'text', text: entry.text });
        for (const tc of entry.toolCalls || []) {
            content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input || {} });
        }
        // An assistant turn must carry at least one block.
        if (content.length === 0) content.push({ type: 'text', text: '' });
        return { role: 'assistant', content };
    }
    // role === 'user'
    if (entry.toolResults && entry.toolResults.length) {
        const content = entry.toolResults.map((r) => ({
            type: 'tool_result',
            tool_use_id: r.id,
            content: typeof r.result === 'string' ? r.result : JSON.stringify(r.result),
            is_error: !!(r.result && r.result.ok === false),
        }));
        return { role: 'user', content };
    }
    return { role: 'user', content: entry.text != null ? String(entry.text) : '' };
}

function buildBody({ system, history = [], tools, model, maxTokens, stream }) {
    const messages = history.map(toWireMessage).filter(Boolean);
    const body = {
        provider: 'anthropic',
        model,
        max_tokens: maxTokens,
        system,
        tools,
        messages,
        stream: !!stream,
    };
    return { path: UPSTREAM_PATH, body };
}

function appendAssistantTurn(history, { text, toolCalls }) {
    history.push({ role: 'assistant', text: text || '', toolCalls: toolCalls || [] });
}

function appendToolResults(history, results) {
    history.push({ role: 'user', toolResults: results || [] });
}

/**
 * Parse a non-streaming Anthropic Message.
 * @returns {{ text:string, toolCalls:Array<{id,name,input}>, stop:boolean, usage?:object }}
 */
function parseResponse(json) {
    const content = (json && json.content) || [];
    let text = '';
    const toolCalls = [];
    for (const block of content) {
        if (block.type === 'text') text += block.text || '';
        else if (block.type === 'tool_use') {
            toolCalls.push({ id: block.id, name: block.name, input: block.input || {} });
        }
    }
    const stop = json && json.stop_reason !== 'tool_use';
    return { text, toolCalls, stop: !!stop || toolCalls.length === 0, usage: json && json.usage };
}

/**
 * Build an SSE handler that consumes raw `data:` payload strings and emits
 * normalized events. Mirrors the Anthropic event protocol: message_start,
 * content_block_start/delta/stop, message_delta.
 */
function makeStreamHandler({ onText = () => {}, onToolCalls = () => {}, onStop = () => {}, onUsage = () => {} } = {}) {
    const blocks = {}; // index → { type, text?, id?, name?, _partialJson? }
    let stopReason = null;
    let usage = null;

    function finalize() {
        const indices = Object.keys(blocks).map(Number).sort((a, b) => a - b);
        let text = '';
        const toolCalls = [];
        for (const i of indices) {
            const b = blocks[i];
            if (b.type === 'text') text += b.text || '';
            else if (b.type === 'tool_use') toolCalls.push({ id: b.id, name: b.name, input: b.input || {} });
        }
        return { text, toolCalls };
    }

    function handle(payload) {
        if (!payload || payload === '[DONE]') return;
        let ev;
        try { ev = JSON.parse(payload); } catch { return; }
        switch (ev.type) {
            case 'message_start':
                if (ev.message && ev.message.usage) usage = ev.message.usage;
                break;
            case 'content_block_start': {
                const block = ev.content_block || {};
                if (block.type === 'text') blocks[ev.index] = { type: 'text', text: '' };
                else if (block.type === 'tool_use') {
                    blocks[ev.index] = { type: 'tool_use', id: block.id, name: block.name, input: {}, _partialJson: '' };
                } else blocks[ev.index] = { type: block.type || 'unknown' };
                break;
            }
            case 'content_block_delta': {
                const b = blocks[ev.index];
                const d = ev.delta || {};
                if (!b) break;
                if (d.type === 'text_delta') {
                    b.text = (b.text || '') + (d.text || '');
                    if (d.text) onText(d.text);
                } else if (d.type === 'input_json_delta') {
                    b._partialJson = (b._partialJson || '') + (d.partial_json || '');
                }
                break;
            }
            case 'content_block_stop': {
                const b = blocks[ev.index];
                if (b && b.type === 'tool_use') {
                    const raw = b._partialJson || '';
                    try { b.input = raw ? JSON.parse(raw) : {}; } catch { b.input = {}; }
                    delete b._partialJson;
                }
                break;
            }
            case 'message_delta': {
                const d = ev.delta || {};
                if (d.stop_reason) stopReason = d.stop_reason;
                if (ev.usage) { usage = { ...(usage || {}), ...ev.usage }; }
                break;
            }
            // message_stop is handled by finalize() on stream end.
            default:
                break;
        }
    }

    handle.finalize = function doFinalize() {
        if (usage) onUsage(usage);
        const { text, toolCalls } = finalize();
        if (toolCalls.length) onToolCalls(toolCalls);
        const stop = stopReason !== 'tool_use' || toolCalls.length === 0;
        onStop({ text, toolCalls, stop });
        return { text, toolCalls, stop };
    };

    return handle;
}

export const anthropicProvider = Object.freeze({
    name: 'anthropic',
    upstreamPath: UPSTREAM_PATH,
    toolsForProvider,
    buildBody,
    appendAssistantTurn,
    appendToolResults,
    parseResponse,
    makeStreamHandler,
});

export default anthropicProvider;
