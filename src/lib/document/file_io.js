/**
 * Pure file-IO helpers split out from persistence.svelte.js so they can be
 * exercised under a vanilla node:assert harness without dragging in Svelte
 * runes. The runes-aware module re-exports the same names so callers can
 * keep importing from `$lib/document/persistence.svelte.js`.
 */
import { getDocumentStore } from '../../../lib/document/index.js';
import { zipSync, strToU8 } from 'fflate';

export const PARAFORM_FILE_EXT = '.paraform.json';

/**
 * Build the JSON blob that `Save` and `Save As` write. The kernel-version
 * stamp is optional — callers that want to capture it should call
 * `store.setLastKernelVersion(...)` before invoking this helper.
 */
export function buildDocumentJSON() {
  return getDocumentStore().toJSON();
}

/**
 * Default file-save name for the current document. Strips path separators and
 * appends `.paraform.json` if missing.
 */
export function defaultSaveFilename(name) {
  const store = getDocumentStore();
  const raw = (name && String(name).trim()) ||
              (store.doc.metadata?.name) ||
              (store.doc.metadata?.title) ||
              'document';
  const safe = raw.replace(/[\\/:*?"<>|]+/g, '_');
  return safe.endsWith(PARAFORM_FILE_EXT) ? safe : `${safe}${PARAFORM_FILE_EXT}`;
}

/**
 * Parse a JSON blob (from disk) into the live document. Throws on malformed
 * input or on a version we don't recognise.
 */
export function loadDocumentFromJSON(json) {
  if (!json || typeof json !== 'object') {
    throw new Error('not a document (expected an object)');
  }
  if (json.version !== 4 && json.version !== 5) {
    throw new Error(`unrecognised document version: ${json.version}`);
  }
  const store = getDocumentStore();
  store.fromJSON(json);
  return store;
}

/**
 * Build the README.txt text shipped with a share-bundle download.
 */
export function buildBundleReadme(json) {
  const meta = (json && json.metadata) || {};
  const name = meta.name || meta.title || 'Untitled';
  const features = (json && json.changelog) ? json.changelog.length : 0;
  const head = (json && typeof json.head === 'number') ? json.head : -1;
  const created = meta.createdAt
    ? new Date(meta.createdAt).toISOString()
    : new Date().toISOString();
  const exported = new Date().toISOString();
  return [
    'ParaForm document bundle',
    '========================',
    '',
    `Name:        ${name}`,
    `Version:     v${json?.version ?? '?'}`,
    `Changelog:   ${features} change${features === 1 ? '' : 's'} (head=${head})`,
    `Created:     ${created}`,
    `Exported:    ${exported}`,
    '',
    'Files in this bundle (zip):',
    `  - document${PARAFORM_FILE_EXT}  (the parametric document — open via File → Open)`,
    '  - screenshot.png        (viewport snapshot at export time; optional, may be omitted)',
    '  - README.txt            (this file)',
    '',
    'Unzip and open the .paraform.json from inside ParaForm via File → Open.',
    '',
  ].join('\n');
}

/**
 * Build a single zip bundle (Uint8Array) containing the document JSON, the
 * README.txt, and an optional screenshot PNG. Pure: no DOM, no downloads —
 * the runes-aware wrapper handles the browser download. `screenshotBytes`
 * may be a Uint8Array, an ArrayBuffer, or null/undefined.
 */
export function buildBundleZip(json, screenshotBytes) {
  const entries = {};
  entries[`document${PARAFORM_FILE_EXT}`] = strToU8(JSON.stringify(json, null, 2));
  entries['README.txt'] = strToU8(buildBundleReadme(json));
  if (screenshotBytes) {
    let u8 = null;
    if (screenshotBytes instanceof Uint8Array) u8 = screenshotBytes;
    else if (screenshotBytes instanceof ArrayBuffer) u8 = new Uint8Array(screenshotBytes);
    else if (ArrayBuffer.isView(screenshotBytes)) {
      u8 = new Uint8Array(screenshotBytes.buffer, screenshotBytes.byteOffset, screenshotBytes.byteLength);
    }
    if (u8) entries['screenshot.png'] = u8;
  }
  return zipSync(entries);
}

/**
 * Default bundle filename stem for a given document JSON, sanitised but
 * without any extension. Used to derive `${stem}.bundle.zip`.
 */
export function defaultBundleStem(json) {
  const meta = (json && json.metadata) || {};
  const raw = meta.name || meta.title || 'document';
  return String(raw).replace(/[\\/:*?"<>|]+/g, '_') || 'document';
}

/**
 * Convert a `data:image/png;base64,…` URL to a Blob. Returns null when
 * decoding fails or we're outside the DOM.
 */
export function dataURLToPNGBlob(dataURL) {
  if (typeof dataURL !== 'string' || !dataURL.startsWith('data:image/')) return null;
  if (typeof Blob === 'undefined') return null;
  try {
    const bytes = dataURLToPNGBytes(dataURL);
    if (!bytes) return null;
    return new Blob([bytes], { type: 'image/png' });
  } catch {
    return null;
  }
}

/**
 * Decode a `data:image/png;base64,…` URL to a raw Uint8Array. Returns null
 * when decoding fails. Pure (no Blob dependency) so it works under Node.
 */
export function dataURLToPNGBytes(dataURL) {
  if (typeof dataURL !== 'string' || !dataURL.startsWith('data:image/')) return null;
  try {
    const comma = dataURL.indexOf(',');
    const b64 = dataURL.slice(comma + 1);
    let bin = '';
    if (typeof atob === 'function') {
      bin = atob(b64);
    } else if (typeof Buffer !== 'undefined') {
      const buf = Buffer.from(b64, 'base64');
      const bytes = new Uint8Array(buf.length);
      for (let i = 0; i < buf.length; i++) bytes[i] = buf[i];
      return bytes;
    } else {
      return null;
    }
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}
