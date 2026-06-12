/**
 * Loft validation.
 *
 * Connects two or more sketches with a smooth surface. The two-circles
 * case is degenerate (both on the same plane) but exercises the emit
 * path; real Loft work needs offset construction planes which haven't
 * shipped yet.
 */

import { addLoft } from '../lib/document/operations.js';
import { circleSketch } from '../lib/document/sketch_ops.js';

export default [
    {
        name: 'Loft · two circles (emit only)',
        build: () => {
            const s1 = circleSketch('XY', 5);
            const s2 = circleSketch('XY', 2);
            addLoft([s1.id, s2.id]);
        },
        expect: {
            featureType: 'Loft',
            python:      /loft\(\[n_\w+,\s*n_\w+\],\s*ruled=False/,
            // Real topology check needs offset planes; not asserted here.
        },
    },
    {
        name: 'Loft · ruled=true',
        build: () => {
            const s1 = circleSketch('XY', 5);
            const s2 = circleSketch('XY', 2);
            addLoft([s1.id, s2.id], { ruled: true });
        },
        expect: {
            featureType: 'Loft',
            python:      /ruled=True/,
        },
    },
];
