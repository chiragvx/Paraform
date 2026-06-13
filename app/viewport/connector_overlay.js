/**
 * ConnectorOverlay — KSP-editor-style attachment nodes.
 *
 * Renders every Connector record on the document as a glowing 3-D node the
 * user can snap a part onto, and exposes a screen-space picker so
 * snap_drag.js can answer "which connector is under the cursor?" in the exact
 * world frame the user sees.
 *
 * Per-kind shapes (so a glance tells you what mate this affords):
 *   - slot / line ports (topology 'line') → a glowing channel TUBE spanning the
 *     `extent`, with small caps at each end. No middle grab ball — the channel
 *     itself is the picking target; the cursor magnetizes to anywhere along it.
 *   - planar / tab (topology 'plane') → a translucent face DISK normal to the
 *     connector axis, with a small contact dot at the origin. You see the
 *     plane the mating face will sit on, not just a point.
 *   - bore / shaft / thread (axial) → a sphere at the origin + axis ring,
 *     telling you where to thread / press in.
 *
 * Colour states (only ONE connector lights up as lock-on at a time):
 *   - idle           → per-kind colour, translucent
 *   - compatible     → calm cyan-green — "the probe could mate me"
 *   - highlighted    → bright lock-on green, larger — "I AM the active target"
 *   - incompatible   → dimmed grey — "probe says no"
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
// Compatible = calm hint that the probe could mate (one of N candidates).
// Highlighted = the ONE active target the cursor is locked onto. Two distinct
// greens so the user can always tell "this is where it'll land" at a glance.
const COL_COMPATIBLE   = 0x2aa85a;   // calm green hint
const COL_INCOMPATIBLE = 0x3a3f44;   // dimmed
const COL_HIGHLIGHT    = 0x6dff96;   // bright lock-on green

const NODE_PX        = 13;    // on-screen node diameter target
const PICK_TARGET_PX = 14;    // magnet radius the picker treats as a hit
const NODE_RADIUS_MM = 1.0;   // unscaled sphere radius; rescaled per frame
// Slot channel tube — kept in world mm so the channel hugs the actual extrusion
// surface at any zoom. 0.6mm radius reads clearly without dominating the part.
const CHANNEL_TUBE_RADIUS_MM = 0.6;
const CHANNEL_CAP_RADIUS_MM  = 0.7;  // small end-marker sphere (world mm)
// Planar face disk — sized as a fraction of the connector's nominal size so the
// disk visually matches the contact area. Clamped to a sensible range.
const PLANAR_DISK_FRACTION   = 0.45; // fraction of nominal size → disk radius
const PLANAR_DISK_MIN_MM     = 4;
const PLANAR_DISK_MAX_MM     = 25;

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

    setVisible(b) {
        const next = !!b;
        // Hidden→visible transition: refresh if a doc commit landed while
        // we were hidden. The Viewport.svelte subscriber skips rebuilds when
        // !isVisible() to keep idle cost zero, so we catch up here. Use a
        // simple dirty flag set by `markDirty` whenever a skipped commit
        // wanted us; first show ever (no _byId entries) also catches up.
        if (next && !this.root.visible && (this._dirty || this._byId.size === 0)) {
            this._dirty = false;
            this.root.visible = true;
            this.rebuild();
            return;
        }
        this.root.visible = next;
    }
    isVisible() { return this.root.visible; }
    /** Note a doc change happened while hidden; next setVisible(true) will rebuild. */
    markDirty() { this._dirty = true; }
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
        const kind = c.kind;
        const colour = KIND_COLOURS[kind] || 0xffffff;
        const balls = [];
        const lines = [];

        // Planar / tab: render the mating face as a translucent disk normal to
        // the connector axis, with a small contact dot at the origin. The disk
        // makes the plane orientation legible at a glance (rule 3: axis = out).
        if (kind === 'planar' || kind === 'tab') {
            const sizeMm = _nominalMm(c, 20);
            const r = Math.max(PLANAR_DISK_MIN_MM,
                Math.min(PLANAR_DISK_MAX_MM, sizeMm * PLANAR_DISK_FRACTION));
            const disk = _faceDisk(colour, r);
            disk.position.set(world.origin[0], world.origin[1], world.origin[2]);
            _orientZTo(disk, world.axis);
            this.root.add(disk);
            lines.push(disk);

            const dot = new THREE.Mesh(_sharedBallGeom(), _ballMat(colour));
            dot.position.set(world.origin[0], world.origin[1], world.origin[2]);
            dot.renderOrder = 999;
            this.root.add(dot);
            balls.push(dot);

            return {
                connector: c, world, kind, isSlot: false,
                point: world.origin.slice(), seg: null, balls, lines, state: 'idle',
            };
        }

        // Bore / shaft / thread (and any unhandled axial kind): sphere at the
        // origin + axis ring telling you where to press / thread.
        const ball = new THREE.Mesh(_sharedBallGeom(), _ballMat(colour));
        ball.position.set(world.origin[0], world.origin[1], world.origin[2]);
        ball.renderOrder = 999;
        this.root.add(ball);
        balls.push(ball);

        const ring = _ringLine(colour);
        ring.position.set(world.origin[0], world.origin[1], world.origin[2]);
        _orientZTo(ring, world.axis);
        this.root.add(ring);
        lines.push(ring);

        return {
            connector: c, world, kind, isSlot: false,
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

        // The channel itself — a visible tube along the slide range. Replaces
        // the thin 1-px line + 3 grab balls that used to dominate the view with
        // no context. World-sized so it hugs the actual extrusion face at any
        // zoom; picking still uses the screen-space segment distance.
        const tube = _channelTube(p0, p1, colour);
        this.root.add(tube);
        lines.push(tube);

        // Small end caps so the run direction + extent are unambiguous. No
        // middle ball — the channel IS the picking target and the highlighted
        // state will indicate "this one" without visual noise.
        for (const p of [p0, p1]) {
            const cap = new THREE.Mesh(_sharedCapGeom(), _ballMat(colour));
            cap.position.set(p[0], p[1], p[2]);
            cap.renderOrder = 999;
            // Caps keep their world size; opt out of screen-space rescale.
            cap.userData._fixedWorldScale = true;
            this.root.add(cap);
            balls.push(cap);
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

    /** Keep nodes a constant on-screen size. Lines/tubes/disks keep world size. */
    updateScreenSpaceSize(viewportHeightPx = 600) {
        if (!this.root.visible) return;
        const cam = this.camera;
        if (!cam.isPerspectiveCamera) return;
        const tmp = new THREE.Vector3();
        const vFov = (cam.fov * Math.PI) / 180;
        for (const e of this._byId.values()) {
            for (const b of e.balls) {
                // Channel end caps (and any other ball flagged) stay in world mm
                // so they sit on the physical channel ends at any zoom.
                if (b.userData._fixedWorldScale) continue;
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
let _CAP_GEOM = null;
function _sharedCapGeom() {
    if (!_CAP_GEOM) _CAP_GEOM = new THREE.SphereGeometry(CHANNEL_CAP_RADIUS_MM, 12, 8);
    return _CAP_GEOM;
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
/**
 * Build a thin tube along the segment p0→p1, using a CylinderGeometry rotated
 * so its long axis matches the segment. Replaces the invisible 1-px line for
 * slot channels — the tube reads clearly at any zoom because it's world-sized
 * (it hugs the extrusion face), not screen-space-scaled.
 */
function _channelTube(p0, p1, colour) {
    const dx = p1[0] - p0[0], dy = p1[1] - p0[1], dz = p1[2] - p0[2];
    const len = Math.hypot(dx, dy, dz) || 1e-6;
    const geom = new THREE.CylinderGeometry(
        CHANNEL_TUBE_RADIUS_MM, CHANNEL_TUBE_RADIUS_MM, len, 12, 1, false,
    );
    const mat = new THREE.MeshBasicMaterial({
        color: colour, transparent: true, opacity: 0.85, depthTest: false, depthWrite: false,
    });
    const mesh = new THREE.Mesh(geom, mat);
    // Cylinder default axis is +Y; rotate so +Y maps to (p1-p0)/len, then place
    // midpoint at the segment center.
    const dir = new THREE.Vector3(dx, dy, dz).normalize();
    mesh.quaternion.copy(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir));
    mesh.position.set((p0[0] + p1[0]) * 0.5, (p0[1] + p1[1]) * 0.5, (p0[2] + p1[2]) * 0.5);
    mesh.renderOrder = 998;
    return mesh;
}
/**
 * A translucent disk in the plane normal to local +Z (caller orients to the
 * connector axis). Renders a planar mating site as the face you'd actually bolt
 * against — not just a point. Outer ring traces the perimeter for clarity.
 */
function _faceDisk(colour, radiusMm) {
    const grp = new THREE.Group();
    const disk = new THREE.Mesh(
        new THREE.CircleGeometry(radiusMm, 40),
        new THREE.MeshBasicMaterial({
            color: colour, transparent: true, opacity: 0.22,
            side: THREE.DoubleSide, depthTest: false, depthWrite: false,
        }),
    );
    disk.renderOrder = 997;
    grp.add(disk);
    // Perimeter ring at the disk edge — gives the plane a hard boundary.
    const pts = [];
    const N = 48;
    for (let i = 0; i <= N; i++) {
        const t = (i / N) * Math.PI * 2;
        pts.push(new THREE.Vector3(Math.cos(t) * radiusMm, Math.sin(t) * radiusMm, 0));
    }
    const ring = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: colour, transparent: true, opacity: 0.95, depthTest: false }),
    );
    ring.renderOrder = 998;
    grp.add(ring);
    // Mirror the .material API the state-update loop reads on lines: expose a
    // single material whose color/opacity getter+setter fan out to both the
    // disk fill and the perimeter ring.
    grp.material = {
        color: {
            setHex(hex) { disk.material.color.setHex(hex); ring.material.color.setHex(hex); },
        },
        set opacity(v) { disk.material.opacity = v * 0.25; ring.material.opacity = v; },
        get opacity() { return ring.material.opacity; },
    };
    return grp;
}
/** Read a numeric nominal size in mm; falls back to `def` for sentinels. */
function _nominalMm(c, def) {
    const n = c && c.size && c.size.nominal;
    const num = Number(n);
    return Number.isFinite(num) && num > 0 ? num : def;
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
        if (n.geometry && n.geometry !== _BALL_GEOM && n.geometry !== _CAP_GEOM) {
            try { n.geometry.dispose(); } catch {}
        }
        if (n.material) {
            if (Array.isArray(n.material)) n.material.forEach((m) => { try { m.dispose(); } catch {} });
            else if (typeof n.material.dispose === 'function') { try { n.material.dispose(); } catch {} }
        }
    });
}
