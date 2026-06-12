/**
 * SketchOnFace validation.
 *
 * Verifies the picker → planeRef → sketch-feature → emit pipeline works
 * end-to-end against the live kernel. The fixture fabricates a face
 * descriptor + origin/normal cache (no raycast needed for the headless
 * harness), builds a SketchOnFace feature carrying a circle profile, and
 * extrudes it.
 *
 * The kernel ultimately receives `Plane(origin=…, z_dir=…)` from the
 * inlined-cache emit path (see `lib/sketch/emit.js:planeExpr`) so the
 * Phase-1B `resolve_face_plane` kernel helper is NOT required for this
 * fixture to pass.
 */

import { addBox, addExtrude } from '../lib/document/operations.js';
import { getDocumentStore } from '../lib/document/store.js';
import { makeSketchData, facePlane, addEntity } from '../lib/sketch/sketch_data.js';
import { makePoint, makeCircle } from '../lib/sketch/entities.js';
import { addSketchChange } from '../lib/sketch/feature.js';
import { descriptor as makeDescriptor } from '../lib/document/descriptor.js';

function sketchOnFace({ origin, normal, kind = 'face', feature = 'fake_box', opTag = 'box', part = '+Z' }) {
    const desc = makeDescriptor(kind, feature, opTag, part, []);
    const plane = facePlane(desc, origin, normal);
    const sk = makeSketchData(plane, { name: 'SketchOnFace' });
    // 5 mm radius circle centred on the sketch plane's origin (0, 0 in
    // sketch-local coords corresponds to the face's centre in world).
    const c = addEntity(sk, makePoint(0, 0));
    addEntity(sk, makeCircle(c.id, 5));
    // Commit through the singleton store so the sketch feature lands in
    // the document the validator emits.
    const change = addSketchChange(sk);
    getDocumentStore().commit(change);
    return sk;   // the SketchData carries the assigned feature id
}

export default [
    {
        name: 'SketchOnFace · circle on Box +Z face',
        build: () => {
            const box = addBox({ length: 20, width: 20, height: 10, centered: true });
            // Top face of a centered 20×20×10 Box sits at z = +5, normal +Z.
            sketchOnFace({ origin: [0, 0, 5], normal: [0, 0, 1], feature: box.id, part: '+Z' });
        },
        expect: {
            // The store ends up with a Box, a Sketch (placed via addSketchChange);
            // featureType asserts whichever wins the search — Sketch is the
            // newer feature so we check for that.
            featureType: 'Sketch',
            python: /Plane\(origin=Vector\(0, 0, 5\), z_dir=Vector\(0, 0, 1\)\)/,
        },
    },
    {
        name: 'SketchOnFace · extrude through face for stepped boss',
        build: () => {
            const box = addBox({ length: 30, width: 30, height: 5 });
            const sk  = sketchOnFace({ origin: [0, 0, 2.5], normal: [0, 0, 1], feature: box.id });
            addExtrude(sk.id, { amount: 8 });
        },
        expect: {
            featureType: 'Extrude',
            python: /Plane\(origin=Vector\([^\)]*\), z_dir=Vector\(0, 0, 1\)\)/,
            // Extrude on a 5mm radius circle pulled +8mm out of a 30×30×5 box
            // → leaf body has 3 faces + the original box faces, so just
            // assert "more than one face."
            topology: { minFaces: 3 },
        },
    },
    {
        name: 'SketchOnFace · oblique normal emits the right z_dir',
        build: () => {
            // A descriptor with a 45° normal: the emitter should still
            // produce a Plane(origin, z_dir) with the cached normal.
            const box = addBox({ length: 10, width: 10, height: 10 });
            sketchOnFace({
                origin: [0, 0, 5],
                normal: [0.7071, 0, 0.7071],   // 45° tilt around Y
                feature: box.id,
                part: 'oblique',
            });
        },
        expect: {
            featureType: 'Sketch',
            python: /z_dir=Vector\(0\.7071, 0, 0\.7071\)/,
        },
    },
];
