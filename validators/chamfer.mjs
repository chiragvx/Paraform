/**
 * Chamfer validation.
 *
 * Bevel every edge of a body (default behaviour). Length-2 makes it
 * asymmetric.
 */

import { addBox, addChamfer } from '../lib/document/operations.js';

export default [
    {
        name: 'Chamfer · all edges 1mm',
        build: () => {
            const b = addBox({ length: 20, width: 20, height: 20 });
            addChamfer(b.id, { length: 1 });
        },
        expect: {
            featureType: 'Chamfer',
            python:      /chamfer\(.+length=1/,
            topology:    { minFaces: 14 },
        },
    },
    {
        name: 'Chamfer · asymmetric 2×1',
        build: () => {
            const b = addBox();
            addChamfer(b.id, { length: 2, length2: 1 });
        },
        expect: {
            featureType: 'Chamfer',
            python:      /length=2,\s*length2=1/,
            topology:    { minFaces: 14 },
        },
    },
];
