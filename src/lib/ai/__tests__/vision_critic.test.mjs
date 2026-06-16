/**
 * Vision-critic unit tests — the PURE parts (no network):
 *   - resolveVisionCriticConfig / visionCriticActive over injected settings
 *   - buildCriticBody shapes a valid Gemini request (images → inlineData,
 *     no tools, systemInstruction present, goal echoed)
 *   - parseCritique pulls text out of a GenerateContentResponse
 *
 * Run standalone:
 *   node src/lib/ai/__tests__/vision_critic.test.mjs
 * Registered in lib/document/__tests__/all.mjs (runs under `npm test`), so it
 * uses RELATIVE imports — the aggregate runner has no $lib loader.
 */
import assert from 'node:assert/strict';

import {
    resolveVisionCriticConfig,
    visionCriticActive,
    buildCriticBody,
    parseCritique,
    CRITIC_SYSTEM,
} from '../vision_critic.js';

let _pass = 0, _fail = 0;
async function t(name, fn) {
    try { await fn(); console.log(`  ok  ${name}`); _pass++; }
    catch (e) { console.error(`  FAIL ${name}\n    ${e?.stack || e?.message || e}`); _fail++; }
}

console.log('── Vision critic (pure) ──');

await t('config: disabled by default, no key', () => {
    const c = resolveVisionCriticConfig({ ai: {} });
    assert.equal(c.enabled, false);
    assert.equal(c.apiKey, null);
    assert.equal(c.model, 'gemma-4-31b-it');     // sensible default
    assert.equal(visionCriticActive({ ai: {} }), false);
});

await t('config: enabled needs a key to be ACTIVE', () => {
    assert.equal(visionCriticActive({ ai: { visionCritic: true } }), false, 'enabled but no key → inactive');
    assert.equal(visionCriticActive({ ai: { visionCritic: true, visionCriticApiKey: 'AIzaX' } }), true);
});

await t('config: key falls back to the main Gemini key when critic key is blank', () => {
    const c = resolveVisionCriticConfig({ ai: { visionCritic: true, geminiApiKey: 'AIza-shared' } });
    assert.equal(c.apiKey, 'AIza-shared');
    // explicit critic key wins over the shared one
    const c2 = resolveVisionCriticConfig({ ai: { visionCritic: true, geminiApiKey: 'AIza-shared', visionCriticApiKey: 'AIza-own' } });
    assert.equal(c2.apiKey, 'AIza-own');
});

await t('config: custom model is honoured', () => {
    const c = resolveVisionCriticConfig({ ai: { visionCritic: true, visionCriticModel: 'gemini-2.5-flash', visionCriticApiKey: 'k' } });
    assert.equal(c.model, 'gemini-2.5-flash');
});

await t('buildCriticBody: gemini-shaped, no tools, images become inlineData', () => {
    const images = [
        { mediaType: 'image/jpeg', dataBase64: 'AAA', view: 'front' },
        { mediaType: 'image/png', dataBase64: 'BBB', view: 'iso' },
    ];
    const body = buildCriticBody({ images, goal: 'a robot dog leg', model: 'gemma-4-31b-it' });
    assert.equal(body.provider, 'gemini');
    assert.equal(body.model, 'gemma-4-31b-it');
    assert.equal(body.stream, false);
    assert.ok(body.systemInstruction && body.systemInstruction.parts[0].text === CRITIC_SYSTEM, 'brief is the systemInstruction');
    assert.ok(body.tools === undefined, 'perception-only: NO tools sent to Gemma');

    const userTurn = body.contents[0];
    assert.equal(userTurn.role, 'user');
    const inline = userTurn.parts.filter((p) => p.inlineData);
    assert.equal(inline.length, 2, 'both renders attached as inlineData');
    assert.equal(inline[0].inlineData.mimeType, 'image/jpeg');
    assert.equal(inline[0].inlineData.data, 'AAA');
    const textPart = userTurn.parts.find((p) => typeof p.text === 'string');
    assert.ok(/robot dog leg/.test(textPart.text), 'goal is echoed to the reviewer');
    assert.ok(/front, iso/.test(textPart.text), 'view names are listed');
});

await t('buildCriticBody: caps the render count and skips empty frames', () => {
    const images = [
        { dataBase64: '1' }, { dataBase64: '2' }, { dataBase64: '3' },
        { dataBase64: '4' }, { dataBase64: '5' }, { /* empty */ },
    ];
    const body = buildCriticBody({ images });
    const inline = body.contents[0].parts.filter((p) => p.inlineData);
    assert.equal(inline.length, 4, 'capped at 4 images');
});

await t('parseCritique: extracts the reviewer text', () => {
    const json = { candidates: [{ content: { parts: [{ text: 'the femur is a plain box' }] } }] };
    assert.equal(parseCritique(json), 'the femur is a plain box');
    assert.equal(parseCritique({}), '', 'garbage in → empty string, never throws');
});

console.log(`\nVision critic: ${_pass} passed, ${_fail} failed\n`);
if (_fail > 0) process.exitCode = 1;
