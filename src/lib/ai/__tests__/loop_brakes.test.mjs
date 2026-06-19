/**
 * Tests for loop_brakes.js — the anti-oscillation guard that stops the agent
 * from re-editing one part's coordinates in circles.
 */
import assert from 'node:assert';
import { makeOscillationGuard, editTargetOf, EDIT_SOFT_LIMIT, EDIT_HARD_LIMIT } from '../loop_brakes.js';

let passed = 0, failed = 0;
function t(name, fn) {
    try { fn(); console.log(`  ok  ${name}`); passed++; }
    catch (e) { console.log(`  XX  ${name}\n      ${e && e.message}`); failed++; }
}

t('editTargetOf pulls the id an edit acts on, across field names', () => {
    assert.equal(editTargetOf({ featureId: 'f1' }), 'f1');
    assert.equal(editTargetOf({ componentId: 'c2' }), 'c2');
    assert.equal(editTargetOf({ partConnectorId: 'k3' }), 'k3');
    assert.equal(editTargetOf({ oldComponentId: 'c4' }), 'c4');
    assert.equal(editTargetOf({}), '');
    assert.equal(editTargetOf(null), '');
});

t('non-edit tools always pass (read-only / create-new never throttled)', () => {
    const g = makeOscillationGuard();
    for (let i = 0; i < 50; i++) {
        assert.equal(g.check('measure', { featureId: 'f1' }).action, 'allow');
        assert.equal(g.check('writeBuildScript', { name: 'x' }).action, 'allow');
    }
});

t('edits with no target are not throttled', () => {
    const g = makeOscillationGuard();
    for (let i = 0; i < 50; i++) assert.equal(g.check('editBuildScript', {}).action, 'allow');
});

t('soft nudge fires once at the soft limit, then stays quiet until hard', () => {
    const g = makeOscillationGuard();
    let nudges = 0;
    for (let i = 1; i < EDIT_HARD_LIMIT; i++) {
        const r = g.check('editBuildScript', { featureId: 'strut' });
        if (r.action === 'nudge') { nudges++; assert.ok(/STOP nudging/.test(r.note)); }
        else assert.equal(r.action, 'allow');
    }
    assert.equal(nudges, 1, 'exactly one soft nudge between soft and hard limits');
    // it fired AT the soft limit, not before
    const g2 = makeOscillationGuard();
    for (let i = 1; i < EDIT_SOFT_LIMIT; i++) assert.equal(g2.check('editBuildScript', { featureId: 'a' }).action, 'allow');
    assert.equal(g2.check('editBuildScript', { featureId: 'a' }).action, 'nudge'); // the EDIT_SOFT_LIMIT-th
});

t('hard limit emits a hard nudge then BLOCKS subsequent edits to that target', () => {
    const g = makeOscillationGuard();
    let r;
    for (let i = 1; i <= EDIT_HARD_LIMIT; i++) r = g.check('editBuildScript', { featureId: 'hinge' });
    assert.equal(r.action, 'nudge');
    assert.equal(r.hard, true);
    // every further edit to THIS target is blocked
    const blocked = g.check('editBuildScript', { featureId: 'hinge' });
    assert.equal(blocked.action, 'block');
    assert.ok(/oscillation guard/.test(blocked.note));
});

t('throttling is per (tool,target): other parts and other tools stay free', () => {
    const g = makeOscillationGuard();
    for (let i = 0; i < EDIT_HARD_LIMIT + 3; i++) g.check('editBuildScript', { featureId: 'deck' });
    // a DIFFERENT feature is unaffected
    assert.equal(g.check('editBuildScript', { featureId: 'base' }).action, 'allow');
    // a DIFFERENT tool on the blocked feature is tracked separately (not pre-blocked)
    assert.equal(g.check('setFeatureParams', { featureId: 'deck' }).action, 'allow');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
