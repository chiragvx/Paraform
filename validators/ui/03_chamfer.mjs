/**
 * Chamfer — all edges of a cube, then a single edge by picker. Visually
 * paired with the fillet scenario so any sign / normal regression that
 * mangles one will show up against the other.
 */
export default {
    name: 'Chamfer — all edges + selected edge',
    steps: [
        {
            label: 'Box 20³',
            run: async ({ ops }) => { ops.addBox({ length: 20, width: 20, height: 20 }); },
        },
        {
            label: 'Chamfer all edges, len=1.5',
            run: async ({ ops, store }) => {
                const box = Object.values(store.doc.features).find(f => f.type === 'Box');
                ops.addChamfer(box.id, { length: 1.5 });
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
            label: 'Pick vertical corner edge',
            waitRender: false,
            run: async ({ store, picking, getLastTopology, pickNearestEdge }) => {
                const t = getLastTopology();
                const box = Object.values(store.doc.features).find(f => f.type === 'Box');
                const hit = pickNearestEdge([10, 10, 0], t);
                picking.clear();
                picking.add(hit.descriptor, {
                    center: hit.center, normal: [0, 0, 1], featureId: box.id,
                });
            },
        },
        {
            label: 'Chamfer selected edge, len=2',
            run: async ({ ops, store, picking, refs }) => {
                const box = Object.values(store.doc.features).find(f => f.type === 'Box');
                const edgeRefs = refs.entriesToEdgeRefs(picking.toArray());
                ops.addChamfer(box.id, { length: 2, edges: edgeRefs });
            },
            expect: { minFaces: 7 },
        },
    ],
};
