/**
 * E4/E6 v2 follow-ups — marking-menu customization, live shortcut reload,
 * component-into-component reparent.
 *
 * Run via:
 *   node --import ./src/lib/commands/__tests__/_register.mjs \
 *        src/lib/__tests__/e4_e6_v2_followups.mjs
 */
import assert from 'node:assert/strict';
import {
  loadMarkingMenuBindings, saveMarkingMenuBindings, resetMarkingMenuBindings,
  DEFAULT_MARKING_MENU, MARKING_MENU_SECTORS,
  loadShortcuts, saveShortcuts, resetShortcuts, subscribeShortcuts,
} from '../viewport/shortcuts.js';
import { canReparentComponent } from '../document/reparent.js';
import {
  resetDocumentStore,
  addComponent, setComponentParent, addBox,
  setActiveComponentProvider,
} from '../../../lib/document/index.js';

let _pass = 0, _fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); _pass++; }
  catch (e) { console.error(`  FAIL ${name}\n    ${e?.stack || e?.message || e}`); _fail++; }
}

function makeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
  };
}

console.log('── E4/E6 v2 follow-ups ──');

// ── Marking-menu binding persistence ────────────────────────────────────
t('loadMarkingMenuBindings returns defaults when storage empty', () => {
  const s = makeStorage();
  const b = loadMarkingMenuBindings(s);
  for (const sec of MARKING_MENU_SECTORS) {
    assert.equal(b[sec], DEFAULT_MARKING_MENU[sec]);
  }
});

t('saveMarkingMenuBindings → loadMarkingMenuBindings round-trip', () => {
  const s = makeStorage();
  const next = { ...DEFAULT_MARKING_MENU, n: 'view.fit', ne: 'doc.save' };
  saveMarkingMenuBindings(next, s);
  const b = loadMarkingMenuBindings(s);
  assert.equal(b.n, 'view.fit');
  assert.equal(b.ne, 'doc.save');
  assert.equal(b.e, DEFAULT_MARKING_MENU.e);
});

t('clearing a sector to null persists as null/blank fallback', () => {
  const s = makeStorage();
  saveMarkingMenuBindings({ ...DEFAULT_MARKING_MENU, n: null }, s);
  const b = loadMarkingMenuBindings(s);
  assert.equal(b.n, null);
});

t('resetMarkingMenuBindings drops storage so defaults return', () => {
  const s = makeStorage();
  saveMarkingMenuBindings({ ...DEFAULT_MARKING_MENU, n: 'view.fit' }, s);
  resetMarkingMenuBindings(s);
  const b = loadMarkingMenuBindings(s);
  assert.equal(b.n, DEFAULT_MARKING_MENU.n);
});

// ── Live shortcut subscription ──────────────────────────────────────────
t('subscribeShortcuts fires on saveShortcuts', () => {
  const s = makeStorage();
  let received = null;
  const unsub = subscribeShortcuts((next) => { received = next; });
  saveShortcuts({ 'doc.save': 'Ctrl+Shift+S' }, s);
  assert.ok(received, 'subscriber received an update');
  assert.equal(received['doc.save'], 'Ctrl+Shift+S');
  unsub();
});

t('subscribeShortcuts fires on resetShortcuts with defaults', () => {
  const s = makeStorage();
  let received = null;
  const unsub = subscribeShortcuts((next) => { received = next; });
  resetShortcuts(s);
  assert.ok(received);
  assert.equal(received['edit.undo'], 'Ctrl+Z');
  unsub();
});

t('unsubscribed subscriber no longer fires (no double-firing on reload)', () => {
  const s = makeStorage();
  let count = 0;
  const unsub = subscribeShortcuts(() => { count++; });
  saveShortcuts({ a: 'A' }, s);
  unsub();
  saveShortcuts({ a: 'B' }, s);
  assert.equal(count, 1, 'only the pre-unsub save fired');
});

t('loadShortcuts after save reflects the persisted edit', () => {
  const s = makeStorage();
  saveShortcuts({ 'doc.save': 'Ctrl+Alt+S' }, s);
  const b = loadShortcuts(s);
  assert.equal(b['doc.save'], 'Ctrl+Alt+S');
});

// ── Component-into-component reparent ─────────────────────────────────
t('setComponentParent moves a component under a new parent', () => {
  const store = resetDocumentStore();
  setActiveComponentProvider(null);
  const a = addComponent({ name: 'A', parentId: 'root' });
  const b = addComponent({ name: 'B', parentId: 'root' });
  const ok = setComponentParent(a.id, b.id);
  assert.equal(ok, true);
  assert.equal(store.doc.components[a.id].parentId, b.id);
});

t('setComponentParent refuses self-reparent', () => {
  const store = resetDocumentStore();
  setActiveComponentProvider(null);
  const a = addComponent({ name: 'A', parentId: 'root' });
  const ok = setComponentParent(a.id, a.id);
  assert.equal(ok, false);
  assert.equal(store.doc.components[a.id].parentId, 'root');
});

t("setComponentParent refuses moving 'root'", () => {
  resetDocumentStore();
  setActiveComponentProvider(null);
  const a = addComponent({ name: 'A', parentId: 'root' });
  const ok = setComponentParent('root', a.id);
  assert.equal(ok, false);
});

t('setComponentParent refuses cycle (move parent under its descendant)', () => {
  const store = resetDocumentStore();
  setActiveComponentProvider(null);
  const a = addComponent({ name: 'A', parentId: 'root' });
  const b = addComponent({ name: 'B', parentId: a.id });
  // Moving A under B would create a cycle (A → B → A).
  const ok = setComponentParent(a.id, b.id);
  assert.equal(ok, false);
  assert.equal(store.doc.components[a.id].parentId, 'root');
});

t('setComponentParent refuses no-op (already at target)', () => {
  resetDocumentStore();
  setActiveComponentProvider(null);
  const a = addComponent({ name: 'A', parentId: 'root' });
  const ok = setComponentParent(a.id, 'root');
  assert.equal(ok, false);
});

t('setComponentParent refuses missing target', () => {
  resetDocumentStore();
  setActiveComponentProvider(null);
  const a = addComponent({ name: 'A', parentId: 'root' });
  const ok = setComponentParent(a.id, 'does-not-exist');
  assert.equal(ok, false);
});

t('setComponentParent is undoable', () => {
  const store = resetDocumentStore();
  setActiveComponentProvider(null);
  const a = addComponent({ name: 'A', parentId: 'root' });
  const b = addComponent({ name: 'B', parentId: 'root' });
  setComponentParent(a.id, b.id);
  assert.equal(store.doc.components[a.id].parentId, b.id);
  assert.equal(store.undo(), true);
  assert.equal(store.doc.components[a.id].parentId, 'root');
});

t('canReparentComponent agrees with setComponentParent guards', () => {
  const store = resetDocumentStore();
  setActiveComponentProvider(null);
  const a = addComponent({ name: 'A', parentId: 'root' });
  const b = addComponent({ name: 'B', parentId: a.id });
  // Same scenarios as above, but checking the validator directly.
  assert.equal(canReparentComponent(store.doc, a.id, b.id).ok, false); // cycle
  assert.equal(canReparentComponent(store.doc, a.id, a.id).ok, false); // self
  assert.equal(canReparentComponent(store.doc, 'root', a.id).ok, false); // root
  assert.equal(canReparentComponent(store.doc, b.id, 'root').ok, true); // valid
});

t('component reparent preserves features in moved subtree', () => {
  const store = resetDocumentStore();
  setActiveComponentProvider(null);
  const a = addComponent({ name: 'A', parentId: 'root' });
  const b = addComponent({ name: 'B', parentId: 'root' });
  const box = addBox({ length: 1, width: 1, height: 1, componentId: a.id });
  assert.equal(store.doc.features[box.id].componentId, a.id);
  setComponentParent(a.id, b.id);
  // Feature still owned by A; A is now under B.
  assert.equal(store.doc.features[box.id].componentId, a.id);
  assert.equal(store.doc.components[a.id].parentId, b.id);
});

console.log(`\n  ${_pass} passed, ${_fail} failed`);
if (_fail) process.exitCode = 1;
