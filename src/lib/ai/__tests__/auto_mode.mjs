/**
 * Auto / focus mode test — proves that when autoMode is on, the agent does NOT
 * accept a premature "I'm done": it nudges the model to keep going until the
 * work is actually done, and stops cleanly once the model stops again with no
 * work in between. With autoMode off, the early stop is honored (old behavior).
 *
 * Run via:
 *   node --import ./src/lib/commands/__tests__/_register.mjs \
 *        src/lib/ai/__tests__/auto_mode.mjs
 */
import assert from 'node:assert/strict';

const _local = new Map();
const _mem = (m) => ({ getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear() });
globalThis.localStorage = _mem(_local);
globalThis.sessionStorage = _mem(new Map());

const { runAgentTurn } = await import('$lib/ai/agent.js');
const { writeSettings } = await import('../../../../app/settings/index.js');
const { resetDocumentStore, getDocumentStore } = await import('../../../../lib/document/index.js');

let _pass = 0, _fail = 0;
async function t(name, fn) {
    try { await fn(); console.log(`  ok  ${name}`); _pass++; }
    catch (e) { console.error(`  FAIL ${name}\n    ${e?.stack || e?.message || e}`); _fail++; }
}

const ENDPOINT = 'http://scripted-model.test';
const DONE = 'data: [DONE]\n\n';
const sse = (o) => `data: ${JSON.stringify(o)}\n\n`;

function emitOpenai(step, idx) {
    if (step.final) return sse({ choices: [{ index: 0, delta: { content: step.text || '' }, finish_reason: 'stop' }] }) + DONE;
    return sse({
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call_${idx}`, type: 'function', function: { name: step.tool, arguments: JSON.stringify(step.args || {}) } }] }, finish_reason: 'tool_calls' }],
    }) + DONE;
}

function priorResults(body) {
    const idToName = {};
    for (const m of body.messages || []) if (m.role === 'assistant') for (const tc of m.tool_calls || []) idToName[tc.id] = tc.function && tc.function.name;
    const out = [];
    for (const m of body.messages || []) {
        if (m.role !== 'tool') continue;
        let r = {}; try { r = JSON.parse(m.content); } catch { r = {}; }
        out.push({ name: idToName[m.tool_call_id], response: r });
    }
    return out;
}
function countNudges(body) {
    let n = 0;
    for (const m of body.messages || []) if (m.role === 'user' && typeof m.content === 'string' && m.content.includes('[auto mode]')) n++;
    return n;
}

function installScriptedModel(plan) {
    const real = globalThis.fetch;
    globalThis.fetch = async (url, opts = {}) => {
        const body = JSON.parse(opts.body);
        const step = plan(priorResults(body), body);
        const text = emitOpenai(step, (body.messages || []).filter((m) => m.role === 'tool').length);
        return { ok: true, status: 200, body: null, headers: { get: () => null }, async text() { return text; }, async json() { return {}; } };
    };
    return () => { globalThis.fetch = real; };
}

function recorder() {
    const events = [];
    return { onEvent: (ev) => events.push(ev), calls: () => events.filter((e) => e.type === 'tool_call') };
}

// A model that tries to stop immediately, but if nudged ("[auto mode]") it then
// builds a box, then tries to stop again.
const lazyPlan = (prior, body) => {
    const nudges = countNudges(body);
    if (prior.length === 0) {
        if (nudges === 0) return { final: true, text: 'Done.' };       // premature stop
        return { tool: 'addBox', args: { length: 10, width: 10, height: 10 } }; // nudged → build
    }
    return { final: true, text: 'Built the box. Complete.' };
};

console.log('── Auto / focus mode ──');

await t('autoMode OFF: a premature stop is honored (nothing built)', async () => {
    writeSettings({ ai: { provider: 'openai' } });
    resetDocumentStore();
    const rec = recorder();
    const restore = installScriptedModel(lazyPlan);
    try {
        await runAgentTurn({ userMessage: 'make a box', onEvent: rec.onEvent, endpoint: ENDPOINT, autoMode: false });
    } finally { restore(); }
    assert.equal(rec.calls().length, 0, 'no tool calls — the early stop was accepted');
    const boxes = Object.values(getDocumentStore().doc.features).filter((f) => f.type === 'Box');
    assert.equal(boxes.length, 0, 'no box was built');
});

await t('autoMode ON: the model is nudged past the premature stop and builds', async () => {
    writeSettings({ ai: { provider: 'openai' } });
    resetDocumentStore();
    const rec = recorder();
    const restore = installScriptedModel(lazyPlan);
    try {
        await runAgentTurn({ userMessage: 'make a box', onEvent: rec.onEvent, endpoint: ENDPOINT, autoMode: true });
    } finally { restore(); }
    const addBoxCalls = rec.calls().filter((c) => c.name === 'addBox');
    assert.equal(addBoxCalls.length, 1, 'auto mode nudged the model into actually building');
    const boxes = Object.values(getDocumentStore().doc.features).filter((f) => f.type === 'Box');
    assert.equal(boxes.length, 1, 'a box exists after auto mode drove it to completion');
});

await t('autoMode ON: terminates (does not loop forever) once truly done', async () => {
    writeSettings({ ai: { provider: 'openai' } });
    resetDocumentStore();
    const rec = recorder();
    const restore = installScriptedModel(lazyPlan);
    let finished = false;
    try {
        await runAgentTurn({ userMessage: 'make a box', onEvent: rec.onEvent, endpoint: ENDPOINT, autoMode: true });
        finished = true;
    } finally { restore(); }
    assert.equal(finished, true, 'the turn returned (bounded, no infinite nudging)');
});

console.log(`\n${_pass} passed, ${_fail} failed`);
if (_fail) process.exit(1);
