/**
 * E6 — View / chrome polish.
 *
 * Run via:
 *   node --import ./src/lib/commands/__tests__/_register.mjs \
 *        src/lib/__tests__/e6_phase.mjs
 *
 * Covers:
 *   - bookmark store (add/list/remove/rename/per-doc scoping)
 *   - snapshotCamera shape
 *   - shortcut parse/format roundtrip + conflict detection
 *   - shortcut load/save with an injected storage
 *   - reparent validators (feature + component cycle detection)
 *   - rollback head computation + suppressed set
 *   - new commands present (display.hiddenEdges, display.xray,
 *     view.bookmark.save, timeline.clearRollback)
 */
import assert from 'node:assert/strict';
import {
  addBookmark, listBookmarks, removeBookmark, renameBookmark,
  snapshotCamera, clearBookmarks,
} from '../viewport/bookmarks.js';
import {
  parseCombo, formatCombo, combosEqual, eventToCombo,
  detectConflicts, loadShortcuts, saveShortcuts, resetShortcuts,
  DEFAULT_SHORTCUTS,
} from '../viewport/shortcuts.js';
import { canReparentFeature, canReparentComponent, componentAncestors } from '../document/reparent.js';
import {
  rollbackIndex, featuresSuppressedByRollback, isFeatureRolledOut, clampRollbackHead,
} from '../document/rollback.js';
import { COMMANDS } from '../commands/registry.js';

let _pass = 0, _fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); _pass++; }
  catch (e) { console.error(`  FAIL ${name}\n    ${e?.stack || e?.message || e}`); _fail++; }
}

// ── In-memory storage (Storage-shaped) ─────────────────────────────────────
function makeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    clear: () => m.clear(),
    _dump: () => Object.fromEntries(m),
  };
}

console.log('── E6 — view / chrome polish ──');

// ── 1. Bookmarks ────────────────────────────────────────────────────────────
t('addBookmark + listBookmarks round-trip', () => {
  const s = makeStorage();
  const b = addBookmark({
    docId: 'doc-a', name: 'Side',
    position: [10, 0, 5], target: [0, 0, 0], up: [0, 0, 1],
  }, s);
  assert.ok(b.id);
  assert.equal(b.name, 'Side');
  const list = listBookmarks('doc-a', s);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, b.id);
  assert.deepEqual(list[0].position, [10, 0, 5]);
});

t('bookmarks scoped per docId', () => {
  const s = makeStorage();
  addBookmark({ docId: 'doc-a', name: 'X', position: [1,2,3], target: [0,0,0], up: [0,0,1] }, s);
  addBookmark({ docId: 'doc-b', name: 'Y', position: [4,5,6], target: [0,0,0], up: [0,0,1] }, s);
  assert.equal(listBookmarks('doc-a', s).length, 1);
  assert.equal(listBookmarks('doc-b', s).length, 1);
  assert.equal(listBookmarks('doc-c', s).length, 0);
});

t('removeBookmark + renameBookmark', () => {
  const s = makeStorage();
  const b = addBookmark({ docId: 'd', name: 'A', position: [1,0,0], target: [0,0,0], up: [0,0,1] }, s);
  assert.ok(renameBookmark(b.id, 'A2', 'd', s));
  assert.equal(listBookmarks('d', s)[0].name, 'A2');
  assert.ok(removeBookmark(b.id, 'd', s));
  assert.equal(listBookmarks('d', s).length, 0);
  assert.equal(removeBookmark('does-not-exist', 'd', s), false);
});

t('snapshotCamera shape', () => {
  const fakeCam = { position: { x: 1, y: 2, z: 3 }, up: { x: 0, y: 0, z: 1 } };
  const fakeCtrls = { target: { x: 4, y: 5, z: 6 } };
  const snap = snapshotCamera(fakeCam, fakeCtrls);
  assert.deepEqual(snap.position, [1, 2, 3]);
  assert.deepEqual(snap.target, [4, 5, 6]);
  assert.deepEqual(snap.up, [0, 0, 1]);
});

t('addBookmark rejects bad inputs', () => {
  const s = makeStorage();
  assert.throws(() => addBookmark({ docId: 'd', name: 'A', position: [1,2], target: [0,0,0], up: [0,0,1] }, s),
    /position/);
  assert.throws(() => addBookmark({ docId: 'd', name: '', position: [1,2,3], target: [0,0,0], up: [0,0,1] }, s),
    /name/);
});

// ── 2. Shortcuts ────────────────────────────────────────────────────────────
t('parseCombo + formatCombo round-trip', () => {
  const c = parseCombo('Ctrl+Shift+K');
  assert.equal(c.ctrl, true);
  assert.equal(c.shift, true);
  assert.equal(c.key, 'k');
  assert.equal(formatCombo(c), 'Ctrl+Shift+K');
  const c2 = parseCombo('F');
  assert.equal(c2.key, 'f');
  assert.equal(c2.ctrl, false);
  assert.equal(formatCombo(c2), 'F');
});

t('eventToCombo + combosEqual + matchCombo', () => {
  const ev = { key: 'k', ctrlKey: true, shiftKey: false, altKey: false, metaKey: false };
  const c = eventToCombo(ev);
  const parsed = parseCombo('Ctrl+K');
  assert.ok(combosEqual(c, parsed));
});

t('detectConflicts surfaces duplicates', () => {
  const conflicts = detectConflicts({
    'a': 'Ctrl+K',
    'b': 'Ctrl+K',
    'c': 'F',
    'd': 'F',
    'e': 'M',
  });
  assert.equal(conflicts.length, 2);
  const byCombo = Object.fromEntries(conflicts.map((c) => [c.combo, c.commandIds.sort()]));
  assert.deepEqual(byCombo['Ctrl+K'], ['a', 'b']);
  assert.deepEqual(byCombo['F'], ['c', 'd']);
});

t('detectConflicts ignores empty bindings', () => {
  const conflicts = detectConflicts({ 'a': '', 'b': '' });
  assert.equal(conflicts.length, 0);
});

t('loadShortcuts + saveShortcuts via injected storage', () => {
  const s = makeStorage();
  const initial = loadShortcuts(s);
  assert.equal(initial['palette.open'], DEFAULT_SHORTCUTS['palette.open']);
  saveShortcuts({ 'edit.undo': 'Ctrl+Shift+Z' }, s);
  const reloaded = loadShortcuts(s);
  assert.equal(reloaded['edit.undo'], 'Ctrl+Shift+Z');
  // Defaults remain merged for keys not overridden.
  assert.equal(reloaded['view.fit'], 'F');
  resetShortcuts(s);
  assert.equal(loadShortcuts(s)['edit.undo'], DEFAULT_SHORTCUTS['edit.undo']);
});

// ── 3. Reparent validators ─────────────────────────────────────────────────
const fakeDoc = () => ({
  components: {
    root:   { id: 'root',   name: 'root',   parentId: null },
    asm:    { id: 'asm',    name: 'asm',    parentId: 'root' },
    sub:    { id: 'sub',    name: 'sub',    parentId: 'asm' },
    other:  { id: 'other',  name: 'other',  parentId: 'root' },
  },
  features: {
    f1: { id: 'f1', componentId: 'root', name: 'Box' },
    f2: { id: 'f2', componentId: 'asm',  name: 'Cyl' },
  },
  featureOrder: ['f1', 'f2'],
});

t('canReparentFeature: legal move', () => {
  const r = canReparentFeature(fakeDoc(), 'f1', 'asm');
  assert.equal(r.ok, true);
});

t('canReparentFeature: rejects no-op (same component)', () => {
  const r = canReparentFeature(fakeDoc(), 'f1', 'root');
  assert.equal(r.ok, false);
  assert.match(r.reason, /already in target/);
});

t('canReparentFeature: rejects missing feature or target', () => {
  assert.equal(canReparentFeature(fakeDoc(), 'ghost', 'asm').ok, false);
  assert.equal(canReparentFeature(fakeDoc(), 'f1', 'ghost').ok, false);
});

t('canReparentComponent: rejects cycle', () => {
  // sub is under asm; reparenting asm under sub would create a cycle.
  const r = canReparentComponent(fakeDoc(), 'asm', 'sub');
  assert.equal(r.ok, false);
  assert.match(r.reason, /cycle/);
});

t('canReparentComponent: rejects self', () => {
  const r = canReparentComponent(fakeDoc(), 'asm', 'asm');
  assert.equal(r.ok, false);
});

t('canReparentComponent: rejects root move', () => {
  const r = canReparentComponent(fakeDoc(), 'root', 'asm');
  assert.equal(r.ok, false);
  assert.match(r.reason, /root/);
});

t('canReparentComponent: legal sibling move', () => {
  const r = canReparentComponent(fakeDoc(), 'sub', 'other');
  assert.equal(r.ok, true);
});

t('componentAncestors walks up the chain', () => {
  const a = componentAncestors(fakeDoc(), 'sub');
  assert.ok(a.includes('sub'));
  assert.ok(a.includes('asm'));
  assert.ok(a.includes('root'));
});

// ── 4. Rollback head ───────────────────────────────────────────────────────
t('rollbackIndex: present / absent', () => {
  const doc = { featureOrder: ['a', 'b', 'c', 'd'] };
  assert.equal(rollbackIndex(doc, 'a'), 0);
  assert.equal(rollbackIndex(doc, 'c'), 2);
  assert.equal(rollbackIndex(doc, 'missing'), -1);
  assert.equal(rollbackIndex(null, 'a'), -1);
});

t('featuresSuppressedByRollback: head at "b" hides c and d', () => {
  const doc = { featureOrder: ['a', 'b', 'c', 'd'] };
  const s = featuresSuppressedByRollback(doc, 'b');
  assert.ok(s.has('c'));
  assert.ok(s.has('d'));
  assert.equal(s.has('a'), false);
  assert.equal(s.has('b'), false); // marker feature itself is visible
});

t('featuresSuppressedByRollback: null head → empty', () => {
  const doc = { featureOrder: ['a', 'b'] };
  assert.equal(featuresSuppressedByRollback(doc, null).size, 0);
});

t('isFeatureRolledOut', () => {
  const doc = { featureOrder: ['a', 'b', 'c'] };
  assert.equal(isFeatureRolledOut(doc, 'a', 'b'), true);
  assert.equal(isFeatureRolledOut(doc, 'b', 'a'), false);
  assert.equal(isFeatureRolledOut(doc, null, 'a'), false);
});

t('clampRollbackHead: rejects unknown feature ids', () => {
  const doc = { featureOrder: ['a', 'b'] };
  assert.equal(clampRollbackHead(doc, 'a'), 'a');
  assert.equal(clampRollbackHead(doc, 'ghost'), null);
  assert.equal(clampRollbackHead(doc, null), null);
});

// ── 5. New registry commands ────────────────────────────────────────────────
t('new commands registered', () => {
  const byId = Object.fromEntries(COMMANDS.map((c) => [c.id, c]));
  for (const id of [
    'display.hiddenEdges',
    'display.xray',
    'view.bookmark.save',
    'timeline.clearRollback',
  ]) {
    assert.ok(byId[id], `missing command ${id}`);
    assert.equal(typeof byId[id].run, 'function');
  }
});

// ── Done ────────────────────────────────────────────────────────────────────
console.log(`\n${_pass} passed, ${_fail} failed`);
if (_fail > 0) process.exit(1);
