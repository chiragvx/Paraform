/**
 * Hole — simple straight hole, counterbore, countersink. Hole-on-picked-face
 * is currently stubbed in the kernel (see validators/picking.mjs), so we
 * just exercise the default-axis cases here.
 */
export default {
    name: 'Hole — simple / counterbore / countersink',
    // Mild top-bias — close enough to iso to keep depth cues but lifted
    // enough that the hole opening on +Z reads from above.
    cameraDir: [0.85, -0.85, 1.3],
    // Section the body along +Y through the centre so the hole's interior
    // walls and bottom are visible in cross-section. Without this a blind
    // hole's bottom disc lights up identically to the top face and the
    // hole becomes invisible from any iso angle.
    sectionAxis: 'y',
    steps: [
        {
            label: 'Box 30×30×20',
            run: async ({ ops }) => { ops.addBox({ length: 30, width: 30, height: 20 }); },
        },
        {
            label: 'Simple hole Ø5 × 10 deep',
            run: async ({ ops, store }) => {
                const box = Object.values(store.doc.features).find(f => f.type === 'Box');
                ops.addHole(box.id, { diameter: 5, depth: 10 });
            },
            expect: { minFaces: 7 },
        },
        {
            label: 'Reset → counterbore Ø5 / cbore Ø10 × 3',
            run: async ({ ops, store }) => {
                for (const id of Object.keys(store.doc.features)) ops.deleteFeature(id);
                const b = ops.addBox({ length: 30, width: 30, height: 20 });
                ops.addHole(b.id, {
                    type: 'counterbore',
                    diameter: 5, depth: 12,
                    counterDia: 10, counterDepth: 3,
                });
            },
            expect: { minFaces: 8 },
        },
        {
            label: 'Reset → countersink Ø3 / csink Ø8',
            run: async ({ ops, store }) => {
                for (const id of Object.keys(store.doc.features)) ops.deleteFeature(id);
                const b = ops.addBox({ length: 30, width: 30, height: 20 });
                ops.addHole(b.id, {
                    type: 'countersink',
                    diameter: 3, depth: 12,
                    counterDia: 8,
                });
            },
            expect: { minFaces: 8 },
        },
        {
            label: 'Reset → through-hole Ø6',
            run: async ({ ops, store }) => {
                for (const id of Object.keys(store.doc.features)) ops.deleteFeature(id);
                const b = ops.addBox({ length: 30, width: 30, height: 20 });
                ops.addHole(b.id, { diameter: 6, through: true });
            },
            expect: { minFaces: 7 },
        },
    ],
};
