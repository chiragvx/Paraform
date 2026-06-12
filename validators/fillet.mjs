/**
 * Fillet validation.
 *
 * Round every edge of a box (default behaviour when no edge selection is
 * passed). With picking on selected edges, the `edges` array carries
 * fingerprint refs — exercised in `picking.mjs`.
 */

import { addBox, addCylinder, addFillet } from '../lib/document/operations.js';

export default [
    {
        name: 'Fillet · all edges of a 20mm cube',
        build: () => {
            const b = addBox({ length: 20, width: 20, height: 20 });
            addFillet(b.id, { radius: 2 });
        },
        expect: {
            featureType: 'Fillet',
            python:      /fillet\(.+radius=2/,
            topology:    { minFaces: 14 },     // 6 originals + 12 edge fillets - rounded corners
        },
    },
    {
        name: 'Fillet · all edges of a cylinder (round both circular edges)',
        build: () => {
            const c = addCylinder({ radius: 10, height: 20 });
            addFillet(c.id, { radius: 1 });
        },
        expect: {
            featureType: 'Fillet',
            python:      /fillet\(.+radius=1/,
            topology:    { minFaces: 3 },
        },
    },
    {
        name: 'Fillet · tiny radius 0.5mm',
        build: () => {
            const b = addBox();
            addFillet(b.id, { radius: 0.5 });
        },
        expect: {
            featureType: 'Fillet',
            python:      /radius=0\.5/,
            topology:    { minFaces: 14 },
        },
    },
];
