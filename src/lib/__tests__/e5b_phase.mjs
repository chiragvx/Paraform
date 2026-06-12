/**
 * E5 phase B — Browser STEP import + ImportedMesh persistence.
 *
 * Zero-dep node:assert. Run via:
 *   node --import ./src/lib/commands/__tests__/_register.mjs \
 *        src/lib/__tests__/e5b_phase.mjs
 *
 * Covers:
 *   - addImportedMesh feature shape (name, format, glbBase64, transform)
 *   - defensive throws on missing required params
 *   - ImportedMesh emit produces comment-only Python (no n_<id> binding)
 *   - ImportedMesh is excluded from the leaf-set (no body output)
 *   - Round-trip: addImportedMesh + store.toJSON + store.fromJSON
 *     preserves glbBase64
 *   - Mock importStep-shaped result maps cleanly to addImportedMesh's
 *     expected input shape
 *   - ImportedMesh feature appears in the FEATURE_TYPES catalog under
 *     SCRIPTED category
 */
import assert from 'node:assert/strict';
import {
  getDocumentStore, resetDocumentStore,
  addBox, addImportedMesh,
  emitDocument,
  FEATURE_TYPES, CATEGORIES,
} from '../../../lib/document/index.js';

let _pass = 0, _fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); _pass++; }
  catch (e) { console.error(`  FAIL ${name}\n    ${e?.stack || e?.message || e}`); _fail++; }
}

function freshDoc() {
  resetDocumentStore();
  return getDocumentStore();
}

const SAMPLE_GLB_BASE64 = 'Z2xURgIAAABAAQAA';   // not a real GLB; opaque blob OK

console.log('── E5 phase B — STEP import + ImportedMesh ──');

// 1. Feature type registration
t('ImportedMesh registered in FEATURE_TYPES under SCRIPTED', () => {
  assert.ok(FEATURE_TYPES.ImportedMesh, 'ImportedMesh missing from FEATURE_TYPES');
  assert.equal(FEATURE_TYPES.ImportedMesh.category, CATEGORIES.SCRIPTED);
  assert.equal(FEATURE_TYPES.ImportedMesh.label, 'Imported Mesh');
});

// 2. addImportedMesh feature shape
t('addImportedMesh stores name + format + glbBase64', () => {
  freshDoc();
  const feat = addImportedMesh({
    name: 'sample.step',
    format: 'step',
    glbBase64: SAMPLE_GLB_BASE64,
  });
  assert.equal(feat.type, 'ImportedMesh');
  assert.equal(feat.name, 'sample.step');
  assert.equal(feat.params.name, 'sample.step');
  assert.equal(feat.params.format, 'step');
  assert.equal(feat.params.glbBase64, SAMPLE_GLB_BASE64);
  assert.equal(feat.componentId, 'root');
});

// 3. addImportedMesh tolerates optional transform
t('addImportedMesh threads optional transform onto params', () => {
  freshDoc();
  const transform = { position: [1, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1] };
  const feat = addImportedMesh({
    name: 'x.glb', format: 'glb', glbBase64: SAMPLE_GLB_BASE64, transform,
  });
  assert.deepEqual(feat.params.transform, transform);
});

// 4. defensive throws
t('addImportedMesh throws when name is missing', () => {
  freshDoc();
  assert.throws(() => addImportedMesh({ glbBase64: SAMPLE_GLB_BASE64 }), /name required/);
});
t('addImportedMesh throws when glbBase64 is missing', () => {
  freshDoc();
  assert.throws(() => addImportedMesh({ name: 'x.step' }), /glbBase64 required/);
});

// 5. Emit produces comment-only python; no n_<id> binding
t('emit ImportedMesh produces comment-only python', () => {
  freshDoc();
  const feat = addImportedMesh({
    name: 'gear.step', format: 'step', glbBase64: SAMPLE_GLB_BASE64,
  });
  const { code } = emitDocument(getDocumentStore().doc);
  assert.ok(code.includes(`# Imported mesh: gear.step (step)`),
    `expected comment for imported mesh; got:\n${code}`);
  // No `n_<id> = ...` assignment should appear for ImportedMesh
  assert.ok(!code.includes(`n_${feat.id} =`),
    `ImportedMesh must not bind n_<id>; code:\n${code}`);
});

// 6. ImportedMesh excluded from leaf set
t('ImportedMesh is not part of the bodies leaf set', () => {
  freshDoc();
  const box = addBox({ length: 5, width: 5, height: 5 });
  const imported = addImportedMesh({
    name: 'aux.step', format: 'step', glbBase64: SAMPLE_GLB_BASE64,
  });
  const { leafIds } = emitDocument(getDocumentStore().doc);
  assert.ok(leafIds.includes(box.id), 'Box should be a leaf');
  assert.ok(!leafIds.includes(imported.id), 'ImportedMesh must not be in leaf set');
});

// 7. Round-trip via store.toJSON / fromJSON preserves the GLB payload
t('addImportedMesh round-trips through toJSON / fromJSON', () => {
  const s1 = freshDoc();
  const feat = addImportedMesh({
    name: 'thing.step', format: 'step', glbBase64: SAMPLE_GLB_BASE64,
  });
  const json = s1.toJSON();
  const serialised = JSON.parse(JSON.stringify(json));
  resetDocumentStore();
  const s2 = getDocumentStore();
  s2.fromJSON(serialised);
  const restored = s2.doc.features[feat.id];
  assert.ok(restored, 'feature missing after fromJSON');
  assert.equal(restored.type, 'ImportedMesh');
  assert.equal(restored.params.glbBase64, SAMPLE_GLB_BASE64);
  assert.equal(restored.params.name, 'thing.step');
  assert.equal(restored.params.format, 'step');
});

// 8. Sanity: mock importStep-style result shape maps to addImportedMesh inputs
t('mock importStep result shape maps to addImportedMesh', () => {
  // Mirrors what src/lib/import/cad.js produces after encodeGlb +
  // arrayBufferToBase64.
  const mockFile = { name: 'mock.step' };
  const mockGlb  = SAMPLE_GLB_BASE64;
  freshDoc();
  const feat = addImportedMesh({
    name: mockFile.name,
    format: 'step',
    glbBase64: mockGlb,
  });
  assert.equal(feat.params.name, 'mock.step');
  assert.equal(feat.params.format, 'step');
  assert.equal(feat.params.glbBase64, mockGlb);
});

console.log(`\n${_pass} passed, ${_fail} failed`);
if (_fail > 0) process.exit(1);
