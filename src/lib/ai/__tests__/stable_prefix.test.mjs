/**
 * Guards the cache-critical invariant: the system prompt (messages[0]) carries
 * ONLY the stable doctrine — no live scene digest, selection, or design-context.
 *
 * Why it matters: on a prefix-caching provider (DeepSeek/OpenAI/Anthropic/Gemini)
 * the cache matches the longest byte-identical prefix. If anything that changes
 * between iterations (the "Current bodies" digest, the viewport selection) gets
 * baked back into system[0], the cache breaks INSIDE the first message and the
 * entire growing history is re-billed at full price every call — the O(N²) drain.
 * The live state must ride as an ephemeral tail message instead (buildLiveContext).
 */
import assert from 'node:assert';
import { buildSystem } from '../agent.js';
import { SYSTEM_PROMPT } from '../system_prompt.js';

let passed = 0, failed = 0;
function t(name, fn) {
    try { fn(); console.log(`  ok  ${name}`); passed++; }
    catch (e) { console.log(`  XX  ${name}\n      ${e && e.message}`); failed++; }
}

t('a seeing model\'s system prompt is EXACTLY the static doctrine (nothing dynamic appended)', () => {
    // vision-capable + no critic → no vision override → byte-for-byte SYSTEM_PROMPT.
    // If anyone re-bakes the scene digest / selection / context into buildSystem,
    // this equality breaks — which is the whole point: system[0] must be stable.
    assert.strictEqual(buildSystem(true, false), SYSTEM_PROMPT);
});

t('blind variants only append the STATIC vision override, still prefixed by the doctrine', () => {
    const blind = buildSystem(false, false);
    const blindWithCritic = buildSystem(false, true);
    assert.ok(blind.startsWith(SYSTEM_PROMPT), 'doctrine stays the stable prefix');
    assert.ok(blindWithCritic.startsWith(SYSTEM_PROMPT));
    // The only delta is the static override text — no per-call data.
    assert.notEqual(blind, blindWithCritic);
});

t('buildSystem is deterministic for a given vision/critic state', () => {
    assert.equal(buildSystem(true, false), buildSystem(true, false));
    assert.equal(buildSystem(false, true), buildSystem(false, true));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
