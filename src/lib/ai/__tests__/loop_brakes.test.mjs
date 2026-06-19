/**
 * Tests for loop_brakes.js — the convergence guards: edit-churn (re-editing one
 * script in circles) and the positioning funnel (hand move/rotate that never
 * converges on a hinge → forced onto mate_parts / drive_joint).
 */
import assert from 'node:assert';
import {
    makeOscillationGuard, editTargetOf,
    EDIT_SOFT_LIMIT, EDIT_HARD_LIMIT, POS_SOFT_LIMIT, POS_HARD_LIMIT,
} from '../loop_brakes.js';

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

t('non-tracked tools always pass (read-only / create-new never throttled)', () => {
    const g = makeOscillationGuard();
    for (let i = 0; i < 50; i++) {
        assert.equal(g.check('measure', { featureId: 'f1' }).action, 'allow');
        assert.equal(g.check('writeBuildScript', { name: 'x' }).action, 'allow');
        assert.equal(g.check('drive_joint', { jointId: 'j1' }).action, 'allow');
    }
});

// ── Edit churn ──────────────────────────────────────────────────────────────
t('edit churn: soft nudge once at the soft limit, hard nudge + block at the hard limit', () => {
    const g = makeOscillationGuard();
    let r, nudges = 0;
    for (let i = 1; i < EDIT_HARD_LIMIT; i++) {
        r = g.check('editBuildScript', { featureId: 'strut' });
        if (r.action === 'nudge') nudges++;
    }
    assert.equal(nudges, 1, 'exactly one soft nudge before the hard limit');
    r = g.check('editBuildScript', { featureId: 'strut' });   // the hard-limit-th
    assert.equal(r.action, 'nudge'); assert.equal(r.hard, true);
    assert.equal(g.check('editBuildScript', { featureId: 'strut' }).action, 'block');
});

t('edit churn is per (tool,target): other parts/tools stay free', () => {
    const g = makeOscillationGuard();
    for (let i = 0; i < EDIT_HARD_LIMIT + 2; i++) g.check('editBuildScript', { featureId: 'deck' });
    assert.equal(g.check('editBuildScript', { featureId: 'base' }).action, 'allow');
    assert.equal(g.check('setFeatureParams', { featureId: 'deck' }).action, 'allow');
});

// ── Positioning funnel ──────────────────────────────────────────────────────
t('positioning funnel counts move+rotate on one part TOGETHER (alternating cannot dodge it)', () => {
    const g = makeOscillationGuard();
    // Alternate addMove / addRotate on the same target — neither tool alone hits a
    // limit, but combined they should trip the funnel.
    let tripped = false;
    for (let i = 0; i < POS_HARD_LIMIT; i++) {
        const tool = i % 2 ? 'addMove' : 'addRotate';
        const r = g.check(tool, { featureId: 'backsupport' });
        if (r.action === 'nudge' && r.hard) tripped = true;
    }
    assert.ok(tripped, 'combined move+rotate trips the hard funnel');
});

t('positioning funnel: soft nudge steers to mate_parts + drive_joint', () => {
    const g = makeOscillationGuard();
    let soft = null;
    for (let i = 0; i < POS_SOFT_LIMIT; i++) soft = g.check('addMove', { componentId: 'c1' });
    assert.equal(soft.action, 'nudge');
    assert.ok(/mate_parts/.test(soft.note) && /drive_joint/.test(soft.note), 'steers to the deterministic path');
});

t('positioning funnel BLOCKS manual move/rotate after the hard limit, but never mate_parts/drive_joint', () => {
    const g = makeOscillationGuard();
    for (let i = 0; i < POS_HARD_LIMIT; i++) g.check('addRotate', { componentId: 'leg' });
    // manual positioning is now blocked for this part…
    assert.equal(g.check('addMove', { componentId: 'leg' }).action, 'block');
    assert.equal(g.check('addRotate', { componentId: 'leg' }).action, 'block');
    // …but the deterministic tools stay open (mate_parts is positioning, never blocked).
    const m = g.check('mate_parts', { partConnectorId: 'leg' });
    assert.notEqual(m.action, 'block');
    assert.equal(g.check('drive_joint', { jointId: 'j_leg' }).action, 'allow');
});

t('positioning funnel is per-part: a different part is unaffected', () => {
    const g = makeOscillationGuard();
    for (let i = 0; i < POS_HARD_LIMIT + 2; i++) g.check('addMove', { componentId: 'leg' });
    assert.equal(g.check('addMove', { componentId: 'arm' }).action, 'allow');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
