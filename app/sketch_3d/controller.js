/**
 * Sketch-mode controller — orchestrates the in-viewport sketcher.
 *
 * On enter:
 *   1. Save current camera + controls snapshot
 *   2. Tween camera to top-down view of the resolved sketch plane
 *   3. Disable OrbitControls rotation (keep pan/zoom)
 *   4. Mount the Sketch3DRenderer's group into the viewport scene
 *   5. Mount the floating HTML overlay (toolbar + status + dim readout)
 *   6. Replace the canvas pointer handlers with sketch tool dispatch
 *
 * On finish/cancel:
 *   1. Optionally commit the local SketchData as a v4 Sketch feature
 *      (and, if the user filled in an Extrude amount, an Extrude on top)
 *   2. Reverse the visual changes: dispose the overlay group, hide the HTML
 *      overlay, restore OrbitControls, tween camera back to the snapshot.
 */

import * as THREE from 'three';
import { ensureStyles } from './styles.js';
import { resolvePlane, topDownCameraTarget } from './plane.js';
import { Sketch3DRenderer } from './renderer.js';
import { snapshotView, tweenTo, tweenToSnapshot } from './camera_anim.js';
import { cursorOnPlane } from './hit_test.js';
import { snap as _snap3D } from './snap_3d.js';
import { TOOL_FACTORIES_3D, toggleConstructionOnSelection } from './tools_3d.js';
import { DimReadout } from './dim_readout.js';
import { ConstraintBadgeLayer } from './constraint_badges.js';
import { ConstraintPanel } from './constraint_panel.js';
import { InferredGlyphLayer } from './inferred_glyphs.js';
import { DynamicDimInput } from './dynamic_dim_input.js';
import {
    makeSketchData, stockPlane, entityCount, constraintCount, removeEntity,
} from '../../lib/sketch/sketch_data.js';
import { solve as solveSketch } from '../../lib/sketch/solver/index.js';
import { addSketchChange, sketchDataOf, updateSketchChange, isSketchFeature } from '../../lib/sketch/feature.js';
import { extrudeSketch } from '../../lib/document/operations.js';

const TOOL_LIST = [
    { key: 'select',  label: 'Select', hotkey: 'V' },
    { key: 'line',    label: 'Line',   hotkey: 'L' },
    { key: 'rect',    label: 'Rect',   hotkey: 'R' },
    { key: 'circle',  label: 'Circle', hotkey: 'C' },
    { key: 'polygon', label: 'Polygon',hotkey: 'P' },
    { key: 'slot',    label: 'Slot',   hotkey: 'S' },
    { key: 'spline',  label: 'Spline', hotkey: 'N' },
    { key: 'dim',     label: 'Dim',    hotkey: 'D' },
    { key: 'fillet',  label: 'Fillet', hotkey: 'F' },
    { key: 'chamfer', label: 'Chamfer',hotkey: 'K' },
    { key: 'offset',  label: 'Offset', hotkey: 'O' },
    { key: 'trim',    label: 'Trim',   hotkey: 'T' },
    { key: 'extend',  label: 'Extend', hotkey: 'E' },
    { key: 'mirror',  label: 'Mirror', hotkey: 'M' },
    { key: 'pattern-linear',   label: 'L-Array',  hotkey: 'A' },
    { key: 'pattern-circular', label: 'C-Array',  hotkey: 'X' },
    { key: 'arc-tangent',      label: 'Arc-Tan',  hotkey: 'G' },
    { key: 'arc-3point',       label: 'Arc-3pt',  hotkey: 'H' },
    { key: 'arc-center',       label: 'Arc-Ctr',  hotkey: 'J' },
    { key: 'text',             label: 'Text',     hotkey: 'Y' },
];

const PLANE_OPTIONS = ['XY', 'XZ', 'YZ'];

export class SketchModeController {
    /**
     * @param {object} opts
     * @param {object} opts.viewport — { scene, camera, renderer, controls }
     * @param {DocumentStore} opts.store
     * @param {object} [opts.bridge]
     * @param {string|object} [opts.plane] — stock-plane name (`'XY'`/`'XZ'`/`'YZ'`)
     *   or a full planeRef object (`{ kind: 'face' | 'construction', … }`).
     *   Face planes should carry `origin` + `normal` cache so the basis
     *   can be built immediately (see `lib/sketch/sketch_data.js:facePlane`).
     * @param {(msg:string, kind?:string)=>void} [opts.toast]
     */
    constructor({ viewport, store, bridge = null, plane = 'XY', toast = null }) {
        if (!viewport || !viewport.scene || !viewport.camera || !viewport.renderer) {
            throw new Error('SketchModeController: viewport must carry { scene, camera, renderer }');
        }
        if (!store) throw new Error('SketchModeController: missing store');
        this.viewport   = viewport;
        this.store      = store;
        this.bridge     = bridge;
        this.toast      = toast || ((msg) => console.info('[sk3d]', msg));

        // Accept either a stock-plane name (legacy callers) or a full
        // planeRef object (face / construction sketches). When a name comes
        // in, build the stock planeRef; otherwise trust the object.
        let planeRef;
        if (typeof plane === 'string') {
            this.planeName = PLANE_OPTIONS.includes(plane) ? plane : 'XY';
            planeRef = stockPlane(this.planeName);
        } else if (plane && plane.kind) {
            planeRef = plane;
            this.planeName = plane.kind === 'stock' ? plane.name : plane.kind;
        } else {
            this.planeName = 'XY';
            planeRef = stockPlane('XY');
        }
        this.gridSize   = 1;
        this.polygonSides = 6;
        this._active    = false;
        /** Public mirror of `_activeTool`'s key — handy for external toolbars. */
        this.activeTool = null;

        if (typeof document !== 'undefined') ensureStyles(document);

        // Local SketchData lives only in memory until Finish.
        this.sketchData = makeSketchData(planeRef, { name: 'Sketch' });
        this.plane = resolvePlane(this.sketchData.planeRef);
        /** True when we're editing an existing feature; on Finish we emit
         *  a SET_PARAMS change instead of ADD_FEATURE so the feature id is
         *  preserved (and downstream extrudes / fillets keep referencing it).
         */
        this._editingExistingFeatureId = null;
        /** Mid-draw construction flag — Tab toggles. Tools that build new
         *  entities should consult this and pass `construction: true` to the
         *  entity factory when set. New entities currently in the registry
         *  read this via `ed._drawingConstruction`. */
        this._drawingConstruction = false;
        /** Driven-dimension toggle — when true, the next dimension placed by
         *  the Dim tool is marked `driven: true` and the solver skips it.
         *  Toggleable via the SketchToolbar chip. */
        this._drivenDimMode = false;

        // ── Undo/redo ─────────────────────────────────────────────────────
        // Each stack entry is a deep-cloned snapshot of `this.sketchData`
        // (post-mutation state). `_lastSnapshot` mirrors the most recently
        // committed state so that the next `commitDirty` can push it to the
        // undo stack as the "previous" state for the new mutation.
        this._undoStack = [];
        this._redoStack = [];
        this._undoCap   = 50;
        this._lastSnapshot = this._cloneSketch(this.sketchData);
        /** True while undo/redo is restoring state — suppresses snapshot
         *  capture inside commitDirty so we don't trash the redo stack. */
        this._restoring = false;
    }

    /** Deep-clone a SketchData object. Re-freezes entities/constraints to
     *  match the makeSketchData invariant on the way out (mirrors the same
     *  ritual in `loadFromFeature`). */
    _cloneSketch(s) {
        if (!s) return null;
        return JSON.parse(JSON.stringify(s));
    }

    /** Restore a previously-cloned snapshot into `this.sketchData`,
     *  re-freezing entities + constraints, refreshing the renderer + badges +
     *  constraint-panel, and re-solving. */
    _restoreSketch(snap) {
        const restored = JSON.parse(JSON.stringify(snap));
        for (const id of Object.keys(restored.entities || {})) {
            const e = restored.entities[id];
            restored.entities[id] = Object.freeze({ ...e, params: Object.freeze({ ...e.params }) });
        }
        for (const id of Object.keys(restored.constraints || {})) {
            const c = restored.constraints[id];
            restored.constraints[id] = Object.freeze({ ...c });
        }
        this.sketchData = restored;
        if (this.renderer) {
            this.renderer.sketchData = this.sketchData;
            // Drop any selection — stale ids could be referenced.
            this.renderer.setSelection([]);
            this.renderer.setHover(null);
            this.renderer.setPreview(null);
            this.renderer.setSnap(null);
        }
        if (this._badges)          this._badges.setSketchData(this.sketchData);
        if (this._constraintPanel) this._constraintPanel.setSketchData(this.sketchData);

        // Re-solve and re-render through commitDirty, but flagged so we
        // don't push a new undo snapshot for the restore itself.
        this._restoring = true;
        try { this.commitDirty(true); }
        finally { this._restoring = false; }
        // After a successful restore, lastSnapshot mirrors the current state
        // so the next mutation captures the right "previous" frame.
        this._lastSnapshot = this._cloneSketch(this.sketchData);
    }

    /** Undo the most recent committed sketch mutation. */
    undo() {
        if (!this._undoStack.length) {
            this._setStatus('Nothing to undo.');
            return false;
        }
        // Push current state onto the redo stack (so redo can return here).
        this._redoStack.push(this._cloneSketch(this.sketchData));
        if (this._redoStack.length > this._undoCap) this._redoStack.shift();
        const prev = this._undoStack.pop();
        this._restoreSketch(prev);
        this._setStatus('Undo.');
        return true;
    }

    /** Redo the last undone mutation. */
    redo() {
        if (!this._redoStack.length) {
            this._setStatus('Nothing to redo.');
            return false;
        }
        this._undoStack.push(this._cloneSketch(this.sketchData));
        if (this._undoStack.length > this._undoCap) this._undoStack.shift();
        const next = this._redoStack.pop();
        this._restoreSketch(next);
        this._setStatus('Redo.');
        return true;
    }

    /**
     * Toggle the "driven (reference) dimensions" mode. Returns the new state.
     * Exposed for the Svelte SketchToolbar's chip.
     */
    toggleDrivenDimMode() {
        this._drivenDimMode = !this._drivenDimMode;
        this._setStatus(this._drivenDimMode
            ? 'Driven-dim mode ON — next dim is reference-only.'
            : 'Driven-dim mode OFF.');
        return this._drivenDimMode;
    }

    /**
     * Stub for the Project Geometry flow owned by the sibling face-pick agent.
     * Real implementation: build a construction polyline by intersecting the
     * resolved edge curve with the sketch plane. v1 is logging-only so the
     * sibling has a stable hook to call from its toolbar button.
     */
    addProjectedEdge(descriptor) {
        console.warn('[sketcher] projected edge from descriptor', descriptor, '— TODO implementation');
        this.toast && this.toast('Project geometry: stub (descriptor logged).', 'info');
        return null;
    }

    /**
     * Reopen the editor on an existing Sketch feature in the document.
     * Loads the stored SketchData, infers the plane, and tells `finish` to
     * commit a SET_PARAMS change against the original feature id.
     *
     * @param {string} featureId
     */
    loadFromFeature(featureId) {
        const feat = this.store.doc.features[featureId];
        if (!feat || !isSketchFeature(feat)) {
            throw new Error(`loadFromFeature: feature ${featureId} is not a Sketch`);
        }
        const stored = sketchDataOf(feat);
        // Deep clone so the editor mutates an independent copy until Finish.
        this.sketchData = JSON.parse(JSON.stringify(stored));
        // Re-freeze entity records to match the makeSketchData invariant.
        for (const id of Object.keys(this.sketchData.entities)) {
            const e = this.sketchData.entities[id];
            this.sketchData.entities[id] = Object.freeze({ ...e, params: Object.freeze({ ...e.params }) });
        }
        this.planeName = (this.sketchData.planeRef && this.sketchData.planeRef.name) || 'XY';
        this.plane = resolvePlane(this.sketchData.planeRef);
        this._editingExistingFeatureId = featureId;
        // Reset undo/redo for the freshly-loaded sketch.
        this._undoStack = [];
        this._redoStack = [];
        this._lastSnapshot = this._cloneSketch(this.sketchData);
        if (this.renderer) { this.renderer.sketchData = this.sketchData; this.renderer.setPlane(this.plane); this.renderer.render(); }
        if (this._badges)          { this._badges.setSketchData(this.sketchData);          this._badges.refresh(); }
        if (this._constraintPanel) { this._constraintPanel.setSketchData(this.sketchData); }
        this._setStatusCounts();
        return this;
    }

    // ── Lifecycle ──────────────────────────────────────────────────────────

    enter() {
        if (this._active) return;
        this._active = true;

        // 1. Snapshot the camera so we can restore it on exit
        this._cameraSnapshot = snapshotView(this.viewport.camera, this.viewport.controls);

        // 2. Build the 3D sketch renderer + add it to the scene
        this.renderer = new Sketch3DRenderer({ sketchData: this.sketchData, plane: this.plane });
        this.viewport.scene.add(this.renderer.group);

        // 3. Mount the HTML overlay (toolbar + status + dim readout)
        this._mountOverlay();

        // 4. Pin OrbitControls to "pan + zoom only" so the camera stays aligned
        //    with the sketch plane while the user works.
        if (this.viewport.controls) {
            this._ctrlSnapshot = {
                enableRotate: this.viewport.controls.enableRotate,
                enablePan:    this.viewport.controls.enablePan,
                enableZoom:   this.viewport.controls.enableZoom,
            };
            this.viewport.controls.enableRotate = false;
        }

        // 5. Bind pointer + key events on the renderer's canvas
        this._bindEvents();

        // 6. Animate camera into top-down view of the sketch plane
        const view = topDownCameraTarget(this.plane, this._defaultDistance());
        if (this._cameraTween) this._cameraTween.cancel();
        this._cameraTween = tweenTo({
            camera:   this.viewport.camera,
            controls: this.viewport.controls,
            toPosition: view.position,
            toTarget:   view.target,
            toUp:       view.up,
        });

        // 7. Activate the default tool
        this.setTool('line');
        this._setStatusCounts();
    }

    /**
     * Commit the sketch and exit sketch mode. If `extrudeAmount > 0`, also
     * adds an Extrude feature on top.
     */
    async finish({ extrudeAmount = 0 } = {}) {
        if (!this._active) return null;
        if (entityCount(this.sketchData) === 0) {
            this.toast('Sketch is empty.', 'error');
            return null;
        }
        try { solveSketch(this.sketchData); } catch {}

        // Re-editing path: update the existing feature in place so downstream
        // refs (Extrude/Revolve/Fillet on this sketch) keep working.
        let resultFeatureId = this.sketchData.id;
        if (this._editingExistingFeatureId) {
            // Pin the SketchData id to the feature id we're editing so the
            // `set-params` change targets the right feature.
            this.sketchData.id = this._editingExistingFeatureId;
            this.store.commit(updateSketchChange(this._editingExistingFeatureId, this.sketchData));
            resultFeatureId = this._editingExistingFeatureId;
        } else {
            this.store.commit(addSketchChange(this.sketchData));
        }

        let extruded = null;
        if (extrudeAmount > 0) extruded = extrudeSketch(resultFeatureId, { amount: +extrudeAmount });

        if (this.bridge && typeof this.bridge.runNow === 'function') this.bridge.runNow();
        this.toast(extruded
            ? `Extruded ${extrudeAmount} mm`
            : (this._editingExistingFeatureId ? 'Sketch updated' : 'Sketch committed'),
            'success');

        return this._teardown(extruded || { id: resultFeatureId });
    }

    /**
     * Cancel sketch mode. If there are uncommitted entities (the sketch has
     * been mutated but the user has never committed via Finish), prompt for
     * confirmation. The `force=true` path bypasses the prompt (used by the
     * "fast Esc-Esc" double-cancel and by programmatic teardown).
     */
    async cancel({ force = false } = {}) {
        if (!this._active) return;
        if (!force && this._hasUncommittedEntities()) {
            // Prefer the registered async confirm (custom dialog with Enter/Esc
            // accept/cancel); fall back to window.confirm only when the host
            // hasn't registered one (tests, headless).
            let ok;
            if (typeof _confirmFn === 'function') {
                try { ok = !!(await _confirmFn('Discard sketch changes?')); }
                catch { ok = false; }
            } else {
                const win = (typeof window !== 'undefined') ? window : null;
                ok = win && typeof win.confirm === 'function'
                    ? win.confirm('Discard sketch changes?')
                    : true;
            }
            if (!ok) return null;
        }
        this.toast('Sketch cancelled.', 'info');
        return this._teardown(null);
    }

    /**
     * True iff the user has added entities since last commit. The cheapest
     * signal: the in-memory SketchData has any entities AND the controller
     * isn't tracking an already-committed feature whose snapshot matches.
     */
    _hasUncommittedEntities() {
        if (!this.sketchData) return false;
        const n = entityCount(this.sketchData);
        if (n === 0) return false;
        // Editing an existing feature → entities exist by definition, but
        // they're "committed" until the user has touched them. We treat the
        // tail of `updatedAt` vs `createdAt` as a cheap "dirty" signal.
        if (this._editingExistingFeatureId) {
            return this.sketchData.updatedAt !== this.sketchData.createdAt;
        }
        return true;
    }

    _teardown(result) {
        // Animate camera back to the user's pre-sketch view first; tear DOM down on completion.
        const finish = () => {
            if (this._constraintPanel) { this._constraintPanel.destroy(); this._constraintPanel = null; }
            if (this._badges)          { this._badges.destroy();           this._badges = null; }
            if (this._glyphLayer)      { this._glyphLayer.destroy();       this._glyphLayer = null; }
            if (this._dynamicDim)      { this._dynamicDim.destroy();       this._dynamicDim = null; }
            if (this.renderer) {
                this.renderer.dispose();
                this.renderer = null;
            }
            if (this._overlayEl && this._overlayEl.parentNode) {
                this._overlayEl.parentNode.removeChild(this._overlayEl);
            }
            this._overlayEl = null;
            this._unbindEvents();
            // Restore the renderer's original render() so the legacy app
            // doesn't pay the badge-refresh cost after we leave.
            if (this._renderPatchOwner) {
                const r = this.viewport.renderer;
                if (r && r.__pf4_sk3d_origRender) {
                    r.render = r.__pf4_sk3d_origRender;
                    delete r.__pf4_sk3d_origRender;
                    delete r.__pf4_sk3d_patched;
                }
                this._renderPatchOwner = false;
            }
            // Restore OrbitControls flags
            if (this.viewport.controls && this._ctrlSnapshot) {
                this.viewport.controls.enableRotate = this._ctrlSnapshot.enableRotate;
                this.viewport.controls.enablePan    = this._ctrlSnapshot.enablePan;
                this.viewport.controls.enableZoom   = this._ctrlSnapshot.enableZoom;
            }
            this._active = false;
        };

        if (this._cameraSnapshot && this.viewport.camera) {
            tweenToSnapshot({
                camera:   this.viewport.camera,
                controls: this.viewport.controls,
                snapshot: this._cameraSnapshot,
                onDone:   finish,
            });
        } else {
            finish();
        }
        return result;
    }

    // ── Tool / plane management ────────────────────────────────────────────

    setTool(toolKey) {
        const factory = TOOL_FACTORIES_3D[toolKey];
        if (!factory) return;
        const inst = factory();
        inst._editor = this;
        if (this._activeTool && this._activeTool.deactivate) {
            try { this._activeTool.deactivate(); } catch {}
        }
        this._activeTool = inst;
        this.activeTool = toolKey;
        if (inst.activate) inst.activate();
        this.viewport.renderer.domElement.style.cursor = inst.cursor || 'crosshair';
        if (this._overlayEl) {
            for (const btn of this._overlayEl.querySelectorAll('[data-tool]')) {
                btn.classList.toggle('pf4-active', btn.dataset.tool === toolKey);
            }
        }
        this._setStatus(`Tool: ${toolKey}.`);
    }

    // ── Public API for external toolbars (Svelte SketchToolbar etc.) ───────
    //
    // Thin wrappers over the same flows the legacy overlay buttons + key
    // handlers already drive. Each is side-effect-only and safe to call when
    // the controller is mid-tool; they reuse `commitDirty` so the renderer,
    // badges, and constraint panel stay in sync.

    /** Current selection size (0 when nothing picked). */
    get selectionSize() {
        return this.renderer ? this.renderer.getSelection().length : 0;
    }

    /** Mirror of the constraint-panel apply path, keyed by CONSTRAINT_TOOLS key. */
    applyConstraint(kind) {
        if (!this._constraintPanel) return false;
        // 'fix' is a UI-level alias — drop the user into the Dim tool which
        // prompts for a value at click and emits the right fixedDistance /
        // fixedRadius / fixedAngle constraint.
        if (kind === 'fix' || kind === 'fix-dim' || kind === 'dim') {
            this.setTool('dim');
            return true;
        }
        // Tolerate the Svelte toolbar's shorter names.
        const ALIASES = {
            equal: 'equal-length',
            horiz: 'horizontal',
            vert: 'vertical',
            perp: 'perpendicular',
        };
        const key = ALIASES[kind] || kind;
        const panel = this._constraintPanel;
        // CONSTRAINT_TOOLS is imported inside constraint_panel.js — reach for
        // it through the live panel's button map so we don't duplicate the
        // import here.
        const btn = panel._buttons && panel._buttons.get(key);
        if (!btn) return false;
        if (btn.disabled) {
            this.toast(`${key}: selection doesn't match`, 'error');
            return false;
        }
        btn.click();
        return true;
    }

    /** Delete every selected entity (cascades). No-op when nothing selected. */
    deleteSelected() {
        if (!this.renderer) return 0;
        const sel = this.renderer.getSelection();
        if (!sel.length) return 0;
        // Same code path as the in-canvas Delete/Backspace handler in tools_3d.
        for (const id of sel) removeEntity(this.sketchData, id);
        this.renderer.setSelection([]);
        this.commitDirty(true);
        return sel.length;
    }

    setPlane(name) {
        if (!PLANE_OPTIONS.includes(name) || name === this.planeName) return;
        this.planeName = name;
        this.sketchData.planeRef = stockPlane(name);
        this.plane = resolvePlane(this.sketchData.planeRef);
        if (this.renderer) this.renderer.setPlane(this.plane);
        // Re-aim the camera
        const view = topDownCameraTarget(this.plane, this._defaultDistance());
        if (this._cameraTween) this._cameraTween.cancel();
        this._cameraTween = tweenTo({
            camera: this.viewport.camera,
            controls: this.viewport.controls,
            toPosition: view.position,
            toTarget: view.target,
            toUp: view.up,
        });
        this._setStatus(`Plane → ${name}.`);
    }

    /** Tools call this after a successful entity/constraint add. */
    commitDirty(reSolve = false) {
        // Capture undo snapshot — push the PRE-mutation snapshot we cached
        // last time. Skip when we're mid-restore (undo/redo path).
        if (!this._restoring && this._lastSnapshot) {
            this._undoStack.push(this._lastSnapshot);
            if (this._undoStack.length > this._undoCap) this._undoStack.shift();
            // Any new edit invalidates the redo timeline.
            if (this._redoStack.length) this._redoStack.length = 0;
        }
        if (reSolve) {
            try { solveSketch(this.sketchData); } catch {}
        }
        if (this.renderer) this.renderer.render();
        if (this._badges)          this._badges.refresh();
        if (this._constraintPanel) this._constraintPanel.refresh();
        this._setStatusCounts();
        // Update the "last committed" snapshot so the NEXT commitDirty has a
        // pre-state to push.
        if (!this._restoring) {
            this._lastSnapshot = this._cloneSketch(this.sketchData);
        }
    }

    setDimReadout(info) {
        if (!this._dimReadout) return;
        if (!info) { this._dimReadout.clear(); return; }
        // Place the readout near the cursor — easier to use the renderer canvas
        // rect since we know `info.cursor` in sketch-local coords.
        const screen = this._localToScreen(info.cursor);
        this._dimReadout.update(info, screen);
    }

    /**
     * Show / update the inferred-constraint glyph row. `hints` is the array
     * produced by `inferDrawHints(...)` (or an empty array to hide).
     *
     * Suppresses the glyph row when Shift is currently held — the user has
     * opted out of auto-inference for this click.
     *
     * @param {Array<{kind:string,note?:string,refId?:string}>} hints
     * @param {{x:number,y:number}} cursorLocal — sketch-local coords
     */
    setInferredGlyphs(hints, cursorLocal) {
        if (!this._glyphLayer) return;
        if (this._suppressInference || !hints || !hints.length) {
            this._glyphLayer.hide();
            return;
        }
        const screen = cursorLocal ? this._localToScreen(cursorLocal) : { x: 0, y: 0 };
        this._glyphLayer.show(hints, screen);
    }

    /**
     * Open / refresh the dynamic dim input row. Returns the live
     * `DynamicDimInput` instance so tools can call `.getLocks()` on commit.
     *
     * `descriptor` = [{ key, label, unit, step }, …]
     * `values`     = { key → currentNumber }    — recomputed each frame
     * `onCommit`   = ({ locks }) => void        — fired on Enter
     */
    openDynamicDim(descriptor, values, screenAt, onCommit) {
        if (!this._dynamicDim) return null;
        this._dynamicDim.open(descriptor, onCommit);
        this._dynamicDim.update(values, screenAt);
        return this._dynamicDim;
    }

    /** Update dynamic dim values + position (no descriptor change). */
    updateDynamicDim(values, cursorLocal) {
        if (!this._dynamicDim) return;
        const screen = cursorLocal ? this._localToScreen(cursorLocal) : null;
        this._dynamicDim.update(values, screen);
    }

    /** Close the dynamic dim row (e.g. on tool deactivate / Escape). */
    closeDynamicDim() {
        if (this._dynamicDim) this._dynamicDim.close();
    }

    /** True iff the user is currently holding Shift over the canvas — used
     *  by tools to suppress inferred constraints on the next click. */
    isInferenceSuppressed() { return !!this._suppressInference; }

    // ── Event binding ──────────────────────────────────────────────────────

    _bindEvents() {
        const dom = this.viewport.renderer.domElement;
        const onDown = (ev) => this._dispatch(ev, 'onPointerDown');
        const onMove = (ev) => {
            // Track Shift live so the inferred-constraint glyph layer can
            // hide while Shift is held (user opting out of auto-inference).
            this._suppressInference = !!ev.shiftKey;
            this._dispatch(ev, 'onPointerMove');
        };
        const onUp   = (ev) => this._dispatch(ev, 'onPointerUp');
        const onKey  = (ev) => {
            if (ev.key === 'Shift') this._suppressInference = true;
            this._onKey(ev);
        };
        const onKeyUp = (ev) => {
            if (ev.key === 'Shift') this._suppressInference = false;
        };
        dom.addEventListener('pointerdown', onDown);
        dom.addEventListener('pointermove', onMove);
        dom.addEventListener('pointerup',   onUp);
        document.addEventListener('keydown', onKey);
        document.addEventListener('keyup',   onKeyUp);
        this._unbindEvents = () => {
            dom.removeEventListener('pointerdown', onDown);
            dom.removeEventListener('pointermove', onMove);
            dom.removeEventListener('pointerup',   onUp);
            document.removeEventListener('keydown', onKey);
            document.removeEventListener('keyup',   onKeyUp);
            this._unbindEvents = () => {};
        };
    }

    _dispatch(ev, method) {
        const tool = this._activeTool;
        if (!tool || typeof tool[method] !== 'function') return;
        // Pan/zoom passthrough: middle-click / right-click / Shift-drag → let OrbitControls handle it
        if (ev.button === 1 || ev.button === 2 || ev.shiftKey) return;
        // Only left button matters for tool clicks
        if (method === 'onPointerDown' && ev.button !== 0) return;

        const result = cursorOnPlane({
            event: ev,
            canvas: this.viewport.renderer.domElement,
            camera: this.viewport.camera,
            plane: this.plane,
        });
        if (!result.local) return;

        // Build the snap result — tools always receive a snapped point
        const drawingAnchor = this._activeTool && this._activeTool._anchor; // optional
        const tolWorld = this._screenToWorldDist(8);
        const snap = _snap3D(result.local, this.sketchData, {
            anchor:     drawingAnchor || this._anchorFromTool(tool),
            gridSize:   this.gridSize,
            snapRadius: tolWorld,
            orthoTol:   tolWorld,
            angleTolDeg: 3,
        });

        if (this.renderer) this.renderer.setSnap(snap);

        const ctx = {
            event: ev,
            world: result.world,
            local: result.local,
            snap,
            sketch: this.sketchData,
            renderer: this.renderer,
        };
        try { tool[method](ctx); }
        catch (e) { console.error('[sk3d tool]', e); }
    }

    // The Line tool stores its in-progress anchor on the closure; expose it
    // through a getter so the controller's snap call can use it.
    _anchorFromTool(tool) {
        // Tools opt in by setting `tool._anchor` whenever they have one
        return tool && tool._anchor ? tool._anchor : null;
    }

    _onKey(ev) {
        if (ev.target.tagName === 'INPUT' || ev.target.tagName === 'SELECT') return;
        // Ctrl/Cmd+Z → undo; Ctrl/Cmd+Y or Ctrl/Cmd+Shift+Z → redo. Stop
        // propagation so the App.svelte doc-level handler doesn't also fire
        // (it already returns early when sketch is active, but be defensive).
        const mod = ev.ctrlKey || ev.metaKey;
        if (mod && ev.key.toLowerCase() === 'z' && !ev.shiftKey) {
            ev.preventDefault();
            ev.stopPropagation();
            this.undo();
            return;
        }
        if (mod && (ev.key.toLowerCase() === 'y' || (ev.shiftKey && ev.key.toLowerCase() === 'z'))) {
            ev.preventDefault();
            ev.stopPropagation();
            this.redo();
            return;
        }
        // Tab toggles construction. If a selection exists, flip it on the
        // selected entities (per the legacy behaviour). Otherwise flip the
        // mid-draw `_drawingConstruction` flag so the next entity created by
        // the active tool is dashed.
        if (ev.key === 'Tab') {
            ev.preventDefault();
            const sel = this.renderer ? this.renderer.getSelection() : [];
            if (sel.length) {
                const n = toggleConstructionOnSelection(this.sketchData, sel);
                if (n > 0) {
                    this.commitDirty();
                    this.toast(`Toggled construction on ${n}.`, 'info');
                }
                return;
            }
            this._drawingConstruction = !this._drawingConstruction;
            this._updateConstructionBadge();
            this.toast(this._drawingConstruction ? 'CONSTRUCTION on.' : 'CONSTRUCTION off.', 'info');
            return;
        }
        for (const t of TOOL_LIST) {
            if (ev.key.toUpperCase() === t.hotkey) {
                this.setTool(t.key);
                ev.preventDefault();
                return;
            }
        }
        if (ev.key === 'Escape') {
            // Let the active tool handle first
            const tool = this._activeTool;
            if (tool && tool.onKeyDown && tool.onKeyDown(ev)) return;
            this.cancel();
            return;
        }
        if (ev.key === 'Enter') {
            this.finish();
            ev.preventDefault();
        }
    }

    // ── HTML overlay ───────────────────────────────────────────────────────

    _mountOverlay() {
        const overlay = document.createElement('div');
        overlay.className = 'pf4-sk3d-overlay';

        // NOTE: the floating bottom toolbar (tool buttons, plane select,
        // polygon-sides / extrude-amount inputs, Finish / Cancel buttons)
        // has been removed — the Svelte component
        // src/lib/components/studio/SketchToolbar.svelte now owns the entire
        // sketch UI surface. Only scene-coupled overlays live here:
        //   • pf4-sk3d-status      — bottom status row (Ready, counts, DOF, hints)
        //   • pf4-sk3d-status-chip — corner chip (Plane / Tool / DOF)
        //   • pf4-sk3d-construction-badge — CONSTRUCTION mode indicator
        //   • DimReadout / InferredGlyphLayer / DynamicDimInput / ConstraintBadgeLayer
        //   • ConstraintPanel — left-edge constraint side panel
        overlay.innerHTML = `
            <div class="pf4-sk3d-status">
                <span data-stat="tool">Ready.</span>
                <span data-stat="counts"></span>
                <span class="pf4-sk3d-dof" data-stat="dof"></span>
                <span style="color:#5a5a5a">Shift-drag to pan · wheel to zoom · Tab construction · Esc cancel · Enter finish</span>
            </div>
            <div class="pf4-sk3d-status-chip" data-stat="status-chip"
                 style="position:absolute;top:8px;right:8px;padding:4px 8px;border-radius:4px;background:rgba(20,20,20,0.6);color:#cfcfcf;font:11px/1.2 monospace;pointer-events:none">
                Plane: ${this.planeName} · Tool: — · DOF: ?
            </div>
            <div class="pf4-sk3d-construction-badge" data-stat="construction"
                 style="position:absolute;top:8px;left:8px;padding:2px 6px;border-radius:3px;background:rgba(120,80,30,0.7);color:#ffd9a0;font:10px/1.2 monospace;letter-spacing:1px;display:none;pointer-events:none">
                CONSTRUCTION
            </div>`;

        // Mount inside the viewport container so the overlays float over the canvas
        const host = this.viewport.renderer.domElement.parentElement || document.body;
        host.style.position = host.style.position || 'relative';
        host.appendChild(overlay);
        this._overlayEl  = overlay;
        this._statusEl   = overlay.querySelector('[data-stat="tool"]');
        this._countsEl   = overlay.querySelector('[data-stat="counts"]');
        this._dofEl      = overlay.querySelector('[data-stat="dof"]');
        this._statusChipEl     = overlay.querySelector('[data-stat="status-chip"]');
        this._constructionBadgeEl = overlay.querySelector('[data-stat="construction"]');

        // Dim readout — floating element parented to the overlay
        this._dimReadout = new DimReadout(overlay);
        // Inferred-constraint glyphs (small pills below-right of the cursor
        // while a tool is in mid-draw) + dynamic length/angle input.
        this._glyphLayer   = new InferredGlyphLayer(overlay);
        this._dynamicDim   = new DynamicDimInput(overlay);

        // Constraint badges — live overlay; refreshed by commitDirty + on render
        this._badges = new ConstraintBadgeLayer({
            host: overlay,
            sketchData: this.sketchData,
            localToScreen: (pt) => this._localToScreen(pt),
            onAfterRemove: () => this.commitDirty(true),
        });

        // Constraint panel — selection-aware toolbar pinned to the left edge
        this._constraintPanel = new ConstraintPanel({
            host: overlay,
            sketchData: this.sketchData,
            getSelection: () => this.renderer ? this.renderer.getSelection() : [],
            toast: (msg, kind) => this.toast(msg, kind),
            onApply: () => this.commitDirty(true),
        });

        // Push selection updates straight to the panel so buttons enable
        // immediately as the user clicks entities.
        if (this.renderer) {
            this.renderer.setSelectionListener(() => {
                if (this._constraintPanel) this._constraintPanel.refresh();
            });
        }
        // Hook the viewport render loop so badges follow camera pan/zoom.
        // Three.js doesn't expose an "after-render" event — we monkey-patch the
        // renderer's render() to call our refresh, which is cheap enough that
        // the per-frame cost is invisible.
        const renderer = this.viewport.renderer;
        if (renderer && !renderer.__pf4_sk3d_patched) {
            const origRender = renderer.render.bind(renderer);
            const patched = (scene, camera) => {
                origRender(scene, camera);
                if (this._badges && this._active) this._badges.refresh();
            };
            renderer.__pf4_sk3d_patched = true;
            renderer.__pf4_sk3d_origRender = renderer.render;
            renderer.render = patched;
            this._renderPatchOwner = true;
        }
    }

    // ── In-canvas dimension input ──────────────────────────────────────────

    /**
     * Open a small HTML input near a sketch-local point. On Enter, calls
     * `onCommit(value)`. On Escape / blur, cancels silently.
     *
     * @param {object} args
     * @param {{x:number,y:number}} args.anchor    — sketch-local 2D point
     * @param {number} args.current                — pre-filled value
     * @param {string} [args.unit]
     * @param {(value:number)=>void} args.onCommit
     */
    openDimInput({ anchor, current, unit = 'mm', onCommit }) {
        this.closeDimInput();
        if (!this._overlayEl) return;
        const screen = this._localToScreen(anchor);
        const el = document.createElement('div');
        el.className = 'pf4-sk3d-diminput';
        el.innerHTML =
            `<input type="text" inputmode="decimal" value="${Number(current).toFixed(2)}" autofocus />` +
            `<span class="pf4-sk3d-diminput-unit">${unit}</span>`;
        el.style.left = `${screen.x + 12}px`;
        el.style.top  = `${screen.y - 14}px`;
        this._overlayEl.appendChild(el);

        const input = el.querySelector('input');
        input.focus(); input.select();
        const close = () => this.closeDimInput();
        const commit = () => {
            const v = parseFloat(input.value);
            if (Number.isFinite(v) && v > 0) {
                try { onCommit(v); }
                catch (err) { this.toast(`Dim failed: ${err.message}`, 'error'); }
            }
            close();
        };
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
            else if (e.key === 'Escape') { e.preventDefault(); close(); }
            // Don't let the keyboard shortcuts grab the input
            e.stopPropagation();
        });
        input.addEventListener('blur', () => setTimeout(close, 80));
        this._dimInputEl = el;
    }

    closeDimInput() {
        if (this._dimInputEl && this._dimInputEl.parentNode) {
            this._dimInputEl.parentNode.removeChild(this._dimInputEl);
        }
        this._dimInputEl = null;
    }

    _setStatus(msg) {
        if (this._statusEl) this._statusEl.textContent = msg;
        this._updateStatusChip();
    }
    _setStatusCounts() {
        if (this._countsEl) {
            const ec = entityCount(this.sketchData);
            const cc = constraintCount(this.sketchData);
            this._countsEl.textContent = `${ec} entities · ${cc} constraints`;
        }
        this._updateStatusChip();
    }
    _updateStatusChip() {
        if (!this._statusChipEl) return;
        // DOF is populated post-solve on `sketchData.dof`; -1 = unknown.
        // TODO: when the solver exposes a sketch DOF API live (without a full
        // solve), wire it here so the chip stays current mid-edit.
        const dof = (this.sketchData && Number.isFinite(this.sketchData.dof) && this.sketchData.dof >= 0)
            ? String(this.sketchData.dof)
            : '?';
        const tool = this.activeTool || '—';
        this._statusChipEl.textContent = `Plane: ${this.planeName} · Tool: ${tool} · DOF: ${dof}`;
    }
    _updateConstructionBadge() {
        if (!this._constructionBadgeEl) return;
        this._constructionBadgeEl.style.display = this._drawingConstruction ? 'block' : 'none';
    }

    // ── Coord helpers ─────────────────────────────────────────────────────

    _defaultDistance() {
        // Camera distance to plane — large enough that a 100 mm sketch fits
        // in the viewport on first frame.
        return 120;
    }

    _localToScreen(local) {
        // Project the local 2D point into screen-relative coords.
        const v = new THREE.Vector3();
        const [wx, wy, wz] = require_localToWorld(local, this.plane);
        v.set(wx, wy, wz);
        v.project(this.viewport.camera);
        const rect = this.viewport.renderer.domElement.getBoundingClientRect();
        return {
            x: (v.x * 0.5 + 0.5) * rect.width,
            y: (-v.y * 0.5 + 0.5) * rect.height,
        };
    }

    _screenToWorldDist(pixels) {
        // Approximate world-units-per-pixel from camera distance to target.
        const cam = this.viewport.camera;
        const tgt = this.viewport.controls ? this.viewport.controls.target : new THREE.Vector3(0, 0, 0);
        const dist = cam.position.distanceTo(tgt);
        const rect = this.viewport.renderer.domElement.getBoundingClientRect();
        const halfFov = THREE.MathUtils.degToRad((cam.fov || 75) / 2);
        const worldPerPx = (2 * Math.tan(halfFov) * dist) / (rect.height || 1);
        return pixels * worldPerPx;
    }

    /** Inverse — convert a world distance (mm) to screen-pixel units. */
    _worldToScreenDist(worldUnits) {
        const w = this._screenToWorldDist(1);
        return w > 0 ? worldUnits / w : 0;
    }

    /**
     * Run the snap pipeline against a sketch-local cursor and return the
     * snap result. Used by tools that need snap-during-drag.
     *
     * @param {{x:number,y:number}} cursor
     * @param {string|null} [excludeId]
     */
    _snapCursor(cursor, excludeId = null) {
        const tolWorld = this._screenToWorldDist(8);
        return _snap3D(cursor, this.sketchData, {
            gridSize:    this.gridSize,
            anchor:      null,
            snapRadius:  tolWorld,
            orthoTol:    tolWorld,
            angleTolDeg: 3,
            excludeId,
        });
    }

    /** Force the badge layer to recompute (called mid-drag by tools). */
    _refreshBadges() {
        if (this._badges && typeof this._badges.refresh === 'function') {
            this._badges.refresh();
        }
    }
}

// Local mirror of plane.js localToWorld to avoid a circular call back.
function require_localToWorld(pt2, plane) {
    const u = Array.isArray(pt2) ? +pt2[0] : +pt2.x;
    const v = Array.isArray(pt2) ? +pt2[1] : +pt2.y;
    const ox = plane.origin, ax = plane.xAxis, ay = plane.yAxis;
    return [
        ox[0] + u * ax[0] + v * ay[0],
        ox[1] + u * ax[1] + v * ay[1],
        ox[2] + u * ax[2] + v * ay[2],
    ];
}

// ── Module singleton ────────────────────────────────────────────────────────

let _active = null;
// Host-installed confirm function (returns a Promise<boolean>). When set,
// SketchModeController.cancel() prefers it over native window.confirm.
let _confirmFn = null;
export function setSketchConfirmFn(fn) { _confirmFn = (typeof fn === 'function') ? fn : null; }

/** Enter sketch mode. Cancels any previously-active controller first. */
export function enterSketchMode(opts) {
    if (_active) { try { _active.cancel(); } catch {} _active = null; }
    _active = new SketchModeController(opts);
    _active.enter();
    return _active;
}

export function exitSketchMode() {
    if (_active) { try { _active.cancel(); } catch {} _active = null; }
}

export function getActiveSketchController() { return _active; }
