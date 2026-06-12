/**
 * Changelog — append-only record of every document edit.
 *
 * A Change carries enough information to be replayed deterministically.
 * `fold.js` walks the changelog and produces the live Document state.
 *
 * Why append-only? It gives undo/redo at every granularity for free, enables
 * non-destructive rollback (move `head` pointer instead of mutating), and is
 * the prerequisite for branchable documents (multiple changes can share a
 * parent — Onshape's "workspace" model).
 */

import { newChangeId } from './types.js';

// ── Change kinds ──────────────────────────────────────────────────────────────
export const CHANGE_KIND = {
    ADD_FEATURE:        'add-feature',
    REMOVE_FEATURE:     'remove-feature',
    UPDATE_FEATURE:     'update-feature',       // patch arbitrary feature fields
    RENAME_FEATURE:     'rename-feature',
    SET_ENABLED:        'set-enabled',
    SET_PARAMS:         'set-params',           // patch feature.params
    SET_INPUTS:         'set-inputs',           // replace feature.inputs map
    REORDER_FEATURE:    'reorder-feature',      // change UI position only

    ADD_PARAMETER:      'add-parameter',
    UPDATE_PARAMETER:   'update-parameter',
    REMOVE_PARAMETER:   'remove-parameter',

    UPSERT_BODY:        'upsert-body',
    UPSERT_SKETCH:      'upsert-sketch',

    SET_METADATA:       'set-metadata',
    SET_UNITS:          'set-units',

    // Foundation 6 / commit 3 — component-tree CRUD + feature-move.
    // Empty-component CRUD only; inserting external STEP files as components
    // is a separate feature outside this scope.
    ADD_COMPONENT:         'add-component',
    REMOVE_COMPONENT:      'remove-component',
    RENAME_COMPONENT:      'rename-component',
    SET_FEATURE_COMPONENT: 'set-feature-component',
    SET_COMPONENT_PARENT:  'set-component-parent',
    SET_COMPONENT_ORIGIN:  'set-component-origin',

    // Spec 09 — assumptions manifest
    ADD_ASSUMPTION:        'add-assumption',
    ACK_ASSUMPTION:        'acknowledge-assumption',
    REMOVE_ASSUMPTION:     'remove-assumption',
    CLEAR_ASSUMPTIONS:     'clear-assumptions',

    // Spec 17 v1 — kinematics oracle (joints)
    ADD_JOINT:             'add-joint',
    UPDATE_JOINT:          'update-joint',
    REMOVE_JOINT:          'remove-joint',

    // Spec 18 v1 — component library / KSP-style mate connectors
    ADD_CONNECTOR:         'add-connector',
    UPDATE_CONNECTOR:      'update-connector',
    REMOVE_CONNECTOR:      'remove-connector',

    // Phase 2 — persistent mate records (swap-with-rebind)
    ADD_MATE:              'add-mate',
    UPDATE_MATE:           'update-mate',
    REMOVE_MATE:           'remove-mate',
};

// ── Change factory ────────────────────────────────────────────────────────────
/**
 * Build a change record. The id is auto-generated; the parent must be supplied
 * by the caller (typically the current head of the changelog).
 *
 * @param {string} kind     — CHANGE_KIND.*
 * @param {object} payload  — kind-specific data
 * @param {string|null} parent
 * @param {string} [label]
 */
export function makeChange(kind, payload, parent = null, label = '') {
    if (!Object.values(CHANGE_KIND).includes(kind)) {
        throw new Error(`Unknown change kind: ${kind}`);
    }
    return {
        id:        newChangeId(),
        parent,
        timestamp: Date.now(),
        kind,
        payload,
        label:     label || kind,
    };
}

// ── Convenience builders ──────────────────────────────────────────────────────
// These wrap makeChange() with kind-appropriate payload validation and labels.
// Use them rather than makeChange directly — they keep the schema honest.

export function addFeatureChange(feature, insertAt = null, parent = null) {
    if (!feature || !feature.id) throw new Error('addFeatureChange: missing feature.id');
    return makeChange(CHANGE_KIND.ADD_FEATURE, { feature, insertAt }, parent, `add ${feature.type}`);
}

export function removeFeatureChange(featureId, parent = null) {
    return makeChange(CHANGE_KIND.REMOVE_FEATURE, { featureId }, parent, `remove ${featureId}`);
}

export function updateFeatureChange(featureId, patch, parent = null) {
    return makeChange(CHANGE_KIND.UPDATE_FEATURE, { featureId, patch }, parent, `update ${featureId}`);
}

export function renameFeatureChange(featureId, name, parent = null) {
    return makeChange(CHANGE_KIND.RENAME_FEATURE, { featureId, name }, parent, `rename ${featureId}`);
}

export function setEnabledChange(featureId, enabled, parent = null) {
    return makeChange(CHANGE_KIND.SET_ENABLED, { featureId, enabled: !!enabled }, parent,
        `${enabled ? 'enable' : 'suppress'} ${featureId}`);
}

export function setParamsChange(featureId, paramsPatch, parent = null) {
    return makeChange(CHANGE_KIND.SET_PARAMS, { featureId, patch: paramsPatch }, parent,
        `params ${featureId}`);
}

export function setInputsChange(featureId, inputs, parent = null) {
    return makeChange(CHANGE_KIND.SET_INPUTS, { featureId, inputs }, parent, `inputs ${featureId}`);
}

export function reorderFeatureChange(featureId, newIndex, parent = null) {
    return makeChange(CHANGE_KIND.REORDER_FEATURE, { featureId, newIndex }, parent,
        `reorder ${featureId}`);
}

export function addParameterChange(parameter, parent = null) {
    if (!parameter || !parameter.id || !parameter.name) {
        throw new Error('addParameterChange: missing id/name');
    }
    return makeChange(CHANGE_KIND.ADD_PARAMETER, { parameter }, parent, `add param ${parameter.name}`);
}

export function updateParameterChange(paramId, patch, parent = null) {
    return makeChange(CHANGE_KIND.UPDATE_PARAMETER, { paramId, patch }, parent, `update param ${paramId}`);
}

export function removeParameterChange(paramId, parent = null) {
    return makeChange(CHANGE_KIND.REMOVE_PARAMETER, { paramId }, parent, `remove param ${paramId}`);
}

export function upsertBodyChange(bodyId, patch, parent = null) {
    return makeChange(CHANGE_KIND.UPSERT_BODY, { bodyId, patch }, parent, `body ${bodyId}`);
}

export function upsertSketchChange(sketchId, patch, parent = null) {
    return makeChange(CHANGE_KIND.UPSERT_SKETCH, { sketchId, patch }, parent, `sketch ${sketchId}`);
}

export function setMetadataChange(patch, parent = null) {
    return makeChange(CHANGE_KIND.SET_METADATA, { patch }, parent, `metadata`);
}

export function setUnitsChange(units, parent = null) {
    return makeChange(CHANGE_KIND.SET_UNITS, { units }, parent, `units → ${units}`);
}

// ── Component-tree changes (Foundation 6 / commit 3) ──────────────────────────
// These mirror the feature-side builders above. Payloads carry the minimum
// data fold.js needs to reconstruct the operation deterministically.

export function addComponentChange(component, parent = null) {
    if (!component || !component.id) throw new Error('addComponentChange: missing component.id');
    return makeChange(CHANGE_KIND.ADD_COMPONENT, { component }, parent, `add component ${component.name || component.id}`);
}

export function removeComponentChange(componentId, parent = null) {
    return makeChange(CHANGE_KIND.REMOVE_COMPONENT, { componentId }, parent, `remove component ${componentId}`);
}

export function renameComponentChange(componentId, name, parent = null) {
    return makeChange(CHANGE_KIND.RENAME_COMPONENT, { componentId, name }, parent, `rename component ${componentId}`);
}

export function setFeatureComponentChange(featureId, componentId, parent = null) {
    return makeChange(
        CHANGE_KIND.SET_FEATURE_COMPONENT,
        { featureId, componentId },
        parent,
        `move ${featureId} → ${componentId}`
    );
}

// E6 v2 — reparent a component under another component.
export function setComponentParentChange(componentId, parentId, parent = null) {
    return makeChange(
        CHANGE_KIND.SET_COMPONENT_PARENT,
        { componentId, parentId },
        parent,
        `move component ${componentId} → ${parentId}`
    );
}

// Spec 18 v2 — write the placement transform onto a component. Used by the
// snap-drag UX to commit a moved part: the bridge's componentSubgroup reads
// origin on every render, so updating it here flows straight to the viewport.
// `originPatch` is a partial { position?, rotation?, scale? }; missing fields
// are filled from the component's existing origin.
export function setComponentOriginChange(componentId, originPatch, parent = null) {
    return makeChange(
        CHANGE_KIND.SET_COMPONENT_ORIGIN,
        { componentId, originPatch: originPatch || {} },
        parent,
        `move component ${componentId}`
    );
}

// ── Assumptions manifest (spec 09) ────────────────────────────────────────────

export function addAssumptionChange(assumption, parent = null) {
    if (!assumption || !assumption.id) {
        throw new Error('addAssumptionChange: missing assumption.id');
    }
    return makeChange(CHANGE_KIND.ADD_ASSUMPTION, { assumption }, parent,
        `assume ${assumption.kind}`);
}

export function acknowledgeAssumptionChange(assumptionId, acknowledged = true, parent = null) {
    return makeChange(CHANGE_KIND.ACK_ASSUMPTION, { assumptionId, acknowledged: !!acknowledged }, parent,
        `ack ${assumptionId}`);
}

export function removeAssumptionChange(assumptionId, parent = null) {
    return makeChange(CHANGE_KIND.REMOVE_ASSUMPTION, { assumptionId }, parent,
        `remove assumption ${assumptionId}`);
}

export function clearAssumptionsChange(filter = null, parent = null) {
    return makeChange(CHANGE_KIND.CLEAR_ASSUMPTIONS, { filter }, parent, `clear assumptions`);
}

// ── Joints (spec 17 v1 — kinematics oracle) ───────────────────────────────────

export function addJointChange(joint, parent = null) {
    if (!joint || !joint.id) throw new Error('addJointChange: missing joint.id');
    return makeChange(CHANGE_KIND.ADD_JOINT, { joint }, parent, `add joint ${joint.kind}`);
}

export function updateJointChange(jointId, patch, parent = null) {
    return makeChange(CHANGE_KIND.UPDATE_JOINT, { jointId, patch }, parent, `update joint ${jointId}`);
}

export function removeJointChange(jointId, parent = null) {
    return makeChange(CHANGE_KIND.REMOVE_JOINT, { jointId }, parent, `remove joint ${jointId}`);
}

// ── Connectors (spec 18 v1 — component library) ──────────────────────────────

export function addConnectorChange(connector, parent = null) {
    if (!connector || !connector.id) throw new Error('addConnectorChange: missing connector.id');
    return makeChange(CHANGE_KIND.ADD_CONNECTOR, { connector }, parent,
        `add connector ${connector.kind}`);
}

export function updateConnectorChange(connectorId, patch, parent = null) {
    return makeChange(CHANGE_KIND.UPDATE_CONNECTOR, { connectorId, patch }, parent,
        `update connector ${connectorId}`);
}

export function removeConnectorChange(connectorId, parent = null) {
    return makeChange(CHANGE_KIND.REMOVE_CONNECTOR, { connectorId }, parent,
        `remove connector ${connectorId}`);
}

// ── Mates (Phase 2 — persistent mate records / swap-with-rebind) ─────────────

export function addMateChange(mate, parent = null) {
    if (!mate || !mate.id) throw new Error('addMateChange: missing mate.id');
    return makeChange(CHANGE_KIND.ADD_MATE, { mate }, parent,
        `add mate ${mate.componentId || mate.id}`);
}

export function updateMateChange(mateId, patch, parent = null) {
    return makeChange(CHANGE_KIND.UPDATE_MATE, { mateId, patch }, parent,
        `update mate ${mateId}`);
}

export function removeMateChange(mateId, parent = null) {
    return makeChange(CHANGE_KIND.REMOVE_MATE, { mateId }, parent,
        `remove mate ${mateId}`);
}
