/**
 * Stability cases — primitive features.
 *
 * For a primitive (Box / Cylinder / Sphere / Torus), every face / edge /
 * vertex descriptor is symbolic — `+Z`, `axis`, `+X+Y+Z` — and contains
 * no geometry. Sweeping a parameter (length, radius, height) MUST not
 * change any descriptor: the symbolic tags are derived from the
 * primitive's topology, which is invariant under dimensional scaling.
 *
 * Threshold: 1.0 (100%) for every primitive case. Anything less is a
 * regression — the kernel re-tagged a face/edge/vertex it should have
 * kept stable.
 */

import {
  buildDoc,
  snapshotDescriptors,
  sweepParameter,
  assertDescriptorsPersist,
} from '../asserts.mjs';

export const cases = [
  {
    name: 'Box: length 10 → 20 (all face/edge/vertex descriptors persist)',
    async run(page) {
      const { featureIds } = await buildDoc(page, [
        { type: 'Box', id: 'box_x', params: { length: 10, width: 10, height: 10 } },
      ]);
      const before = await snapshotDescriptors(page);
      await sweepParameter(page, featureIds.box_x, 'length', 20);
      const after = await snapshotDescriptors(page);
      return assertDescriptorsPersist(before, after, { threshold: 1.0 });
    },
  },
  {
    name: 'Box: width 10 → 25',
    async run(page) {
      const { featureIds } = await buildDoc(page, [
        { type: 'Box', id: 'box_x', params: { length: 10, width: 10, height: 10 } },
      ]);
      const before = await snapshotDescriptors(page);
      await sweepParameter(page, featureIds.box_x, 'width', 25);
      const after = await snapshotDescriptors(page);
      return assertDescriptorsPersist(before, after, { threshold: 1.0 });
    },
  },
  {
    name: 'Box: height 10 → 5 (downward sweep still preserves descriptors)',
    async run(page) {
      const { featureIds } = await buildDoc(page, [
        { type: 'Box', id: 'box_x', params: { length: 10, width: 10, height: 10 } },
      ]);
      const before = await snapshotDescriptors(page);
      await sweepParameter(page, featureIds.box_x, 'height', 5);
      const after = await snapshotDescriptors(page);
      return assertDescriptorsPersist(before, after, { threshold: 1.0 });
    },
  },
  {
    name: 'Box: uniform-scale-like multi-sweep (length, width, height all change)',
    async run(page) {
      const { featureIds } = await buildDoc(page, [
        { type: 'Box', id: 'box_x', params: { length: 10, width: 10, height: 10 } },
      ]);
      const before = await snapshotDescriptors(page);
      // Three sequential single-param sweeps — emulates a parametric driver
      // adjusting a uniform scale.
      await sweepParameter(page, featureIds.box_x, 'length', 20);
      await sweepParameter(page, featureIds.box_x, 'width', 20);
      await sweepParameter(page, featureIds.box_x, 'height', 20);
      const after = await snapshotDescriptors(page);
      return assertDescriptorsPersist(before, after, { threshold: 1.0 });
    },
  },
  {
    name: 'Cylinder: radius 5 → 12',
    async run(page) {
      const { featureIds } = await buildDoc(page, [
        { type: 'Cylinder', id: 'cyl_a', params: { radius: 5, height: 10 } },
      ]);
      const before = await snapshotDescriptors(page);
      await sweepParameter(page, featureIds.cyl_a, 'radius', 12);
      const after = await snapshotDescriptors(page);
      return assertDescriptorsPersist(before, after, { threshold: 1.0 });
    },
  },
  {
    name: 'Cylinder: height 10 → 30',
    async run(page) {
      const { featureIds } = await buildDoc(page, [
        { type: 'Cylinder', id: 'cyl_a', params: { radius: 5, height: 10 } },
      ]);
      const before = await snapshotDescriptors(page);
      await sweepParameter(page, featureIds.cyl_a, 'height', 30);
      const after = await snapshotDescriptors(page);
      return assertDescriptorsPersist(before, after, { threshold: 1.0 });
    },
  },
  {
    name: 'Sphere: radius 5 → 15',
    async run(page) {
      const { featureIds } = await buildDoc(page, [
        { type: 'Sphere', id: 'sph_a', params: { radius: 5 } },
      ]);
      const before = await snapshotDescriptors(page);
      await sweepParameter(page, featureIds.sph_a, 'radius', 15);
      const after = await snapshotDescriptors(page);
      return assertDescriptorsPersist(before, after, { threshold: 1.0 });
    },
  },
];
