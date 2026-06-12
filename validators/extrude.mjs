/**
 * Extrude validation cases.
 *
 * Pull a 2D sketch into 3D. The result body is a prism / disc; topology
 * depends on the profile (3F for a circle extrude, more for a rect or
 * polygon).
 */

import { addExtrude } from '../lib/document/operations.js';
import { circleSketch, rectangleSketch, polygonSketch } from '../lib/document/sketch_ops.js';

export default [
    {
        name: 'Extrude · circle r=5 h=10',
        build: () => {
            const sk = circleSketch('XY', 5);
            addExtrude(sk.id, { amount: 10 });
        },
        expect: {
            featureType: 'Extrude',
            python:      /extrude\(n_\w+,\s*amount=10/,
            topology:    { minFaces: 3, minEdges: 2 },
        },
    },
    {
        name: 'Extrude · 20×10 rect h=5',
        build: () => {
            const sk = rectangleSketch('XY', 20, 10);
            addExtrude(sk.id, { amount: 5 });
        },
        expect: {
            featureType: 'Extrude',
            python:      /extrude\(n_\w+,\s*amount=5/,
            topology:    { minFaces: 6, minEdges: 12 },
        },
    },
    {
        name: 'Extrude · hex r=8 h=4',
        build: () => {
            const sk = polygonSketch('XY', 6, 8);
            addExtrude(sk.id, { amount: 4 });
        },
        expect: {
            featureType: 'Extrude',
            python:      /extrude\(n_\w+,\s*amount=4/,
            topology:    { minFaces: 8, minEdges: 18 },
        },
    },
    {
        name: 'Extrude · both directions',
        build: () => {
            const sk = circleSketch('XY', 3);
            addExtrude(sk.id, { amount: 8, both: true });
        },
        expect: {
            featureType: 'Extrude',
            python:      /both=True/,
            topology:    { minFaces: 3 },
        },
    },
];
