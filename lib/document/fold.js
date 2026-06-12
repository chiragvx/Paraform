/**
 * Fold — compute the live Document state from a changelog.
 *
 * Strategy: walk changes [0..head] inclusive, apply each one to a working copy.
 * O(N) per refold. For long histories we will eventually cache snapshots at
 * checkpoints, but for v1 a full refold on every commit is fine — the changelog
 * is typically <1k entries even for complex parts.
 *
 * Invariant: applying the same changelog twice produces an identical document
 * (deep-equal). Determinism is non-negotiable — it's what makes branching and
 * collaborative editing tractable down the road.
 */

import { emptyDocument, makeComponent } from './types.js';
import { CHANGE_KIND } from './changelog.js';

/**
 * Apply a single change to a document IN PLACE. Throws on unknown kinds or
 * payloads that violate invariants (eg removing a feature that doesn't exist).
 *
 * @param {Document} doc
 * @param {ChangeRecord} change
 * @param {{ replay?: boolean }} [opts]
 *   `replay: true` is set when re-folding a full changelog (foldChangelog /
 *   foldIncremental). In that mode an UPDATE for a joint/mate that a later
 *   REMOVE deletes — or whose ADD is gone after a migration/compaction — is an
 *   EXPECTED, harmless artifact of an append-only log, so we skip silently
 *   instead of logging. During a LIVE single commit (default) the same
 *   condition is a real bug, so we still warn.
 */
export function applyChange(doc, change, opts = {}) {
    const { kind, payload } = change;
    const replay = !!opts.replay;

    switch (kind) {
        case CHANGE_KIND.ADD_FEATURE: {
            const { feature, insertAt } = payload;
            if (doc.features[feature.id]) {
                throw new Error(`add-feature: id collision ${feature.id}`);
            }
            doc.features[feature.id] = JSON.parse(JSON.stringify(feature));
            if (insertAt == null || insertAt >= doc.featureOrder.length) {
                doc.featureOrder.push(feature.id);
            } else {
                doc.featureOrder.splice(Math.max(0, insertAt), 0, feature.id);
            }
            break;
        }
        case CHANGE_KIND.REMOVE_FEATURE: {
            const { featureId } = payload;
            if (!doc.features[featureId]) break;  // idempotent
            delete doc.features[featureId];
            doc.featureOrder = doc.featureOrder.filter(id => id !== featureId);
            break;
        }
        case CHANGE_KIND.UPDATE_FEATURE: {
            const { featureId, patch } = payload;
            const f = doc.features[featureId];
            if (!f) throw new Error(`update-feature: missing ${featureId}`);
            Object.assign(f, patch);
            break;
        }
        case CHANGE_KIND.RENAME_FEATURE: {
            const { featureId, name } = payload;
            const f = doc.features[featureId];
            if (!f) throw new Error(`rename-feature: missing ${featureId}`);
            f.name = name;
            break;
        }
        case CHANGE_KIND.SET_ENABLED: {
            const { featureId, enabled } = payload;
            const f = doc.features[featureId];
            if (!f) throw new Error(`set-enabled: missing ${featureId}`);
            f.enabled = !!enabled;
            break;
        }
        case CHANGE_KIND.SET_PARAMS: {
            const { featureId, patch } = payload;
            const f = doc.features[featureId];
            if (!f) throw new Error(`set-params: missing ${featureId}`);
            f.params = { ...f.params, ...patch };
            break;
        }
        case CHANGE_KIND.SET_INPUTS: {
            const { featureId, inputs } = payload;
            const f = doc.features[featureId];
            if (!f) throw new Error(`set-inputs: missing ${featureId}`);
            f.inputs = JSON.parse(JSON.stringify(inputs || {}));
            break;
        }
        case CHANGE_KIND.REORDER_FEATURE: {
            const { featureId, newIndex } = payload;
            const cur = doc.featureOrder.indexOf(featureId);
            if (cur < 0) throw new Error(`reorder-feature: missing ${featureId}`);
            doc.featureOrder.splice(cur, 1);
            const tgt = Math.max(0, Math.min(newIndex, doc.featureOrder.length));
            doc.featureOrder.splice(tgt, 0, featureId);
            break;
        }
        case CHANGE_KIND.ADD_PARAMETER: {
            const { parameter } = payload;
            if (doc.parameters[parameter.id]) {
                throw new Error(`add-parameter: id collision ${parameter.id}`);
            }
            doc.parameters[parameter.id] = JSON.parse(JSON.stringify(parameter));
            break;
        }
        case CHANGE_KIND.UPDATE_PARAMETER: {
            const { paramId, patch } = payload;
            const p = doc.parameters[paramId];
            if (!p) throw new Error(`update-parameter: missing ${paramId}`);
            Object.assign(p, patch);
            break;
        }
        case CHANGE_KIND.REMOVE_PARAMETER: {
            const { paramId } = payload;
            delete doc.parameters[paramId];
            break;
        }
        case CHANGE_KIND.UPSERT_BODY: {
            const { bodyId, patch } = payload;
            doc.bodies[bodyId] = { ...(doc.bodies[bodyId] || { name: bodyId, color: '#8c9aaa', hidden: false }), ...patch };
            break;
        }
        case CHANGE_KIND.UPSERT_SKETCH: {
            const { sketchId, patch } = payload;
            doc.sketches[sketchId] = { ...(doc.sketches[sketchId] || {}), ...patch };
            break;
        }
        case CHANGE_KIND.SET_METADATA: {
            const { patch } = payload;
            doc.metadata = { ...doc.metadata, ...patch };
            break;
        }
        case CHANGE_KIND.SET_UNITS: {
            doc.units = payload.units;
            break;
        }
        // ── Component-tree changes (Foundation 6 / commit 3) ──────────────────
        case CHANGE_KIND.ADD_COMPONENT: {
            const { component } = payload;
            if (!component || !component.id) {
                console.warn('[fold] add-component: missing component.id');
                break;
            }
            if (doc.components[component.id]) {
                // Idempotent: don't overwrite a pre-existing component.
                console.warn(`[fold] add-component: id collision ${component.id} (skipping)`);
                break;
            }
            // Deep-clone so the changelog payload stays immutable.
            doc.components[component.id] = JSON.parse(JSON.stringify(component));
            break;
        }
        case CHANGE_KIND.REMOVE_COMPONENT: {
            const { componentId } = payload;
            if (componentId === 'root') {
                console.warn('[fold] remove-component: refusing to remove root');
                break;
            }
            if (!doc.components[componentId]) break;  // idempotent

            // The parent the orphaned features/children should fall through to.
            // If the removed component's own parentId is missing/dangling we
            // dump everything onto 'root'.
            const removed = doc.components[componentId];
            const fallbackParent = (removed && removed.parentId && doc.components[removed.parentId])
                ? removed.parentId
                : 'root';

            // Collect the full subtree (componentId + every transitive child)
            // iteratively. Cap iterations defensively against parentId cycles.
            const toRemove = new Set([componentId]);
            const maxIter = Object.keys(doc.components).length + 1;
            for (let iter = 0; iter < maxIter; iter++) {
                let grew = false;
                for (const cid of Object.keys(doc.components)) {
                    if (toRemove.has(cid)) continue;
                    const c = doc.components[cid];
                    if (c && toRemove.has(c.parentId)) {
                        toRemove.add(cid);
                        grew = true;
                    }
                }
                if (!grew) break;
            }
            // Never remove root, even if some bad data tied it into the subtree.
            toRemove.delete('root');

            // Reassign every feature whose componentId is in the removed set.
            for (const fid of Object.keys(doc.features)) {
                const f = doc.features[fid];
                if (!f) continue;
                const cid = f.componentId || 'root';
                if (toRemove.has(cid)) f.componentId = fallbackParent;
            }

            // Cascade-delete the assembly records anchored to the removed
            // subtree. Without this, deleting a placed part leaves its
            // connectors floating in the scene as stale cyan snap targets
            // (the connector overlay renders every doc.connectors entry), and
            // dangling mates/joints keep the kinematics + swap logic pointed
            // at a component that no longer exists. Done implicitly here (not
            // as separate changes) so undo restores them for free on replay.
            const removedConnectorIds = new Set();
            if (doc.connectors && typeof doc.connectors === 'object') {
                for (const connId of Object.keys(doc.connectors)) {
                    const c = doc.connectors[connId];
                    if (c && toRemove.has(c.parent)) {
                        removedConnectorIds.add(connId);
                        delete doc.connectors[connId];
                    }
                }
            }
            if (doc.mates && typeof doc.mates === 'object') {
                for (const mateId of Object.keys(doc.mates)) {
                    const m = doc.mates[mateId];
                    if (!m) continue;
                    const hostId = m.hostConnectorRef && m.hostConnectorRef.connectorId;
                    // Drop a mate when its placed component is going away OR its
                    // host connector was just removed (host part deleted under it).
                    if (toRemove.has(m.componentId) || (hostId && removedConnectorIds.has(hostId))) {
                        delete doc.mates[mateId];
                    }
                }
            }
            if (doc.joints && typeof doc.joints === 'object') {
                for (const jointId of Object.keys(doc.joints)) {
                    const j = doc.joints[jointId];
                    if (!j) continue;
                    if (toRemove.has(j.parent) || toRemove.has(j.child)) {
                        delete doc.joints[jointId];
                    }
                }
            }

            // Delete all collected components.
            for (const cid of toRemove) {
                delete doc.components[cid];
            }
            break;
        }
        case CHANGE_KIND.RENAME_COMPONENT: {
            const { componentId, name } = payload;
            if (componentId === 'root') {
                console.warn('[fold] rename-component: refusing to rename root');
                break;
            }
            const c = doc.components[componentId];
            if (!c) {
                console.warn(`[fold] rename-component: missing ${componentId}`);
                break;
            }
            c.name = name;
            break;
        }
        case CHANGE_KIND.SET_COMPONENT_PARENT: {
            const { componentId, parentId } = payload;
            if (componentId === 'root') {
                console.warn('[fold] set-component-parent: refusing to move root');
                break;
            }
            const c = doc.components[componentId];
            if (!c) {
                console.warn(`[fold] set-component-parent: missing ${componentId}`);
                break;
            }
            // Guard: target must exist (or be 'root'); no self-reparent; no
            // cycles. We re-validate here even though the op layer calls
            // canReparentComponent first, because the changelog can be
            // re-folded after edits that invalidate the original target.
            if (componentId === parentId) {
                console.warn('[fold] set-component-parent: self-reparent');
                break;
            }
            const targetExists = parentId === 'root' || !!doc.components[parentId];
            if (!targetExists) {
                console.warn(`[fold] set-component-parent: target ${parentId} missing`);
                break;
            }
            // Walk target's ancestor chain; reject if we encounter the source.
            const seen = new Set();
            let cur = parentId;
            let cycle = false;
            while (cur && !seen.has(cur)) {
                if (cur === componentId) { cycle = true; break; }
                seen.add(cur);
                const node = doc.components[cur];
                if (!node) break;
                cur = node.parentId || null;
                if (cur === 'root') break;
            }
            if (cycle) {
                console.warn('[fold] set-component-parent: would create cycle');
                break;
            }
            c.parentId = parentId;
            break;
        }
        case CHANGE_KIND.SET_FEATURE_COMPONENT: {
            const { featureId, componentId } = payload;
            const f = doc.features[featureId];
            if (!f) {
                console.warn(`[fold] set-feature-component: missing feature ${featureId}`);
                break;
            }
            const target = doc.components[componentId] ? componentId : 'root';
            f.componentId = target;
            break;
        }
        case CHANGE_KIND.SET_COMPONENT_ORIGIN: {
            const { componentId, originPatch } = payload;
            if (componentId === 'root') {
                console.warn('[fold] set-component-origin: refusing to move root');
                break;
            }
            const c = doc.components[componentId];
            if (!c) {
                console.warn(`[fold] set-component-origin: missing ${componentId}`);
                break;
            }
            const cur = c.origin || { position: [0,0,0], rotation: [0,0,0], scale: [1,1,1] };
            const next = {
                position: Array.isArray(originPatch?.position) && originPatch.position.length === 3
                    ? originPatch.position.slice()
                    : (cur.position || [0,0,0]).slice(),
                rotation: Array.isArray(originPatch?.rotation) && originPatch.rotation.length === 3
                    ? originPatch.rotation.slice()
                    : (cur.rotation || [0,0,0]).slice(),
                scale: Array.isArray(originPatch?.scale) && originPatch.scale.length === 3
                    ? originPatch.scale.slice()
                    : (cur.scale || [1,1,1]).slice(),
            };
            c.origin = next;
            break;
        }
        // ── Assumptions manifest (spec 09) ────────────────────────────────────
        case CHANGE_KIND.ADD_ASSUMPTION: {
            const { assumption } = payload;
            if (!assumption || !assumption.id) {
                console.warn('[fold] add-assumption: missing id');
                break;
            }
            if (!Array.isArray(doc.assumptions)) doc.assumptions = [];
            // Idempotent — collisions skip.
            if (doc.assumptions.some(a => a && a.id === assumption.id)) break;
            doc.assumptions.push(JSON.parse(JSON.stringify(assumption)));
            break;
        }
        case CHANGE_KIND.ACK_ASSUMPTION: {
            const { assumptionId, acknowledged } = payload;
            if (!Array.isArray(doc.assumptions)) break;
            const a = doc.assumptions.find(x => x && x.id === assumptionId);
            if (a) a.acknowledged = !!acknowledged;
            break;
        }
        case CHANGE_KIND.REMOVE_ASSUMPTION: {
            const { assumptionId } = payload;
            if (!Array.isArray(doc.assumptions)) break;
            doc.assumptions = doc.assumptions.filter(a => a && a.id !== assumptionId);
            break;
        }
        case CHANGE_KIND.CLEAR_ASSUMPTIONS: {
            const { filter } = payload || {};
            if (!Array.isArray(doc.assumptions)) { doc.assumptions = []; break; }
            if (filter && typeof filter === 'object') {
                doc.assumptions = doc.assumptions.filter(a => {
                    if (!a) return false;
                    if (filter.source && a.source !== filter.source) return true;
                    return false;
                });
            } else {
                doc.assumptions = [];
            }
            break;
        }
        // ── Joints (spec 17 v1 — kinematics oracle) ──────────────────────────
        case CHANGE_KIND.ADD_JOINT: {
            const { joint } = payload;
            if (!joint || !joint.id) {
                console.warn('[fold] add-joint: missing joint.id');
                break;
            }
            if (!doc.joints || typeof doc.joints !== 'object') doc.joints = {};
            if (doc.joints[joint.id]) {
                console.warn(`[fold] add-joint: id collision ${joint.id} (skipping)`);
                break;
            }
            doc.joints[joint.id] = JSON.parse(JSON.stringify(joint));
            break;
        }
        case CHANGE_KIND.UPDATE_JOINT: {
            const { jointId, patch } = payload;
            if (!doc.joints || !doc.joints[jointId]) {
                if (!replay) console.warn(`[fold] update-joint: missing ${jointId}`);
                break;
            }
            const j = doc.joints[jointId];
            // Shallow merge, but limits is itself an object — merge nested.
            if (patch && typeof patch === 'object') {
                for (const k of Object.keys(patch)) {
                    if (k === 'limits' && patch.limits && typeof patch.limits === 'object') {
                        j.limits = { ...j.limits, ...patch.limits };
                    } else if (k === 'origin' || k === 'axis') {
                        if (Array.isArray(patch[k]) && patch[k].length === 3) j[k] = patch[k].slice();
                    } else {
                        j[k] = patch[k];
                    }
                }
            }
            break;
        }
        case CHANGE_KIND.REMOVE_JOINT: {
            const { jointId } = payload;
            if (doc.joints && doc.joints[jointId]) delete doc.joints[jointId];
            break;
        }
        // ── Connectors (spec 18 v1 — component library / KSP mates) ──────────
        case CHANGE_KIND.ADD_CONNECTOR: {
            const { connector } = payload;
            if (!connector || !connector.id) {
                console.warn('[fold] add-connector: missing connector.id');
                break;
            }
            if (!doc.connectors || typeof doc.connectors !== 'object') doc.connectors = {};
            if (doc.connectors[connector.id]) {
                console.warn(`[fold] add-connector: id collision ${connector.id} (skipping)`);
                break;
            }
            doc.connectors[connector.id] = JSON.parse(JSON.stringify(connector));
            break;
        }
        case CHANGE_KIND.UPDATE_CONNECTOR: {
            const { connectorId, patch } = payload;
            if (!doc.connectors || !doc.connectors[connectorId]) {
                console.warn(`[fold] update-connector: missing ${connectorId}`);
                break;
            }
            const c = doc.connectors[connectorId];
            if (patch && typeof patch === 'object') {
                for (const k of Object.keys(patch)) {
                    if ((k === 'origin' || k === 'axis') && Array.isArray(patch[k]) && patch[k].length === 3) {
                        c[k] = patch[k].slice();
                    } else if (k === 'size' && patch.size && typeof patch.size === 'object') {
                        c.size = { ...c.size, ...patch.size };
                    } else if (k === 'metadata' && patch.metadata && typeof patch.metadata === 'object') {
                        c.metadata = { ...c.metadata, ...patch.metadata };
                    } else if (k === 'mates_with' && Array.isArray(patch.mates_with)) {
                        c.mates_with = patch.mates_with.slice();
                    } else {
                        c[k] = patch[k];
                    }
                }
            }
            break;
        }
        case CHANGE_KIND.REMOVE_CONNECTOR: {
            const { connectorId } = payload;
            if (doc.connectors && doc.connectors[connectorId]) delete doc.connectors[connectorId];
            break;
        }
        // ── Mates (Phase 2 — persistent mate records / swap-with-rebind) ─────
        case CHANGE_KIND.ADD_MATE: {
            const { mate } = payload;
            if (!mate || !mate.id) {
                console.warn('[fold] add-mate: missing mate.id');
                break;
            }
            if (!doc.mates || typeof doc.mates !== 'object') doc.mates = {};
            if (doc.mates[mate.id]) {
                console.warn(`[fold] add-mate: id collision ${mate.id} (skipping)`);
                break;
            }
            doc.mates[mate.id] = JSON.parse(JSON.stringify(mate));
            break;
        }
        case CHANGE_KIND.UPDATE_MATE: {
            const { mateId, patch } = payload;
            if (!doc.mates || !doc.mates[mateId]) {
                if (!replay) console.warn(`[fold] update-mate: missing ${mateId}`);
                break;
            }
            const m = doc.mates[mateId];
            if (patch && typeof patch === 'object') {
                // Deep-clone nested objects on assignment so the changelog
                // payload stays immutable and re-fold is deterministic.
                for (const k of Object.keys(patch)) {
                    const v = patch[k];
                    m[k] = (v && typeof v === 'object') ? JSON.parse(JSON.stringify(v)) : v;
                }
            }
            break;
        }
        case CHANGE_KIND.REMOVE_MATE: {
            const { mateId } = payload;
            if (doc.mates && doc.mates[mateId]) delete doc.mates[mateId];
            break;
        }
        default:
            throw new Error(`applyChange: unknown kind ${kind}`);
    }

    doc.metadata.updatedAt = change.timestamp;
}

/**
 * Fold a changelog from scratch into a live document.
 *
 * @param {ChangeRecord[]} changelog
 * @param {number} head     — index (inclusive) of the last change to apply; -1 = empty
 * @returns {Document}      — fresh document; does not mutate inputs
 */
export function foldChangelog(changelog, head = -1) {
    const doc = emptyDocument();
    // Preserve the changelog and head on the produced document so it is itself
    // a complete unit of state — fold(doc.changelog, doc.head) ≡ doc.
    doc.changelog = changelog.slice();
    doc.head = head;
    // Components are doc-level metadata (not driven by changelog kinds in v0).
    // emptyDocument() already seeds `{ root }`, but re-assert defensively here
    // so any future caller that bypasses emptyDocument still gets a root.
    if (!doc.components || typeof doc.components !== 'object' || Array.isArray(doc.components) || !doc.components.root) {
        doc.components = { root: makeComponent({ id: 'root' }) };
    }
    if (!Array.isArray(doc.assumptions)) doc.assumptions = [];
    if (!doc.joints || typeof doc.joints !== 'object' || Array.isArray(doc.joints)) doc.joints = {};
    if (!doc.connectors || typeof doc.connectors !== 'object' || Array.isArray(doc.connectors)) doc.connectors = {};
    if (!doc.mates || typeof doc.mates !== 'object' || Array.isArray(doc.mates)) doc.mates = {};

    const end = Math.min(head, changelog.length - 1);
    for (let i = 0; i <= end; i++) {
        applyChange(doc, changelog[i], { replay: true });
    }
    // Foundation 6 / commit 2: defensive fill-in. Older changelogs (v4/early
    // v5) committed features without a `componentId`. Stamp them onto 'root'
    // so downstream code (`featuresInComponent`, browser UI, emit) can rely
    // on the field being present. Purely additive — no new changelog kind.
    for (const fid of Object.keys(doc.features)) {
        const f = doc.features[fid];
        if (f && !f.componentId) f.componentId = 'root';
    }
    return doc;
}

/**
 * Incremental fold — apply changes [from..to] to an existing live doc IN PLACE.
 * Cheaper than full refold when only a few changes have been appended.
 *
 * @param {Document} doc
 * @param {number} from   — first change to apply (inclusive)
 * @param {number} to     — last change to apply (inclusive)
 */
export function foldIncremental(doc, from, to) {
    const end = Math.min(to, doc.changelog.length - 1);
    for (let i = from; i <= end; i++) {
        applyChange(doc, doc.changelog[i], { replay: true });
    }
    doc.head = end;
    // Defensive componentId fill (see foldChangelog comment).
    for (const fid of Object.keys(doc.features)) {
        const f = doc.features[fid];
        if (f && !f.componentId) f.componentId = 'root';
    }
}
