/**
 * Standalone transforms — Move, Rotate, Scale. Each transform feature
 * applies to the body produced by the upstream feature, so we chain one
 * primitive + one transform per case.
 */
export default {
    name: 'Transforms — Move / Rotate / Scale',
    steps: [
        {
            label: 'Box 10³',
            run: async ({ ops }) => { ops.addBox({ length: 10, width: 10, height: 10 }); },
        },
        {
            label: 'Move +X 20mm',
            run: async ({ ops, store }) => {
                const box = Object.values(store.doc.features).find(f => f.type === 'Box');
                ops.addMove(box.id, [20, 0, 0]);
            },
            expect: { faces: 6 },
        },
        {
            label: 'Reset → cylinder, rotate 45° about X',
            run: async ({ ops, store }) => {
                for (const id of Object.keys(store.doc.features)) ops.deleteFeature(id);
                const cyl = ops.addCylinder({ radius: 5, height: 20 });
                ops.addRotate(cyl.id, 'X', 45);
            },
            expect: { faces: 3 },
        },
        {
            label: 'Reset → box, scale ×1.5',
            run: async ({ ops, store }) => {
                for (const id of Object.keys(store.doc.features)) ops.deleteFeature(id);
                const b = ops.addBox({ length: 10, width: 10, height: 10 });
                ops.addScale(b.id, 1.5);
            },
            expect: { faces: 6 },
        },
    ],
};
