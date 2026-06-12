/**
 * Revolve — full 360 sweep + partial 270 wedge. Sketch is offset from the
 * Z axis so the revolve produces a ring rather than a degenerate disc.
 */
export default {
    name: 'Revolve — full + partial wedge',
    steps: [
        {
            label: 'Offset profile → revolve 360°',
            run: async ({ ops, sketch }) => {
                const b = sketch.new('XZ', { name: 'Revolve profile' });
                b.line(5, 0, 10, 0);
                b.line(10, 0, 10, 8);
                b.line(10, 8, 5, 8);
                b.line(5, 8, 5, 0);
                const sk = b.commit();
                ops.addRevolve(sk.id, { angle: 360, axis: 'Z' });
            },
            expect: { minFaces: 3 },
        },
        {
            label: 'Reset → revolve 270° wedge',
            run: async ({ ops, sketch, store }) => {
                for (const id of Object.keys(store.doc.features)) ops.deleteFeature(id);
                const b = sketch.new('XZ', { name: 'Wedge profile' });
                b.line(5, 0, 10, 0);
                b.line(10, 0, 10, 8);
                b.line(10, 8, 5, 8);
                b.line(5, 8, 5, 0);
                const sk = b.commit();
                ops.addRevolve(sk.id, { angle: 270, axis: 'Z' });
            },
            expect: { minFaces: 4 },
        },
    ],
};
