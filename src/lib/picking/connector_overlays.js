/**
 * Spec 18 v1 — connector visualisation overlay.
 *
 * Renders the document's connectors as small cyan rings + axis arrows,
 * each tagged with its kind/size. The overlay is a `THREE.Group` that
 * Viewport.svelte parents directly under the Z-up scene root (no GLB
 * wrap multiplication — connectors are already authored in world mm).
 *
 *   makeConnectorOverlay(scene, getConnectors)  → controller
 *   controller.refresh()       — rebuild from the current connector set
 *   controller.setVisible(b)   — toggle (default off; auto-on during drag)
 *   controller.pickAtCursor({ x, y }, camera, radius=24) → nearest connector
 *   controller.setCompatibilityProbe(partConnectors) — recolor each ring
 *       green (any of `partConnectors` mates) or dimmed (no compat). Pass
 *       null/empty to drop the probe and revert to per-kind colors.
 *   controller.pickCompatibleAtCursor(...) — same as pickAtCursor but
 *       only returns hits that pass the current compatibility probe.
 *   controller.dispose()
 *
 * The picker computes screen-space distance to each connector origin and
 * returns the closest within `radius` pixels.
 */

import * as THREE from 'three';
import { connectorsCompatible, worldConnectorFor } from '../library/mate_solver.js';

const RING_R   = 1.8;     // mm — visible ring radius (sized for fastener scale)
const ARROW_LEN = 6.0;
const COLORS = {
    thread: 0x66ddff,
    bore:   0x55ee88,
    planar: 0xeecc55,
    shaft:  0xdd66ff,
    tab:    0xff8855,
    slot:   0xff5577,
    rail:   0x88aaff,
};

export function makeConnectorOverlay(scene, getConnectors, docProvider = null) {
    const group = new THREE.Group();
    group.name = 'connector-overlay';
    group.visible = false;
    scene.add(group);

    let visible = false;
    let lastConnectors = [];

    // Resolve a connector's WORLD frame. A placed part's connectors are stored
    // in component-local mm with a non-identity component origin; rendering /
    // picking at the raw local origin puts the ring at the wrong place (and
    // breaks snapping onto any part not at the world origin). When a docProvider
    // is supplied we walk the component chain via worldConnectorFor; otherwise
    // we fall back to the raw stored frame (pre-existing behaviour).
    function _world(c) {
        if (docProvider) {
            try {
                const doc = docProvider();
                if (doc) return worldConnectorFor(doc, c);
            } catch {}
        }
        return {
            kind: c.kind,
            axis: (Array.isArray(c.axis) ? c.axis : [0, 0, 1]).slice(),
            origin: (Array.isArray(c.origin) ? c.origin : [0, 0, 0]).slice(),
        };
    }
    /** Active compatibility probe: connectors the user is about to mate against. */
    let probeConnectors = null;
    /** Per-connector record: { ring, arrow, baseColor, isCompatible } so we can
     *  re-tint without rebuilding the THREE objects. */
    const meshIndex = new Map();   // connectorId → { ring, arrow, baseColor }

    function _disposeChildren() {
        for (const c of group.children.slice()) {
            group.remove(c);
            if (c.geometry) c.geometry.dispose();
            if (c.material) {
                if (Array.isArray(c.material)) c.material.forEach((m) => m.dispose());
                else c.material.dispose();
            }
        }
        meshIndex.clear();
    }

    function refresh() {
        _disposeChildren();
        const list = (typeof getConnectors === 'function' ? getConnectors() : null) || {};
        const connectors = Array.isArray(list) ? list : Object.values(list);
        lastConnectors = connectors;
        for (const c of connectors) {
            if (!c) continue;
            const colour = COLORS[c.kind] || 0xffffff;
            const ringGeo = new THREE.TorusGeometry(RING_R, 0.15, 8, 24);
            const ringMat = new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity: 0.85 });
            const ring = new THREE.Mesh(ringGeo, ringMat);
            const w = _world(c);
            const origin = w.origin;
            const axis   = w.axis;
            ring.position.set(origin[0], origin[1], origin[2]);
            // Orient ring's normal (default +Z) to the connector axis.
            const n = new THREE.Vector3(axis[0], axis[1], axis[2]).normalize();
            const up = new THREE.Vector3(0, 0, 1);
            const q = new THREE.Quaternion().setFromUnitVectors(up, n);
            ring.quaternion.copy(q);
            ring.userData.connectorId = c.id;
            group.add(ring);

            // Axis arrow.
            const dir = new THREE.Vector3(axis[0], axis[1], axis[2]).normalize();
            const arrow = new THREE.ArrowHelper(dir,
                new THREE.Vector3(origin[0], origin[1], origin[2]),
                ARROW_LEN, colour, 1.5, 0.8);
            arrow.userData.connectorId = c.id;
            group.add(arrow);

            meshIndex.set(c.id, { ring, arrow, baseColor: colour });
        }
        // Re-apply any active compatibility probe so a refresh-during-drag
        // doesn't lose its tinting.
        if (probeConnectors && probeConnectors.length > 0) _applyProbe();
    }

    /**
     * Set the connectors the user is about to mate against. The overlay
     * brightens every existing connector that mates with any of them, and
     * dims the rest. Pass null/empty to clear.
     *
     * @param {Connector[]|null} partConnectors — part-side connectors (the
     *   "I'm about to drop this") to test against. Compatibility is
     *   evaluated with `connectorsCompatible` from mate_solver.
     */
    function setCompatibilityProbe(partConnectors) {
        probeConnectors = Array.isArray(partConnectors) && partConnectors.length > 0
            ? partConnectors
            : null;
        _applyProbe();
    }

    function _applyProbe() {
        for (const [cid, rec] of meshIndex.entries()) {
            const c = lastConnectors.find((x) => x && x.id === cid);
            if (!c) continue;
            let compatible = true;       // no probe → keep base colors
            if (probeConnectors) {
                compatible = probeConnectors.some((pc) => connectorsCompatible(c, pc));
            }
            const target = compatible
                ? (probeConnectors ? 0x6bff8a : rec.baseColor)
                : 0x444444;
            try { rec.ring.material.color.setHex(target); } catch {}
            try { rec.ring.material.opacity = compatible ? 0.95 : 0.25; } catch {}
            try { rec.arrow.setColor(new THREE.Color(target)); } catch {}
        }
    }

    /**
     * Return the connector's `{ kind, axis, origin }` in world coordinates.
     * v1 assumption (matches placeLibraryPart): connectors are stored in
     * world coords already, so this is a near-no-op — but routing through
     * the overlay lets SnapDragController stay agnostic of how connectors
     * are persisted, and lets a future commit swap in proper component-
     * origin composition without touching the controller.
     */
    function getWorldConnector(connectorId) {
        const c = lastConnectors.find((x) => x && x.id === connectorId);
        if (!c) return null;
        return _world(c);
    }

    /**
     * Same as `pickAtCursor` but only returns hits compatible with the
     * active probe. Use this during a drag to make sure non-mateable
     * connectors can't accidentally win the magnet contest.
     */
    function pickCompatibleAtCursor(cursor, camera, viewSize, radius = 24) {
        const hit = pickAtCursor(cursor, camera, viewSize, radius);
        if (!hit || !probeConnectors) return hit;
        if (probeConnectors.some((pc) => connectorsCompatible(hit.connector, pc))) {
            return hit;
        }
        return null;
    }

    function setVisible(b) {
        visible = !!b;
        group.visible = visible;
    }

    /**
     * Pick the closest connector to a screen-space point. `cursor` is
     * `{ x, y }` in device pixels; `camera` is the active perspective
     * camera; `viewSize` is `{ width, height }`.
     *
     * @returns {{ connector: object, distancePx: number }|null}
     */
    function pickAtCursor(cursor, camera, viewSize, radius = 24) {
        if (!camera || !viewSize) return null;
        let best = null;
        let bestD = radius;
        const tmp = new THREE.Vector3();
        for (const c of lastConnectors) {
            if (!c) continue;
            const o = _world(c).origin;
            tmp.set(o[0], o[1], o[2]).project(camera);
            const px = (tmp.x * 0.5 + 0.5) * viewSize.width;
            const py = (-tmp.y * 0.5 + 0.5) * viewSize.height;
            const d = Math.hypot(px - cursor.x, py - cursor.y);
            if (d < bestD) { bestD = d; best = c; }
        }
        return best ? { connector: best, distancePx: bestD } : null;
    }

    function dispose() {
        _disposeChildren();
        scene.remove(group);
    }

    return {
        refresh, setVisible, pickAtCursor,
        setCompatibilityProbe, pickCompatibleAtCursor, getWorldConnector,
        dispose,
        get visible() { return visible; },
        group,
    };
}
