/**
 * Tests for the app/settings module.
 * Run via:  node app/__tests__/settings.mjs
 */

import assert from 'node:assert/strict';
import {
    SETTINGS_KEY, DEFAULT_KEYBINDINGS, DEFAULT_SETTINGS, BG_COLORS,
    TESSELLATION_DEFLECTION_MM,
    deepMerge, readSettings, writeSettings, clearSettings,
} from '../settings/index.js';

// ── In-memory Storage shim ───────────────────────────────────────────────────
function memStorage(initial = {}) {
    const data = { ...initial };
    return {
        data,
        getItem:    (k)    => (k in data ? data[k] : null),
        setItem:    (k, v) => { data[k] = String(v); },
        removeItem: (k)    => { delete data[k]; },
    };
}

const _tests = [];
let _suite = '';
function suite(name, fn) { _suite = name; fn(); _suite = ''; }
function test(name, fn)  { _tests.push({ suite: _suite, name, fn }); }
async function runAll() {
    let pass = 0, fail = 0;
    for (const t of _tests) {
        try { await t.fn(); pass++; console.log(`  \x1b[32m✓\x1b[0m ${t.suite ? t.suite + ' › ' : ''}${t.name}`); }
        catch (e) { fail++; console.log(`  \x1b[31m✗\x1b[0m ${t.suite ? t.suite + ' › ' : ''}${t.name}`); console.log(`    ${e.message}`); }
    }
    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail > 0) process.exit(1);
}

// ── Constants ────────────────────────────────────────────────────────────────
suite('constants', () => {
    test('SETTINGS_KEY is a stable string', () => {
        assert.equal(SETTINGS_KEY, 'paraform_app_settings');
    });

    test('DEFAULT_KEYBINDINGS includes every documented binding', () => {
        for (const k of ['undo', 'redo', 'compile', 'resetCamera', 'normalToFace',
            'toolSelect', 'toolMove', 'toolRotate', 'toolScale',
            'openSettings', 'toggleWireframe', 'exportModel']) {
            assert.ok(DEFAULT_KEYBINDINGS[k], `missing ${k}`);
            assert.ok(DEFAULT_KEYBINDINGS[k].key);
            assert.ok(DEFAULT_KEYBINDINGS[k].label);
        }
    });

    test('DEFAULT_SETTINGS carries every section', () => {
        for (const section of ['preferences','viewport','camera','performance','graphics','measurement','export','diagnostics','keybindings']) {
            assert.ok(DEFAULT_SETTINGS[section], `missing ${section}`);
        }
    });

    test('BG_COLORS exposes the four background presets', () => {
        for (const name of ['default','black','gray','blue']) {
            assert.equal(typeof BG_COLORS[name], 'number');
        }
    });

    test('TESSELLATION_DEFLECTION_MM presets are monotonic + positive', () => {
        const order = ['draft','medium','high','ultra'];
        let prev = Infinity;
        for (const k of order) {
            const v = TESSELLATION_DEFLECTION_MM[k];
            assert.ok(Number.isFinite(v) && v > 0, `${k} missing or non-positive`);
            assert.ok(v < prev, `${k} should be finer (smaller mm) than the previous preset`);
            prev = v;
        }
    });

    test('graphics.tessellationQuality default is "medium"', () => {
        assert.equal(DEFAULT_SETTINGS.graphics.tessellationQuality, 'medium');
    });

    test('DEFAULT_SETTINGS / DEFAULT_KEYBINDINGS are frozen', () => {
        assert.throws(() => { DEFAULT_SETTINGS.viewport.fov = 999; });
        assert.throws(() => { DEFAULT_KEYBINDINGS.undo.key = '!'; });
    });
});

// ── deepMerge ────────────────────────────────────────────────────────────────
suite('deepMerge', () => {
    test('returns a fresh object', () => {
        const a = { x: 1 };
        const out = deepMerge(a, { y: 2 });
        assert.notEqual(out, a);
        assert.deepEqual(out, { x: 1, y: 2 });
    });

    test('recurses into nested objects', () => {
        const out = deepMerge({ a: { x: 1, y: 2 } }, { a: { y: 9, z: 7 } });
        assert.deepEqual(out, { a: { x: 1, y: 9, z: 7 } });
    });

    test('treats arrays as values (replaces, not merges)', () => {
        const out = deepMerge({ list: [1, 2, 3] }, { list: [9] });
        assert.deepEqual(out.list, [9]);
    });

    test('handles null source gracefully', () => {
        assert.deepEqual(deepMerge({ x: 1 }, null), { x: 1 });
    });

    test('null values in source override', () => {
        const out = deepMerge({ x: { nested: 1 } }, { x: null });
        assert.equal(out.x, null);
    });
});

// ── readSettings / writeSettings ─────────────────────────────────────────────
suite('persistence', () => {
    test('readSettings returns defaults from an empty storage', () => {
        const s = readSettings(memStorage());
        assert.deepEqual(s.viewport, DEFAULT_SETTINGS.viewport);
    });

    test('readSettings deep-merges stored partial overrides on top of defaults', () => {
        const store = memStorage({ [SETTINGS_KEY]: JSON.stringify({ viewport: { fov: 60 } }) });
        const s = readSettings(store);
        assert.equal(s.viewport.fov, 60);
        assert.equal(s.viewport.showGrid, DEFAULT_SETTINGS.viewport.showGrid);
    });

    test('readSettings tolerates a corrupted blob and falls back to defaults', () => {
        const store = memStorage({ [SETTINGS_KEY]: '{ not valid json' });
        const s = readSettings(store);
        assert.equal(s.viewport.fov, DEFAULT_SETTINGS.viewport.fov);
    });

    test('writeSettings merges and persists, returning the new tree', () => {
        const store = memStorage();
        const updated = writeSettings({ camera: { orbitSpeed: 2.5 } }, store);
        assert.equal(updated.camera.orbitSpeed, 2.5);
        // The unchanged sibling lives on
        assert.equal(updated.camera.zoomSpeed, DEFAULT_SETTINGS.camera.zoomSpeed);
        // localStorage now holds the merged blob
        const stored = JSON.parse(store.getItem(SETTINGS_KEY));
        assert.equal(stored.camera.orbitSpeed, 2.5);
    });

    test('writeSettings calls compound — second write merges with the first', () => {
        const store = memStorage();
        writeSettings({ camera: { orbitSpeed: 2.5 } }, store);
        const final = writeSettings({ viewport: { fov: 50 } }, store);
        assert.equal(final.camera.orbitSpeed, 2.5);
        assert.equal(final.viewport.fov, 50);
    });

    test('clearSettings removes the persisted blob', () => {
        const store = memStorage();
        writeSettings({ viewport: { fov: 90 } }, store);
        clearSettings(store);
        assert.equal(store.getItem(SETTINGS_KEY), null);
    });

    test('functions are no-ops when no storage is available (Node-side import)', () => {
        const s = readSettings(null);
        assert.deepEqual(s.viewport, DEFAULT_SETTINGS.viewport);
        const updated = writeSettings({ viewport: { fov: 33 } }, null);
        assert.equal(updated.viewport.fov, 33);   // returns merged value even without persistence
    });
});

runAll();
