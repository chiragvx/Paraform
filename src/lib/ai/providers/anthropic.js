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

const EPHEMERAL = { type: 'ephemeral' };

/**
 * Canonical tools → Anthropic's native shape, with the LAST tool marked for
 * prompt caching.
 *
 * Why the last tool: an Anthropic cache breakpoint caches the contiguous request
 * prefix up to and including the marked block, and `tools` precede `system` +
 * `messages` in that prefix. The tool surface (~30k tokens) is the single
 * largest STABLE part of every request — agent.js builds `tools` once per turn
 * (outside the iteration loop) and reuses the identical array on every
 * tool-call round-trip. One breakpoint here turns that whole block into a
 * ~90%-cheaper cache READ on iterations 2..N of a multi-step build, which is
 * where the cost actually lived (the block was re-billed in full 10–50× per
 * build before this). The 1.25× write surcharge on the first call is recouped
 * on the second; any multi-iteration turn — i.e. every real build — comes out
 * far ahead, and a single-shot turn still seeds the cache for the next user
 * message within the 5-minute TTL.
 */
function toolsForProvider(agentTools) {
    const list = (agentTools || []).map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema,
    }));
    if (list.length) {
        list[list.length - 1] = { ...list[list.length - 1], cache_control: EPHEMERAL };
    }
    return list;
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
    // Vision: a user turn carrying images → Anthropic image blocks (base64).
    if (entry.images && entry.images.length) {
        const content = [];
        if (entry.text) content.push({ type: 'text', text: String(entry.text) });
        for (const img of entry.images) {
            if (!img || !img.dataBase64) continue;
            content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType || 'image/png', data: img.dataBase64 } });
        }
        if (content.length) return { role: 'user', content };
    }
    return { role: 'user', content: entry.text != null ? String(entry.text) : '' };
}

function buildBody({ system, history = [], tools, model, maxTokens, stream }) {
    const messages = history.map(toWireMessage).filter(Boolean);
    // Rolling conversation cache: mark the last block of the last message so the
    // growing message-history prefix is cached incrementally. In a multi-step
    // build the history balloons (every tool result is appended), so on each
    // round-trip the prior turns become a cache READ and only the new delta is
    // billed at full rate. Anthropic finds the longest cached prefix, so a single
    // rolling breakpoint suffices; combined with the tools breakpoint that is 2
    // of the allowed 4. Only array-content messages carry blocks — a plain text
    // turn (string content) has nowhere to hang the marker, so we skip it.
    const last = messages[messages.length - 1];
    if (last && Array.isArray(last.content) && last.content.length) {
        const i = last.content.length - 1;
        last.content[i] = { ...last.content[i], cache_control: EPHEMERAL };
    }
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
