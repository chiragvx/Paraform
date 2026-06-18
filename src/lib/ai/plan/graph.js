/**
 * Plan-Graph — the source of truth for AI-driven design intent.
 *
 * A prompt like "robot dog" becomes a structured, versioned graph of nodes
 * (assembly / subassembly / part / instance) ABOVE the geometry. The mermaid
 * map renders this graph; user edits mutate it through the structured ops here;
 * the build executor walks it; checkpoints reference its version ids so the
 * conversation, the document, and the design intent stay coherent.
 *
 * Design goals (built for scalability from day one):
 *   - PURE DATA. No Svelte, no DOM, no THREE — testable under node:assert like
 *     context.js / planner.js. The reactive store (plan_store.svelte.js) wraps
 *     this; persistence rides as an opaque POJO inside the document JSON.
 *   - TOTAL. Every op is defensive — a malformed call from a weak model yields
 *     false / null, never a throw, so the agent loop can never break on it.
 *   - DETERMINISTIC STRUCTURE. Ids are sequence counters (n1, n2, v1 …), never
 *     random; the wall clock is injectable so tests are byte-stable.
 *   - VERSIONED. commit() snapshots the working draft into an immutable version;
 *     checkout() restores one; diff() powers the "v1 → v2" change view.
 *   - REFLOW-AWARE. Nodes declare `deps`; editing a node's spec marks its
 *     dependents stale (the camera-swap case) so only affected parts rebuild.
 *
 *   getPlanGraph()                         → process-local singleton
 *   g.addNode({...})                       → id
 *   g.editNodeSpec(id, specPatch)          → marks dependents stale
 *   g.replacePart(id, { partRef, spec })   → swap a COTS/reuse part + reflow
 *   g.instance(sourceId, { count, … })     → N placements of one design
 *   g.commit(label) / g.checkout(versionId)→ version history
 *   g.diff(vA, vB)                         → structured change set
 *   g.toMermaid()                          → view string for the chat map
 *   g.snapshot() / PlanGraph.restore(pojo) → persistence
 */

// ── constants ────────────────────────────────────────────────────────────────

export const NODE_KINDS = Object.freeze(['assembly', 'subassembly', 'part', 'instance']);
export const PART_CLASSES = Object.freeze(['buy', 'reuse', 'fabricate', 'unknown']);
export const NODE_STATUS = Object.freeze(['pending', 'building', 'verified', 'blocked']);

// ── small total helpers ──────────────────────────────────────────────────────

const isStr = (s) => typeof s === 'string' && s.length > 0;
const isObj = (o) => o && typeof o === 'object' && !Array.isArray(o);
const arr = (x) => (Array.isArray(x) ? x : []);

/** Deep clone a plain-data value. structuredClone when available, else JSON. */
function clone(v) {
    if (v === null || typeof v !== 'object') return v;
    try { return structuredClone(v); } catch { /* fall through */ }
    try { return JSON.parse(JSON.stringify(v)); } catch { return v; }
}

/** A blank, well-formed node. Callers patch fields through the ops, never raw. */
function makeNode(partial = {}) {
    const p = isObj(partial) ? partial : {};
    const kind = NODE_KINDS.includes(p.kind) ? p.kind : 'part';
    const cls = PART_CLASSES.includes(p.cls) ? p.cls : 'unknown';
    const status = NODE_STATUS.includes(p.status) ? p.status : 'pending';
    return {
        id: isStr(p.id) ? p.id : '',           // assigned by addNode
        kind,
        label: isStr(p.label) ? p.label : (isStr(p.id) ? p.id : kind),
        cls,
        spec: isObj(p.spec) ? clone(p.spec) : {
            role: null, interface: [], load: null, sizeBand: null, partRef: null,
        },
        binding: isObj(p.binding) ? clone(p.binding) : {
            recipe: null, params: {}, featureIds: [],
        },
        instanceOf: isStr(p.instanceOf) ? p.instanceOf : null,
        chirality: (p.chirality === 'left' || p.chirality === 'right') ? p.chirality : null,
        accept: arr(p.accept).map(clone),
        status,
        deps: arr(p.deps).filter(isStr),
        parentId: isStr(p.parentId) ? p.parentId : null,
        children: arr(p.children).filter(isStr),
        stale: !!p.stale,
        meta: isObj(p.meta) ? clone(p.meta) : {},   // extensibility escape hatch
    };
}

// ── the graph ────────────────────────────────────────────────────────────────

export class PlanGraph {
    /** @param {{ now?: () => number }} [opts] injectable clock for deterministic tests */
    constructor(opts = {}) {
        this._now = (opts && typeof opts.now === 'function') ? opts.now : () => Date.now();
        this.reset();
    }

    reset() {
        /** id → node (the working draft) */
        this.nodes = new Map();
        /** ordered top-level node ids */
        this.rootIds = [];
        /** immutable committed versions: [{ id, label, parentId, createdAt, snapshot }] */
        this.versions = [];
        this.currentVersionId = null;
        this._nodeSeq = 0;
        this._verSeq = 0;
        /**
         * Approval gate (clarify→plan→APPROVE→build). The user approves the plan
         * in the UI; the AI reads this (via get_plan_graph) and must not build
         * geometry until it is true. Any STRUCTURAL change (new node, spec edit,
         * part swap, removal → markStale / addNode / removeNode) revokes approval,
         * so a steered plan must be re-approved. Build-status changes
         * (pending→building→verified via setStatus) do NOT revoke it.
         */
        this.approved = false;
        this.approvedAt = 0;
    }

    /** Revoke approval — called by every structural mutation (a steer). */
    _revokeApproval() { this.approved = false; this.approvedAt = 0; }

    /**
     * Mark the current plan APPROVED for build and commit it as a revert point.
     * The user drives this from the plan map; the AI never approves on their
     * behalf. Returns the committed version id.
     */
    approve(label = 'approved ✓') {
        this.approved = true;
        this.approvedAt = this._now();
        return this.commit(label);
    }

    isApproved() { return !!this.approved; }

    // ── node CRUD ──────────────────────────────────────────────────────────────

    /**
     * Add a node to the working draft. Returns the new id, or null on bad input.
     * Wires parent/child links; a node with no (valid) parent becomes a root.
     */
    addNode(partial = {}) {
        const node = makeNode(partial);
        node.id = `n${++this._nodeSeq}`;
        const parent = isStr(partial?.parentId) ? this.nodes.get(partial.parentId) : null;
        node.parentId = parent ? parent.id : null;
        node.children = [];                       // children are wired by their own addNode
        this.nodes.set(node.id, node);
        if (parent) { if (!parent.children.includes(node.id)) parent.children.push(node.id); }
        else this.rootIds.push(node.id);
        this._revokeApproval();   // adding a part changes the plan → re-approval needed
        return node.id;
    }

    getNode(id) { return this.nodes.get(id) || null; }
    has(id) { return this.nodes.has(id); }
    allNodes() { return [...this.nodes.values()]; }

    /** Shallow-merge a patch onto a node (guarded to the known fields). */
    updateNode(id, patch) {
        const n = this.nodes.get(id);
        if (!n || !isObj(patch)) return false;
        if (isStr(patch.label)) n.label = patch.label;
        if (NODE_KINDS.includes(patch.kind)) n.kind = patch.kind;
        if (PART_CLASSES.includes(patch.cls)) n.cls = patch.cls;
        if (NODE_STATUS.includes(patch.status)) n.status = patch.status;
        if (patch.chirality === 'left' || patch.chirality === 'right' || patch.chirality === null) n.chirality = patch.chirality;
        if (isObj(patch.meta)) n.meta = { ...n.meta, ...clone(patch.meta) };
        return true;
    }

    setClass(id, cls) { const n = this.nodes.get(id); if (!n || !PART_CLASSES.includes(cls)) return false; n.cls = cls; return true; }
    setStatus(id, status) { const n = this.nodes.get(id); if (!n || !NODE_STATUS.includes(status)) return false; n.status = status; return true; }
    setAccept(id, accept) { const n = this.nodes.get(id); if (!n) return false; n.accept = arr(accept).map(clone); return true; }

    /** Merge a binding patch (recipe / params / featureIds back-links). */
    setBinding(id, bindingPatch) {
        const n = this.nodes.get(id);
        if (!n || !isObj(bindingPatch)) return false;
        n.binding = { ...n.binding, ...clone(bindingPatch) };
        return true;
    }

    /** Declare that `id` depends on `dependsOnId` (sizing + reflow edge). */
    addDep(id, dependsOnId) {
        const n = this.nodes.get(id);
        if (!n || !isStr(dependsOnId) || dependsOnId === id) return false;
        if (!n.deps.includes(dependsOnId)) n.deps.push(dependsOnId);
        return true;
    }

    // ── spec edits + reflow ─────────────────────────────────────────────────────

    /**
     * Patch a node's spec and mark it + every transitive dependent STALE so the
     * executor rebuilds only what the change actually touched. This is the core
     * of the "change the camera, the mount and cutout reflow" behaviour.
     */
    editNodeSpec(id, specPatch) {
        const n = this.nodes.get(id);
        if (!n || !isObj(specPatch)) return false;
        n.spec = { ...n.spec, ...clone(specPatch) };
        this.markStale(id);
        return true;
    }

    /**
     * Swap a part (the camera-module change). Sets class to buy/reuse, records
     * the new partRef + any spec deltas (e.g. new size), and reflows dependents.
     */
    replacePart(id, { partRef = null, spec = null, cls = 'buy' } = {}) {
        const n = this.nodes.get(id);
        if (!n) return false;
        if (PART_CLASSES.includes(cls)) n.cls = cls;
        if (isObj(spec)) n.spec = { ...n.spec, ...clone(spec) };
        if (partRef !== undefined) n.spec.partRef = partRef;
        this.markStale(id);
        return true;
    }

    /** Mark a node and all transitive dependents stale (reverse-dep walk). */
    markStale(id) {
        if (!this.nodes.has(id)) return 0;
        this._revokeApproval();   // a spec edit / part swap changes the plan → re-approve
        const dependents = this._dependentIndex();
        const seen = new Set();
        const stack = [id];
        while (stack.length) {
            const cur = stack.pop();
            if (seen.has(cur)) continue;
            seen.add(cur);
            const n = this.nodes.get(cur);
            if (n) n.stale = true;
            for (const d of (dependents.get(cur) || [])) stack.push(d);
        }
        return seen.size;
    }

    clearStale(id) { const n = this.nodes.get(id); if (!n) return false; n.stale = false; return true; }
    staleNodes() { return this.allNodes().filter((n) => n.stale); }

    /** nodeId → [ids of nodes that declare it in their deps]. */
    _dependentIndex() {
        const idx = new Map();
        for (const n of this.nodes.values()) {
            for (const dep of n.deps) {
                if (!idx.has(dep)) idx.set(dep, []);
                idx.get(dep).push(n.id);
            }
        }
        return idx;
    }

    dependentsOf(id) { return this._dependentIndex().get(id) || []; }

    // ── structural ops ──────────────────────────────────────────────────────────

    /** Split a node into children (decompose a subassembly into parts). */
    splitNode(id, childPartials) {
        const parent = this.nodes.get(id);
        if (!parent || !Array.isArray(childPartials) || !childPartials.length) return [];
        if (parent.kind === 'part') parent.kind = 'subassembly';
        const ids = [];
        for (const cp of childPartials) {
            const childId = this.addNode({ ...(isObj(cp) ? cp : {}), parentId: id });
            if (childId) ids.push(childId);
        }
        return ids;
    }

    /**
     * Instance one design as N placements (4 legs from 1 leg). The source stays
     * the canonical design; instances are lightweight references with their own
     * chirality. BOM reads "1 design → N placements", not N builds.
     */
    instance(sourceId, { count = 1, chirality = null, parentId = null, labelPrefix = null } = {}) {
        const src = this.nodes.get(sourceId);
        if (!src) return [];
        const n = Math.max(1, Math.min(64, Number.isFinite(count) ? count : 1));
        const ids = [];
        for (let i = 0; i < n; i++) {
            const chir = Array.isArray(chirality) ? chirality[i] : chirality;
            const id = this.addNode({
                kind: 'instance',
                label: `${labelPrefix || src.label} #${i + 1}`,
                instanceOf: sourceId,
                chirality: (chir === 'left' || chir === 'right') ? chir : null,
                parentId: isStr(parentId) ? parentId : src.parentId,
                deps: [sourceId],          // an instance reflows when its design changes
            });
            if (id) ids.push(id);
        }
        return ids;
    }

    /** Remove a node and its subtree; clean up parent links, roots, and deps. */
    removeNode(id) {
        const n = this.nodes.get(id);
        if (!n) return false;
        for (const childId of [...n.children]) this.removeNode(childId);
        if (n.parentId) {
            const parent = this.nodes.get(n.parentId);
            if (parent) parent.children = parent.children.filter((c) => c !== id);
        }
        this.rootIds = this.rootIds.filter((r) => r !== id);
        this.nodes.delete(id);
        for (const other of this.nodes.values()) {
            if (other.deps.includes(id)) other.deps = other.deps.filter((d) => d !== id);
        }
        this._revokeApproval();   // removing a part changes the plan → re-approve
        return true;
    }

    // ── versioning ──────────────────────────────────────────────────────────────

    /** Snapshot the working draft into an immutable version; returns its id. */
    commit(label) {
        const id = `v${++this._verSeq}`;
        this.versions.push({
            id,
            label: isStr(label) ? label : `version ${this._verSeq}`,
            parentId: this.currentVersionId,
            createdAt: this._now(),
            snapshot: this._draftSnapshot(),
        });
        this.currentVersionId = id;
        return id;
    }

    /** Restore a committed version into the working draft. */
    checkout(versionId) {
        const v = this.versions.find((x) => x.id === versionId);
        if (!v) return false;
        this._loadDraft(v.snapshot);
        this.currentVersionId = versionId;
        return true;
    }

    listVersions() {
        return this.versions.map((v) => ({ id: v.id, label: v.label, parentId: v.parentId, createdAt: v.createdAt }));
    }

    /**
     * Structured diff between two committed versions (or the working draft when
     * an id is omitted/falsy). Powers the "v1: cam-xyz 10×20 → v2: cam-123 50×50"
     * change view. Compares node existence + a small set of meaningful fields.
     */
    diff(versionIdA, versionIdB) {
        const a = this._resolveSnapshot(versionIdA);
        const b = this._resolveSnapshot(versionIdB);
        const byId = (snap) => new Map(arr(snap?.nodes).map((n) => [n.id, n]));
        const ma = byId(a), mb = byId(b);
        const added = [], removed = [], changed = [];
        for (const [id, nb] of mb) if (!ma.has(id)) added.push({ id, label: nb.label });
        for (const [id, na] of ma) if (!mb.has(id)) removed.push({ id, label: na.label });
        const FIELDS = ['label', 'cls', 'status', 'chirality', 'instanceOf'];
        for (const [id, na] of ma) {
            const nb = mb.get(id);
            if (!nb) continue;
            const fields = {};
            for (const f of FIELDS) {
                if (JSON.stringify(na[f]) !== JSON.stringify(nb[f])) fields[f] = [na[f], nb[f]];
            }
            if (JSON.stringify(na.spec) !== JSON.stringify(nb.spec)) fields.spec = [na.spec, nb.spec];
            if (Object.keys(fields).length) changed.push({ id, label: nb.label, fields });
        }
        return { added, removed, changed };
    }

    _resolveSnapshot(versionId) {
        if (!versionId) return this._draftSnapshot();
        const v = this.versions.find((x) => x.id === versionId);
        return v ? v.snapshot : this._draftSnapshot();
    }

    _draftSnapshot() {
        return { nodes: this.allNodes().map(clone), rootIds: [...this.rootIds] };
    }

    _loadDraft(snap) {
        this.nodes = new Map(arr(snap?.nodes).map((n) => [n.id, makeNode(n)]));
        this.rootIds = arr(snap?.rootIds).filter((id) => this.nodes.has(id));
    }

    // ── view ────────────────────────────────────────────────────────────────────

    /**
     * Render the graph as mermaid `graph TD` source. This is a VIEW — never the
     * source of truth; the UI edits go through the ops above, not this text.
     * Nodes are styled by class (buy/reuse/fabricate) so the user sees at a
     * glance what to order vs print.
     */
    toMermaid() {
        const lines = ['graph TD'];
        const safe = (s) => String(s == null ? '' : s).replace(/"/g, "'");
        const shape = (n) => {
            const tag = n.cls !== 'unknown' ? ` [${n.cls}]` : '';
            const star = n.stale ? ' *' : '';
            return `${n.id}["${safe(n.label)}${tag}${star}"]`;
        };
        // Emit edges (parent → child); isolated roots still get a node line.
        const emitted = new Set();
        const emitNode = (id) => {
            const n = this.nodes.get(id);
            if (!n) return;
            if (!n.children.length && !emitted.has(id)) { lines.push(`  ${shape(n)}`); emitted.add(id); }
            for (const c of n.children) {
                const cn = this.nodes.get(c);
                if (!cn) continue;
                lines.push(`  ${shape(n)} --> ${shape(cn)}`);
                emitted.add(id); emitted.add(c);
                emitNode(c);
            }
        };
        for (const r of this.rootIds) emitNode(r);
        // Class styling — coloured by part class.
        lines.push('  classDef buy fill:#1e3a5f,stroke:#3b82f6,color:#fff;');
        lines.push('  classDef reuse fill:#1e4620,stroke:#22c55e,color:#fff;');
        lines.push('  classDef fabricate fill:#4a3410,stroke:#f59e0b,color:#fff;');
        for (const cls of ['buy', 'reuse', 'fabricate']) {
            const ids = this.allNodes().filter((n) => n.cls === cls).map((n) => n.id);
            if (ids.length) lines.push(`  class ${ids.join(',')} ${cls};`);
        }
        return lines.join('\n');
    }

    // ── persistence (opaque POJO for the document JSON) ─────────────────────────

    snapshot() {
        return {
            nodes: this.allNodes().map(clone),
            rootIds: [...this.rootIds],
            versions: this.versions.map((v) => ({ ...v, snapshot: clone(v.snapshot) })),
            currentVersionId: this.currentVersionId,
            nodeSeq: this._nodeSeq,
            verSeq: this._verSeq,
            approved: this.approved,
            approvedAt: this.approvedAt,
        };
    }

    restore(pojo) {
        this.reset();
        if (!isObj(pojo)) return this;
        try {
            this._loadDraft({ nodes: pojo.nodes, rootIds: pojo.rootIds });
            this.versions = arr(pojo.versions)
                .filter((v) => isObj(v) && isStr(v.id))
                .map((v) => ({ id: v.id, label: v.label, parentId: v.parentId ?? null, createdAt: v.createdAt ?? 0, snapshot: clone(v.snapshot) || { nodes: [], rootIds: [] } }));
            this.currentVersionId = isStr(pojo.currentVersionId) ? pojo.currentVersionId : null;
            // _loadDraft builds nodes directly (no addNode), so restoring the
            // approval flag here is safe — it won't be revoked by the load.
            this.approved = !!pojo.approved;
            this.approvedAt = Number.isFinite(pojo.approvedAt) ? pojo.approvedAt : 0;
            // Restore counters above the max seen id so new ids never collide.
            const maxN = this.allNodes().reduce((m, n) => Math.max(m, +String(n.id).replace(/\D/g, '') || 0), 0);
            this._nodeSeq = Number.isFinite(pojo.nodeSeq) ? Math.max(pojo.nodeSeq, maxN) : maxN;
            this._verSeq = Number.isFinite(pojo.verSeq) ? pojo.verSeq : this.versions.length;
        } catch { /* corrupt snapshot — leave a clean reset graph */ }
        return this;
    }

    static restore(pojo, opts) { return new PlanGraph(opts).restore(pojo); }
}

// ── process-local singleton (one design session per loaded document) ──────────

let _shared = null;
export function getPlanGraph() {
    if (!_shared) _shared = new PlanGraph();
    return _shared;
}
/** Replace the singleton (used by load/restore + tests). */
export function setPlanGraph(g) { if (g instanceof PlanGraph) _shared = g; return _shared; }

export default getPlanGraph;
