/**
 * Checkpoints — coherent revert across the THREE state stores (Phase 4).
 *
 * A "chat version the user can revert to" is not a chat-only concept: the
 * conversation, the document geometry, and the design intent must roll back
 * together or they drift. A checkpoint binds all three:
 *
 *   { chatItemIndex, docHead, planSnapshot }
 *
 * Reverting truncates the chat (caller's job — it owns the transcript), folds
 * the document back to docHead, and restores the plan-graph snapshot. Captured
 * automatically each turn so "I liked 50% — let me re-prompt from there" works.
 *
 * Pure + total: operates on INJECTED store + graph (no singletons) so it tests
 * under node:assert and can't break the chat loop. Distinct from plan VERSIONS
 * (commit/checkout) — those are user-named design milestones; checkpoints are
 * automatic per-turn revert points.
 *
 *   captureCheckpoint({ store, graph, chatItemIndex, label }) → checkpoint
 *   restoreCheckpoint(checkpoint, { store, graph })           → { doc, plan }
 */

let _seq = 0;

/** Snapshot the bound state into a checkpoint record. `chat` = { itemsLen, historyLen }. */
export function captureCheckpoint({ store, graph, chat = {}, label = '', now = Date.now } = {}) {
    let docHead = -1;
    try { docHead = (store && store.doc && Number.isInteger(store.doc.head)) ? store.doc.head : -1; } catch { docHead = -1; }
    let planSnapshot = null;
    try { planSnapshot = (graph && graph.allNodes().length) ? graph.snapshot() : null; } catch { planSnapshot = null; }
    return {
        id: `ckpt_${++_seq}`,
        label: String(label || `checkpoint ${_seq}`),
        chat: {
            itemsLen: Number.isInteger(chat.itemsLen) ? chat.itemsLen : 0,
            historyLen: Number.isInteger(chat.historyLen) ? chat.historyLen : 0,
        },
        docHead,
        planSnapshot,
        createdAt: now(),
    };
}

/**
 * Restore the document + plan-graph from a checkpoint. The caller truncates the
 * chat transcript to `checkpoint.chatItemIndex` itself. Returns what was applied.
 */
export function restoreCheckpoint(checkpoint, { store, graph } = {}) {
    const out = { doc: false, plan: false };
    if (!checkpoint || typeof checkpoint !== 'object') return out;
    try {
        if (store && typeof store.setHead === 'function' && Number.isInteger(checkpoint.docHead)) {
            store.setHead(checkpoint.docHead);
            out.doc = true;
        }
    } catch { /* leave doc as-is */ }
    try {
        if (graph && typeof graph.restore === 'function') {
            if (checkpoint.planSnapshot) { graph.restore(checkpoint.planSnapshot); out.plan = true; }
            else { graph.reset(); out.plan = true; }   // checkpoint predates any plan → empty it
        }
    } catch { /* leave plan as-is */ }
    return out;
}
