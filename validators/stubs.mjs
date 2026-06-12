/**
 * Stub-feature validation — Thread / Draft / PushPullFace.
 *
 * These features have JS emitters and Python kernel stubs but no
 * high-level `add*` helper yet. The kernel may not fully support each
 * one, so the cases below mark `expect.stub = true` — the harness then
 * reports any kernel error as `stub-skipped` rather than `fail`.
 */

import { addBox, addCylinder } from '../lib/document/operations.js';
import { makeFeature, bodyRef, axisRef } from '../lib/document/types.js';
import { addFeatureChange } from '../lib/document/changelog.js';
import { getDocumentStore } from '../lib/document/store.js';

function addThreadStub(featureId, { spec = 'M3', length = 10 } = {}) {
    const f = makeFeature('Thread', { spec, length, face: null }, { body: bodyRef(featureId) });
    getDocumentStore().commit(addFeatureChange(f));
    return f;
}

function addDraftStub(featureId, { angle = 2, pullDirection = 'Z' } = {}) {
    const f = makeFeature('Draft',
        { angle, faces: [] },
        { body: bodyRef(featureId), pullDirection: axisRef(pullDirection) });
    getDocumentStore().commit(addFeatureChange(f));
    return f;
}

function addPushPullStub(featureId, { distance = 5 } = {}) {
    const f = makeFeature('PushPullFace',
        { distance, face: null },
        { body: bodyRef(featureId) });
    getDocumentStore().commit(addFeatureChange(f));
    return f;
}

export default [
    {
        name: 'Thread · M3×10 emit only (stub)',
        build: () => {
            const b = addCylinder({ radius: 1.5, height: 15 });
            addThreadStub(b.id, { spec: 'M3', length: 10 });
        },
        expect: {
            stub: true,
            featureType: 'Thread',
            python:      /add_thread\(n_\w+,\s*location=None,\s*spec="M3",\s*length=10\)/,
        },
    },
    {
        name: 'Draft · 2° along Z emit only (stub)',
        build: () => {
            const b = addBox({ length: 20, width: 20, height: 10 });
            addDraftStub(b.id, { angle: 2, pullDirection: 'Z' });
        },
        expect: {
            stub: true,
            featureType: 'Draft',
            python:      /draft\(n_\w+,.*direction=Axis\.Z,\s*angle=2\)/,
        },
    },
    {
        name: 'PushPullFace · distance=5 emit only (stub)',
        build: () => {
            const b = addBox({ length: 20, width: 20, height: 20 });
            addPushPullStub(b.id, { distance: 5 });
        },
        expect: {
            stub: true,
            featureType: 'PushPullFace',
            python:      /push_pull_face\(n_\w+,\s*None,\s*distance=5\)/,
        },
    },
];
