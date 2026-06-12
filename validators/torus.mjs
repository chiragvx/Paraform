/**
 * Torus validation cases.
 *
 * OCCT represents a torus as 1 toroidal face + 2 seam edges. We assert
 * loosely (≥1 face, ≥0 edges) because edge count depends on whether the
 * exporter splits the seam.
 */

import { addTorus } from '../lib/document/operations.js';

export default [
    {
        name: 'Torus · major=10 minor=2',
        build: () => addTorus({ majorRadius: 10, minorRadius: 2 }),
        expect: {
            featureType: 'Torus',
            python:      /Torus\(10, 2/,
            topology:    { minFaces: 1 },
        },
    },
    {
        name: 'Torus · thin major=30 minor=1',
        build: () => addTorus({ majorRadius: 30, minorRadius: 1 }),
        expect: {
            featureType: 'Torus',
            python:      /Torus\(30, 1/,
            topology:    { minFaces: 1 },
        },
    },
];
