/**
 * PickingSelection — subscribable set of picked face descriptors.
 *
 * Keyed by the canonical descriptor string (lib/document/descriptor.js
 * `stringify`) so the same logical face is the same key across regens.
 *
 *   const sel = new PickingSelection();
 *   sel.add(descriptor, payload?);   payload is optional metadata
 *                                    (e.g. the cached center + normal for
 *                                    rendering halos before the next regen)
 *   sel.remove(descriptor);
 *   sel.clear();
 *   sel.has(descriptor);
 *   sel.size;                        // number of selected entries
 *   sel.toArray();                   // [{ descriptor, payload, key }, ...]
 *   sel.descriptors();               // [Descriptor, ...]
 *
 *   const unsub = sel.subscribe((evt) => { … });
 *
 * Events emitted to subscribers:
 *   { kind: 'add',    descriptor, key, payload }
 *   { kind: 'remove', descriptor, key }
 *   { kind: 'clear' }
 *
 * No DOM, no Three.js — pure data + observable.
 */

import { stringify as descriptorKey } from '../document/descriptor.js';

export class PickingSelection {
    constructor() {
        /** @type {Map<string, { descriptor: object, payload: any, key: string }>} */
        this._entries = new Map();
        /** @type {Set<Function>} */
        this._subs    = new Set();
        /** @type {Array<'face'|'edge'|'vertex'|null>} stack of command hints */
        this._preferredStack = [];
        /** @type {Set<string>|null} pure runtime kind filter; null = accept all */
        this._kindFilter = null;
    }

    // ── Kind filter ───────────────────────────────────────────────────────
    // Runtime-only gate the wiring consults before committing a pick. The
    // SelectionFilter dropdown drives this; null means "accept every kind".
    /**
     * @param {Array<'body'|'face'|'edge'|'vertex'>|null|undefined} kinds
     * Pass null/undefined (or an empty array) to clear the filter.
     */
    setKindFilter(kinds) {
        if (!kinds || (Array.isArray(kinds) && kinds.length === 0)) {
            this._kindFilter = null;
        } else {
            this._kindFilter = new Set(kinds);
        }
    }
    /** @returns {Array<string>|null} */
    getKindFilter() {
        return this._kindFilter ? [...this._kindFilter] : null;
    }
    /** True if the filter is unset or includes the given kind. */
    acceptsKind(kind) {
        if (!this._kindFilter) return true;
        if (!kind) return false;
        return this._kindFilter.has(kind);
    }

    get size() { return this._entries.size; }

    // ── Preferred-kind stack ──────────────────────────────────────────────
    // The currently-active command can push a hint so the picker prioritises
    // matching entities on hover (Fillet → 'edge', Hole → 'face', etc.).
    // Returns a restore() fn that pops only its own entry; safe to call twice.
    pushPreferredKind(kind) {
        this._preferredStack.push(kind);
        let restored = false;
        const myDepth = this._preferredStack.length;
        return () => {
            if (restored) return;
            restored = true;
            this._preferredStack.length = Math.min(this._preferredStack.length, myDepth - 1);
        };
    }
    get preferredKind() {
        const n = this._preferredStack.length;
        return n > 0 ? this._preferredStack[n - 1] : null;
    }

    /** Stable canonical key for a descriptor. Exposed so callers can dedupe. */
    static keyOf(descriptor) { return descriptorKey(descriptor); }

    /**
     * Add a descriptor to the selection. If it's already present the payload
     * is updated (so the latest pick replaces stale center / normal data).
     * Returns the canonical key.
     */
    add(descriptor, payload = null) {
        if (!descriptor) return null;
        const key = descriptorKey(descriptor);
        if (!key) return null;
        const existed = this._entries.has(key);
        this._entries.set(key, { descriptor, payload, key });
        // Only fire 'add' the first time we see this key, so subscribers
        // don't get flooded by repeated identical picks (hover-then-click).
        if (!existed) this._emit({ kind: 'add', descriptor, key, payload });
        return key;
    }

    /** Remove by descriptor OR by raw key. Returns true if anything went. */
    remove(descriptorOrKey) {
        const key = typeof descriptorOrKey === 'string'
            ? descriptorOrKey
            : descriptorKey(descriptorOrKey);
        if (!key || !this._entries.has(key)) return false;
        const entry = this._entries.get(key);
        this._entries.delete(key);
        this._emit({ kind: 'remove', descriptor: entry.descriptor, key });
        return true;
    }

    /** Add if missing, remove if present. Returns the new presence state. */
    toggle(descriptor, payload = null) {
        const key = descriptorKey(descriptor);
        if (!key) return false;
        if (this._entries.has(key)) { this.remove(key); return false; }
        this.add(descriptor, payload);
        return true;
    }

    clear() {
        if (this._entries.size === 0) return;
        this._entries.clear();
        this._emit({ kind: 'clear' });
    }

    has(descriptorOrKey) {
        const key = typeof descriptorOrKey === 'string'
            ? descriptorOrKey
            : descriptorKey(descriptorOrKey);
        return this._entries.has(key);
    }

    toArray() { return [...this._entries.values()]; }
    descriptors() { return this.toArray().map(e => e.descriptor); }
    keys() { return [...this._entries.keys()]; }

    subscribe(fn) {
        if (typeof fn !== 'function') return () => {};
        this._subs.add(fn);
        return () => this._subs.delete(fn);
    }

    _emit(evt) {
        for (const fn of this._subs) {
            try { fn(evt); }
            catch (e) { console.error('[PickingSelection] subscriber threw:', e); }
        }
    }
}

// Module singleton — main.js + the panel + Fillet/Hole/etc. all share one
// selection so they don't drift out of sync.

let _shared = null;
export function getPickingSelection() {
    if (!_shared) _shared = new PickingSelection();
    return _shared;
}
export function resetPickingSelection() { _shared = null; }
