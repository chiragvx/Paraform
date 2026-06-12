/**
 * Helix on its own + a thread-style sweep (circle profile along helix path).
 */
export default {
    name: 'Helix + Sweep — thread profile',
    // Sweep-along-helix currently hangs the Python kernel (build123d 0.10.0).
    // Re-enable once the kernel-side fix lands. See the issue exposed by the
    // initial ui:validate sweep on 2026-05-30.
    skip: 'kernel hangs on sweep(circle, path=helix) — needs b123d_server fix',
    steps: [
        {
            label: 'Helix r=8, pitch=4, h=24',
            run: async ({ ops }) => {
                ops.addHelix({ pitch: 4, height: 24, radius: 8 });
            },
        },
        {
            label: 'Reset → circle profile r=1 + helix path → sweep',
            run: async ({ ops, sketch, store }) => {
                for (const id of Object.keys(store.doc.features)) ops.deleteFeature(id);
                const profile = sketch.circle('XY', 1);
                const path = ops.addHelix({ pitch: 4, height: 24, radius: 8 });
                ops.addSweep(profile.id, path.id);
            },
            expect: { minFaces: 2 },
        },
    ],
};
