/**
 * E6 — Shortcut customization.
 *
 * Pure helpers for:
 *   - parseCombo("Ctrl+Shift+K") → canonical { ctrl, shift, alt, meta, key }
 *   - formatCombo(combo)
 *   - detectConflicts(bindings) → [{commandId, otherCommandId, combo}, …]
 *   - loadShortcuts / saveShortcuts / resetShortcuts (localStorage)
 *   - matchCombo(event, combo)
 *
 * Bindings are stored as { commandId: comboString }. UI reads / writes via
 * load+save; the App.svelte keymap (and any future dispatcher) consults
 * loadShortcuts() + matchCombo() to resolve a keydown to a command.
 */

const STORAGE_KEY = 'paraform_shortcuts_v1';

/** Defaults — keep this small; one-line stamps from EditorReadiness E6.3. */
export const DEFAULT_SHORTCUTS = Object.freeze({
  'palette.open':         'Ctrl+K',
  'edit.undo':            'Ctrl+Z',
  'edit.redo':            'Ctrl+Y',
  'edit.delete':          'Delete',
  'view.fit':             'F',
  'display.toggleWire':   'W',
  'visibility.hideSelected': 'H',
  'visibility.isolateSelected': 'Ctrl+I',
  'doc.save':             'Ctrl+S',
  'doc.new':              'Ctrl+N',
  'tools.measure':        'M',
  'sketch.cancel':        'Escape',
  'view.front':           'Ctrl+1',
  'view.back':            'Ctrl+2',
  'view.left':            'Ctrl+3',
  'view.right':           'Ctrl+4',
  'view.top':             'Ctrl+5',
  'view.bottom':          'Ctrl+6',
  'view.iso':             'Ctrl+7',
});

/** Parse a combo string into a canonical object. Returns null when unparseable. */
export function parseCombo(s) {
  if (typeof s !== 'string') return null;
  const parts = s.split('+').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const combo = { ctrl: false, shift: false, alt: false, meta: false, key: '' };
  for (const p of parts) {
    const lower = p.toLowerCase();
    if (lower === 'ctrl' || lower === 'control') combo.ctrl = true;
    else if (lower === 'shift') combo.shift = true;
    else if (lower === 'alt' || lower === 'option') combo.alt = true;
    else if (lower === 'meta' || lower === 'cmd' || lower === '⌘') combo.meta = true;
    else combo.key = p.length === 1 ? p.toLowerCase() : p;
  }
  if (!combo.key) return null;
  return combo;
}

/** Inverse of parseCombo. Canonical capitalisation. */
export function formatCombo(combo) {
  if (!combo) return '';
  const out = [];
  if (combo.ctrl) out.push('Ctrl');
  if (combo.shift) out.push('Shift');
  if (combo.alt) out.push('Alt');
  if (combo.meta) out.push('Meta');
  if (combo.key) out.push(combo.key.length === 1 ? combo.key.toUpperCase() : combo.key);
  return out.join('+');
}

/** Read a keydown event and produce a canonical combo. */
export function eventToCombo(ev) {
  if (!ev || !ev.key) return null;
  // Modifier-only keypress → ignore (user is mid-chord).
  if (ev.key === 'Control' || ev.key === 'Shift' || ev.key === 'Alt' || ev.key === 'Meta') return null;
  return {
    ctrl: !!ev.ctrlKey,
    shift: !!ev.shiftKey,
    alt: !!ev.altKey,
    meta: !!ev.metaKey,
    key: ev.key.length === 1 ? ev.key.toLowerCase() : ev.key,
  };
}

/** Deep-equality of two combos (canonical). */
export function combosEqual(a, b) {
  if (!a || !b) return false;
  return a.ctrl === b.ctrl && a.shift === b.shift && a.alt === b.alt &&
    a.meta === b.meta && a.key === b.key;
}

/** Event matcher for runtime dispatch. */
export function matchCombo(ev, comboOrStr) {
  const c = typeof comboOrStr === 'string' ? parseCombo(comboOrStr) : comboOrStr;
  const ec = eventToCombo(ev);
  return combosEqual(c, ec);
}

/**
 * Detect any two command ids bound to the same combo. Returns an array of
 * { combo, commandIds: [...] } entries (only ids where length >= 2 land here).
 */
export function detectConflicts(bindings) {
  const byCombo = new Map();
  for (const [cmdId, str] of Object.entries(bindings || {})) {
    if (!str) continue;
    const c = parseCombo(str);
    if (!c) continue;
    const key = formatCombo(c);
    const arr = byCombo.get(key) || [];
    arr.push(cmdId);
    byCombo.set(key, arr);
  }
  const out = [];
  for (const [combo, ids] of byCombo) {
    if (ids.length >= 2) out.push({ combo, commandIds: ids });
  }
  return out;
}

export function loadShortcuts(storage = (typeof localStorage !== 'undefined' ? localStorage : null)) {
  const merged = { ...DEFAULT_SHORTCUTS };
  if (!storage) return merged;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return merged;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') Object.assign(merged, parsed);
  } catch {}
  return merged;
}

// ── E6 v2 — live subscription. saveShortcuts / resetShortcuts notify
// subscribers (e.g. App.svelte's keymap dispatcher) so edits in the
// ShortcutsPanel apply without a page reload.
const _shortcutSubs = new Set();

export function subscribeShortcuts(fn) {
  if (typeof fn !== 'function') return () => {};
  _shortcutSubs.add(fn);
  return () => { _shortcutSubs.delete(fn); };
}

function _notifyShortcuts(bindings) {
  for (const fn of _shortcutSubs) {
    try { fn(bindings); } catch (err) { console.warn('[shortcuts] subscriber', err); }
  }
}

export function saveShortcuts(bindings, storage = (typeof localStorage !== 'undefined' ? localStorage : null)) {
  if (storage) {
    try { storage.setItem(STORAGE_KEY, JSON.stringify(bindings || {})); } catch {}
  }
  _notifyShortcuts(bindings || {});
}

export function resetShortcuts(storage = (typeof localStorage !== 'undefined' ? localStorage : null)) {
  if (storage) {
    try { storage.removeItem(STORAGE_KEY); } catch {}
  }
  _notifyShortcuts({ ...DEFAULT_SHORTCUTS });
}

/** Per-command lookup. */
export function getShortcutFor(commandId, bindings) {
  const b = bindings || loadShortcuts();
  return b[commandId] || null;
}

// ── E4 v2 — marking-menu binding persistence ──────────────────────────────
// 8 sectors (n, ne, e, se, s, sw, w, nw) → command id. Stored under a
// separate localStorage key so the data shape stays simple; the viewport
// reads loadMarkingMenuBindings() at menu open-time so edits in the
// Settings panel apply on the next RMB press without reload.

const MARKING_MENU_STORAGE_KEY = 'paraform_marking_menu_v1';

export const MARKING_MENU_SECTORS = Object.freeze(['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']);

// Defaults route the eight most common viewport actions to the cardinals so a
// flick out of RMB-down lands a command without ever rendering the pie:
//   N  Measure (M)            — most-used callable
//   NE Section view toggle    — clip-plane on/off
//   E  Move (xform)           — primary edit
//   SE Isolate selection      — show only what's picked
//   S  Fit to selection (F)   — frame what's picked / all
//   SW Hide selected          — quick visibility flick
//   W  Show all hidden        — pair with SW
//   NW Fillet                 — the most-used modifier
//
// Each id resolves through the COMMANDS registry; un-mapped sectors are
// still configurable from Settings.
export const DEFAULT_MARKING_MENU = Object.freeze({
  n:  'tools.measure',
  ne: 'view.section.activate',
  e:  'xform.move',
  se: 'visibility.isolateSelected',
  s:  'view.fit',
  sw: 'visibility.hideSelected',
  w:  'visibility.showAll',
  nw: 'modifier.fillet',
});

export function loadMarkingMenuBindings(storage = (typeof localStorage !== 'undefined' ? localStorage : null)) {
  const merged = { ...DEFAULT_MARKING_MENU };
  if (!storage) return merged;
  try {
    const raw = storage.getItem(MARKING_MENU_STORAGE_KEY);
    if (!raw) return merged;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      for (const sec of MARKING_MENU_SECTORS) {
        if (typeof parsed[sec] === 'string') merged[sec] = parsed[sec];
        else if (parsed[sec] === null || parsed[sec] === '') merged[sec] = null;
      }
    }
  } catch {}
  return merged;
}

export function saveMarkingMenuBindings(bindings, storage = (typeof localStorage !== 'undefined' ? localStorage : null)) {
  if (!storage) return;
  try { storage.setItem(MARKING_MENU_STORAGE_KEY, JSON.stringify(bindings || {})); } catch {}
}

export function resetMarkingMenuBindings(storage = (typeof localStorage !== 'undefined' ? localStorage : null)) {
  if (!storage) return;
  try { storage.removeItem(MARKING_MENU_STORAGE_KEY); } catch {}
}
