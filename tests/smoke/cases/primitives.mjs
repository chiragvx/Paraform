/**
 * Smoke cases for primitive features (Box, Cylinder, Sphere, Torus).
 *
 * Each case resets the document, fires a primitive command (or v4 helper),
 * waits for the kernel to render, and asserts:
 *   - the kernel round-trip happened (assertKernelRan)
 *   - no error chip (assertNoKernelError)
 *   - the document holds the expected number of body-emitting features
 *   - for boxes (defaults + explicit params), the world-space bbox lands
 *     where Align.MIN-on-Z says it should
 *
 * Defaults pulled from lib/document/operations.js:
 *   addBox      → 10×10×10, centered XY, MIN Z   → bbox [-5,-5,0]..[5,5,10]
 *   addCylinder → r=5, h=10, centered XY, MIN Z
 *   addSphere   → r=5
 *   addTorus    → majorRadius=10, minorRadius=2
 *
 * Per CLAUDE.md, the scene is Z-up and primitives use Align.MIN on Z, so
 * a default 10 mm box sits on Z=0 with top at Z=10.
 */
import {
  resetDocument,
  runCommand,
  v4Call,
  waitForRender,
  assertBodyEmittingCount,
  assertNoKernelError,
  assertKernelRan,
  assertBodyBBoxApprox,
} from '../asserts.mjs';

export const cases = [
  {
    name: 'primitive.box — default 10mm cube adds one body at Align.MIN Z',
    async run(page) {
      await resetDocument(page);
      await runCommand(page, 'primitive.box');
      await waitForRender(page);
      await assertKernelRan(page);
      await assertNoKernelError(page);
      await assertBodyEmittingCount(page, 1);
      await assertBodyBBoxApprox(page, [-5, -5, 0], [5, 5, 10], 1.0);
    },
  },
  {
    name: 'primitive.cylinder — defaults add one body',
    async run(page) {
      await resetDocument(page);
      await runCommand(page, 'primitive.cylinder');
      await waitForRender(page);
      await assertKernelRan(page);
      await assertNoKernelError(page);
      await assertBodyEmittingCount(page, 1);
    },
  },
  {
    name: 'primitive.sphere — defaults add one body',
    async run(page) {
      await resetDocument(page);
      await runCommand(page, 'primitive.sphere');
      await waitForRender(page);
      await assertKernelRan(page);
      await assertNoKernelError(page);
      await assertBodyEmittingCount(page, 1);
    },
  },
  {
    name: 'primitive.torus — defaults add one body',
    async run(page) {
      await resetDocument(page);
      await runCommand(page, 'primitive.torus');
      await waitForRender(page);
      await assertKernelRan(page);
      await assertNoKernelError(page);
      await assertBodyEmittingCount(page, 1);
    },
  },
  {
    name: 'v4.addBox — explicit 20×20×20 lands at [-10,-10,0]..[10,10,20]',
    async run(page) {
      await resetDocument(page);
      await v4Call(page, 'addBox', { length: 20, width: 20, height: 20 });
      await waitForRender(page);
      await assertKernelRan(page);
      await assertNoKernelError(page);
      await assertBodyEmittingCount(page, 1);
      await assertBodyBBoxApprox(page, [-10, -10, 0], [10, 10, 20], 1.0);
    },
  },
  {
    name: 'primitive.box + primitive.cylinder — two body-emitting features',
    async run(page) {
      await resetDocument(page);
      await runCommand(page, 'primitive.box');
      await waitForRender(page);
      await runCommand(page, 'primitive.cylinder');
      await waitForRender(page);
      await assertKernelRan(page);
      await assertNoKernelError(page);
      await assertBodyEmittingCount(page, 2);
    },
  },
];
