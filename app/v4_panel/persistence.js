/**
 * Persistence — save / load the v4 Document.
 *
 * Three flavours, layered:
 *   - Browser autosave   → localStorage, debounced on every store commit
 *   - Manual save/load   → explicit calls (same localStorage)
 *   - JSON file I/O      → download/upload via Blob + FileReader for sharing,
 *                          version control, or backup
 *
 * The document JSON is whatever `DocumentStore.toJSON()` produces — a
 * `{version, id, units, metadata, changelog, head}` payload. `fromJSON()`
 * accepts the same shape; pre-v4 shapes flow through `ensureV4` at the
 * caller boundary.
 */

const DOC_KEY = 'paraform_v4_document';

// ── localStorage I/O ────────────────────────────────────────────────────────

/**
 * Persist a JSON-serialisable v4 document to localStorage.
 * Pass a custom `storage` for tests.
 */
export function saveToStorage(json, storage = (typeof localStorage !== 'undefined' ? localStorage : null)) {
    if (!storage) return false;
    try {
        storage.setItem(DOC_KEY, JSON.stringify(json));
        return true;
    } catch (err) {
        console.warn('[v4 persistence] saveToStorage failed:', err.message);
        return false;
    }
}

/**
 * Load the persisted v4 document or null if none / corrupted.
 */
export function loadFromStorage(storage = (typeof localStorage !== 'undefined' ? localStorage : null)) {
    if (!storage) return null;
    try {
        const raw = storage.getItem(DOC_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return null;
        return parsed;
    } catch (err) {
        console.warn('[v4 persistence] loadFromStorage failed:', err.message);
        return null;
    }
}

/** Erase the persisted document. */
export function clearStorage(storage = (typeof localStorage !== 'undefined' ? localStorage : null)) {
    if (storage) storage.removeItem(DOC_KEY);
}

/** Debug helper — returns the size in bytes of the persisted blob (0 if none). */
export function storageSize(storage = (typeof localStorage !== 'undefined' ? localStorage : null)) {
    if (!storage) return 0;
    const raw = storage.getItem(DOC_KEY);
    return raw ? raw.length : 0;
}

// ── Debounced auto-save ────────────────────────────────────────────────────

/**
 * Subscribe the store to localStorage autosave. Returns an unsubscribe fn.
 *
 * Edits are coalesced via `setTimeout`; rapid commits (slider drag) result
 * in a single save after `delayMs` of quiescence.
 *
 * @param {DocumentStore} store
 * @param {object} [opts]
 * @param {number} [opts.delayMs] — debounce window
 * @param {Storage} [opts.storage]
 * @param {(ok:boolean) => void} [opts.onSave] — called after each save
 */
export function attachAutoSave(store, { delayMs = 750, storage = (typeof localStorage !== 'undefined' ? localStorage : null), onSave = null } = {}) {
    if (!store) throw new Error('attachAutoSave: missing store');
    let timer = null;
    const flush = () => {
        timer = null;
        const ok = saveToStorage(store.toJSON(), storage);
        if (onSave) onSave(ok);
    };
    const unsub = store.subscribe((_doc, event) => {
        if (event === 'select' || event === 'refs') return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(flush, delayMs);
    });
    return () => {
        if (timer) { clearTimeout(timer); timer = null; }
        unsub();
    };
}

// ── JSON file I/O ──────────────────────────────────────────────────────────

/**
 * Trigger a browser download of `json` as a `.paraform.json` file.
 * Caller owns the `document` reference; injectable for tests.
 *
 * @param {object} json
 * @param {string} [filename]
 * @param {Document} [doc]
 */
export function downloadAsFile(json, filename = 'document.paraform.json', doc = (typeof document !== 'undefined' ? document : null)) {
    if (!doc) throw new Error('downloadAsFile: no document available');
    const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = doc.createElement('a');
    a.href = url;
    a.download = filename;
    doc.body.appendChild(a);
    a.click();
    doc.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Read a `File` (from an `<input type=file>`) and parse it as JSON.
 * Returns a promise resolving to the parsed object.
 *
 * @param {File|Blob} file
 * @returns {Promise<object>}
 */
export function readFromFile(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            try {
                const text = String(reader.result || '');
                const parsed = JSON.parse(text);
                if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
                resolve(parsed);
            } catch (err) {
                reject(new Error(`readFromFile: ${err.message}`));
            }
        };
        reader.onerror = () => reject(new Error('readFromFile: FileReader failed'));
        reader.readAsText(file);
    });
}
