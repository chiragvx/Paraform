/**
 * Box validation cases.
 *
 * What we assert:
 *   - The store actually holds a Box feature with the right type.
 *   - emitDocument writes a `Box(L, W, H, …)` call.
 *   - The kernel returns 6 faces + 12 edges.
 *   - At least one face has +Z normal with area = L × W.
 */

import { addBox } from '../lib/document/operations.js';

export default [
    {
        name: 'Box · 10×10×10 centered',
        build: () => addBox({ length: 10, width: 10, height: 10, centered: true }),
        expect: {
            featureType: 'Box',
            python:      /Box\(10, 10, 10/,
            topology: {
                faces: 6, edges: 12,
                face:  { normal: '+Z', surfaceType: 'planar', minArea: 99, maxArea: 101 },
            },
        },
    },
    {
        name: 'Box · 20×10×5 align-to-min',
        build: () => addBox({ length: 20, width: 10, height: 5, centered: false }),
        expect: {
            featureType: 'Box',
            python:      /Box\(20, 10, 5/,
            topology: { faces: 6, edges: 12, face: { normal: '+Z', minArea: 199, maxArea: 201 } },
        },
    },
    {
        name: 'Box · thin slab 50×50×1',
        build: () => addBox({ length: 50, width: 50, height: 1 }),
        expect: {
            featureType: 'Box',
            python:      /Box\(50, 50, 1/,
            topology: { faces: 6, edges: 12, face: { normal: '+Z', minArea: 2499, maxArea: 2501 } },
        },
    },
];
