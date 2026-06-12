import { getDocumentStore } from '../../../lib/document/index.js';
import { studio } from '../studio/runtime.svelte.js';
import {
  PARAFORM_FILE_EXT as FILE_EXT,
  buildDocumentJSON as _buildDocumentJSON,
  defaultSaveFilename as _defaultSaveFilename,
  loadDocumentFromJSON as _loadDocumentFromJSON,
  buildBundleReadme,
  buildBundleZip,
  defaultBundleStem,
  dataURLToPNGBytes,
} from './file_io.js';

// Re-export pure helpers so callers keep importing from this module.
export { buildBundleReadme, PARAFORM_FILE_EXT } from './file_io.js';

const STORAGE_KEY = 'paraform_v4_document';
const DEBOUNCE_MS = 500;

// Events that should NOT trigger a save — selection/refs/set-head don't
// change the persisted document state (changelog + head + metadata).
const SKIP_EVENTS = new Set(['select', 'refs']);

function getCurrentKernelVersion() {
  return studio.bridge?.lastKernelVersion ?? null;
}

class PersistenceState {
  status = $state('idle');     // 'idle' | 'pending' | 'saved' | 'error'
  lastSavedAt = $state(null);  // epoch ms of last successful save
  restored = $state(false);    // true after a successful restore-on-boot
  // Kernel version block captured at restoreDocument() time (the version that
  // was live when the doc was last persisted). `null` if the saved doc predates
  // Foundation 2 or no doc was restored.
  restoredKernelVersion = $state(null);

  // `{ restored: 'x', current: 'y' }` when the restored doc was produced by a
  // different build123d version than the kernel currently reachable; `null`
  // when the versions agree or the bridge hasn't yet reported a live version.
  mismatchWarning = $derived.by(() => {
    const restored = this.restoredKernelVersion?.build123d;
    if (!restored) return null;
    const current = getCurrentKernelVersion()?.build123d;
    if (!current) return null;          // bridge hasn't fired yet — no warning
    if (restored === current) return null;
    return { restored, current };
  });
}

export const persistence = new PersistenceState();

/**
 * Synchronously restore the document from localStorage if one is stored.
 * Returns true iff a document was found and applied.
 *
 * Safe to call before the bridge boots — the bridge will pick up the loaded
 * document via its store-subscribe on first run.
 */
export function restoreDocument() {
  if (typeof localStorage === 'undefined') return false;
  let raw;
  try { raw = localStorage.getItem(STORAGE_KEY); }
  catch { return false; }
  if (!raw) return false;
  try {
    const json = JSON.parse(raw);
    // v4 and v5 both load — store.fromJSON runs migrateV4ToV5 on v4 docs.
    if (!json || (json.version !== 4 && json.version !== 5)) return false;
    const store = getDocumentStore();
    store.fromJSON(json);
    persistence.restored = true;
    persistence.restoredKernelVersion = store.loadedKernelVersion ?? null;
    persistence.status = 'saved';
    persistence.lastSavedAt = Date.now();
    return true;
  } catch (e) {
    console.warn('[persistence] restore failed:', e);
    return false;
  }
}

/**
 * Subscribe to the store and debounce-save to localStorage on every commit.
 * Returns a dispose function.
 */
export function startAutosave() {
  if (typeof localStorage === 'undefined') return () => {};
  const store = getDocumentStore();
  let timer = 0;

  function flush() {
    timer = 0;
    try {
      // Stash whatever kernel version the bridge has at flush time so it
      // serializes into the saved blob (avoids a separate bridge subscription).
      const live = getCurrentKernelVersion();
      if (live) store.setLastKernelVersion(live);
      const json = store.toJSON();
      localStorage.setItem(STORAGE_KEY, JSON.stringify(json));
      persistence.status = 'saved';
      persistence.lastSavedAt = Date.now();
    } catch (e) {
      console.warn('[persistence] save failed:', e);
      persistence.status = 'error';
    }
  }

  const unsub = store.subscribe((_doc, eventLabel) => {
    if (typeof eventLabel === 'string' && SKIP_EVENTS.has(eventLabel)) return;
    persistence.status = 'pending';
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, DEBOUNCE_MS);
  });

  return () => {
    if (timer) {
      clearTimeout(timer);
      flush(); // best-effort final save on dispose
    }
    unsub();
  };
}

// ── Save / Open helpers (E5.1) ─────────────────────────────────────────────

/**
 * Build the JSON blob that `Save` and `Save As` write. Returns the structure
 * that {@link saveDocumentToFile} serializes, exposed for tests + the
 * shareBundle helper so they can introspect what gets written.
 */
export function buildDocumentJSON() {
  try {
    const live = getCurrentKernelVersion();
    if (live) getDocumentStore().setLastKernelVersion(live);
  } catch { /* defensive — bridge may not be up */ }
  return _buildDocumentJSON();
}

/** Default file-save name for the current document. */
export const defaultSaveFilename = _defaultSaveFilename;

/**
 * Trigger a browser download of `data` with MIME type `mime` and the given
 * filename. Defensive on SSR / non-DOM contexts (returns false).
 */
function _triggerDownload(data, filename, mime = 'application/octet-stream') {
  if (typeof document === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) {
    return false;
  }
  try {
    const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Defer revoke so the click handler has flushed.
    setTimeout(() => { try { URL.revokeObjectURL(url); } catch {} }, 0);
    return true;
  } catch (e) {
    console.warn('[persistence] download failed:', e);
    return false;
  }
}
// Exposed for tests that want to assert on the download-trigger surface.
export { _triggerDownload as _triggerDownloadForTests };

/**
 * Save the current document to a `.paraform.json` file. Filename defaults to
 * the doc's metadata.name; pass a string to override.
 */
export function saveDocumentToFile(filename) {
  const json = buildDocumentJSON();
  const text = JSON.stringify(json, null, 2);
  const name = filename
    ? (String(filename).endsWith(FILE_EXT) ? String(filename) : `${String(filename)}${FILE_EXT}`)
    : defaultSaveFilename();
  return _triggerDownload(text, name, 'application/json');
}

/**
 * Save As — prompts the user for a filename via window.prompt. Returns the
 * filename written, or null if the user cancelled.
 */
export function saveDocumentAs() {
  const suggested = defaultSaveFilename();
  let name = suggested;
  if (typeof window !== 'undefined' && typeof window.prompt === 'function') {
    const next = window.prompt('Save as…', suggested);
    if (next == null) return null;
    name = next.trim() || suggested;
  }
  if (!name.endsWith(FILE_EXT)) name = `${name}${FILE_EXT}`;
  saveDocumentToFile(name);
  return name;
}

/**
 * Parse a JSON blob (from disk) into the live document. Throws on malformed
 * input or on a version we don't recognise. Exported for tests; the
 * end-user flow goes through {@link openDocumentFromFile}.
 */
export function loadDocumentFromJSON(json) {
  const store = _loadDocumentFromJSON(json);
  // Flag the doc as freshly loaded so the autosave subscription doesn't
  // immediately mark it 'pending' before the user touches anything.
  persistence.status = 'saved';
  persistence.lastSavedAt = Date.now();
  return store;
}

/**
 * Open a `.paraform.json` (or `.json`) file via the browser file picker,
 * parse it, and load it into the live store. Resolves with
 * `{ name, json }` on success; rejects on user cancel or parse error.
 */
export function openDocumentFromFile() {
  if (typeof document === 'undefined') {
    return Promise.reject(new Error('no DOM'));
  }
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.paraform.json,.json,application/json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) { reject(new Error('no file selected')); return; }
      try {
        const text = await file.text();
        const json = JSON.parse(text);
        loadDocumentFromJSON(json);
        const stem = file.name
          .replace(/\.paraform\.json$/i, '')
          .replace(/\.json$/i, '');
        resolve({ name: stem, json });
      } catch (e) {
        console.warn('[persistence] open failed:', e);
        reject(e);
      }
    };
    input.click();
  });
}

// ── Share / Bundle (E5.4) ──────────────────────────────────────────────────

/**
 * Snapshot the current viewport as a PNG data URL. Returns null if the
 * renderer isn't available (e.g. during tests).
 */
export function captureViewportScreenshot() {
  try {
    const canvas = studio?.viewport?.renderer?.domElement
                 || studio?.viewport?.canvas
                 || null;
    if (!canvas || typeof canvas.toDataURL !== 'function') return null;
    return canvas.toDataURL('image/png');
  } catch (e) {
    console.warn('[persistence] screenshot capture failed:', e);
    return null;
  }
}

/**
 * Share / Download bundle (v2). Bundles the `.paraform.json`, README.txt,
 * and (when available) a screenshot.png into a single `{stem}.bundle.zip`
 * download via `fflate`. Returns
 *   `{ zip: bool, screenshot: bool, filename: string }`
 * where `zip` indicates the download trigger fired and `screenshot` flags
 * whether a viewport snapshot was bundled in.
 */
export function shareDocumentBundle() {
  const json = buildDocumentJSON();
  const stem = defaultBundleStem(json);
  const filename = `${stem}.bundle.zip`;

  const dataURL = captureViewportScreenshot();
  const screenshotBytes = dataURLToPNGBytes(dataURL);

  const zipBytes = buildBundleZip(json, screenshotBytes);
  const zip = _triggerDownload(zipBytes, filename, 'application/zip');
  return { zip, screenshot: !!screenshotBytes, filename };
}

/**
 * True when the autosave layer believes there are unsaved (or failed-to-save)
 * changes. Used by the "New Document" confirm-dialog gate.
 */
export function hasUnsavedChanges() {
  return persistence.status === 'pending' || persistence.status === 'error';
}

export function clearSavedDocument() {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(STORAGE_KEY);
    persistence.status = 'idle';
    persistence.lastSavedAt = null;
    persistence.restored = false;
    persistence.restoredKernelVersion = null;
  } catch (e) { console.warn('[persistence] clear failed:', e); }
}
