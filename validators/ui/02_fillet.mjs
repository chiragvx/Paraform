/**
 * Fillet — both the "round every edge" path and the picked-edge path.
 *
 * The picked-edge case uses pickNearestEdge against the live topology to
 * recover the descriptor for the top-front edge of a centered 20mm box,
 * adds it to the picking selection, and only that edge gets rounded.
 */
export default {
    name: 'Fillet — all edges + selected edge',
    steps: [
        {
            label: 'Box 20³',
            run: async ({ ops }) => { ops.addBox({ length: 20, width: 20, height: 20 }); },
            expect: { faces: 6, edges: 12 },
        },
        {
            label: 'Fillet all edges, r=2',
            run: async ({ ops, store }) => {
                const box = Object.values(store.doc.features).find(f => f.type === 'Box');
                ops.addFillet(box.id, { radius: 2 });
            },
            expect: { minFaces: 14 },
        },
        {
            label: 'Reset → fresh box 20³',
            run: async ({ ops, store }) => {
                for (const id of Object.keys(store.doc.features)) ops.deleteFeature(id);
                ops.addBox({ length: 20, width: 20, height: 20 });
            },
            expect: { faces: 6, edges: 12 },
        },
        {
            label: 'Pick top-front edge',
            // Pure-selection step — no kernel call, so don't wait for a regen.
            waitRender: false,
            run: async ({ store, picking, getLastTopology, pickNearestEdge }) => {
                const t = getLastTopology();
                const box = Object.values(store.doc.features).find(f => f.type === 'Box');
                const hit = pickNearestEdge([0, -10, 10], t);
                picking.clear();
                picking.add(hit.descriptor, {
                    center: hit.center,
                    normal: [0, 0, 1],
                    featureId: box.id,
                });
            },
        },
        {
            label: 'Fillet selected edge only, r=3',
            run: async ({ ops, store, picking, refs }) => {
                const box = Object.values(store.doc.features).find(f => f.type === 'Box');
                const edgeRefs = refs.entriesToEdgeRefs(picking.toArray());
                ops.addFillet(box.id, { radius: 3, edges: edgeRefs });
            },
            // 6 box faces + 1 cylindrical fillet face from rounding one edge.
            expect: { minFaces: 7 },
        },
    ],
};
