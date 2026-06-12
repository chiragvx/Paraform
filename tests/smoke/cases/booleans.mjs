/**
 * Smoke cases for boolean operations (union / cut / intersect).
 *
 * Each case builds source primitives via `v4.addBox / addCylinder / addSphere`,
 * grabs the last N feature ids out of the document, runs the boolean op, and
 * asserts that exactly one feature is body-emitting afterwards (the boolean's
 * source features are consumed — their `outputs.bodies` becomes empty).
 *
 * No bbox assertions: kernel overlap layout is finicky and outside the smoke
 * surface — we're proving the boolean op compiled and reduced the body set.
 */

import {
  resetDocument,
  v4Call,
  waitForRender,
  assertBodyEmittingCount,
  assertNoKernelError,
  assertKernelRan,
} from '../asserts.mjs';

/** Pull the last `n` feature ids out of the document's timeline order. */
async function lastFeatureIds(page, n) {
  return await page.evaluate((count) => {
    const order = window.__paraform__.getStore().doc.featureOrder || [];
    return order.slice(-count);
  }, n);
}

export const cases = [
  {
    name: 'union of two overlapping boxes',
    async run(page) {
      await resetDocument(page);
      await v4Call(page, 'addBox', { length: 20, width: 20, height: 20 });
      await waitForRender(page);
      await v4Call(page, 'addBox', { length: 30, width: 30, height: 30 });
      await waitForRender(page);
      const [a, b] = await lastFeatureIds(page, 2);
      await v4Call(page, 'addUnion', [a, b]);
      await waitForRender(page);
      await assertKernelRan(page);
      await assertNoKernelError(page);
      // Union consumes both sources; only the boolean feature emits a body.
      await assertBodyEmittingCount(page, 1);
    },
  },
  {
    name: 'cut: box minus cylinder (bored through)',
    async run(page) {
      await resetDocument(page);
      await v4Call(page, 'addBox', { length: 30, width: 30, height: 30 });
      await waitForRender(page);
      await v4Call(page, 'addCylinder', { radius: 5, height: 40 });
      await waitForRender(page);
      const [boxId, cylId] = await lastFeatureIds(page, 2);
      await v4Call(page, 'addCut', boxId, [cylId]);
      await waitForRender(page);
      await assertKernelRan(page);
      await assertNoKernelError(page);
      await assertBodyEmittingCount(page, 1);
    },
  },
  {
    name: 'intersect of two overlapping boxes',
    async run(page) {
      await resetDocument(page);
      await v4Call(page, 'addBox', { length: 30, width: 30, height: 30 });
      await waitForRender(page);
      await v4Call(page, 'addBox', { length: 20, width: 20, height: 20 });
      await waitForRender(page);
      const [a, b] = await lastFeatureIds(page, 2);
      await v4Call(page, 'addIntersect', [a, b]);
      await waitForRender(page);
      await assertKernelRan(page);
      await assertNoKernelError(page);
      await assertBodyEmittingCount(page, 1);
    },
  },
  {
    name: 'union of three primitives (box + cylinder + sphere)',
    async run(page) {
      await resetDocument(page);
      await v4Call(page, 'addBox', { length: 25, width: 25, height: 25 });
      await waitForRender(page);
      await v4Call(page, 'addCylinder', { radius: 8, height: 25 });
      await waitForRender(page);
      await v4Call(page, 'addSphere', { radius: 12 });
      await waitForRender(page);
      const [a, b, c] = await lastFeatureIds(page, 3);
      await v4Call(page, 'addUnion', [a, b, c]);
      await waitForRender(page);
      await assertKernelRan(page);
      await assertNoKernelError(page);
      await assertBodyEmittingCount(page, 1);
    },
  },
  {
    name: 'cut with two tools: box - [cylinder, sphere]',
    async run(page) {
      await resetDocument(page);
      await v4Call(page, 'addBox', { length: 40, width: 40, height: 40 });
      await waitForRender(page);
      await v4Call(page, 'addCylinder', { radius: 6, height: 50 });
      await waitForRender(page);
      await v4Call(page, 'addSphere', { radius: 10 });
      await waitForRender(page);
      const [boxId, cylId, sphereId] = await lastFeatureIds(page, 3);
      await v4Call(page, 'addCut', boxId, [cylId, sphereId]);
      await waitForRender(page);
      await assertKernelRan(page);
      await assertNoKernelError(page);
      await assertBodyEmittingCount(page, 1);
    },
  },
];
