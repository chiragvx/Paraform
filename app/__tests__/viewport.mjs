/**
 * Tests for the viewport navigation layer:
 *   - lib/viewport/presets.js          — preset mapping table
 *   - lib/viewport/view_animator.js    — named views + frame helpers (pure math)
 *   - lib/viewport/camera_controls.js  — pure API surface (skips DOM events)
 *   - app/viewport/rubber_band.js      — window/crossing membership rule
 *
 * Run via:  node app/__tests__/viewport.mjs
 */

import assert from 'node:assert/strict';
import * as THREE from 'three';

import {
    NAV_PRESETS, DEFAULT_PRESET, resolveAction, listPresets,
} from '../../lib/viewport/presets.js';
import {
    NAMED_VIEWS, STANDARD_DURATION_MS, aabbOf,
} from '../../lib/viewport/view_animator.js';
import { CADCameraControls } from '../../lib/viewport/camera_controls.js';
import { decideMembership } from '../viewport/rubber_band.js';

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
    console.log(`\n  ${pass} passed, ${fail} failed`);
    if (fail > 0) process.exit(1);
}

// ── Minimal DOM stub so CADCameraControls can construct ─────────────────────
// We don't fire events through it — we only need it to satisfy the constructor
// and let us call the public API (target, dollyTo, etc.).
function stubElement() {
    const handlers = new Map();
    return {
        getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 }; },
        addEventListener(type, fn) { handlers.set(type, fn); },
        removeEventListener(type) { handlers.delete(type); },
        setPointerCapture()    {},
        releasePointerCapture(){},
        ownerDocument: { defaultView: { addEventListener() {}, removeEventListener() {} } },
    };
}

// Stub global `window` if missing (Node ≥18 has it as undefined in default module).
if (typeof globalThis.window === 'undefined') {
    globalThis.window = { addEventListener() {}, removeEventListener() {} };
}

// ── Presets ──────────────────────────────────────────────────────────────────
suite('presets', () => {
    test('exposes the four canonical presets', () => {
        assert.deepEqual(listPresets().sort(), ['blender', 'fusion', 'onshape', 'solidworks']);
        assert.equal(DEFAULT_PRESET, 'solidworks');
    });

    test('SolidWorks: MMB-plain → orbit; Ctrl+MMB → pan; Shift+MMB → zoom', () => {
        assert.equal(resolveAction('solidworks', { button: 1, ctrlKey: false, shiftKey: false, altKey: false }), 'orbit');
        assert.equal(resolveAction('solidworks', { button: 1, ctrlKey: true,  shiftKey: false, altKey: false }), 'pan');
        assert.equal(resolveAction('solidworks', { button: 1, ctrlKey: false, shiftKey: true,  altKey: false }), 'zoom');
    });

    test('Fusion: MMB-plain → pan; Shift+MMB → orbit; Ctrl+MMB → zoom', () => {
        assert.equal(resolveAction('fusion', { button: 1, ctrlKey: false, shiftKey: false, altKey: false }), 'pan');
        assert.equal(resolveAction('fusion', { button: 1, ctrlKey: false, shiftKey: true,  altKey: false }), 'orbit');
        assert.equal(resolveAction('fusion', { button: 1, ctrlKey: true,  shiftKey: false, altKey: false }), 'zoom');
    });

    test('Onshape: RMB-plain → orbit; Ctrl+RMB → pan; MMB-plain → pan', () => {
        assert.equal(resolveAction('onshape', { button: 2, ctrlKey: false, shiftKey: false, altKey: false }), 'orbit');
        assert.equal(resolveAction('onshape', { button: 2, ctrlKey: true,  shiftKey: false, altKey: false }), 'pan');
        assert.equal(resolveAction('onshape', { button: 1, ctrlKey: false, shiftKey: false, altKey: false }), 'pan');
    });

    test('Unknown button returns null (LMB on SW with no mapping)', () => {
        assert.equal(resolveAction('solidworks', { button: 0, ctrlKey: false, shiftKey: false, altKey: false }), null);
    });

    test('Alt-held with no matching row falls back to plain action', () => {
        // SW has no Alt+MMB row, so Alt+MMB still orbits (plain MMB row).
        assert.equal(resolveAction('solidworks', { button: 1, altKey: true,  ctrlKey: false, shiftKey: false }), 'orbit');
    });
});

// ── View animator ────────────────────────────────────────────────────────────
suite('view_animator', () => {
    test('NAMED_VIEWS covers the seven cardinals + iso', () => {
        const names = Object.keys(NAMED_VIEWS).sort();
        assert.ok(names.includes('front'));
        assert.ok(names.includes('back'));
        assert.ok(names.includes('left'));
        assert.ok(names.includes('right'));
        assert.ok(names.includes('top'));
        assert.ok(names.includes('bottom'));
        assert.ok(names.includes('iso'));
    });

    test('TOP looks down +Z (Z-up convention)', () => {
        // dir vector points from target outward toward camera.
        assert.deepEqual(NAMED_VIEWS.top.dir, [0, 0, 1]);
    });

    test('FRONT looks down +Y with Z-up', () => {
        assert.deepEqual(NAMED_VIEWS.front.dir, [0, 1, 0]);
        assert.deepEqual(NAMED_VIEWS.front.up,  [0, 0, 1]);
    });

    test('ISO points at (+x, −y, +z) bisector (Fusion-style)', () => {
        const d = NAMED_VIEWS.iso.dir;
        assert.equal(Math.sign(d[0]),  1);
        assert.equal(Math.sign(d[1]), -1);
        assert.equal(Math.sign(d[2]),  1);
    });

    test('STANDARD_DURATION_MS within Material 200–400 ms band', () => {
        assert.ok(STANDARD_DURATION_MS >= 200 && STANDARD_DURATION_MS <= 400);
    });

    test('aabbOf produces a non-empty box for a single mesh', () => {
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(10, 20, 30));
        mesh.position.set(5, 0, 0);
        const box = aabbOf([mesh]);
        assert.ok(!box.isEmpty());
        const size = box.getSize(new THREE.Vector3());
        assert.ok(size.x >= 10 - 1e-6);
        assert.ok(size.y >= 20 - 1e-6);
        assert.ok(size.z >= 30 - 1e-6);
    });

    test('aabbOf returns empty box for empty input', () => {
        assert.ok(aabbOf([]).isEmpty());
        assert.ok(aabbOf([null, undefined]).isEmpty());
    });
});

// ── CADCameraControls public API ────────────────────────────────────────────
suite('CADCameraControls', () => {
    function makeControls(opts = {}) {
        const camera = new THREE.PerspectiveCamera(75, 800/600, 0.1, 1000);
        camera.position.set(0, 0, 100);
        const dom = stubElement();
        const controls = new CADCameraControls(camera, dom, opts);
        return { camera, dom, controls };
    }

    test('constructs with SW defaults and exposes the OrbitControls API surface', () => {
        const { controls } = makeControls();
        assert.ok(controls.target instanceof THREE.Vector3);
        assert.equal(controls.enabled, true);
        assert.equal(controls.enableRotate, true);
        assert.equal(controls.enablePan,    true);
        assert.equal(controls.enableZoom,   true);
        assert.equal(typeof controls.enableDamping, 'boolean');
        assert.equal(typeof controls.update,  'function');
        assert.equal(typeof controls.reset,   'function');
        assert.equal(typeof controls.dispose, 'function');
        assert.equal(controls.getPreset(), 'solidworks');
    });

    test('setPreset switches the active table', () => {
        const { controls } = makeControls();
        controls.setPreset('fusion');
        assert.equal(controls.getPreset(), 'fusion');
    });

    test('dollyTo updates camera distance while preserving direction', () => {
        const { camera, controls } = makeControls();
        controls.target.set(0, 0, 0);
        camera.position.set(0, 0, 100);
        controls.dollyTo(50);
        assert.ok(Math.abs(camera.position.distanceTo(controls.target) - 50) < 1e-3);
        // Direction preserved: still on +Z axis.
        assert.ok(Math.abs(camera.position.x) < 1e-3);
        assert.ok(Math.abs(camera.position.y) < 1e-3);
    });

    test('dollyTo clamps to minDistance', () => {
        const { camera, controls } = makeControls();
        controls.minDistance = 2;
        controls.target.set(0, 0, 0);
        camera.position.set(0, 0, 100);
        controls.dollyTo(0.01);
        assert.ok(camera.position.distanceTo(controls.target) >= 2 - 1e-6);
    });

    test('reset restores construction-time target + position', () => {
        const { camera, controls } = makeControls();
        const origPos = camera.position.clone();
        const origTgt = controls.target.clone();
        // Disturb the camera then reset.
        camera.position.set(40, 50, 60);
        controls.target.set(10, 10, 10);
        controls.reset();
        assert.ok(camera.position.distanceTo(origPos) < 1e-3);
        assert.ok(controls.target.distanceTo(origTgt) < 1e-3);
    });

    test('saveState recaptures the current view as the new reset target', () => {
        const { camera, controls } = makeControls();
        camera.position.set(200, 0, 0);
        controls.target.set(50, 0, 0);
        controls.saveState();
        camera.position.set(0, 0, 0);
        controls.target.set(0, 0, 0);
        controls.reset();
        assert.ok(camera.position.distanceTo(new THREE.Vector3(200, 0, 0)) < 1e-3);
        assert.ok(controls.target.distanceTo(new THREE.Vector3(50, 0, 0)) < 1e-3);
    });

    test('respects per-action disable flags (sketcher pins enableRotate=false)', () => {
        const { controls } = makeControls();
        controls.enableRotate = false;
        // Internal: a plain MMB-down would be an orbit on SW preset, but the
        // gate inside _handlePointerDown short-circuits and leaves _dragAction
        // null. We exercise the gate by directly calling the handler with a
        // synthetic event.
        const fakeEv = { button: 1, ctrlKey: false, shiftKey: false, altKey: false,
                         clientX: 100, clientY: 100, pointerId: 1,
                         preventDefault() {} };
        controls._handlePointerDown(fakeEv);
        assert.equal(controls._dragAction, null);
    });

    test('change event fires when reset() is called', () => {
        const { controls } = makeControls();
        let fired = 0;
        controls.addEventListener('change', () => { fired++; });
        controls.reset();
        assert.ok(fired >= 1);
    });
});

// ── Rubber-band membership ───────────────────────────────────────────────────
suite('rubber_band', () => {
    const inside    = { minX: 20, maxX: 30, minY: 20, maxY: 30 };
    const crossing  = { minX: 15, maxX: 25, minY: 20, maxY: 30 }; // straddles left edge
    const outside   = { minX:  0, maxX: 10, minY:  0, maxY: 10 };

    const rect = { left: 18, right: 60, top: 18, bottom: 60 };

    test('window mode: fully enclosed = picked', () => {
        assert.equal(decideMembership('window', rect, inside),    true);
        assert.equal(decideMembership('window', rect, crossing),  false);
        assert.equal(decideMembership('window', rect, outside),   false);
    });

    test('crossing mode: anything touching = picked', () => {
        assert.equal(decideMembership('crossing', rect, inside),   true);
        assert.equal(decideMembership('crossing', rect, crossing), true);
        assert.equal(decideMembership('crossing', rect, outside),  false);
    });

    test('crossing mode: AABB fully containing the band rect is picked', () => {
        const huge = { minX: -100, maxX: 1000, minY: -100, maxY: 1000 };
        assert.equal(decideMembership('crossing', rect, huge), true);
    });
});

await runAll();
