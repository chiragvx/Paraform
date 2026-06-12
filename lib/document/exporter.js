/**
 * v4 document exporter — emit the current document, ask the kernel to
 * render it AND export to a chosen format (STEP / STL / BREP), then return
 * the raw bytes ready for a browser download.
 *
 * Two entry points:
 *
 *   exportDocumentAs(format, opts) → Promise<{ ok, bytes, filename, ... }>
 *       Pure data path — fetches the bytes from the kernel and returns
 *       them. Callers are responsible for triggering the download.
 *
 *   downloadDocumentAs(format, opts) → Promise<{ ok, filename, ... }>
 *       Convenience wrapper that creates a Blob + anchor click in the
 *       browser to drop the file in the user's downloads folder.
 *
 * Both rely on the kernel client's `executeCode(code, { formats })` shape
 * added alongside this module. The kernel runs `build123d.export_step`
 * (etc.) over the combined Compound and returns the base64-encoded blob.
 */

import { emitDocument } from './emit.js';
import { getDocumentStore } from './store.js';
import { HttpKernelClient } from './kernel_client.js';

/** Default singleton kernel client — shared with DocumentExecutor. */
let _client = null;
function defaultClient() {
    if (!_client) _client = new HttpKernelClient();
    return _client;
}

const MIME_TYPES = {
    step: 'application/step',
    stl:  'model/stl',
    brep: 'application/octet-stream',
};

const FILE_EXTENSIONS = {
    step: 'step',
    stl:  'stl',
    brep: 'brep',
};

/**
 * Emit the live (or provided) document and request the kernel to export
 * it in `format`. Returns the raw bytes as an ArrayBuffer.
 *
 * @param {'step'|'stl'|'brep'} format
 * @param {object} [opts]
 * @param {object} [opts.doc]      — defaults to the singleton document
 * @param {object} [opts.client]   — defaults to `new HttpKernelClient()`
 * @param {string} [opts.filename] — defaults to `paraform-<timestamp>.<ext>`
 * @returns {Promise<{ ok: boolean, bytes?: ArrayBuffer, filename: string, mime: string, error?: string }>}
 */
export async function exportDocumentAs(format, opts = {}) {
    const fmt = String(format || '').toLowerCase();
    if (!FILE_EXTENSIONS[fmt]) {
        return { ok: false, error: `Unsupported export format: ${format}`, filename: '', mime: '' };
    }
    const doc    = opts.doc    || getDocumentStore().doc;
    const client = opts.client || defaultClient();
    const filename = opts.filename || defaultFilename(fmt);
    const mime     = MIME_TYPES[fmt];

    let code;
    try {
        const out = emitDocument(doc);
        code = out.code;
    } catch (err) {
        return { ok: false, error: err.message || String(err), filename, mime };
    }

    let res;
    try {
        res = await client.executeCode(code, { formats: [fmt] });
    } catch (err) {
        return { ok: false, error: err.message || String(err), filename, mime };
    }

    if (!res || !res.ok) {
        return { ok: false, error: (res && res.error) || 'kernel rejected the request', filename, mime };
    }
    const bytes = res[fmt];
    if (!bytes || (bytes.byteLength === 0)) {
        const kernelErr = res[`${fmt}_error`];
        return {
            ok: false,
            error: kernelErr || `kernel returned no ${fmt.toUpperCase()} bytes`,
            filename, mime,
        };
    }
    return { ok: true, bytes, filename, mime };
}

/**
 * Convenience: do the export AND trigger a browser download. Returns the
 * filename / mime / ok flag (no `bytes` since they've already been consumed).
 *
 * Skips the download step gracefully in non-DOM environments (returns the
 * full payload so the caller can decide).
 */
export async function downloadDocumentAs(format, opts = {}) {
    const result = await exportDocumentAs(format, opts);
    if (!result.ok) return result;

    if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof Blob === 'undefined') {
        // Non-browser environment — return the bytes for the caller to handle.
        return result;
    }
    const blob = new Blob([result.bytes], { type: result.mime });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = result.filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Defer revoke so the browser has a chance to start the download.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return { ok: true, filename: result.filename, mime: result.mime };
}

function defaultFilename(fmt) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    return `paraform-${stamp}.${FILE_EXTENSIONS[fmt]}`;
}
