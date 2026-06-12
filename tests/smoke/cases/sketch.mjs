/**
 * Smoke cases — sketch operations.
 *
 * Covers the quick-add sketch helpers (rect / circle), the sketch-consuming
 * features (Extrude / Revolve), and a sanity check that entering and
 * cancelling the in-viewport sketcher doesn't blow up the kernel.
 *
 * The full DOM-driven sketcher (toolbar, constraints, edit tools) is out
 * of scope here — those paths own their own UI and would need real mouse
 * choreography to drive. Instead, every "draw" path goes through the v4
 * helpers (`rectangleSketch`, `circleSketch`, `addExtrude`, `addRevolve`)
 * which commit finished sketch features directly to the store.
 *
 * Note on body counts: a Sketch feature alone does NOT emit a body — its
 * outputs sit under `outputs.sketches`. So `assertBodyEmittingCount(0)`
 * is the right check after a bare sketch; the count only ticks up once
 * an Extrude / Revolve consumes it.
 */

import {
  resetDocument,
  runCommand,
  v4Call,
  waitForRender,
  assertFeaturePresent,
  assertBodyEmittingCount,
  assertNoKernelError,
  assertKernelRan,
} from '../asserts.mjs';

/** Read the most recently authored feature id from the store. */
async function lastFeatureId(page) {
  return await page.evaluate(() => {
    const order = window.__paraform__.getStore().doc.featureOrder;
    return order[order.length - 1];
  });
}

export const cases = [
  {
    name: 'sketch.rect.xy.quick produces a Sketch feature',
    async run(page) {
      await resetDocument(page);
      await runCommand(page, 'sketch.rect.xy.quick');
      await waitForRender(page);
      await assertKernelRan(page);
      await assertNoKernelError(page);
      await assertFeaturePresent(page, 'Sketch', 1);
      // Sketches don't emit bodies — they emit sketch outputs.
      await assertBodyEmittingCount(page, 0);
    },
  },

  {
    name: 'sketch.circle.xy.quick produces a Sketch feature',
    async run(page) {
      await resetDocument(page);
      await runCommand(page, 'sketch.circle.xy.quick');
      await waitForRender(page);
      await assertKernelRan(page);
      await assertNoKernelError(page);
      await assertFeaturePresent(page, 'Sketch', 1);
      await assertBodyEmittingCount(page, 0);
    },
  },

  {
    name: 'rectangleSketch + addExtrude emits one body',
    async run(page) {
      await resetDocument(page);
      // 20×20 rectangle on XY, then pull it +10 mm.
      await v4Call(page, 'rectangleSketch', 'XY', 20, 20);
      await waitForRender(page);
      const sid = await lastFeatureId(page);
      await v4Call(page, 'addExtrude', sid, { amount: 10 });
      await waitForRender(page);
      await assertKernelRan(page);
      await assertNoKernelError(page);
      await assertFeaturePresent(page, 'Sketch', 1);
      await assertFeaturePresent(page, 'Extrude', 1);
      // Sketch emits no body; Extrude emits one.
      await assertBodyEmittingCount(page, 1);
    },
  },

  {
    name: 'circleSketch + addRevolve emits one body',
    async run(page) {
      await resetDocument(page);
      // Circle r=10 on XY, then full-turn revolve about Z.
      await v4Call(page, 'circleSketch', 'XY', 10);
      await waitForRender(page);
      const sid = await lastFeatureId(page);
      await v4Call(page, 'addRevolve', sid, { angle: 360, axis: 'Z' });
      await waitForRender(page);
      await assertKernelRan(page);
      await assertNoKernelError(page);
      await assertFeaturePresent(page, 'Sketch', 1);
      await assertFeaturePresent(page, 'Revolve', 1);
      await assertBodyEmittingCount(page, 1);
    },
  },

  {
    name: 'sketch.enter.xy then sketch.cancel — no kernel error',
    async run(page) {
      await resetDocument(page);
      // The real sketcher owns DOM + hotkeys, so we don't try to draw —
      // just verify entering and cancelling the mode is harmless. The
      // reset itself runs the kernel, so assertKernelRan still holds
      // even though enter/cancel don't trigger a recompile.
      await runCommand(page, 'sketch.enter.xy');
      await runCommand(page, 'sketch.cancel');
      await assertKernelRan(page);
      await assertNoKernelError(page);
      // No sketch feature was committed (the sketcher commits on finish).
      await assertBodyEmittingCount(page, 0);
    },
  },
];
