/**
 * Polygon / Slot / Ellipse sketches, each driven to a 3D body via extrude.
 */
export default {
    name: 'Sketch primitives — Polygon / Slot / Ellipse',
    steps: [
        {
            label: 'Hex polygon r=10, extrude 8',
            run: async ({ ops, sketch }) => {
                const sk = sketch.polygon('XY', 6, 10);
                ops.addExtrude(sk.id, { amount: 8 });
            },
            expect: { minFaces: 8 },
        },
        {
            label: 'Reset → linear slot 30×6, extrude 4',
            run: async ({ ops, sketch, store }) => {
                for (const id of Object.keys(store.doc.features)) ops.deleteFeature(id);
                const sk = sketch.slot('XY', 30, 6);
                ops.addExtrude(sk.id, { amount: 4 });
            },
            expect: { minFaces: 3 },
        },
        {
            label: 'Reset → ellipse 12×6, extrude 5',
            run: async ({ ops, sketch, store }) => {
                for (const id of Object.keys(store.doc.features)) ops.deleteFeature(id);
                const sk = sketch.ellipse('XY', 12, 6);
                ops.addExtrude(sk.id, { amount: 5 });
            },
            expect: { minFaces: 3 },
        },
    ],
};
