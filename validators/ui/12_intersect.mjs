/**
 * Intersect — keep only the common volume of two overlapping primitives.
 */
export default {
    name: 'Boolean — Intersect',
    steps: [
        {
            label: 'Box 20³',
            run: async ({ ops }) => { ops.addBox({ length: 20, width: 20, height: 20 }); },
        },
        {
            label: 'Sphere r=12',
            run: async ({ ops }) => { ops.addSphere({ radius: 12 }); },
        },
        {
            label: 'Intersect → rounded-corner cube',
            run: async ({ ops, store }) => {
                const feats = Object.values(store.doc.features);
                const box = feats.find(f => f.type === 'Box');
                const sph = feats.find(f => f.type === 'Sphere');
                ops.addIntersect([box.id, sph.id]);
            },
            expect: { minFaces: 1 },
        },
    ],
};
