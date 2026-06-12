/**
 * LinearPattern validation.
 *
 * Repeats a body along an axis. Emits `pattern_linear(body, axis=Axis.X,
 * count=N, spacing=S)`. Final topology has count copies of the source.
 */

import { addBox, addLinearPattern } from '../lib/document/operations.js';

export default [
    {
        name: 'LinearPattern · 3× along X spacing 15',
        build: () => {
            const b = addBox({ length: 10, width: 10, height: 10 });
            addLinearPattern(b.id, { direction: 'X', count: 3, spacing: 15 });
        },
        expect: {
            featureType: 'LinearPattern',
            python:      /pattern_linear\(n_\w+,\s*axis=Axis\.X,\s*count=3,\s*spacing=15\)/,
            topology:    { minFaces: 18 },        // 3 × 6 faces
        },
    },
    {
        name: 'LinearPattern · 4× along Y spacing 8',
        build: () => {
            const b = addBox({ length: 5, width: 5, height: 5 });
            addLinearPattern(b.id, { direction: 'Y', count: 4, spacing: 8 });
        },
        expect: {
            featureType: 'LinearPattern',
            python:      /axis=Axis\.Y,\s*count=4,\s*spacing=8/,
            topology:    { minFaces: 24 },
        },
    },
    {
        name: 'LinearPattern · default (2× along X)',
        build: () => {
            const b = addBox();
            addLinearPattern(b.id);
        },
        expect: {
            featureType: 'LinearPattern',
            python:      /pattern_linear\(.+count=2,\s*spacing=10\)/,
        },
    },
];
