/**
 * Sketch ↔ Document feature bridge.
 *
 * A sketch becomes a v4 Document feature of type `Sketch` whose `params.sketch`
 * carries the full SketchData. Inputs (the supporting plane / face) feed into
 * `feature.inputs.plane` as a normal Ref, so the DAG sees the dependency.
 *
 * Round-trip:
 *   makeSketchFeature(planeRef, sketchData)  ↔  sketchDataOf(feature)
 *
 * The Document changelog stores the SketchData verbatim, so every edit to a
 * sketch (`addEntity`, `addConstraint`, `setConstraintValue`) is captured by
 * a `SET_PARAMS` change that swaps the entire sketch payload. That keeps the
 * changelog one-edit-per-action without requiring per-entity change kinds —
 * SketchData is small (KB at most), so storing whole snapshots is cheap.
 */

import { makeFeature, planeRef as docPlaneRef, faceRef as docFaceRef } from '../document/types.js';
import { setParamsChange, addFeatureChange } from '../document/changelog.js';

/**
 * Wrap SketchData in a v4 Document feature. The plane reference is mapped
 * onto `feature.inputs.plane` so the regen scheduler knows the sketch depends
 * on the supporting plane (whether stock, construction, or a parametric face).
 *
 * @param {object} sketchData — from makeSketchData()
 * @returns {Feature}
 */
export function makeSketchFeature(sketchData) {
    if (!sketchData || !sketchData.planeRef) {
        throw new Error('makeSketchFeature: missing sketchData or planeRef');
    }
    const inputs = {};
    switch (sketchData.planeRef.kind) {
        case 'stock':
            inputs.plane = docPlaneRef(sketchData.planeRef.name);
            break;
        case 'construction':
            inputs.plane = docPlaneRef({ construction: sketchData.planeRef.id });
            break;
        case 'face':
            inputs.plane = docFaceRef(sketchData.planeRef.descriptor);
            break;
        default:
            throw new Error(`makeSketchFeature: unknown planeRef kind ${sketchData.planeRef.kind}`);
    }
    const feature = makeFeature('Sketch', { sketch: sketchData }, inputs);
    feature.id = sketchData.id;        // align ids so cross-references resolve consistently
    feature.name = sketchData.name || feature.name;
    return feature;
}

/**
 * Extract the SketchData payload from a Sketch feature. Throws if the feature
 * isn't a Sketch (callers should type-check upstream).
 */
export function sketchDataOf(feature) {
    if (!feature || feature.type !== 'Sketch') {
        throw new Error(`sketchDataOf: not a Sketch feature (type=${feature && feature.type})`);
    }
    const sketch = feature.params && feature.params.sketch;
    if (!sketch) throw new Error('sketchDataOf: feature missing params.sketch');
    return sketch;
}

/**
 * Build the changelog entry to add a new Sketch feature to a document.
 * The Sketch feature carries its plane ref via inputs.plane.
 *
 * @param {object} sketchData
 * @returns {ChangeRecord}
 */
export function addSketchChange(sketchData) {
    const feature = makeSketchFeature(sketchData);
    return addFeatureChange(feature);
}

/**
 * Build a changelog entry that replaces the SketchData payload of an existing
 * Sketch feature. Use this for every sketch edit funnelled through the store
 * (add entity, add constraint, drag handle, change dim value, …).
 *
 * @param {string} featureId — must be a Sketch feature id
 * @param {object} sketchData — the new full SketchData
 * @returns {ChangeRecord}
 */
export function updateSketchChange(featureId, sketchData) {
    return setParamsChange(featureId, { sketch: sketchData });
}

/**
 * Build a query for every closed loop produced by a sketch feature, useful
 * as input to downstream Extrude/Revolve/Loft. The kernel-side emitter
 * produces a sketch-loop topology entry per closed loop in the sketch; the
 * resolver matches by descriptor `opTag = 'sketch'` and `part = 'loop[i]'`.
 *
 * Returns null if you should use the simpler bodyRef path — callers that
 * want a specific loop need to construct a more precise query themselves.
 */
export function isSketchFeature(feature) {
    return !!(feature && feature.type === 'Sketch');
}
