/**
 * Loft — connect two sketches into a single solid. Loft only produces a
 * 3D body when its input sketches lie on DIFFERENT planes; two coplanar
 * sketches degenerate into a flat sheet (1 face, 0 edges). So the bottom
 * sketch sits on XY at Z=0 and the top sketch sits on a parallel plane
 * offset to a positive Z — emitted as a raw `Plane(origin=…, z_dir=…)`
 * via the 'face' planeRef shape that the sketcher already understands.
 *
 * NB: step `run` functions are serialised + evaluated inside the page, so
 * any helpers they need must be defined inline (no closures from this
 * module reach the eval'd code).
 */
export default {
    name: 'Loft — square (Z=0) → circle (Z=18)',
    cameraDir: [1, -1, 1.2],
    steps: [
        {
            label: 'Square Z=0 + circle Z=18 → loft',
            run: async ({ ops, sketch, store }) => {
                const planeAt = (z) => ({ kind: 'face', origin: [0, 0, z], normal: [0, 0, 1] });
                sketch.rect('XY', 20, 20);
                sketch.circle(planeAt(18), 8);
                const sketches = Object.values(store.doc.features)
                    .filter(f => f.type === 'Sketch').map(f => f.id);
                ops.addLoft(sketches);
            },
            expect: { minFaces: 3 },
        },
        {
            label: 'Reset → square Z=0 + hexagon Z=20 → loft',
            run: async ({ ops, sketch, store }) => {
                const planeAt = (z) => ({ kind: 'face', origin: [0, 0, z], normal: [0, 0, 1] });
                for (const id of Object.keys(store.doc.features)) ops.deleteFeature(id);
                sketch.rect('XY', 20, 20);
                sketch.polygon(planeAt(20), 6, 6);
                const sketches = Object.values(store.doc.features)
                    .filter(f => f.type === 'Sketch').map(f => f.id);
                ops.addLoft(sketches);
            },
            expect: { minFaces: 3 },
        },
    ],
};
