/**
 * Plan-graph reactive store (Phase 3) — the thin Svelte-runes view over the
 * pure PlanGraph singleton (graph.js). The graph mutates outside Svelte (via the
 * plan_* tool handlers during an AI turn); this store snapshots it into reactive
 * state the PlanMap panel renders. Call refreshPlan() after a turn (ChatPanel
 * does this when the transcript changes) or from the panel's manual refresh.
 *
 *   planState        — reactive { nodes, rootIds, versions, currentVersion, stale, mermaid, closure }
 *   refreshPlan()    — re-snapshot the live graph into planState
 *   runPlanClosure() — run the physics closure pass and stash the result
 */

import { getPlanGraph } from './graph.js';
import { runClosureCheck } from './closure.js';

export const planState = $state({
    nodeCount: 0,
    nodes: [],
    rootIds: [],
    versions: [],
    currentVersion: null,
    stale: [],
    mermaid: '',
    closure: null,        // last closure result, or null
});

function compact(n) {
    return {
        id: n.id, kind: n.kind, label: n.label, cls: n.cls, status: n.status,
        parentId: n.parentId, children: n.children,
        instanceOf: n.instanceOf || null, chirality: n.chirality || null,
        stale: !!n.stale,
        role: n.spec?.role || null,
        partRef: n.spec?.partRef || null,
        recipe: n.binding?.recipe || null,
    };
}

/**
 * Re-snapshot the live plan-graph into reactive state. Computes everything into
 * LOCALS first and only WRITES planState — it never READS planState — so calling
 * it from an $effect can't create a read-write feedback loop.
 */
export function refreshPlan() {
    try {
        const g = getPlanGraph();
        const nodes = g.allNodes().map(compact);
        planState.nodes = nodes;
        planState.nodeCount = nodes.length;
        planState.rootIds = [...g.rootIds];
        planState.versions = g.listVersions();
        planState.currentVersion = g.currentVersionId;
        planState.stale = g.staleNodes().map((n) => n.id);
        planState.mermaid = g.toMermaid();
    } catch { /* leave last good state */ }
}

/** Run the physics closure pass and store the result for the panel. */
export function runPlanClosure(opts = {}) {
    try {
        planState.closure = runClosureCheck(getPlanGraph(), opts);
    } catch { planState.closure = null; }
    return planState.closure;
}
