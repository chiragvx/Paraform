/**
 * Boolean operations — Cut and Union. Visual sanity check that the
 * resulting body has the expected hole / merged silhouette.
 */
export default {
    name: 'Booleans — Cut, Union',
    steps: [
        {
            label: 'Box 30×30×20',
            run: async ({ ops }) => { ops.addBox({ length: 30, width: 30, height: 20 }); },
        },
        {
            label: 'Add Cylinder r=6 h=30 (tool)',
            run: async ({ ops }) => { ops.addCylinder({ radius: 6, height: 30 }); },
        },
        {
            label: 'Cut: box − cylinder',
            run: async ({ ops, store }) => {
                const features = Object.values(store.doc.features);
                const box = features.find(f => f.type === 'Box');
                const cyl = features.find(f => f.type === 'Cylinder');
                ops.addCut(box.id, [cyl.id]);
            },
            expect: { minFaces: 7 },
        },
        {
            label: 'Reset → two offset cylinders + union',
            run: async ({ ops, store }) => {
                for (const id of Object.keys(store.doc.features)) ops.deleteFeature(id);
                const a = ops.addCylinder({ radius: 8, height: 20 });
                const b = ops.addCylinder({ radius: 8, height: 20 });
                ops.addMove(b.id, [10, 0, 0]);
                ops.addUnion([a.id, b.id]);
            },
            expect: { minFaces: 3 },
        },
    ],
};
