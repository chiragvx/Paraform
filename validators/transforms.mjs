/**
 * Transform validation — Move / Rotate / Scale.
 *
 * Emit-only checks: the kernel applies a translate / rotate / scale to
 * the body and emits Python that calls `body.translate(...)` / etc.
 * Topology shape is preserved (same face/edge counts as the source).
 */

import { addBox, addMove, addRotate, addScale } from '../lib/document/operations.js';

export default [
    {
        name: 'Move · box translated (10, 0, 0)',
        build: () => {
            const b = addBox();
            addMove(b.id, [10, 0, 0]);
        },
        expect: {
            featureType: 'Move',
            python:      /translate\(Vector\(10,\s*0,\s*0\)\)/,
            topology:    { faces: 6, edges: 12 },
        },
    },
    {
        name: 'Move · negative offset',
        build: () => {
            const b = addBox();
            addMove(b.id, [-5, -5, 10]);
        },
        expect: {
            featureType: 'Move',
            python:      /translate\(Vector\(-5,\s*-5,\s*10\)\)/,
        },
    },
    {
        name: 'Rotate · 45° about Z',
        build: () => {
            const b = addBox({ length: 20, width: 10, height: 5 });
            addRotate(b.id, 'Z', 45);
        },
        expect: {
            featureType: 'Rotate',
            python:      /rotate\(Axis\.Z,\s*45\)/,
            topology:    { faces: 6, edges: 12 },
        },
    },
    {
        name: 'Rotate · 90° about X',
        build: () => {
            const b = addBox();
            addRotate(b.id, 'X', 90);
        },
        expect: {
            featureType: 'Rotate',
            python:      /rotate\(Axis\.X,\s*90\)/,
        },
    },
    {
        name: 'Scale · 2× a 10mm cube',
        build: () => {
            const b = addBox({ length: 10, width: 10, height: 10 });
            addScale(b.id, 2);
        },
        expect: {
            featureType: 'Scale',
            python:      /scale\(n_\w+,\s*by=2\)/,
            topology:    { faces: 6, edges: 12 },
        },
    },
];
