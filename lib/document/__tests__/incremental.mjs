/**
 * Phase G4 — incremental recompile engine + emit checkpoint mode.
 * Zero-dep node:assert. Registered in all.mjs.
 *
 * Covers:
 *   - featureDepHashes: editing a feature changes ITS hash + DOWNSTREAM hashes
 *     but leaves UPSTREAM hashes untouched (the precise unchanged-prefix claim)
 *   - incrementalPlan: partitions reuse vs recompute against prior hashes
 *   - affectedFeatures: changed + transitive downstream
 *   - emit incremental:false (default) is byte-identical to no-arg emit
 *   - emit incremental:true wraps body features in _ckpt_get/_ckpt_put guards,
 *     does NOT wrap scene-only/comment features, and returns depHashes
 */
import assert from 'node:assert/strict';
import {
  getDocumentStore, resetDocumentStore,
  addBox, addFillet, addReferenceImage,
  setParamsChange,
  emitDocument,
} from '../index.js';
import { featureDepHashes, incrementalPlan, affectedFeatures } from '../dep_hash.js';

let _pass = 0, _fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); _pass++; }
  catch (e) { console.error(`  FAIL ${name}\n    ${e?.stack || e?.message || e}`); _fail++; }
}
function fresh() { resetDocumentStore(); return getDocumentStore(); }

console.log('── Phase G4 — incremental recompile (dep-hash + emit checkpoints) ──');

t('editing a feature changes its hash + downstream, NOT upstream', () => {
  const s = fresh();
  const box = addBox({ length: 10, width: 10, height: 10 });
  const fil = addFillet(box.id, { radius: 1 });          // fil depends on box

  const h0 = featureDepHashes(s.doc);
  const boxH0 = h0.get(box.id);
  const filH0 = h0.get(fil.id);

  // Edit the UPSTREAM box.
  s.commit(setParamsChange(box.id, { length: 20 }));
  const h1 = featureDepHashes(s.doc);
  assert.notEqual(h1.get(box.id), boxH0, 'edited box hash should change');
  assert.notEqual(h1.get(fil.id), filH0, 'downstream fillet hash should change');

  // Now edit only the DOWNSTREAM fillet — box hash must stay put.
  const boxH1 = h1.get(box.id);
  s.commit(setParamsChange(fil.id, { radius: 3 }));
  const h2 = featureDepHashes(s.doc);
  assert.equal(h2.get(box.id), boxH1, 'upstream box hash must NOT change when only fillet edited');
  assert.notEqual(h2.get(fil.id), h1.get(fil.id), 'edited fillet hash should change');
});

t('incrementalPlan partitions reuse vs recompute', () => {
  const s = fresh();
  const box = addBox({ length: 10, width: 10, height: 10 });
  const fil = addFillet(box.id, { radius: 1 });
  const prev = featureDepHashes(s.doc);

  // Edit the box → box + fillet recompute, nothing reusable here (only 2 feats,
  // both affected). Add an independent body that stays clean.
  const indep = addBox({ length: 3, width: 3, height: 3 });
  const prev2 = featureDepHashes(s.doc);
  s.commit(setParamsChange(box.id, { length: 20 }));

  const plan = incrementalPlan(prev2, s.doc);
  assert.ok(plan.recompute.includes(box.id), 'edited box must recompute');
  assert.ok(plan.recompute.includes(fil.id), 'downstream fillet must recompute');
  assert.ok(plan.reuse.includes(indep.id), 'independent body must be reusable');
  void prev;
});

t('affectedFeatures = changed + transitive downstream', () => {
  const s = fresh();
  const box = addBox({ length: 10, width: 10, height: 10 });
  const fil = addFillet(box.id, { radius: 1 });
  const aff = affectedFeatures(s.doc, [box.id]);
  assert.ok(aff.has(box.id) && aff.has(fil.id), 'box + downstream fillet affected');
  const affFil = affectedFeatures(s.doc, [fil.id]);
  assert.ok(affFil.has(fil.id) && !affFil.has(box.id), 'editing fillet does not affect upstream box');
});

t('emit incremental:false is byte-identical to default emit', () => {
  const s = fresh();
  addBox({ length: 10, width: 10, height: 10 });
  const a = emitDocument(s.doc).code;
  const b = emitDocument(s.doc, { incremental: false }).code;
  assert.equal(a, b, 'explicit incremental:false must match no-arg emit');
});

t('emit incremental:true wraps body features in _ckpt guards + returns hashes', () => {
  const s = fresh();
  const box = addBox({ length: 10, width: 10, height: 10 });
  const out = emitDocument(s.doc, { incremental: true });
  assert.ok(out.depHashes && out.depHashes[box.id], 'depHashes returned for the box');
  assert.ok(out.code.includes(`n_${box.id} = _ckpt_get(`), `box body should be cache-guarded:\n${out.code}`);
  assert.ok(out.code.includes(`_ckpt_put(`), 'should store the body after compute');
  assert.ok(out.code.includes(`if n_${box.id} is None:`), 'guard skips recompute on hit');
});

t('emit incremental:true does NOT wrap scene-only (comment) features', () => {
  const s = fresh();
  addBox({ length: 10, width: 10, height: 10 });
  const img = addReferenceImage({ name: 'ref.png', dataUrl: 'data:image/png;base64,AAAA' });
  const out = emitDocument(s.doc, { incremental: true });
  assert.ok(!out.code.includes(`n_${img.id} = _ckpt_get(`),
    'a comment-only ReferenceImage must not be cache-guarded');
});

console.log(`\n${_pass} passed, ${_fail} failed`);
if (_fail > 0) process.exit(1);
