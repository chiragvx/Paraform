// Platform-aware file I/O. Native dialogs + filesystem in the Tauri desktop
// build; <input type="file"> + FileReader in the browser. Call sites should
// import from here so the same code path works in both environments.
//
// Loaded only inside Tauri builds — the dynamic imports avoid bundling
// `@tauri-apps/plugin-dialog` and `@tauri-apps/plugin-fs` into the browser
// build (where they would be dead weight and require the host APIs that
// only exist in the desktop runtime).

import { isDesktop } from './runtime.js';

/**
 * Prompt the user to pick a file to open. Returns the file's contents.
 * @param {object} opts
 * @param {Array<{name:string,extensions:string[]}>} [opts.filters]
 * @param {'binary'|'text'} [opts.encoding='binary']
 * @returns {Promise<{path:string|null, name:string, data:Uint8Array|string}|null>}
 *   null when the user cancels.
 */
export async function openFile(opts = {}) {
    const { filters = [], encoding = 'binary' } = opts;
    if (isDesktop()) {
        const [{ open }, { readFile, readTextFile }] = await Promise.all([
            import('@tauri-apps/plugin-dialog'),
            import('@tauri-apps/plugin-fs'),
        ]);
        const picked = await open({ multiple: false, filters });
        if (!picked) return null;
        const path = typeof picked === 'string' ? picked : picked.path;
        const data = encoding === 'text' ? await readTextFile(path) : await readFile(path);
        const name = path.split(/[\\/]/).pop() || '';
        return { path, name, data };
    }
    return openFileBrowser(filters, encoding);
}

/**
 * Prompt the user for a save path and write the given bytes / text.
 * @param {object} opts
 * @param {Uint8Array|string} opts.data
 * @param {string} [opts.defaultPath]
 * @param {Array<{name:string,extensions:string[]}>} [opts.filters]
 * @returns {Promise<string|null>} chosen path, or null if cancelled.
 */
export async function saveFile(opts) {
    const { data, defaultPath, filters = [] } = opts;
    if (isDesktop()) {
        const [{ save }, { writeFile, writeTextFile }] = await Promise.all([
            import('@tauri-apps/plugin-dialog'),
            import('@tauri-apps/plugin-fs'),
        ]);
        const path = await save({ defaultPath, filters });
        if (!path) return null;
        if (typeof data === 'string') await writeTextFile(path, data);
        else await writeFile(path, data);
        return path;
    }
    return saveFileBrowser(data, defaultPath);
}

// ── Browser fallbacks (kept identical to existing main.js behaviour) ──────

function openFileBrowser(filters, encoding) {
    return new Promise(resolve => {
        const accept = filters
            .flatMap(f => f.extensions.map(e => `.${e}`))
            .join(',');
        const input = document.createElement('input');
        input.type = 'file';
        if (accept) input.accept = accept;
        input.onchange = () => {
            const file = input.files?.[0];
            if (!file) return resolve(null);
            const reader = new FileReader();
            reader.onload = () => {
                const raw = reader.result;
                const data = encoding === 'text'
                    ? String(raw)
                    : new Uint8Array(raw);
                resolve({ path: null, name: file.name, data });
            };
            reader.onerror = () => resolve(null);
            if (encoding === 'text') reader.readAsText(file);
            else reader.readAsArrayBuffer(file);
        };
        input.click();
    });
}

function saveFileBrowser(data, defaultPath) {
    const blob = data instanceof Uint8Array
        ? new Blob([data], { type: 'application/octet-stream' })
        : new Blob([data], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = defaultPath ? defaultPath.split(/[\\/]/).pop() : 'export.bin';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    return Promise.resolve(a.download);
}
