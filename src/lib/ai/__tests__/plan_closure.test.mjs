/**
 * Decomposition seeder + physics closure pass (Phases 1–2).
 *
 * Verifies the quadruped template seeds a sane graph (body + electronics + one
 * parametric leg instanced ×4), that closure CLOSES the default design, counts
 * instance mass 4× (not 1× + weightless references), and — the money shot — that
 * pushing a joint past its actuator's torque FAILS closure with a deterministic
 * servo-step suggestion. Pure modules, no kernel, no singleton.
 *
 * Run via:
 *   node --import ./src/lib/commands/__tests__/_register.mjs \
 *        src/lib/ai/__tests__/plan_closure.test.mjs
 */
import assert from 'node:assert/strict';

import { PlanGraph } from '../plan/graph.js';
import { seedPlanGraph } from '../plan/decompose.js';
import { runClosureCheck } from '../plan/closure.js';

let _pass = 0, _fail = 0;
async function t(name, fn) {
    try { await fn(); console.log(`  ok  ${name}`); _pass++; }
    catch (e) { console.error(`  FAIL ${name}\n    ${e?.stack || e?.message || e}`); _fail++; }
}

console.log('── Decomposition + closure ──');

await t('seedPlanGraph("robot dog") builds the quadruped template, 4 leg instances', () => {
    const g = new PlanGraph();
    const r = seedPlanGraph(g, 'robot dog');
    assert.equal(r.archetype, 'quadruped');
    assert.equal(r.legInstances, 4);
    assert.equal(g.listVersions().length, 1, 'seed committed v1');
    const insts = g.allNodes().filter((n) => n.kind === 'instance');
    assert.equal(insts.length, 4);
    assert.deepEqual(insts.map((n) => n.chirality), ['left', 'right', 'left', 'right']);
});

await t('seeding is deterministic (same goal → byte-identical structure)', () => {
    const a = new PlanGraph(); seedPlanGraph(a, 'robot dog');
    const b = new PlanGraph(); seedPlanGraph(b, 'robot dog');
    assert.equal(JSON.stringify(a._draftSnapshot()), JSON.stringify(b._draftSnapshot()));
});

await t('closure CLOSES the default quadruped (no errors) and counts mass 4×', () => {
    const g = new PlanGraph();
    seedPlanGraph(g, 'robot dog');
    const res = runClosureCheck(g, { targetMassG: 2500 });
    assert.equal(res.ok, true, `default design should close: ${JSON.stringify(res.issues)}`);
    // 4 legs × (3 servos 170g + femur40 + tibia40 + foot8 = 258g) + body 470g ≈ 1502g
    assert.ok(res.totalMassG > 1400 && res.totalMassG < 1600, `mass ${res.totalMassG}g should reflect 4 legs`);
    const torque = res.checks.filter((c) => c.check === 'joint-torque');
    assert.equal(torque.length, 3, 'three joint-torque checks (per leg design)');
    assert.ok(torque.every((c) => c.ok));
});

await t('overloading the knee FAILS closure with a servo-step suggestion', () => {
    const g = new PlanGraph();
    seedPlanGraph(g, 'robot dog');
    const knee = g.allNodes().find((n) => n.label === 'Knee flex');
    assert.ok(knee, 'knee joint exists');
    // Crank the required torque well past the DS3218 ceiling (20 kg·cm).
    g.editNodeSpec(knee.id, { jointTorqueNmm: 4000 });   // ~40.8 kg·cm × 1.5 = 61 kg·cm
    const res = runClosureCheck(g);
    assert.equal(res.ok, false, 'an over-loaded knee must fail closure');
    const issue = res.issues.find((i) => i.check === 'joint-torque' && i.nodeId === knee.id);
    assert.ok(issue, 'the knee raises a torque issue');
    assert.match(issue.message, /kg·cm/);
});

await t('a holdable bump suggests the smallest sufficient rung', () => {
    const g = new PlanGraph();
    seedPlanGraph(g, 'robot dog');
    const hip = g.allNodes().find((n) => n.label === 'Hip flex');
    // Bump hip-flex past MG996R (10) but within DS3218 (20): need ~12 kg·cm.
    g.editNodeSpec(hip.id, { jointTorqueNmm: 800, actuator: 'MG996R' });  // 8.16×1.5 = 12.2 > 10
    const res = runClosureCheck(g);
    const check = res.checks.find((c) => c.check === 'joint-torque' && c.nodeId === hip.id);
    assert.equal(check.ok, false);
    assert.equal(check.suggestedActuator, 'DS3218', 'suggests the next rung that holds');
});

await t('generic fallback for an unknown archetype', () => {
    const g = new PlanGraph();
    const r = seedPlanGraph(g, 'a decorative vase');
    assert.notEqual(r.archetype, 'quadruped');
    assert.ok(g.allNodes().length >= 1);
});

console.log(`\nDecomposition + closure: ${_pass} passed, ${_fail} failed`);
if (_fail) process.exit(1);
