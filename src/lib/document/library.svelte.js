/**
 * Document library — the user's saved files, organised in folders.
 *
 * The app had only a single autosaved document (localStorage
 * 'paraform_v4_document'); there was no way to keep MANY documents or organise
 * them. This store is that: a browser-persisted library of full document
 * snapshots grouped into folders, with save / open / new / import flows.
 *
 * Each library entry is a full `store.toJSON()` snapshot (so opening it restores
 * the exact document) plus an optional iso-view thumbnail captured from the live
 * viewport. The autosave layer still tracks the *working* document; saving here
 * takes a named snapshot, and opening loads a snapshot back into the studio.
 *
 * Reactive surface (read by LibraryView):
 *   library.folders   — [{ id, name, createdAt }]
 *   library.docs      — [{ id, name, folderId, json, thumb, createdAt, updatedAt }]
 *   library.currentId — the library entry the working doc maps to (for Save)
 *
 * API: ensureHydrated(), createFolder/renameFolder/deleteFolder, docsIn(folderId),
 * saveCurrent({name,folderId}), saveAsNew(...), openDoc(id), newDoc(),
 * renameDoc/moveDoc/deleteDoc/duplicateDoc.
 */

import { getDocumentStore, resetDocument, DocumentStore } from '../../../lib/document/index.js';
import { buildDocumentJSON, loadDocumentFromJSON } from './persistence.svelte.js';
import { captureSnapshots, hasSnapshotProvider } from '../../../lib/viewport/snapshot.js';
import { isCloudEnabled } from '../../../lib/cloud.js';
import { session } from '../auth/session.svelte.js';
import {
    cloudListFolders, cloudUpsertFolder, cloudDeleteFolder,
    cloudListDocuments, cloudUpsertDocument, cloudDeleteDocument,
} from '../../../lib/cloud_projects.js';

const LS_KEY = 'paraform.library.v1';
const MAX_BYTES = 4_700_000;

export const library = $state({
    folders: [],   // [{ id, name, createdAt }]
    docs: [],      // [{ id, name, folderId, json, thumb, createdAt, updatedAt }]
    currentId: null,
});

let _hydrated = false;
let _saveTimer = null;

function uid(p) { return `${p}_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`; }

// ── Cloud mirror (local-first; fire-and-forget when signed in) ───────────────
function _uid() { try { return session.user?.id || null; } catch { return null; } }
function _cloudReady() { return isCloudEnabled() && !!_uid(); }
function _pushFolder(f) { if (_cloudReady() && f) cloudUpsertFolder(_uid(), f); }
function _pushDoc(d) { if (_cloudReady() && d) cloudUpsertDocument(_uid(), d); }

// Cloud writes from the live auto-save-back loop are throttled per-document so
// a flurry of edits doesn't hammer Supabase — local persistence stays instant,
// the cloud mirror settles a few seconds after the user stops typing.
const CLOUD_PUSH_MS = 4000;
const _cloudTimers = new Map();
function _pushDocDebounced(d) {
    if (!_cloudReady() || !d || !d.id) return;
    const t = _cloudTimers.get(d.id);
    if (t) clearTimeout(t);
    _cloudTimers.set(d.id, setTimeout(() => { _cloudTimers.delete(d.id); _pushDoc(d); }, CLOUD_PUSH_MS));
}

// A pristine, document-shaped JSON blob for a brand-new file. Built from a
// throwaway DocumentStore so we never have to hand-maintain the empty shape —
// `toJSON()` already stamps version 5, so `loadDocumentFromJSON` accepts it.
function blankDocJSON() {
    try { return new DocumentStore().toJSON(); } catch { return null; }
}
// A document is "blank" when nothing has been committed to it yet — used to
// avoid materialising junk "Untitled" entries for the default seed.
function _isBlank(json) {
    try { return !json || !Array.isArray(json.changelog) || json.changelog.length === 0; }
    catch { return true; }
}

function deriveName() {
    try {
        const meta = getDocumentStore().doc.metadata || {};
        const n = (meta.name || meta.title || '').trim();
        if (n) return n;
    } catch { /* */ }
    return 'Untitled';
}

export function ensureHydrated() {
    if (_hydrated) return;
    _hydrated = true;
    try {
        if (typeof localStorage !== 'undefined') {
            const raw = localStorage.getItem(LS_KEY);
            if (raw) {
                const data = JSON.parse(raw);
                if (data && Array.isArray(data.docs)) {
                    library.docs = data.docs;
                    library.folders = Array.isArray(data.folders) ? data.folders : [];
                    library.currentId = data.currentId || null;
                }
            }
        }
    } catch { /* corrupt store — start empty */ }
}

function _serialize(withThumbs) {
    return JSON.stringify({
        v: 1,
        currentId: library.currentId,
        folders: library.folders,
        docs: library.docs.map((d) => (withThumbs ? d : { ...d, thumb: null })),
    });
}

function persist() {
    if (typeof localStorage === 'undefined') return;
    try {
        let payload = _serialize(true);
        if (payload.length > MAX_BYTES) payload = _serialize(false); // drop thumbnails to fit
        localStorage.setItem(LS_KEY, payload);
    } catch {
        // Quota exceeded even without thumbs — best effort: try thumbless once.
        try { localStorage.setItem(LS_KEY, _serialize(false)); } catch { /* give up; stays in memory */ }
    }
}

function markDirty() {
    if (_saveTimer || typeof setTimeout === 'undefined') { persist(); return; }
    _saveTimer = setTimeout(() => { _saveTimer = null; persist(); }, 300);
}

// ── Folders ────────────────────────────────────────────────────────────────
export function createFolder(name) {
    const f = { id: uid('fld'), name: (name || 'New folder').trim() || 'New folder', createdAt: Date.now(), updatedAt: Date.now() };
    library.folders = [f, ...library.folders];
    persist();
    _pushFolder(f);
    return f;
}
export function renameFolder(id, name) {
    const f = library.folders.find((x) => x.id === id);
    if (!f) return false;
    f.name = (name || '').trim() || f.name;
    f.updatedAt = Date.now();
    library.folders = [...library.folders];
    persist();
    _pushFolder(f);
    return true;
}
export function deleteFolder(id) {
    library.folders = library.folders.filter((f) => f.id !== id);
    // Orphan its docs back to "uncategorised" rather than deleting them.
    const orphaned = [];
    for (const d of library.docs) if (d.folderId === id) { d.folderId = null; d.updatedAt = Date.now(); orphaned.push(d); }
    library.docs = [...library.docs];
    persist();
    if (_cloudReady()) { cloudDeleteFolder(_uid(), id); for (const d of orphaned) _pushDoc(d); }
}

// ── Documents ──────────────────────────────────────────────────────────────
/** Docs in a folder. folderId: 'all' = everything, null = uncategorised, else a folder id. */
export function docsIn(folderId) {
    const list = library.docs.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    if (folderId === 'all' || folderId === undefined) return list;
    if (folderId === null) return list.filter((d) => !d.folderId);
    return list.filter((d) => d.folderId === folderId);
}

export function getDoc(id) { return library.docs.find((d) => d.id === id) || null; }

async function _thumb() {
    try {
        if (!hasSnapshotProvider()) return null;
        const shots = await captureSnapshots(['iso']);
        return (shots && shots[0] && shots[0].dataUrl) || null;
    } catch { return null; }
}

/**
 * Save the working document into the library. Updates the current entry if the
 * working doc came from the library; otherwise creates a new one. Returns the entry.
 */
export async function saveCurrent({ name, folderId } = {}) {
    let json;
    try { json = buildDocumentJSON(); } catch { json = null; }
    if (!json) return null;
    const thumb = await _thumb();
    const existing = library.currentId ? getDoc(library.currentId) : null;
    if (existing) {
        existing.json = json;
        if (thumb) existing.thumb = thumb;
        if (name && name.trim()) existing.name = name.trim();
        if (folderId !== undefined) existing.folderId = folderId;
        existing.updatedAt = Date.now();
        library.docs = [...library.docs];
        persist();
        _pushDoc(existing);
        return existing;
    }
    return saveAsNew({ name: name || deriveName(), folderId: folderId ?? null, json, thumb });
}

export function saveAsNew({ name, folderId = null, json, thumb = null } = {}) {
    const doc = {
        id: uid('doc'),
        name: (name || deriveName()).trim() || 'Untitled',
        folderId: folderId ?? null,
        json: json || (() => { try { return buildDocumentJSON(); } catch { return null; } })(),
        thumb: thumb || null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };
    if (!doc.json) return null;
    library.docs = [doc, ...library.docs];
    library.currentId = doc.id;
    persist();
    _pushDoc(doc);
    return doc;
}

/**
 * Capture the live working document into its library entry *now* (synchronous).
 * Called before any switch (open/new) so in-flight edits are never lost. If the
 * working doc isn't bound to a library entry yet but has real content, it is
 * materialised as a new entry so a switch can't drop unsaved work.
 */
export function flushActiveDoc() {
    let json;
    try { json = buildDocumentJSON(); } catch { json = null; }
    if (!json) return;
    const cur = library.currentId ? getDoc(library.currentId) : null;
    if (cur) {
        cur.json = json;
        cur.updatedAt = Date.now();
        library.docs = [...library.docs];
        persist();
        _pushDocDebounced(cur);
    } else if (!_isBlank(json)) {
        // Unbound working doc with content → give it a home before we navigate
        // away. saveAsNew sets currentId; the caller may immediately reassign it
        // (e.g. openDoc to a different file), but the entry persists either way.
        saveAsNew({ name: deriveName(), json });
    }
}

/**
 * Switch the studio to a library document. Flushes the current doc first (no
 * data loss), then loads the target IN PLACE via the shared store instance so
 * every subscription (autosave, active-doc sync, bridge) keeps working.
 * Caller navigates to the studio if needed.
 */
export function openDoc(id) {
    ensureHydrated();
    const d = getDoc(id);
    if (!d || !d.json) return false;
    if (id === library.currentId) return true;   // already the active document
    flushActiveDoc();                             // uses the OLD currentId
    library.currentId = d.id;                     // bind target before loading…
    try {
        loadDocumentFromJSON(d.json);             // …so the 'load' notify maps to the right entry
        persist();
        return true;
    } catch (e) {
        console.warn('[library] open failed:', e);
        return false;
    }
}

/**
 * Start a fresh document. Flushes the current one, resets the live store IN
 * PLACE to a blank seed (NOT resetDocumentStore — that swaps the instance and
 * orphans subscriptions), then materialises it as a real "Untitled" file so it
 * shows up in the library immediately. Returns true on success.
 */
export function newDoc() {
    ensureHydrated();
    flushActiveDoc();
    library.currentId = null;                     // detach before loading the seed
    const seed = blankDocJSON();
    try {
        if (seed) loadDocumentFromJSON(seed);
        else resetDocument();
    } catch (e) { console.warn('[library] new failed:', e); return false; }
    // Make every new document a real, listed file (sets currentId).
    return !!saveAsNew({ name: 'Untitled' });
}

/** Newest-first slice of the library, for the in-studio "recently opened" menu. */
export function recentDocs(limit = 6) {
    return library.docs
        .slice()
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
        .slice(0, Math.max(0, limit));
}

/** Duplicate the document that's currently open and switch to the copy. */
export function duplicateCurrent() {
    flushActiveDoc();
    if (!library.currentId) {
        const made = saveAsNew({ name: deriveName() });
        if (!made) return null;
    }
    const copy = duplicateDoc(library.currentId);
    if (copy) openDoc(copy.id);
    return copy;
}

/**
 * On boot: if a working document was restored but isn't bound to any library
 * entry (e.g. it predates the multi-document layer, or its entry was deleted),
 * give it a home so it shows up as a real file and starts syncing. No-op for a
 * blank seed or an already-bound document.
 */
export function adoptWorkingDocIfUnbound() {
    ensureHydrated();
    if (library.currentId && getDoc(library.currentId)) return null;
    let json;
    try { json = buildDocumentJSON(); } catch { return null; }
    if (!json || _isBlank(json)) return null;
    return saveAsNew({ name: deriveName(), json });
}

// ── Active-document sync (auto-save-back) ────────────────────────────────────
// The global-blob autosave (persistence.svelte.js) keeps the *working* doc
// restorable; this loop additionally mirrors every commit into the bound
// library entry so the library is the durable, switchable document set.
let _activeUnsub = null;
let _activeTimer = null;
const ACTIVE_SYNC_MS = 800;

function _writeActive() {
    const cur = library.currentId ? getDoc(library.currentId) : null;
    if (!cur) return;
    let json;
    try { json = buildDocumentJSON(); } catch { return; }
    if (!json) return;
    cur.json = json;
    cur.updatedAt = Date.now();
    library.docs = [...library.docs];
    persist();
    _pushDocDebounced(cur);
}

export function startActiveDocSync() {
    if (_activeUnsub || typeof window === 'undefined') return () => {};
    ensureHydrated();
    const store = getDocumentStore();
    _activeUnsub = store.subscribe((_doc, label) => {
        // select/refs don't change persisted state; loads are already captured
        // by openDoc/newDoc setting currentId, so the trailing write is a no-op.
        if (typeof label === 'string' && (label === 'select' || label === 'refs')) return;
        if (!library.currentId) return;           // unbound working doc → blob autosave covers it
        if (_activeTimer) clearTimeout(_activeTimer);
        _activeTimer = setTimeout(() => { _activeTimer = null; _writeActive(); }, ACTIVE_SYNC_MS);
    });
    return () => {
        if (_activeTimer) { clearTimeout(_activeTimer); _activeTimer = null; _writeActive(); }
        if (_activeUnsub) _activeUnsub();
        _activeUnsub = null;
    };
}

export function renameDoc(id, name) {
    const d = getDoc(id);
    if (!d) return false;
    d.name = (name || '').trim() || d.name;
    d.updatedAt = Date.now();
    library.docs = [...library.docs];
    persist();
    _pushDoc(d);
    return true;
}
export function moveDoc(id, folderId) {
    const d = getDoc(id);
    if (!d) return false;
    d.folderId = folderId ?? null;
    d.updatedAt = Date.now();
    library.docs = [...library.docs];
    persist();
    _pushDoc(d);
    return true;
}
export function deleteDoc(id) {
    library.docs = library.docs.filter((d) => d.id !== id);
    if (library.currentId === id) library.currentId = null;
    persist();
    if (_cloudReady()) cloudDeleteDocument(_uid(), id);
}
export function duplicateDoc(id) {
    const d = getDoc(id);
    if (!d) return null;
    const copy = { ...d, id: uid('doc'), name: `${d.name} copy`, createdAt: Date.now(), updatedAt: Date.now() };
    library.docs = [copy, ...library.docs];
    persist();
    _pushDoc(copy);
    return copy;
}

// ── Cloud pull + merge (call when the library page mounts) ────────────────────
let _synced = false;
export async function syncCloud(force = false) {
    if (!_cloudReady()) return;
    if (_synced && !force) return;
    _synced = true;
    ensureHydrated();
    const uid2 = _uid();
    let cf = [], cd = [];
    try { [cf, cd] = await Promise.all([cloudListFolders(uid2), cloudListDocuments(uid2)]); }
    catch { return; }

    // Folders: cloud wins on tie/newer; local-only get pushed up.
    const fmap = new Map(library.folders.map((f) => [f.id, f]));
    for (const c of cf) { const l = fmap.get(c.id); if (!l || (c.updatedAt || 0) >= (l.updatedAt || 0)) fmap.set(c.id, c); }
    const cfIds = new Set(cf.map((f) => f.id));
    const upFolders = library.folders.filter((l) => !cfIds.has(l.id));
    library.folders = [...fmap.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    // Documents: same merge rule.
    const dmap = new Map(library.docs.map((d) => [d.id, d]));
    for (const c of cd) { const l = dmap.get(c.id); if (!l || (c.updatedAt || 0) >= (l.updatedAt || 0)) dmap.set(c.id, c); }
    const cdIds = new Set(cd.map((d) => d.id));
    const upDocs = library.docs.filter((l) => !cdIds.has(l.id));
    library.docs = [...dmap.values()];

    persist();
    for (const f of upFolders) _pushFolder(f);   // migrate local-only up
    for (const d of upDocs) _pushDoc(d);
}
