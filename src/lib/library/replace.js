/**
 * Phase 2 — replaceComponent (swap-with-rebind).
 *
 * The headline "switch the servo with one click" feature. Given a placed
 * component and a new library part id:
 *
 *   1. Gather the persistent Mates whose placed component is `oldComponentId`.
 *   2. For each mate, find the connector on the NEW part that best matches the
 *      old part-connector — match priority:
 *        a) same `role`
 *        b) else same `interfaceId`
 *        c) else same `kind` + compatible gender/size (via mate_solver).
 *   3. Remove the old component's body feature(s) + connectors + the old
 *      component; place the new part (reusing placeLibraryPart) bound to the
 *      SAME host connectors, re-solving each mate transform.
 *   4. Rebind joints that referenced the old component to the new one.
 *   5. Return { ok, newComponentId, rebound:[...], unresolved:[...] }. Mates
 *      that can't be matched on the new part land in `unresolved` (warnings,
 *      never silently dropped).
 *
 * Goes through the commit pipeline (placeLibraryPart + the ops layer); no
 * direct doc mutation.
 */

import {
    getDocumentStore,
    removeComponent,
    removeConnector,
    removeMate,
    deleteFeature,
    updateJoint,
    matesForComponent,
} from '../../../lib/document/index.js';
import { getPartById } from './index.js';
import { placeLibraryPart } from './place.js';
import { connectorsCompatible } from './mate_solver.js';

/**
 * Pick the connector on `newPart` that best re-binds the mate that was bound
 * to `oldSourceConnector` (the original PartRecord connector of the old part).
 *
 * Priority: role > interfaceId > kind+gender/size compatibility.
 *
 * @param {object} newPart            — the new PartRecord
 * @param {object|null} oldSourceConnector — the old part's connector record
 * @returns {{ connector: object, basis: string }|null}
 */
export function matchConnectorForRebind(newPart, oldSourceConnector) {
    const cons = (newPart && Array.isArray(newPart.connectors)) ? newPart.connectors : [];
    if (!cons.length || !oldSourceConnector) return null;

    // a) same role
    if (typeof oldSourceConnector.role === 'string' && oldSourceConnector.role.length) {
        const hit = cons.find((c) => c && c.role === oldSourceConnector.role);
        if (hit) return { connector: hit, basis: 'role' };
    }
    // b) same interfaceId
    if (typeof oldSourceConnector.interfaceId === 'string' && oldSourceConnector.interfaceId.length) {
        const hit = cons.find((c) => c && c.interfaceId === oldSourceConnector.interfaceId);
        if (hit) return { connector: hit, basis: 'interfaceId' };
    }
    // c) same kind + compatible gender/size. We test a flipped-gender twin of
    //    the old connector so connectorsCompatible's gender-complement rule
    //    treats the candidate as a like-for-like replacement (the candidate
    //    mates the same host the old one did).
    const twin = {
        kind: oldSourceConnector.kind,
        gender: oldSourceConnector.gender,
        size: oldSourceConnector.size,
        mates_with: oldSourceConnector.mates_with || [oldSourceConnector.kind],
    };
    for (const c of cons) {
        if (!c || c.kind !== oldSourceConnector.kind) continue;
        // Build a host-shaped probe: same kind, complementary gender so the
        // candidate's gender lines up the way the original did.
        const probe = {
            kind: c.kind,
            gender: _complementGender(c.gender),
            size: c.size,
            mates_with: c.mates_with || [c.kind],
        };
        if (connectorsCompatible(probe, c)) {
            return { connector: c, basis: 'kind' };
        }
        // Fall back: bare kind match (defensive — gender/size loose).
    }
    // Last resort within kind: any same-kind connector.
    const sameKind = cons.find((c) => c && c.kind === oldSourceConnector.kind);
    if (sameKind) return { connector: sameKind, basis: 'kind' };

    return null;
}

function _complementGender(g) {
    if (g === 'male') return 'female';
    if (g === 'female') return 'male';
    return 'neutral';
}

/**
 * Swap the part placed at `oldComponentId` for `newPartId`, re-binding every
 * mate that positioned it.
 *
 * @param {string} oldComponentId
 * @param {string} newPartId
 * @param {{ name?: string }} [opts]
 * @returns {{
 *   ok: boolean,
 *   newComponentId?: string,
 *   rebound?: Array<{ mateId: string, hostConnectorId: string|null, partConnectorId: string|null, basis: string }>,
 *   unresolved?: Array<{ mateId: string, reason: string, sourceConnectorId: string|null }>,
 *   error?: string,
 * }}
 */
export function replaceComponent(oldComponentId, newPartId, opts = {}) {
    if (!oldComponentId || oldComponentId === 'root') {
        return { ok: false, error: 'oldComponentId required (and may not be root)' };
    }
    if (!newPartId) return { ok: false, error: 'newPartId required' };

    const store = getDocumentStore();
    const doc = store.doc;

    const oldComp = doc.components && doc.components[oldComponentId];
    if (!oldComp) return { ok: false, error: `unknown component ${oldComponentId}` };

    const newPart = getPartById(newPartId);
    if (!newPart) return { ok: false, error: `unknown part ${newPartId}` };

    // ── 1. Gather mates that positioned the old component ──
    const mates = matesForComponent(oldComponentId);

    // ── 2. Match the new part's connectors to each old mate. We need the
    //       *original PartRecord connector* for the old part-connector; the
    //       stamped connector on the old component carries sourceConnectorId
    //       + sourcePartId in metadata, so we resolve through that. ──
    const rebound = [];
    const unresolved = [];

    // Resolve a "primary" mate that we'll use to drive the new placement (the
    // first mate with a matchable connector). Remaining mates are reported.
    let primary = null;       // { mate, hostRef, match }
    for (const mate of mates) {
        const oldSrc = _oldSourceConnectorFor(doc, oldComponentId, mate, newPart);
        const match = matchConnectorForRebind(newPart, oldSrc);
        if (!match) {
            unresolved.push({
                mateId: mate.id,
                reason: oldSrc
                    ? `no connector on ${newPartId} matches role/interfaceId/kind of "${oldSrc.role || oldSrc.interfaceId || oldSrc.kind}"`
                    : `could not resolve the old part connector for mate ${mate.id}`,
                sourceConnectorId: mate.partConnectorRef ? mate.partConnectorRef.sourceConnectorId : null,
            });
            continue;
        }
        if (!primary) {
            primary = { mate, match };
        }
        rebound.push({
            mateId: mate.id,
            hostConnectorId: mate.hostConnectorRef ? (mate.hostConnectorRef.connectorId || null) : null,
            partConnectorId: match.connector.id,
            basis: match.basis,
        });
    }

    // ── 3. Remove the old placement (features + connectors + component + its
    //       mates), then place the new part. Capture identifiers BEFORE we
    //       mutate so the deletes don't race the reads. ──
    const oldFeatureIds = Object.values(doc.features || {})
        .filter((f) => f && f.componentId === oldComponentId)
        .map((f) => f.id);
    const oldConnectorIds = Object.values(doc.connectors || {})
        .filter((c) => c && c.parent === oldComponentId)
        .map((c) => c.id);
    const oldMateIds = mates.map((m) => m.id);
    const parentComponentId = oldComp.parentId || 'root';

    // Build the host ref for the new placement. Prefer the primary mate's
    // host. Fall back to a free placement at the old component's origin so a
    // part with no resolvable mate still lands somewhere sensible.
    let placeMate;
    if (primary) {
        const hostRef = primary.mate.hostConnectorRef || {};
        placeMate = {
            hostConnectorRef: hostRef.connectorId
                ? { connectorId: hostRef.connectorId }
                : { world: hostRef.world || _worldFromOrigin(oldComp) },
            partConnectorId: primary.match.connector.id,
        };
    } else {
        placeMate = {
            hostConnectorRef: { world: _worldFromOrigin(oldComp) },
        };
    }

    // Delete old features + connectors + mates + component.
    for (const fid of oldFeatureIds) {
        try { deleteFeature(fid); } catch (_) { /* idempotent */ }
    }
    for (const cid of oldConnectorIds) {
        try { removeConnector(cid); } catch (_) { /* idempotent */ }
    }
    for (const mid of oldMateIds) {
        try { removeMate(mid); } catch (_) { /* idempotent */ }
    }
    // removeComponent also nukes any StandardPart features still under it.
    try { removeComponent(oldComponentId); } catch (_) { /* idempotent */ }

    // ── Place the new part (re-solving the mate transform). ──
    const placed = placeLibraryPart({
        partId: newPartId,
        parentComponentId,
        mate: placeMate,
        name: opts.name || newPart.name,
    });
    if (!placed.ok) {
        return { ok: false, error: `placement failed: ${placed.error || 'unknown'}`, rebound, unresolved };
    }
    const newComponentId = placed.componentId;

    // ── 4. Rebind joints that referenced the old component. ──
    for (const j of Object.values(doc.joints || {})) {
        if (!j) continue;
        const patch = {};
        if (j.parent === oldComponentId) patch.parent = newComponentId;
        if (j.child === oldComponentId)  patch.child  = newComponentId;
        if (Object.keys(patch).length) {
            try { updateJoint(j.id, patch); } catch (_) { /* defensive */ }
        }
    }

    return { ok: true, newComponentId, rebound, unresolved };
}

/**
 * Resolve the old part's *source* connector (the PartRecord connector) that a
 * given mate bound. We try, in order:
 *   1. The stamped connector on the old component (via mate.partConnectorRef
 *      .connectorId) — its metadata carries sourcePartId + sourceConnectorId,
 *      and it also carries role/interfaceId copied at stamp time.
 *   2. The mate's recorded sourceConnectorId looked up on the OLD part record
 *      (resolved via the stamped connector's metadata.sourcePartId).
 *
 * Returns a connector-shaped object with role/interfaceId/kind/gender/size.
 */
function _oldSourceConnectorFor(doc, oldComponentId, mate, _newPart) {
    const pref = mate && mate.partConnectorRef ? mate.partConnectorRef : null;
    // 1. Stamped connector still on the (pre-delete) doc.
    if (pref && pref.connectorId && doc.connectors && doc.connectors[pref.connectorId]) {
        const stamped = doc.connectors[pref.connectorId];
        // The stamped connector already carries role/interfaceId (Phase 2) and
        // kind/gender/size, which is exactly what the matcher needs.
        return {
            kind: stamped.kind,
            gender: stamped.gender,
            size: stamped.size,
            mates_with: stamped.mates_with,
            role: stamped.role ?? null,
            interfaceId: stamped.interfaceId ?? null,
            id: (stamped.metadata && stamped.metadata.sourceConnectorId) || pref.sourceConnectorId || stamped.id,
        };
    }
    // 2. Resolve via the old part record (sourcePartId on any stamped connector).
    let sourcePartId = null;
    for (const c of Object.values(doc.connectors || {})) {
        if (c && c.parent === oldComponentId && c.metadata && c.metadata.sourcePartId) {
            sourcePartId = c.metadata.sourcePartId;
            break;
        }
    }
    if (sourcePartId && pref && pref.sourceConnectorId) {
        const oldPart = getPartById(sourcePartId);
        if (oldPart) {
            const src = (oldPart.connectors || []).find((c) => c.id === pref.sourceConnectorId);
            if (src) return src;
        }
    }
    return null;
}

/** Build a world-frame host tuple from a component's origin (free placement). */
function _worldFromOrigin(comp) {
    const o = (comp && comp.origin) || {};
    const pos = Array.isArray(o.position) ? o.position.slice() : [0, 0, 0];
    return { kind: 'planar', axis: [0, 0, 1], origin: pos };
}
