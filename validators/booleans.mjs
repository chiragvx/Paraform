/**
 * Boolean validation — Union / Cut / Intersect.
 *
 * The emitter expresses these as `+`, `-`, `&` Python operators on the
 * body variables. The kernel runs them as OCCT booleans.
 */

import { addBox, addCylinder, addUnion, addCut, addIntersect } from '../lib/document/operations.js';

export default [
    {
        name: 'Union · box + cylinder',
        build: () => {
            const a = addBox({ length: 20, width: 20, height: 20 });
            const b = addCylinder({ radius: 8, height: 30 });
            addUnion([a.id, b.id]);
        },
        expect: {
            featureType: 'Union',
            python:      /=\s*n_\w+\s*\+\s*n_\w+/,
            topology:    { minFaces: 4 },
        },
    },
    {
        name: 'Cut · box minus drilled cylinder',
        build: () => {
            const a = addBox({ length: 20, width: 20, height: 20 });
            const b = addCylinder({ radius: 4, height: 40 });
            addCut(a.id, [b.id]);
        },
        expect: {
            featureType: 'Cut',
            python:      /=\s*n_\w+\s*-\s*n_\w+/,
            topology:    { minFaces: 7 },     // 5 box faces (one drilled) + cylinder hole walls
        },
    },
    {
        name: 'Intersect · box ∩ cylinder',
        build: () => {
            const a = addBox({ length: 30, width: 30, height: 30 });
            const b = addCylinder({ radius: 10, height: 30 });
            addIntersect([a.id, b.id]);
        },
        expect: {
            featureType: 'Intersect',
            python:      /=\s*n_\w+\s*&\s*n_\w+/,
            topology:    { minFaces: 3 },
        },
    },
];
