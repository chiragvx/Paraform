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

import { getDocumentStore, resetDocument } from '../../../lib/document/index.js';
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

/** Load a library document into the studio. Caller navigates to the studio. */
export function openDoc(id) {
    const d = getDoc(id);
    if (!d || !d.json) return false;
    try {
        loadDocumentFromJSON(d.json);
        library.currentId = d.id;
        persist();
        return true;
    } catch (e) {
        console.warn('[library] open failed:', e);
        return false;
    }
}

/** Start a fresh blank working document (not yet in the library). */
export function newDoc() {
    try { resetDocument(); } catch (e) { console.warn('[library] new failed:', e); return false; }
    library.currentId = null;
    return true;
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
