/**
 * Cylinder validation cases.
 *
 * A solid Cylinder is 3 faces (top + bottom + lateral) and 3 edges (top circle,
 * bottom circle, the seam where the lateral cylindrical surface "closes" — OCCT
 * reports it as one edge).
 */

import { addCylinder } from '../lib/document/operations.js';

export default [
    {
        name: 'Cylinder · r=5 h=10 centered',
        build: () => addCylinder({ radius: 5, height: 10, centered: true }),
        expect: {
            featureType: 'Cylinder',
            python:      /Cylinder\(5, 10/,
            topology:    { minFaces: 3, minEdges: 2, face: { normal: '+Z', surfaceType: 'planar' } },
        },
    },
    {
        name: 'Cylinder · r=1 h=50 thin shaft',
        build: () => addCylinder({ radius: 1, height: 50 }),
        expect: {
            featureType: 'Cylinder',
            python:      /Cylinder\(1, 50/,
            topology:    { minFaces: 3, minEdges: 2 },
        },
    },
    {
        name: 'Cylinder · r=20 h=2 disc',
        build: () => addCylinder({ radius: 20, height: 2 }),
        expect: {
            featureType: 'Cylinder',
            python:      /Cylinder\(20, 2/,
            topology:    { minFaces: 3, minEdges: 2 },
        },
    },
];
