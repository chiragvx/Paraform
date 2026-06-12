/**
 * Sketch → Extrude pipeline. Sketches don't produce bodies on their own
 * (kernel rejects renders with no body), so every step here combines a
 * sketch + extrude into one commit.
 */
export default {
    name: 'Sketch — rectangle + extrude, circle + extrude',
    steps: [
        {
            label: 'Rectangle 30×20 → extrude 12 mm',
            run: async ({ ops, sketch }) => {
                const sk = sketch.rect('XY', 30, 20);
                ops.addExtrude(sk.id, { amount: 12 });
            },
            expect: { minFaces: 6 },
        },
        {
            label: 'Reset → circle r=10 → extrude 5 mm',
            run: async ({ ops, sketch, store }) => {
                for (const id of Object.keys(store.doc.features)) ops.deleteFeature(id);
                const sk = sketch.circle('XY', 10);
                ops.addExtrude(sk.id, { amount: 5 });
            },
            expect: { minFaces: 3 },
        },
    ],
};
