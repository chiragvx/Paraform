/**
 * Multimodal tests — vision (capture_views), image attachments, image_to_sketch,
 * web research tool presence, and provider image serialization.
 *
 * Run via:
 *   node --import ./src/lib/commands/__tests__/_register.mjs \
 *        src/lib/ai/__tests__/multimodal.mjs
 */
import assert from 'node:assert/strict';

import { AGENT_TOOLS, dispatchTool } from '$lib/ai/tools.js';
import { openaiProvider, geminiProvider, anthropicProvider } from '$lib/ai/providers/index.js';
import { setSnapshotProvider, clearSnapshotProvider } from '../../../../lib/viewport/snapshot.js';
import { setAttachedImages, getLastAttachedImage, clearAttachedImages } from '$lib/ai/attachments.js';

let _pass = 0, _fail = 0;
async function t(name, fn) {
    try { await fn(); console.log(`  ok  ${name}`); _pass++; }
    catch (e) { console.error(`  FAIL ${name}\n    ${e?.stack || e?.message || e}`); _fail++; }
}

console.log('── Multimodal (vision / images / web) ──');

const IMG_HISTORY = [{ role: 'user', text: 'look at this', images: [{ mediaType: 'image/png', dataBase64: 'AAAA' }] }];

await t('openai serializes an image user turn to image_url content', () => {
    const body = openaiProvider.buildBody({ system: '', history: IMG_HISTORY, tools: [], model: 'm', maxTokens: 10, stream: false }).body;
    const u = body.messages.find((m) => m.role === 'user');
    assert.ok(Array.isArray(u.content), 'content is an array');
    const img = u.content.find((c) => c.type === 'image_url');
    assert.ok(img && /data:image\/png;base64,AAAA/.test(img.image_url.url), 'image_url data URL present');
    assert.ok(u.content.some((c) => c.type === 'text' && /look/.test(c.text)), 'text part preserved');
});

await t('gemini serializes an image user turn to inlineData', () => {
    const body = geminiProvider.buildBody({ system: '', history: IMG_HISTORY, tools: [], model: 'm', maxTokens: 10, stream: false }).body;
    const u = body.contents.find((c) => c.role === 'user');
    const img = u.parts.find((p) => p.inlineData);
    assert.ok(img && img.inlineData.data === 'AAAA' && img.inlineData.mimeType === 'image/png', 'inlineData part present');
});

await t('anthropic serializes an image user turn to an image block', () => {
    const body = anthropicProvider.buildBody({ system: '', history: IMG_HISTORY, tools: [], model: 'm', maxTokens: 10, stream: false }).body;
    const u = body.messages.find((m) => m.role === 'user');
    assert.ok(Array.isArray(u.content), 'content is an array');
    const img = u.content.find((c) => c.type === 'image');
    assert.ok(img && img.source && img.source.type === 'base64' && img.source.data === 'AAAA', 'image block present');
});

await t('vision + web tools are registered', () => {
    const names = new Set(AGENT_TOOLS.map((x) => x.name));
    for (const n of ['capture_views', 'image_to_sketch', 'web_search', 'web_fetch']) {
        assert.ok(names.has(n), `missing tool ${n}`);
    }
});

await t('capture_views: degrades with no viewport, works with a provider', async () => {
    clearSnapshotProvider();
    const none = await dispatchTool('capture_views', {});
    assert.equal(none.ok, false, 'no viewport → ok:false');

    const fake = async (views) => (views || ['front', 'right', 'top', 'iso']).map((v) => ({ view: v, dataUrl: `data:image/jpeg;base64,Zm9v${v.length}` }));
    setSnapshotProvider(fake);
    try {
        const got = await dispatchTool('capture_views', { views: ['front', 'top'] });
        assert.equal(got.ok, true, got.error);
        assert.deepEqual(got.views, ['front', 'top']);
        assert.ok(Array.isArray(got._images) && got._images.length === 2, '_images carries the frames');
        assert.equal(got._images[0].mediaType, 'image/jpeg');
        assert.ok(got._images[0].dataBase64.length > 0, 'base64 extracted from data URL');
    } finally {
        clearSnapshotProvider(fake);
    }
});

await t('image_to_sketch: degrades gracefully (no attachment / no DOM)', async () => {
    clearAttachedImages();
    const noAttach = await dispatchTool('image_to_sketch', {});
    assert.equal(noAttach.ok, false, 'no attachment → ok:false');
    assert.ok(/attach/i.test(noAttach.error), 'helpful message');

    setAttachedImages([{ mediaType: 'image/png', dataBase64: 'AAAA' }]);
    assert.ok(getLastAttachedImage(), 'attachment stored');
    const noDom = await dispatchTool('image_to_sketch', {});
    assert.equal(noDom.ok, false, 'no DOM in node → ok:false, not a throw');
    clearAttachedImages();
});

console.log(`\n${_pass} passed, ${_fail} failed`);
if (_fail) process.exit(1);
