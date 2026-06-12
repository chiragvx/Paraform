/**
 * Settings store — pure, testable, framework-free.
 *
 * The Phase 1E starter for main.js decomposition: lift the settings constants
 * and persistence helpers out of main.js into a dedicated module so they
 * can be unit-tested and progressively typed.
 *
 * What lives here:
 *   - DEFAULT_KEYBINDINGS, DEFAULT_SETTINGS, BG_COLORS  — constants
 *   - readSettings / writeSettings                     — localStorage I/O
 *   - deepMerge                                        — utility used by both
 *
 * What stays in main.js:
 *   - `applySettings(s)` — touches the live viewport and DOM, can't be
 *     decoupled from the running app yet. main.js wraps `writeSettings`
 *     with `applySettings` to mirror the old `saveSettings` semantics.
 *
 * The legacy `getSettings` / `saveSettings` global functions in main.js are
 * preserved as thin shims over `readSettings` / `writeSettings` during the
 * transition window so nothing else has to change.
 */

export const SETTINGS_KEY = 'paraform_app_settings';

/** Recursively freeze a value so the constants below are immutable end-to-end. */
function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        for (const k of Object.keys(value)) deepFreeze(value[k]);
        Object.freeze(value);
    }
    return value;
}

/**
 * Default keybindings map. Edited via the Settings → Keybindings panel and
 * dispatched at runtime by `buildKeyDispatch` (still in main.js).
 */
export const DEFAULT_KEYBINDINGS = deepFreeze({
    undo:            { key: 'z', ctrl: true,  shift: false, alt: false, label: 'Undo' },
    redo:            { key: 'y', ctrl: true,  shift: false, alt: false, label: 'Redo' },
    compile:         { key: 's', ctrl: true,  shift: false, alt: false, label: 'Compile & Run' },
    resetCamera:     { key: 'f', ctrl: false, shift: false, alt: false, label: 'Fit View' },
    normalToFace:    { key: 'n', ctrl: false, shift: false, alt: false, label: 'View Normal-to Face' },
    toolSelect:      { key: 'v', ctrl: false, shift: false, alt: false, label: 'Tool: Select' },
    toolMove:        { key: 'g', ctrl: false, shift: false, alt: false, label: 'Tool: Move' },
    toolRotate:      { key: 'r', ctrl: false, shift: false, alt: false, label: 'Tool: Rotate' },
    toolScale:       { key: 's', ctrl: false, shift: false, alt: false, label: 'Tool: Scale' },
    openSettings:    { key: ',', ctrl: true,  shift: false, alt: false, label: 'Open Settings' },
    toggleWireframe: { key: 'w', ctrl: false, shift: false, alt: false, label: 'Toggle Wireframe' },
    exportModel:     { key: 'e', ctrl: true,  shift: false, alt: false, label: 'Export Model' },
});

/**
 * Default settings tree. The structure is the contract — anything the UI
 * panels read or write must appear here with its default value.
 */
export const DEFAULT_SETTINGS = deepFreeze({
    preferences: { unitSystem: 'mm', autoSave: 'off', startup: 'library' },
    viewport:    { defaultDisplayMode: 'shaded', background: 'default', showGrid: true, gridSize: 10, showAxes: true, fov: 75 },
    camera:      { orbitSpeed: 1.0, zoomSpeed: 1.0, panSpeed: 1.0, dampingFactor: 0.05, invertY: false, autoFitOnCompile: true, navPreset: 'solidworks', reverseZoom: false },
    performance: { compileQuality: 'preview', autoRecompileDelay: 500, workerThreads: 'auto' },
    graphics:    { antialias: true, edgeThickness: 1, pixelRatio: 'device', tessellationQuality: 'medium' },
    measurement: { unit: 'mm', decimalPlaces: 2 },
    export:      { defaultFormat: 'stl', stlType: 'binary', exportQuality: 'high', filenamePattern: '{model}' },
    diagnostics: { showFPS: false, showPolygonCount: true, showCompileTime: true },
    // Phase 2 — switchable AI provider. `provider` selects the backend the chat
    // + repair loop route through via the Flask /ai/chat proxy (keys live on the
    // server, never the client). Gemini is the default working path; Anthropic
    // is selectable; `'mock'` keeps the deterministic repair rules offline.
    // `geminiModel` / `anthropicModel` pin the model per provider. The legacy
    // `model` key is still honoured for back-compat (see agent.js).
    ai:          { provider: 'gemini', geminiModel: 'gemini-2.5-flash', anthropicModel: 'claude-opus-4-8', maxTokens: 4096 },
    keybindings: { ...DEFAULT_KEYBINDINGS },
});

/**
 * Tessellation quality presets — mapped to OCCT chord-deviation tolerance
 * (mm) and sent to the kernel as `deflection`. Lower = smoother curves +
 * more triangles + slower compile. Tuned for typical mm-scale CAD parts:
 *
 *   draft:   coarse facets, sub-second compile
 *   medium:  noticeable smoothing, default
 *   high:    near-CAD-grade curves
 *   ultra:   reference quality, large meshes
 */
export const TESSELLATION_DEFLECTION_MM = deepFreeze({
    draft:  0.20,
    medium: 0.05,
    high:   0.015,
    ultra:  0.005,
});

/** Background colour palette used by the viewport. Indexed by settings.viewport.background. */
export const BG_COLORS = deepFreeze({
    default: 0x1a1c1e,
    black:   0x000000,
    gray:    0x1a1a1a,
    blue:    0x080d14,
});

/**
 * Recursive deep merge — leaves arrays and primitives as-is, recurses into
 * plain objects so partial settings patches merge correctly.
 *
 * @param {object} target
 * @param {object} source
 */
export function deepMerge(target, source) {
    const result = { ...target };
    for (const k of Object.keys(source || {})) {
        const v = source[k];
        if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
            result[k] = deepMerge(target[k] || {}, v);
        } else {
            result[k] = v;
        }
    }
    return result;
}

/**
 * Load settings from localStorage, merged with the defaults. Never throws —
 * a corrupted blob falls back to defaults cleanly. Inject `storage` for tests.
 *
 * @param {Storage|object} [storage] — defaults to `globalThis.localStorage`
 */
export function readSettings(storage = (typeof localStorage !== 'undefined' ? localStorage : null)) {
    if (!storage) return cloneDefaults();
    try {
        const raw = storage.getItem(SETTINGS_KEY);
        const stored = raw ? JSON.parse(raw) : {};
        return deepMerge(DEFAULT_SETTINGS, stored);
    } catch {
        return cloneDefaults();
    }
}

/**
 * Persist a partial settings patch — merges with the current stored value
 * and writes the result back. Returns the new settings tree.
 *
 * @param {object} patch
 * @param {Storage|object} [storage] — defaults to `globalThis.localStorage`
 */
export function writeSettings(patch, storage = (typeof localStorage !== 'undefined' ? localStorage : null)) {
    const updated = deepMerge(readSettings(storage), patch);
    if (storage) storage.setItem(SETTINGS_KEY, JSON.stringify(updated));
    return updated;
}

/** Erase any persisted settings — useful for "reset to defaults" UI. */
export function clearSettings(storage = (typeof localStorage !== 'undefined' ? localStorage : null)) {
    if (storage) storage.removeItem(SETTINGS_KEY);
}

function cloneDefaults() {
    return deepMerge({}, DEFAULT_SETTINGS);
}
