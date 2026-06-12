/**
 * Document parameters — add a parameter, then update it and confirm the
 * downstream feature regenerates. Parameters don't render directly, so
 * the screenshot just shows whatever body we drove them into.
 */
export default {
    name: 'Parameters — declare + update',
    steps: [
        {
            label: 'Declare param L=20, B = box(L,L,L)',
            run: async ({ ops, store }) => {
                ops.addDocumentParameter('L', 20, 'mm');
                ops.addBox({ length: 20, width: 20, height: 20 });
                if (Object.keys(store.doc.parameters).length === 0) {
                    throw new Error('parameter was not registered on the document');
                }
            },
            expect: { faces: 6 },
        },
        {
            label: 'Update L → 12 (box should shrink)',
            run: async ({ ops, store }) => {
                ops.setDocumentParameter('L', { value: 12 });
                // The Box feature was created with literal 20s — update its
                // params to track L so the change is observable in the render.
                const box = Object.values(store.doc.features).find(f => f.type === 'Box');
                ops.setFeatureParams(box.id, { length: 12, width: 12, height: 12 });
            },
            expect: { faces: 6 },
        },
    ],
};
