/**
 * Shell — hollow a body. build123d's offset() can only shell a Solid when
 * at least one face is opened, so we exercise the two realistic flavours:
 *   - tray (one +Z face open, thick walls so the cavity reads visually)
 *   - tube (both +Z and -Z open, thin walls)
 */
export default {
    name: 'Shell — open-face tray + open-both-ends tube',
    // Tilt slightly over the top so the tray's cavity reads, but keep
    // the side walls visible so you can tell tray-from-tube at a glance.
    cameraDir: [0.85, -0.85, 1.3],
    steps: [
        {
            label: 'Box 30×30×14',
            run: async ({ ops }) => { ops.addBox({ length: 30, width: 30, height: 14 }); },
            expect: { faces: 6, edges: 12 },
        },
        {
            label: 'Pick +Z face',
            waitRender: false,
            run: async ({ store, picking, getLastTopology, pickNearestFace }) => {
                const t = getLastTopology();
                const box = Object.values(store.doc.features).find(f => f.type === 'Box');
                const hit = pickNearestFace([0, 0, 7], [0, 0, 1], t);
                picking.clear();
                picking.add(hit.descriptor, {
                    center: hit.center, normal: [0, 0, 1], featureId: box.id,
                });
            },
        },
        {
            label: 'Shell +Z open, thk=2.5 (tray)',
            run: async ({ ops, store, picking, refs }) => {
                const box = Object.values(store.doc.features).find(f => f.type === 'Box');
                const openFaces = refs.entriesToFaceRefs(picking.toArray());
                ops.addShell(box.id, { thickness: 2.5, openFaces });
            },
            expect: { minFaces: 9 },
        },
        {
            label: 'Reset → fresh 30×30×20 box',
            run: async ({ ops, store }) => {
                for (const id of Object.keys(store.doc.features)) ops.deleteFeature(id);
                ops.addBox({ length: 30, width: 30, height: 20 });
            },
            expect: { faces: 6, edges: 12 },
        },
        {
            label: 'Pick +Z and -Z faces',
            waitRender: false,
            run: async ({ store, picking, getLastTopology, pickNearestFace }) => {
                const t = getLastTopology();
                const box = Object.values(store.doc.features).find(f => f.type === 'Box');
                const top = pickNearestFace([0, 0, 10],  [0, 0, 1],  t);
                const bot = pickNearestFace([0, 0, -10], [0, 0, -1], t);
                picking.clear();
                picking.add(top.descriptor, { center: top.center, normal: [0, 0, 1],  featureId: box.id });
                picking.add(bot.descriptor, { center: bot.center, normal: [0, 0, -1], featureId: box.id });
            },
        },
        {
            label: 'Shell open ±Z (tube), thk=1.5',
            run: async ({ ops, store, picking, refs }) => {
                const box = Object.values(store.doc.features).find(f => f.type === 'Box');
                const openFaces = refs.entriesToFaceRefs(picking.toArray());
                ops.addShell(box.id, { thickness: 1.5, openFaces });
            },
            expect: { minFaces: 8 },
        },
    ],
};
