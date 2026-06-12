/**
 * Shell validation.
 *
 * Hollow out a body by offsetting its faces inward. Without an
 * `openFaces` selection it closes the shell (offset all faces); with one,
 * only the specified face becomes the opening.
 */

import { addBox, addShell } from '../lib/document/operations.js';

export default [
    {
        name: 'Shell · 1mm wall on a 20mm cube (closed)',
        build: () => {
            const b = addBox({ length: 20, width: 20, height: 20 });
            addShell(b.id, { thickness: 1 });
        },
        expect: {
            featureType: 'Shell',
            python:      /offset\(n_\w+,\s*amount=-1/,
        },
    },
    {
        name: 'Shell · default thickness on default box',
        build: () => {
            const b = addBox();
            addShell(b.id);
        },
        expect: {
            featureType: 'Shell',
            python:      /offset\(n_\w+,\s*amount=-1/,
        },
    },
];
