/**
 * E5 v2 — Real zip-wrapped Share bundle.
 *
 * Verifies `buildBundleZip()` produces a single, valid zip archive
 * containing the .paraform.json + README.txt + optional screenshot.png,
 * with parseable JSON inside.
 *
 * Run via:
 *   node --import ./src/lib/commands/__tests__/_register.mjs \
 *        src/lib/__tests__/e5_v2_share_zip.mjs
 */
import assert from 'node:assert/strict';
import { unzipSync, strFromU8 } from 'fflate';
import {
  resetDocumentStore,
  getDocumentStore,
  addBox,
} from '../../../lib/document/index.js';
import {
  buildDocumentJSON,
  buildBundleZip,
  defaultBundleStem,
  PARAFORM_FILE_EXT,
} from '../document/file_io.js';

let _pass = 0, _fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); _pass++; }
  catch (e) { console.error(`  FAIL ${name}\n    ${e?.stack || e?.message || e}`); _fail++; }
}

console.log('── E5 v2 — Zip-wrapped share bundle ──');

function freshJSON(name = 'Widget') {
  resetDocumentStore();
  const store = getDocumentStore();
  store.doc.metadata = { ...(store.doc.metadata || {}), name };
  addBox(); addBox();
  return buildDocumentJSON();
}

t('buildBundleZip returns a Uint8Array', () => {
  const json = freshJSON();
  const bytes = buildBundleZip(json, null);
  assert.ok(bytes instanceof Uint8Array, 'expected Uint8Array');
  assert.ok(bytes.length > 0, 'zip should be non-empty');
});

t('zip header signature matches PK\\x03\\x04', () => {
  const json = freshJSON();
  const bytes = buildBundleZip(json, null);
  assert.equal(bytes[0], 0x50);
  assert.equal(bytes[1], 0x4b);
  assert.equal(bytes[2], 0x03);
  assert.equal(bytes[3], 0x04);
});

t('zip contains document.paraform.json + README.txt (no screenshot)', () => {
  const json = freshJSON();
  const bytes = buildBundleZip(json, null);
  const entries = unzipSync(bytes);
  const names = Object.keys(entries).sort();
  assert.deepEqual(names, ['README.txt', `document${PARAFORM_FILE_EXT}`].sort());
});

t('zip JSON entry parses back to original document', () => {
  const json = freshJSON('RoundTrip');
  const bytes = buildBundleZip(json, null);
  const entries = unzipSync(bytes);
  const text = strFromU8(entries[`document${PARAFORM_FILE_EXT}`]);
  const parsed = JSON.parse(text);
  assert.equal(parsed.version, 5);
  assert.equal(parsed.metadata?.name, 'RoundTrip');
  assert.ok(Array.isArray(parsed.changelog));
  assert.ok(parsed.changelog.length >= 2);
});

t('README.txt mentions zip bundle structure', () => {
  const json = freshJSON('Foo');
  const bytes = buildBundleZip(json, null);
  const entries = unzipSync(bytes);
  const readme = strFromU8(entries['README.txt']);
  assert.ok(readme.includes('Foo'), 'README missing doc name');
  assert.ok(/zip/i.test(readme), 'README should reference zip bundle');
  assert.ok(readme.includes('README.txt'), 'README missing self-reference');
  assert.ok(readme.includes(`document${PARAFORM_FILE_EXT}`));
});

t('screenshot.png included when bytes supplied', () => {
  const json = freshJSON();
  // Fake "PNG" bytes — content is opaque to zipSync.
  const fakePng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const bytes = buildBundleZip(json, fakePng);
  const entries = unzipSync(bytes);
  assert.ok(entries['screenshot.png'], 'screenshot.png entry missing');
  assert.deepEqual(Array.from(entries['screenshot.png']), Array.from(fakePng));
});

t('screenshot omitted cleanly when bytes is null/undefined', () => {
  const json = freshJSON();
  const a = unzipSync(buildBundleZip(json, null));
  const b = unzipSync(buildBundleZip(json, undefined));
  assert.ok(!a['screenshot.png']);
  assert.ok(!b['screenshot.png']);
});

t('defaultBundleStem sanitises bad chars + falls back', () => {
  assert.equal(defaultBundleStem({ metadata: { name: 'Hello/World' } }), 'Hello_World');
  assert.equal(defaultBundleStem({ metadata: {} }), 'document');
  assert.equal(defaultBundleStem({}), 'document');
  assert.equal(defaultBundleStem({ metadata: { name: 'a:b*c?' } }), 'a_b_c_');
});

t('accepts ArrayBuffer screenshot input', () => {
  const json = freshJSON();
  const ab = new ArrayBuffer(8);
  new Uint8Array(ab).set([1, 2, 3, 4, 5, 6, 7, 8]);
  const entries = unzipSync(buildBundleZip(json, ab));
  assert.ok(entries['screenshot.png']);
  assert.equal(entries['screenshot.png'].length, 8);
});

t('README + JSON content lengths > 0 inside zip', () => {
  const json = freshJSON();
  const entries = unzipSync(buildBundleZip(json, null));
  assert.ok(entries['README.txt'].length > 50);
  assert.ok(entries[`document${PARAFORM_FILE_EXT}`].length > 50);
});

console.log(`\n  ${_pass} pass · ${_fail} fail`);
if (_fail > 0) process.exit(1);
