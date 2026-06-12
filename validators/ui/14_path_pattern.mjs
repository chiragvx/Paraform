/**
 * PathPattern — distribute copies of a body along an open sketch curve.
 * Body + path sketch + pattern all happen in one commit so we don't hit
 * the kernel's "no bodies in __paraform_result__" rejection on the
 * sketch-only step.
 */
export default {
    name: 'PathPattern — bodies along a curve',
    // Kernel `pattern_path` has two known bugs surfaced by this bot:
    //   1. open wire paths fail with "Cannot build face(s): wires not planar"
    //      because the sketch is being treated as a face.
    //   2. closed sketch paths still fail because `path.location_at(t)` doesn't
    //      work on a Sketch, then the except-branch appends the same Body
    //      object N times into a Compound, which errors.
    // Both live in b123d_server/harness.py::pattern_path.
    skip: 'kernel pattern_path is broken — see b123d_server/harness.py:87',
    steps: [
        {
            label: 'Cylinder + circle path + pattern × 8',
            run: async ({ ops, sketch }) => {
                const cyl = ops.addCylinder({ radius: 1.5, height: 8 });
                const path = sketch.circle('XY', 20);
                ops.addPathPattern(cyl.id, path.id, { count: 8 });
            },
            expect: { minFaces: 3 },
        },
    ],
};
