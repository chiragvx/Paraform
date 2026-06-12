/**
 * Migration — turn a v3 linear tree (lib/tree/types.js shape) into a v4
 * changelog-based document.
 *
 * Strategy:
 *   1. Replay the v3 tree as a synthetic changelog: one ADD_PARAMETER per
 *      parameter, one ADD_FEATURE per node, in their stored linear order.
 *   2. Convert v3 `params.body` / `params.target` / `params.bodies[]` references
 *      into v4 `inputs[role] = bodyRef(featureId)` so the DAG is explicit.
 *   3. Carry over body and sketch metadata via UPSERT_BODY / UPSERT_SKETCH.
 *
 * The resulting v4 document is *behaviourally* equivalent: feature ids are
 * preserved, params unchanged. The new affordance is explicit dependencies
 * and an append-only history (the synthetic changelog has one change per
 * artefact in the original v3 tree).
 */

import { CHANGE_KIND } from './changelog.js';
import { newChangeId, makeFeature, makeParameter, bodyRef, makeComponent } from './types.js';
import { foldChangelog } from './fold.js';

/**
 * Infer the dependency role+ref from a v3 node's params.
 * Different node types use different param names for their upstream body refs.
 *
 * Returns a `{ [role]: ref }` map suitable for `feature.inputs`.
 *
 * @param {object} v3Node       — node from the v3 tree
 * @param {Set<string>} knownIds — feature ids already added (for validation)
 */
function deriveInputs(v3Node, knownIds) {
    const inputs = {};
    const p = v3Node.params || {};

    // Single upstream body — common case
    const singleRole = {
        Extrude:  'sketch',
        Revolve:  'sketch',
        Sweep:    'sketch',
        Loft:     'sketches',
        Fillet:   'body',
        Chamfer:  'body',
        Shell:    'body',
        Draft:    'body',
        Hole:     'body',
        Thread:   'body',
        Offset3D: 'body',
        Mirror:   'body',
        LinearPattern:   'body',
        CircularPattern: 'body',
        PathPattern:     'body',
        Move:     'body',
        Rotate:   'body',
        Scale:    'body',
        Align:    'body',
        MoveFace: 'body',
        PushPullFace: 'body',
        DeleteFace:   'body',
        ReplaceFace:  'body',
        ProjectEdges: 'body',
        SketchOnFace: 'body',
    }[v3Node.type];

    if (singleRole && (p.body || p.bodyId)) {
        const id = p.body || p.bodyId;
        if (knownIds.has(id)) inputs[singleRole] = bodyRef(id);
    }

    // Boolean ops: `target` + `tools[]`
    if (['Cut', 'Intersect', 'Split'].includes(v3Node.type)) {
        if (p.target && knownIds.has(p.target)) inputs.target = bodyRef(p.target);
        if (Array.isArray(p.tools)) {
            inputs.tools = p.tools.filter(id => knownIds.has(id)).map(id => bodyRef(id));
        }
    }
    if (v3Node.type === 'Union' && Array.isArray(p.bodies)) {
        inputs.bodies = p.bodies.filter(id => knownIds.has(id)).map(id => bodyRef(id));
    }

    // Generic fallback: any v3 inputs[] (Ref shape) get copied over with
    // a generated role name. v3's `inputs[]` was rarely populated but we
    // honour it if present.
    if (Array.isArray(v3Node.inputs)) {
        v3Node.inputs.forEach((ref, i) => {
            if (ref && ref.kind === 'body' && ref.nodeId && knownIds.has(ref.nodeId)) {
                const role = `extra${i}`;
                if (!inputs[role]) inputs[role] = bodyRef(ref.nodeId, ref.bodyKey);
            }
        });
    }

    return inputs;
}

/**
 * Convert a v3 tree into a v4 document.
 *
 * @param {object} v3Tree — emptyTree()/migrateTreeToV2() shape from lib/tree/types.js
 * @returns {Document}
 */
export function migrateV3TreeToV4(v3Tree) {
    if (!v3Tree || !Array.isArray(v3Tree.nodes)) {
        throw new Error('migrateV3TreeToV4: input is not a v3 tree');
    }

    const changelog = [];
    const ts = Date.now();
    let parent = null;
    function pushChange(kind, payload, label = '') {
        const change = {
            id: newChangeId(),
            parent,
            timestamp: ts,
            kind,
            payload,
            label: label || kind,
        };
        changelog.push(change);
        parent = change.id;
        return change;
    }

    // 1. Parameters (id-keyed; v3 used numeric/name-keyed shape)
    for (const v3p of v3Tree.parameters || []) {
        const param = makeParameter(v3p.name, v3p.value, v3p.unit || 'mm', v3p.equation || null);
        if (v3p.id) param.id = v3p.id;   // preserve id if present
        pushChange(CHANGE_KIND.ADD_PARAMETER, { parameter: param }, `add param ${param.name}`);
    }

    // 2. Features — preserve v3 node ids so external references remain valid
    const knownIds = new Set();
    for (const v3Node of v3Tree.nodes) {
        const feature = makeFeature(v3Node.type, v3Node.params || {});
        // Preserve identity from v3 so downstream nodes referencing this id by
        // string still resolve. Update bookkeeping fields too.
        feature.id      = v3Node.id || feature.id;
        feature.name    = v3Node.name || feature.name;
        feature.enabled = v3Node.enabled !== false;
        feature.notes   = v3Node.notes || '';
        feature.warnings = Array.isArray(v3Node.warnings) ? v3Node.warnings.slice() : [];
        feature.createdAt = v3Node.createdAt || ts;
        feature.inputs  = deriveInputs(v3Node, knownIds);
        knownIds.add(feature.id);
        pushChange(CHANGE_KIND.ADD_FEATURE, { feature, insertAt: null }, `add ${feature.type}`);
    }

    // 3. Bodies metadata (color, name, hidden, suppressed)
    for (const [bodyId, meta] of Object.entries(v3Tree.bodies || {})) {
        pushChange(CHANGE_KIND.UPSERT_BODY, { bodyId, patch: meta }, `body ${bodyId}`);
    }

    // 4. Sketches metadata
    for (const [sketchId, data] of Object.entries(v3Tree.sketches || {})) {
        pushChange(CHANGE_KIND.UPSERT_SKETCH, { sketchId, patch: data }, `sketch ${sketchId}`);
    }

    // 5. Document-level settings
    if (v3Tree.units && v3Tree.units !== 'mm') {
        pushChange(CHANGE_KIND.SET_UNITS, { units: v3Tree.units });
    }
    if (v3Tree.metadata) {
        pushChange(CHANGE_KIND.SET_METADATA, { patch: v3Tree.metadata });
    }

    const doc = foldChangelog(changelog, changelog.length - 1);
    return doc;
}

/**
 * Quick check: does a given object look like a v3 tree?
 */
export function isV3Tree(obj) {
    return !!(obj && (obj.version === 2 || obj.version === 3) && Array.isArray(obj.nodes));
}

/**
 * Quick check: does a given object look like a v4 document?
 */
export function isV4Document(obj) {
    return !!(obj && obj.version === 4 && Array.isArray(obj.changelog));
}

/**
 * Quick check: does a given object look like a v5 document?
 */
export function isV5Document(obj) {
    return !!(obj && obj.version === 5 && Array.isArray(obj.changelog));
}

/**
 * v4 → v5 migration. Purely additive: stamps `version = 5` and ensures a
 * `components` map exists with a `root` entry. Does NOT touch changelog,
 * head, features, parameters, bodies, or sketches — every existing feature
 * remains implicitly assigned to the root component.
 *
 * Idempotent: running on a v5 doc is a no-op. Running on something without
 * `version === 4` is a no-op (returns the input unchanged) so callers can
 * safely chain it after `ensureV4`.
 *
 * @param {object} json
 * @returns {object}
 */
export function migrateV4ToV5(json) {
    if (!json || json.version !== 4) return json;   // not our migration
    const next = { ...json, version: 5 };
    // Be defensive against legacy v4 docs where `components` was a `[]` stub —
    // treat any non-object value as missing and start fresh with `root`.
    const existing = (next.components && typeof next.components === 'object' && !Array.isArray(next.components))
        ? next.components
        : null;
    if (!existing || !existing.root) {
        next.components = {
            root: makeComponent({ id: 'root', name: (next.metadata && next.metadata.name) || 'Document' }),
            ...(existing || {}),
        };
    }
    return next;
}

/**
 * Idempotent universal entrypoint: migrate whatever shape is passed in to v5.
 * Returns the input unchanged if already v5.
 */
export function ensureV5(obj) {
    if (!obj) return obj;
    if (isV5Document(obj)) return obj;
    if (isV4Document(obj)) return migrateV4ToV5(obj);
    if (isV3Tree(obj))     return migrateV4ToV5(migrateV3TreeToV4(obj));
    throw new Error(`ensureV5: unrecognised document shape (version=${obj.version})`);
}

/**
 * Idempotent universal entrypoint: migrate whatever shape is passed in to v4.
 * Returns the input unchanged if already v4. Retained for callers that
 * specifically want the v4 shape (i.e. without the components map).
 */
export function ensureV4(obj) {
    if (!obj) return obj;
    if (isV4Document(obj)) return obj;
    if (isV3Tree(obj))     return migrateV3TreeToV4(obj);
    if (isV5Document(obj)) return obj;   // tolerate forward shape
    throw new Error(`ensureV4: unrecognised document shape (version=${obj.version})`);
}
