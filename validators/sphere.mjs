/**
 * Sphere validation cases.
 *
 * OCCT represents a sphere as 1 spherical face + 1 seam edge + 1 vertex.
 */

import { addSphere } from '../lib/document/operations.js';

export default [
    {
        name: 'Sphere · r=5',
        build: () => addSphere({ radius: 5 }),
        expect: {
            featureType: 'Sphere',
            python:      /Sphere\(5/,
            topology:    { minFaces: 1, minEdges: 0 },
        },
    },
    {
        name: 'Sphere · r=20 large',
        build: () => addSphere({ radius: 20 }),
        expect: {
            featureType: 'Sphere',
            python:      /Sphere\(20/,
            topology:    { minFaces: 1, minEdges: 0 },
        },
    },
];
