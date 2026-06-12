/**
 * Smoke cases — transform + pattern features.
 *
 * Covers the three transform ops (Move / Rotate / Scale) and the three
 * primary pattern ops (LinearPattern / CircularPattern / Mirror) wired
 * through the v4 helpers in lib/document/operations.js.
 *
 * Verified signatures (operations.js):
 *   addMove(featureId, vector = [0,0,0])
 *   addRotate(featureId, axis = 'Z', angle = 90)
 *   addScale(featureId, factor = 1)
 *   addLinearPattern(featureId, { direction = 'X', count = 2, spacing = 10 } = {})
 *   addCircularPattern(featureId, { axis = 'Z', count = 4, angle = 360 } = {})
 *   addMirror(featureId, plane = 'XY')
 *
 * Bounding-box math (defaults from operations.js + CLAUDE.md alignment rules):
 *   addBox(length=40, width=40, height=40)  → bbox [-20,-20, 0] .. [20, 20,40]
 *   after addMove(box, [10, 0, 0])          → bbox [-10,-20, 0] .. [30, 20,40]
 *
 *   addBox(length=40, width=20, height=10)  → bbox [-20,-10, 0] .. [20, 10,10]
 *   after addRotate(box, 'Z', 90)           → bbox [-10,-20, 0] .. [10, 20,10]
 *   (Z stays the same; XY extents swap because the rotation pivots about
 *   the world Z axis through origin and the box is XY-centered on origin.)
 *
 *   addBox(length=20, width=20, height=20)  → bbox [-10,-10, 0] .. [10, 10,20]
 *   after addScale(box, 2.0)                → bbox [-20,-20, 0] .. [20, 20,40]
 *   (Uniform scale about origin; Align.MIN-on-Z origin stays at z=0.)
 *
 * For patterns we only assert kernel ran, no error, and that exactly one
 * body-emitting feature exists — the pattern feature owns all instances,
 * superseding the source body's direct emission.
 *
 * Per CLAUDE.md: Z-up world, primitives use Align.MIN on Z.
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

/** Read the most recently authored feature id from the store. */
async function lastFeatureId(page) {
  return await page.evaluate(() => {
    const order = window.__paraform__.getStore().doc.featureOrder;
    return order[order.length - 1];
  });
}

export const cases = [
  // ── Transforms ────────────────────────────────────────────────────────────
  {
    name: 'xform.move — 40mm cube shifted +10 on X lands at [-10,-20,0]..[30,20,40]',
    async run(page) {
      await resetDocument(page);
      await v4Call(page, 'addBox', { length: 40, width: 40, height: 40 });
      await waitForRender(page);
      const boxId = await lastFeatureId(page);
      await v4Call(page, 'addMove', boxId, [10, 0, 0]);
      await waitForRender(page);
      await assertKernelRan(page);
      await assertNoKernelError(page);
      await assertBodyEmittingCount(page, 1);
      await assertBodyBBoxApprox(page, [-10, -20, 0], [30, 20, 40], 1.0);
    },
  },

  {
    name: 'xform.rotate — 40x20x10 box rotated 90° about Z swaps XY extents',
    async run(page) {
      await resetDocument(page);
      await v4Call(page, 'addBox', { length: 40, width: 20, height: 10 });
      await waitForRender(page);
      const boxId = await lastFeatureId(page);
      await v4Call(page, 'addRotate', boxId, 'Z', 90);
      await waitForRender(page);
      await assertKernelRan(page);
      await assertNoKernelError(page);
      await assertBodyEmittingCount(page, 1);
      await assertBodyBBoxApprox(page, [-10, -20, 0], [10, 20, 10], 1.0);
    },
  },

  {
    name: 'xform.scale — 20mm cube scaled 2.0 doubles bbox to [-20,-20,0]..[20,20,40]',
    async run(page) {
      await resetDocument(page);
      await v4Call(page, 'addBox', { length: 20, width: 20, height: 20 });
      await waitForRender(page);
      const boxId = await lastFeatureId(page);
      await v4Call(page, 'addScale', boxId, 2.0);
      await waitForRender(page);
      await assertKernelRan(page);
      await assertNoKernelError(page);
      await assertBodyEmittingCount(page, 1);
      await assertBodyBBoxApprox(page, [-20, -20, 0], [20, 20, 40], 1.0);
    },
  },

  // ── Patterns ──────────────────────────────────────────────────────────────
  {
    name: 'pattern.linear — cylinder × 3 spaced 20mm on +X yields one body-emitting feature',
    async run(page) {
      await resetDocument(page);
      await v4Call(page, 'addCylinder', { radius: 5, height: 10 });
      await waitForRender(page);
      const cylId = await lastFeatureId(page);
      await v4Call(page, 'addLinearPattern', cylId, {
        direction: 'X',
        count: 3,
        spacing: 20,
      });
      await waitForRender(page);
      await assertKernelRan(page);
      await assertNoKernelError(page);
      await assertBodyEmittingCount(page, 1);
    },
  },

  {
    name: 'pattern.circular — cylinder × 4 about Z over 360° yields one body-emitting feature',
    async run(page) {
      await resetDocument(page);
      await v4Call(page, 'addCylinder', { radius: 5, height: 10 });
      await waitForRender(page);
      const cylId = await lastFeatureId(page);
      await v4Call(page, 'addCircularPattern', cylId, {
        axis: 'Z',
        count: 4,
        angle: 360,
      });
      await waitForRender(page);
      await assertKernelRan(page);
      await assertNoKernelError(page);
      await assertBodyEmittingCount(page, 1);
    },
  },

  {
    name: 'pattern.mirror — box mirrored about XZ plane yields one body-emitting feature',
    async run(page) {
      await resetDocument(page);
      await v4Call(page, 'addBox', { length: 20, width: 20, height: 20 });
      await waitForRender(page);
      const boxId = await lastFeatureId(page);
      await v4Call(page, 'addMirror', boxId, 'XZ');
      await waitForRender(page);
      await assertKernelRan(page);
      await assertNoKernelError(page);
      await assertBodyEmittingCount(page, 1);
    },
  },
];
