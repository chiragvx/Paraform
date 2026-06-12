/**
 * Hole validation.
 *
 * Cylindrical cut on a body. Default places the hole at origin along +Z.
 * Counterbore + countersink emit the appropriate keyword args.
 */

import { addBox, addHole } from '../lib/document/operations.js';

export default [
    {
        name: 'Hole · simple Ø3.2mm depth 10mm',
        build: () => {
            const b = addBox({ length: 30, width: 30, height: 20 });
            addHole(b.id, { diameter: 3.2, depth: 10 });
        },
        expect: {
            featureType: 'Hole',
            python:      /make_hole\(n_\w+,\s*location=None,\s*diameter=3\.2,\s*depth=10/,
            topology:    { minFaces: 7 },
        },
    },
    {
        name: 'Hole · through-hole (depth=None in python)',
        build: () => {
            const b = addBox({ length: 30, width: 30, height: 20 });
            addHole(b.id, { diameter: 5, through: true });
        },
        expect: {
            featureType: 'Hole',
            python:      /depth=None/,
            topology:    { minFaces: 7 },
        },
    },
    {
        name: 'Hole · counterbore 6mm head 3mm deep',
        build: () => {
            const b = addBox({ length: 30, width: 30, height: 20 });
            addHole(b.id, { diameter: 3.2, depth: 15, type: 'counterbore', counterDia: 6, counterDepth: 3 });
        },
        expect: {
            featureType: 'Hole',
            python:      /counter_bore_diameter=6.+counter_bore_depth=3/,
        },
    },
    {
        name: 'Hole · countersink Ø6 (angle defaulted in kernel)',
        build: () => {
            const b = addBox();
            addHole(b.id, { diameter: 3.2, depth: 8, type: 'countersink', counterDia: 6 });
        },
        expect: {
            featureType: 'Hole',
            python:      /counter_sink_diameter=6/,
        },
    },
];
