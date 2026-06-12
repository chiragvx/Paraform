/**
 * E2.1 / E2.4 — face-pick + Sketch-on-face entry tests.
 *
 * Run with:
 *   node --import ./src/lib/sketch/__tests__/_register.mjs \
 *        src/lib/sketch/__tests__/face_pick.mjs
 *
 * Stubs `$lib/studio/runtime.svelte.js` and `app/sketch_3d/index.js` so the
 * pure logic in `src/lib/sketch/boot.js` and `lib/document/operations.js` can
 * be exercised without three.js, DOM, or Svelte runes.
 */
import assert from 'node:assert/strict';
import { enterSketch, isSketchActive, cancelSketch } from '../boot.js';
import { studio } from '$lib/studio/runtime.svelte.js';
import { resetDocumentStore, getDocumentStore, addSketchOnFace } from '../../../../lib/document/index.js';
import { _testCalls, _testReset } from '../../../../app/sketch_3d/index.js';

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log(`  ok  ${name}`); pass++; }
  catch (e) { console.error(`  FAIL ${name}\n    ${e?.stack || e?.message || e}`); fail++; }
}

function freshState() {
  resetDocumentStore();
  _testReset();
  studio._reset();
}

const MOCK_FACE_DESC = { kind: 'face', feature: 'box_1', op: 'box', selector: { face: 'F0' } };
const MOCK_EDGE_DESC = { kind: 'edge', feature: 'box_1', op: 'box', selector: { edge: 'E0' } };

console.log('── face-pick + Sketch-on-face ──');

// 1. legacy string-plane path still works
await t('enterSketch("XY") enters on stock plane', async () => {
  freshState();
  const ctrl = await enterSketch('XY');
  assert.ok(ctrl, 'controller returned');
  assert.equal(isSketchActive(), true);
  const calls = _testCalls();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, 'enter');
  assert.equal(calls[0].plane, 'XY');
  cancelSketch();
  assert.equal(isSketchActive(), false);
});

// 2. face-descriptor path resolves via measure + enters
await t('enterSketch({faceDescriptor}) resolves measure + enters', async () => {
  freshState();
  studio.setMeasureImpl(async (q) => {
    if (q.type === 'centroid') return { value: [1, 2, 3] };
    if (q.type === 'normal')   return { value: [0, 0, 1] };
    throw new Error('unexpected query: ' + q.type);
  });
  const ctrl = await enterSketch({ faceDescriptor: MOCK_FACE_DESC, featureId: 'sof_1' });
  assert.ok(ctrl, 'sketcher entered');
  const calls = _testCalls();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, 'enter');
  assert.equal(calls[0].plane.kind, 'face');
  assert.deepEqual(calls[0].plane.origin, [1, 2, 3]);
  assert.deepEqual(calls[0].plane.normal, [0, 0, 1]);
  assert.equal(calls[0].plane.featureId, 'sof_1');
  cancelSketch();
});

// 3. measure failure surfaces error chip, no entry
await t('enterSketch({faceDescriptor}) handles measure failure', async () => {
  freshState();
  studio.setMeasureImpl(async () => { throw new Error('topology stale'); });
  const ctrl = await enterSketch({ faceDescriptor: MOCK_FACE_DESC });
  assert.equal(ctrl, null, 'returns null on measure failure');
  assert.equal(isSketchActive(), false, 'sketcher not entered');
  assert.ok(String(studio.bridge.lastError || '').includes('missing face'),
    'bridge.lastError surfaces missing-face message');
});

// 4. measure returning non-vec3 also fails defensively
await t('enterSketch({faceDescriptor}) defensive on bad measure payload', async () => {
  freshState();
  studio.setMeasureImpl(async (q) => ({ value: q.type === 'centroid' ? 'oops' : null }));
  const ctrl = await enterSketch({ faceDescriptor: MOCK_FACE_DESC });
  assert.equal(ctrl, null);
  assert.ok(String(studio.bridge.lastError || '').includes('missing face'));
});

// 5. addSketchOnFace commits a feature with the descriptor stored
await t('addSketchOnFace commits SketchOnFace feature', () => {
  freshState();
  const f = addSketchOnFace(MOCK_FACE_DESC);
  assert.equal(f.type, 'SketchOnFace');
  assert.deepEqual(f.params.face, MOCK_FACE_DESC);
  const doc = getDocumentStore().doc;
  assert.ok(doc.features[f.id], 'feature in store');
  assert.equal(doc.features[f.id].type, 'SketchOnFace');
});

// 6. addSketchOnFace rejects missing descriptor
await t('addSketchOnFace throws without descriptor', () => {
  freshState();
  assert.throws(() => addSketchOnFace(null), /faceDescriptor required/);
});

// 7. startFacePick / cancelFacePick state transitions
await t('studio.startFacePick + cancelFacePick transitions', () => {
  freshState();
  assert.equal(studio.facePickMode, null);
  let cancelled = 0;
  const ok = studio.startFacePick({
    purpose: 'sketch',
    accept: ['face'],
    onPick: () => {},
    onCancel: () => { cancelled++; },
  });
  assert.equal(ok, true);
  assert.ok(studio.facePickMode);
  assert.equal(studio.facePickMode.purpose, 'sketch');
  assert.ok(studio.facePickMode.accept.has('face'));
  studio.cancelFacePick();
  assert.equal(studio.facePickMode, null);
  assert.equal(cancelled, 1, 'onCancel fired exactly once');
});

// 8. starting a new pick while one is in-flight cancels the prior one
await t('startFacePick supersedes an existing gesture', () => {
  freshState();
  let firstCancelled = 0;
  studio.startFacePick({ purpose: 'project', accept: ['face', 'edge'],
    onPick: () => {}, onCancel: () => { firstCancelled++; } });
  studio.startFacePick({ purpose: 'intersect', accept: ['face'],
    onPick: () => {}, onCancel: () => {} });
  assert.equal(firstCancelled, 1, 'prior onCancel fired');
  assert.equal(studio.facePickMode.purpose, 'intersect');
  assert.ok(studio.facePickMode.accept.has('face'));
  assert.ok(!studio.facePickMode.accept.has('edge'));
});

// 9. Project gesture honours an edge-accepting policy
await t('startFacePick accept-set covers project (face|edge)', () => {
  freshState();
  studio.startFacePick({ purpose: 'project', accept: ['face', 'edge'],
    onPick: () => {}, onCancel: () => {} });
  assert.ok(studio.facePickMode.accept.has('face'));
  assert.ok(studio.facePickMode.accept.has('edge'));
  // Mimic Viewport.svelte's accept check.
  assert.ok(studio.facePickMode.accept.has(MOCK_EDGE_DESC.kind));
});

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
