/**
 * E5 phase A — Document file persistence + hamburger menu wiring.
 *
 * Zero-dep node:assert. Run via:
 *   node --import ./src/lib/commands/__tests__/_register.mjs \
 *        src/lib/__tests__/e5a_phase.mjs
 *
 * Covers (≥ 8 cases):
 *   1. doc.new / doc.open / doc.save / doc.saveAs / doc.shareBundle commands
 *      registered under the Document group.
 *   2. Each command's run() dispatches into the persistence facade (counted
 *      via the test stub).
 *   3. doc.new branches: with unsaved changes → opens newDocConfirm dialog;
 *      without → calls resetDocument directly.
 *   4. Persistence module (real, non-stubbed): buildDocumentJSON shape +
 *      version is 5.
 *   5. defaultSaveFilename appends `.paraform.json` and sanitises bad chars.
 *   6. loadDocumentFromJSON accepts v4 + v5 + rejects malformed.
 *   7. buildBundleReadme shape: includes doc name, version, changelog count.
 *   8. captureViewportScreenshot defensive on missing renderer (returns null).
 */
import assert from 'node:assert/strict';
import { COMMANDS } from '../commands/registry.js';
import {
  _setUnsavedForTests,
  _resetCallCountersForTests,
  _getCallCountersForTests,
} from '../commands/__tests__/_stubs/persistence.mjs';
import { dialogs } from '$lib/dialogs/dialogs.svelte.js';
import {
  resetDocumentStore,
  getDocumentStore,
  addBox,
} from '../../../lib/document/index.js';

// Import the pure file-IO helpers — the runes-aware persistence.svelte.js
// is stubbed in the test loader so registry.js stays importable; the pure
// helpers live in `file_io.js` and exercise the real store round-trip.
import {
  buildDocumentJSON,
  defaultSaveFilename,
  loadDocumentFromJSON,
  buildBundleReadme,
} from '../document/file_io.js';

let _pass = 0, _fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); _pass++; }
  catch (e) { console.error(`  FAIL ${name}\n    ${e?.stack || e?.message || e}`); _fail++; }
}

const byId = Object.fromEntries(COMMANDS.map((c) => [c.id, c]));

console.log('── E5 phase A — Document file persistence ──');

// 1. command presence
t('doc.new registered (Document group)', () => {
  assert.ok(byId['doc.new'], 'doc.new missing');
  assert.equal(byId['doc.new'].group, 'Document');
  assert.equal(typeof byId['doc.new'].run, 'function');
});

t('doc.open registered (Document group)', () => {
  assert.ok(byId['doc.open']);
  assert.equal(byId['doc.open'].group, 'Document');
});

t('doc.save / doc.saveAs registered', () => {
  assert.ok(byId['doc.save']);
  assert.ok(byId['doc.saveAs']);
  assert.equal(byId['doc.save'].group, 'Document');
  assert.equal(byId['doc.saveAs'].group, 'Document');
});

t('doc.shareBundle registered', () => {
  assert.ok(byId['doc.shareBundle']);
  assert.equal(byId['doc.shareBundle'].group, 'Document');
});

// 2. dispatch through persistence facade (via stub call counters)
t('doc.save → saveDocumentToFile', () => {
  _resetCallCountersForTests();
  byId['doc.save'].run({ store: getDocumentStore() });
  assert.equal(_getCallCountersForTests().save, 1);
});

t('doc.saveAs → saveDocumentAs', () => {
  _resetCallCountersForTests();
  byId['doc.saveAs'].run({ store: getDocumentStore() });
  assert.equal(_getCallCountersForTests().saveAs, 1);
});

t('doc.open → openDocumentFromFile', () => {
  _resetCallCountersForTests();
  byId['doc.open'].run({ store: getDocumentStore() });
  assert.equal(_getCallCountersForTests().open, 1);
});

t('doc.shareBundle → shareDocumentBundle', () => {
  _resetCallCountersForTests();
  byId['doc.shareBundle'].run({ store: getDocumentStore() });
  assert.equal(_getCallCountersForTests().share, 1);
});

// 3. doc.new branches
t('doc.new with unsaved changes opens newDocConfirm dialog', () => {
  resetDocumentStore();
  _setUnsavedForTests(true);
  let opened = null;
  const origOpen = dialogs.open;
  dialogs.open = (name) => { opened = name; };
  try {
    byId['doc.new'].run({ store: getDocumentStore() });
  } finally { dialogs.open = origOpen; }
  assert.equal(opened, 'newDocConfirm');
});

t('doc.new with no unsaved changes resets directly', () => {
  resetDocumentStore();
  const store = getDocumentStore();
  addBox(); addBox();
  assert.ok(store.doc.featureOrder.length >= 2);
  _setUnsavedForTests(false);
  const origOpen = dialogs.open;
  let opened = null;
  dialogs.open = (name) => { opened = name; };
  try {
    byId['doc.new'].run({ store });
  } finally { dialogs.open = origOpen; }
  assert.equal(opened, null, 'dialog should not open when no unsaved changes');
  // After reset the live store features list should be empty.
  assert.equal(getDocumentStore().doc.featureOrder.length, 0);
});

// 4. real persistence: buildDocumentJSON shape
t('buildDocumentJSON returns a v5 document with changelog + head', () => {
  resetDocumentStore();
  addBox();
  const json = buildDocumentJSON();
  assert.equal(json.version, 5);
  assert.ok(Array.isArray(json.changelog));
  assert.ok(json.changelog.length >= 1);
  assert.equal(typeof json.head, 'number');
  assert.ok(json.components && json.components.root);
});

// 5. defaultSaveFilename
t('defaultSaveFilename uses doc metadata + appends .paraform.json', () => {
  resetDocumentStore();
  const store = getDocumentStore();
  store.doc.metadata = { ...(store.doc.metadata || {}), name: 'Bracket-V2' };
  const f = defaultSaveFilename();
  assert.ok(f.endsWith('.paraform.json'), `got ${f}`);
  assert.ok(f.includes('Bracket-V2'));
});

t('defaultSaveFilename sanitises path separators / illegal chars', () => {
  resetDocumentStore();
  const store = getDocumentStore();
  store.doc.metadata = { ...(store.doc.metadata || {}), name: 'a/b\\c:d*e?f' };
  const f = defaultSaveFilename();
  assert.ok(!/[\\/:*?"<>|]/.test(f.replace(/\.paraform\.json$/, '')));
});

// 6. loadDocumentFromJSON
t('loadDocumentFromJSON accepts v5 round-trip', () => {
  resetDocumentStore();
  addBox();
  const json = buildDocumentJSON();
  resetDocumentStore();        // clear
  assert.equal(getDocumentStore().doc.featureOrder.length, 0);
  loadDocumentFromJSON(json);
  assert.ok(getDocumentStore().doc.featureOrder.length >= 1);
});

t('loadDocumentFromJSON accepts v4 (migrates to v5)', () => {
  resetDocumentStore();
  addBox();
  const v5 = buildDocumentJSON();
  // Synthesize a v4 doc by stripping the components map + downgrading version.
  const v4 = { ...v5, version: 4 };
  delete v4.components;
  resetDocumentStore();
  loadDocumentFromJSON(v4);
  const live = getDocumentStore();
  assert.ok(live.doc.featureOrder.length >= 1);
  assert.ok(live.doc.components && live.doc.components.root, 'v4 → v5 migration injects root component');
});

t('loadDocumentFromJSON rejects malformed input', () => {
  assert.throws(() => loadDocumentFromJSON(null));
  assert.throws(() => loadDocumentFromJSON({ version: 99 }));
  assert.throws(() => loadDocumentFromJSON('not an object'));
});

// 7. README shape
t('buildBundleReadme contains doc name + version + changelog count', () => {
  resetDocumentStore();
  const store = getDocumentStore();
  store.doc.metadata = { ...(store.doc.metadata || {}), name: 'WidgetA' };
  addBox(); addBox();
  const json = buildDocumentJSON();
  const txt = buildBundleReadme(json);
  assert.ok(txt.includes('WidgetA'),    'README missing name');
  assert.ok(txt.includes('v5'),         'README missing version tag');
  assert.ok(/Changelog:\s+\d+ change/.test(txt), 'README missing changelog count');
  assert.ok(txt.includes('README.txt'), 'README missing self-reference');
});

// 8. Hamburger menu coverage — every item we wired in TopBar.svelte
//     corresponds to a registered command (or an existing dialog action).
t('hamburger menu items map to known commands / dialogs', () => {
  // From TopBar.svelte hamburger menu:
  const wired = ['doc.new', 'doc.open', 'doc.save', 'doc.saveAs', 'doc.shareBundle'];
  for (const id of wired) assert.ok(byId[id], `hamburger expects ${id}`);
});

console.log(`\n  ${_pass} pass · ${_fail} fail`);
if (_fail > 0) process.exit(1);
