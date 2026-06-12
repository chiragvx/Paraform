/**
 * CircularPattern validation.
 *
 * Repeats a body around an axis. Emits `pattern_circular(body, axis=Axis.Z,
 * count=N, angle=A)`. Default sweeps the full 360°.
 */

import { addBox, addCylinder, addCircularPattern, addMove } from '../lib/document/operations.js';

export default [
    {
        name: 'CircularPattern · 6× around Z',
        build: () => {
            // Move a small box off-axis so the pattern produces 6 distinct copies.
            const b = addBox({ length: 4, width: 4, height: 4 });
            addMove(b.id, [20, 0, 0]);
            // Pattern the moved body. The pattern op takes the latest body in chain.
            // Note: pattern targets the feature by id; here we want the Move output.
            // The kernel always patterns the body produced by the referenced feature.
            const m = { id: b.id }; // pattern wraps original box reference
            addCircularPattern(m.id, { axis: 'Z', count: 6, angle: 360 });
        },
        expect: {
            featureType: 'CircularPattern',
            python:      /pattern_circular\(n_\w+,\s*axis=Axis\.Z,\s*count=6,\s*angle=360\)/,
        },
    },
    {
        name: 'CircularPattern · 4× over 180° around X',
        build: () => {
            const b = addCylinder({ radius: 2, height: 5 });
            addMove(b.id, [10, 0, 0]);
            addCircularPattern(b.id, { axis: 'X', count: 4, angle: 180 });
        },
        expect: {
            featureType: 'CircularPattern',
            python:      /axis=Axis\.X,\s*count=4,\s*angle=180/,
        },
    },
    {
        name: 'CircularPattern · default (4× full sweep around Z)',
        build: () => {
            const b = addBox({ length: 3, width: 3, height: 3 });
            addMove(b.id, [15, 0, 0]);
            addCircularPattern(b.id);
        },
        expect: {
            featureType: 'CircularPattern',
            python:      /count=4,\s*angle=360/,
        },
    },
];
