/**
 * Convert picker selection entries into the `{ descriptor, query, fingerprint }`
 * shape the v4 emitter / kernel `resolve_edges` + `resolve_faces` consume.
 *
 * The picker stores entries as `{ descriptor, key, payload }`, where
 * `payload = { center, normal, featureId }` carrying the last-known local-
 * frame center + normal at the moment of the click. The emitter wants:
 *
 *   {
 *     descriptor,                     // post-Phase 1B — the canonical id
 *     query: qDescriptor(descriptor), // emit.js resolves this against topology
 *     fingerprint: {
 *       centerRounded: [x, y, z],
 *       normalRounded: [nx, ny, nz],
 *       areaBucket:    <number — not strictly required by the kernel
 *                                resolver but kept for symmetry with v3>,
 *       sourceNodeId:  <feature id this fingerprint was sourced from>,
 *     }
 *   }
 *
 * The `query` field is only attached when the entry has a descriptor (post-
 * Phase 1B picks). Legacy v3 entries without a descriptor get just the
 * fingerprint, and the kernel falls back to centroid matching.
 */

import { qDescriptor } from '../document/queries.js';
import { getDocumentStore } from '../document/store.js';
import { componentPathFor } from '../document/types.js';

/**
 * Convert a single selection entry to an emit-ready edge ref.
 * Returns `null` if the payload lacks a center (the entry was added without
 * positional info — can't resolve at the kernel side).
 *
 * @param {{ descriptor: object, payload: { center?: number[], normal?: number[], featureId?: string } }} entry
 */
export function entryToEdgeRef(entry) {
    return entryToRef(entry);
}

/** Same as above but emitted under the face-fingerprint key. */
export function entryToFaceRef(entry) {
    return entryToRef(entry);
}

function entryToRef(entry) {
    if (!entry || !entry.payload || !entry.payload.center) return null;
    const p = entry.payload;
    const featureId = p.featureId || (entry.descriptor && entry.descriptor.feature) || '';
    const ref = {
        descriptor: entry.descriptor || null,
        fingerprint: {
            centerRounded: p.center.slice(),
            normalRounded: (p.normal || [0, 0, 1]).slice(),
            areaBucket:    1,
            sourceNodeId:  featureId,
        },
        // Foundation 6 — componentPath travels alongside the descriptor /
        // fingerprint so downstream consumers (component browser, future
        // path-qualified emitters) know which subtree owns the picked
        // entity. Prefer an explicit value on the payload (the wiring layer
        // stamps it onto every pick); fall back to a fresh document-store
        // lookup; finally default to `['root']` so the field is always set.
        componentPath: _resolveComponentPath(featureId, p.componentPath),
    };
    // Post-Phase 1B: when the entry carries a descriptor, attach a
    // qDescriptor query so emit.js can resolve symbolically instead of
    // falling back to the fingerprint centroid heuristic.
    if (entry.descriptor && entry.descriptor.kind) {
        ref.query = qDescriptor(entry.descriptor);
    }
    return ref;
}

/**
 * Resolve the componentPath for a featureId. Honours an explicit value when
 * present (the wiring layer stamps it onto every pick payload); otherwise
 * walks the live document via `componentPathFor`. Falls back to `['root']`
 * when the store is unavailable, the feature is unknown, or no featureId is
 * given — keeps the field non-null for every ref.
 */
function _resolveComponentPath(featureId, prefer) {
    if (Array.isArray(prefer) && prefer.length > 0) return prefer.slice();
    if (!featureId) return ['root'];
    let store;
    try { store = getDocumentStore(); } catch { return ['root']; }
    const doc = store && store.doc;
    if (!doc || !doc.features) return ['root'];
    const feat = doc.features[featureId];
    const componentId = (feat && feat.componentId) || 'root';
    return componentPathFor(doc, componentId);
}

/**
 * Convert a whole array of entries to edge refs, dropping any that lack
 * the position needed for resolver matching.
 */
export function entriesToEdgeRefs(entries) {
    if (!Array.isArray(entries)) return [];
    const out = [];
    for (const e of entries) {
        const ref = entryToEdgeRef(e);
        if (ref) out.push(ref);
    }
    return out;
}

export function entriesToFaceRefs(entries) {
    return entriesToEdgeRefs(entries);   // identical shape; emit chooses the key
}
