/**
 * Stability cases — pattern features.
 *
 * Pattern descriptors carry an `inst[i]` ordinal in `part`. Sweeping:
 *   - the source dimension: all instance descriptors persist (1.0)
 *   - the spacing:           all instance descriptors persist (1.0) —
 *                            spacing is a placement parameter, not a
 *                            topological one
 *   - the count (N → N+k):   the first N inst[i] descriptors persist;
 *                            the k new ones appear as `added`. That's a
 *                            structural addition, not a migration, and
 *                            the persistence rate is 1.0 for "the
 *                            descriptors that already existed".
 *
 * Threshold rationale:
 *   - Pattern count change (3 → 5):  0.95 — first 3 inst[i] descriptors
 *     must persist, but the kernel's pattern naming for boundary
 *     instances can shift when the array length crosses a divisor
 *     boundary (also called out in spec 14 as an xfail-on-strict
 *     residual). Tighten to 1.0 once pattern boundary instances are
 *     locked.
 *   - Pattern spacing change:        1.0 — spacing is a pure placement
 *     dim; topology of the instances is invariant.
 *   - Source dim change:             1.0 — the source body's descriptors
 *     are reborn at the new dimension; pattern just re-applies the
 *     placement, so every inst[i] keeps its ordinal.
 */

import {
  buildDoc,
  snapshotDescriptors,
  sweepParameter,
  assertDescriptorsPersist,
} from '../asserts.mjs';

const CUBE = { length: 10, width: 10, height: 10 };

export const cases = [
  {
    name: 'LinearPattern: count 3 → 5 (first 3 inst[i] descriptors persist)',
    async run(page) {
      const { featureIds } = await buildDoc(page, [
        { type: 'Box',           id: 'box_x',  params: CUBE },
        { type: 'LinearPattern', id: 'lpat_a', target: 'box_x',
          params: { direction: 'X', count: 3, spacing: 15 } },
      ]);
      const before = await snapshotDescriptors(page);
      await sweepParameter(page, featureIds.lpat_a, 'count', 5);
      const after = await snapshotDescriptors(page);
      // 0.95 — boundary instances may re-tag (see file header).
      return assertDescriptorsPersist(before, after, { threshold: 0.95 });
    },
  },
  {
    name: 'LinearPattern: spacing 15 → 25',
    async run(page) {
      const { featureIds } = await buildDoc(page, [
        { type: 'Box',           id: 'box_x',  params: CUBE },
        { type: 'LinearPattern', id: 'lpat_a', target: 'box_x',
          params: { direction: 'X', count: 3, spacing: 15 } },
      ]);
      const before = await snapshotDescriptors(page);
      await sweepParameter(page, featureIds.lpat_a, 'spacing', 25);
      const after = await snapshotDescriptors(page);
      return assertDescriptorsPersist(before, after, { threshold: 1.0 });
    },
  },
  {
    name: 'LinearPattern: source box length 10 → 20',
    async run(page) {
      const { featureIds } = await buildDoc(page, [
        { type: 'Box',           id: 'box_x',  params: CUBE },
        { type: 'LinearPattern', id: 'lpat_a', target: 'box_x',
          params: { direction: 'X', count: 3, spacing: 15 } },
      ]);
      const before = await snapshotDescriptors(page);
      await sweepParameter(page, featureIds.box_x, 'length', 20);
      const after = await snapshotDescriptors(page);
      return assertDescriptorsPersist(before, after, { threshold: 1.0 });
    },
  },
];
