/**
 * Checkpoint capture/restore (Phase 4) — coherent cross-store revert.
 *
 * Verifies a checkpoint binds chat position + document head + plan-graph
 * snapshot, and that restoring rolls the document + plan back together while
 * leaving the chat truncation positions for the caller. Uses a fake store so it
 * stays a pure unit test (no kernel, no singletons).
 *
 * Run via:
 *   node --import ./src/lib/commands/__tests__/_register.mjs \
 *        src/lib/ai/__tests__/plan_checkpoints.test.mjs
 */
import assert from 'node:assert/strict';

import { PlanGraph } from '../plan/graph.js';
import { captureCheckpoint, restoreCheckpoint } from '../plan/checkpoints.js';

let _pass = 0, _fail = 0;
async function t(name, fn) {
    try { await fn(); console.log(`  ok  ${name}`); _pass++; }
    catch (e) { console.error(`  FAIL ${name}\n    ${e?.stack || e?.message || e}`); _fail++; }
}

// Minimal stand-in for DocumentStore: just a foldable head pointer.
function fakeStore(head) { return { doc: { head }, setHead(n) { this.doc.head = n; } }; }
const clock = () => { let n = 0; return () => (n += 100); };

console.log('── Checkpoints (cross-store revert) ──');

await t('capture binds chat position + doc head + plan snapshot', () => {
    const store = fakeStore(5);
    const graph = new PlanGraph();
    graph.addNode({ label: 'A' });
    const c = captureCheckpoint({ store, graph, chat: { itemsLen: 3, historyLen: 7 }, label: 'v1', now: clock() });
    assert.equal(c.docHead, 5);
    assert.equal(c.chat.itemsLen, 3);
    assert.equal(c.chat.historyLen, 7);
    assert.ok(c.planSnapshot && c.planSnapshot.nodes.length === 1);
});

await t('restore rolls the document head AND the plan-graph back together', () => {
    const store = fakeStore(5);
    const graph = new PlanGraph();
    graph.addNode({ label: 'A' });
    const c = captureCheckpoint({ store, graph, chat: { itemsLen: 2, historyLen: 4 }, now: clock() });

    // ... time passes: more geometry, more plan nodes
    store.doc.head = 12;
    graph.addNode({ label: 'B' });
    graph.addNode({ label: 'C' });
    assert.equal(graph.allNodes().length, 3);

    const applied = restoreCheckpoint(c, { store, graph });
    assert.deepEqual(applied, { doc: true, plan: true });
    assert.equal(store.doc.head, 5, 'document folded back');
    assert.equal(graph.allNodes().length, 1, 'plan-graph rolled back to the checkpoint');
});

await t('a checkpoint with no plan empties the graph on restore', () => {
    const store = fakeStore(0);
    const graph = new PlanGraph();          // empty at capture
    const c = captureCheckpoint({ store, graph, chat: {}, now: clock() });
    assert.equal(c.planSnapshot, null);
    graph.addNode({ label: 'added later' });
    restoreCheckpoint(c, { store, graph });
    assert.equal(graph.allNodes().length, 0, 'graph emptied to match the pre-plan checkpoint');
});

await t('restore is total: missing store/graph is a no-op, not a throw', () => {
    const c = captureCheckpoint({ store: fakeStore(1), graph: new PlanGraph(), chat: {}, now: clock() });
    assert.deepEqual(restoreCheckpoint(c, {}), { doc: false, plan: false });
    assert.deepEqual(restoreCheckpoint(null, { store: fakeStore(1) }), { doc: false, plan: false });
});

console.log(`\nCheckpoints: ${_pass} passed, ${_fail} failed`);
if (_fail) process.exit(1);
