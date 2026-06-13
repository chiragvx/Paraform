/**
 * AI agent build — end-to-end "can a model actually build in the editor" proof.
 *
 * Run via:
 *   node --import ./src/lib/commands/__tests__/_register.mjs \
 *        src/lib/ai/__tests__/agent_build_e2e.mjs
 *
 * Unlike tools.mjs (dispatchTool in isolation) and providers.mjs (serialisation
 * in isolation), this drives the REAL runAgentTurn loop top to bottom:
 *
 *   scripted model → <provider>.buildBody → streamChat (SSE framing) →
 *   <provider> stream handler → dispatchTool → real lib/document ops → tool
 *   results fed back → next model turn.
 *
 * The only thing faked is the LLM itself: globalThis.fetch is replaced with a
 * deterministic "scripted model" that plays a realistic multi-step build plan.
 * It does NOT hard-code feature ids — it reads each tool result out of the
 * request body and threads the editor's real returned ids into the next call,
 * exactly as a live model must. If the editor's round-trip (ids flow
 * model→editor→model) were broken, these tests would fail.
 *
 * Every scenario runs against BOTH the default GPT-OSS path ('openai', the core
 * focus — OpenAI-compatible tool_calls) and the Gemini path ('gemini',
 * functionCall parts), forcing the provider through the settings store. The
 * scripted model shapes its SSE to whatever provider the request body names, so
 * one plan proves both wire formats build the same geometry.
 *
 * No API key and no kernel are required: the build plan uses only document-level
 * ops (primitives, booleans, library placement, observe). Kernel-backed verbs
 * (measure / run_invariants) are covered by a separate integration test.
 */
import assert from 'node:assert/strict';

// ── In-memory localStorage + sessionStorage so we can force the active provider
// per scenario AND exercise the v1 session-only routing for BYO API keys.
const _local = new Map();
const _session = new Map();
function _mem(map) {
    return {
        getItem: (k) => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => { map.set(k, String(v)); },
        removeItem: (k) => { map.delete(k); },
        clear: () => { map.clear(); },
    };
}
globalThis.localStorage = _mem(_local);
globalThis.sessionStorage = _mem(_session);

const { runAgentTurn } = await import('$lib/ai/agent.js');
const { writeSettings } = await import('../../../../app/settings/index.js');
const { resetDocumentStore, getDocumentStore } = await import('../../../../lib/document/index.js');

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

const ENDPOINT = 'http://scripted-model.test';
const PROVIDERS = ['openai', 'gemini'];

function setProvider(name) {
    writeSettings({ ai: { provider: name } });
}

// ── Provider-shaped SSE ───────────────────────────────────────────────────────
//
// A plan step is provider-neutral: either { tool, args, text? } (call one tool)
// or { final:true, text } (end the turn). These helpers render it into the SSE
// the active provider's stream handler expects.

function sse(obj) { return `data: ${JSON.stringify(obj)}\n\n`; }
const DONE = 'data: [DONE]\n\n';

function emitOpenai(step, stepIndex) {
    if (step.final) {
        return sse({ choices: [{ index: 0, delta: { content: step.text || '' }, finish_reason: 'stop' }] }) + DONE;
    }
    let out = '';
    if (step.text) out += sse({ choices: [{ index: 0, delta: { content: step.text } }] });
    out += sse({
        choices: [{
            index: 0,
            delta: { tool_calls: [{ index: 0, id: `call_${stepIndex}`, type: 'function', function: { name: step.tool, arguments: JSON.stringify(step.args || {}) } }] },
            finish_reason: 'tool_calls',
        }],
        usage: { total_tokens: 16 },
    });
    return out + DONE;
}

function emitGemini(step) {
    if (step.final) {
        return sse({ candidates: [{ content: { role: 'model', parts: [{ text: step.text || '' }] }, finishReason: 'STOP' }] });
    }
    const parts = [];
    if (step.text) parts.push({ text: step.text });
    parts.push({ functionCall: { name: step.tool, args: step.args || {} } });
    return sse({ candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }], usageMetadata: { totalTokenCount: 16 } });
}

// ── Read prior tool results back out of the request body, per provider ─────────

function priorResults(body) {
    if (body.provider === 'gemini') {
        const out = [];
        for (const c of body.contents || []) {
            if (c.role !== 'user') continue;
            for (const p of c.parts || []) {
                if (p.functionResponse) out.push({ name: p.functionResponse.name, response: p.functionResponse.response });
            }
        }
        return out;
    }
    // openai: tool messages carry only tool_call_id + content; recover the name
    // from the preceding assistant tool_calls, exactly as a real model context.
    const idToName = {};
    for (const m of body.messages || []) {
        if (m.role === 'assistant') {
            for (const tc of m.tool_calls || []) idToName[tc.id] = tc.function && tc.function.name;
        }
    }
    const out = [];
    for (const m of body.messages || []) {
        if (m.role !== 'tool') continue;
        let response = {};
        try { response = JSON.parse(m.content); } catch { response = { raw: m.content }; }
        out.push({ name: idToName[m.tool_call_id], response });
    }
    return out;
}

/**
 * Install a fake fetch that answers POST /ai/chat by running `plan(prior)` and
 * rendering the returned step into the request's provider SSE shape.
 */
function installScriptedModel(plan) {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts = {}) => {
        const u = String(url);
        if (!u.endsWith('/ai/chat')) throw new Error(`scripted model received an unexpected request: ${u}`);
        const body = JSON.parse(opts.body);
        const prior = priorResults(body);
        const step = plan(prior, body);
        const text = body.provider === 'gemini' ? emitGemini(step) : emitOpenai(step, prior.length);
        return {
            ok: true,
            status: 200,
            body: null, // force streamChat's "no getReader" text fallback
            headers: { get: () => null },
            async text() { return text; },
            async json() { return {}; },
        };
    };
    return () => { globalThis.fetch = realFetch; };
}

function recorder() {
    const events = [];
    return {
        onEvent: (ev) => events.push(ev),
        events,
        calls: () => events.filter((e) => e.type === 'tool_call'),
        results: () => events.filter((e) => e.type === 'tool_result'),
        text: () => events.filter((e) => e.type === 'text').map((e) => e.text).join(''),
        done: () => events.some((e) => e.type === 'done'),
        error: () => events.find((e) => e.type === 'error'),
    };
}

/** Run one plan through runAgentTurn under the given provider. */
async function drive(provider, userMessage, plan) {
    setProvider(provider);
    resetDocumentStore();
    const rec = recorder();
    const restore = installScriptedModel(plan);
    try {
        await runAgentTurn({ userMessage, onEvent: rec.onEvent, endpoint: ENDPOINT });
    } finally {
        restore();
    }
    return rec;
}

console.log('── AI agent build — end-to-end (scripted model, GPT-OSS + Gemini) ──');

for (const provider of PROVIDERS) {
    // ── Scenario A: build a bracket from primitives + a boolean ────────────────
    // addBox → addCylinder → addUnion(both real ids) → get_document_summary →
    // final prose. Proves multi-step id threading and a boolean assembly.
    await t(`[${provider}] builds a base+boss bracket and unions them by real id`, async () => {
        const plan = (prior) => {
            switch (prior.length) {
                case 0: return { text: 'Creating the base plate.', tool: 'addBox', args: { length: 40, width: 20, height: 5 } };
                case 1: return { text: 'Adding a boss.', tool: 'addCylinder', args: { radius: 6, height: 12 } };
                case 2: {
                    const boxId = prior[0].response.featureId;
                    const cylId = prior[1].response.featureId;
                    assert.ok(boxId && cylId, `editor must return featureIds (got ${boxId}, ${cylId})`);
                    return { text: 'Fusing boss to base.', tool: 'addUnion', args: { featureIds: [boxId, cylId] } };
                }
                case 3: return { tool: 'get_document_summary', args: {} };
                default: return { final: true, text: 'Built a 40×20×5 mm base with a Ø12 mm boss fused on. 3 features.' };
            }
        };
        const rec = await drive(provider, 'Make a bracket: a plate with a cylindrical boss fused on.', plan);

        assert.ok(!rec.error(), `loop errored: ${JSON.stringify(rec.error())}`);
        assert.ok(rec.done(), 'loop emitted done');
        for (const r of rec.results()) {
            assert.notEqual(r.result && r.result.ok, false, `${r.name} failed: ${JSON.stringify(r.result)}`);
        }

        const doc = getDocumentStore().doc;
        const types = Object.values(doc.features).map((f) => f.type);
        assert.ok(types.includes('Box'), `expected a Box, got ${types}`);
        assert.ok(types.includes('Cylinder'), `expected a Cylinder, got ${types}`);
        assert.ok(types.includes('Union'), `expected a Union, got ${types}`);

        const union = Object.values(doc.features).find((f) => f.type === 'Union');
        const referenced = JSON.stringify(union.inputs || {});
        const box = Object.values(doc.features).find((f) => f.type === 'Box');
        const cyl = Object.values(doc.features).find((f) => f.type === 'Cylinder');
        assert.ok(referenced.includes(box.id), 'union references the real box id');
        assert.ok(referenced.includes(cyl.id), 'union references the real cylinder id');

        assert.ok(/boss|base|bracket/i.test(rec.text()), `expected a closing summary, got "${rec.text()}"`);
    });

    // ── Scenario B: assemble a real library part via search → place ────────────
    await t(`[${provider}] searches the library and places the part it found`, async () => {
        const { loadLibrary } = await import('../../library/index.js');
        await loadLibrary();
        const plan = (prior) => {
            switch (prior.length) {
                case 0: return { text: 'Looking for an SG90 servo.', tool: 'search_library', args: { query: 'sg90 servo' } };
                case 1: {
                    const hits = (prior[0].response && prior[0].response.hits) || [];
                    assert.ok(hits.length > 0, 'search_library returned at least one real part');
                    return { text: `Placing ${hits[0].name}.`, tool: 'placeLibraryPart', args: { partId: hits[0].partId } };
                }
                case 2: return { tool: 'list_components', args: {} };
                default: return { final: true, text: 'Placed an SG90-class servo into the assembly.' };
            }
        };
        const rec = await drive(provider, 'Add an SG90 servo to the scene.', plan);

        assert.ok(!rec.error(), `loop errored: ${JSON.stringify(rec.error())}`);
        for (const r of rec.results()) {
            assert.notEqual(r.result && r.result.ok, false, `${r.name} failed: ${JSON.stringify(r.result)}`);
        }
        const comps = Object.values(getDocumentStore().doc.components || {});
        assert.ok(comps.length >= 1, `expected a placed component, got ${comps.length}`);
        const placeCall = rec.calls().find((c) => c.name === 'placeLibraryPart');
        assert.ok(placeCall && placeCall.input.partId, 'placeLibraryPart was called with a partId');
    });

    // ── Scenario C: a silent build still yields a synthesized completion ───────
    await t(`[${provider}] a silent build still yields a synthesized completion line`, async () => {
        const plan = (prior) => (prior.length === 0
            ? { tool: 'addBox', args: { length: 10, width: 10, height: 10 } }
            : { final: true, text: '' });
        const rec = await drive(provider, 'Make a 10mm cube.', plan);

        assert.ok(!rec.error(), `loop errored: ${JSON.stringify(rec.error())}`);
        const built = Object.values(getDocumentStore().doc.features).some((f) => f.type === 'Box');
        assert.ok(built, 'the cube was built');
        assert.ok(rec.text().trim().length > 0, 'a non-empty completion line was synthesized for the mute turn');
    });
}

// ── v1 bring-your-own-key: forwarded as a header AND lives only in sessionStorage
await t('settings API key + base URL are forwarded to the proxy as headers', async () => {
    setProvider('openai');
    writeSettings({ ai: { openaiApiKey: 'sk-test-byok-123', openaiBaseUrl: 'https://api.groq.com/openai/v1' } });
    resetDocumentStore();

    const seen = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts = {}) => {
        seen.push({ url: String(url), headers: opts.headers || {} });
        const body = JSON.parse(opts.body);
        const prior = priorResults(body);
        const step = prior.length === 0
            ? { tool: 'addBox', args: { length: 5, width: 5, height: 5 } }
            : { final: true, text: 'done' };
        return {
            ok: true, status: 200, body: null, headers: { get: () => null },
            async text() { return emitOpenai(step, prior.length); }, async json() { return {}; },
        };
    };
    try {
        await runAgentTurn({ userMessage: 'tiny cube', endpoint: ENDPOINT });
    } finally {
        globalThis.fetch = realFetch;
        writeSettings({ ai: { openaiApiKey: '', openaiBaseUrl: '' } }); // don't leak into other tests
    }

    assert.ok(seen.length >= 1, 'at least one proxy request was made');
    const h = seen[0].headers;
    assert.equal(h['X-Provider-Api-Key'], 'sk-test-byok-123', 'forwards the user key as X-Provider-Api-Key');
    assert.equal(h['X-Provider-Base-Url'], 'https://api.groq.com/openai/v1', 'forwards the host base URL');
    assert.ok(Object.values(getDocumentStore().doc.features).some((f) => f.type === 'Box'), 'cube built with BYO key');
});

await t('blank settings key → no X-Provider-Api-Key header is sent (proxy will 503 in v1)', async () => {
    setProvider('openai');
    writeSettings({ ai: { openaiApiKey: '', openaiBaseUrl: '' } });
    resetDocumentStore();
    let headers = null;
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts = {}) => {
        headers = opts.headers || {};
        const body = JSON.parse(opts.body);
        const prior = priorResults(body);
        // The real proxy would 503 here; the harness keeps responding so we can
        // assert the headers without modelling the error path end-to-end.
        const step = prior.length === 0 ? { tool: 'addBox', args: { length: 2, width: 2, height: 2 } } : { final: true, text: 'done' };
        return { ok: true, status: 200, body: null, headers: { get: () => null }, async text() { return emitOpenai(step, prior.length); }, async json() { return {}; } };
    };
    try {
        await runAgentTurn({ userMessage: 'tiny cube', endpoint: ENDPOINT });
    } finally {
        globalThis.fetch = realFetch;
    }
    assert.ok(headers && !('X-Provider-Api-Key' in headers), 'no key header when settings key is blank');
});

await t('API keys land in sessionStorage and NEVER in the localStorage blob', async () => {
    // Clean slate so we can inspect the raw stored blobs precisely.
    _local.clear(); _session.clear();
    writeSettings({ ai: { provider: 'anthropic', anthropicApiKey: 'sk-ant-secret-xyz' } });

    const persistedRaw = _local.get('paraform_app_settings') || '';
    const sessionRaw = _session.get('paraform_session_secrets') || '';

    assert.ok(persistedRaw.length > 0, 'persistent settings blob was written');
    assert.ok(!persistedRaw.includes('sk-ant-secret-xyz'), 'api key MUST NOT appear in the localStorage blob');
    assert.ok(sessionRaw.includes('sk-ant-secret-xyz'), 'api key DOES live in the sessionStorage blob');

    // …and the readback still surfaces it (sessionStorage overlays).
    const { readSettings } = await import('../../../../app/settings/index.js');
    assert.equal(readSettings().ai.anthropicApiKey, 'sk-ant-secret-xyz', 'readback overlays the session secret');

    // Cleanup so subsequent tests aren't affected.
    _local.clear(); _session.clear();
});

console.log(`\n${_pass} passed, ${_fail} failed`);
process.exit(_fail === 0 ? 0 : 1);
