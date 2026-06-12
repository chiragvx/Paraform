/**
 * Edge-picking validation — confirm that the JS picker, run against the
 * live kernel's topology, resolves a known query point to the right edge.
 *
 * This is the missing half of `picking.mjs`. picking.mjs proved the
 * fingerprint refs survive the round-trip; this one proves the *picker
 * itself* would have produced those refs from a cursor hit.
 *
 * Each case:
 *   - builds a primitive whose edges have known centers
 *   - emits + runs against the live kernel
 *   - calls `pickNearestEdge(queryPoint, topology)` and asserts the
 *     returned descriptor matches an expected predicate
 */

import { addBox, addCylinder } from '../lib/document/operations.js';
import { pickNearestEdge } from '../lib/picking/face_picker.js';

export default [
    {
        name: 'EdgePicker · Box top-front edge resolves to a Box edge descriptor',
        build: () => {
            addBox({ length: 20, width: 20, height: 20, centered: true });
        },
        expect: {
            featureType: 'Box',
            topology:    { faces: 6, edges: 12 },
            custom: ({ topology }) => {
                // Top-front edge of a 20mm centered Box: center ≈ (0, -10, 10)
                const queryPoint = [0, -10, 10];
                const hit = pickNearestEdge(queryPoint, topology);
                if (!hit) return 'pickNearestEdge returned null on a Box topology';
                if (hit.distance > 0.5) {
                    return `nearest-edge distance ${hit.distance.toFixed(2)}mm too high — expected ~0`;
                }
                // The descriptor (when emitted by the v4 namer) should be an edge of the Box.
                // Some kernels emit v3 topology with no descriptors; tolerate that and
                // assert only on the center match.
                if (hit.descriptor && hit.descriptor.kind && hit.descriptor.kind !== 'edge') {
                    return `expected descriptor.kind='edge', got '${hit.descriptor.kind}'`;
                }
                return null;
            },
        },
    },
    {
        name: 'EdgePicker · Box vertical-corner edge resolves separately from horizontals',
        build: () => {
            addBox({ length: 20, width: 20, height: 20, centered: true });
        },
        expect: {
            featureType: 'Box',
            custom: ({ topology }) => {
                // Vertical edge at (+X, +Y) corner: center ≈ (10, 10, 0)
                const queryPoint = [10, 10, 0];
                const hit = pickNearestEdge(queryPoint, topology);
                if (!hit) return 'pickNearestEdge returned null';
                if (hit.distance > 0.5) {
                    return `nearest-edge distance ${hit.distance.toFixed(2)}mm — expected ~0`;
                }
                // The matched center should be near (10, 10, 0) — never near a top
                // or bottom edge.
                const c = hit.center;
                if (Math.abs(c[0] - 10) > 1 || Math.abs(c[1] - 10) > 1 || Math.abs(c[2]) > 1) {
                    return `picker landed at ${JSON.stringify(c)}, expected ~(10, 10, 0)`;
                }
                return null;
            },
        },
    },
    {
        name: 'EdgePicker · Cylinder click near the lateral seam picks an edge',
        build: () => {
            addCylinder({ radius: 5, height: 10, centered: true });
        },
        expect: {
            featureType: 'Cylinder',
            custom: ({ topology }) => {
                // build123d's `edge.center()` on a closed circular edge is
                // the *parametric* midpoint (on the rim), not the disc
                // centre — so the top/bottom rings report centers like
                // (−5, 0, ±5). The vertical seam edge sits at (5, 0, 0).
                // Click near the seam → picker should resolve to it
                // (distance ≤ 1mm).
                const queryPoint = [5, 0, 0];
                const hit = pickNearestEdge(queryPoint, topology);
                if (!hit) return 'pickNearestEdge returned null for Cylinder';
                if (hit.distance > 1) {
                    return `expected seam-pick distance ≤ 1mm, got ${hit.distance.toFixed(2)}mm`;
                }
                return null;
            },
        },
    },
    {
        name: 'EdgePicker · query far from any edge returns a far-distance result',
        build: () => {
            addBox({ length: 20, width: 20, height: 20, centered: true });
        },
        expect: {
            featureType: 'Box',
            custom: ({ topology }) => {
                // A point inside the box body, far from any edge.
                const queryPoint = [0, 0, 0];
                const hit = pickNearestEdge(queryPoint, topology);
                if (!hit) return 'pickNearestEdge unexpectedly returned null';
                // The nearest edge from (0,0,0) on a 20mm cube is any midpoint
                // of an edge — distance ≈ sqrt(10² + 10²) ≈ 14.14mm.
                if (hit.distance < 10) {
                    return `from origin the nearest edge should be ≥10mm — got ${hit.distance.toFixed(2)}`;
                }
                return null;
            },
        },
    },
];
