/**
 * Phase A1 / B2 — Reference-image canvas + insert-at-marker.
 *
 * Zero-dep node:assert. Registered in all.mjs (npm test).
 *
 * Covers:
 *   - ReferenceImage registered in FEATURE_TYPES under REFERENCE
 *   - addReferenceImage feature shape (dataUrl, size, placement, display)
 *   - defensive throw on missing dataUrl
 *   - emit produces comment-only python (no n_<id> binding)
 *   - ReferenceImage is excluded from the leaf-set
 *   - the KERNEL claim: adding a reference image leaves the body-producing
 *     code (n_<id> lines + leafIds) untouched, and tweaking opacity does NOT
 *     change the emitted code at all (cache-friendly, no recompile)
 *   - round-trip via toJSON / fromJSON preserves the dataUrl
 *   - insert-at-marker: an installed insert-index resolver splices new
 *     features into featureOrder instead of appending
 */
import assert from 'node:assert/strict';
import {
  getDocumentStore, resetDocumentStore, setInsertIndexResolver,
  addBox, addReferenceImage, updateReferenceImage,
  emitDocument,
  FEATURE_TYPES, CATEGORIES,
} from '../index.js';

let _pass = 0, _fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); _pass++; }
  catch (e) { console.error(`  FAIL ${name}\n    ${e?.stack || e?.message || e}`); _fail++; }
}
function freshDoc() {
  resetDocumentStore();
  return getDocumentStore();
}

// 1x1 transparent PNG data-URL — opaque blob is fine for these data tests.
const SAMPLE_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

console.log('── Phase A1 — Reference-image canvas + insert-at-marker ──');

// 1. Feature type registration
t('ReferenceImage registered in FEATURE_TYPES under REFERENCE', () => {
  assert.ok(FEATURE_TYPES.ReferenceImage, 'ReferenceImage missing from FEATURE_TYPES');
  assert.equal(FEATURE_TYPES.ReferenceImage.category, CATEGORIES.REFERENCE);
  assert.equal(FEATURE_TYPES.ReferenceImage.label, 'Reference Image');
});

// 2. addReferenceImage feature shape + defaults
t('addReferenceImage stores dataUrl + size + Z-up placement + display', () => {
  freshDoc();
  const f = addReferenceImage({ name: 'front.png', dataUrl: SAMPLE_DATA_URL });
  assert.equal(f.type, 'ReferenceImage');
  assert.equal(f.params.dataUrl, SAMPLE_DATA_URL);
  assert.equal(f.params.width_mm, 100);
  assert.equal(f.params.height_mm, 100);
  assert.deepEqual(f.params.origin, [0, 0, 0]);
  assert.deepEqual(f.params.normal, [0, 0, 1]);   // Z-up: lying on the ground, facing up
  assert.equal(f.params.opacity, 0.65);
  assert.equal(f.params.displayThrough, false);
  assert.equal(f.componentId, 'root');
});

// 3. defensive throw
t('addReferenceImage throws when dataUrl is missing', () => {
  freshDoc();
  assert.throws(() => addReferenceImage({ name: 'x.png' }), /dataUrl required/);
});

// 4. emit comment-only, no n_<id>
t('emit ReferenceImage produces comment-only python', () => {
  freshDoc();
  const f = addReferenceImage({ name: 'side.png', dataUrl: SAMPLE_DATA_URL });
  const { code } = emitDocument(getDocumentStore().doc);
  assert.ok(code.includes('# Reference image: side.png'),
    `expected comment for reference image; got:\n${code}`);
  assert.ok(!code.includes(`n_${f.id} =`),
    `ReferenceImage must not bind n_<id>; code:\n${code}`);
  // The huge dataUrl must NOT be baked into kernel code.
  assert.ok(!code.includes(SAMPLE_DATA_URL), 'dataUrl leaked into kernel code');
});

// 5. excluded from leaf set
t('ReferenceImage is not part of the bodies leaf set', () => {
  freshDoc();
  const box = addBox({ length: 5, width: 5, height: 5 });
  const img = addReferenceImage({ name: 'ref.png', dataUrl: SAMPLE_DATA_URL });
  const { leafIds } = emitDocument(getDocumentStore().doc);
  assert.ok(leafIds.includes(box.id), 'Box should be a leaf');
  assert.ok(!leafIds.includes(img.id), 'ReferenceImage must not be in leaf set');
});

// 6. KERNEL claim — body code untouched by a reference image, and opacity
//    tweaks change nothing in the emitted code (so the compile cache hits).
t('reference image leaves body code untouched; opacity tweak is cache-neutral', () => {
  // Measure within ONE doc so feature ids stay stable (the global id counter
  // is not reset by resetDocumentStore, so cross-doc id compares are invalid).
  const s = freshDoc();
  addBox({ length: 5, width: 5, height: 5 });
  const bodyLines = () => emitDocument(s.doc).code
    .split('\n').filter(l => l.trim().startsWith('n_')).sort();
  const baseLeafIds = emitDocument(s.doc).leafIds.slice().sort();
  const baseBodyLines = bodyLines();

  const img = addReferenceImage({ name: 'ref.png', dataUrl: SAMPLE_DATA_URL });
  assert.deepEqual(emitDocument(s.doc).leafIds.slice().sort(), baseLeafIds,
    'leafIds changed by a reference image');
  assert.deepEqual(bodyLines(), baseBodyLines,
    'body code changed by a reference image');

  // Tweaking opacity must not change the emitted code at all.
  const before = emitDocument(s.doc).code;
  updateReferenceImage(img.id, { opacity: 0.2 });
  const after = emitDocument(s.doc).code;
  assert.equal(after, before, 'opacity tweak changed emitted code (would bust the cache)');
});

// 7. round-trip
t('addReferenceImage round-trips through toJSON / fromJSON', () => {
  const s1 = freshDoc();
  const f = addReferenceImage({ name: 'keep.png', dataUrl: SAMPLE_DATA_URL, width_mm: 42, height_mm: 24 });
  const serialised = JSON.parse(JSON.stringify(s1.toJSON()));
  resetDocumentStore();
  const s2 = getDocumentStore();
  s2.fromJSON(serialised);
  const restored = s2.doc.features[f.id];
  assert.ok(restored, 'feature missing after fromJSON');
  assert.equal(restored.params.dataUrl, SAMPLE_DATA_URL);
  assert.equal(restored.params.width_mm, 42);
  assert.equal(restored.params.height_mm, 24);
});

// 8. insert-at-marker (Phase B2) — universal via the store resolver
t('insert-index resolver splices new features instead of appending', () => {
  const s = freshDoc();
  const a = addBox({ length: 1, width: 1, height: 1 });
  const b = addBox({ length: 1, width: 1, height: 1 });
  const c = addBox({ length: 1, width: 1, height: 1 });
  assert.deepEqual(s.doc.featureOrder, [a.id, b.id, c.id]);

  // Marker "after a" → insert at index 1.
  setInsertIndexResolver(() => 1);
  const d = addBox({ length: 1, width: 1, height: 1 });
  assert.deepEqual(s.doc.featureOrder, [a.id, d.id, b.id, c.id],
    'new feature should splice at the marker index');

  // Clearing the resolver restores append behaviour.
  setInsertIndexResolver(null);
  const e = addBox({ length: 1, width: 1, height: 1 });
  assert.deepEqual(s.doc.featureOrder, [a.id, d.id, b.id, c.id, e.id]);
});

console.log(`\n${_pass} passed, ${_fail} failed`);
if (_fail > 0) process.exit(1);
