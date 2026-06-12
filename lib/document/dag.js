/**
 * DAG — dependency-graph operations over a Document.
 *
 * Dependencies are encoded in feature.inputs[role] = Ref. Each Ref that points
 * to another feature becomes a directed edge in the DAG.
 *
 * Operations:
 *   - edges(doc)         — enumerate {from, to, role} edges
 *   - dependentsOf(doc)  — reverse adjacency map: feature → features that consume it
 *   - dependenciesOf(doc)— forward adjacency map: feature → features it consumes
 *   - topoOrder(doc)     — Kahn's algorithm; cycle-safe, returns null on cycle
 *   - parallelGroups(doc)— levels of the DAG; features in one group can run concurrently
 *   - downstream(doc, id)— transitive closure: every feature that depends on `id`
 *   - upstream(doc, id)  — transitive closure: every feature `id` depends on
 *
 * All operations skip disabled features (treated as if removed for execution
 * purposes — but they remain in the document model so re-enabling is cheap).
 */

import { refFeatureId } from './types.js';

/**
 * Enumerate every directed dependency edge in the document.
 * @param {Document} doc
 * @returns {Array<{from: string, to: string, role: string}>}
 *          from = upstream feature id (the producer)
 *          to   = downstream feature id (the consumer)
 *          role = the input role name on the consumer
 */
export function edges(doc) {
    const out = [];
    for (const f of Object.values(doc.features)) {
        if (!f.enabled) continue;
        for (const [role, ref] of Object.entries(f.inputs || {})) {
            const refs = Array.isArray(ref) ? ref : [ref];
            for (const r of refs) {
                const upstream = refFeatureId(r);
                if (upstream && doc.features[upstream] && doc.features[upstream].enabled) {
                    out.push({ from: upstream, to: f.id, role });
                }
            }
        }
    }
    return out;
}

/**
 * Build forward adjacency: feature id → array of upstream feature ids it consumes.
 * @returns {Map<string, Set<string>>}
 */
export function dependenciesOf(doc) {
    const map = new Map();
    for (const id of Object.keys(doc.features)) map.set(id, new Set());
    for (const { from, to } of edges(doc)) {
        map.get(to).add(from);
    }
    return map;
}

/**
 * Build reverse adjacency: feature id → array of downstream consumers.
 * @returns {Map<string, Set<string>>}
 */
export function dependentsOf(doc) {
    const map = new Map();
    for (const id of Object.keys(doc.features)) map.set(id, new Set());
    for (const { from, to } of edges(doc)) {
        map.get(from).add(to);
    }
    return map;
}

/**
 * Topological order via Kahn's algorithm. Stable: ties are broken by the
 * authored UI order so the result is deterministic across runs.
 *
 * @param {Document} doc
 * @returns {string[]|null} feature ids in eval order, or null on cycle
 */
export function topoOrder(doc) {
    const deps = dependenciesOf(doc);
    const inDeg = new Map();
    for (const [id, set] of deps) inDeg.set(id, set.size);

    // Stable ready queue: prefer features earlier in featureOrder
    const orderIndex = new Map(doc.featureOrder.map((id, i) => [id, i]));
    const cmp = (a, b) => (orderIndex.get(a) ?? 1e9) - (orderIndex.get(b) ?? 1e9);

    /** @type {string[]} */ const ready = [];
    for (const [id, d] of inDeg) {
        if (d === 0 && doc.features[id].enabled) ready.push(id);
    }
    ready.sort(cmp);

    const out = [];
    const dependents = dependentsOf(doc);
    while (ready.length) {
        const id = ready.shift();
        out.push(id);
        for (const downId of dependents.get(id)) {
            const nd = inDeg.get(downId) - 1;
            inDeg.set(downId, nd);
            if (nd === 0 && doc.features[downId].enabled) {
                // insert sorted to preserve stable order
                const pos = lowerBound(ready, downId, cmp);
                ready.splice(pos, 0, downId);
            }
        }
    }

    // Cycle check: any enabled feature still has unsatisfied deps
    for (const [id, d] of inDeg) {
        if (d > 0 && doc.features[id].enabled) return null;
    }
    return out;
}

function lowerBound(arr, target, cmp) {
    let lo = 0, hi = arr.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cmp(arr[mid], target) < 0) lo = mid + 1; else hi = mid;
    }
    return lo;
}

/**
 * Parallel groups — the topological layering. All features in `groups[i]`
 * have all their dependencies satisfied by features in `groups[0..i-1]`,
 * which means they can be evaluated concurrently on the worker pool.
 *
 * @param {Document} doc
 * @returns {string[][]|null} array of groups; null on cycle
 */
export function parallelGroups(doc) {
    const deps = dependenciesOf(doc);
    const inDeg = new Map();
    for (const [id, set] of deps) inDeg.set(id, set.size);
    const dependents = dependentsOf(doc);

    const orderIndex = new Map(doc.featureOrder.map((id, i) => [id, i]));
    const stableSort = (arr) => arr.sort(
        (a, b) => (orderIndex.get(a) ?? 1e9) - (orderIndex.get(b) ?? 1e9),
    );

    /** @type {string[][]} */ const groups = [];
    let layer = [];
    for (const [id, d] of inDeg) {
        if (d === 0 && doc.features[id].enabled) layer.push(id);
    }
    stableSort(layer);

    let processed = 0;
    while (layer.length) {
        groups.push(layer);
        processed += layer.length;
        const next = [];
        for (const id of layer) {
            for (const downId of dependents.get(id)) {
                const nd = inDeg.get(downId) - 1;
                inDeg.set(downId, nd);
                if (nd === 0 && doc.features[downId].enabled) next.push(downId);
            }
        }
        stableSort(next);
        layer = next;
    }

    // Cycle check
    const enabledCount = Object.values(doc.features).filter(f => f.enabled).length;
    if (processed !== enabledCount) return null;
    return groups;
}

/**
 * Transitive downstream — every feature that (directly or indirectly) depends
 * on `featureId`. Used to compute the regen set after a parameter change.
 *
 * @param {Document} doc
 * @param {string} featureId
 * @returns {Set<string>} excludes `featureId` itself
 */
export function downstream(doc, featureId) {
    const dependents = dependentsOf(doc);
    const seen = new Set();
    const stack = [featureId];
    while (stack.length) {
        const id = stack.pop();
        const ds = dependents.get(id);
        if (!ds) continue;
        for (const d of ds) {
            if (!seen.has(d)) { seen.add(d); stack.push(d); }
        }
    }
    return seen;
}

/**
 * Transitive upstream — every feature that `featureId` (directly or indirectly)
 * depends on. Used to compute what must be evaluated before a target.
 *
 * @param {Document} doc
 * @param {string} featureId
 * @returns {Set<string>} excludes `featureId` itself
 */
export function upstream(doc, featureId) {
    const deps = dependenciesOf(doc);
    const seen = new Set();
    const stack = [featureId];
    while (stack.length) {
        const id = stack.pop();
        const ups = deps.get(id);
        if (!ups) continue;
        for (const u of ups) {
            if (!seen.has(u)) { seen.add(u); stack.push(u); }
        }
    }
    return seen;
}

/**
 * Detect cycles. Returns the set of feature ids that participate in any cycle,
 * or an empty set if the graph is acyclic.
 * @param {Document} doc
 * @returns {Set<string>}
 */
export function cycles(doc) {
    const cycleSet = new Set();
    const deps = dependenciesOf(doc);
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map();
    for (const id of Object.keys(doc.features)) color.set(id, WHITE);

    function dfs(id) {
        color.set(id, GRAY);
        for (const up of deps.get(id) || []) {
            const c = color.get(up);
            if (c === GRAY) { cycleSet.add(up); cycleSet.add(id); }
            else if (c === WHITE && dfs(up)) { cycleSet.add(id); }
        }
        color.set(id, BLACK);
        return cycleSet.has(id);
    }

    for (const id of Object.keys(doc.features)) {
        if (color.get(id) === WHITE) dfs(id);
    }
    return cycleSet;
}
