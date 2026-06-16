/**
 * Plan-graph persistence round-trip (Phase 0 wiring).
 *
 * Proves the design intent survives a `.paraform.json` save/load: graph →
 * syncPlanGraphToDoc → store.toJSON → new store.fromJSON → loadPlanGraphFromDoc
 * → identical graph. Uses LOCAL DocumentStore instances (not the singleton) so
 * it is safe to interleave in the aggregate runner, and injects the plan-graph
 * singleton via setPlanGraph.
 *
 * Run via:
 *   node --import ./src/lib/commands/__tests__/_register.mjs \
 *        src/lib/ai/__tests__/plan_persist.test.mjs
 */
import assert from 'node:assert/strict';

import { DocumentStore } from '../../../../lib/document/index.js';
import { PlanGraph, getPlanGraph, setPlanGraph } from '../plan/graph.js';
import { syncPlanGraphToDoc, loadPlanGraphFromDoc } from '../plan/sync.js';

let _pass = 0, _fail = 0;
async function t(name, fn) {
    try { await fn(); console.log(`  ok  ${name}`); _pass++; }
    catch (e) { console.error(`  FAIL ${name}\n    ${e?.stack || e?.message || e}`); _fail++; }
}

console.log('── Plan-Graph persistence round-trip ──');

await t('graph survives toJSON → fromJSON via the opaque planGraph POJO', () => {
    const g = new PlanGraph();
    setPlanGraph(g);
    const body = g.addNode({ kind: 'assembly', label: 'Body', cls: 'fabricate' });
    const leg = g.addNode({ kind: 'subassembly', label: 'Leg', parentId: body });
    g.instance(leg, { count: 4, chirality: ['left', 'right', 'left', 'right'] });
    g.commit('v1');

    const src = new DocumentStore();
    assert.equal(syncPlanGraphToDoc(src), true);
    const json = JSON.parse(JSON.stringify(src.toJSON()));   // simulate disk
    assert.ok(json.planGraph, 'toJSON carries the planGraph blob');

    // Fresh store + fresh (empty) graph, then load.
    const dst = new DocumentStore();
    dst.fromJSON(json);
    setPlanGraph(new PlanGraph());
    assert.equal(getPlanGraph().allNodes().length, 0, 'graph is empty before load');
    assert.equal(loadPlanGraphFromDoc(dst), true);

    const g2 = getPlanGraph();
    assert.equal(g2.allNodes().length, 6, 'body + leg + 4 instances restored');
    assert.equal(g2.listVersions().length, 1, 'version history restored');
    // collision-safe: a new node id must not clash with any restored id
    const idsBefore = new Set(g2.allNodes().map((n) => n.id));
    const fresh = g2.addNode({ label: 'extra' });
    assert.ok(!idsBefore.has(fresh), `new id ${fresh} must not collide with restored ids`);

    setPlanGraph(new PlanGraph());   // cleanup for interleaving
});

await t('empty graph does not bloat the document', () => {
    setPlanGraph(new PlanGraph());
    const store = new DocumentStore();
    assert.equal(syncPlanGraphToDoc(store), false);
    assert.equal(store.toJSON().planGraph, undefined, 'no empty planGraph key');
});

await t('load is total: missing/corrupt planGraph yields a clean empty graph', () => {
    setPlanGraph(new PlanGraph());
    getPlanGraph().addNode({ label: 'stale-from-prior-session' });
    const store = new DocumentStore();          // no planGraph
    assert.equal(loadPlanGraphFromDoc(store), false);
    assert.equal(getPlanGraph().allNodes().length, 0, 'prior session state cleared');
    setPlanGraph(new PlanGraph());
});

console.log(`\nPlan-Graph persistence: ${_pass} passed, ${_fail} failed`);
if (_fail) process.exit(1);
