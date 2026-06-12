/**
 * Revolve validation. A 2D sketch spun around an axis becomes a 3D body
 * of revolution — e.g. a cone, vase, washer.
 *
 * Current kernel limitation: build123d's `revolve()` fails with
 * BRep_API::not-done for the simple BuildSketch + Rectangle + Axis.Z
 * combination we emit. This is the kind of bug the harness is here to
 * surface — flagged stub for now so it doesn't block the green run,
 * but tracked so we re-enable it once the kernel-side emit path is
 * upgraded (e.g. to use BuildPart + Revolve directly with a profile
 * face on a Workplane).
 */

import { addRevolve } from '../lib/document/operations.js';
import { newSketch } from '../lib/document/sketch_ops.js';

export default [
    {
        name: 'Revolve · offset rect 360° about Z (disc) — kernel-fragile',
        build: () => {
            const sk = newSketch('XZ');
            sk.rect(5, 0, 15, 5);
            const feat = sk.commit();
            addRevolve(feat.id, { angle: 360, axis: 'Z' });
        },
        expect: {
            stub: true,
            featureType: 'Revolve',
            python:      /revolve\(n_\w+,\s*axis=Axis\.Z,\s*revolution_arc=360/,
        },
    },
    {
        name: 'Revolve · offset rect 180° half-rev — kernel-fragile',
        build: () => {
            const sk = newSketch('XZ');
            sk.rect(4, 0, 12, 4);
            const feat = sk.commit();
            addRevolve(feat.id, { angle: 180, axis: 'Z' });
        },
        expect: {
            stub: true,
            featureType: 'Revolve',
            python:      /revolution_arc=180/,
        },
    },
];
