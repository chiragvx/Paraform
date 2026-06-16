/**
 * Plan-graph tools through dispatchTool (Phase 1–2 integration).
 *
 * Drives the model-facing surface end-to-end: the plan tools are registered in
 * AGENT_TOOLS, propose_plan_graph seeds a quadruped, run_closure_check closes
 * it, plan_bom expands instances to real quantities (12 servos for 4 legs), and
 * plan_replace_part reflows. Uses the singletons (as the agent does) and cleans
 * up after itself so the aggregate runner stays isolated.
 *
 * Run via:
 *   node --import ./src/lib/commands/__tests__/_register.mjs \
 *        src/lib/ai/__tests__/plan_tools.test.mjs
 */
import assert from 'node:assert/strict';

import { AGENT_TOOLS, dispatchTool } from '../tools.js';
import { getPlanGraph, setPlanGraph, PlanGraph } from '../plan/graph.js';

let _pass = 0, _fail = 0;
async function t(name, fn) {
    try { await fn(); console.log(`  ok  ${name}`); _pass++; }
    catch (e) { console.error(`  FAIL ${name}\n    ${e?.stack || e?.message || e}`); _fail++; }
}

console.log('── Plan-graph tools (dispatchTool) ──');

await t('plan tools are registered in AGENT_TOOLS', () => {
    const names = new Set(AGENT_TOOLS.map((t) => t.name));
    for (const n of ['get_plan_graph', 'propose_plan_graph', 'plan_split_node', 'plan_instance', 'run_closure_check', 'plan_bom', 'plan_replace_part', 'plan_commit', 'plan_diff']) {
        assert.ok(names.has(n), `AGENT_TOOLS missing ${n}`);
    }
});

await t('propose_plan_graph seeds a quadruped with a mermaid map', async () => {
    setPlanGraph(new PlanGraph());
    const r = await dispatchTool('propose_plan_graph', { goal: 'robot dog' });
    assert.equal(r.ok, true);
    assert.equal(r.archetype, 'quadruped');
    assert.match(r.mermaid, /^graph TD/);
    assert.ok(r.nodes.length > 15);
});

await t('run_closure_check closes the seeded design', async () => {
    const r = await dispatchTool('run_closure_check', { targetMassG: 2500 });
    assert.equal(r.ok, true);
    assert.ok(r.totalMassG > 1400, `mass ${r.totalMassG}`);
    assert.ok(r.checks.some((c) => c.check === 'joint-torque'));
});

await t('plan_bom expands instances: 12 servos for 4 legs', async () => {
    const r = await dispatchTool('plan_bom', {});
    assert.equal(r.ok, true);
    const servoQty = r.buy.filter((x) => /servo$/i.test(x.label)).reduce((s, x) => s + x.qty, 0);
    assert.equal(servoQty, 12, `expected 12 servos, got ${servoQty}`);
    const shell = r.fabricate.find((x) => /shell/i.test(x.label));
    assert.ok(shell && shell.qty === 1, 'one body shell');
    const bracket = r.fabricate.find((x) => /bracket/i.test(x.label));
    assert.ok(bracket && bracket.qty === 4, 'each bracket ×4 legs');
});

await t('plan_replace_part swaps a servo and reflows its bracket', async () => {
    const g = getPlanGraph();
    const kneeServo = g.allNodes().find((n) => /DS3218 servo/.test(n.label));
    assert.ok(kneeServo, 'knee servo node exists');
    const r = await dispatchTool('plan_replace_part', { nodeId: kneeServo.id, partRef: 'MG996R' });
    assert.equal(r.ok, true);
    assert.ok(Array.isArray(r.stale) && r.stale.length >= 1, 'reflow marked something stale');
});

await t('plan_commit + plan_diff report the spec change', async () => {
    const g = getPlanGraph();
    const v = await dispatchTool('plan_commit', { label: 'after servo swap' });
    assert.equal(v.ok, true);
    const versions = g.listVersions();
    assert.ok(versions.length >= 2, 'seed v1 + this commit');
    const d = await dispatchTool('plan_diff', { fromVersion: versions[0].id, toVersion: v.versionId });
    assert.equal(d.ok, true);
    assert.ok(d.diff.changed.length >= 1, 'the servo swap shows in the diff');
});

// Cleanup so the singletons don't leak into other suites.
setPlanGraph(new PlanGraph());
try { const { getDocumentStore } = await import('../../../../lib/document/index.js'); const s = getDocumentStore(); if (s && s.doc) delete s.doc.planGraph; } catch { /* */ }

console.log(`\nPlan-graph tools: ${_pass} passed, ${_fail} failed`);
if (_fail) process.exit(1);
