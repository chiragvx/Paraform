/**
 * ConnectorOverlay — KSP-editor-style attachment nodes.
 *
 * Renders every Connector record on the document as a glowing 3-D node the
 * user can snap a part onto, and exposes a screen-space picker so
 * snap_drag.js can answer "which connector is under the cursor?" in the exact
 * world frame the user sees.
 *
 * Two node shapes:
 *   - point connectors (bore/shaft/thread/planar/tab) → a filled sphere node
 *     plus a thin axis ring, screen-space-sized so it reads the same at any
 *     zoom (like KSP's attach balls).
 *   - slot / line ports (topology 'line') → the whole channel drawn as a
 *     glowing line spanning its `extent`, with grab balls at both ends and the
 *     middle. The cursor magnetizes to *anywhere along the channel*, so a
 *     t-nut drops in wherever you point and slides along it — the KSP rail feel.
 *
 * Colour states (the green-glow lock-on is the whole point):
 *   - idle           → per-kind colour, translucent
 *   - compatible     → bright green (probe says this mates the dragged part)
 *   - incompatible   → dimmed grey (probe says it can't mate)
 *   - highlighted    → near-white, enlarged (cursor is locked onto it)
 *
 * Z-up correct: connectors are component-local mm; we walk the component-origin
 * chain via `worldConnectorFor` to get the world frame each rebuild. The root
 * group lives at scene identity (NOT under the GLB wrap) so kernel-frame mm map
 * 1:1 — same rule as PickProxyLayer / FaceHighlightOverlay (see CLAUDE.md).
 */

import * as THREE from 'three';
import { worldConnectorFor, connectorsCompatible } from '../../src/lib/library/mate_solver.js';
import { pointSegmentDist2D, normalize3 } from './snap_math.js';

const KIND_COLOURS = Object.freeze({
    bore: 0xff8c42, shaft: 0xff8c42, thread: 0xff8c42,
    planar: 0x4fb3ff, tab: 0x4fb3ff, slot: 0x6bd0ff, rail: 0x6bcf63,
});
const COL_COMPATIBLE   = 0x35e06a;   // KSP lock-on green
const COL_INCOMPATIBLE = 0x3a3f44;   // dimmed
const COL_HIGHLIGHT    = 0xbfffd0;   // near-white green

const NODE_PX        = 13;    // on-screen node diameter target
const PICK_TARGET_PX = 14;    // magnet radius the picker treats as a hit
const NODE_RADIUS_MM = 1.0;   // unscaled sphere radius; rescaled per frame

export class ConnectorOverlay {
    /**
     * @param {object} args
     * @param {THREE.Scene}  args.scene
     * @param {THREE.Camera} args.camera
     * @param {() => object} args.docProvider — returns DocumentStore.doc
     * @param {(connectorId: string) => boolean} [args.connectorFilter]
     */
    constructor({ scene, camera, docProvider, connectorFilter = null }) {
        if (!scene || !camera || typeof docProvider !== 'function') {
            throw new Error('ConnectorOverlay: scene/camera/docProvider required');
        }
        this.scene = scene;
        this.camera = camera;
        this.docProvider = docProvider;
        this.connectorFilter = connectorFilter;

        this.root = new THREE.Group();
        this.root.name = '__connector_overlay__';
        this.root.renderOrder = 998;
        this.root.visible = false;
        scene.add(this.root);

        /** Active compatibility probe (the dragged part's connectors). */
        this._probe = null;
        this._highlightId = null;

        /**
         * entries: id → {
         *   connector, world, kind, isSlot,
         *   point:[x,y,z], seg:[[x,y,z],[x,y,z]]|null,
         *   balls:THREE.Mesh[], lines:THREE.Object3D[], state
         * }
         */
        this._byId = new Map();
        // Kept for back-compat with callers that read `.pickables` (raycast
        // path). The screen-space picker below is the live one.
        this.pickables = [];
    }

    setVisible(b) { this.root.visible = !!b; }
    isVisible() { return this.root.visible; }
    setConnectorFilter(fn) { this.connectorFilter = typeof fn === 'function' ? fn : null; }

    /** Set / clear the dragged part's connectors used to colour mate targets. */
    setCompatibilityProbe(partConnectors) {
        this._probe = (Array.isArray(partConnectors) && partConnectors.length) ? partConnectors : null;
        this._applyStates();
    }

    /** Alias — snap_drag calls refresh(); rebuild is the implementation. */
    refresh() { this.rebuild(); }

    rebuild() {
        while (this.root.children.length) {
            const ch = this.root.children[0];
            this.root.remove(ch);
            _disposeRecursive(ch);
        }
        this._byId.clear();
        this.pickables = [];

        const doc = this.docProvider();
        if (!doc || !doc.connectors) return;

        for (const id of Object.keys(doc.connectors)) {
            if (this.connectorFilter && !this.connectorFilter(id)) continue;
            const c = doc.connectors[id];
            if (!c) continue;
            const world = worldConnectorFor(doc, c);
            const isSlot = world.topology === 'line' || c.kind === 'slot';
            const entry = isSlot
                ? this._buildSlotNode(id, c, world)
                : this._buildPointNode(id, c, world);
            this._byId.set(id, entry);
        }
        this._applyStates();
        this.updateScreenSpaceSize();
    }

    _buildPointNode(id, c, world) {
        const colour = KIND_COLOURS[c.kind] || 0xffffff;
        const balls = [];
        const lines = [];

        const ball = new THREE.Mesh(_sharedBallGeom(), _ballMat(colour));
        ball.position.set(world.origin[0], world.origin[1], world.origin[2]);
        ball.renderOrder = 999;
        this.root.add(ball);
        balls.push(ball);

        // Thin axis ring so orientation is legible.
        const ring = _ringLine(colour);
        ring.position.set(world.origin[0], world.origin[1], world.origin[2]);
        _orientZTo(ring, world.axis);
        this.root.add(ring);
        lines.push(ring);

        return {
            connector: c, world, kind: c.kind, isSlot: false,
            point: world.origin.slice(), seg: null, balls, lines, state: 'idle',
        };
    }

    _buildSlotNode(id, c, world) {
        const colour = KIND_COLOURS.slot;
        const axis = normalize3(world.axis);
        const ext = world.extent || { from: -10, to: 10 };
        const o = world.origin;
        const p0 = [o[0] + axis[0] * ext.from, o[1] + axis[1] * ext.from, o[2] + axis[2] * ext.from];
        const p1 = [o[0] + axis[0] * ext.to,   o[1] + axis[1] * ext.to,   o[2] + axis[2] * ext.to];

        const lines = [];
        const balls = [];

        // The channel guide line.
        const line = new THREE.Line(
            new THREE.BufferGeometry().setFromPoints([
                new THREE.Vector3(...p0), new THREE.Vector3(...p1),
            ]),
            new THREE.LineBasicMaterial({ color: colour, transparent: true, opacity: 0.85, depthTest: false }),
        );
        line.renderOrder = 998;
        this.root.add(line);
        lines.push(line);

        // Grab balls at both ends + middle.
        for (const p of [p0, o.slice(), p1]) {
            const b = new THREE.Mesh(_sharedBallGeom(), _ballMat(colour));
            b.position.set(p[0], p[1], p[2]);
            b.renderOrder = 999;
            this.root.add(b);
            balls.push(b);
        }

        return {
            connector: c, world, kind: 'slot', isSlot: true,
            point: o.slice(), seg: [p0, p1], balls, lines, state: 'idle',
        };
    }

    /** Re-tint every node by probe compatibility + current highlight. */
    _applyStates() {
        for (const [id, e] of this._byId.entries()) {
            let state = 'idle';
            if (this._probe) {
                const ok = this._probe.some((p) => connectorsCompatible(e.world, p));
                state = ok ? 'compatible' : 'incompatible';
            }
            if (id === this._highlightId) state = 'highlighted';
            e.state = state;
            const { colour, opacity, scale } = _stateStyle(state, KIND_COLOURS[e.kind] || 0xffffff);
            for (const b of e.balls) {
                b.material.color.setHex(colour);
                b.material.opacity = opacity;
                b.userData._stateScale = scale;
            }
            for (const ln of e.lines) {
                if (ln.material && ln.material.color) {
                    ln.material.color.setHex(state === 'idle' ? (KIND_COLOURS[e.kind] || 0xffffff) : colour);
                    ln.material.opacity = state === 'incompatible' ? 0.25 : 0.9;
                }
            }
        }
    }

    /** Brighten the connector under cursor. Pass null to clear. */
    setHighlighted(connectorId) {
        if (this._highlightId === connectorId) return;
        this._highlightId = connectorId || null;
        this._applyStates();
    }

    /** World-frame {kind,axis,origin,normal,extent,…} for the mate solver. */
    getWorldConnector(connectorId) {
        const doc = this.docProvider();
        const c = doc && doc.connectors && doc.connectors[connectorId];
        if (!c) return null;
        return worldConnectorFor(doc, c);
    }

    /**
     * Closest connector to a screen point. Point nodes use distance to their
     * projected origin; slot nodes use distance to their projected channel
     * segment (so the cursor locks anywhere along the channel).
     *
     * @param {{x:number,y:number}} cursor — px in the canvas
     * @param {THREE.Camera} camera
     * @param {{width:number,height:number}} view
     * @param {number} radius — magnet radius in px
     * @returns {{ connector: object, distancePx: number }|null}
     */
    pickAtCursor(cursor, camera, view, radius = PICK_TARGET_PX) {
        if (!camera || !view) return null;
        let best = null, bestD = radius;
        const v = new THREE.Vector3();
        const toPx = (p) => {
            v.set(p[0], p[1], p[2]).project(camera);
            if (v.z < -1 || v.z > 1) return null;
            return [(v.x * 0.5 + 0.5) * view.width, (-v.y * 0.5 + 0.5) * view.height];
        };
        for (const e of this._byId.values()) {
            let d;
            if (e.isSlot && e.seg) {
                const a = toPx(e.seg[0]); const b = toPx(e.seg[1]);
                if (!a || !b) continue;
                d = pointSegmentDist2D(cursor.x, cursor.y, a[0], a[1], b[0], b[1]);
            } else {
                const a = toPx(e.point);
                if (!a) continue;
                d = Math.hypot(a[0] - cursor.x, a[1] - cursor.y);
            }
            if (d < bestD) { bestD = d; best = e; }
        }
        return best ? { connector: best.connector, distancePx: bestD } : null;
    }

    /** Same, but only returns hits compatible with the active probe. */
    pickCompatibleAtCursor(cursor, camera, view, radius = PICK_TARGET_PX) {
        if (!camera || !view) return null;
        let best = null, bestD = radius;
        const v = new THREE.Vector3();
        const toPx = (p) => {
            v.set(p[0], p[1], p[2]).project(camera);
            if (v.z < -1 || v.z > 1) return null;
            return [(v.x * 0.5 + 0.5) * view.width, (-v.y * 0.5 + 0.5) * view.height];
        };
        for (const e of this._byId.values()) {
            if (this._probe && !this._probe.some((p) => connectorsCompatible(e.world, p))) continue;
            let d;
            if (e.isSlot && e.seg) {
                const a = toPx(e.seg[0]); const b = toPx(e.seg[1]);
                if (!a || !b) continue;
                d = pointSegmentDist2D(cursor.x, cursor.y, a[0], a[1], b[0], b[1]);
            } else {
                const a = toPx(e.point);
                if (!a) continue;
                d = Math.hypot(a[0] - cursor.x, a[1] - cursor.y);
            }
            if (d < bestD) { bestD = d; best = e; }
        }
        return best ? { connector: best.connector, distancePx: bestD } : null;
    }

    /**
     * KSP-style proximity snap: given the dragged part's connectors and their
     * CURRENT world positions, return the nearest host connector whose node is
     * within `radius` px of a compatible part node. Slot hosts measure to their
     * channel segment so the part snaps when it nears anywhere along the rail.
     *
     * @param {{connector:object, world:number[]}[]} partNodes
     * @returns {{ connectorId:string, distancePx:number }|null}
     */
    nearestCompatibleHost(partNodes, camera, view, radius = PICK_TARGET_PX) {
        if (!camera || !view || !partNodes || !partNodes.length) return null;
        const v = new THREE.Vector3();
        const toPx = (p) => {
            v.set(p[0], p[1], p[2]).project(camera);
            if (v.z < -1 || v.z > 1) return null;
            return [(v.x * 0.5 + 0.5) * view.width, (-v.y * 0.5 + 0.5) * view.height];
        };
        let best = null, bestD = radius;
        for (const e of this._byId.values()) {
            for (const pn of partNodes) {
                if (!connectorsCompatible(e.world, pn.connector)) continue;
                const pp = toPx(pn.world);
                if (!pp) continue;
                let d;
                if (e.isSlot && e.seg) {
                    const a = toPx(e.seg[0]); const b = toPx(e.seg[1]);
                    if (!a || !b) continue;
                    d = pointSegmentDist2D(pp[0], pp[1], a[0], a[1], b[0], b[1]);
                } else {
                    const a = toPx(e.point);
                    if (!a) continue;
                    d = Math.hypot(a[0] - pp[0], a[1] - pp[1]);
                }
                if (d < bestD) { bestD = d; best = e; }
            }
        }
        return best ? { connectorId: best.connector.id, distancePx: bestD } : null;
    }

    /** Keep nodes a constant on-screen size. Lines keep their world length. */
    updateScreenSpaceSize(viewportHeightPx = 600) {
        if (!this.root.visible) return;
        const cam = this.camera;
        if (!cam.isPerspectiveCamera) return;
        const tmp = new THREE.Vector3();
        const vFov = (cam.fov * Math.PI) / 180;
        for (const e of this._byId.values()) {
            for (const b of e.balls) {
                const dist = cam.position.distanceTo(tmp.copy(b.position)) || 1;
                const worldPerPx = (2 * Math.tan(vFov / 2) * dist) / viewportHeightPx;
                const stateScale = b.userData._stateScale || 1;
                const s = Math.max(0.02, (worldPerPx * NODE_PX * 0.5 * stateScale) / NODE_RADIUS_MM);
                b.scale.setScalar(s);
            }
        }
    }

    dispose() {
        try { this.scene.remove(this.root); } catch {}
        _disposeRecursive(this.root);
        this._byId.clear();
        this.pickables = [];
    }
}

// ── geometry / material helpers ──────────────────────────────────────────────

let _BALL_GEOM = null;
function _sharedBallGeom() {
    if (!_BALL_GEOM) _BALL_GEOM = new THREE.SphereGeometry(NODE_RADIUS_MM, 16, 12);
    return _BALL_GEOM;
}
function _ballMat(colour) {
    return new THREE.MeshBasicMaterial({
        color: colour, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false,
    });
}
function _ringLine(colour) {
    const pts = [];
    const N = 28;
    for (let i = 0; i <= N; i++) {
        const t = (i / N) * Math.PI * 2;
        pts.push(new THREE.Vector3(Math.cos(t) * 2.2, Math.sin(t) * 2.2, 0));
    }
    return new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: colour, transparent: true, opacity: 0.9, depthTest: false }),
    );
}
function _orientZTo(obj, axis) {
    const a = new THREE.Vector3(axis[0], axis[1], axis[2]);
    if (a.lengthSq() < 0.5) return;
    a.normalize();
    obj.quaternion.copy(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), a));
}
function _stateStyle(state, kindColour) {
    switch (state) {
        case 'compatible':   return { colour: COL_COMPATIBLE,   opacity: 0.98, scale: 1.25 };
        case 'incompatible': return { colour: COL_INCOMPATIBLE, opacity: 0.30, scale: 0.8 };
        case 'highlighted':  return { colour: COL_HIGHLIGHT,    opacity: 1.0,  scale: 1.6 };
        default:             return { colour: kindColour,       opacity: 0.85, scale: 1.0 };
    }
}
function _disposeRecursive(node) {
    if (!node) return;
    node.traverse?.((n) => {
        if (n.geometry && n.geometry !== _BALL_GEOM) { try { n.geometry.dispose(); } catch {} }
        if (n.material) {
            if (Array.isArray(n.material)) n.material.forEach((m) => { try { m.dispose(); } catch {} });
            else { try { n.material.dispose(); } catch {} }
        }
    });
}
