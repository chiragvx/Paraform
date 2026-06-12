/**
 * Mirror validation.
 *
 * Reflect a body across one of the three principal planes (XY / YZ / XZ).
 * Emits `mirror(body, about=Plane.XY)`. The mirrored result is a new body
 * whose topology mirrors the source's face/edge counts.
 */

import { addBox, addCylinder, addMirror, addMove } from '../lib/document/operations.js';

export default [
    {
        name: 'Mirror · box across XY',
        build: () => {
            const b = addBox({ length: 10, width: 10, height: 10 });
            addMove(b.id, [0, 0, 20]);
            addMirror(b.id, 'XY');
        },
        expect: {
            featureType: 'Mirror',
            python:      /mirror\(n_\w+,\s*about=Plane\.XY\)/,
            topology:    { minFaces: 6 },
        },
    },
    {
        name: 'Mirror · cylinder across YZ',
        build: () => {
            const b = addCylinder({ radius: 3, height: 10 });
            addMove(b.id, [12, 0, 0]);
            addMirror(b.id, 'YZ');
        },
        expect: {
            featureType: 'Mirror',
            python:      /about=Plane\.YZ/,
        },
    },
    {
        name: 'Mirror · default plane (XY)',
        build: () => {
            const b = addBox();
            addMove(b.id, [0, 0, 15]);
            addMirror(b.id);
        },
        expect: {
            featureType: 'Mirror',
            python:      /about=Plane\.XY/,
        },
    },
];
