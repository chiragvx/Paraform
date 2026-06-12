/**
 * E6 — View bookmarks (saved camera snapshots).
 *
 * Pure store with localStorage persistence (per-document scoping via doc id key).
 * UI lives in ViewCubeMount.svelte (bookmark list popover next to the cube);
 * tweens go through view_animator.js's
 * `tweenTo` so they inherit the same easing as named-view jumps.
 *
 * Bookmark shape:
 *   { id, name, position:[x,y,z], target:[x,y,z], up:[x,y,z], createdAt }
 */

const STORAGE_KEY = 'paraform_view_bookmarks_v1';

/** Read raw blob (per-doc keyed) from localStorage. Never throws. */
function _readAll(storage = (typeof localStorage !== 'undefined' ? localStorage : null)) {
  if (!storage) return {};
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}

function _writeAll(blob, storage = (typeof localStorage !== 'undefined' ? localStorage : null)) {
  if (!storage) return;
  try { storage.setItem(STORAGE_KEY, JSON.stringify(blob)); } catch {}
}

/** List bookmarks for a given doc. Returns a fresh array. */
export function listBookmarks(docId = 'default', storage) {
  const all = _readAll(storage);
  const list = Array.isArray(all[docId]) ? all[docId] : [];
  return list.map((b) => ({ ...b }));
}

/** Capture the camera state, validate, and append. Returns the new bookmark. */
export function addBookmark({ docId = 'default', name, position, target, up }, storage) {
  if (!name || typeof name !== 'string') throw new Error('addBookmark: name required');
  if (!Array.isArray(position) || position.length !== 3) throw new Error('addBookmark: position must be [x,y,z]');
  if (!Array.isArray(target) || target.length !== 3) throw new Error('addBookmark: target must be [x,y,z]');
  if (!Array.isArray(up) || up.length !== 3) up = [0, 0, 1];
  const bm = {
    id: `bm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    name: name.trim(),
    position: position.map(Number),
    target: target.map(Number),
    up: up.map(Number),
    createdAt: Date.now(),
  };
  const all = _readAll(storage);
  const list = Array.isArray(all[docId]) ? all[docId] : [];
  list.push(bm);
  all[docId] = list;
  _writeAll(all, storage);
  return bm;
}

export function removeBookmark(bookmarkId, docId = 'default', storage) {
  const all = _readAll(storage);
  const list = Array.isArray(all[docId]) ? all[docId] : [];
  const next = list.filter((b) => b.id !== bookmarkId);
  all[docId] = next;
  _writeAll(all, storage);
  return next.length !== list.length;
}

export function renameBookmark(bookmarkId, name, docId = 'default', storage) {
  if (!name || typeof name !== 'string') return false;
  const all = _readAll(storage);
  const list = Array.isArray(all[docId]) ? all[docId] : [];
  let hit = false;
  const next = list.map((b) => {
    if (b.id !== bookmarkId) return b;
    hit = true;
    return { ...b, name: name.trim() };
  });
  if (!hit) return false;
  all[docId] = next;
  _writeAll(all, storage);
  return true;
}

export function clearBookmarks(docId = 'default', storage) {
  const all = _readAll(storage);
  delete all[docId];
  _writeAll(all, storage);
}

/** Pure helper: capture a snapshot from a THREE camera + controls. */
export function snapshotCamera(camera, controls) {
  if (!camera) return null;
  const p = camera.position;
  const u = camera.up;
  const t = controls?.target;
  return {
    position: [p.x, p.y, p.z],
    target: t ? [t.x, t.y, t.z] : [0, 0, 0],
    up: [u.x, u.y, u.z],
  };
}
