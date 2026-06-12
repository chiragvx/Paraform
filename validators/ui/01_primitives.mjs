/**
 * Primitives — bare-minimum feature creation. Catches kernel regressions in
 * the basic shape calls and confirms the renderer is mounting GLBs.
 */
export default {
    name: 'Primitives — Box / Sphere / Cylinder / Torus',
    steps: [
        {
            label: 'Empty viewport',
        },
        {
            label: 'Add Box 20×20×20',
            run: async ({ ops }) => { ops.addBox({ length: 20, width: 20, height: 20 }); },
            expect: { features: 1, faces: 6, edges: 12 },
        },
        {
            label: 'Reset, add Sphere r=10',
            run: async ({ ops, store }) => {
                for (const id of Object.keys(store.doc.features)) ops.deleteFeature(id);
                ops.addSphere({ radius: 10 });
            },
            expect: { features: 1, minFaces: 1 },
        },
        {
            label: 'Reset, add Cylinder r=8 h=20',
            run: async ({ ops, store }) => {
                for (const id of Object.keys(store.doc.features)) ops.deleteFeature(id);
                ops.addCylinder({ radius: 8, height: 20 });
            },
            expect: { features: 1, faces: 3, edges: 3 },
        },
        {
            label: 'Reset, add Torus 12/3',
            run: async ({ ops, store }) => {
                for (const id of Object.keys(store.doc.features)) ops.deleteFeature(id);
                ops.addTorus({ majorRadius: 12, minorRadius: 3 });
            },
            expect: { features: 1, minFaces: 1 },
        },
    ],
};
