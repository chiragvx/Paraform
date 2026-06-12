/**
 * E3 Slice 1 — Splits + Combine-keep-tools + Align + Cosmetic Thread.
 *
 * Zero-dep node:assert. Run via:
 *   node --import ./src/lib/commands/__tests__/_register.mjs \
 *        src/lib/__tests__/e3_slice1.mjs
 *
 * Covers:
 *   - addAlign feature shape (+ datum + offset)
 *   - addSplit / addSplitFace feature shape
 *   - addCosmeticThread metadata stored on params
 *   - addUnion / addCut / addIntersect with keepTools=true emit + leaf-set
 *   - bool.split palette command exists with selection gating
 *   - Align emit composes Move-style translate (qDatum kernel pending)
 *   - CosmeticThread serializes round-trip through store
 */
import assert from 'node:assert/strict';
import { COMMANDS } from '../commands/registry.js';
import {
  getDocumentStore, resetDocumentStore,
  addBox, addCylinder,
  addAlign, addSplit, addSplitFace, addCosmeticThread,
  addUnion, addCut, addIntersect,
  emitDocument,
} from '../../../lib/document/index.js';

let _pass = 0, _fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); _pass++; }
  catch (e) { console.error(`  FAIL ${name}\n    ${e?.stack || e?.message || e}`); _fail++; }
}

const byId = Object.fromEntries(COMMANDS.map(c => [c.id, c]));

function freshDoc() {
  resetDocumentStore();
  return getDocumentStore();
}

console.log('── E3 Slice 1 ──');

// ── 1. addAlign creates a feature with the correct shape ────────────────────
t('addAlign stores datums + offset and dual body inputs', () => {
  const store = freshDoc();
  const a = addBox({ length: 5, width: 5, height: 5 });
  const b = addBox({ length: 10, width: 10, height: 10 });
  const feat = addAlign(a.id, b.id, {
    sourceDatum: 'corner-min-min-min',
    targetDatum: 'face-center-+Z',
    offset: [1, 2, 3],
  });
  assert.equal(feat.type, 'Align');
  assert.equal(feat.params.sourceDatum, 'corner-min-min-min');
  assert.equal(feat.params.targetDatum, 'face-center-+Z');
  assert.deepEqual(feat.params.offset, [1, 2, 3]);
  assert.equal(feat.inputs.source.featureId, a.id);
  assert.equal(feat.inputs.target.featureId, b.id);
  // Warning chip is stamped because qDatum kernel resolver isn't ready.
  assert.ok((feat.warnings || []).some(w => /datum vocabulary/i.test(w)));
  assert.ok(store.doc.features[feat.id]);
});

// ── 2. addSplitFace creates a feature with face + curve ─────────────────────
t('addSplitFace records descriptor + curve spec + stub warning', () => {
  freshDoc();
  const face = { kind: 'face', canonical: 'feat:box.0/face:top' };
  const feat = addSplitFace(face, { kind: 'sketch', sketchId: 'sk_1' });
  assert.equal(feat.type, 'SplitFace');
  assert.deepEqual(feat.params.face, face);
  assert.equal(feat.params.curve.kind, 'sketch');
  assert.equal(feat.params.curve.sketchId, 'sk_1');
  assert.ok((feat.warnings || []).some(w => /kernel impl pending/i.test(w)));
});

// ── 3. addCosmeticThread stores the spec verbatim ───────────────────────────
t('addCosmeticThread stamps standard + pitch + diameter + direction', () => {
  freshDoc();
  const face = { kind: 'face', canonical: 'feat:cyl.0/face:cyl' };
  const feat = addCosmeticThread(face, {
    standard: 'M4 × 0.7', pitch: 0.7, nominalDiameter: 4,
    length: 12, direction: 'left-hand',
  });
  assert.equal(feat.type, 'CosmeticThread');
  assert.equal(feat.params.standard, 'M4 × 0.7');
  assert.equal(feat.params.pitch, 0.7);
  assert.equal(feat.params.nominalDiameter, 4);
  assert.equal(feat.params.length, 12);
  assert.equal(feat.params.direction, 'left-hand');
  assert.deepEqual(feat.params.face, face);
});

// ── 4. addSplit accepts target + tools and wires inputs ─────────────────────
t('addSplit binds target + first tool, extras land in params', () => {
  freshDoc();
  const a = addBox({ length: 5, width: 5, height: 5 });
  const b = addCylinder({ radius: 2, height: 10 });
  const c = addCylinder({ radius: 3, height: 10 });
  const feat = addSplit(a.id, [b.id, c.id]);
  assert.equal(feat.type, 'Split');
  assert.equal(feat.inputs.target.featureId, a.id);
  assert.equal(feat.inputs.tool.featureId, b.id);
  assert.deepEqual(feat.params.extraTools, [c.id]);
});

// ── 5. addUnion with keepTools=true differs from default ────────────────────
t('addUnion(keepTools=true) emits a different Python than default', () => {
  freshDoc();
  const a = addBox({ length: 5, width: 5, height: 5 });
  const b = addBox({ length: 5, width: 5, height: 5 });
  addUnion([a.id, b.id], { keepTools: true });
  const { code: keepCode } = emitDocument(getDocumentStore().doc);

  freshDoc();
  const c = addBox({ length: 5, width: 5, height: 5 });
  const d = addBox({ length: 5, width: 5, height: 5 });
  addUnion([c.id, d.id]); // default keepTools=false
  const { code: defCode } = emitDocument(getDocumentStore().doc);

  assert.ok(/keepTools=True/.test(keepCode), 'keep variant should mark comment');
  assert.ok(!/keepTools=True/.test(defCode), 'default variant should not');
});

// ── 6. keepTools=true keeps operands in the leaf set ────────────────────────
t('keepTools=true preserves operands as render leaves', () => {
  freshDoc();
  const a = addBox({ length: 5, width: 5, height: 5 });
  const b = addBox({ length: 5, width: 5, height: 5 });
  const u = addUnion([a.id, b.id], { keepTools: true });
  const { leafIds } = emitDocument(getDocumentStore().doc);
  assert.ok(leafIds.includes(a.id), 'a should remain a leaf');
  assert.ok(leafIds.includes(b.id), 'b should remain a leaf');
  assert.ok(leafIds.includes(u.id), 'union is also a leaf');
});

t('keepTools=false consumes operands (default behaviour preserved)', () => {
  freshDoc();
  const a = addBox({ length: 5, width: 5, height: 5 });
  const b = addBox({ length: 5, width: 5, height: 5 });
  const u = addUnion([a.id, b.id]);
  const { leafIds } = emitDocument(getDocumentStore().doc);
  assert.ok(!leafIds.includes(a.id), 'a is consumed');
  assert.ok(!leafIds.includes(b.id), 'b is consumed');
  assert.ok(leafIds.includes(u.id), 'union is the only leaf');
});

// ── 7. Cut + Intersect respect keepTools too ────────────────────────────────
t('addCut(keepTools=true) and addIntersect(keepTools=true) plumb through', () => {
  freshDoc();
  const a = addBox({ length: 5, width: 5, height: 5 });
  const b = addBox({ length: 4, width: 4, height: 4 });
  const cut = addCut(a.id, [b.id], { keepTools: true });
  assert.equal(cut.params.keepTools, true);

  const c = addBox({ length: 4, width: 4, height: 4 });
  const inter = addIntersect([a.id, c.id], { keepTools: true });
  assert.equal(inter.params.keepTools, true);

  const { code } = emitDocument(getDocumentStore().doc);
  assert.ok(/Cut .* keepTools=True/.test(code));
  assert.ok(/Intersect .* keepTools=True/.test(code));
});

// ── 8. bool.split palette command exists + gating ───────────────────────────
t('bool.split palette command is registered', () => {
  assert.ok(byId['bool.split'], 'bool.split missing');
  assert.equal(byId['bool.split'].group, 'Boolean');
  assert.equal(typeof byId['bool.split'].enabled, 'function');
  assert.equal(typeof byId['bool.split'].run, 'function');
});

t('bool.split enabled() = false on empty store', () => {
  const store = freshDoc();
  assert.equal(byId['bool.split'].enabled({ store }), false);
});

// ── 9. xform.align + modifier.thread + bool.splitFace palette commands ──────
t('xform.align command exists with full form schema', () => {
  const cmd = byId['xform.align'];
  assert.ok(cmd, 'xform.align missing');
  assert.equal(cmd.group, 'Transform');
  assert.ok(cmd.form);
  assert.ok(cmd.form.fields.some(f => f.key === 'sourceDatum' && f.type === 'select'));
  assert.ok(cmd.form.fields.some(f => f.key === 'targetDatum' && f.type === 'select'));
  assert.ok(cmd.form.fields.some(f => f.key === 'ox'));
});

t('modifier.thread command exists with M-series options', () => {
  const cmd = byId['modifier.thread'];
  assert.ok(cmd, 'modifier.thread missing');
  assert.equal(cmd.group, 'Modifiers');
  const std = cmd.form.fields.find(f => f.key === 'standard');
  assert.ok(std && std.options.some(o => /^M3/.test(o.value)));
  assert.ok(std.options.some(o => /^M16/.test(o.value)));
});

t('bool.splitFace command exists', () => {
  assert.ok(byId['bool.splitFace']);
});

// ── 10. Align emit — translate-only fallback ───────────────────────────────
t('Align emits a Move-style translate using the offset', () => {
  freshDoc();
  const a = addBox({ length: 5, width: 5, height: 5 });
  const b = addBox({ length: 10, width: 10, height: 10 });
  addAlign(a.id, b.id, { offset: [7, 0, 0] });
  const { code } = emitDocument(getDocumentStore().doc);
  // Translate-only fallback: contains a Vector(7, …) translate call on the
  // source body var.
  assert.ok(/\.translate\(Vector\(7,\s*0,\s*0\)\)/.test(code),
    'expected translate(Vector(7, 0, 0)) in emitted code');
  // Comment marker proving the datum vocab path is acknowledged.
  assert.ok(/Align.*kernel datum vocab pending/i.test(code));
});

// ── 11. CosmeticThread round-trips through emit (no body binding) ──────────
t('CosmeticThread emit is a comment — no n_<id> body binding', () => {
  freshDoc();
  const cyl = addCylinder({ radius: 3, height: 10 });
  const face = { kind: 'face', canonical: 'cyl' };
  const ct = addCosmeticThread(face, { standard: 'M3 × 0.5', length: 8 });
  const { code, leafIds } = emitDocument(getDocumentStore().doc);
  assert.ok(/Cosmetic thread/i.test(code));
  // No body var should be assigned for the cosmetic thread feature.
  assert.ok(!new RegExp(`n_${ct.id}\\s*=`).test(code),
    'CosmeticThread should not bind n_<id>');
  // Leaf set should still contain the original cylinder.
  assert.ok(leafIds.includes(cyl.id));
  assert.ok(!leafIds.includes(ct.id));
});

// ── 12. CosmeticThread is preserved across an emit cycle ────────────────────
t('CosmeticThread spec survives store round-trip', () => {
  freshDoc();
  const face = { kind: 'face', canonical: 'face:xyz' };
  const feat = addCosmeticThread(face, { standard: 'M6 × 1.0', length: 15 });
  // Re-read through the store map; ensure params are stable.
  const reread = getDocumentStore().doc.features[feat.id];
  assert.equal(reread.type, 'CosmeticThread');
  assert.equal(reread.params.standard, 'M6 × 1.0');
  assert.equal(reread.params.length, 15);
  assert.deepEqual(reread.params.face, face);
});

console.log(`\n${_pass} passed, ${_fail} failed`);
if (_fail > 0) process.exit(1);
