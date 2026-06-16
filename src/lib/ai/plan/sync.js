/**
 * Plan-graph ⇆ document persistence bridge (pure, testable).
 *
 * The PlanGraph singleton (graph.js) is the live design intent; the document
 * store round-trips an OPAQUE `planGraph` POJO inside `.paraform.json`. This
 * module is the thin, side-effect-light glue between them, kept out of the
 * Svelte runes wrapper so it runs under node:assert.
 *
 *   syncPlanGraphToDoc()   — write the live graph's snapshot into store.doc.planGraph
 *   loadPlanGraphFromDoc() — restore the live graph from store.doc.planGraph
 *
 * Both are total: a missing store / missing graph / corrupt POJO degrades to a
 * no-op rather than throwing, so the AI loop and document load never break on
 * plan-graph state.
 */

import { getDocumentStore } from '../../../../lib/document/index.js';
import { getPlanGraph, setPlanGraph, PlanGraph } from './graph.js';

/** Flush the live plan-graph into the document so the next save captures it. */
export function syncPlanGraphToDoc(store = getDocumentStore()) {
    try {
        if (!store || !store.doc) return false;
        const g = getPlanGraph();
        // Empty graph → don't bloat the doc with an empty planGraph blob.
        if (!g || g.allNodes().length === 0) {
            if (store.doc.planGraph) delete store.doc.planGraph;
            return false;
        }
        store.doc.planGraph = g.snapshot();
        return true;
    } catch { return false; }
}

/** Restore the live plan-graph from the document (called on document load). */
export function loadPlanGraphFromDoc(store = getDocumentStore()) {
    try {
        const pojo = store && store.doc && store.doc.planGraph;
        if (pojo && typeof pojo === 'object') {
            setPlanGraph(PlanGraph.restore(pojo));
            return true;
        }
        // No persisted graph → start clean so a stale prior session can't leak in.
        setPlanGraph(new PlanGraph());
        return false;
    } catch { return false; }
}
