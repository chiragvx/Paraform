/**
 * TransformGizmo — Fusion-style translate / rotate / scale manipulator that
 * wraps THREE.TransformControls (three/examples/jsm).
 *
 *   const gizmo = new TransformGizmo({
 *       camera, renderer, scene,
 *       cameraControls,    // CADCameraControls — disabled during a drag
 *       selection,         // PickingSelection from lib/picking
 *       bodyRoot: () => bridge.bodyTransform,    // resolves selection → Object3D
 *       onChange: () => requestRender?.(),
 *   });
 *
 *   gizmo.setMode('translate' | 'rotate' | 'scale');
 *   gizmo.setEnabled(true | false);
 *   gizmo.dispose();
 *
 * Hotkeys (installed on `window`, skipped while typing in inputs):
 *   W — translate    E — rotate    R — scale    Q — toggle on/off
 *
 * Z-up correctness:
 *   The kernel ships geometry in world-frame Z-up, but the bridge wraps GLB
 *   bodies under a `+π/2` X-rotation node (see CLAUDE.md "GLB import"). We
 *   attach the gizmo to the **selected Object3D** (which is the wrap or its
 *   descendant), and force `controls.space = 'world'` so the handles align to
 *   world X / Y / Z rather than the wrap's local frame. The world frame is the
 *   one the user reasons about (the grid, the axes, the named views all live
 *   there), so world-space gizmos are the right default for a CAD app.
 *
 *   TransformControls itself is Y-up biased internally, but only insofar as
 *   its default `space` is 'local'. With 'world', the handles read straight
 *   off the world basis and we get correct Z-up axes for free.
 *
 * TODO(kernel-integration): right now the drag mutates the THREE.Object3D
 *   directly (position / quaternion / scale). For feature-tree integration we
 *   need to emit a delta and route it through a "Move feature" op so the
 *   change survives a kernel regen. The bridge currently replaces the body
 *   group on every regen, which would wipe the visual transform. Until then
 *   the gizmo is best used on selections that aren't followed by a regen.
 */

import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';

const MODES = new Set(['translate', 'rotate', 'scale']);

export class TransformGizmo {
    /**
     * @param {object}   args
     * @param {THREE.Camera}        args.camera
     * @param {THREE.WebGLRenderer} args.renderer
     * @param {THREE.Scene}         args.scene
     * @param {object}              args.cameraControls — CADCameraControls; .enabled is toggled during drag.
     * @param {object}              [args.selection]    — PickingSelection (lib/picking/selection.js).
     * @param {() => THREE.Object3D|null} [args.bodyRoot] — getter for the bridge's bodyTransform.
     * @param {() => void}          [args.onChange]     — request a re-render after a drag step.
     * @param {string}              [args.initialMode]  — 'translate' | 'rotate' | 'scale' (default translate).
     * @param {boolean}             [args.installHotkeys] — default true.
     */
    constructor({
        camera, renderer, scene,
        cameraControls,
        selection = null,
        bodyRoot = null,
        onChange = null,
        initialMode = 'translate',
        installHotkeys = true,
    }) {
        if (!camera || !renderer || !scene) {
            throw new Error('TransformGizmo: camera/renderer/scene required');
        }
        this.camera = camera;
        this.renderer = renderer;
        this.scene = scene;
        this.cameraControls = cameraControls || null;
        this.selection = selection || null;
        this.bodyRoot = (typeof bodyRoot === 'function') ? bodyRoot : (() => null);
        this.onChange = (typeof onChange === 'function') ? onChange : null;

        this._enabled = true;
        this._attached = null;       // THREE.Object3D currently held by the gizmo
        this._wasCameraEnabled = true;

        this._controls = new TransformControls(camera, renderer.domElement);
        // World-space handles. CLAUDE.md is Z-up world; the wrap rotates the
        // GLB data into world Z, so 'world' is what users expect.
        try { this._controls.setSpace('world'); } catch {}
        this._controls.setSize(0.85);
        this._controls.setMode(MODES.has(initialMode) ? initialMode : 'translate');
        // Render gizmo on top of the body so users can grab handles even when
        // a face is fully covering them.
        const giz = this._controls.getHelper ? this._controls.getHelper() : this._controls;
        giz.renderOrder = 999;
        scene.add(giz);
        this._helper = giz;

        // Disable camera controls during drag — otherwise an orbit fires the
        // moment the user grabs a handle near the body silhouette.
        this._onDraggingChanged = (ev) => {
            if (!this.cameraControls) return;
            if (ev.value) {
                this._wasCameraEnabled = !!this.cameraControls.enabled;
                this.cameraControls.enabled = false;
            } else {
                this.cameraControls.enabled = this._wasCameraEnabled;
            }
        };
        this._onObjectChange = () => {
            // TODO(kernel-integration): emit a feature-tree delta here.
            // For now, mutating the Object3D directly is enough for the
            // viewport-v2 UX pass; the next pass routes through a Move op.
            if (this.onChange) this.onChange();
        };
        this._controls.addEventListener('dragging-changed', this._onDraggingChanged);
        this._controls.addEventListener('objectChange', this._onObjectChange);
        this._controls.addEventListener('change', this._onObjectChange);

        // Selection → attach. If a body is in the selection, hold its wrap.
        // Face / edge descriptors are ignored — gizmo is body-level only for
        // this pass.
        this._unsubSelection = null;
        if (this.selection && typeof this.selection.subscribe === 'function') {
            this._unsubSelection = this.selection.subscribe(() => this._refreshAttachment());
            this._refreshAttachment();
        }

        // Hotkeys
        this._onKey = (e) => this._handleKey(e);
        if (installHotkeys) window.addEventListener('keydown', this._onKey);
    }

    /** Manually attach the gizmo to a specific Object3D (skips selection). */
    attach(obj) {
        if (!obj) { this.detach(); return; }
        if (this._attached === obj) return;
        this._attached = obj;
        this._controls.attach(obj);
        this._controls.visible = this._enabled;
    }

    detach() {
        if (!this._attached) return;
        this._attached = null;
        try { this._controls.detach(); } catch {}
        this._controls.visible = false;
    }

    /** 'translate' | 'rotate' | 'scale' */
    setMode(mode) {
        if (!MODES.has(mode)) return;
        this._controls.setMode(mode);
    }

    getMode() { return this._controls.getMode ? this._controls.getMode() : this._controls.mode; }

    /** Master toggle. When false, the gizmo is hidden AND detaches from input. */
    setEnabled(b) {
        this._enabled = !!b;
        this._controls.enabled = this._enabled;
        this._controls.visible = this._enabled && !!this._attached;
        if (!this._enabled) {
            // Make sure we don't leave camera controls disabled if a drag
            // was in flight when the user toggled off.
            if (this.cameraControls) this.cameraControls.enabled = this._wasCameraEnabled;
        }
    }

    isEnabled() { return this._enabled; }

    /** Recompute attachment from the current selection. */
    _refreshAttachment() {
        if (!this.selection || !this._enabled) return;
        const root = this.bodyRoot();
        if (!root) { this.detach(); return; }
        // Prefer the first body-kind descriptor; fall back to ANY descriptor
        // and resolve to its owning wrap via featureId.
        const entries = this.selection.toArray();
        if (entries.length === 0) { this.detach(); return; }
        // Find target object: body wrap with matching featureId.
        const wantedIds = new Set();
        for (const e of entries) {
            const d = e && e.descriptor;
            if (!d) continue;
            const fid = d.featureId || d.feature;
            if (fid) wantedIds.add(fid);
        }
        if (wantedIds.size === 0) { this.detach(); return; }

        let target = null;
        if (root.userData && wantedIds.has(root.userData.featureId)) {
            target = root;
        }
        if (!target) {
            root.traverse?.((node) => {
                if (target) return;
                if (node.userData && wantedIds.has(node.userData.featureId)) {
                    // Walk up to the wrap so the whole body moves as one.
                    let p = node;
                    while (p && p.name !== '__v4_glb_wrap__' && p.parent && p.parent !== root.parent) {
                        if (p === root) break;
                        p = p.parent;
                    }
                    target = p || node;
                }
            });
        }
        if (target) this.attach(target);
        else this.detach();
    }

    _handleKey(e) {
        if (!this._enabled && e.key.toLowerCase() !== 'q') return;
        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        const k = e.key.toLowerCase();
        if (k === 'w') { e.preventDefault(); this.setMode('translate'); }
        else if (k === 'e') { e.preventDefault(); this.setMode('rotate'); }
        else if (k === 'r') { e.preventDefault(); this.setMode('scale'); }
        else if (k === 'q') { e.preventDefault(); this.setEnabled(!this._enabled); }
    }

    dispose() {
        window.removeEventListener('keydown', this._onKey);
        if (this._unsubSelection) { try { this._unsubSelection(); } catch {} this._unsubSelection = null; }
        try {
            this._controls.removeEventListener('dragging-changed', this._onDraggingChanged);
            this._controls.removeEventListener('objectChange', this._onObjectChange);
            this._controls.removeEventListener('change', this._onObjectChange);
        } catch {}
        try { this._controls.detach(); } catch {}
        if (this._helper && this._helper.parent) this._helper.parent.remove(this._helper);
        try { this._controls.dispose(); } catch {}
        this._attached = null;
    }
}
