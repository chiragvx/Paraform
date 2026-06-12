/**
 * DocumentStore — runtime façade over the v4 changelog-based document.
 *
 * The store owns:
 *   1. The canonical changelog (append-only)
 *   2. A pointer (`head`) into it — moves backward for rollback
 *   3. A live folded Document derived from changelog[0..head]
 *   4. A pub/sub channel for UI subscribers
 *   5. A redo stack of changes that lie ahead of head (popped when new changes append)
 *
 * Mutation rules:
 *   - Every edit funnels through `commit(change)` which appends and folds.
 *   - `undo()` decrements head, refolds, and pushes the popped change to redo.
 *   - `redo()` re-applies the topmost redo change.
 *   - Appending a new change clears the redo stack (linear history).
 *
 * Branching (multiple changes sharing a parent) is supported by the changelog
 * shape but not yet exposed through this API — v1 is linear only.
 */

import { foldChangelog, applyChange } from './fold.js';
import { emptyDocument, makeComponent, componentPathFor as _componentPathFor } from './types.js';
import { migrateV4ToV5 } from './migrate.js';

const MAX_CHANGELOG = 5000;   // soft cap; older changes are squashed via snapshot

export class DocumentStore {
    /**
     * @param {Document|null} [initial] — a previously persisted document, or null for fresh.
     */
    constructor(initial = null) {
        if (initial && Array.isArray(initial.changelog)) {
            this.doc = foldChangelog(initial.changelog, initial.head ?? initial.changelog.length - 1);
            // Preserve identity fields the fold doesn't restore
            this.doc.id = initial.id || this.doc.id;
            this.doc.metadata = { ...this.doc.metadata, ...(initial.metadata || {}) };
            // Components are doc-level metadata, not derived from the changelog
            // in v0. Preserve whatever the caller persisted; default to a fresh
            // root if missing/corrupt. Defensive against legacy v4-shape `[]`.
            const inboundComponents = (initial.components && typeof initial.components === 'object' && !Array.isArray(initial.components))
                ? initial.components
                : null;
            if (inboundComponents && inboundComponents.root) {
                this.doc.components = inboundComponents;
            } else {
                this.doc.components = { root: makeComponent({ id: 'root' }), ...(inboundComponents || {}) };
            }
        } else {
            this.doc = emptyDocument();
        }
        // emptyDocument() guarantees this, but a freshly-folded doc may
        // omit it if a future fold path forgets — re-assert here.
        if (!this.doc.components || typeof this.doc.components !== 'object' || Array.isArray(this.doc.components) || !this.doc.components.root) {
            this.doc.components = { root: makeComponent({ id: 'root' }), ...(this.doc.components && typeof this.doc.components === 'object' && !Array.isArray(this.doc.components) ? this.doc.components : {}) };
        }
        this._redo = [];           // ChangeRecord[] — popped during undo, re-applied on redo
        this._subs = new Set();    // (doc, eventLabel, store) → void
        this._selectedFeatureId = null;
        this._selectedRefs = [];

        // Kernel version metadata. `_lastKernelVersion` is whatever the bridge
        // last reported (live); `_loadedKernelVersion` is whatever was read out
        // of fromJSON (the version that was active when the doc was saved). The
        // restore code compares the two to surface a mismatch warning.
        this._lastKernelVersion = null;
        this._loadedKernelVersion = null;
    }

    // ── Kernel version tracking ────────────────────────────────────────────────
    /**
     * Callers (persistence flush, bridge subscription) push the most recently
     * observed kernel version block here so the next toJSON() captures it.
     * @param {object|null} v — e.g. `{ build123d: '0.6.2', occt: '7.7.2' }`
     */
    setLastKernelVersion(v) {
        this._lastKernelVersion = v || null;
    }

    /** The version block read from the persisted JSON at fromJSON() time. */
    get loadedKernelVersion() { return this._loadedKernelVersion; }

    // ── Subscriptions ──────────────────────────────────────────────────────────
    subscribe(fn) {
        this._subs.add(fn);
        return () => this._subs.delete(fn);
    }
    _notify(eventLabel = 'change') {
        for (const fn of this._subs) {
            try { fn(this.doc, eventLabel, this); }
            catch (e) { console.error('[DocumentStore subscriber]', e); }
        }
    }

    // ── Commit — the single mutation entry point ───────────────────────────────
    /**
     * Append a change to the changelog, advance head, fold incrementally.
     * Throws (and rolls back) if applyChange rejects the payload.
     *
     * @param {ChangeRecord} change
     */
    commit(change) {
        // Stamp parent to current head's change id if not already set, so the
        // record remains valid in a future branching world.
        if (change.parent === null && this.doc.head >= 0) {
            change.parent = this.doc.changelog[this.doc.head].id;
        }
        try {
            applyChange(this.doc, change);
        } catch (err) {
            console.warn('[DocumentStore.commit] rejected:', err.message);
            throw err;
        }
        this.doc.changelog.push(change);
        this.doc.head = this.doc.changelog.length - 1;
        this._redo.length = 0;   // linear history — appending invalidates redo
        this._notify(change.label || change.kind);
    }

    /**
     * Append many changes atomically. If any one throws, the whole batch is
     * rolled back (the document is refolded from before the batch).
     */
    commitBatch(changes, label = 'batch') {
        if (!changes.length) return;
        const headBefore = this.doc.head;
        const changelogLenBefore = this.doc.changelog.length;
        try {
            for (const ch of changes) {
                if (ch.parent === null && this.doc.head >= 0) {
                    ch.parent = this.doc.changelog[this.doc.head].id;
                }
                applyChange(this.doc, ch);
                this.doc.changelog.push(ch);
                this.doc.head = this.doc.changelog.length - 1;
            }
            this._redo.length = 0;
            this._notify(label);
        } catch (err) {
            // Rollback: truncate changelog and refold from scratch
            this.doc.changelog.length = changelogLenBefore;
            const refolded = foldChangelog(this.doc.changelog, headBefore);
            Object.assign(this.doc, refolded);
            console.warn('[DocumentStore.commitBatch] rolled back:', err.message);
            throw err;
        }
    }

    // ── Undo / redo ────────────────────────────────────────────────────────────
    canUndo() { return this.doc.head >= 0; }
    canRedo() { return this._redo.length > 0; }

    undo() {
        if (!this.canUndo()) return false;
        const change = this.doc.changelog[this.doc.head];
        // Drop the head change and refold the prefix
        this.doc.changelog.pop();
        this._redo.push(change);
        const newHead = this.doc.head - 1;
        const refolded = foldChangelog(this.doc.changelog, newHead);
        Object.assign(this.doc, refolded);
        this._notify(`undo ${change.label}`);
        return true;
    }

    redo() {
        if (!this.canRedo()) return false;
        const change = this._redo.pop();
        try {
            applyChange(this.doc, change);
        } catch (err) {
            console.warn('[DocumentStore.redo] failed:', err.message);
            this._redo.push(change);  // restore
            return false;
        }
        this.doc.changelog.push(change);
        this.doc.head = this.doc.changelog.length - 1;
        this._notify(`redo ${change.label}`);
        return true;
    }

    // ── Rollback ───────────────────────────────────────────────────────────────
    /**
     * Set the playhead to an explicit change index (or -1 for empty).
     * Anything past the new head moves to the redo stack so it can be replayed.
     * @param {number} newHead
     */
    setHead(newHead) {
        const clamped = Math.max(-1, Math.min(newHead, this.doc.changelog.length - 1));
        if (clamped === this.doc.head) return;
        if (clamped < this.doc.head) {
            // Move popped changes into redo (newest first → push reverses to oldest-last)
            for (let i = this.doc.changelog.length - 1; i > clamped; i--) {
                this._redo.push(this.doc.changelog[i]);
            }
            this.doc.changelog.length = clamped + 1;
        } else {
            // Move forward by replaying from redo
            while (this.doc.head < clamped && this._redo.length) {
                this.redo();
            }
            return;
        }
        const refolded = foldChangelog(this.doc.changelog, clamped);
        Object.assign(this.doc, refolded);
        this._notify('set-head');
    }

    // ── Component-tree helpers (Foundation 6 / commit 2) ──────────────────────
    /**
     * Features whose `componentId === componentId` (missing field → 'root'),
     * returned in `doc.featureOrder` order. Pure read; does not mutate.
     *
     * @param {string} componentId
     * @returns {Feature[]}
     */
    featuresInComponent(componentId) {
        const order = this.doc.featureOrder || [];
        const out = [];
        for (const fid of order) {
            const f = this.doc.features[fid];
            if (!f) continue;
            const cid = f.componentId || 'root';
            if (cid === componentId) out.push(f);
        }
        return out;
    }

    /**
     * Derived path of component ids from `root` down to `componentId`.
     * Delegates to types.js — kept here for ergonomic store.componentPathFor(id).
     *
     * @param {string} componentId
     * @returns {string[]}
     */
    componentPathFor(componentId) {
        return _componentPathFor(this.doc, componentId);
    }

    /**
     * Direct children of a parent component (one level deep). Read-only —
     * does not mutate the doc.
     *
     * @param {string} parentId
     * @returns {Component[]}
     */
    componentChildren(parentId) {
        const components = this.doc.components || {};
        const out = [];
        for (const cid of Object.keys(components)) {
            const c = components[cid];
            if (!c) continue;
            if (c.parentId === parentId) out.push(c);
        }
        return out;
    }

    /**
     * All transitive descendants of `rootId` (the root itself is excluded).
     * Walked iteratively breadth-first; cycle-safe via a visited set.
     *
     * @param {string} rootId
     * @returns {Component[]}
     */
    componentDescendants(rootId) {
        const components = this.doc.components || {};
        const seen = new Set([rootId]);
        const out = [];
        const queue = [rootId];
        while (queue.length) {
            const parent = queue.shift();
            for (const cid of Object.keys(components)) {
                if (seen.has(cid)) continue;
                const c = components[cid];
                if (c && c.parentId === parent) {
                    seen.add(cid);
                    out.push(c);
                    queue.push(cid);
                }
            }
        }
        return out;
    }

    /**
     * Subset of `doc.featureOrder` for one component. Same ordering as the
     * flat order; just filtered by membership.
     *
     * @param {string} componentId
     * @returns {string[]}  FeatureId[]
     */
    featureOrderInComponent(componentId) {
        const order = this.doc.featureOrder || [];
        const out = [];
        for (const fid of order) {
            const f = this.doc.features[fid];
            if (!f) continue;
            const cid = f.componentId || 'root';
            if (cid === componentId) out.push(fid);
        }
        return out;
    }

    // ── Selection (transient; not part of changelog) ───────────────────────────
    selectFeature(id) { this._selectedFeatureId = id; this._notify('select'); }
    selectedFeatureId() { return this._selectedFeatureId; }
    selectedFeature()   { return this._selectedFeatureId ? this.doc.features[this._selectedFeatureId] : null; }
    setRefs(refs) { this._selectedRefs = refs || []; this._notify('refs'); }
    getRefs()     { return this._selectedRefs.slice(); }

    // ── Serialization ──────────────────────────────────────────────────────────
    /**
     * Serialise to v5 JSON.
     *
     * Every feature stays in `doc.features` / `doc.featureOrder` — the v0
     * component tree is collapsed (single 'root' component), so we are NOT
     * splitting features into per-component lists in this commit. Commit 2
     * adds path-qualified featureIds; commit 3 adds the browser UI.
     */
    toJSON() {
        // Defensive: ensure components is a well-formed map with a root entry
        // before serialising, even if a buggy caller mutated this.doc.
        const components = (this.doc.components && typeof this.doc.components === 'object' && !Array.isArray(this.doc.components) && this.doc.components.root)
            ? this.doc.components
            : { root: makeComponent({ id: 'root' }) };
        const out = {
            version: 5,
            id:        this.doc.id,
            units:     this.doc.units,
            metadata:  this.doc.metadata,
            components,
            assumptions: Array.isArray(this.doc.assumptions) ? this.doc.assumptions.slice() : [],
            changelog: this.doc.changelog,
            head:      this.doc.head,
        };
        if (this._lastKernelVersion) {
            out.kernelVersion = this._lastKernelVersion;
        }
        return out;
    }

    /**
     * Replace the live document with the contents of a persisted JSON blob.
     *
     * Version handling:
     *   - v3 tree docs do NOT reach this code path; callers route them through
     *     `ensureV4` / `migrateV3TreeToV4` before constructing `json`.
     *   - v4 docs are migrated to v5 here via `migrateV4ToV5` (purely additive:
     *     stamps version + injects a root component).
     *   - v5 docs load as-is.
     */
    fromJSON(json) {
        // Bring everything up to v5 first. migrateV4ToV5 is idempotent on v5
        // and a no-op on anything without version === 4, so it's safe to chain.
        const v5json = migrateV4ToV5(json) || json || {};
        const refolded = foldChangelog(v5json.changelog || [], v5json.head ?? -1);
        refolded.id = v5json.id || refolded.id;
        refolded.metadata = { ...refolded.metadata, ...(v5json.metadata || {}) };
        if (v5json.units) refolded.units = v5json.units;
        // Lift persisted components onto the live doc, defaulting to a fresh
        // root if the payload is missing/corrupt. Do NOT clobber when valid.
        const inbound = (v5json.components && typeof v5json.components === 'object' && !Array.isArray(v5json.components))
            ? v5json.components
            : null;
        if (inbound && inbound.root) {
            refolded.components = inbound;
        } else {
            refolded.components = { root: makeComponent({ id: 'root' }), ...(inbound || {}) };
        }
        // Merge any top-level `assumptions` field from the JSON. The changelog
        // already produces the canonical list during fold; this preserves any
        // assumptions an external producer wrote without driving them through
        // a change record (idempotent — fold-derived ones are kept).
        if (Array.isArray(v5json.assumptions)) {
            const have = new Set((refolded.assumptions || []).map(a => a && a.id));
            for (const a of v5json.assumptions) {
                if (a && a.id && !have.has(a.id)) {
                    refolded.assumptions.push(JSON.parse(JSON.stringify(a)));
                }
            }
        }
        this.doc = refolded;
        this._redo.length = 0;
        this._selectedFeatureId = null;
        // Capture the persisted kernel version (may be absent on pre-Foundation-2
        // docs) — exposed via `loadedKernelVersion` for the restore-mismatch check.
        this._loadedKernelVersion = (v5json && typeof v5json.kernelVersion === 'object')
            ? v5json.kernelVersion
            : null;
        this._notify('load');
    }
}

// ── Free-function exports for doc-only callers ────────────────────────────────
// Some UI consumers (ComponentBrowserPanel) operate on a doc object directly
// without going through the singleton store — these wrappers give them an
// API that takes `(doc, parentId)` instead of being a method on DocumentStore.

/** Direct children of a parent component. */
export function componentChildren(doc, parentId) {
    const components = (doc && doc.components) || {};
    const out = [];
    for (const cid of Object.keys(components)) {
        const c = components[cid];
        if (c && c.parentId === parentId) out.push(c);
    }
    return out;
}

/** All transitive descendants of `rootId` (root itself excluded). Cycle-safe. */
export function componentDescendants(doc, rootId) {
    const components = (doc && doc.components) || {};
    const seen = new Set([rootId]);
    const out = [];
    const queue = [rootId];
    while (queue.length) {
        const parent = queue.shift();
        for (const cid of Object.keys(components)) {
            if (seen.has(cid)) continue;
            const c = components[cid];
            if (c && c.parentId === parent) {
                seen.add(cid);
                out.push(c);
                queue.push(cid);
            }
        }
    }
    return out;
}

// ── Lazy module singleton ─────────────────────────────────────────────────────
let _store = null;
export function getDocumentStore() {
    if (!_store) _store = new DocumentStore();
    return _store;
}
export function resetDocumentStore(initial = null) {
    _store = new DocumentStore(initial);
    return _store;
}
