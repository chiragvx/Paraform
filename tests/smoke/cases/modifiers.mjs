/**
 * Smoke cases for modifier features (fillet / chamfer / shell / hole).
 *
 * Each case seeds a 40-cube via `v4.addBox`, then applies a modifier and
 * asserts:
 *   - the kernel ran (lastCompileMs > 0),
 *   - no error chip surfaced,
 *   - exactly one body-emitting feature remains (the modifier consumes its
 *     source — the input box's `outputs.bodies` is emptied),
 *   - and for fillet/chamfer/shell, the world-space bbox matches the input
 *     cube within 1 mm (rounding / hollowing changes corners and walls but
 *     not the outer extents).
 *
 * Box defaults via the addBox op: centered=true XY, Align.MIN on Z. So a
 * 40-cube spans X:[-20,20], Y:[-20,20], Z:[0,40].
 *
 * Skipped: Offset3D — not exposed by lib/document/operations.js (no
 * `v4.addOffset3D` helper to call).
 */

import {
  resetDocument,
  v4Call,
  waitForRender,
  assertBodyEmittingCount,
  assertNoKernelError,
  assertKernelRan,
  assertBodyBBoxApprox,
} from '../asserts.mjs';

const CUBE = { length: 40, width: 40, height: 40 };
const CUBE_MIN = [-20, -20, 0];
const CUBE_MAX = [20, 20, 40];

/** Pull the last `n` feature ids out of the document's timeline order. */
async function lastFeatureIds(page, n) {
  return await page.evaluate((count) => {
    const order = window.__paraform__.getStore().doc.featureOrder || [];
    return order.slice(-count);
  }, n);
}

export const cases = [
  {
    name: 'fillet a 40-cube (radius 2)',
    async run(page) {
      await resetDocument(page);
      await v4Call(page, 'addBox', CUBE);
      await waitForRender(page);
      const [boxId] = await lastFeatureIds(page, 1);
      await v4Call(page, 'addFillet', boxId, { radius: 2 });
      await waitForRender(page);
      await assertKernelRan(page);
      await assertNoKernelError(page);
      await assertBodyEmittingCount(page, 1);
      // Rounding only carves corners — outer bbox is unchanged.
      await assertBodyBBoxApprox(page, CUBE_MIN, CUBE_MAX, 1.0);
    },
  },
  {
    name: 'chamfer a 40-cube (length 2)',
    async run(page) {
      await resetDocument(page);
      await v4Call(page, 'addBox', CUBE);
      await waitForRender(page);
      const [boxId] = await lastFeatureIds(page, 1);
      await v4Call(page, 'addChamfer', boxId, { length: 2 });
      await waitForRender(page);
      await assertKernelRan(page);
      await assertNoKernelError(page);
      await assertBodyEmittingCount(page, 1);
      // Chamfer trims corners but the outer AABB is the same as the box.
      await assertBodyBBoxApprox(page, CUBE_MIN, CUBE_MAX, 1.0);
    },
  },
  {
    name: 'shell a 40-cube (thickness 1)',
    async run(page) {
      await resetDocument(page);
      await v4Call(page, 'addBox', CUBE);
      await waitForRender(page);
      const [boxId] = await lastFeatureIds(page, 1);
      await v4Call(page, 'addShell', boxId, { thickness: 1 });
      await waitForRender(page);
      await assertKernelRan(page);
      await assertNoKernelError(page);
      await assertBodyEmittingCount(page, 1);
      // Shell hollows the interior; the external bbox is unchanged.
      await assertBodyBBoxApprox(page, CUBE_MIN, CUBE_MAX, 1.0);
    },
  },
  {
    name: 'hole through a 40-cube (diameter 8, through)',
    async run(page) {
      await resetDocument(page);
      await v4Call(page, 'addBox', CUBE);
      await waitForRender(page);
      const [boxId] = await lastFeatureIds(page, 1);
      // Signature per operations.js:
      //   addHole(targetBodyId, { diameter, depth, through, type, ... })
      await v4Call(page, 'addHole', boxId, { diameter: 8, depth: 50, through: true });
      await waitForRender(page);
      await assertKernelRan(page);
      await assertNoKernelError(page);
      // Hole consumes the source body; only the Hole feature emits.
      await assertBodyEmittingCount(page, 1);
    },
  },
  {
    name: 'fillet then chamfer chained on a 40-cube',
    async run(page) {
      await resetDocument(page);
      await v4Call(page, 'addBox', CUBE);
      await waitForRender(page);
      const [boxId] = await lastFeatureIds(page, 1);
      await v4Call(page, 'addFillet', boxId, { radius: 2 });
      await waitForRender(page);
      const [filletId] = await lastFeatureIds(page, 1);
      await v4Call(page, 'addChamfer', filletId, { length: 1 });
      await waitForRender(page);
      await assertKernelRan(page);
      await assertNoKernelError(page);
      // Both modifiers consume their input — only the final chamfer emits.
      await assertBodyEmittingCount(page, 1);
    },
  },
];
