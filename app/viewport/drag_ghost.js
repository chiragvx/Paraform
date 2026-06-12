/**
 * DragGhost — translucent placement preview that follows the cursor while
 * the user drags a library part into the viewport.
 *
 *   const ghost = new DragGhost({ scene });
 *   ghost.setPart(partRecord);              // builds the wireframe + fill
 *   ghost.setPose({ position, rotation });  // each pointermove
 *   ghost.setSnapping(true|false);          // recolor when a snap target is hit
 *   ghost.hide();                           // on drag-leave / drop
 *   ghost.dispose();                        // on viewport teardown
 *
 * Visual: a wire-edge `BoxGeometry` sized to the part's authored
 * `boundingBox` (max - min), plus a faint translucent fill so the volume
 * reads at a glance. The wireframe is `depthTest: false` so the ghost
 * stays visible even when it overlaps existing bodies. When a compatible
 * snap target is in range, the wireframe brightens green so the user
 * knows "drop here and it mates."
 *
 * Z-up correct: the bbox uses the part's own min/max from the JSON
 * record, which is authored in part-local mm (same convention as the
 * connectors). The ghost is parented at scene identity, so position
 * comes in world mm directly — no GLB-wrap multiplication.
 */

import * as THREE from 'three';

const FREE_COLOR  = 0x66ccff;   // soft cyan — neutral preview
const SNAP_COLOR  = 0x6bff8a;   // bright green — matches connector-overlay hit
const FILL_OPACITY = 0.18;
const EDGE_OPACITY = 0.95;

export class DragGhost {
    /**
     * @param {object} args
     * @param {THREE.Scene} args.scene  — the viewport's Z-up scene root.
     */
    constructor({ scene }) {
        if (!scene) throw new Error('DragGhost: scene required');
        this.scene = scene;

        this.root = new THREE.Group();
        this.root.name = '__pf4_drag_ghost__';
        this.root.visible = false;
        this.root.renderOrder = 997;     // under connector overlay (998) and gizmo (999)
        scene.add(this.root);

        // Lazily-built mesh + outline. Created/replaced in setPart.
        this._fillMesh = null;
        this._edgeMesh = null;
        this._snapping = false;
        this._currentPartId = null;

        // Cached material refs so setSnapping can recolor without rebuild.
        this._edgeMat = null;
        this._fillMat = null;
    }

    /**
     * Rebuild ghost geometry for `part`. Re-using the same DragGhost across
     * multiple drag sessions: setting a different part disposes the previous
     * meshes. Setting the same part again is a no-op (cheap).
     *
     * @param {object} part — a PartRecord from src/lib/library/parts/*.json
     */
    setPart(part) {
        if (!part || !part.id) return;
        if (this._currentPartId === part.id) return;
        this._disposeMeshes();
        this._currentPartId = part.id;

        const bb = part.boundingBox || null;
        const min = (bb && Array.isArray(bb.min)) ? bb.min : [-5, -5, 0];
        const max = (bb && Array.isArray(bb.max)) ? bb.max : [ 5,  5, 10];
        const sx = Math.max(0.1, max[0] - min[0]);
        const sy = Math.max(0.1, max[1] - min[1]);
        const sz = Math.max(0.1, max[2] - min[2]);
        // Box centre in part-local coords.
        const cx = (min[0] + max[0]) * 0.5;
        const cy = (min[1] + max[1]) * 0.5;
        const cz = (min[2] + max[2]) * 0.5;

        const fillGeom = new THREE.BoxGeometry(sx, sy, sz);
        // Translate so the bbox-min sits at the part's authored origin —
        // bbox min Z = 0 means the part rests on z=0 of its local frame
        // (matches the Align.MIN convention from CLAUDE.md).
        fillGeom.translate(cx, cy, cz);

        const fillMat = new THREE.MeshBasicMaterial({
            color: FREE_COLOR,
            transparent: true,
            opacity: FILL_OPACITY,
            depthWrite: false,
            side: THREE.DoubleSide,
        });
        const fillMesh = new THREE.Mesh(fillGeom, fillMat);
        fillMesh.renderOrder = 997;
        this._fillMesh = fillMesh;
        this._fillMat = fillMat;
        this.root.add(fillMesh);

        const edgeGeom = new THREE.EdgesGeometry(fillGeom);
        const edgeMat = new THREE.LineBasicMaterial({
            color: FREE_COLOR,
            transparent: true,
            opacity: EDGE_OPACITY,
            depthTest: false,
            linewidth: 1,
        });
        const edgeMesh = new THREE.LineSegments(edgeGeom, edgeMat);
        edgeMesh.renderOrder = 998;
        this._edgeMesh = edgeMesh;
        this._edgeMat = edgeMat;
        this.root.add(edgeMesh);

        this.setSnapping(false);
    }

    /**
     * Position + orient the ghost in world space. `rotation` is Euler XYZ
     * radians (matches the mate solver's output and the document Component
     * origin convention).
     */
    setPose({ position = [0, 0, 0], rotation = [0, 0, 0] } = {}) {
        this.root.position.set(position[0], position[1], position[2]);
        this.root.rotation.set(rotation[0], rotation[1], rotation[2]);
        this.root.visible = true;
        this.root.updateMatrixWorld(true);
    }

    /** Light up green when a compatible snap target is in range. */
    setSnapping(b) {
        const want = !!b;
        if (this._snapping === want) return;
        this._snapping = want;
        const color = want ? SNAP_COLOR : FREE_COLOR;
        try { this._edgeMat?.color?.setHex(color); } catch {}
        try { this._fillMat?.color?.setHex(color); } catch {}
        // Slight opacity bump when snapping so the lock-on is unmistakable.
        if (this._fillMat) this._fillMat.opacity = want ? 0.26 : FILL_OPACITY;
    }
    isSnapping() { return this._snapping; }

    hide() { this.root.visible = false; }

    dispose() {
        try { this.scene.remove(this.root); } catch {}
        this._disposeMeshes();
        this._currentPartId = null;
    }

    _disposeMeshes() {
        for (const child of this.root.children.slice()) {
            this.root.remove(child);
            try { child.geometry?.dispose?.(); } catch {}
            try {
                if (Array.isArray(child.material)) {
                    for (const m of child.material) m?.dispose?.();
                } else {
                    child.material?.dispose?.();
                }
            } catch {}
        }
        this._fillMesh = null;
        this._edgeMesh = null;
        this._edgeMat = null;
        this._fillMat = null;
    }
}

// ── Cursor → world projection helper ─────────────────────────────────────

/**
 * Project a screen-space cursor onto the world XY ground plane (Z=0).
 * Used as the fallback target when no snap connector is hit during a
 * library drag. Returns `[x, y, 0]` or null when the cursor ray is
 * parallel to the ground plane.
 *
 * Shared with `snap_drag.js`'s rail-slide projection but specialised
 * for a horizontal plane.
 *
 * @param {{clientX:number, clientY:number}} ev
 * @param {{ camera: THREE.Camera, renderer: THREE.WebGLRenderer }} ctx
 * @returns {[number, number, number] | null}
 */
export function cursorOnGroundPlane(ev, { camera, renderer }) {
    if (!ev || !camera || !renderer) return null;
    const rect = renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
        ((ev.clientX - rect.left) / rect.width)  * 2 - 1,
        -((ev.clientY - rect.top)  / rect.height) * 2 + 1,
    );
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, camera);
    // Z-up scene: ground plane normal is +Z, passing through origin.
    const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
    const hit = new THREE.Vector3();
    if (!ray.ray.intersectPlane(plane, hit)) return null;
    return [hit.x, hit.y, hit.z];
}
