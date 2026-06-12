// Runtime environment detection. Lets the rest of the app branch on whether
// it's running inside the Tauri desktop shell vs a plain browser, without
// hard-coding `window.__TAURI_INTERNALS__` checks at every call site.

export function isDesktop() {
    return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export function platformLabel() {
    return isDesktop() ? 'desktop' : 'web';
}

// Default engine URL the executor should use. Desktop builds talk to the
// bundled Python sidecar on localhost; web builds default to empty (mock mode)
// and let the user paste a remote tunnel URL.
export function defaultEngineUrl() {
    return isDesktop() ? 'http://127.0.0.1:7823' : '';
}
