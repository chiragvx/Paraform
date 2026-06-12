/**
 * SnapDragController — drives the "drag a placed component until one of its
 * connectors snaps to a compatible connector on another component" UX.
 *
 * Architecture:
 *
 *   1. We hook the existing `TransformGizmo` (don't replace it) — that gives
 *      us 'translate' / 'rotate' / 'scale' modes for free and lets the user
 *      drag without snap when they want. Snap only kicks in during a
 *      translate drag.
 *   2. On drag start we identify the *dragged component* (walk parents of
 *      the attached Object3D for `userData.componentId`) and gather its
 *      `connectors[]` from `doc.connectors` (filtered by `parent ===
 *      componentId`). We also tell the overlay to hide the dragged
 *      component's own connectors so we never self-snap.
 *   3. Each frame during the drag we raycast the cursor against
 *      `overlay.pickables`. The closest hit is a candidate *host
 *      connector*. We check `connectorsCompatible(host, anyPartConnector)`
 *      for each of the dragged component's connectors; first compatible
 *      pair wins.
 *   4. We compute the solved transform via `solveMateTransform(host, part)`,
 *      then *override* the gizmo's chosen position with the solved one —
 *      so the body visually clamps onto the mate.
 *   5. On drag end, if a snap was active we commit the position:
 *        - `updateStandardPart(featureId, { transform: { position, rotation } })`
 *          for every StandardPart feature in the dragged component
 *          (the kernel re-bakes geometry at the new pose), and
 *        - `setComponentOrigin(componentId, { position, rotation })` so
 *          the component-tree view + bridge subgroup also know.
 *      If no snap landed, we still commit a `setComponentOrigin` so the
 *      visual mutation persists across kernel regen.
 *
 * Z-up: connector frames come back from `worldConnectorFor` in world coords;
 * the gizmo also reads world coords (its `space = 'world'`); the kernel-
 * baked feature transforms ARE world coords. One frame everywhere.
 *
 * Snap thresholds match `snap_indicators.js` so the sketch-snap and
 * assembly-snap feel consistent.
 */

import * as THREE from 'three';
import {
    connectorsCompatible, solveMateTransform, worldConnectorFor,
} from '../../src/lib/library/mate_solver.js';
import { deriveConnectorsFromGeometry } from '../../src/lib/snap/derive.js';
import { clamp, closestParamOnLine, normalize3 } from './snap_math.js';
import {
    composeMatrix, decomposePose, localForWorldPose,
    componentWorldFromObject, liveConnectorWorld,
} from './snap_frames.js';

const MAGNET_PX = 24;     // cursor-fallback magnet radius (px)
const SNAP_NODE_PX = 38;  // part-node→host-node magnet radius (px) — KSP-generous

export class SnapDragController {
    /**
     * @param {object} args
     * @param {object} args.transformGizmo   — TransformGizmo instance
     * @param {object} args.connectorOverlay — ConnectorOverlay instance
     * @param {THREE.Camera} args.camera
     * @param {THREE.WebGLRenderer} args.renderer
     * @param {() => object} args.docProvider — DocumentStore.doc getter
     * @param {(componentId: string, originPatch: object) => void} args.commitMove
     *     — writes the new placement (called once on drag-end). Lets the
     *     host decide whether to update StandardPart features, component
     *     origin, or both — keeps SnapDragController free of doc-op deps.
     * @param {() => void} [args.onChange]  — request a re-render
     */
    constructor({
        transformGizmo, connectorOverlay,
        camera, renderer, docProvider,
        commitMove, onChange = null,
        selection = null,
        bodyRoot = null,
        geometryProvider = null,
    }) {
        if (!transformGizmo || !connectorOverlay || !camera || !renderer
            || typeof docProvider !== 'function' || typeof commitMove !== 'function') {
            throw new Error('SnapDragController: missing required args');
        }
        this.gizmo = transformGizmo;
        this.overlay = connectorOverlay;
        this.camera = camera;
        this.renderer = renderer;
        this.docProvider = docProvider;
        this.commitMove = commitMove;
        this.onChange = onChange;
        this.selection = selection;
        this.bodyRoot = (typeof bodyRoot === 'function') ? bodyRoot : (() => null);
        this.geometryProvider = (typeof geometryProvider === 'function') ? geometryProvider : null;
        /** Cached derived connectors of every component except the dragged one,
         *  computed once on drag start. */
        this._derivedHostConnectors = [];
        // Raycaster + NDC are used by the slide-along-rail path to project
        // the cursor onto a rail axis once a rail snap is active. Kept on
        // the controller so we don't allocate per-tick.
        this._raycaster = new THREE.Raycaster();
        this._ndc = new THREE.Vector2();

        this._cursor = { clientX: 0, clientY: 0, valid: false };

        this._dragging = false;
        this._draggedComponentId = null;
        this._draggedConnectors = [];    // [{ connector, partRecord-style frame }]
        this._activeSnap = null;         // { hostConnectorId, hostWorld, partConnector, solved }
        this._attachedSnapshot = null;   // { position, quaternion } captured on drag start

        this._enabled = true;

        this._onMouseMove = (e) => this._onCursor(e);
        this._onDraggingChanged = (ev) => this._onDragging(ev);
        this._onObjectChange = () => this._onTick();

        renderer.domElement.addEventListener('pointermove', this._onMouseMove);

        // Tap into the existing gizmo's control events. We add our listeners
        // in addition to the gizmo's own — they don't conflict.
        const ctrl = transformGizmo._controls;
        ctrl.addEventListener('dragging-changed', this._onDraggingChanged);
        ctrl.addEventListener('objectChange',    this._onObjectChange);

        // Selection → attach. Walks the bridge's bodyTransform looking for
        // the `__v4_component_<id>__` subgroup that owns the selected
        // feature, and attaches the gizmo to it directly. Falls back to
        // detach when nothing is selectable. We own this logic instead of
        // the gizmo's own attach heuristic because the heuristic walks to
        // `__v4_glb_wrap__` and ends up moving the whole body tree at once.
        this._unsubSelection = null;
        if (selection && typeof selection.subscribe === 'function') {
            this._unsubSelection = selection.subscribe(() => this._refreshAttachment());
            this._refreshAttachment();
        }
    }

    /** Public: re-resolve the gizmo attachment from the current selection.
     *  Call after a drop's geometry lands so the move gizmo grabs the freshly
     *  placed component's subgroup (which doesn't exist until the kernel
     *  render). The constructor only re-runs this on selection change, not on
     *  bridge render, so the host pokes it explicitly post-drop. */
    refreshAttachment() { this._refreshAttachment(); }

    _refreshAttachment() {
        if (!this.selection) return;
        const root = this.bodyRoot();
        if (!root) { this.gizmo.detach(); return; }
        const entries = this.selection.toArray();
        if (entries.length === 0) { this.gizmo.detach(); return; }
        // Pull the featureIds from selection entries; resolve each to its
        // owning componentId via doc.features; map each componentId to its
        // subgroup in the bodyTransform tree.
        const doc = this.docProvider();
        const features = (doc && doc.features) || {};
        const wantedComponentIds = new Set();
        for (const e of entries) {
            const d = e && e.descriptor;
            const fid = d && (d.featureId || d.feature);
            if (!fid) continue;
            const f = features[fid];
            const cid = (f && f.componentId) || null;
            if (cid && cid !== 'root') wantedComponentIds.add(cid);
        }
        if (wantedComponentIds.size === 0) { this.gizmo.detach(); return; }

        let target = null;
        root.traverse?.((node) => {
            if (target) return;
            const cid = node.userData && node.userData.componentId;
            if (cid && wantedComponentIds.has(cid)) target = node;
        });
        if (target) this.gizmo.attach(target);
        else this.gizmo.detach();
    }

    setEnabled(b) { this._enabled = !!b; }
    isEnabled()   { return this._enabled; }

    dispose() {
        try { this.renderer.domElement.removeEventListener('pointermove', this._onMouseMove); } catch {}
        const ctrl = this.gizmo && this.gizmo._controls;
        if (ctrl) {
            try { ctrl.removeEventListener('dragging-changed', this._onDraggingChanged); } catch {}
            try { ctrl.removeEventListener('objectChange',    this._onObjectChange); } catch {}
        }
        if (this._unsubSelection) { try { this._unsubSelection(); } catch {} this._unsubSelection = null; }
    }

    // ── Internal ─────────────────────────────────────────────────────────────

    _onCursor(e) {
        this._cursor.clientX = e.clientX;
        this._cursor.clientY = e.clientY;
        this._cursor.valid = true;
    }

    _onDragging(ev) {
        if (!this._enabled) return;
        if (ev.value) {
            // Drag start — only engage snap in translate mode (rotate/scale
            // mate-snapping needs orientation math we'll add in Phase 3).
            const mode = this.gizmo.getMode ? this.gizmo.getMode() : 'translate';
            if (mode !== 'translate') return;

            const obj = this.gizmo._attached;
            if (!obj) return;

            const componentId = _findComponentId(obj);
            if (!componentId) return;

            this._dragging = true;
            this._draggedComponentId = componentId;
            this._draggedConnectors = _collectComponentConnectors(this.docProvider(), componentId);
            this._activeSnap = null;
            this._attachedSnapshot = {
                position: obj.position.clone(),
                quaternion: obj.quaternion.clone(),
            };
            // Capture the frames needed for frame-correct snap math. The
            // subgroup sits at identity under the ×1000 / Y-up→Z-up GLB wrap
            // and the component's placement is baked into geometry (bridge.js),
            // so we drive the part via a world-space DELTA, never by writing
            // world-mm straight into the subgroup's local position.
            this._captureDragFrames(obj, componentId);

            // Use the part's connectors as the compatibility probe — every
            // visible host connector recolors green (compatible) or dim
            // (not) so the user sees mate targets at a glance.
            try {
                // Hide the dragged component's own connectors so a part can
                // never snap to itself.
                this.overlay.setConnectorFilter((cid) => {
                    const cc = this.docProvider()?.connectors?.[cid];
                    return !cc || cc.parent !== componentId;
                });
                this.overlay.setCompatibilityProbe(this._draggedConnectors);
                this.overlay.refresh();
                this.overlay.setVisible(true);
            } catch {}

            // Phase 2 — also synthesize implicit connectors from the
            // kernel-shipped face geometry, so parts WITHOUT declared
            // `connectors[]` still magnetize face-to-face.
            this._derivedHostConnectors = [];
            try {
                const geom = this.geometryProvider ? this.geometryProvider() : null;
                if (geom) {
                    const all = deriveConnectorsFromGeometry(geom, { includeEdges: false });
                    // Filter would-be-self matches by approximate distance to
                    // the dragged subgroup's bbox — for v1, keep all derived
                    // connectors and rely on the user-visible mate result.
                    this._derivedHostConnectors = all;
                }
            } catch (err) { console.warn('[snap_drag] derive failed:', err); }
            // If the dragged part has no explicit connectors, synthesize a
            // single planar one at its local origin so face-to-face snap is
            // possible without authoring connectors per primitive.
            if (this._draggedConnectors.length === 0) {
                this._draggedConnectors = [_implicitOriginConnector()];
            }
        } else {
            // Drag end — commit if a snap is active.
            if (this._dragging && this._draggedComponentId) {
                if (this._activeSnap) {
                    const { solved, finalPosition, finalEuler } = this._activeSnap;
                    // Channel / rail snaps slide along their axis — use
                    // finalPosition (the user's slide-into-place pose) when
                    // present; fall back to the solved transform otherwise.
                    const pos = Array.isArray(finalPosition)
                        ? finalPosition.slice()
                        : solved.position.slice();
                    const rot = Array.isArray(finalEuler)
                        ? finalEuler.slice()
                        : solved.euler.slice();
                    this.commitMove(this._draggedComponentId, {
                        position: pos,
                        rotation: rot,
                    });
                } else {
                    // No snap — persist the visual drag pose. Convert the
                    // subgroup's current world matrix back into a component
                    // world origin (mm, Z-up) so the next kernel regen bakes
                    // the part where the user left it (not in the wrap frame).
                    const obj = this.gizmo._attached;
                    if (obj) {
                        const wc = this._componentWorldFromObject(obj);
                        if (wc) this.commitMove(this._draggedComponentId, wc);
                    }
                }
            }
            this._dragging = false;
            this._draggedComponentId = null;
            this._draggedConnectors = [];
            this._activeSnap = null;
            this._attachedSnapshot = null;
            try {
                this.overlay.setCompatibilityProbe(null);
                this.overlay.setConnectorFilter(null);
                this.overlay.setHighlighted(null);
                this.overlay.setVisible(false);
            } catch {}
        }
    }

    _onTick() {
        if (!this._dragging) return;
        if (!this._cursor.valid) return;

        // Ask the overlay for the closest compatible connector. The probe
        // we set on drag start ensures only mate-able connectors qualify.
        const rect = this.renderer.domElement.getBoundingClientRect();
        const cursor = {
            x: this._cursor.clientX - rect.left,
            y: this._cursor.clientY - rect.top,
        };
        const view = { width: rect.width, height: rect.height };

        // KSP-style primary snap: snap when the DRAGGED PART's connector node
        // nears a compatible host node — not when the cursor does. This is what
        // makes it snap easily: you drag the part itself near the rail.
        const partNodes = this._draggedConnectorWorldNodes();
        let hostHit = null;
        if (this.overlay.nearestCompatibleHost) {
            hostHit = this.overlay.nearestCompatibleHost(partNodes, this.camera, view, SNAP_NODE_PX);
        }
        // Fallback: cursor-near-host (covers parts whose live node frame is
        // unavailable, and keeps the old behaviour as a safety net).
        if (!hostHit) {
            const cur = this.overlay.pickCompatibleAtCursor
                ? this.overlay.pickCompatibleAtCursor(cursor, this.camera, view, MAGNET_PX)
                : null;
            if (cur && cur.connector) hostHit = { connectorId: cur.connector.id };
        }

        // If no explicit connector wins, try the derived (face-center)
        // probe — gives face-to-face snap for parts without authored
        // connectors. The derived candidates are precomputed on drag start.
        let snap = null;
        if (hostHit) {
            snap = this._resolveSnap(hostHit.connectorId);
        }
        if (!snap && this._derivedHostConnectors.length > 0) {
            const derivedHit = this._pickDerivedAtCursor(cursor, view);
            if (derivedHit) snap = this._resolveDerivedSnap(derivedHit);
        }
        if (!snap) {
            if (this._activeSnap) {
                this._activeSnap = null;
                try { this.overlay.setHighlighted(null); } catch {}
                if (this.onChange) this.onChange();
            }
            return;
        }

        // Snap! Light up the locked target (KSP green lock-on).
        try { this.overlay.setHighlighted(snap.hostConnectorId || null); } catch {}

        // Override the attached object's pose with the solved transform.
        // Channel (slot/line) and rail snaps leave the slide DOF free: we move
        // the part along the channel toward the cursor, clamped to the slot
        // extent, then re-solve so seat depth + frame orientation stay exact.
        let position = snap.solved.position;
        let euler = snap.solved.euler;
        const host = snap.hostWorld;
        const isChannel = host?.topology === 'line' || snap.hostConnector?.kind === 'slot';
        if (isChannel && Array.isArray(host?.axis)) {
            // Slide the part to where IT currently is along the channel (project
            // its live connector node onto the channel axis) — consistent with
            // how the snap was detected. Fall back to the cursor ray.
            let s = this._slideScalarFromPartNode(host, partNodes, snap.partConnector);
            if (s === null) s = this._slideScalarOnAxis(host);
            if (s !== null) {
                const slide = host.extent ? clamp(s, host.extent.from, host.extent.to) : s;
                const re = solveMateTransform(host, snap.partConnector, { slide });
                position = re.position;
                euler = re.euler;
            }
        } else if (snap.hostConnector?.kind === 'rail') {
            const slidPos = this._slidePositionOnRail(snap, this._cursor);
            if (slidPos) position = slidPos;
        }
        // Apply the solved WORLD pose to the subgroup as a world-space delta
        // (frame-correct: see _captureDragFrames). `position`/`euler` are the
        // component's desired world pose in mm Z-up.
        this._applyWorldPose(position, euler);
        // Remember the solved world pose so commitMove on release re-bakes it.
        this._activeSnap = { ...snap, finalPosition: position, finalEuler: euler };
        if (this.onChange) this.onChange();
    }

    /** Capture the frames used to drive the subgroup by a world-space delta. */
    _captureDragFrames(obj, componentId) {
        if (!obj) return;
        obj.updateMatrixWorld(true);
        this._objStart = obj.matrixWorld.clone();
        this._objStartInv = this._objStart.clone().invert();
        const P = obj.parent ? obj.parent.matrixWorld.clone() : new THREE.Matrix4();
        this._Pinv = P.clone().invert();
        const doc = this.docProvider();
        const comp = doc && doc.components && doc.components[componentId];
        const o = (comp && comp.origin) || { position: [0, 0, 0], rotation: [0, 0, 0] };
        this._W0 = composeMatrix(o.position || [0, 0, 0], o.rotation || [0, 0, 0]);
        this._W0inv = this._W0.clone().invert();
    }

    /**
     * Current world positions of the dragged part's connectors. The subgroup
     * started at `_objStart`; its connectors started at their doc world frames
     * (`worldConnectorFor`); so the live world position is
     * `objNow · objStart⁻¹ · worldOrigin`.
     */
    _draggedConnectorWorldNodes() {
        const obj = this.gizmo._attached;
        if (!obj || !this._objStartInv) return [];
        obj.updateMatrixWorld(true);
        const doc = this.docProvider();
        const out = [];
        for (const c of this._draggedConnectors) {
            const w = worldConnectorFor(doc, c);
            const o = w && w.origin ? w.origin : [0, 0, 0];
            const live = liveConnectorWorld(obj.matrixWorld, this._objStartInv, o);
            out.push({ connector: c, world: [live.x, live.y, live.z] });
        }
        return out;
    }

    /**
     * Set the subgroup so the component reaches world pose (position, euler).
     * Because placement is baked and the subgroup sits under the GLB wrap, we
     * solve for the subgroup's LOCAL matrix:
     *   objWorldTarget = Wnew · W0⁻¹ · objStart ;  objLocal = P⁻¹ · objWorldTarget
     */
    _applyWorldPose(position, euler) {
        const obj = this.gizmo._attached;
        if (!obj || !this._objStart) return;
        const Wnew = composeMatrix(position, euler);
        const local = localForWorldPose(this._Pinv, this._objStart, this._W0inv, Wnew);
        local.decompose(obj.position, obj.quaternion, obj.scale);
        obj.updateMatrixWorld(true);
    }

    /** Inverse of _applyWorldPose: read the subgroup's current world pose back
     *  into a component origin {position, rotation} (mm, Z-up) for commit. */
    _componentWorldFromObject(obj) {
        if (!obj || !this._objStartInv || !this._W0) return null;
        obj.updateMatrixWorld(true);
        const wc = componentWorldFromObject(obj.matrixWorld, this._objStartInv, this._W0);
        return decomposePose(wc);
    }

    /**
     * Slide scalar from the dragged part's own connector node: project its live
     * world position onto the host channel axis (mm from channel origin). This
     * keeps detection and placement using the same reference (the part), so the
     * nut sits at the channel point nearest where you dragged it.
     */
    _slideScalarFromPartNode(host, partNodes, partConnector) {
        if (!Array.isArray(partNodes) || !partNodes.length) return null;
        const pn = partNodes.find((n) => partConnector && n.connector.id === partConnector.id)
            || partNodes.find((n) => connectorsCompatible(host, n.connector));
        if (!pn) return null;
        const a = normalize3(host.axis);
        const o = host.origin;
        return (pn.world[0] - o[0]) * a[0] + (pn.world[1] - o[1]) * a[1] + (pn.world[2] - o[2]) * a[2];
    }

    /**
     * Project the cursor pick ray onto the host channel axis and return the
     * slide scalar `s` (mm from the channel origin along its unit axis). Null
     * when the channel is parallel to the view ray (singular). Reuses the pure
     * closest-point-of-two-lines helper from snap_math.
     */
    _slideScalarOnAxis(host) {
        if (!this._cursor.valid) return null;
        const rect = this.renderer.domElement.getBoundingClientRect();
        const x = ((this._cursor.clientX - rect.left) / rect.width)  * 2 - 1;
        const y = -((this._cursor.clientY - rect.top)  / rect.height) * 2 + 1;
        this._ndc.set(x, y);
        this._raycaster.setFromCamera(this._ndc, this.camera);
        const rO = this._raycaster.ray.origin;
        const rD = this._raycaster.ray.direction;
        return closestParamOnLine(
            [rO.x, rO.y, rO.z], [rD.x, rD.y, rD.z],
            host.origin, normalize3(host.axis),
        );
    }

    /**
     * Slide-along-rail support: given a rail snap (hostWorld carries the
     * rail axis + a point on the line) and a cursor screen position,
     * return the closest point on the rail axis to the cursor pick ray.
     * Returns null when the rail is exactly parallel to the cursor ray
     * (singular case — fall back to the solved snap position).
     */
    _slidePositionOnRail(snap, cursor) {
        if (!cursor.valid) return null;
        const rect = this.renderer.domElement.getBoundingClientRect();
        const x = ((cursor.clientX - rect.left) / rect.width)  * 2 - 1;
        const y = -((cursor.clientY - rect.top)  / rect.height) * 2 + 1;
        this._ndc.set(x, y);
        this._raycaster.setFromCamera(this._ndc, this.camera);
        const rO = this._raycaster.ray.origin;
        const rD = this._raycaster.ray.direction;

        const Pl = snap.hostWorld.origin;
        const dl = _vec3Normalize(snap.hostWorld.axis);
        const dr = [rD.x, rD.y, rD.z];      // already normalized by Raycaster

        // Closest-point-of-two-lines (see derivation in the geometry FAQ).
        const w  = [rO.x - Pl[0], rO.y - Pl[1], rO.z - Pl[2]];
        const b  = _dot(dr, dl);
        const d  = _dot(dr, w);
        const e  = _dot(dl, w);
        const denom = 1 - b * b;
        if (denom < 1e-6) return null;
        const tl = (e - b * d) / denom;
        return [Pl[0] + tl * dl[0], Pl[1] + tl * dl[1], Pl[2] + tl * dl[2]];
    }

    /**
     * Screen-space probe over `_derivedHostConnectors`. Each derived
     * connector carries its world frame already (kernel geometry is in
     * world coords), so projection is straight three.js. Returns the
     * winner or null.
     */
    _pickDerivedAtCursor(cursor, view) {
        if (this._derivedHostConnectors.length === 0) return null;
        const _v = new THREE.Vector3();
        let best = null;
        let bestPx = MAGNET_PX;
        for (const c of this._derivedHostConnectors) {
            _v.set(c.origin[0], c.origin[1], c.origin[2]).project(this.camera);
            if (_v.z < -1 || _v.z > 1) continue;
            const sx = ( _v.x + 1) * 0.5 * view.width;
            const sy = (-_v.y + 1) * 0.5 * view.height;
            const px = Math.hypot(sx - cursor.x, sy - cursor.y);
            if (px < bestPx) {
                // Also require compatibility with at least one part
                // connector — keeps the snap consistent with the explicit
                // path: face-to-face only when both sides can mate.
                const ok = this._draggedConnectors.some((p) => connectorsCompatible(c, p));
                if (!ok) continue;
                bestPx = px;
                best = c;
            }
        }
        return best;
    }

    _resolveDerivedSnap(hostConnector) {
        const hostWorld = {
            kind:   hostConnector.kind,
            axis:   hostConnector.axis,
            origin: hostConnector.origin,
        };
        for (const partConnector of this._draggedConnectors) {
            if (!connectorsCompatible(hostConnector, partConnector)) continue;
            const solved = solveMateTransform(hostWorld, partConnector);
            return {
                hostConnectorId: hostConnector.id,
                hostConnector,
                hostWorld,
                partConnector,
                solved,
                derived: true,
            };
        }
        return null;
    }

    _resolveSnap(hostConnectorId) {
        const hostWorld = this.overlay.getWorldConnector(hostConnectorId);
        if (!hostWorld) return null;
        const doc = this.docProvider();
        const hostConnector = doc.connectors?.[hostConnectorId];
        if (!hostConnector) return null;

        // For each dragged-component connector (in part-local frame),
        // pick the first compatible match.
        for (const partConnector of this._draggedConnectors) {
            if (!connectorsCompatible(hostConnector, partConnector)) continue;
            const solved = solveMateTransform(hostWorld, partConnector);
            return {
                hostConnectorId,
                hostConnector,
                hostWorld,
                partConnector,
                solved,
            };
        }
        return null;
    }
}

/** Walk up the parent chain looking for `userData.componentId`. */
function _findComponentId(obj) {
    let cur = obj;
    let guard = 32;
    while (cur && guard-- > 0) {
        const cid = cur.userData && cur.userData.componentId;
        if (cid) return cid;
        cur = cur.parent;
    }
    return null;
}

function _vec3Normalize(v) {
    const m = Math.hypot(v[0], v[1], v[2]);
    if (m < 1e-9) return [0, 0, 1];
    return [v[0] / m, v[1] / m, v[2] / m];
}
function _dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

/** A neutral planar connector at the part's local origin, used as a
 *  fallback when the dragged component has no explicit connectors. Snaps
 *  face-to-face by sitting on the host face center. */
function _implicitOriginConnector() {
    return {
        id: 'derived:part-origin',
        parent: null,
        kind: 'planar',
        gender: 'neutral',
        size: { nominal: 'auto', unit: 'mm' },
        axis: [0, 0, 1],
        origin: [0, 0, 0],
        mates_with: [],
        inducedJoint: 'fixed',
        metadata: { derived: true, source: 'part-origin' },
    };
}

/** Pull every connector record whose `parent === componentId`. */
function _collectComponentConnectors(doc, componentId) {
    if (!doc || !doc.connectors || !componentId) return [];
    const out = [];
    for (const id of Object.keys(doc.connectors)) {
        const c = doc.connectors[id];
        if (c && c.parent === componentId) out.push(c);
    }
    return out;
}
