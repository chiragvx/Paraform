/**
 * PickingOverlay — Three.js visualisation for face picking.
 *
 * Mounts a dedicated Group into the viewport scene. The group holds:
 *
 *   - One **hover marker** (single mesh) — repositioned each pointer-move.
 *     Hidden when no face is under the cursor. Disc-shaped so it reads as
 *     "face under cursor" rather than a vertex / edge marker.
 *
 *   - A **selection halo group** — one disc per selected face. Cleared and
 *     rebuilt whenever the selection set changes (still a small list — up to
 *     ~tens of faces in practical use).
 *
 * Both shapes are billboarded along the face normal in local space so the
 * marker always lies flat against the face it's annotating. The overlay
 * group's transform matches the bridge's body-group wrapper so the local-
 * frame centers from the kernel topology map directly to world position.
 *
 * The overlay never mutates the underlying body meshes — it's pure overlay.
 */

import * as THREE from 'three';

const OVERLAY_GROUP_NAME = '__pf4_picking_overlay__';

const HOVER_COLOR     = 0xff8c28;   // CATIA orange — matches body hover tint
const SELECTION_COLOR = 0x3f8dff;   // blue — matches body selected tint
const HALO_OPACITY    = 0.72;
const HALO_RADIUS_MM  = 4;          // disc radius for face picks
const HALO_SEGMENTS   = 32;
const NORMAL_OFFSET   = 0.2;        // mm; lifts the marker just above the surface to avoid z-fighting
const EDGE_BAR_LENGTH_MM = 18;      // length of the tangent-aligned bar for edge hovers
const EDGE_BAR_RADIUS_MM = 0.6;     // radius — thicker than a line so it reads on any face colour

export class PickingOverlay {
    /**
     * @param {object}        opts
     * @param {THREE.Scene}   opts.scene        — viewport scene the overlay attaches to
     * @param {THREE.Object3D}[opts.bodyGroup]  — bridge's body-group wrapper, used to copy
     *                                            scale + rotation so kernel-local centers
     *                                            map to the right world position
     */
    constructor({ scene, bodyGroup = null } = {}) {
        if (!scene) throw new Error('PickingOverlay: missing scene');
        this.scene     = scene;
        this.bodyGroup = bodyGroup;

        this.group = new THREE.Group();
        this.group.name = OVERLAY_GROUP_NAME;
        this.group.renderOrder = 1000;
        // The picker returns face centres in world coords (the bridge's wrap
        // brings the GLB into the same mm/Z-up frame the kernel topology
        // uses, so they coincide). Our overlay group stays at identity in
        // the scene — markers are placed directly at world positions.

        // Two hover markers: a disc for face picks and a tangent-aligned
        // bar for edge picks. updateHover() shows one or the other based on
        // whether the pick carries a normal or a tangent.
        this._hoverMesh     = this._makeMarker(HOVER_COLOR);
        this._hoverMesh.visible = false;
        this.group.add(this._hoverMesh);
        this._hoverEdgeMesh = this._makeEdgeBar(HOVER_COLOR);
        this._hoverEdgeMesh.visible = false;
        this.group.add(this._hoverEdgeMesh);

        this._selectionGroup = new THREE.Group();
        this._selectionGroup.name = '__pf4_picking_selection__';
        this.group.add(this._selectionGroup);

        scene.add(this.group);
    }

    /**
     * Kept on the API so callers don't need to know the overlay no longer
     * inherits the body's transform. Stores the reference for any future
     * code that needs it but doesn't change the overlay group.
     */
    syncFromBodyGroup(bodyGroup = this.bodyGroup) {
        this.bodyGroup = bodyGroup;
    }

    /**
     * Move the hover marker onto the picked face. Pass `null` to hide it.
     *
     * @param {{ center: number[], normal: number[] } | null} pickResult
     */
    updateHover(pickResult) {
        if (!pickResult) {
            this._hoverMesh.visible = false;
            this._hoverEdgeMesh.visible = false;
            return;
        }
        // Faces are handled by the body-conforming highlight layer in the
        // orchestrator (the entire body tints under the cursor — matches
        // Fusion / SolidWorks). The disc marker would just float redundantly
        // on top, so it stays hidden for face picks.
        // Edges still get a tangent-aligned bar because a hovered edge is
        // otherwise indistinguishable from a hovered body face.
        this._hoverMesh.visible = false;
        if (pickResult.tangent) {
            // Anchor the bar at the cursor's actual world-hit point when
            // available — for circular edges the picker's `center` is the
            // arc centroid (often well off the visible edge), whereas
            // `worldHit` is exactly where the cursor sits.
            const anchor = pickResult.worldHit || pickResult.center;
            this._placeEdgeBar(this._hoverEdgeMesh, anchor, pickResult.tangent);
            this._hoverEdgeMesh.visible = true;
        } else {
            this._hoverEdgeMesh.visible = false;
        }
    }

    /**
     * Replace the entire selection-halo set. Each entry needs at least a
     * `payload` carrying `center` and `normal` (the picker's output payload
     * shape). Entries without a payload are skipped (they were added before
     * the topology emitted the face).
     *
     * @param {Array<{ payload: { center?: number[], normal?: number[] } } | { center?: number[], normal?: number[] }>} entries
     */
    updateSelection(entries) {
        this._clearGroup(this._selectionGroup);
        if (!Array.isArray(entries) || entries.length === 0) return;
        // Faces are handled by the body-conforming highlight layer — the
        // whole picked body tints blue and the silhouette stays clean. So
        // we only render selection halos for EDGE picks here, where a body
        // tint alone would leave the user wondering which edge was chosen.
        for (const entry of entries) {
            const payload = entry && entry.payload ? entry.payload : entry;
            if (!payload || !payload.tangent) continue;
            const anchor = payload.worldHit || payload.center;
            if (!anchor) continue;
            const bar = this._makeEdgeBar(SELECTION_COLOR);
            this._placeEdgeBar(bar, anchor, payload.tangent);
            this._selectionGroup.add(bar);
        }
    }

    /** Detach + dispose every owned resource. */
    dispose() {
        this._clearGroup(this._selectionGroup);
        this._disposeMesh(this._hoverMesh);
        this._disposeMesh(this._hoverEdgeMesh);
        this._hoverMesh = null;
        this._hoverEdgeMesh = null;
        if (this.group.parent) this.group.parent.remove(this.group);
        this.scene = null;
        this.bodyGroup = null;
    }

    // ── Internals ───────────────────────────────────────────────────────────

    _makeMarker(color) {
        // Filled disc — the body of the highlight.
        const geom = new THREE.CircleGeometry(HALO_RADIUS_MM, HALO_SEGMENTS);
        const mat  = new THREE.MeshBasicMaterial({
            color,
            transparent: true,
            opacity:     HALO_OPACITY,
            side:        THREE.DoubleSide,
            depthTest:   false,
            depthWrite:  false,
        });
        const mesh = new THREE.Mesh(geom, mat);
        mesh.renderOrder = 1001;

        // Outline ring — sits on the rim of the disc, opaque, same colour.
        // Makes the marker pop on light AND dark surfaces. CircleGeometry's
        // first vertex is the centre; positions 1..N+1 trace the rim, so
        // drop the centre and use the rim positions as a LineLoop.
        const rimPositions = new Float32Array((HALO_SEGMENTS + 1) * 3);
        for (let i = 0; i <= HALO_SEGMENTS; i++) {
            const a = (i / HALO_SEGMENTS) * Math.PI * 2;
            rimPositions[i * 3]     = Math.cos(a) * HALO_RADIUS_MM;
            rimPositions[i * 3 + 1] = Math.sin(a) * HALO_RADIUS_MM;
            rimPositions[i * 3 + 2] = 0;
        }
        const rimGeom = new THREE.BufferGeometry();
        rimGeom.setAttribute('position', new THREE.BufferAttribute(rimPositions, 3));
        const rimMat  = new THREE.LineBasicMaterial({ color, depthTest: false, linewidth: 2 });
        const rim     = new THREE.LineLoop(rimGeom, rimMat);
        rim.renderOrder = 1002;
        mesh.add(rim);
        return mesh;
    }

    _makeEdgeBar(color) {
        // A cylinder along its local +Y axis. Length 1, radius EDGE_BAR_RADIUS_MM.
        // We scale Y per-edge in _placeEdgeBar so we can reuse one geometry.
        const geom = new THREE.CylinderGeometry(
            EDGE_BAR_RADIUS_MM, EDGE_BAR_RADIUS_MM, 1, 12, 1, false,
        );
        const mat  = new THREE.MeshBasicMaterial({
            color,
            transparent: true,
            opacity: 0.92,
            depthTest: false,    // render on top of the edge line
            depthWrite: false,
        });
        const mesh = new THREE.Mesh(geom, mat);
        mesh.renderOrder = 1001;
        mesh.raycast = () => {};     // pure overlay; do not interfere with picking
        return mesh;
    }

    _placeEdgeBar(mesh, center, tangent) {
        if (!center) return;
        const cx = center[0] ?? 0;
        const cy = center[1] ?? 0;
        const cz = center[2] ?? 0;
        const tx = (tangent && tangent[0]) || 1;
        const ty = (tangent && tangent[1]) || 0;
        const tz = (tangent && tangent[2]) || 0;
        const t = new THREE.Vector3(tx, ty, tz);
        const len = t.length();
        if (len < 1e-9) t.set(1, 0, 0); else t.divideScalar(len);
        // Cylinder defaults to local +Y. Rotate so +Y aligns with the tangent.
        const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), t);
        mesh.quaternion.copy(q);
        mesh.position.set(cx, cy, cz);
        mesh.scale.set(1, EDGE_BAR_LENGTH_MM, 1);
    }

    _placeMarker(mesh, center, normal) {
        if (!center) return;
        const cx = center[0] ?? 0;
        const cy = center[1] ?? 0;
        const cz = center[2] ?? 0;
        const nx = (normal && normal[0]) || 0;
        const ny = (normal && normal[1]) || 0;
        const nz = (normal && normal[2]) || 1;
        // CircleGeometry sits in the XY plane facing +Z. Re-orient so its
        // normal points along the face normal.
        const targetNormal = new THREE.Vector3(nx, ny, nz);
        const len = targetNormal.length();
        if (len < 1e-9) targetNormal.set(0, 0, 1); else targetNormal.divideScalar(len);
        const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), targetNormal);
        mesh.quaternion.copy(q);
        mesh.position.set(
            cx + targetNormal.x * NORMAL_OFFSET,
            cy + targetNormal.y * NORMAL_OFFSET,
            cz + targetNormal.z * NORMAL_OFFSET,
        );
    }

    _clearGroup(group) {
        while (group.children.length) {
            const child = group.children.pop();
            this._disposeMesh(child);
        }
    }

    _disposeMesh(mesh) {
        if (!mesh) return;
        if (mesh.geometry && mesh.geometry.dispose) mesh.geometry.dispose();
        if (mesh.material && mesh.material.dispose) mesh.material.dispose();
    }
}
