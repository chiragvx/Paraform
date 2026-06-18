/**
 * Plan-Graph foundation tests (Phase 0 of PLAN-deterministic-design.md).
 *
 * Verifies the pure graph module: node CRUD + parent/child wiring, dependency-
 * driven reflow (the camera-swap case), instancing (1 design → N placements),
 * versioning (commit / checkout / diff), the mermaid view, and POJO round-trip
 * persistence with collision-safe id counters. Totality: bad input never throws.
 *
 * Run via:
 *   node --import ./src/lib/commands/__tests__/_register.mjs \
 *        src/lib/ai/__tests__/plan_graph.test.mjs
 */
import assert from 'node:assert/strict';

import { PlanGraph, getPlanGraph, setPlanGraph, NODE_KINDS } from '../plan/graph.js';

let _pass = 0, _fail = 0;
async function t(name, fn) {
    try { await fn(); console.log(`  ok  ${name}`); _pass++; }
    catch (e) { console.error(`  FAIL ${name}\n    ${e?.stack || e?.message || e}`); _fail++; }
}

// A fixed clock so version timestamps are deterministic in tests.
const fixedClock = () => { let n = 1_000; return () => (n += 1000); };

console.log('── Plan-Graph foundation ──');

await t('addNode wires roots and children; ids are deterministic counters', () => {
    const g = new PlanGraph();
    const body = g.addNode({ kind: 'assembly', label: 'Body' });
    const leg = g.addNode({ kind: 'subassembly', label: 'Leg', parentId: body });
    assert.equal(body, 'n1');
    assert.equal(leg, 'n2');
    assert.deepEqual(g.rootIds, ['n1']);
    assert.deepEqual(g.getNode(body).children, ['n2']);
    assert.equal(g.getNode(leg).parentId, 'n1');
});

await t('malformed input never throws and is coerced to a well-formed node', () => {
    const g = new PlanGraph();
    const id = g.addNode({ kind: 'nonsense', cls: 'bogus', status: 'weird' });
    const n = g.getNode(id);
    assert.ok(NODE_KINDS.includes(n.kind));      // defaulted to 'part'
    assert.equal(n.cls, 'unknown');
    assert.equal(n.status, 'pending');
    // total ops: bad ids return falsey, no throw
    assert.equal(g.editNodeSpec('does-not-exist', { x: 1 }), false);
    assert.equal(g.setClass('nope', 'buy'), false);
    assert.equal(g.checkout('v999'), false);
});

await t('editNodeSpec marks the node AND transitive dependents stale (reflow)', () => {
    const g = new PlanGraph();
    const cam = g.addNode({ label: 'Camera', cls: 'buy' });
    const mount = g.addNode({ label: 'Camera mount', cls: 'fabricate' });
    const cutout = g.addNode({ label: 'Shell cutout', cls: 'fabricate' });
    g.addDep(mount, cam);        // mount depends on camera
    g.addDep(cutout, mount);     // cutout depends on mount (transitive on camera)

    g.editNodeSpec(cam, { partRef: 'cam-123', size: [50, 50] });
    const stale = g.staleNodes().map((n) => n.id).sort();
    assert.deepEqual(stale, [cam, mount, cutout].sort(), 'camera + mount + cutout all reflow');
});

await t('replacePart swaps a COTS part and reflows dependents (camera v1→v2)', () => {
    const g = new PlanGraph();
    const cam = g.addNode({ label: 'Camera', cls: 'buy', spec: { partRef: 'cam-xyz', size: [10, 20] } });
    const mount = g.addNode({ label: 'Mount', cls: 'fabricate' });
    g.addDep(mount, cam);
    g.replacePart(cam, { partRef: 'cam-123', spec: { size: [50, 50] }, cls: 'buy' });
    assert.equal(g.getNode(cam).spec.partRef, 'cam-123');
    assert.deepEqual(g.getNode(cam).spec.size, [50, 50]);
    assert.ok(g.getNode(mount).stale, 'the mount reflows after the camera swap');
});

await t('instance creates N placements referencing one design, with chirality', () => {
    const g = new PlanGraph();
    const leg = g.addNode({ kind: 'subassembly', label: 'Leg' });
    const ids = g.instance(leg, { count: 4, chirality: ['left', 'right', 'left', 'right'] });
    assert.equal(ids.length, 4);
    const insts = ids.map((id) => g.getNode(id));
    assert.ok(insts.every((n) => n.kind === 'instance' && n.instanceOf === leg));
    assert.ok(insts.every((n) => n.deps.includes(leg)), 'instances reflow when the design changes');
    assert.deepEqual(insts.map((n) => n.chirality), ['left', 'right', 'left', 'right']);
    // changing the source design reflows all instances
    g.editNodeSpec(leg, { len: 130 });
    assert.equal(g.staleNodes().length, 1 + 4);
});

await t('commit / checkout restores a prior working draft', () => {
    const g = new PlanGraph({ now: fixedClock() });
    const a = g.addNode({ label: 'A' });
    const v1 = g.commit('v1');
    g.addNode({ label: 'B' });
    assert.equal(g.allNodes().length, 2);
    g.checkout(v1);
    assert.equal(g.allNodes().length, 1, 'B is gone after checking out v1');
    assert.ok(g.has(a));
    assert.equal(g.currentVersionId, v1);
});

await t('diff reports added / removed / changed (the spec-change view)', () => {
    const g = new PlanGraph({ now: fixedClock() });
    const cam = g.addNode({ label: 'Camera', cls: 'buy', spec: { partRef: 'cam-xyz' } });
    const v1 = g.commit('v1');
    g.editNodeSpec(cam, { partRef: 'cam-123' });
    g.addNode({ label: 'New strut' });
    const v2 = g.commit('v2');
    const d = g.diff(v1, v2);
    assert.equal(d.added.length, 1);
    assert.equal(d.removed.length, 0);
    assert.equal(d.changed.length, 1);
    assert.equal(d.changed[0].id, cam);
    assert.ok(d.changed[0].fields.spec, 'the camera spec change shows in the diff');
});

await t('toMermaid renders a graph TD view with class styling', () => {
    const g = new PlanGraph();
    const body = g.addNode({ kind: 'assembly', label: 'Body', cls: 'fabricate' });
    g.addNode({ label: 'Servo', cls: 'buy', parentId: body });
    const m = g.toMermaid();
    assert.match(m, /^graph TD/);
    assert.match(m, /Body/);
    assert.match(m, /Servo \[buy\]/);
    assert.match(m, /classDef buy/);
});

await t('snapshot / restore round-trips and keeps id counters collision-safe', () => {
    const g = new PlanGraph({ now: fixedClock() });
    g.addNode({ label: 'A' });
    g.addNode({ label: 'B' });
    g.commit('v1');
    const pojo = JSON.parse(JSON.stringify(g.snapshot()));   // simulate disk round-trip
    const g2 = PlanGraph.restore(pojo);
    assert.equal(g2.allNodes().length, 2);
    assert.equal(g2.listVersions().length, 1);
    // a new node must not collide with restored ids
    const fresh = g2.addNode({ label: 'C' });
    assert.ok(!['n1', 'n2'].includes(fresh), `new id ${fresh} should be past the restored max`);
});

await t('getPlanGraph singleton is replaceable via setPlanGraph', () => {
    const custom = new PlanGraph();
    custom.addNode({ label: 'only' });
    setPlanGraph(custom);
    assert.equal(getPlanGraph().allNodes().length, 1);
    setPlanGraph(new PlanGraph());   // reset for any later suite sharing the process
});

await t('approval gate: approve sets it, a structural edit revokes it, status edits do not', () => {
    const g = new PlanGraph({ now: fixedClock() });
    const root = g.addNode({ kind: 'assembly', label: 'Laptop stand' });
    const base = g.addNode({ kind: 'part', label: 'Base', parentId: root });
    assert.equal(g.isApproved(), false, 'a fresh plan is not approved');

    const v = g.approve();
    assert.ok(v, 'approve commits a revert-point version');
    assert.equal(g.isApproved(), true);

    // Build-status changes during the build must NOT revoke approval.
    g.setStatus(base, 'building');
    g.setStatus(base, 'verified');
    g.setBinding(base, { featureIds: ['f1'] });
    assert.equal(g.isApproved(), true, 'building the plan keeps it approved');

    // A steer (spec edit / new part / removal) revokes approval → re-approve.
    g.editNodeSpec(base, { sizeBand: 'large' });
    assert.equal(g.isApproved(), false, 'a spec edit revokes approval');

    g.approve();
    g.addNode({ kind: 'part', label: 'Feet', parentId: root });
    assert.equal(g.isApproved(), false, 'adding a part revokes approval');
});

await t('approval survives snapshot/restore round-trip', () => {
    const g = new PlanGraph({ now: fixedClock() });
    g.addNode({ kind: 'assembly', label: 'Stand' });
    g.approve();
    const restored = PlanGraph.restore(g.snapshot());
    assert.equal(restored.isApproved(), true);
    assert.equal(restored.approvedAt, g.approvedAt);
});

console.log(`\nPlan-Graph: ${_pass} passed, ${_fail} failed`);
if (_fail) process.exit(1);
