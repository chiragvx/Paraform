/**
 * Viewport snapshot bridge — lets non-viewport code (the AI tool layer) capture
 * what the model currently looks like, from named camera angles, as images.
 *
 * The renderer (boot.js) owns scene/camera/renderer, so IT registers a snapshot
 * provider here; the AI's capture_views tool calls captureSnapshots() to get
 * back data-URL images it can feed to the vision model. Decoupling through this
 * tiny singleton keeps the AI layer free of any three.js dependency and lets a
 * headless/test context degrade to "no snapshots" cleanly.
 *
 *   setSnapshotProvider(fn)   — fn(views:string[]) => Promise<[{view,dataUrl}]>
 *   clearSnapshotProvider(fn) — unregister (boot.js dispose)
 *   hasSnapshotProvider()     — is a viewport live?
 *   captureSnapshots(views)   — returns [{view, dataUrl}] (or [] if unavailable)
 */

let _provider = null;

/** Register the renderer's capture function. Last registration wins. */
export function setSnapshotProvider(fn) {
    _provider = (typeof fn === 'function') ? fn : null;
}

/** Unregister (no-op if a different provider is now active). */
export function clearSnapshotProvider(fn) {
    if (!fn || _provider === fn) _provider = null;
}

/** Is a live viewport available to snapshot? */
export function hasSnapshotProvider() {
    return typeof _provider === 'function';
}

/**
 * Capture the current model from the given named views. Returns an array of
 * { view, dataUrl }; empty if no viewport is registered or capture failed.
 * Never throws.
 *
 * @param {string[]} [views]
 * @returns {Promise<Array<{view:string, dataUrl:string}>>}
 */
export async function captureSnapshots(views) {
    if (typeof _provider !== 'function') return [];
    try {
        const r = await _provider(Array.isArray(views) && views.length ? views : undefined);
        return Array.isArray(r) ? r.filter((s) => s && typeof s.dataUrl === 'string' && s.dataUrl) : [];
    } catch {
        return [];
    }
}
