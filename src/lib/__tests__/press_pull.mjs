/**
 * E3 Slice 2 — Press-Pull Face.
 *
 * Zero-dep node:assert. Run via:
 *   node --import ./src/lib/commands/__tests__/_register.mjs \
 *        src/lib/__tests__/press_pull.mjs
 *
 * Covers:
 *   - addPushPullFace creates a PushPullFace feature with correct shape
 *   - addPushPullFace throws cleanly on bad inputs
 *   - Emit produces a `push_pull_face(parent, ..., distance=N)` call
 *   - Press-Pull is in the leaf set (consumes its parent)
 *   - Palette command `modifier.pressPull` registered
 *   - Form fallback command `modifier.pressPull.form` exists
 *   - PushPullFace consumes its body input (parent drops out of leaves)
 *   - DFM heuristic fires when distance would over-thin the wall
 */
import assert from 'node:assert/strict';
import { COMMANDS } from '../commands/registry.js';
import {
  getDocumentStore, resetDocumentStore,
  addBox,
  addPushPullFace,
  emitDocument,
} from '../../../lib/document/index.js';
import {
  zeroThickness,
  setMeasureForTests, resetMeasureForTests,
} from '../dfm/checks.js';

let _pass = 0, _fail = 0;
function t(name, fn) {
  try {
    const ret = fn();
    if (ret && typeof ret.then === 'function') {
      return ret.then(
        () => { console.log(`  ok  ${name}`); _pass++; },
        (e) => { console.error(`  FAIL ${name}\n    ${e?.stack || e?.message || e}`); _fail++; },
      );
    }
    console.log(`  ok  ${name}`); _pass++;
  } catch (e) {
    console.error(`  FAIL ${name}\n    ${e?.stack || e?.message || e}`);
    _fail++;
  }
}

const byId = Object.fromEntries(COMMANDS.map(c => [c.id, c]));

function freshDoc() {
  resetDocumentStore();
  return getDocumentStore();
}

console.log('── E3 Slice 2 (Press-Pull) ──');

// ── 1. addPushPullFace shape ────────────────────────────────────────────────
t('addPushPullFace stores face descriptor + distance + body input', () => {
  freshDoc();
  const box = addBox({ length: 10, width: 10, height: 10 });
  const face = { kind: 'face', feature: box.id, canonical: `feat:${box.id}/face:+Z` };
  const feat = addPushPullFace(face, 5);
  assert.equal(feat.type, 'PushPullFace');
  assert.deepEqual(feat.params.face, face);
  assert.equal(feat.params.distance, 5);
  assert.equal(feat.inputs.body.featureId, box.id);
});

// ── 2. addPushPullFace defensive on bad input ───────────────────────────────
t('addPushPullFace throws on missing descriptor', () => {
  freshDoc();
  assert.throws(() => addPushPullFace(null, 5), /faceDescriptor/);
});

t('addPushPullFace throws on non-numeric distance', () => {
  freshDoc();
  const box = addBox({});
  const face = { kind: 'face', feature: box.id };
  assert.throws(() => addPushPullFace(face, 'lots'), /numeric distance/);
  assert.throws(() => addPushPullFace(face, NaN), /numeric distance/);
});

t('addPushPullFace throws when descriptor has no feature id', () => {
  freshDoc();
  assert.throws(() => addPushPullFace({ kind: 'face' }, 3),
    /missing source feature id/);
});

// ── 3. Emit produces the kernel call ────────────────────────────────────────
t('emit produces push_pull_face(body, query, distance=N) call', () => {
  freshDoc();
  const box = addBox({ length: 10, width: 10, height: 10 });
  const face = {
    kind: 'face', feature: box.id,
    fingerprint: {
      centerRounded: [0, 0, 10],
      normalRounded: [0, 0, 1],
      areaBucket: 100,
      sourceNodeId: box.id,
    },
  };
  const pp = addPushPullFace(face, 5);
  const { code } = emitDocument(getDocumentStore().doc);
  // The PushPullFace emitter uses `faceQuery(face)` which renders the
  // fingerprint as the second arg, and `distance=N` as a keyword.
  assert.ok(new RegExp(`n_${pp.id}\\s*=\\s*push_pull_face\\(n_${box.id},`).test(code),
    'expected n_<pp> = push_pull_face(n_<box>, …)');
  assert.ok(/distance=5/.test(code), 'expected distance=5 keyword arg');
});

// ── 4. PushPullFace consumes its parent in the leaf set ─────────────────────
t('PushPullFace replaces its parent on the leaf set', () => {
  freshDoc();
  const box = addBox({});
  const face = { kind: 'face', feature: box.id };
  const pp = addPushPullFace(face, 3);
  const { leafIds } = emitDocument(getDocumentStore().doc);
  assert.ok(!leafIds.includes(box.id), 'parent box should be consumed');
  assert.ok(leafIds.includes(pp.id), 'press-pull is the new leaf');
});

// ── 5. Palette command registered + form fallback ───────────────────────────
t('modifier.pressPull palette command exists', () => {
  const cmd = byId['modifier.pressPull'];
  assert.ok(cmd, 'modifier.pressPull missing');
  assert.equal(cmd.group, 'Modifiers');
  assert.equal(typeof cmd.run, 'function');
});

t('modifier.pressPull.form fallback command exists with face + distance', () => {
  const cmd = byId['modifier.pressPull.form'];
  assert.ok(cmd, 'modifier.pressPull.form missing');
  assert.ok(cmd.form, 'must carry a form');
  const keys = cmd.form.fields.map(f => f.key);
  assert.ok(keys.includes('faceJson'), 'form needs faceJson field');
  assert.ok(keys.includes('distance'), 'form needs distance field');
});

// ── 6. DFM hook — coarse wall-thickness heuristic via zeroThickness ─────────
t('zeroThickness fires when smallest bbox dim is below profile.minWallMm', async () => {
  // Mock the measure provider: pretend the post-press-pull body shrinks
  // its smallest dim below the 0.4mm threshold.
  setMeasureForTests(async (q) => {
    if (q.type === 'bbox') {
      return { ok: true, size: [0.2, 10, 10] };
    }
    return { ok: true };
  });
  try {
    const result = await zeroThickness('feat_x', { minWallMm: 0.4 });
    assert.equal(result.ok, false);
    assert.equal(result.severity, 'error');
    assert.ok(/below minimum wall/i.test(result.message));
  } finally {
    resetMeasureForTests();
  }
});

// ── 7. DFM hook — passes when wall thickness OK after press-pull ────────────
t('zeroThickness passes when smallest dim is comfortably above threshold', async () => {
  setMeasureForTests(async (q) => {
    if (q.type === 'bbox') return { ok: true, size: [5, 10, 10] };
    return { ok: true };
  });
  try {
    const result = await zeroThickness('feat_x', { minWallMm: 0.4 });
    assert.equal(result.ok, true);
    assert.equal(result.severity, 'pass');
  } finally {
    resetMeasureForTests();
  }
});

// ── 8. Press-Pull integrates with v4 — fits into the timeline ───────────────
t('PushPullFace appears in featureOrder + survives a fresh emit cycle', () => {
  freshDoc();
  const box = addBox({});
  const face = { kind: 'face', feature: box.id };
  const pp = addPushPullFace(face, 2.5);
  const doc = getDocumentStore().doc;
  assert.ok(doc.featureOrder.includes(box.id));
  assert.ok(doc.featureOrder.includes(pp.id));
  const { order } = emitDocument(doc);
  // Topological: parent must come before the press-pull
  assert.ok(order.indexOf(box.id) < order.indexOf(pp.id));
});

// ── Done ────────────────────────────────────────────────────────────────────
await new Promise(r => setTimeout(r, 50)); // flush any pending async t() chains
console.log(`\n${_pass} passed, ${_fail} failed`);
process.exit(_fail === 0 ? 0 : 1);
