/**
 * Helix validation cases.
 *
 * A Helix is a 1D wire (a path) — no faces, just edges. The kernel may or
 * may not emit it as a topology entry depending on how `export_gltf`
 * handles wires; we assert loosely.
 */

import { addHelix } from '../lib/document/operations.js';

export default [
    {
        name: 'Helix · pitch 5 height 20 radius 5',
        build: () => addHelix({ pitch: 5, height: 20, radius: 5 }),
        expect: {
            featureType: 'Helix',
            python:      /Helix\(5, 20, 5/,
            // Wire-only output: topology may or may not include it; just confirm
            // the kernel executed the Python without error. Stub semantics
            // would say "no body change," but Helix DOES produce a wire, so
            // we keep it as a pass.
        },
    },
    {
        name: 'Helix · left-handed coil',
        build: () => addHelix({ pitch: 4, height: 16, radius: 3, lefthand: true }),
        expect: {
            featureType: 'Helix',
            python:      /Helix\(4, 16, 3, cone_angle=0, lefthand=True/,
        },
    },
];
