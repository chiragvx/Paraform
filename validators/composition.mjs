/**
 * Composition validation — multi-feature regression cases.
 *
 * These exercise realistic chains (primitive → modify → boolean → pattern)
 * that the UI typically builds. The goal is to catch breakage at the
 * boundaries between feature emitters more than at any single op.
 */

import {
    addBox, addCylinder, addHole, addFillet, addChamfer, addShell,
    addUnion, addCut, addLinearPattern, addMove, addMirror,
} from '../lib/document/operations.js';

export default [
    {
        name: 'Composition · Box + Hole + Fillet',
        build: () => {
            const b = addBox({ length: 30, width: 30, height: 20 });
            addHole(b.id, { diameter: 4, depth: 15 });
            addFillet(b.id, { radius: 1 });
        },
        expect: {
            featureType: 'Fillet',
            python:      /make_hole.+\n.+fillet/s,
            topology:    { minFaces: 14 },     // 6 box + hole walls + fillet faces
        },
    },
    {
        name: 'Composition · Cylinder hollowed + chamfered rim',
        build: () => {
            const c = addCylinder({ radius: 10, height: 20 });
            addShell(c.id, { thickness: 1 });
            addChamfer(c.id, { length: 0.5 });
        },
        expect: {
            featureType: 'Chamfer',
            python:      /offset.+\n.+chamfer/s,
        },
    },
    {
        name: 'Composition · Union then linear pattern',
        build: () => {
            const a = addBox({ length: 8, width: 8, height: 8 });
            const b = addCylinder({ radius: 3, height: 12 });
            const u = addUnion([a.id, b.id]);
            addLinearPattern(u.id, { direction: 'X', count: 3, spacing: 15 });
        },
        expect: {
            featureType: 'LinearPattern',
            python:      /=\s*n_\w+\s*\+\s*n_\w+[\s\S]*?pattern_linear/,
        },
    },
    {
        name: 'Composition · Cut + Mirror',
        build: () => {
            const a = addBox({ length: 20, width: 20, height: 20 });
            const t = addCylinder({ radius: 3, height: 30 });
            const c = addCut(a.id, [t.id]);
            addMove(c.id, [15, 0, 0]);
            addMirror(c.id, 'YZ');
        },
        expect: {
            featureType: 'Mirror',
            python:      /n_\w+\s*-\s*n_\w+[\s\S]*?translate[\s\S]*?mirror/,
        },
    },
];
