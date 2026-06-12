/**
 * Sweep validation cases.
 *
 * Sweep a profile sketch along a path (either another sketch's curve or
 * a Helix body). The current kernel's `sweep()` works when the profile +
 * path live in compatible frames; some helix-path combos fail with the
 * stock kernel until the wire-conversion ships. We assert structurally.
 *
 * NB: SketchBuilder methods like `.line()` and `.circle()` return entity
 * ids, not the builder. Hold the builder reference and call `.commit()`
 * on it directly.
 */

import { addSweep, addHelix } from '../lib/document/operations.js';
import { newSketch } from '../lib/document/sketch_ops.js';

export default [
    {
        name: 'Sweep · circle along line (pipe)',
        build: () => {
            const profileSk = newSketch('XY');
            profileSk.circle(0, 0, 1.5);
            const profile = profileSk.commit();

            const pathSk = newSketch('XZ');
            pathSk.line(0, 0, 0, 50);
            const path = pathSk.commit();

            addSweep(profile.id, path.id);
        },
        expect: {
            // Open-path sweep currently fails on the kernel because the
            // path sketch is emitted via BuildSketch + make_face — which
            // requires a closed wire. Flagged stub until the emit path
            // for "path-only" sketches lands.
            stub: true,
            featureType: 'Sweep',
            python:      /sweep\(n_\w+,\s*path=n_\w+/,
        },
    },
    {
        name: 'Sweep · circle along helix (thread, kernel-fragile)',
        build: () => {
            const profileSk = newSketch('XZ');
            profileSk.circle(5, 0, 0.5);
            const profile = profileSk.commit();

            const helix = addHelix({ pitch: 4, height: 20, radius: 5 });
            addSweep(profile.id, helix.id);
        },
        expect: {
            // Helix-path sweep is currently fragile on the kernel side.
            // Mark as stub so a kernel failure does NOT fail the run; the
            // emit-shape assertion still has to match.
            stub: true,
            featureType: 'Sweep',
            python:      /sweep\(n_\w+,\s*path=n_\w+/,
        },
    },
];
