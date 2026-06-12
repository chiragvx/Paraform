/**
 * E3 Slice 3 — Face-edit ops (Move / Delete / Offset Face).
 *
 * Run via:
 *   node --import ./src/lib/commands/__tests__/_register.mjs \
 *        src/lib/__tests__/face_edit.mjs
 *
 * Covers:
 *   - addMoveFace / addDeleteFace / addOffsetFace happy path
 *   - Defensive throws on bad input
 *   - Emit produces correct kernel calls for all three
 *   - Leaf-set: parent body consumed; the new feature replaces it
 *   - Palette commands registered (gesture + form siblings)
 *   - DFM hook handles MoveFace (vector projected onto normal) and OffsetFace
 */
import assert from 'node:assert/strict';
import { COMMANDS } from '../commands/registry.js';
import {
  getDocumentStore, resetDocumentStore,
  addBox,
  addMoveFace, addDeleteFace, addOffsetFace,
  emitDocument,
} from '../../../lib/document/index.js';
import {
  pressPullWallThickness, effectivePressPullDistance,
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

console.log('── E3 Slice 3 (Face-edit ops) ──');

// ── 1. addMoveFace shape ────────────────────────────────────────────────────
t('addMoveFace stores face + vector + body input', () => {
  freshDoc();
  const box = addBox({ length: 10, width: 10, height: 10 });
  const face = { kind: 'face', feature: box.id };
  const feat = addMoveFace(face, [0, 0, 5]);
  assert.equal(feat.type, 'MoveFace');
  assert.deepEqual(feat.params.face, face);
  assert.deepEqual(feat.params.vector, [0, 0, 5]);
  assert.equal(feat.inputs.body.featureId, box.id);
  assert.ok(Array.isArray(feat.warnings) && feat.warnings.length > 0,
    'MoveFace stamps a tangent-not-supported warning chip');
});

// ── 2. addMoveFace defensive ────────────────────────────────────────────────
t('addMoveFace throws on missing descriptor', () => {
  freshDoc();
  assert.throws(() => addMoveFace(null, [0, 0, 1]), /faceDescriptor/);
});

t('addMoveFace throws on wrong vector length', () => {
  freshDoc();
  const box = addBox({});
  const face = { kind: 'face', feature: box.id };
  assert.throws(() => addMoveFace(face, [1, 2]), /vector/);
  assert.throws(() => addMoveFace(face, 'nope'), /vector/);
});

t('addMoveFace throws when descriptor has no feature id', () => {
  freshDoc();
  assert.throws(() => addMoveFace({ kind: 'face' }, [0, 0, 1]),
    /missing source feature id/);
});

// ── 3. addDeleteFace shape ──────────────────────────────────────────────────
t('addDeleteFace stores face + body input + warning chip', () => {
  freshDoc();
  const box = addBox({});
  const face = { kind: 'face', feature: box.id };
  const feat = addDeleteFace(face);
  assert.equal(feat.type, 'DeleteFace');
  assert.equal(feat.inputs.body.featureId, box.id);
  assert.ok(Array.isArray(feat.warnings) && feat.warnings.length > 0);
});

t('addDeleteFace throws on missing descriptor', () => {
  freshDoc();
  assert.throws(() => addDeleteFace(null), /faceDescriptor/);
});

// ── 4. addOffsetFace shape ──────────────────────────────────────────────────
t('addOffsetFace stores face + distance + body input', () => {
  freshDoc();
  const box = addBox({});
  const face = { kind: 'face', feature: box.id };
  const feat = addOffsetFace(face, 2);
  assert.equal(feat.type, 'OffsetFace');
  assert.equal(feat.params.distance, 2);
  assert.equal(feat.inputs.body.featureId, box.id);
});

t('addOffsetFace throws on non-numeric distance', () => {
  freshDoc();
  const box = addBox({});
  const face = { kind: 'face', feature: box.id };
  assert.throws(() => addOffsetFace(face, 'lots'), /numeric distance/);
});

// ── 5. Emit produces correct kernel calls ───────────────────────────────────
t('emit produces move_face / delete_face / offset_face calls', () => {
  freshDoc();
  const box = addBox({});
  const face = { kind: 'face', feature: box.id };
  const mf = addMoveFace(face, [1, 2, 3]);
  const df = addDeleteFace(face);
  const of = addOffsetFace(face, 1.5);
  const { code } = emitDocument(getDocumentStore().doc);
  assert.ok(new RegExp(`n_${mf.id}\\s*=\\s*move_face\\(n_${box.id},`).test(code),
    'expected move_face(n_<box>, …)');
  assert.ok(/\[1, 2, 3\]/.test(code), 'expected the [vx, vy, vz] vector in emit');
  assert.ok(new RegExp(`n_${df.id}\\s*=\\s*delete_face\\(n_${box.id},`).test(code),
    'expected delete_face(n_<box>, …)');
  assert.ok(new RegExp(`n_${of.id}\\s*=\\s*offset_face\\(n_${box.id},`).test(code),
    'expected offset_face(n_<box>, …)');
  assert.ok(/distance=1\.5/.test(code), 'OffsetFace emits distance=1.5 keyword');
});

// ── 6. Leaf-set ─────────────────────────────────────────────────────────────
t('MoveFace consumes its parent body in the leaf set', () => {
  freshDoc();
  const box = addBox({});
  const face = { kind: 'face', feature: box.id };
  const mf = addMoveFace(face, [0, 0, 1]);
  const { leafIds } = emitDocument(getDocumentStore().doc);
  assert.ok(!leafIds.includes(box.id), 'parent box should be consumed');
  assert.ok(leafIds.includes(mf.id), 'move-face is the new leaf');
});

t('DeleteFace consumes its parent body in the leaf set', () => {
  freshDoc();
  const box = addBox({});
  const face = { kind: 'face', feature: box.id };
  const df = addDeleteFace(face);
  const { leafIds } = emitDocument(getDocumentStore().doc);
  assert.ok(!leafIds.includes(box.id), 'parent box should be consumed');
  assert.ok(leafIds.includes(df.id), 'delete-face is the new leaf');
});

t('OffsetFace consumes its parent body in the leaf set', () => {
  freshDoc();
  const box = addBox({});
  const face = { kind: 'face', feature: box.id };
  const of = addOffsetFace(face, 0.5);
  const { leafIds } = emitDocument(getDocumentStore().doc);
  assert.ok(!leafIds.includes(box.id), 'parent box should be consumed');
  assert.ok(leafIds.includes(of.id), 'offset-face is the new leaf');
});

// ── 7. Palette commands registered ──────────────────────────────────────────
t('palette commands registered for all three (gesture + form sibling)', () => {
  for (const id of ['modifier.moveFace', 'modifier.moveFace.form',
                    'modifier.deleteFace', 'modifier.deleteFace.form',
                    'modifier.offsetFace', 'modifier.offsetFace.form']) {
    const cmd = byId[id];
    assert.ok(cmd, `${id} missing`);
    assert.equal(cmd.group, 'Modifiers');
    assert.equal(typeof cmd.run, 'function');
  }
});

t('form siblings carry the expected fields', () => {
  const move = byId['modifier.moveFace.form'];
  const moveKeys = move.form.fields.map(f => f.key);
  assert.ok(moveKeys.includes('faceJson') && moveKeys.includes('vx')
    && moveKeys.includes('vy') && moveKeys.includes('vz'),
    'move face form needs faceJson + vx/vy/vz fields');
  const del = byId['modifier.deleteFace.form'];
  const delKeys = del.form.fields.map(f => f.key);
  assert.ok(delKeys.includes('faceJson'), 'delete face form needs faceJson');
  const off = byId['modifier.offsetFace.form'];
  const offKeys = off.form.fields.map(f => f.key);
  assert.ok(offKeys.includes('faceJson') && offKeys.includes('distance'),
    'offset face form needs faceJson + distance');
});

// ── 8. DFM hook — effectivePressPullDistance projects MoveFace vector ───────
t('effectivePressPullDistance projects MoveFace vector onto face normal', () => {
  const face = {
    kind: 'face',
    fingerprint: { normalRounded: [0, 0, 1] },
  };
  const featMove = { type: 'MoveFace', params: { face, vector: [3, 4, 7] } };
  // Normal is +Z so projected distance is just vz = 7.
  assert.equal(effectivePressPullDistance(featMove), 7);

  // Non-axis-aligned normal: [1, 1, 0] normalized; vector [2, 0, 0] → 2/√2 ≈ 1.4142
  const faceXY = { fingerprint: { normalRounded: [1, 1, 0] } };
  const f2 = { type: 'MoveFace', params: { face: faceXY, vector: [2, 0, 0] } };
  const d = effectivePressPullDistance(f2);
  assert.ok(Math.abs(d - (2 / Math.sqrt(2))) < 1e-9, `expected ~1.414, got ${d}`);

  // OffsetFace reads params.distance directly.
  const featOffset = { type: 'OffsetFace', params: { distance: -2.5 } };
  assert.equal(effectivePressPullDistance(featOffset), -2.5);

  // PushPullFace also flows through.
  const featPP = { type: 'PushPullFace', params: { distance: 3 } };
  assert.equal(effectivePressPullDistance(featPP), 3);

  // Non-face-edit feature → NaN
  assert.ok(Number.isNaN(effectivePressPullDistance({ type: 'Box', params: {} })));
});

t('pressPullWallThickness fires for OffsetFace-derived distance', async () => {
  setMeasureForTests(async (q) => {
    if (q.type === 'bbox') return { ok: true, size: [0.5, 10, 10] };
    return { ok: true };
  });
  try {
    // Distance −0.4 leaves predicted wall 0.5 − 0.4 = 0.1 mm, well under 0.4.
    const result = await pressPullWallThickness('feat_off', { minWallMm: 0.4 }, -0.4);
    assert.equal(result.ok, false);
    assert.equal(result.severity, 'error');
  } finally {
    resetMeasureForTests();
  }
});

// ── Done ────────────────────────────────────────────────────────────────────
await new Promise(r => setTimeout(r, 50));
console.log(`\n${_pass} passed, ${_fail} failed`);
process.exit(_fail === 0 ? 0 : 1);
