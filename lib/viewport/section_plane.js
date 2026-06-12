/**
 * SectionPlane — Fusion-style "Section Analysis" clipping plane with a
 * visible gizmo, TransformControls handles, optional back-side cap, and
 * face-alignment helper.
 *
 * Z-up correct: default normal is **+Z** (world up). All math is in world
 * coordinates; this module never reasons about a Y-up frame.
 *
 *   const section = new SectionPlane({
 *       scene,                  // THREE.Scene — the visible gizmo lives here
 *       camera,                 // THREE.Camera — for TransformControls
 *       renderer,               // THREE.WebGLRenderer — drives clipping
 *       cameraControls,         // CADCameraControls — disabled during drag
 *       bodyRoot: () => bridge.bodyTransform,  // for the back-side cap
 *       onChange: () => requestRender?.(),
 *   });
 *
 *   section.setEnabled(true);
 *   section.flipNormal();
 *   section.alignToFace({ point:[x,y,z], normal:[nx,ny,nz] });
 *   section.setOffset(12);                   // along the current normal
 *   section.reset();
 *   section.dispose();
 *
 * The actual `THREE.Plane` is exposed as `section.plane` (read-only); the
 * caller is responsible for pushing it onto `renderer.clippingPlanes`
 * once at setup time. We do NOT mutate `renderer.clippingPlanes` from
 * here so that multiple clip sources (future capability) can co-exist.
 */

import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';

const GIZMO_SIZE = 120; // mm — visible quad edge length

/** Build the visible plane gizmo (translucent quad + outline + arrow). */
function buildGizmo() {
    const group = new THREE.Group();
    group.name = '__pf4_section_gizmo__';
    group.renderOrder = 5;

    // Translucent quad. The gizmo is built in its own local frame with
    // its normal = +Z; the group is then rotated to match the world
    // plane's normal.
    const quadGeom = new THREE.PlaneGeometry(GIZMO_SIZE, GIZMO_SIZE);
    const quadMat = new THREE.MeshBasicMaterial({
        color: 0x4f7cff,
        transparent: true,
        opacity: 0.12,
        side: THREE.DoubleSide,
        depthWrite: false,
        depthTest: false,
    });
    const quad = new THREE.Mesh(quadGeom, quadMat);
    quad.renderOrder = 5;
    group.add(quad);

    // Outline (line loop) so the plane is legible even at grazing angles.
    const half = GIZMO_SIZE / 2;
    const outlinePts = [
        new THREE.Vector3(-half, -half, 0),
        new THREE.Vector3( half, -half, 0),
        new THREE.Vector3( half,  half, 0),
        new THREE.Vector3(-half,  half, 0),
        new THREE.Vector3(-half, -half, 0),
    ];
    const outlineGeom = new THREE.BufferGeometry().setFromPoints(outlinePts);
    const outlineMat = new THREE.LineBasicMaterial({
        color: 0x4f7cff,
        transparent: true,
        opacity: 0.9,
        depthTest: false,
    });
    const outline = new THREE.Line(outlineGeom, outlineMat);
    outline.renderOrder = 6;
    group.add(outline);

    // Flip arrow — a short cone pointing in +Z (the plane's local normal).
    const arrowGeom = new THREE.ConeGeometry(6, 18, 12);
    const arrowMat = new THREE.MeshBasicMaterial({
        color: 0x4f7cff,
        transparent: true,
        opacity: 0.85,
        depthTest: false,
    });
    const arrow = new THREE.Mesh(arrowGeom, arrowMat);
    // ConeGeometry has its tip on +Y by default; rotate so the tip points
    // along the group's +Z (the plane normal).
    arrow.rotation.x = Math.PI / 2;
    arrow.position.z = 10;
    arrow.renderOrder = 6;
    group.add(arrow);

    return { group, quad, outline, arrow, quadMat, outlineMat, arrowMat };
}

export class SectionPlane {
    /**
     * @param {object}              args
     * @param {THREE.Scene}         args.scene
     * @param {THREE.Camera}        args.camera
     * @param {THREE.WebGLRenderer} args.renderer
     * @param {object}              [args.cameraControls]
     * @param {() => THREE.Object3D|null} [args.bodyRoot]
     * @param {() => void}          [args.onChange]
     * @param {[number,number,number]} [args.initialNormal] default [0,0,1]
     * @param {number}              [args.initialOffset]    default 0
     */
    constructor({
        scene, camera, renderer,
        cameraControls = null,
        bodyRoot = null,
        onChange = null,
        initialNormal = [0, 0, 1],
        initialOffset = 0,
    }) {
        if (!scene || !camera || !renderer) {
            throw new Error('SectionPlane: scene/camera/renderer required');
        }
        this.scene = scene;
        this.camera = camera;
        this.renderer = renderer;
        this.cameraControls = cameraControls || null;
        this.bodyRoot = typeof bodyRoot === 'function' ? bodyRoot : (() => null);
        this.onChange = typeof onChange === 'function' ? onChange : null;

        // ── Plane equation ─────────────────────────────────────────────
        // THREE.Plane stores (normal, constant) with the convention
        //   normal · x + constant = 0
        // Points with `normal · x + constant > 0` are kept; the rest are
        // clipped. To clip "everything above the offset along +normal" we
        // store the offset as a signed distance from the origin along the
        // current normal.
        const n0 = new THREE.Vector3(...initialNormal).normalize();
        this.plane = new THREE.Plane(n0.clone(), -initialOffset);
        this._normal = n0.clone();
        this._offset = initialOffset;

        // ── Visible gizmo ──────────────────────────────────────────────
        const built = buildGizmo();
        this._gizmoParts = built;
        this.gizmoGroup = built.group;
        this.gizmoGroup.visible = false;
        scene.add(this.gizmoGroup);

        // ── TransformControls (translate + rotate) ─────────────────────
        // The proxy is a bare Object3D whose position+quaternion encode the
        // plane's pose; we read it on every change and push the result
        // back into `this.plane`.
        this._proxy = new THREE.Object3D();
        this._proxy.name = '__pf4_section_proxy__';
        this._syncProxyFromPlane();
        scene.add(this._proxy);

        this._tc = new TransformControls(camera, renderer.domElement);
        this._tc.size = 0.9;
        this._tc.space = 'local'; // handles follow the plane's frame
        this._tc.attach(this._proxy);
        // TransformControls in modern three is a Group; add the root, not
        // the control itself (which throws in r170+).
        const tcRoot = (typeof this._tc.getHelper === 'function')
            ? this._tc.getHelper()
            : this._tc;
        this._tcRoot = tcRoot;
        scene.add(tcRoot);

        this._tc.addEventListener('change', () => this._syncPlaneFromProxy());
        this._tc.addEventListener('dragging-changed', (ev) => {
            if (this.cameraControls && 'enabled' in this.cameraControls) {
                this.cameraControls.enabled = !ev.value;
            }
        });

        // ── Back-side cap ──────────────────────────────────────────────
        // True solid-looking cut surface: a parallel `THREE.Group` shadows
        // the bodyRoot meshes with BackSide-clones of their materials,
        // clipped by the OPPOSITE plane. The opposite-clipped back faces
        // visually plug the hole the front-clipped solid leaves behind, so
        // a sectioned cylinder looks like a real solid cylinder (not a
        // hollow shell with a blue quad inside).
        //
        // We also keep a small blue outline quad as a fallback affordance
        // when there's no bodyRoot — useful in tests / early-init.
        this._oppPlane = new THREE.Plane(this._normal.clone().negate(), this._offset);
        this._capGroup = new THREE.Group();
        this._capGroup.name = '__pf4_section_cap_group__';
        this._capGroup.renderOrder = 4;
        scene.add(this._capGroup);
        this._capGroup.visible = false;
        // Map source mesh → mirrored back-cap mesh so we can patch in
        // place across re-renders without dropping the GPU buffer.
        /** @type {Map<THREE.Mesh, THREE.Mesh>} */
        this._capMirror = new Map();

        // Fallback flat quad — only used when bodyRoot is unresolvable.
        const capGeom = new THREE.PlaneGeometry(GIZMO_SIZE * 8, GIZMO_SIZE * 8);
        const capMat = new THREE.MeshBasicMaterial({
            color: 0x2a3140,
            side: THREE.DoubleSide,
            transparent: false,
            depthWrite: true,
        });
        this._capMat = capMat;
        this._cap = new THREE.Mesh(capGeom, capMat);
        this._cap.name = '__pf4_section_cap_fallback__';
        this._cap.renderOrder = 4;
        scene.add(this._cap);
        this._cap.visible = false;

        this._enabled = false;
        this.setEnabled(false);
        this._syncTransformsFromPlane();
    }

    // ── Public API ─────────────────────────────────────────────────────

    /** Toggle the clip + the visible gizmo + the cap. */
    setEnabled(on) {
        this._enabled = !!on;
        this.gizmoGroup.visible = this._enabled;
        // Real cap (back-side mirror of the body, clipped by the opposite plane).
        this._capGroup.visible = this._enabled;
        // Fallback flat quad — only shown if we can't build the real cap.
        const haveBodies = this._capGroup.children.length > 0;
        this._cap.visible = this._enabled && !haveBodies;
        if (this._enabled) this.refreshCap();
        // Show/hide the TransformControls helper.
        if (this._tcRoot) this._tcRoot.visible = this._enabled;
        this._tc.enabled = this._enabled;
        this._notify();
    }

    /**
     * Rebuild the back-side cap from the current bodyRoot. Cheap to call on
     * every kernel re-render or selection change — meshes that already have
     * a mirror reuse it; stale mirrors are pruned.
     *
     * Cap meshes share geometry with the source mesh (zero-copy) but use a
     * cloned material with `side = BackSide` and `clippingPlanes = [opp]`
     * so the *inside* of the body is what we see on the cut side, plugging
     * what would otherwise be a hollow hole.
     */
    refreshCap() {
        const root = this.bodyRoot();
        if (!root) {
            // Fall back to flat quad.
            this._cap.visible = this._enabled;
            return;
        }
        const seen = new Set();
        const oppPlane = this._oppPlane;
        root.traverse((node) => {
            if (!node.isMesh) return;
            // Skip our own helpers / overlays — anything tagged.
            if (node.userData?.__pf4_section_cap_mirror__) return;
            if (node.userData?.__pf4_edge_overlay__) return;
            if (node.userData?.__pf4_hidden_edges__) return;
            if (node.userData?.__pf4_technical_edges__) return;
            seen.add(node);
            let mirror = this._capMirror.get(node);
            if (!mirror) {
                const matSrc = Array.isArray(node.material) ? node.material[0] : node.material;
                if (!matSrc || !matSrc.clone) return;
                // Back-side clone, same material — clipped by the SAME
                // global section plane as the body. Where the body's front
                // face is cut away, the back face shows through and reads
                // as the body's actual interior surface (solid-looking).
                const matClone = matSrc.clone();
                matClone.side = THREE.BackSide;
                // Subtle darkening so the cut surface reads as "inside"
                // rather than the polished outer skin.
                if ('color' in matClone && matClone.color?.multiplyScalar) {
                    matClone.color = matClone.color.clone().multiplyScalar(0.75);
                }
                matClone.needsUpdate = true;
                mirror = new THREE.Mesh(node.geometry, matClone);
                mirror.userData.__pf4_section_cap_mirror__ = true;
                mirror.renderOrder = 4;
                this._capGroup.add(mirror);
                this._capMirror.set(node, mirror);
            }
            // Match the source mesh's world transform; the cap group is at
            // scene identity so we copy world matrix decomposition.
            node.updateMatrixWorld?.(true);
            mirror.matrixAutoUpdate = false;
            mirror.matrix.copy(node.matrixWorld);
            mirror.matrixWorldNeedsUpdate = true;
            mirror.visible = node.visible !== false;
        });
        // Prune mirrors whose source mesh disappeared.
        for (const [src, mirror] of [...this._capMirror.entries()]) {
            if (!seen.has(src)) {
                this._capGroup.remove(mirror);
                try { mirror.material?.dispose?.(); } catch {}
                this._capMirror.delete(src);
            }
        }
        // Whenever real cap children exist, hide the fallback quad.
        const haveBodies = this._capGroup.children.length > 0;
        this._cap.visible = this._enabled && !haveBodies;
    }

    isEnabled() { return this._enabled; }

    /** Flip the plane's normal in-place. Offset is preserved relative to
     *  the new normal so the cut surface stays on the same world plane. */
    flipNormal() {
        // The world plane stays put; we just swap which side gets clipped.
        // With normal n and signed offset o: plane.normal=n, plane.constant=-o.
        // After flipping: n' = -n, signed offset along n' is -o, so
        // plane.normal=-n, plane.constant = -(-o) = o.
        this._normal.multiplyScalar(-1);
        this._offset = -this._offset;
        this.plane.normal.copy(this._normal);
        this.plane.constant = -this._offset;
        this._syncTransformsFromPlane();
        this._notify();
    }

    /** Reset to default: +Z normal, offset 0. */
    reset() {
        this._normal.set(0, 0, 1);
        this._offset = 0;
        this.plane.normal.copy(this._normal);
        this.plane.constant = 0;
        this._syncTransformsFromPlane();
        this._notify();
    }

    /** Slide along the current normal. `v` is a signed mm offset from origin. */
    setOffset(v) {
        if (!Number.isFinite(v)) return;
        this._offset = v;
        this.plane.constant = -v;
        this._syncTransformsFromPlane();
        this._notify();
    }

    getOffset() { return this._offset; }

    /** Align the plane to a face: place at `point`, normal = `normal`. */
    alignToFace({ point, normal }) {
        if (!Array.isArray(point) || !Array.isArray(normal)) return false;
        const n = new THREE.Vector3(normal[0], normal[1], normal[2]);
        if (n.lengthSq() < 1e-12) return false;
        n.normalize();
        const p = new THREE.Vector3(point[0], point[1], point[2]);
        // The signed distance from origin to the plane through `p` with
        // normal `n` is `n · p`.
        const offset = n.dot(p);
        this._normal.copy(n);
        this._offset = offset;
        this.plane.normal.copy(n);
        this.plane.constant = -offset;
        this._syncTransformsFromPlane();
        this._notify();
        return true;
    }

    /** Set the TransformControls mode: 'translate' | 'rotate'. */
    setMode(mode) {
        if (mode !== 'translate' && mode !== 'rotate') return;
        this._tc.setMode(mode);
    }

    /** Replace the camera-controls handle (e.g. after `upgradeViewport`). */
    setCameraControls(cc) { this.cameraControls = cc || null; }

    dispose() {
        try { this._tc.detach(); } catch {}
        try { this._tc.dispose(); } catch {}
        try { this.scene.remove(this._tcRoot); } catch {}
        try { this.scene.remove(this._proxy); } catch {}
        try { this.scene.remove(this.gizmoGroup); } catch {}
        try { this.scene.remove(this._cap); } catch {}
        try {
            for (const m of this._capMirror.values()) {
                try { m.material?.dispose?.(); } catch {}
            }
            this._capMirror.clear();
            this.scene.remove(this._capGroup);
        } catch {}
        for (const m of [this._gizmoParts.quadMat, this._gizmoParts.outlineMat, this._gizmoParts.arrowMat, this._capMat]) {
            try { m.dispose(); } catch {}
        }
        this.gizmoGroup.traverse?.((o) => { try { o.geometry?.dispose?.(); } catch {} });
        try { this._cap.geometry?.dispose?.(); } catch {}
    }

    // ── Internals ──────────────────────────────────────────────────────

    /** Push (normal, offset) → proxy.position/quaternion + gizmo + cap. */
    _syncTransformsFromPlane() {
        // The proxy's +Z axis points along the plane normal; its position
        // sits on the plane at the closest point to the world origin
        // (offset · normal).
        const n = this._normal.clone().normalize();
        const pos = n.clone().multiplyScalar(this._offset);
        const q = new THREE.Quaternion().setFromUnitVectors(
            new THREE.Vector3(0, 0, 1), n,
        );
        this._proxy.position.copy(pos);
        this._proxy.quaternion.copy(q);
        this._proxy.updateMatrixWorld(true);

        this.gizmoGroup.position.copy(pos);
        this.gizmoGroup.quaternion.copy(q);
        this.gizmoGroup.updateMatrixWorld(true);

        // Cap sits sub-mm behind the plane so the body's front face wins
        // the depth test wherever it pokes through. The fallback `_cap`
        // mesh is created later in the ctor, so this method is also called
        // before it exists (via `_syncProxyFromPlane` at line 152). Guard
        // against that pre-init call — the values it would have written
        // get applied when `_syncTransformsFromPlane` is invoked again at
        // the end of the ctor (line 212).
        if (this._cap) {
            const capBias = 0.05;
            this._cap.position.copy(pos.clone().sub(n.clone().multiplyScalar(capBias)));
            this._cap.quaternion.copy(q);
            this._cap.updateMatrixWorld(true);
        }

        this._syncOppPlane();
        if (this._enabled) this.refreshCap();
    }

    _syncProxyFromPlane() { this._syncTransformsFromPlane(); }

    /** Keep the opposite-side clip plane (used by the back-cap material)
     *  in sync with the section plane: opposite normal, opposite constant. */
    _syncOppPlane() {
        if (!this._oppPlane) return;
        this._oppPlane.normal.copy(this._normal).negate();
        this._oppPlane.constant = this._offset;
    }

    /** Read proxy pose back into (normal, offset, plane). Called on every
     *  TransformControls 'change' event. */
    _syncPlaneFromProxy() {
        const n = new THREE.Vector3(0, 0, 1)
            .applyQuaternion(this._proxy.quaternion)
            .normalize();
        const offset = n.dot(this._proxy.position);
        this._normal.copy(n);
        this._offset = offset;
        this.plane.normal.copy(n);
        this.plane.constant = -offset;

        // Keep the gizmo + cap glued to the proxy (TransformControls only
        // moves the proxy directly).
        this.gizmoGroup.position.copy(this._proxy.position);
        this.gizmoGroup.quaternion.copy(this._proxy.quaternion);
        this._cap.position.copy(this._proxy.position.clone().sub(n.clone().multiplyScalar(0.05)));
        this._cap.quaternion.copy(this._proxy.quaternion);

        this._syncOppPlane();
        if (this._enabled) this.refreshCap();
        this._notify();
    }

    _notify() { if (this.onChange) try { this.onChange(); } catch {} }
}
