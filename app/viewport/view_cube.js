/**
 * ViewCube — top-right HUD widget for instant view changes.
 *
 * Rendered as a second Three.js scene drawn over the main viewport via the
 * renderer's autoClear=false pass. A small OrthographicCamera frames a
 * unit cube; the cube's quaternion mirrors the main camera so the cube
 * always reflects the current view direction.
 *
 * Interactive zones:
 *   - 6 faces      → tween to ortho normal  (front / back / left / right / top / bottom)
 *   - 12 edges     → tween to 45° between two faces (top-front, top-right, …)
 *   - 8 corners    → tween to the nearest isometric
 *   - "House"      → reset to home view
 *
 * Hover rendering: the picked face highlights to ACCENT colour with a thin
 * outline. Click → delegate to the host's `onCommand(name)` callback.
 *
 * Implementation notes:
 *   • The widget owns its own scene + camera + lights, but shares the
 *     host renderer. Render order: host scene first, then cube overlay
 *     with `clearDepth(); render(cubeScene, cubeCam)`.
 *   • Hit-testing uses an OrthographicCamera so screen-space picking is
 *     trivially decoupled from the main perspective camera.
 *   • Sized at 110 px by default; positioned with CSS-style top/right
 *     inset because the renderer's domElement is full-bleed.
 */

import * as THREE from 'three';

// Autodesk Fusion / Inventor-style ViewCube palette.
// Light off-white faces, dark text, brand-orange hover.
const FACE_IDLE_FILL = '#e8ebef';
const FACE_HOVER_FILL = '#ff8c28';
const FACE_RIM        = '#b8c0c9';
const FACE_TEXT_IDLE  = '#222831';
const FACE_TEXT_HOVER = '#ffffff';
const EDGE_LINE       = 0xb8c0c9;

// Widget renders inside a 170px host (set by ViewCubeMount). The cube itself
// uses the inner ~60% of that — the rim is reserved for orbit arrows and
// the embedded triad / home button.
const SIZE_PX = 170;
const PAD_PX  = 12;

/** Label glyphs printed on the 6 faces — title case to match Fusion. */
const FACE_LABELS = {
    top:    'Top',
    bottom: 'Bottom',
    front:  'Front',
    back:   'Back',
    left:   'Left',
    right:  'Right',
};

/**
 * Build a CanvasTexture for one face label.
 */
function makeFaceLabelTexture(label, hovered, renderer = null) {
    const SIZE = 512;
    const canvas = document.createElement('canvas');
    canvas.width = SIZE; canvas.height = SIZE;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = hovered ? FACE_HOVER_FILL : FACE_IDLE_FILL;
    ctx.fillRect(0, 0, SIZE, SIZE);
    // Inner rim — soft gray hairline (Inventor style).
    ctx.strokeStyle = FACE_RIM;
    ctx.lineWidth = 6;
    ctx.strokeRect(8, 8, SIZE - 16, SIZE - 16);
    ctx.fillStyle = hovered ? FACE_TEXT_HOVER : FACE_TEXT_IDLE;
    ctx.font = '800 128px "Inter", "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, SIZE / 2, SIZE / 2);
    const tex = new THREE.CanvasTexture(canvas);
    try {
        tex.anisotropy = renderer
            ? renderer.capabilities.getMaxAnisotropy()
            : 8;
    } catch { tex.anisotropy = 8; }
    tex.needsUpdate = true;
    return tex;
}

/** Edge and corner zone descriptors — each gets a small box hit-test mesh
 *  plus a direction vector for tweening. */
const EDGE_ZONES = [
    // top edges (4)
    { name: 'top-front',  dir: [ 0,  1,  1], pos: [ 0,  0.78,  0.78], size: [1.0, 0.18, 0.18] },
    { name: 'top-back',   dir: [ 0, -1,  1], pos: [ 0, -0.78,  0.78], size: [1.0, 0.18, 0.18] },
    { name: 'top-right',  dir: [ 1,  0,  1], pos: [ 0.78,  0,  0.78], size: [0.18, 1.0, 0.18] },
    { name: 'top-left',   dir: [-1,  0,  1], pos: [-0.78,  0,  0.78], size: [0.18, 1.0, 0.18] },
    // bottom edges (4)
    { name: 'bottom-front',  dir: [ 0,  1, -1], pos: [ 0,  0.78, -0.78], size: [1.0, 0.18, 0.18] },
    { name: 'bottom-back',   dir: [ 0, -1, -1], pos: [ 0, -0.78, -0.78], size: [1.0, 0.18, 0.18] },
    { name: 'bottom-right',  dir: [ 1,  0, -1], pos: [ 0.78,  0, -0.78], size: [0.18, 1.0, 0.18] },
    { name: 'bottom-left',   dir: [-1,  0, -1], pos: [-0.78,  0, -0.78], size: [0.18, 1.0, 0.18] },
    // vertical edges (4)
    { name: 'front-right',  dir: [ 1,  1,  0], pos: [ 0.78,  0.78, 0], size: [0.18, 0.18, 1.0] },
    { name: 'front-left',   dir: [-1,  1,  0], pos: [-0.78,  0.78, 0], size: [0.18, 0.18, 1.0] },
    { name: 'back-right',   dir: [ 1, -1,  0], pos: [ 0.78, -0.78, 0], size: [0.18, 0.18, 1.0] },
    { name: 'back-left',    dir: [-1, -1,  0], pos: [-0.78, -0.78, 0], size: [0.18, 0.18, 1.0] },
];

const CORNER_ZONES = [
    { name: 'top-front-right',    dir: [ 1,  1,  1], pos: [ 0.78,  0.78,  0.78] },
    { name: 'top-front-left',     dir: [-1,  1,  1], pos: [-0.78,  0.78,  0.78] },
    { name: 'top-back-right',     dir: [ 1, -1,  1], pos: [ 0.78, -0.78,  0.78] },
    { name: 'top-back-left',      dir: [-1, -1,  1], pos: [-0.78, -0.78,  0.78] },
    { name: 'bottom-front-right', dir: [ 1,  1, -1], pos: [ 0.78,  0.78, -0.78] },
    { name: 'bottom-front-left',  dir: [-1,  1, -1], pos: [-0.78,  0.78, -0.78] },
    { name: 'bottom-back-right',  dir: [ 1, -1, -1], pos: [ 0.78, -0.78, -0.78] },
    { name: 'bottom-back-left',   dir: [-1, -1, -1], pos: [-0.78, -0.78, -0.78] },
];

// Drag-to-orbit + free-look tuning.
const DRAG_START_PX     = 3;     // movement beyond this turns a press into an orbit drag
const CUBE_DOUBLE_TAP_MS = 350;  // two taps within this latch free-look mode
const CLICK_DEFER_MS    = 280;   // single-tap command delay so a double-tap can cancel it
const FREELOOK_GAIN     = 2.5;   // px multiplier — the widget is small, so amplify

export class ViewCube {
    /**
     * @param {object}                args
     * @param {THREE.WebGLRenderer}   args.renderer    — shared with the host viewport
     * @param {THREE.Camera}          args.mainCamera  — to mirror its orientation
     * @param {(name:string)=>void}   args.onCommand   — fires when user clicks a cell
     * @param {(dx:number,dy:number)=>void} [args.onOrbit] — fires per pointer move
     *        while the user drags the cube (or steers in free-look mode), with
     *        screen-pixel deltas. Wire it to the camera controls' `orbitBy` to
     *        get Fusion-style "drag the cube to rotate the view". Optional —
     *        without it the cube is click-only (legacy behaviour).
     */
    constructor({ renderer, mainCamera, onCommand, onOrbit = null }) {
        if (!renderer || !mainCamera) throw new Error('ViewCube: missing renderer or mainCamera');
        this.renderer   = renderer;
        this.mainCamera = mainCamera;
        this.onCommand  = typeof onCommand === 'function' ? onCommand : () => {};
        this.onOrbit    = typeof onOrbit === 'function' ? onOrbit : null;

        this.scene = new THREE.Scene();
        // Z-up ortho camera. Position is recomputed each frame to mirror the
        // main camera's direction (see render()) so the cube view tracks the
        // main view. Initial position is iso so the first paint isn't blank.
        const r = 1.4;
        this.camera = new THREE.OrthographicCamera(-r, r, r, -r, 0.1, 100);
        this.camera.up.set(0, 0, 1);
        this.camera.position.set(5, -5, 5);
        this.camera.lookAt(0, 0, 0);

        // The cube group stays at identity. The widget camera moves around
        // the cube; the cube itself is "the world" so its face labels are
        // fixed in world-aligned positions (TOP at world +Z, etc.).
        this.group = new THREE.Group();
        this.scene.add(this.group);

        // Soft ambient so the cube isn't pitch-black on any view.
        this.scene.add(new THREE.AmbientLight(0xffffff, 0.85));
        const dir = new THREE.DirectionalLight(0xffffff, 0.6);
        dir.position.set(2, 2, 3);
        this.scene.add(dir);

        // ── Build the cube faces ──────────────────────────────────────────
        this._faceMeshes = {};
        this._materials  = {};
        const geom = new THREE.PlaneGeometry(1.6, 1.6);
        for (const face of ['front', 'back', 'right', 'left', 'top', 'bottom']) {
            const texIdle = makeFaceLabelTexture(FACE_LABELS[face], false, renderer);
            const texHov  = makeFaceLabelTexture(FACE_LABELS[face], true, renderer);
            const mat = new THREE.MeshBasicMaterial({ map: texIdle, side: THREE.DoubleSide });
            const mesh = new THREE.Mesh(geom, mat);
            mesh.userData = { command: face, kind: 'face', texIdle, texHov };
            this._orientFace(mesh, face);
            this.group.add(mesh);
            this._faceMeshes[face] = mesh;
            this._materials[face]  = mat;
        }

        // Cube outline frame for visual structure.
        const frame = new THREE.LineSegments(
            new THREE.EdgesGeometry(new THREE.BoxGeometry(1.6, 1.6, 1.6)),
            new THREE.LineBasicMaterial({ color: EDGE_LINE, transparent: true, opacity: 0.85 }),
        );
        this.group.add(frame);

        // ── Edge zones (12) ───────────────────────────────────────────────
        this._zoneMeshes = [];
        const zoneIdleMat  = () => new THREE.MeshBasicMaterial({
            color: 0x36404a, transparent: true, opacity: 0.0,
        });
        for (const e of EDGE_ZONES) {
            const m = new THREE.Mesh(
                new THREE.BoxGeometry(e.size[0], e.size[1], e.size[2]),
                zoneIdleMat(),
            );
            m.position.set(e.pos[0], e.pos[1], e.pos[2]);
            m.userData = { kind: 'edge', name: e.name, dir: e.dir, command: `edge:${e.name}` };
            this.group.add(m);
            this._zoneMeshes.push(m);
        }
        // ── Corner zones (8) ──────────────────────────────────────────────
        for (const c of CORNER_ZONES) {
            const m = new THREE.Mesh(
                new THREE.BoxGeometry(0.18, 0.18, 0.18),
                zoneIdleMat(),
            );
            m.position.set(c.pos[0], c.pos[1], c.pos[2]);
            m.userData = { kind: 'corner', name: c.name, dir: c.dir, command: `corner:${c.name}` };
            this.group.add(m);
            this._zoneMeshes.push(m);
        }

        // ── DOM container — positioned by host (ViewCubeMount). The cube
        // occupies the INNER region of the widget; orbit arrows + triad +
        // home menu live in the host around it. We size to 100% so the
        // Svelte host can decide the bounding rect.
        this.container = document.createElement('div');
        this.container.className = 'pf-viewcube';
        Object.assign(this.container.style, {
            position: 'absolute',
            inset:    '20%',           // inner 60% of the host = cube zone
            zIndex:   '5',
            cursor:   'pointer',
            pointerEvents: 'auto',
        });

        this._raycaster = new THREE.Raycaster();
        this._lastHover = null;

        // ── Drag-to-orbit + double-tap free-look state ─────────────────────
        // A press that moves > DRAG_START_PX becomes an orbit drag (the cube
        // is the controller, like Fusion / Onshape). A clean single tap still
        // fires the view command — but deferred CLICK_DEFER_MS so a second
        // tap can cancel it and latch FREE-LOOK instead: the pointer steers
        // the camera with no button held until the user taps again or hits
        // Esc. The latch is what makes trackpad orbiting comfortable.
        this._pressed = false;
        this._pressPointerId = null;
        this._dragging = false;
        this._pressPos = { x: 0, y: 0 };
        this._movePrev = { x: 0, y: 0 };
        this._lastTapAt = 0;
        this._pendingClickTimer = 0;
        this.freeLook = false;

        this._onMove   = (e) => this._handleMove(e);
        this._onLeave  = ()  => this._setHover(null);
        this._onDown   = (e) => this._handleDown(e);
        this._onUp     = (e) => this._handleUp(e);
        this._onCancel = ()  => { this._pressed = false; this._dragging = false; };
        this._onKey    = (e) => {
            if (e.key === 'Escape' && this.freeLook) this._setFreeLook(false);
        };

        this.container.addEventListener('pointermove',  this._onMove);
        this.container.addEventListener('pointerleave', this._onLeave);
        this.container.addEventListener('pointerdown',  this._onDown);
        this.container.addEventListener('pointerup',    this._onUp);
        this.container.addEventListener('pointercancel', this._onCancel);
        window.addEventListener('keydown', this._onKey);
    }

    /** Look up the direction vector for an edge/corner command name.
     *  Returns [x,y,z] or null. */
    directionFor(command) {
        if (!command) return null;
        for (const m of (this._zoneMeshes || [])) {
            if (m.userData.command === command) return m.userData.dir;
        }
        // Face fallback (commands like 'front', 'top') → look up by view
        // name. Returns world-frame directions (Z-up) that match the
        // standardView table in lib/viewport/view_animator.js.
        const face = this._faceMeshes[command];
        if (face) {
            const FACE_DIR = {
                front:  [ 0,  1,  0],
                back:   [ 0, -1,  0],
                left:   [-1,  0,  0],
                right:  [ 1,  0,  0],
                top:    [ 0,  0,  1],
                bottom: [ 0,  0, -1],
            };
            return FACE_DIR[command] || null;
        }
        return null;
    }

    /** Mount into the viewport container (must be position:relative). */
    mount(parent) {
        if (!parent) throw new Error('ViewCube.mount: missing parent');
        parent.appendChild(this.container);
    }

    /** Detach + free GL resources. */
    dispose() {
        if (this._pendingClickTimer) clearTimeout(this._pendingClickTimer);
        this.container.removeEventListener('pointermove',  this._onMove);
        this.container.removeEventListener('pointerleave', this._onLeave);
        this.container.removeEventListener('pointerdown',  this._onDown);
        this.container.removeEventListener('pointerup',    this._onUp);
        this.container.removeEventListener('pointercancel', this._onCancel);
        window.removeEventListener('keydown', this._onKey);
        if (this.container.parentNode) this.container.parentNode.removeChild(this.container);
        for (const m of Object.values(this._materials)) {
            if (m.map) m.map.dispose();
            m.dispose();
        }
        for (const f of Object.values(this._faceMeshes)) {
            if (f.userData.texIdle) f.userData.texIdle.dispose();
            if (f.userData.texHov)  f.userData.texHov.dispose();
            f.geometry.dispose();
        }
    }

    /** Call from the host render loop AFTER the main scene render. */
    render() {
        // Track the main camera's DIRECTION (unit position vector) so the
        // widget shows the cube from the same angle the main camera looks at
        // the model. Cube itself stays at identity — its face labels live in
        // world-axis positions (TOP at +Z, FRONT at +Y, RIGHT at +X).
        const mainPos = new THREE.Vector3();
        this.mainCamera.getWorldPosition(mainPos);
        if (mainPos.lengthSq() > 1e-6) mainPos.normalize().multiplyScalar(5);
        else                            mainPos.set(5, -5, 5);
        this.camera.position.copy(mainPos);
        // Inherit the main camera's up-vector so the widget orientation stays
        // glued to the main view (Z-up everywhere unless the user explicitly
        // changed it).
        this.camera.up.copy(this.mainCamera.up);
        this.camera.lookAt(0, 0, 0);

        const rect = this.container.getBoundingClientRect();
        const parentRect = this.renderer.domElement.getBoundingClientRect();
        const x = rect.left - parentRect.left;
        const y = parentRect.height - (rect.top - parentRect.top) - rect.height;
        const sz = rect.width;

        const prev = new THREE.Vector4();
        this.renderer.getViewport(prev);
        const prevScissor = this.renderer.getScissorTest();
        const prevAutoClear = this.renderer.autoClear;
        this.renderer.setScissorTest(true);
        this.renderer.setViewport(x, y, sz, sz);
        this.renderer.setScissor(x, y, sz, sz);
        // CRITICAL: disable autoClear before rendering the cube — otherwise
        // three.js clears the scissored region to the renderer's dark
        // clear-color (default black), painting an opaque rectangle behind
        // the cube. We manually clearDepth() instead so the cube still draws
        // over the main scene's geometry; the gradient/IBL background behind
        // the cube area remains visible.
        this.renderer.autoClear = false;
        this.renderer.clearDepth();
        this.renderer.render(this.scene, this.camera);
        this.renderer.autoClear = prevAutoClear;
        this.renderer.setViewport(prev);
        this.renderer.setScissorTest(prevScissor);
    }

    // ── Internals ──────────────────────────────────────────────────────────

    _orientFace(mesh, face) {
        // Z-up convention. PlaneGeometry's default normal is +Z (local) and
        // label-top is local +Y. For each face we need:
        //   normal → world axis pointing OUT of the cube
        //   label-top → world +Z for the four side faces (FRONT/BACK/LEFT/RIGHT)
        //   TOP: label-top points toward FRONT (+Y), BOTTOM: toward BACK (-Y)
        // Three.js Euler order 'XYZ' applies Rz first, then Ry, then Rx.
        // The compound (Rx·Ry·Rz) below is derived per-face so the label
        // reads upright when viewed from outside.
        const P = Math.PI;
        switch (face) {
            case 'top':    mesh.position.set( 0,  0,  0.81); mesh.rotation.set(0, 0, 0); break;
            case 'bottom': mesh.position.set( 0,  0, -0.81); mesh.rotation.set(P, 0, 0); break;
            case 'front':  mesh.position.set( 0,  0.81, 0);  mesh.rotation.set(-P/2, 0, P); break;
            case 'back':   mesh.position.set( 0, -0.81, 0);  mesh.rotation.set( P/2, 0, 0); break;
            case 'right':  mesh.position.set( 0.81, 0, 0);   mesh.rotation.set(0,  P/2,  P/2); break;
            case 'left':   mesh.position.set(-0.81, 0, 0);   mesh.rotation.set(0, -P/2,  P/2); break;
        }
    }

    _eventNDC(ev) {
        const rect = this.container.getBoundingClientRect();
        return {
            x:  ((ev.clientX - rect.left) / rect.width)  * 2 - 1,
            y: -((ev.clientY - rect.top)  / rect.height) * 2 + 1,
        };
    }

    _hitTest(ev) {
        const ndc = this._eventNDC(ev);
        this._raycaster.setFromCamera({ x: ndc.x, y: ndc.y }, this.camera);
        // Prefer edge/corner zones (they protrude slightly past the face plane);
        // fall back to the six faces when no zone hit.
        const zoneHits = this._raycaster.intersectObjects(this._zoneMeshes, false);
        if (zoneHits && zoneHits.length) return zoneHits[0].object;
        const faceHits = this._raycaster.intersectObjects(Object.values(this._faceMeshes), false);
        if (faceHits && faceHits.length) return faceHits[0].object;
        return null;
    }

    _handleMove(ev) {
        // Free-look: the pointer steers the camera, no button needed.
        if (this.freeLook && !this._pressed && this.onOrbit) {
            const dx = ev.clientX - this._movePrev.x;
            const dy = ev.clientY - this._movePrev.y;
            this._movePrev.x = ev.clientX;
            this._movePrev.y = ev.clientY;
            if (dx || dy) this.onOrbit(dx * FREELOOK_GAIN, dy * FREELOOK_GAIN);
            return;
        }
        // Press-drag: orbit while the button is down.
        if (this._pressed && this.onOrbit) {
            const dx = ev.clientX - this._movePrev.x;
            const dy = ev.clientY - this._movePrev.y;
            if (!this._dragging) {
                const moved = Math.hypot(ev.clientX - this._pressPos.x, ev.clientY - this._pressPos.y);
                if (moved > DRAG_START_PX) {
                    this._dragging = true;
                    this._setHover(null);
                    this.container.style.cursor = 'grabbing';
                }
            }
            if (this._dragging) {
                this._movePrev.x = ev.clientX;
                this._movePrev.y = ev.clientY;
                if (dx || dy) this.onOrbit(dx * FREELOOK_GAIN, dy * FREELOOK_GAIN);
                return;
            }
        }
        const obj = this._hitTest(ev);
        this._setHover(obj);
    }

    _handleDown(ev) {
        if (ev.button !== 0) return;
        this._pressed = true;
        this._pressPointerId = ev.pointerId;
        this._dragging = false;
        this._pressPos.x = ev.clientX;
        this._pressPos.y = ev.clientY;
        this._movePrev.x = ev.clientX;
        this._movePrev.y = ev.clientY;
        try { this.container.setPointerCapture(ev.pointerId); } catch {}
        ev.preventDefault();
        ev.stopPropagation();
    }

    _handleUp(ev) {
        if (!this._pressed || ev.pointerId !== this._pressPointerId) return;
        try { this.container.releasePointerCapture(ev.pointerId); } catch {}
        this._pressed = false;
        this._pressPointerId = null;
        const wasDrag = this._dragging;
        this._dragging = false;
        this.container.style.cursor = this.freeLook ? 'move' : 'pointer';
        if (wasDrag) { this._lastTapAt = 0; return; }   // drag ≠ tap

        ev.stopPropagation();
        const now = performance.now();
        const isDoubleTap = (now - this._lastTapAt) <= CUBE_DOUBLE_TAP_MS;
        this._lastTapAt = isDoubleTap ? 0 : now;

        if (isDoubleTap && this.onOrbit) {
            // Double-tap toggles free-look; cancel the deferred single-tap
            // command so the view doesn't snap first.
            if (this._pendingClickTimer) {
                clearTimeout(this._pendingClickTimer);
                this._pendingClickTimer = 0;
            }
            this._setFreeLook(!this.freeLook);
            this._movePrev.x = ev.clientX;
            this._movePrev.y = ev.clientY;
            return;
        }
        if (this.freeLook) {
            // Any single tap while latched exits the mode (no view command).
            this._setFreeLook(false);
            return;
        }
        // Single tap → view command, deferred so a second tap can cancel it.
        // Hit-test NOW (cursor position is only valid at tap time).
        const obj = this._hitTest(ev);
        if (!obj) return;
        const command = obj.userData.command;
        if (this._pendingClickTimer) clearTimeout(this._pendingClickTimer);
        this._pendingClickTimer = setTimeout(() => {
            this._pendingClickTimer = 0;
            this.onCommand(command);
        }, this.onOrbit ? CLICK_DEFER_MS : 0);
    }

    /** Toggle the double-tap "cube steers the camera" latch + its visuals. */
    _setFreeLook(on) {
        this.freeLook = !!on;
        if (on) {
            this.container.style.cursor = 'move';
            this.container.style.outline = '2px solid #ff8c28';
            this.container.style.outlineOffset = '2px';
            this.container.style.borderRadius = '8px';
            this._setHover(null);
        } else {
            this.container.style.cursor = 'pointer';
            this.container.style.outline = '';
            this.container.style.outlineOffset = '';
            this.container.style.borderRadius = '';
        }
    }

    _setHover(obj) {
        if (this._lastHover === obj) return;
        // Restore previous
        if (this._lastHover) {
            const ud = this._lastHover.userData;
            const m  = this._lastHover.material;
            if (ud.kind === 'face') { m.map = ud.texIdle; m.needsUpdate = true; }
            else { m.opacity = 0.0; m.color.setHex(0x36404a); }
        }
        if (obj) {
            const ud = obj.userData;
            const m  = obj.material;
            if (ud.kind === 'face') { m.map = ud.texHov; m.needsUpdate = true; }
            else { m.opacity = 0.55; m.color.setHex(0xff8c28); }
        }
        this._lastHover = obj;
        this.container.style.cursor = obj ? 'pointer' : 'default';
    }

}
