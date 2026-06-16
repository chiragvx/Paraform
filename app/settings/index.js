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

/**
 * Separate session-only blob for secret values (BYO API keys). Stored in
 * sessionStorage so they live only for the current tab and never sit at rest
 * in localStorage. The persistent SETTINGS_KEY blob never contains a key.
 */
export const SESSION_SECRETS_KEY = 'paraform_session_secrets';

/**
 * Setting paths that MUST live in sessionStorage, not localStorage. Any value
 * written to these paths is routed to the session blob; any persisted value
 * found at these paths in old localStorage is ignored on read. Update this
 * list when adding new browser-held secrets.
 */
const SESSION_ONLY_PATHS = Object.freeze([
    'ai.openaiApiKey',
    'ai.anthropicApiKey',
    'ai.geminiApiKey',
    'ai.visionCriticApiKey',
]);

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
    // server, never the client). OpenAI-compatible GPT-OSS is the default core
    // path (open-weight, widely available, native tool calling); Gemini +
    // Anthropic stay selectable; `'mock'` keeps the deterministic repair rules
    // offline. `openaiModel` / `geminiModel` / `anthropicModel` pin the model per
    // provider. The legacy `model` key is still honoured for back-compat (agent.js).
    // `*ApiKey` / `openaiBaseUrl` are optional bring-your-own credentials: stored
    // in THIS browser and sent to the user's own kernel proxy (X-Provider-Api-Key
    // header), which uses them in place of its server env keys. Blank = fall back
    // to the server-configured key.
    // `escalationModel` (opt-in, blank = off): a STRONGER model id the agent
    // switches to only for hard steps (self-repair after a compile failure, or
    // when it's stuck repeating a failing call). Leaves the cheap default model
    // driving the easy majority of steps. Must be a model the active provider can
    // serve (e.g. another OpenRouter id). See agent.js resolveModelConfig.
    ai:          { provider: 'openai', openaiModel: 'nvidia/nemotron-3-ultra-550b-a55b:free', escalationModel: '', geminiModel: 'gemini-2.5-flash', anthropicModel: 'claude-opus-4-8', maxTokens: 32768, openaiApiKey: '', openaiBaseUrl: '', geminiApiKey: '', anthropicApiKey: '' },
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

// ── Path utilities for routing session-only settings ─────────────────────────

function _hasPath(obj, path) {
    const parts = path.split('.');
    let cur = obj;
    for (const p of parts) {
        if (cur == null || typeof cur !== 'object' || !(p in cur)) return false;
        cur = cur[p];
    }
    return true;
}

function _getPath(obj, path) {
    const parts = path.split('.');
    let cur = obj;
    for (const p of parts) {
        if (cur == null || typeof cur !== 'object') return undefined;
        cur = cur[p];
    }
    return cur;
}

function _setPath(obj, path, value) {
    const parts = path.split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        const p = parts[i];
        if (cur[p] == null || typeof cur[p] !== 'object') cur[p] = {};
        cur = cur[p];
    }
    cur[parts[parts.length - 1]] = value;
}

function _deletePath(obj, path) {
    const parts = path.split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        const p = parts[i];
        if (cur == null || typeof cur !== 'object') return;
        cur = cur[p];
    }
    if (cur && typeof cur === 'object') delete cur[parts[parts.length - 1]];
}

/**
 * Split a settings patch into a persistent half (localStorage) and a
 * secret half (sessionStorage). The persistent half is the patch with the
 * SESSION_ONLY_PATHS removed; the secret half is just those paths.
 */
function _splitSecrets(patch) {
    if (!patch || typeof patch !== 'object') return { persistent: {}, secret: {}, hasSecret: false };
    const persistent = JSON.parse(JSON.stringify(patch));
    const secret = {};
    let hasSecret = false;
    for (const p of SESSION_ONLY_PATHS) {
        if (_hasPath(persistent, p)) {
            _setPath(secret, p, _getPath(persistent, p));
            _deletePath(persistent, p);
            hasSecret = true;
        }
    }
    return { persistent, secret, hasSecret };
}

function _defaultSession() {
    return (typeof sessionStorage !== 'undefined' ? sessionStorage : null);
}

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
 * Load settings from localStorage (persistent) AND sessionStorage (secrets),
 * merged with the defaults. Never throws — a corrupted blob falls back to
 * defaults cleanly. Inject `storage`/`session` for tests.
 *
 * The persistent blob NEVER carries a SESSION_ONLY_PATHS value; old values that
 * snuck in are ignored on read (they'll be erased on the next write of that
 * path). Session secrets overlay the persistent tree last, so they win.
 *
 * @param {Storage|object|null} [storage] — defaults to `globalThis.localStorage`
 * @param {Storage|object|null} [session] — defaults to `globalThis.sessionStorage`
 */
export function readSettings(
    storage = (typeof localStorage !== 'undefined' ? localStorage : null),
    session = _defaultSession(),
) {
    // Persistent half: localStorage merged onto defaults, with any straggling
    // session-only values scrubbed so they can't be seen here. We JSON-clone so
    // the tree is fully mutable (DEFAULT_SETTINGS is deepFreeze-d, and
    // deepMerge only shallow-copies the top level — untouched subtrees can
    // still point at the frozen original).
    let base;
    if (!storage) {
        base = cloneDefaults();
    } else {
        try {
            const raw = storage.getItem(SETTINGS_KEY);
            const stored = raw ? JSON.parse(raw) : {};
            base = deepMerge(DEFAULT_SETTINGS, stored);
        } catch {
            base = cloneDefaults();
        }
    }
    base = JSON.parse(JSON.stringify(base));
    for (const p of SESSION_ONLY_PATHS) _setPath(base, p, '');

    // Secret half: sessionStorage, overlaid last so it wins.
    if (!session) return base;
    try {
        const raw = session.getItem(SESSION_SECRETS_KEY);
        const secrets = raw ? JSON.parse(raw) : {};
        return deepMerge(base, secrets);
    } catch {
        return base;
    }
}

/**
 * Persist a partial settings patch. SESSION_ONLY_PATHS go to sessionStorage;
 * everything else goes to localStorage. Returns the merged settings tree.
 *
 * @param {object} patch
 * @param {Storage|object|null} [storage] — defaults to `globalThis.localStorage`
 * @param {Storage|object|null} [session] — defaults to `globalThis.sessionStorage`
 */
export function writeSettings(
    patch,
    storage = (typeof localStorage !== 'undefined' ? localStorage : null),
    session = _defaultSession(),
) {
    const { persistent, secret, hasSecret } = _splitSecrets(patch);

    // Build the persistent half (always — used both for storage write AND for
    // the returned merged tree, so behaviour matches the no-storage case).
    const baseNow = readSettings(storage, null);
    // JSON-clone before mutating: deepMerge shallow-copies, so subtrees not
    // touched by `persistent` may still reference the frozen defaults.
    const updatedBase = JSON.parse(JSON.stringify(deepMerge(baseNow, persistent)));
    // Belt-and-suspenders: scrub session-only paths before persisting.
    for (const p of SESSION_ONLY_PATHS) _setPath(updatedBase, p, '');
    if (storage) {
        try { storage.setItem(SETTINGS_KEY, JSON.stringify(updatedBase)); } catch { /* quota etc. */ }
    }

    // Build the secret half: existing session blob + secret patch.
    let secretsNow = {};
    if (session) {
        try {
            const raw = session.getItem(SESSION_SECRETS_KEY);
            secretsNow = raw ? JSON.parse(raw) : {};
        } catch { secretsNow = {}; }
    }
    if (hasSecret) {
        secretsNow = deepMerge(secretsNow, secret);
        if (session) {
            try { session.setItem(SESSION_SECRETS_KEY, JSON.stringify(secretsNow)); } catch { /* quota etc. */ }
        }
    }

    // Return the merged view (defaults + persistent patch + secret patch),
    // regardless of whether either storage was actually available.
    return deepMerge(updatedBase, secretsNow);
}

/** Erase persisted + session settings — useful for "reset to defaults" UI. */
export function clearSettings(
    storage = (typeof localStorage !== 'undefined' ? localStorage : null),
    session = _defaultSession(),
) {
    if (storage) storage.removeItem(SETTINGS_KEY);
    if (session) session.removeItem(SESSION_SECRETS_KEY);
}

function cloneDefaults() {
    return deepMerge({}, DEFAULT_SETTINGS);
}
