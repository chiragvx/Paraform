/**
 * CADCameraControls — drop-in replacement for THREE.OrbitControls with
 * CAD-grade feel: ray-hit pivot on orbit, cursor-glued pan, exponential
 * zoom-to-cursor, preset mappings.
 *
 * API surface kept compatible with what the rest of the app uses:
 *
 *   controls.target          : THREE.Vector3 — orbit/pan focal point
 *   controls.enabled         : boolean       — master switch (default true)
 *   controls.enableRotate    : boolean       — sketcher pins this false
 *   controls.enablePan       : boolean
 *   controls.enableZoom      : boolean
 *   controls.enableDamping   : boolean       — enables orbit inertial coast
 *   controls.dampingFactor   : number        — scales the coast duration
 *                                              (default 0.08 ≈ stock feel)
 *   controls.update()        : called from the render loop
 *   controls.reset()         : restore camera to construction-time view
 *   controls.dispose()       : detach listeners
 *
 * In addition:
 *
 *   controls.setPreset(name)               : 'solidworks' | 'fusion' | …
 *   controls.setPickProvider(fn)           : raycast hook (see below)
 *   controls.setReverseZoom(bool)
 *   controls.setSpeeds({ orbit, pan, zoom })
 *   controls.dollyTo(distance, [target])   : tween-friendly setter
 *
 * Pick provider — a function `(ndc) => worldHit | null` the host installs
 * so the controls can ask "what's under the cursor?" without owning a
 * scene reference. Used to derive a ray-hit pivot on orbit-down and a
 * cursor-glued depth on pan-down / wheel-zoom. If the provider is missing
 * or returns null, the controls fall back to the current target.
 *
 * Emits `change` events compatible with OrbitControls
 * (`controls.addEventListener('change', fn)`).
 */

import * as THREE from 'three';
import { DEFAULT_PRESET, resolveAction } from './presets.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _spherical = new THREE.Spherical();

const DEFAULT_ORBIT_SPEED = 0.005;    // rad / px
const DEFAULT_PAN_SPEED   = 1.0;
const DEFAULT_ZOOM_SPEED  = 1.0;
const WHEEL_FACTOR        = 0.10;     // 10 % of distance per wheel tick
const DOUBLE_TAP_MS       = 300;      // max gap between MMB taps that counts as a double-click
const TAP_PIXEL_TOL       = 4;        // movement above this turns a tap into a drag
// Trackpad gesture tuning. Two-finger scroll deltas arrive as a stream of
// small pixel-mode wheel events; we treat them as drag pixels (content
// follows the fingers, so the sign flips vs. raw deltas). Pinch arrives as
// ctrl+wheel with small deltas — boost it or pinch-zoom feels glacial.
const TRACKPAD_ORBIT_GAIN = 1.0;      // wheel px → orbit px
const TRACKPAD_PAN_GAIN   = 1.0;      // wheel px → pan px
const PINCH_ZOOM_DIVISOR  = 30;       // vs 100 for a discrete mouse notch
// How long (ms) a trackpad/mouse classification stays sticky for ambiguous
// wheel events (small integer deltas could be either device).
const WHEEL_DEVICE_STICKY_MS = 800;

/** CSS cursors per drag action — match Fusion/Onshape conventions. */
const DRAG_CURSORS = {
    orbit: 'grabbing',
    pan:   'grabbing',
    zoom:  'ns-resize',
};
const MIN_DOLLY_TARGET    = 0.5;      // mm; never closer than this to the focus
const MAX_DOLLY_TARGET    = 5000;
const POLAR_EPS           = 1e-3;     // keep poles barely-touchable so up vector survives
// Horizon-locked orbit: clamp pitch to ±89° off the world equator so the
// camera can't tumble past straight-up/down (which would flip world-up).
const HORIZON_PITCH_LIMIT = (89 * Math.PI) / 180;
// Orbit damping (inertia) tuning.
//   _DECAY_MS: ~time for velocity to fall to ~5% of release value.
//   _MIN_PX_PER_FRAME: kill the coast once below this, otherwise we keep
//   firing 'change' events forever at sub-pixel speed.
//   _SAMPLE_WINDOW_MS: only count moves within this window when measuring
//   release velocity — older deltas are stale (the user paused mid-drag).
const DAMPING_DECAY_MS       = 250;
const DAMPING_MIN_PX_PER_FRAME = 0.05;
const DAMPING_SAMPLE_WINDOW_MS = 60;

/**
 * @typedef {(ndc: {x:number,y:number}) => ({ point: THREE.Vector3 }|null)} PickProvider
 */

export class CADCameraControls extends THREE.EventDispatcher {
    /**
     * @param {THREE.Camera} camera
     * @param {HTMLElement}  domElement
     * @param {object}       [opts]
     * @param {string}       [opts.preset]         — 'solidworks' (default), 'fusion', etc.
     * @param {PickProvider} [opts.pickProvider]
     * @param {boolean}      [opts.reverseZoom]
     * @param {() => THREE.Box3|null} [opts.bodyAabbProvider] — fallback orbit-pivot
     *        source: used when the ray-cast misses geometry. The box's centre is
     *        used as the pivot. If this returns null/empty too, the controls
     *        fall back to the current `controls.target`.
     * @param {[number, number, number]} [opts.worldUp] — world-up axis for
     *        horizon-locked orbit (default `[0, 0, 1]`, matches the v4 kernel
     *        and sketcher convention). Holding Shift during a drag lifts the
     *        lock and gives free trackball-style orbit.
     * @param {boolean}      [opts.horizonLock]    — default `true`. Disable
     *        to make every orbit free (legacy behaviour).
     */
    constructor(camera, domElement, opts = {}) {
        super();
        if (!camera) throw new Error('CADCameraControls: missing camera');
        if (!domElement) throw new Error('CADCameraControls: missing domElement');

        this.camera     = camera;
        this.domElement = domElement;

        this.target = new THREE.Vector3(0, 0, 0);

        this.enabled       = true;
        this.enableRotate  = true;
        this.enablePan     = true;
        this.enableZoom    = true;
        // Orbit inertia: when true, releasing an orbit drag lets the camera
        // coast for ~DAMPING_DECAY_MS with exponential decay of the angular
        // velocity captured at pointer-up. Only kicks in after release — the
        // active drag remains cursor-glued (no lag), so the ray-pivot stays
        // honest. Default ON for Fusion preset, OFF for SolidWorks (see
        // setPreset below).
        this.enableDamping = (opts.preset === 'fusion');
        this.dampingFactor = 0.05;
        // Coast state. _coastDx / _coastDy are pixels-per-RAF carried over.
        this._coastDx = 0;
        this._coastDy = 0;
        this._coastRaf = 0;
        this._lastMoveTime = 0;

        this.orbitSpeed = DEFAULT_ORBIT_SPEED;
        this.panSpeed   = DEFAULT_PAN_SPEED;
        this.zoomSpeed  = DEFAULT_ZOOM_SPEED;
        this.reverseZoom = !!opts.reverseZoom;
        // Invert-Y on orbit: vertical mouse drag normally lifts the camera up
        // when you drag down (pitch follows the world point under the cursor).
        // Setting this flips the sign of the dy contribution in both horizon-
        // locked and trackball orbit paths, matching the "natural" scroll
        // option some users prefer from DCC apps.
        this.invertOrbitY = !!opts.invertOrbitY;
        this.minDistance = MIN_DOLLY_TARGET;
        this.maxDistance = MAX_DOLLY_TARGET;

        this._preset = opts.preset || DEFAULT_PRESET;
        /** @type {PickProvider|null} */
        this._pickProvider = opts.pickProvider || null;
        /** @type {(() => THREE.Box3|null)|null} */
        this._bodyAabbProvider = (typeof opts.bodyAabbProvider === 'function')
            ? opts.bodyAabbProvider : null;

        // World-up axis for horizon-locked orbit. Defaults to Z-up (kernel
        // convention). Holding Shift during a drag yields free orbit.
        const wu = opts.worldUp || [0, 0, 1];
        this.worldUp = new THREE.Vector3(wu[0], wu[1], wu[2]).normalize();
        this.horizonLock = opts.horizonLock !== false;

        // ── Drag state ─────────────────────────────────────────────────────
        this._dragAction = null;  // 'orbit' | 'pan' | 'zoom' | null
        this._dragPrev   = { x: 0, y: 0 };
        this._dragStart  = { x: 0, y: 0 };
        this._dragPointerId = null;
        // Modifier snapshot captured at pointer-down so the drag's modality
        // (e.g. free orbit on Shift) doesn't flicker if the user releases mid-
        // drag.
        this._dragShift = false;
        // Orbit pivot is cached for the duration of a single drag (mousedown
        // → mouseup). The pivot is the result of `_resolveOrbitPivot` at
        // mousedown — once cached we don't re-raycast mid-drag, which would
        // be both expensive and surprising (a swing across geometry would
        // change pivot depth and feel like a rubber-band).
        this._orbitPivotCached = false;
        // Target the orbit pivot replaced, snapshotted at pointer-down. Must be
        // a live Vector3 from construction — `_handlePointerDown` calls
        // `this._orbitPrevTarget.copy(this.target)` on the FIRST orbit press,
        // and an uninitialised field threw "Cannot read properties of undefined
        // (reading 'copy')" there, aborting every orbit gesture.
        this._orbitPrevTarget = new THREE.Vector3();
        // Pan-glued plane: pan keeps the world point that was under the cursor
        // at pan-start glued under the cursor for the whole drag.
        this._panPlane = new THREE.Plane();
        this._panStartWorld = new THREE.Vector3();

        // ── Reset snapshot ─────────────────────────────────────────────────
        this._reset = {
            position: camera.position.clone(),
            target:   this.target.clone(),
            up:       camera.up.clone(),
            zoom:     camera.zoom,
        };

        // ── Auto near/far clipping ─────────────────────────────────────────
        // CAD scenes span 6+ orders of magnitude (mm details to m-scale
        // assemblies). A fixed near/far either clips on zoom-out or eats
        // depth precision when zoomed close. We recompute per-frame from
        // the camera→target distance, with an optional scene-radius hint
        // so `far` always encompasses everything in the scene.
        this.autoClip = true;
        this._sceneRadiusProvider = null;

        // ── Double-MMB fit-all detection ───────────────────────────────────
        // Two MMB taps within DOUBLE_TAP_MS, neither moving more than
        // TAP_PIXEL_TOL pixels, fire a 'fit' event. The host listens and
        // calls its viewport-controller's smartFit / frameBox.
        this._lastMmbTapAt = 0;
        this._lastMmbTapPos = { x: 0, y: 0 };

        // ── Trackpad gesture mode ──────────────────────────────────────────
        // 'auto' (default): classify each wheel event as trackpad or mouse
        //   by its delta signature. Trackpad two-finger scroll orbits
        //   (Shift = pan), pinch (ctrl+wheel) zooms; a discrete mouse wheel
        //   keeps zooming.
        // 'on'  : always treat plain wheel as a trackpad scroll gesture.
        // 'off' : legacy — every wheel event zooms.
        this.trackpadMode = opts.trackpadMode || 'auto';
        this._wheelDevice = null;        // 'trackpad' | 'mouse' | null
        this._wheelDeviceAt = 0;

        this._bind();
        this._updateClipping();
    }

    // ── Setters ────────────────────────────────────────────────────────────

    setPreset(name)               {
        this._preset = name;
        // Fusion presets default to inertial orbit; SolidWorks to immediate
        // stop. Hosts that want to override should call setEnableDamping
        // after setPreset.
        if (name === 'fusion')          this.enableDamping = true;
        else if (name === 'solidworks') this.enableDamping = false;
    }
    setEnableDamping(b)           { this.enableDamping = !!b; if (!b) this._stopCoast(); }
    getPreset()                   { return this._preset; }
    setPickProvider(fn)           { this._pickProvider = (typeof fn === 'function') ? fn : null; }
    setBodyAabbProvider(fn)       { this._bodyAabbProvider = (typeof fn === 'function') ? fn : null; }
    setReverseZoom(b)             { this.reverseZoom = !!b; }
    setInvertY(b)                 { this.invertOrbitY = !!b; }
    setHorizonLock(b)             { this.horizonLock = !!b; }
    setWorldUp(v) {
        if (Array.isArray(v))         this.worldUp.set(v[0], v[1], v[2]).normalize();
        else if (v && 'x' in v)       this.worldUp.copy(v).normalize();
    }
    setSpeeds(s = {}) {
        if (Number.isFinite(s.orbit)) this.orbitSpeed = s.orbit * DEFAULT_ORBIT_SPEED;
        if (Number.isFinite(s.pan))   this.panSpeed   = s.pan;
        if (Number.isFinite(s.zoom))  this.zoomSpeed  = s.zoom;
    }

    /**
     * Provide a function returning the scene's bounding-sphere radius
     * (world units). Used by `_updateClipping` so the far plane always
     * encompasses scene contents on zoom-out. Pass a getter rather than
     * a static value because the scene grows as features are added.
     *
     * @param {() => number} fn
     */
    setSceneRadiusProvider(fn) {
        this._sceneRadiusProvider = (typeof fn === 'function') ? fn : null;
        this._updateClipping();
    }

    /** Toggle auto near/far. When off, the camera's frustum stays as-set. */
    setAutoClip(b) { this.autoClip = !!b; }

    /** Re-capture the current view as the reset target. Call after `lookAt`. */
    saveState() {
        this._reset.position.copy(this.camera.position);
        this._reset.target.copy(this.target);
        this._reset.up.copy(this.camera.up);
        this._reset.zoom = this.camera.zoom;
    }

    reset() {
        this.camera.position.copy(this._reset.position);
        this.target.copy(this._reset.target);
        this.camera.up.copy(this._reset.up);
        this.camera.zoom = this._reset.zoom;
        this.camera.lookAt(this.target);
        this.camera.updateProjectionMatrix();
        this._updateClipping();
        this.dispatchEvent({ type: 'change' });
    }

    update() {
        // No incremental work needed — every drag/wheel handler already
        // updates camera + target inline and fires 'change'. This stub keeps
        // the OrbitControls render-loop contract intact.
        return false;
    }

    dispose() { this._stopCoast(); this._unbind(); }

    // ── Inertial coast (orbit damping) ────────────────────────────────────
    //
    // Re-fires `_applyOrbit` each frame with an exponentially decaying delta
    // (half-life ~ DAMPING_DECAY_MS / 3). Cancellable via _stopCoast(); any
    // user input (pointer-down, wheel, manual setter) calls _stopCoast so the
    // user is never fighting the inertia.
    _startCoast() {
        this._stopCoast();
        const startDx = this._coastDx;
        const startDy = this._coastDy;
        const t0 = performance.now();
        // `dampingFactor` (camera setting; schema default 0.08) scales how long
        // the inertial coast lasts: the default reproduces DAMPING_DECAY_MS, a
        // higher value coasts longer, lower stops sooner. Clamped so a stray
        // value can't pin the coast on forever or zero it out.
        const df = Number.isFinite(this.dampingFactor) && this.dampingFactor > 0 ? this.dampingFactor : 0.08;
        const decayMs = Math.max(60, Math.min(2000, DAMPING_DECAY_MS * (df / 0.08)));
        // We keep the orbit pivot the user established for the drag — the
        // coast is, conceptually, the tail of the same gesture. The "drag
        // ended" cleanup in pointer-up runs AFTER this call so the pivot
        // cache is already torn down; restore it here.
        this._orbitPivotCached = true;
        const tick = () => {
            const dt = performance.now() - t0;
            // Exponential decay: a = exp(-dt / tau), tau ≈ decayMs / 3 so
            // we hit ~5% at decayMs (scaled by the user's damping setting).
            const tau = decayMs / 3;
            const a = Math.exp(-dt / tau);
            const dx = startDx * a;
            const dy = startDy * a;
            if (Math.hypot(dx, dy) < DAMPING_MIN_PX_PER_FRAME) {
                this._stopCoast();
                return;
            }
            this._applyOrbit(dx, dy);
            this._updateClipping();
            this.dispatchEvent({ type: 'change' });
            this._coastRaf = requestAnimationFrame(tick);
        };
        this._coastRaf = requestAnimationFrame(tick);
    }

    _stopCoast() {
        if (this._coastRaf) {
            cancelAnimationFrame(this._coastRaf);
            this._coastRaf = 0;
        }
        this._coastDx = 0;
        this._coastDy = 0;
    }

    /**
     * Orbit the camera around the current target as if the user dragged
     * `dxPx, dyPx` pixels. Public entry point for hosts that drive the
     * camera from outside a canvas drag — the ViewCube's drag-to-orbit /
     * free-look mode and trackpad scroll gestures both route through here.
     * Respects `enableRotate`, horizon lock, and invert-Y.
     */
    orbitBy(dxPx, dyPx) {
        if (!this.enabled || !this.enableRotate) return;
        this._stopCoast();
        this._applyOrbit(dxPx, dyPx);
        this._updateClipping();
        this.dispatchEvent({ type: 'change' });
    }

    /**
     * Screen-space pan by `dxPx, dyPx` pixels at the target's depth —
     * the world appears to follow the gesture 1:1 on screen. Public for
     * the same reasons as `orbitBy`.
     */
    panBy(dxPx, dyPx) {
        if (!this.enabled || !this.enablePan) return;
        const cam = this.camera;
        const h = this.domElement.clientHeight || 600;
        let worldPerPx;
        if (cam.isOrthographicCamera) {
            worldPerPx = (cam.top - cam.bottom) / (cam.zoom || 1) / h;
        } else {
            const dist = cam.position.distanceTo(this.target) || 1;
            worldPerPx = (2 * dist * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2))) / h;
        }
        // Camera-frame right/up in world space.
        const right = _v.setFromMatrixColumn(cam.matrixWorld, 0);
        const up    = _v2.setFromMatrixColumn(cam.matrixWorld, 1);
        const delta = _v3
            .copy(right).multiplyScalar(-dxPx * worldPerPx * this.panSpeed)
            .addScaledVector(up, dyPx * worldPerPx * this.panSpeed);
        cam.position.add(delta);
        this.target.add(delta);
        this._updateClipping();
        this.dispatchEvent({ type: 'change' });
    }

    /** 'auto' | 'on' | 'off' — see constructor docs. */
    setTrackpadMode(mode) {
        if (mode === 'auto' || mode === 'on' || mode === 'off') this.trackpadMode = mode;
    }

    /** Set distance from camera to target without changing direction. */
    dollyTo(distance, target = null) {
        if (target) this.target.copy(target);
        const dir = _v.copy(this.camera.position).sub(this.target);
        const len = dir.length() || 1;
        dir.multiplyScalar(this._clampDistance(distance) / len);
        this.camera.position.copy(this.target).add(dir);
        this.camera.lookAt(this.target);
        this.dispatchEvent({ type: 'change' });
    }

    // ── Internals ──────────────────────────────────────────────────────────

    _bind() {
        const el = this.domElement;
        // Pointer events unify mouse + pen + touch.
        this._onPointerDown   = (e) => this._handlePointerDown(e);
        this._onPointerMove   = (e) => this._handlePointerMove(e);
        this._onPointerUp     = (e) => this._handlePointerUp(e);
        this._onPointerCancel = (e) => this._handlePointerUp(e);
        this._onWheel         = (e) => this._handleWheel(e);
        this._onContextMenu   = (e) => { if (this.enabled) e.preventDefault(); };

        el.addEventListener('pointerdown',   this._onPointerDown);
        el.addEventListener('wheel',         this._onWheel, { passive: false });
        el.addEventListener('contextmenu',   this._onContextMenu);
        // move/up bind on window so we don't lose them off the canvas
        window.addEventListener('pointermove',   this._onPointerMove);
        window.addEventListener('pointerup',     this._onPointerUp);
        window.addEventListener('pointercancel', this._onPointerCancel);
    }

    _unbind() {
        const el = this.domElement;
        if (!el) return;
        el.removeEventListener('pointerdown', this._onPointerDown);
        el.removeEventListener('wheel',       this._onWheel);
        el.removeEventListener('contextmenu', this._onContextMenu);
        window.removeEventListener('pointermove',   this._onPointerMove);
        window.removeEventListener('pointerup',     this._onPointerUp);
        window.removeEventListener('pointercancel', this._onPointerCancel);
    }

    _eventNDC(ev) {
        const rect = this.domElement.getBoundingClientRect();
        return {
            x:  ((ev.clientX - rect.left) / rect.width)  * 2 - 1,
            y: -((ev.clientY - rect.top)  / rect.height) * 2 + 1,
        };
    }

    _hitWorld(ndc) {
        if (!this._pickProvider) return null;
        try {
            const hit = this._pickProvider(ndc);
            // IMPORTANT: clone — the caller stores this through the duration
            // of a drag, so a shared scratch Vector3 would get clobbered.
            if (hit && hit.point) return hit.point.clone();
        } catch { /* ignore */ }
        return null;
    }

    /**
     * Resolve the orbit pivot per the SolidWorks-style fallback chain:
     *   1. ray-hit point under the cursor (preferred — pivot on what you're
     *      looking at);
     *   2. body AABB centre (so empty space still orbits "the part");
     *   3. current `controls.target` (legacy fallback — never null).
     * Returns a NEW Vector3 the caller is free to retain.
     */
    _resolveOrbitPivot(ndc) {
        const hit = this._hitWorld(ndc);
        if (hit) return hit;
        if (this._bodyAabbProvider) {
            try {
                const box = this._bodyAabbProvider();
                if (box && !box.isEmpty()) return box.getCenter(new THREE.Vector3());
            } catch { /* ignore — defensive against provider explosions */ }
        }
        return this.target.clone();
    }

    _handlePointerDown(ev) {
        if (!this.enabled) return;
        // Any new drag kills inertia — the user is taking the wheel back.
        this._stopCoast();
        const action = resolveAction(this._preset, ev);
        if (!action) return;
        // Respect per-action toggles (sketcher disables rotate).
        if (action === 'orbit' && !this.enableRotate) return;
        if (action === 'pan'   && !this.enablePan)    return;
        if (action === 'zoom'  && !this.enableZoom)   return;

        ev.preventDefault();
        try { this.domElement.setPointerCapture(ev.pointerId); } catch {}
        this._dragAction = action;
        this._dragPointerId = ev.pointerId;
        this._dragShift = !!ev.shiftKey;
        this._dragPrev.x  = ev.clientX;
        this._dragPrev.y  = ev.clientY;
        this._dragStart.x = ev.clientX;
        this._dragStart.y = ev.clientY;

        const ndc = this._eventNDC(ev);

        if (action === 'orbit') {
            // SolidWorks-style: pivot on what the cursor's looking at.
            // Cache the resolved point as the temporary orbit centre for the
            // duration of THIS drag. The original target is restored on
            // pointer-up so accidental orbits don't permanently drift the
            // focal point off the part.
            const pivot = this._resolveOrbitPivot(ndc);
            this._orbitPrevTarget.copy(this.target);
            this._orbitPivotCached = true;
            this.target.copy(pivot);
        } else if (action === 'pan') {
            // Build a screen-aligned plane at the depth of the hit (or the
            // current target if nothing hit). The drag will keep the world
            // point under the cursor on this plane for the whole gesture.
            // Re-use the same fallback chain so empty-space pans still
            // pick a sensible depth (body-AABB centre, not a point at the
            // far plane).
            const depthPoint = this._resolveOrbitPivot(ndc);
            const camDir = _v.copy(this.camera.position).sub(depthPoint).normalize().multiplyScalar(-1);
            this._panPlane.setFromNormalAndCoplanarPoint(camDir, depthPoint);
            // Snapshot the world point we want to keep under the cursor.
            const ray = this._ndcRay(ndc);
            const hitPlane = new THREE.Vector3();
            ray.intersectPlane(this._panPlane, hitPlane);
            this._panStartWorld.copy(hitPlane);
        }
        // Swap the cursor to the action-specific glyph so users get the
        // same visual feedback Fusion/Onshape/SW all give.
        const cur = DRAG_CURSORS[action];
        if (cur) {
            this._prevCursor = this.domElement.style.cursor;
            this.domElement.style.cursor = cur;
        }
        this.dispatchEvent({ type: 'start', action });
    }

    _handlePointerMove(ev) {
        if (!this._dragAction) return;
        if (ev.pointerId !== this._dragPointerId) return;
        const dx = ev.clientX - this._dragPrev.x;
        const dy = ev.clientY - this._dragPrev.y;
        this._dragPrev.x = ev.clientX;
        this._dragPrev.y = ev.clientY;

        if (this._dragAction === 'orbit') {
            // Track per-frame orbit deltas for inertial coast at release.
            // We sample the LATEST move only — averaging over the drag would
            // damp flick gestures (rest of drag dominates the average).
            this._coastDx = dx;
            this._coastDy = dy;
            this._lastMoveTime = performance.now();
            this._applyOrbit(dx, dy);
        } else if (this._dragAction === 'pan') {
            this._applyPanCursorGlued(ev);
        } else if (this._dragAction === 'zoom') {
            // SW-style continuous zoom — vertical drag dollies in/out.
            // 1px down = zoom in, 1px up = zoom out (configurable inverse).
            const sign = this.reverseZoom ? -1 : 1;
            const factor = Math.pow(0.995, dy * sign * this.zoomSpeed);
            this._dolly(factor);
        }
        this._updateClipping();
        this.dispatchEvent({ type: 'change' });
    }

    _handlePointerUp(ev) {
        if (this._dragAction == null) return;
        if (ev.pointerId !== this._dragPointerId) return;
        try { this.domElement.releasePointerCapture(this._dragPointerId); } catch {}
        const action = this._dragAction;
        // If this was an orbit and damping is on, hand the captured per-
        // frame deltas to the coast loop. The coast keeps the orbit pivot
        // cached for its duration (otherwise the next 'change' fired by
        // _applyOrbit would re-resolve against the current target and drift).
        if (this._dragAction === 'orbit' && this.enableDamping) {
            const stale = (performance.now() - this._lastMoveTime) > DAMPING_SAMPLE_WINDOW_MS;
            const speed = Math.hypot(this._coastDx, this._coastDy);
            if (!stale && speed > DAMPING_MIN_PX_PER_FRAME) {
                this._startCoast();
            } else {
                this._coastDx = 0;
                this._coastDy = 0;
            }
        } else {
            this._coastDx = 0;
            this._coastDy = 0;
        }
        // Drop the cached orbit pivot so the NEXT drag picks a fresh one
        // (next click → next raycast → new pivot). The current target stays
        // where the orbit left it — matching SolidWorks where the focal
        // point sticks to whatever you last orbited around.
        this._orbitPivotCached = false;
        this._dragAction = null;
        this._dragPointerId = null;
        this._dragShift = false;
        // Restore the host's cursor (or 'auto' if none was set).
        this.domElement.style.cursor = this._prevCursor || '';
        this._prevCursor = null;

        // Double-MMB tap (no drag both times) = Fit-All. Universal CAD
        // gesture — Fusion, Onshape, SW, CATIA all do it.
        if (ev.button === 1) {
            const moved = Math.hypot(
                ev.clientX - this._dragStart.x,
                ev.clientY - this._dragStart.y,
            );
            if (moved <= TAP_PIXEL_TOL) {
                const now = performance.now();
                const dt  = now - this._lastMmbTapAt;
                const dx  = ev.clientX - this._lastMmbTapPos.x;
                const dy  = ev.clientY - this._lastMmbTapPos.y;
                if (dt <= DOUBLE_TAP_MS && Math.hypot(dx, dy) <= TAP_PIXEL_TOL) {
                    this.dispatchEvent({ type: 'fit' });
                    this._lastMmbTapAt = 0;  // consume — third tap shouldn't re-fire
                } else {
                    this._lastMmbTapAt = now;
                    this._lastMmbTapPos.x = ev.clientX;
                    this._lastMmbTapPos.y = ev.clientY;
                }
            }
        }
        this.dispatchEvent({ type: 'end', action });
    }

    /**
     * Classify a wheel event as 'trackpad' or 'mouse'.
     *
     * Signature heuristics (no API exists for this):
     *   - deltaMode LINE/PAGE        → discrete mouse wheel (Firefox mice)
     *   - non-zero deltaX            → two-finger scroll (trackpad)
     *   - fractional deltaY          → trackpad (macOS momentum scrolling)
     *   - |deltaY| < 40 in pixel mode → almost always a trackpad
     * Ambiguous events (small integer deltas could be a hi-res mouse wheel)
     * reuse the last classification within WHEEL_DEVICE_STICKY_MS so a
     * gesture never flip-flops mid-stream.
     */
    _classifyWheel(ev) {
        const now = performance.now();
        let device = null;
        if (ev.deltaMode !== 0) device = 'mouse';
        else if (ev.deltaX !== 0) device = 'trackpad';
        else if (!Number.isInteger(ev.deltaY)) device = 'trackpad';
        else if (Math.abs(ev.deltaY) < 40) device = 'trackpad';
        else if (Math.abs(ev.deltaY) >= 100) device = 'mouse';
        if (device === null) {
            device = (now - this._wheelDeviceAt) < WHEEL_DEVICE_STICKY_MS
                ? (this._wheelDevice || 'mouse')
                : 'mouse';
        }
        this._wheelDevice = device;
        this._wheelDeviceAt = now;
        return device;
    }

    _handleWheel(ev) {
        if (!this.enabled) return;
        // Wheel = the user is driving; cancel any coast in progress.
        this._stopCoast();

        // ── Trackpad gestures ──────────────────────────────────────────────
        // Pinch (ctrl+wheel) always zooms — handled by the shared zoom path
        // below with a boosted step. Plain two-finger scroll orbits, and
        // Shift+scroll pans, when trackpad mode applies.
        const isPinch = ev.ctrlKey && ev.deltaMode === 0 && Math.abs(ev.deltaY) < 50;
        const isTrackpadScroll = !ev.ctrlKey
            && this.trackpadMode !== 'off'
            && (this.trackpadMode === 'on' || this._classifyWheel(ev) === 'trackpad');
        if (isTrackpadScroll) {
            ev.preventDefault();
            // Content-follows-fingers: scrolling right pulls the scene right,
            // i.e. behaves like dragging the model — hence the sign flip.
            if (ev.shiftKey) {
                if (!this.enablePan) return;
                // Browsers move deltaY into deltaX while Shift is held; take
                // whichever axis carries the motion.
                const dx = ev.deltaX !== 0 ? ev.deltaX : ev.deltaY;
                this.panBy(-dx * TRACKPAD_PAN_GAIN, -ev.deltaY * TRACKPAD_PAN_GAIN);
            } else {
                if (!this.enableRotate) {
                    // Sketch mode pins rotation — fall through to pan so the
                    // gesture still does something useful.
                    if (this.enablePan) {
                        this.panBy(-ev.deltaX * TRACKPAD_PAN_GAIN, -ev.deltaY * TRACKPAD_PAN_GAIN);
                    }
                    return;
                }
                this._applyOrbit(-ev.deltaX * TRACKPAD_ORBIT_GAIN, -ev.deltaY * TRACKPAD_ORBIT_GAIN);
                this._updateClipping();
                this.dispatchEvent({ type: 'change' });
            }
            return;
        }

        if (!this.enableZoom) return;
        ev.preventDefault();
        const ndc = this._eventNDC(ev);

        // Exponential dolly fraction. `factor < 1` zooms IN (camera moves
        // closer / ortho frustum shrinks); `factor > 1` zooms out.
        // deltaY is typically ±100 per mouse notch; trackpad pinch deltas
        // are far smaller, so they get a tighter divisor or pinching feels
        // glacial. Clamp to a sane multiplier either way.
        const dir = this.reverseZoom ? -1 : 1;
        const divisor = isPinch ? PINCH_ZOOM_DIVISOR : 100;
        const steps = Math.max(-5, Math.min(5, ev.deltaY / divisor)) * dir;
        const factor = Math.pow(1 - WHEEL_FACTOR * this.zoomSpeed, steps);

        // Resolve the world-space point the cursor is over. We prefer a real
        // ray-hit; if nothing hit, unproject at the current target depth so
        // ortho/perspective still get a sensible "point under the cursor".
        const cursorWorld = this._cursorWorldAtDepth(ndc);

        if (this.camera.isOrthographicCamera) {
            this._dollyOrthoToCursor(cursorWorld, factor);
        } else {
            this._dollyPerspectiveToCursor(cursorWorld, factor);
        }
        this._updateClipping();
        this.dispatchEvent({ type: 'change' });
    }

    /**
     * Unproject the cursor's NDC at the depth of the current target (or the
     * ray-hit point if there is one). For perspective, "depth" is the
     * distance from the camera; for ortho, the plane normal is the camera
     * direction and we just intersect.
     */
    _cursorWorldAtDepth(ndc) {
        const hit = this._hitWorld(ndc);
        if (hit) return hit;
        // Unproject at the depth of `controls.target`. We build a plane
        // through the target whose normal is the camera-forward axis; the
        // cursor ray's intersection with that plane is "the cursor at
        // current depth".
        const camForward = _v.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
        const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(camForward, this.target);
        const ray = this._ndcRay(ndc);
        const out = new THREE.Vector3();
        if (ray.intersectPlane(plane, out)) return out;
        return this.target.clone();
    }

    /**
     * Perspective zoom-to-cursor.
     *
     * Move the camera along (cursor - camera) by `(1 - factor)` of that
     * distance — when factor < 1, camera moves toward the cursor; when
     * factor > 1, it moves away. Shift the target by the same vector so
     * subsequent orbits keep the camera-target distance constant and the
     * focal point glued to where the user was zooming.
     */
    _dollyPerspectiveToCursor(cursorWorld, factor) {
        // Vector from camera to cursor point in world.
        const camToCursor = _v.copy(cursorWorld).sub(this.camera.position);
        // Shift = (1 - factor) * camToCursor. factor=0.9 (zoom in) → shift
        // 0.1 of the way toward cursor; factor=1.1 (zoom out) → shift -0.1.
        const shift = camToCursor.multiplyScalar(1 - factor);
        // Distance clamp: don't overshoot or get too close to the target.
        const tentativeDist = this.camera.position.clone().add(shift).distanceTo(this.target.clone().add(shift));
        if (tentativeDist < this.minDistance || tentativeDist > this.maxDistance) {
            // Re-scale shift so the resulting distance lands on the clamp.
            const curDist = this.camera.position.distanceTo(this.target);
            const want = this._clampDistance(curDist * factor);
            if (Math.abs(want - curDist) < 1e-6) return;
            // Fall back to a target-centred dolly when zoom-to-cursor would
            // bust the clamps.
            this._dolly(want / curDist);
            return;
        }
        this.camera.position.add(shift);
        this.target.add(shift);
    }

    /**
     * Ortho zoom-to-cursor.
     *
     * Two effects must happen together:
     *   1. The frustum shrinks/grows (camera.zoom *= 1/factor).
     *   2. The target slides toward the cursor so that the world point under
     *      the cursor BEFORE the zoom is still under it AFTER. The camera
     *      itself slides too, so the view direction is preserved.
     *
     * Algebra: let s = 1/factor be the new zoom multiplier. For a point p
     * in screen space (NDC) to map back to the same world point, the new
     * target T' must satisfy:
     *     p_world_new = T' + (p_screen_offset / new_zoom)
     *   =  T  + (p_screen_offset / old_zoom)
     * Solving:  T' = p_world  - (p_world - T) * factor
     *         = T  + (p_world - T) * (1 - factor)
     */
    _dollyOrthoToCursor(cursorWorld, factor) {
        if (factor <= 0) return;
        const newZoom = this.camera.zoom / factor;
        // Clamp ortho zoom to a sane band so users can't end up with a
        // pinhole or a flatlined frustum.
        if (newZoom < 1e-3 || newZoom > 1e6) return;
        const shift = _v.copy(cursorWorld).sub(this.target).multiplyScalar(1 - factor);
        this.target.add(shift);
        this.camera.position.add(shift);
        this.camera.zoom = newZoom;
        this.camera.updateProjectionMatrix();
    }

    // ── Math helpers ───────────────────────────────────────────────────────

    _ndcRay(ndc) {
        const ray = new THREE.Ray();
        ray.origin.setFromMatrixPosition(this.camera.matrixWorld);
        ray.direction.set(ndc.x, ndc.y, 0.5).unproject(this.camera).sub(ray.origin).normalize();
        return ray;
    }

    _applyOrbit(dx, dy) {
        // Honour Invert-Y by flipping the vertical drag sign at the single
        // entry point shared by both orbit modes. Cheaper than threading the
        // flag into every math helper.
        if (this.invertOrbitY) dy = -dy;
        // Free trackball orbit when Shift is held at drag-start: rotate
        // around the camera's local axes regardless of world-up. CAD users
        // sometimes need this to flip horizon-locked views upside-down or
        // to spin the part along its silhouette.
        if (!this.horizonLock || this._dragShift) {
            this._applyTrackballOrbit(dx, dy);
            return;
        }
        this._applyHorizonLockedOrbit(dx, dy);
    }

    /**
     * Horizon-locked (constrained) orbit — world-up stays up.
     *
     * Yaw is a rotation around `worldUp` through the target (any horizontal
     * mouse motion). Pitch is a rotation around the camera's right axis
     * (vertical mouse motion), clamped so we never cross the world-up poles.
     */
    _applyHorizonLockedOrbit(dx, dy) {
        const up = this.worldUp;
        const offset = _v.copy(this.camera.position).sub(this.target);

        // Yaw: rotate around worldUp.
        const yaw = -dx * this.orbitSpeed;
        offset.applyAxisAngle(up, yaw);

        // Pitch axis = camera-right = (offset × up). For the rotation to be
        // stable as we approach the poles we work out the current latitude
        // (angle off the equator), then clamp the rotation so we never
        // cross ±HORIZON_PITCH_LIMIT.
        const offLen = offset.length() || 1;
        const horiz = _v2.copy(offset).addScaledVector(up, -offset.dot(up));
        const horizLen = horiz.length();
        // If the camera is already exactly at a pole, pick an arbitrary
        // right axis to break the singularity.
        let right;
        if (horizLen < 1e-6) {
            right = _v3.set(1, 0, 0);
            if (Math.abs(up.dot(right)) > 0.9) right.set(0, 1, 0);
            right.crossVectors(right, up).normalize();
        } else {
            right = _v3.copy(horiz).cross(up).normalize();
        }
        // Current latitude in [-pi/2, +pi/2]: asin(offset·up / |offset|).
        const sinLat = THREE.MathUtils.clamp(offset.dot(up) / offLen, -1, 1);
        const lat    = Math.asin(sinLat);
        const desiredDelta = -dy * this.orbitSpeed;
        const newLat = THREE.MathUtils.clamp(
            lat + desiredDelta,
            -HORIZON_PITCH_LIMIT,
             HORIZON_PITCH_LIMIT,
        );
        const pitchDelta = newLat - lat;
        if (Math.abs(pitchDelta) > 1e-9) {
            offset.applyAxisAngle(right, pitchDelta);
        }

        this.camera.position.copy(this.target).add(offset);
        // Snap the camera's up vector to world-up so re-aiming via lookAt
        // doesn't roll the horizon by accident.
        this.camera.up.copy(up);
        this.camera.lookAt(this.target);
    }

    /** Free trackball orbit — the original behaviour, kept for Shift-drag. */
    _applyTrackballOrbit(dx, dy) {
        // Convert camera offset to spherical around `target` using current up.
        const offset = _v.copy(this.camera.position).sub(this.target);
        // Express in a frame where camera.up is +Y so polar/azimuth feel right.
        const quat = _q.setFromUnitVectors(this.camera.up, new THREE.Vector3(0, 1, 0));
        const quatInv = quat.clone().invert();
        offset.applyQuaternion(quat);
        _spherical.setFromVector3(offset);

        _spherical.theta -= dx * this.orbitSpeed;
        _spherical.phi   -= dy * this.orbitSpeed;
        // Clamp phi so we never flip world-up (slight epsilon at the poles
        // keeps the up vector well-defined).
        _spherical.phi = Math.max(POLAR_EPS, Math.min(Math.PI - POLAR_EPS, _spherical.phi));
        _spherical.makeSafe();

        offset.setFromSpherical(_spherical);
        offset.applyQuaternion(quatInv);

        this.camera.position.copy(this.target).add(offset);
        this.camera.lookAt(this.target);
    }

    _applyPanCursorGlued(ev) {
        // Re-cast through the cursor onto the pan plane; translate camera +
        // target so the originally-grabbed world point sits under the cursor.
        const ndc = this._eventNDC(ev);
        const ray = this._ndcRay(ndc);
        const hitPlane = _v.set(0, 0, 0);
        if (!ray.intersectPlane(this._panPlane, hitPlane)) return;
        const delta = _v2.copy(this._panStartWorld).sub(hitPlane).multiplyScalar(this.panSpeed);
        this.camera.position.add(delta);
        this.target.add(delta);
    }

    _dolly(factor) {
        const offset = _v.copy(this.camera.position).sub(this.target);
        const newLen = this._clampDistance(offset.length() * factor);
        offset.setLength(newLen);
        this.camera.position.copy(this.target).add(offset);
    }

    _clampDistance(d) {
        return Math.max(this.minDistance, Math.min(this.maxDistance, d));
    }

    /**
     * Recompute the camera's near/far so the visible depth range tracks
     * the current viewing distance. Called after every drag, wheel, and
     * programmatic camera change.
     *
     *   near = max(0.01, dist * 0.001)        — 0.1 % of dist for precision
     *   far  = max(dist * 100,                — generic fallback
     *              dist + sceneRadius * 4)    — guarantees scene is visible
     *
     * Ortho cameras don't use near/far the same way; we still update them
     * so clipping planes don't strand a deep scene out of view.
     */
    _updateClipping() {
        if (!this.autoClip) return;
        const cam = this.camera;
        if (!cam || !cam.isCamera) return;
        const dist = cam.position.distanceTo(this.target) || 1;
        const radius = this._sceneRadiusProvider
            ? (this._sceneRadiusProvider() || 0)
            : 0;
        const near = Math.max(0.01, dist * 0.001);
        const far  = Math.max(dist * 100, dist + radius * 4, 1000);
        if (cam.near !== near || cam.far !== far) {
            cam.near = near;
            cam.far  = far;
            cam.updateProjectionMatrix();
        }
    }
}

/**
 * Build a default pick-provider backed by a Three.js scene. Hands a single
 * raycaster a list of pickable objects; returns the closest hit or null.
 * The host can swap a fancier one later (e.g. body-only, ignoring overlays).
 *
 * @param {THREE.Camera} camera
 * @param {() => THREE.Object3D[]} pickablesProvider
 */
export function makeScenePickProvider(camera, pickablesProvider) {
    const raycaster = new THREE.Raycaster();
    return function pickAt(ndc) {
        const items = pickablesProvider();
        if (!items || items.length === 0) return null;
        raycaster.setFromCamera({ x: ndc.x, y: ndc.y }, camera);
        const hits = raycaster.intersectObjects(items, true);
        if (!hits || hits.length === 0) return null;
        return { point: hits[0].point.clone(), object: hits[0].object };
    };
}
