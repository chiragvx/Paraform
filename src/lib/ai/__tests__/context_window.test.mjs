/**
 * Tests for context_window.js — the send-time history compaction that stops the
 * agent loop from re-billing a huge transcript on every iteration.
 */
import assert from 'node:assert';
import { compactHistory, digestResult, digestInput, estimateTokens } from '../context_window.js';

let passed = 0, failed = 0;
function t(name, fn) {
    try { fn(); console.log(`  ok  ${name}`); passed++; }
    catch (e) { console.log(`  XX  ${name}\n      ${e && e.message}`); failed++; }
}

// A long build123d source blob, the kind that rides along in editBuildScript.
const BIG_CODE = 'from build123d import *\n' + 'x = 1  # filler line\n'.repeat(80);

t('digestResult keeps identifying fields, drops the rest', () => {
    const r = digestResult({ ok: true, featureId: 'f12', summary: 'built deck', geometry: new Array(5000).fill(0), bodies: [{ huge: 'x'.repeat(9000) }] });
    assert.equal(r.ok, true);
    assert.equal(r.featureId, 'f12');
    assert.equal(r.summary, 'built deck');
    assert.equal(r.geometry, undefined);
    assert.equal(r.bodies, undefined);
    assert.ok(estimateTokens(r) < 50, 'digested result is tiny');
});

t('digestResult clips a long error and falls back to _digest when nothing known', () => {
    const r = digestResult({ ok: false, error: 'E'.repeat(2000) });
    assert.equal(r.ok, false);
    assert.ok(r.error.length < 300);
    const r2 = digestResult({ mystery: 'm'.repeat(2000) });
    assert.ok(r2._digest && r2._digest.length < 300);
});

t('digestInput elides long code strings but keeps small identifying keys', () => {
    const inp = { featureId: 'f7', name: 'strut', code: BIG_CODE };
    const d = digestInput(inp);
    assert.equal(d.featureId, 'f7');
    assert.equal(d.name, 'strut');
    assert.ok(/elided \d+ chars/.test(d.code), 'code blob elided');
    assert.ok(estimateTokens(d) < 40);
    // small inputs pass through untouched
    const small = { featureId: 'f7' };
    assert.strictEqual(digestInput(small), small);
});

t('compactHistory keeps the goal + recent window verbatim, compacts the middle', () => {
    const hist = [{ role: 'user', text: 'make a laptop stand' }];
    for (let i = 0; i < 20; i++) {
        hist.push({ role: 'assistant', text: `step ${i}`, toolCalls: [{ id: `c${i}`, name: 'editBuildScript', input: { featureId: `f${i}`, code: BIG_CODE } }] });
        hist.push({ role: 'user', toolResults: [{ id: `c${i}`, name: 'editBuildScript', result: { ok: true, featureId: `f${i}`, dump: 'd'.repeat(4000) } }] });
    }
    const out = compactHistory(hist, { keepRecent: 8 });

    // Goal kept verbatim, by reference.
    assert.strictEqual(out[0], hist[0]);
    // Recent window kept verbatim, by reference.
    for (let i = hist.length - 8; i < hist.length; i++) assert.strictEqual(out[i], hist[i], `recent[${i}] verbatim`);
    // An OLD assistant tool-call input was elided.
    const oldAsst = out[1];
    assert.ok(/elided/.test(oldAsst.toolCalls[0].input.code), 'old code elided');
    // An OLD tool result was digested (no dump field).
    const oldRes = out[2];
    assert.equal(oldRes.toolResults[0].result.dump, undefined);
    assert.equal(oldRes.toolResults[0].result.featureId, 'f0');
    // The compacted send is dramatically smaller than the raw transcript.
    assert.ok(estimateTokens(out) * 3 < estimateTokens(hist), 'compaction cuts >2/3 of tokens');
});

t('compactHistory preserves tool_use ↔ tool_result id pairing', () => {
    const hist = [{ role: 'user', text: 'go' }];
    for (let i = 0; i < 15; i++) {
        hist.push({ role: 'assistant', toolCalls: [{ id: `id${i}`, name: 'measure', input: { a: i } }] });
        hist.push({ role: 'user', toolResults: [{ id: `id${i}`, name: 'measure', result: { ok: true, value: i } }] });
    }
    const out = compactHistory(hist, { keepRecent: 6 });
    // Every assistant call id still has the matching result id.
    const callIds = out.flatMap((m) => (m.toolCalls || []).map((c) => c.id));
    const resIds = out.flatMap((m) => (m.toolResults || []).map((r) => r.id));
    assert.deepEqual(callIds, resIds, 'ids line up after compaction');
});

t('compactHistory is non-mutating', () => {
    const hist = [{ role: 'user', text: 'go' }];
    for (let i = 0; i < 12; i++) hist.push({ role: 'user', toolResults: [{ id: `c${i}`, name: 'x', result: { ok: true, dump: 'z'.repeat(3000) } }] });
    const snapshot = JSON.stringify(hist);
    compactHistory(hist, { keepRecent: 4 });
    assert.equal(JSON.stringify(hist), snapshot, 'original history untouched');
});

t('compactHistory ages out old render images, keeps the most recent few', () => {
    const hist = [{ role: 'user', text: 'go' }];
    for (let i = 0; i < 10; i++) {
        hist.push({ role: 'assistant', text: `t${i}` });
        hist.push({ role: 'user', text: 'render', images: [{ mediaType: 'image/jpeg', dataBase64: 'AAAA'.repeat(2000) }] });
    }
    const out = compactHistory(hist, { keepRecent: 4, keepImages: 2 });
    const withImages = out.filter((m) => Array.isArray(m.images) && m.images.length).length;
    // keepImages from the OLD zone + whatever falls inside the recent window.
    assert.ok(withImages <= 2 + 4, `kept ${withImages} image turns (bounded)`);
    assert.ok(withImages < 10, 'most old images dropped');
    // A dropped-image turn leaves a breadcrumb.
    const breadcrumb = out.some((m) => typeof m.text === 'string' && /render\(s\) omitted/.test(m.text));
    assert.ok(breadcrumb, 'omitted images leave a note');
});

t('short histories pass through untouched', () => {
    const hist = [{ role: 'user', text: 'go' }, { role: 'assistant', text: 'done' }];
    const out = compactHistory(hist, { keepRecent: 8 });
    assert.strictEqual(out[0], hist[0]);
    assert.strictEqual(out[1], hist[1]);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
