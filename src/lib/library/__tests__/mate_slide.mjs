/**
 * Slide-along-channel — computeSlidPlacement (the "," / "." keyboard nudge).
 *
 * Run via:
 *   node src/lib/library/__tests__/mate_slide.mjs
 *
 * Proves the post-placement slide-adjust math: starting from a placed,
 * channel-mated t-nut, computeSlidPlacement returns a new component origin
 * that has moved along the host run by `deltaMm`, preserves seat depth + roll,
 * clamps to the host extent, and bails (null) for non-channel mates so the
 * keyboard handler can fall through.
 */

import assert from 'node:assert/strict';

import { slotPortsForExtrusion } from '../profiles.js';
import { worldConnectorFor } from '../mate_solver.js';
import { computeSlidPlacement } from '../orient.js';
import { makeConnector } from '../../../../lib/document/types.js';

let _pass = 0, _fail = 0;
function t(name, fn) {
    try { fn(); console.log(`  ok  ${name}`); _pass++; }
    catch (e) { console.error(`  FAIL ${name}\n    ${e?.stack || e?.message || e}`); _fail++; }
}
const approx = (a, b, eps = 1e-3) => Math.abs(a - b) <= eps;

const EXT_2020_250 = {
    id: 'lib-part-ext-2020-250',
    name: '2020 T-slot extrusion, 250 mm',
    category: 'extrusion',
    source: 'parametric',
    connectors: [
        { id: 'end-bottom', kind: 'planar', gender: 'neutral', axis: [0, 0, -1], origin: [0, 0, 0],
          interfaceId: 'profile-2020', mates_with: ['planar'],
          size: { nominal: 20, unit: 'mm' } },
        { id: 'end-top', kind: 'planar', gender: 'neutral', axis: [0, 0, 1], origin: [0, 0, 250],
          interfaceId: 'profile-2020', mates_with: ['planar'],
          size: { nominal: 20, unit: 'mm' } },
    ],
    boundingBox: { min: [-10, -10, 0], max: [10, 10, 250] },
};

/**
 * Build a synthetic doc with an extrusion host + a t-nut child mated to one
 * slot. Returns { doc, hostComponentId, partComponentId, slotConnectorId,
 * partConnectorId, mateId, hostWorld, slotAxis }.
 */
function buildScene() {
    const hostComponentId = 'host-ext';
    const partComponentId = 'part-tnut';

    // Generate the slot ports for a 2020-250 and pick the +X face one.
    const slots = slotPortsForExtrusion(EXT_2020_250);
    const slotPlusX = slots.find((p) => p.normal[0] > 0.5);
    if (!slotPlusX) throw new Error('+X slot not generated');
    // Re-parent the slot port to the placed host component.
    const hostSlot = makeConnector({
        ...slotPlusX, parent: hostComponentId,
    });

    // The t-nut's rail port (mirrors nuts.json after v2 upgrade).
    const partRail = makeConnector({
        id: 'rail-slide', parent: partComponentId, kind: 'rail', gender: 'neutral',
        size: { nominal: 'M5', unit: 'mm' },
        axis: [1, 0, 0], origin: [0, 0, 1], normal: [0, 0, 1],
        topology: 'line', profile: 'tslot-2020', fit: 'detent',
        mates_with: ['rail', 'slot'], inducedJoint: 'prismatic',
    });

    const mate = {
        id: 'mate-1',
        hostConnectorRef: { connectorId: hostSlot.id },
        partConnectorRef: { connectorId: partRail.id, sourceConnectorId: 'rail-slide' },
        componentId: partComponentId,
        offset: null,
        inducedJoint: { id: null, kind: 'prismatic' },
    };

    const doc = {
        components: {
            [hostComponentId]: { id: hostComponentId, kind: 'component',
                origin: { position: [0, 0, 0], rotation: [0, 0, 0] }, parentId: null },
            [partComponentId]: { id: partComponentId, kind: 'component',
                origin: { position: [0, 0, 0], rotation: [0, 0, 0] }, parentId: null },
        },
        connectors: {
            [hostSlot.id]: hostSlot,
            [partRail.id]: partRail,
        },
        mates: { [mate.id]: mate },
    };

    const hostWorld = worldConnectorFor(doc, hostSlot);
    return {
        doc, hostComponentId, partComponentId,
        slotConnectorId: hostSlot.id, partConnectorId: partRail.id, mateId: mate.id,
        hostWorld, slotAxis: hostWorld.axis,
    };
}

console.log('── slide-along-channel — computeSlidPlacement ──');

t('returns null for missing/invalid inputs', () => {
    assert.equal(computeSlidPlacement(null, 'x', 5), null);
    assert.equal(computeSlidPlacement({}, '', 5), null);
    const { doc, partComponentId } = buildScene();
    assert.equal(computeSlidPlacement(doc, partComponentId, NaN), null);
    assert.equal(computeSlidPlacement(doc, 'no-such-component', 5), null);
});

t('returns null when the selection has no mate (free placement)', () => {
    const { doc, partComponentId } = buildScene();
    doc.mates = {};
    assert.equal(computeSlidPlacement(doc, partComponentId, 5), null);
});

t('a +10 mm nudge from persisted slide=0 lands at slide=10 along the run', () => {
    const scene = buildScene();
    // Seat the part by setting offset.slide=0 — _currentSlide reads it
    // directly instead of projecting the unmoved component origin.
    scene.doc.mates[scene.mateId].offset = { slide: 0 };
    const res = computeSlidPlacement(scene.doc, scene.partComponentId, 10);
    assert.ok(res && res.regime === 'channel', `regime ${res && res.regime}`);
    assert.ok(approx(res.slide, 10), `slide=${res.slide}`);
    // The component origin should have moved by +10 mm along the host run.
    scene.doc.mates[scene.mateId].offset = { slide: 0 };
    const base = computeSlidPlacement(scene.doc, scene.partComponentId, 0);
    const dp = [
        res.origin.position[0] - base.origin.position[0],
        res.origin.position[1] - base.origin.position[1],
        res.origin.position[2] - base.origin.position[2],
    ];
    const a = scene.slotAxis;
    const along = dp[0] * a[0] + dp[1] * a[1] + dp[2] * a[2];
    assert.ok(approx(along, 10, 1e-3), `along-axis Δ=${along}`);
});

t('successive nudges accumulate via the persisted offset.slide', () => {
    const scene = buildScene();
    // Persist a known base; the next nudge should add to it.
    scene.doc.mates[scene.mateId].offset = { slide: 10 };
    const r2 = computeSlidPlacement(scene.doc, scene.partComponentId, 7);
    assert.ok(approx(r2.slide, 17), `slide after persisted=10 + 7 = ${r2.slide}`);
});

t('nudge with no persisted offset projects the current part seat onto the run', () => {
    // Real-world flow: after a fresh placement, the part component sits at the
    // mate-solved position and there is no offset.slide yet. The next nudge
    // should read the part's current seat (projection onto the host axis) and
    // add to it. This test mirrors that flow.
    const scene = buildScene();
    // Move the part component so its connector world-origin projects to +30
    // mm along the host axis. Host slot axis is +Z, host origin is (10,0,125).
    // Part connector is at part-local (0,0,1). With component origin at
    // (0,0,154), the part connector lands at world (0,0,155), which projects
    // to (155 - 125) = +30 along +Z.
    scene.doc.components[scene.partComponentId].origin =
        { position: [0, 0, 154], rotation: [0, 0, 0] };
    const res = computeSlidPlacement(scene.doc, scene.partComponentId, 5);
    assert.ok(approx(res.slide, 35, 1e-2), `projected base 30 + 5 = ${res.slide}`);
});

t('slide is clamped to the host extent (cannot run off the channel)', () => {
    const scene = buildScene();
    const ext = scene.hostWorld.extent;            // ~{-117, +117} for 250 mm
    assert.ok(ext, 'host has extent');
    // Push beyond the +extent end.
    const huge = computeSlidPlacement(scene.doc, scene.partComponentId, ext.to + 200);
    assert.ok(approx(huge.slide, ext.to), `clamped to ${ext.to}, got ${huge.slide}`);
    // Push beyond the -extent end.
    const tiny = computeSlidPlacement(scene.doc, scene.partComponentId, ext.from - 200);
    assert.ok(approx(tiny.slide, ext.from), `clamped to ${ext.from}, got ${tiny.slide}`);
});

t('returns null for a non-channel mate (planar host)', () => {
    const scene = buildScene();
    // Replace the slot host with a planar end face — same id so the mate
    // points at it, but topology / extent gone.
    scene.doc.connectors[scene.slotConnectorId] = makeConnector({
        id: scene.slotConnectorId, parent: scene.hostComponentId,
        kind: 'planar', gender: 'neutral', axis: [0, 0, 1], origin: [0, 0, 250],
        mates_with: ['planar'], size: { nominal: 20, unit: 'mm' },
        interfaceId: 'profile-2020',
    });
    assert.equal(computeSlidPlacement(scene.doc, scene.partComponentId, 5), null);
});

t('opts.baseSlide overrides the persisted base (live-edit accumulator)', () => {
    // The keyboard handler tracks a transient slide locally during a rapid
    // key-mash and re-solves from that base each press, without writing the
    // intermediate value back to the doc. Verify that passing baseSlide:N
    // makes a +Δ press land at N+Δ, ignoring what the mate offset currently
    // says.
    const scene = buildScene();
    scene.doc.mates[scene.mateId].offset = { slide: 0 };
    const res = computeSlidPlacement(scene.doc, scene.partComponentId, 3, { baseSlide: 50 });
    assert.ok(approx(res.slide, 53), `baseSlide=50 + 3 = ${res.slide}`);
});

t('preserves the persisted roll when re-solving the slide', () => {
    const scene = buildScene();
    const roll = Math.PI;       // 180° flip in the channel
    scene.doc.mates[scene.mateId].offset = { roll, slide: 0 };
    const res = computeSlidPlacement(scene.doc, scene.partComponentId, 15);
    assert.ok(approx(res.roll, roll), `roll preserved: ${res.roll}`);
    assert.ok(approx(res.slide, 15));
});

console.log(`\n  ${_pass} passed, ${_fail} failed`);
if (_fail > 0) process.exit(1);
