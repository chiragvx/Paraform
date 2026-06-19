/**
 * Build-gate tests (clarify→plan→APPROVE→build, state-enforced).
 *
 * Verifies the pure `evaluateBuildGate` decision that the tool dispatcher uses to
 * refuse fabrication until intent is captured and any multi-node plan is approved
 * — the rail that the GPT-OSS-120B "blender" transcript walked straight past by
 * narrating the brief/plan in prose instead of calling the tools. Also checks the
 * widened gated-tool set and the weak-driver detector. PURE — no document store.
 *
 * Run via:
 *   node --import ./src/lib/commands/__tests__/_register.mjs \
 *        src/lib/ai/__tests__/build_gate.test.mjs
 */
import assert from 'node:assert/strict';

import { evaluateBuildGate, AGENT_TOOLS } from '../tools.js';
import { isWeakDriver } from '../agent.js';

let _pass = 0, _fail = 0;
async function t(name, fn) {
    try { await fn(); console.log(`  ok  ${name}`); _pass++; }
    catch (e) { console.error(`  FAIL ${name}\n    ${e?.stack || e?.message || e}`); _fail++; }
}

const blocked = (r) => r && typeof r.error === 'string' && /Build blocked/.test(r.error);

console.log('── Build gate (clarify→plan→approve→build) ──');

await t('first part on an EMPTY doc is allowed (the "20mm cube" escape)', () => {
    const r = evaluateBuildGate('addMountingPlate', { planNodes: 0, planApproved: false, hasBrief: false, featureCount: 0, partScale: true });
    assert.equal(r, null);
});

await t('bare primitives are NEVER intent-gated (incremental single-part edits)', () => {
    // "a box, now a cylinder on top" — partScale is false for primitives, so a
    // brief is never demanded no matter how many features already exist.
    const r = evaluateBuildGate('addBox', { planNodes: 0, planApproved: false, hasBrief: false, featureCount: 5, partScale: false });
    assert.equal(r, null);
});

await t('a second WHOLE PART with no brief is blocked (no faking intent in prose)', () => {
    const r = evaluateBuildGate('addMountingPlate', { planNodes: 0, planApproved: false, hasBrief: false, featureCount: 1, partScale: true });
    assert.ok(blocked(r));
    assert.match(r.error, /propose_brief/);
});

await t('a recorded brief unlocks subsequent part-scale builds', () => {
    const r = evaluateBuildGate('placeLibraryPart', { planNodes: 1, planApproved: false, hasBrief: true, featureCount: 2, partScale: true });
    assert.equal(r, null);
});

await t('an unapproved multi-node plan blocks fabrication even WITH a brief', () => {
    const r = evaluateBuildGate('build_part_recipe', { planNodes: 6, planApproved: false, hasBrief: true, featureCount: 0, partScale: true });
    assert.ok(blocked(r));
    assert.match(r.error, /not approved/);
});

await t('approval gate applies to bare primitives too (multi-node, unapproved)', () => {
    const r = evaluateBuildGate('addBox', { planNodes: 6, planApproved: false, hasBrief: false, featureCount: 0, partScale: false });
    assert.ok(blocked(r));
    assert.match(r.error, /not approved/);
});

await t('an APPROVED multi-node plan lets the build proceed', () => {
    const r = evaluateBuildGate('build_part_recipe', { planNodes: 6, planApproved: true, hasBrief: false, featureCount: 3, partScale: true });
    assert.equal(r, null);
});

await t('approval gate takes precedence over the intent gate', () => {
    // >1 node + unapproved → always the approval message, regardless of brief/doc.
    const r = evaluateBuildGate('placeLibraryPart', { planNodes: 4, planApproved: false, hasBrief: false, featureCount: 5, partScale: true });
    assert.ok(blocked(r));
    assert.match(r.error, /not approved/);
});

await t('the blender-killer: whole-part generators are real tools and intent-gated', () => {
    const names = new Set(AGENT_TOOLS.map((tdef) => tdef.name));
    for (const g of ['addMountingPlate', 'addImpeller', 'addProjectBox', 'addFan']) {
        assert.ok(names.has(g), `${g} should be a real tool`);
    }
    // The exact path the transcript used to slip two flat plates past the gate:
    // a second generator part with no captured intent is now refused.
    const r = evaluateBuildGate('addImpeller', { planNodes: 0, planApproved: false, hasBrief: false, featureCount: 1, partScale: true });
    assert.ok(blocked(r));
});

await t('bad / missing state never throws (totality)', () => {
    assert.equal(evaluateBuildGate('addBox'), null);                 // no state object
    assert.equal(evaluateBuildGate('addBox', {}), null);             // empty state
    assert.doesNotThrow(() => evaluateBuildGate(undefined, undefined));
});

await t('weak-driver detector flags known-weak families, not capable ones', () => {
    assert.equal(isWeakDriver('cerebras', 'gpt-oss-120b'), true);
    assert.equal(isWeakDriver('gemini', 'gemma-3-27b'), true);
    assert.equal(isWeakDriver('nvidia', 'meta/llama-3.1-8b-instruct'), true);
    assert.equal(isWeakDriver('anthropic', 'claude-opus-4-8'), false);
    assert.equal(isWeakDriver('gemini', 'gemini-2.5-flash'), false);
    assert.equal(isWeakDriver('openai', 'gpt-5'), false);
    assert.equal(isWeakDriver('x', ''), false);
});

console.log(`\nBuild gate: ${_pass} passed, ${_fail} failed`);
if (_fail) process.exit(1);
