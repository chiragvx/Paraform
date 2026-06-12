/**
 * Patterns + Mirror. Catches transform-frame regressions where the copies
 * land in the wrong spot or with the wrong orientation.
 */
export default {
    name: 'Patterns — Linear / Circular / Mirror',
    steps: [
        {
            label: 'Cylinder r=2 h=10',
            run: async ({ ops }) => { ops.addCylinder({ radius: 2, height: 10 }); },
        },
        {
            label: 'Linear pattern × 4 along +X',
            run: async ({ ops, store }) => {
                const cyl = Object.values(store.doc.features).find(f => f.type === 'Cylinder');
                ops.addLinearPattern(cyl.id, { direction: 'X', count: 4, spacing: 8 });
            },
        },
        {
            label: 'Reset → cylinder, circular pattern × 6 around Z',
            run: async ({ ops, store }) => {
                for (const id of Object.keys(store.doc.features)) ops.deleteFeature(id);
                const cyl = ops.addCylinder({ radius: 2, height: 10 });
                ops.addMove(cyl.id, [10, 0, 0]);
                ops.addCircularPattern(cyl.id, { axis: 'Z', count: 6, angle: 360 });
            },
        },
        {
            label: 'Reset → box, mirror across YZ',
            run: async ({ ops, store }) => {
                for (const id of Object.keys(store.doc.features)) ops.deleteFeature(id);
                const b = ops.addBox({ length: 10, width: 10, height: 10 });
                ops.addMove(b.id, [10, 0, 0]);
                ops.addMirror(b.id, 'YZ');
            },
        },
    ],
};
