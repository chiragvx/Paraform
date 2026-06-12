/**
 * Phase 2 — AI provider abstraction tests.
 *
 * Run via:
 *   node --import ./src/lib/commands/__tests__/_register.mjs \
 *        src/lib/ai/__tests__/providers.mjs
 *
 * Covers:
 *   (a) gemini.toolsForProvider produces functionDeclarations with `parameters`
 *       (not `input_schema`) for every tool that takes input.
 *   (b) gemini.parseResponse extracts text + toolCalls from a sample
 *       candidates[].content.parts[] payload including a functionCall.
 *   (c) gemini.appendToolResults yields a { role:'user',
 *       parts:[{functionResponse:{name,response}}] } entry.
 *   (d) anthropic.parseResponse still parses an Anthropic-shaped response.
 *   plus: getProvider selection, schema sanitisation, history round-trips.
 */
import assert from 'node:assert/strict';

import { AGENT_TOOLS } from '$lib/ai/tools.js';
import { getProvider, DEFAULT_PROVIDER } from '$lib/ai/providers/index.js';

let _pass = 0, _fail = 0;
async function t(name, fn) {
    try {
        await fn();
        console.log(`  ok  ${name}`);
        _pass++;
    } catch (e) {
        console.error(`  FAIL ${name}\n    ${e?.stack || e?.message || e}`);
        _fail++;
    }
}

console.log('── Phase 2 — AI provider abstraction ──');

await t('getProvider: default is gemini; unknown falls back to default', () => {
    assert.equal(DEFAULT_PROVIDER, 'gemini');
    assert.equal(getProvider().name, 'gemini');
    assert.equal(getProvider('gemini').name, 'gemini');
    assert.equal(getProvider('anthropic').name, 'anthropic');
    assert.equal(getProvider('totally-bogus').name, 'gemini');
    assert.equal(getProvider('GEMINI').name, 'gemini');
});

await t('(a) gemini.toolsForProvider → functionDeclarations with parameters (not input_schema)', () => {
    const gemini = getProvider('gemini');
    const tools = gemini.toolsForProvider(AGENT_TOOLS);
    assert.ok(Array.isArray(tools) && tools.length === 1, 'one tool wrapper');
    const decls = tools[0].functionDeclarations;
    assert.ok(Array.isArray(decls), 'has functionDeclarations array');
    assert.equal(decls.length, AGENT_TOOLS.length, 'one declaration per canonical tool');
    for (const d of decls) {
        assert.equal(typeof d.name, 'string');
        assert.equal(typeof d.description, 'string');
        assert.ok(!('input_schema' in d), `${d.name} must not carry input_schema`);
        // Tools that take input expose `parameters` (renamed from input_schema).
        const canonical = AGENT_TOOLS.find((x) => x.name === d.name);
        const hasProps = canonical.input_schema
            && canonical.input_schema.properties
            && Object.keys(canonical.input_schema.properties).length > 0;
        if (hasProps) {
            assert.ok(d.parameters, `${d.name} should have parameters`);
            assert.equal(d.parameters.type, 'object');
            // Only the allowed JSON-Schema keys survive sanitisation.
            for (const key of Object.keys(d.parameters)) {
                assert.ok(
                    ['type', 'description', 'properties', 'required', 'items', 'enum'].includes(key),
                    `${d.name}.parameters has unexpected key ${key}`,
                );
            }
        }
    }
    // Spot-check addBox specifically.
    const addBox = decls.find((d) => d.name === 'addBox');
    assert.ok(addBox.parameters.properties.length, 'addBox keeps its length prop');
    assert.deepEqual(addBox.parameters.required, ['length', 'width', 'height']);
});

await t('gemini.sanitizeSchema strips non-Gemini keywords but keeps enum/items', () => {
    const gemini = getProvider('gemini');
    const cleaned = gemini.sanitizeSchema({
        type: 'object',
        additionalProperties: true, // must be stripped
        properties: {
            kind: { type: 'string', enum: ['a', 'b'], description: 'k' },
            list: { type: 'array', items: { type: 'string' }, minItems: 1 /* stripped */ },
        },
        required: ['kind'],
    });
    assert.ok(!('additionalProperties' in cleaned));
    assert.deepEqual(cleaned.properties.kind.enum, ['a', 'b']);
    assert.equal(cleaned.properties.list.items.type, 'string');
    assert.ok(!('minItems' in cleaned.properties.list));
});

await t('(b) gemini.parseResponse extracts text + toolCalls from candidates[].content.parts[]', () => {
    const gemini = getProvider('gemini');
    const sample = {
        candidates: [{
            content: {
                role: 'model',
                parts: [
                    { text: 'Placing a box. ' },
                    { functionCall: { id: 'fc-1', name: 'addBox', args: { length: 10, width: 5, height: 3 } } },
                ],
            },
            finishReason: 'STOP',
        }],
        usageMetadata: { totalTokenCount: 42 },
    };
    const parsed = gemini.parseResponse(sample);
    assert.equal(parsed.text, 'Placing a box. ');
    assert.equal(parsed.toolCalls.length, 1);
    assert.equal(parsed.toolCalls[0].name, 'addBox');
    assert.equal(parsed.toolCalls[0].id, 'fc-1');
    assert.deepEqual(parsed.toolCalls[0].input, { length: 10, width: 5, height: 3 });
    assert.equal(parsed.stop, false, 'tool calls present → not stopped');
    assert.ok(parsed.usage);
});

await t('gemini.parseResponse: text-only → stop:true, no toolCalls', () => {
    const gemini = getProvider('gemini');
    const parsed = gemini.parseResponse({
        candidates: [{ content: { role: 'model', parts: [{ text: 'Done.' }] }, finishReason: 'STOP' }],
    });
    assert.equal(parsed.text, 'Done.');
    assert.equal(parsed.toolCalls.length, 0);
    assert.equal(parsed.stop, true);
});

await t('(c) gemini.appendToolResults → {role:user, parts:[{functionResponse:{name,response}}]}', () => {
    const gemini = getProvider('gemini');
    const history = [];
    gemini.appendToolResults(history, [
        { id: 'fc-1', name: 'addBox', result: { ok: true, featureId: 'box_1' } },
        { id: null, name: 'measure', result: 12.5 }, // scalar must be wrapped
    ]);
    assert.equal(history.length, 1);
    // Serialise through buildBody to confirm the wire shape.
    const { body } = gemini.buildBody({
        system: 'sys', history, tools: [], model: 'gemini-2.5-flash', maxTokens: 100, stream: false,
    });
    const content = body.contents[0];
    assert.equal(content.role, 'user');
    assert.equal(content.parts.length, 2);
    const fr0 = content.parts[0].functionResponse;
    assert.equal(fr0.name, 'addBox');
    assert.deepEqual(fr0.response, { ok: true, featureId: 'box_1' });
    assert.equal(fr0.id, 'fc-1');
    const fr1 = content.parts[1].functionResponse;
    assert.equal(fr1.name, 'measure');
    assert.deepEqual(fr1.response, { result: 12.5 }, 'scalar wrapped as object');
    assert.ok(!('id' in fr1), 'no id echoed when none provided');
});

await t('gemini.buildBody: assistant turn → role:model with functionCall parts; systemInstruction set', () => {
    const gemini = getProvider('gemini');
    const history = [{ role: 'user', text: 'hi' }];
    gemini.appendAssistantTurn(history, { text: 'ok', toolCalls: [{ id: 'x', name: 'addBox', input: { length: 1 } }] });
    const { body, path } = gemini.buildBody({
        system: 'SYS', history, tools: [], model: 'gemini-2.5-flash', maxTokens: 256, stream: true,
    });
    assert.equal(body.provider, 'gemini');
    assert.equal(body.systemInstruction.parts[0].text, 'SYS');
    assert.equal(body.generationConfig.maxOutputTokens, 256);
    assert.equal(body.contents[0].role, 'user');
    assert.equal(body.contents[1].role, 'model');
    const fc = body.contents[1].parts.find((p) => p.functionCall);
    assert.equal(fc.functionCall.name, 'addBox');
    assert.match(path, /streamGenerateContent\?alt=sse$/);
});

await t('gemini.makeStreamHandler accumulates text + functionCall across chunks', () => {
    const gemini = getProvider('gemini');
    const texts = [];
    let finalResult = null;
    const handler = gemini.makeStreamHandler({
        onText: (txt) => texts.push(txt),
        onStop: (r) => { finalResult = r; },
    });
    handler(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Hel' }] } }] }));
    handler(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'lo' }] } }] }));
    handler(JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name: 'addBox', args: { length: 2 } } }] }, finishReason: 'STOP' }] }));
    const out = handler.finalize();
    assert.deepEqual(texts, ['Hel', 'lo']);
    assert.equal(out.text, 'Hello');
    assert.equal(out.toolCalls.length, 1);
    assert.equal(out.toolCalls[0].name, 'addBox');
    assert.equal(out.stop, false);
    assert.ok(finalResult, 'onStop fired');
});

await t('(d) anthropic.parseResponse parses an Anthropic-shaped response', () => {
    const anthropic = getProvider('anthropic');
    const sample = {
        role: 'assistant',
        stop_reason: 'tool_use',
        content: [
            { type: 'text', text: 'Adding a box.' },
            { type: 'tool_use', id: 'tu-1', name: 'addBox', input: { length: 10, width: 10, height: 10 } },
        ],
        usage: { input_tokens: 5, output_tokens: 7 },
    };
    const parsed = anthropic.parseResponse(sample);
    assert.equal(parsed.text, 'Adding a box.');
    assert.equal(parsed.toolCalls.length, 1);
    assert.equal(parsed.toolCalls[0].name, 'addBox');
    assert.equal(parsed.toolCalls[0].id, 'tu-1');
    assert.equal(parsed.stop, false, 'tool_use → not stopped');
    assert.ok(parsed.usage);
});

await t('anthropic: tools pass through with input_schema; tool results → tool_result blocks', () => {
    const anthropic = getProvider('anthropic');
    const tools = anthropic.toolsForProvider(AGENT_TOOLS);
    assert.ok(tools[0].input_schema, 'anthropic keeps input_schema');
    assert.ok(!('parameters' in tools[0]), 'anthropic does not rename to parameters');

    const history = [];
    anthropic.appendToolResults(history, [{ id: 'tu-1', name: 'addBox', result: { ok: true } }]);
    const { body } = anthropic.buildBody({
        system: 'sys', history, tools, model: 'claude-opus-4-8', maxTokens: 100, stream: false,
    });
    assert.equal(body.provider, 'anthropic');
    const msg = body.messages[0];
    assert.equal(msg.role, 'user');
    assert.equal(msg.content[0].type, 'tool_result');
    assert.equal(msg.content[0].tool_use_id, 'tu-1');
});

await t('anthropic.makeStreamHandler assembles text + tool_use over SSE events', () => {
    const anthropic = getProvider('anthropic');
    let final = null;
    const handler = anthropic.makeStreamHandler({ onStop: (r) => { final = r; } });
    handler(JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 1 } } }));
    handler(JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }));
    handler(JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } }));
    handler(JSON.stringify({ type: 'content_block_stop', index: 0 }));
    handler(JSON.stringify({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu-9', name: 'addBox' } }));
    handler(JSON.stringify({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"length":3}' } }));
    handler(JSON.stringify({ type: 'content_block_stop', index: 1 }));
    handler(JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'tool_use' } }));
    const out = handler.finalize();
    assert.equal(out.text, 'Hi');
    assert.equal(out.toolCalls.length, 1);
    assert.equal(out.toolCalls[0].name, 'addBox');
    assert.deepEqual(out.toolCalls[0].input, { length: 3 });
    assert.equal(out.stop, false);
    assert.ok(final);
});

console.log(`\n${_pass} passed, ${_fail} failed`);
process.exit(_fail === 0 ? 0 : 1);
