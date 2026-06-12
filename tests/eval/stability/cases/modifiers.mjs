/**
 * Stability cases — modifier features layered on a primitive.
 *
 * Modifiers (Fillet, Chamfer, Shell, Hole) produce descriptors whose
 * `parents` chain points back into the upstream primitive. Sweeping
 * either the modifier's own parameter OR the upstream primitive's
 * parameter MUST preserve the descriptor canonical strings — symbolic
 * tags + parent lineage are dimensionless.
 *
 * Threshold rationale:
 *   - Box + Fillet (radius change):    1.0 — pure radius sweep does not
 *     alter the set of filleted edges or any face on the parent box.
 *   - Box + Fillet (parent dim change): 1.0 — fillet's filleted-edge
 *     parents are descriptor-keyed, not coordinate-keyed.
 *   - Box + Shell (thickness change):  1.0 — shell descriptors are
 *     symbolic (outer/inner faces); thickness is a dimension.
 *   - Box + Hole (diameter change):    0.95 — the bore-side cylindrical
 *     faces are stable, but the kernel may re-emit the start/end
 *     vertices on the bore as new descriptors if it folds parallel
 *     near-degenerate edges differently at small diameters. Allow one
 *     bore-cap vertex/edge to migrate without failing the case; if
 *     more than ~5% migrate, the structural promise is broken.
 *   - Box + Chamfer (length change):   0.90 — chamfer chains are the
 *     known-fragile case in spec 14 (cited in the tracker as an
 *     xfail-on-strict naming corpus entry). When the chamfer length
 *     grows, OCCT may swap which edge wins at converging corners; the
 *     vast majority of descriptors persist but a small fraction migrate
 *     by design. Tracked separately under spec 14's "chamfer chains"
 *     residual.
 */

import {
  buildDoc,
  snapshotDescriptors,
  sweepParameter,
  assertDescriptorsPersist,
} from '../asserts.mjs';

const CUBE = { length: 40, width: 40, height: 40 };

export const cases = [
  {
    name: 'Box + Fillet: fillet radius 2 → 5 (filleted-face descriptor persists)',
    async run(page) {
      const { featureIds } = await buildDoc(page, [
        { type: 'Box',    id: 'box_x',  params: CUBE },
        { type: 'Fillet', id: 'fill_a', target: 'box_x', params: { radius: 2 } },
      ]);
      const before = await snapshotDescriptors(page);
      await sweepParameter(page, featureIds.fill_a, 'radius', 5);
      const after = await snapshotDescriptors(page);
      return assertDescriptorsPersist(before, after, { threshold: 1.0 });
    },
  },
  {
    name: 'Box + Fillet: box length 40 → 60 (filleted face\'s parent persists)',
    async run(page) {
      const { featureIds } = await buildDoc(page, [
        { type: 'Box',    id: 'box_x',  params: CUBE },
        { type: 'Fillet', id: 'fill_a', target: 'box_x', params: { radius: 2 } },
      ]);
      const before = await snapshotDescriptors(page);
      await sweepParameter(page, featureIds.box_x, 'length', 60);
      const after = await snapshotDescriptors(page);
      return assertDescriptorsPersist(before, after, { threshold: 1.0 });
    },
  },
  {
    name: 'Box + Shell: thickness 1 → 3',
    async run(page) {
      const { featureIds } = await buildDoc(page, [
        { type: 'Box',   id: 'box_x',   params: CUBE },
        { type: 'Shell', id: 'shell_a', target: 'box_x', params: { thickness: 1 } },
      ]);
      const before = await snapshotDescriptors(page);
      await sweepParameter(page, featureIds.shell_a, 'thickness', 3);
      const after = await snapshotDescriptors(page);
      return assertDescriptorsPersist(before, after, { threshold: 1.0 });
    },
  },
  {
    name: 'Box + Hole: diameter 8 → 14 (bore-side descriptors persist ≥ 95%)',
    async run(page) {
      const { featureIds } = await buildDoc(page, [
        { type: 'Box',  id: 'box_x',  params: CUBE },
        { type: 'Hole', id: 'hole_a', target: 'box_x',
          params: { diameter: 8, depth: 50, through: true } },
      ]);
      const before = await snapshotDescriptors(page);
      await sweepParameter(page, featureIds.hole_a, 'diameter', 14);
      const after = await snapshotDescriptors(page);
      // 0.95 — bore-cap vertex/edge may migrate at extreme diameter ratios;
      // bore-side cylindrical face must persist. See file header for rationale.
      return assertDescriptorsPersist(before, after, { threshold: 0.95 });
    },
  },
  {
    name: 'Box + Chamfer: length 2 → 4 (chamfer chain — known-fragile)',
    async run(page) {
      const { featureIds } = await buildDoc(page, [
        { type: 'Box',     id: 'box_x',   params: CUBE },
        { type: 'Chamfer', id: 'cham_a',  target: 'box_x', params: { length: 2 } },
      ]);
      const before = await snapshotDescriptors(page);
      await sweepParameter(page, featureIds.cham_a, 'length', 4);
      const after = await snapshotDescriptors(page);
      // 0.90 — chamfer chains are listed as xfail-on-strict in spec 14's
      // naming corpus. Edge-converging corners may re-tag; tighten as
      // chamfer naming hardens.
      return assertDescriptorsPersist(before, after, { threshold: 0.90 });
    },
  },
];
