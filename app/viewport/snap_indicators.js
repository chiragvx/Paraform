/**
 * SnapIndicators — ghost markers + cursor magnetization for measure / gizmo drag.
 *
 * Given the bridge's `geometry` blob (per-face triangulations + per-edge
 * polylines) the engine builds a flat list of snap candidates:
 *   - vertex       (red)   from edge polyline endpoints
 *   - midpoint     (green) from edge polyline midpoint sample
 *   - center       (blue)  from face center (kernel-provided)
 *
 * Each frame (or on cursor move) the caller pipes the pointer screen position
 * + camera into `pick(ndcX, ndcY)`. The engine projects every candidate to
 * screen, finds the nearest within `MAGNET_PX`, and exposes the snap's world
 * point + kind. Visual indicators show every nearby candidate (within
 * `SHOW_PX`) so the user can preview alternatives before committing.
 *
 * Z-up correct: all candidate points are in world-frame mm (the same frame
 * the kernel emits), no GLB-wrap involvement.
 */

import * as THREE from 'three';

const MAGNET_PX = 10;        // cursor magnetizes within this many screen px
const SHOW_PX   = 28;        // markers visible for candidates within this many px
const MARKER_RADIUS_PX = 5;  // visual marker size on screen

// Snap-type → CSS colour (in the HUD overlay) and three.js colour (sphere ghosts).
const COLOURS = Object.freeze({
    vertex:   { hex: 0xff5252, css: '#ff5252' },
    midpoint: { hex: 0x6bcf63, css: '#6bcf63' },
    center:   { hex: 0x4fb3ff, css: '#4fb3ff' },
});

/**
 * Build a snap-candidate list from the kernel-shipped geometry blob.
 * Returns plain points (no THREE objects) so consumers can stash them in
 * userData / cache.
 *
 * @param {{faces?:object, edges?:object}} geometry  — bridge.geometry
 * @returns {Array<{point: [number,number,number], kind: 'vertex'|'midpoint'|'center'}>}
 */
export function buildSnapCandidates(geometry) {
    const out = [];
    if (!geometry) return out;
    const edges = geometry.edges || {};
    for (const key of Object.keys(edges)) {
        const src = edges[key];
        if (!src || !Array.isArray(src.points) || src.points.length < 6) continue;
        // Vertices: first + last polyline point.
        const n = src.points.length;
        out.push({ point: [src.points[0], src.points[1], src.points[2]], kind: 'vertex' });
        out.push({ point: [src.points[n - 3], src.points[n - 2], src.points[n - 1]], kind: 'vertex' });
        // Midpoint: middle sample of the polyline (cheap; not arc-length parameterized).
        const midIdx = Math.floor((n / 3) / 2) * 3;
        out.push({ point: [src.points[midIdx], src.points[midIdx + 1], src.points[midIdx + 2]], kind: 'midpoint' });
    }
    const faces = geometry.faces || {};
    for (const key of Object.keys(faces)) {
        const src = faces[key];
        if (!src) continue;
        if (Array.isArray(src.center)) {
            out.push({ point: src.center.slice(), kind: 'center' });
        }
    }
    return out;
}

/**
 * Mount a screen-space HTML overlay (absolutely positioned dots) that renders
 * snap markers near the cursor. Returns a controller the caller drives:
 *
 *   const snap = mountSnapIndicators({ host, camera, renderer });
 *   snap.setCandidates(buildSnapCandidates(bridge.geometry));
 *   snap.update({ clientX, clientY });   // returns { point, kind } | null
 *   snap.setVisible(true);
 *   snap.dispose();
 */
export function mountSnapIndicators({ host, camera, renderer }) {
    if (!host || !camera || !renderer) {
        throw new Error('mountSnapIndicators: host/camera/renderer required');
    }
    const overlay = document.createElement('div');
    overlay.className = 'pf-snap-indicators';
    Object.assign(overlay.style, {
        position: 'absolute', inset: '0',
        pointerEvents: 'none', zIndex: '12',
        display: 'none',
    });
    host.appendChild(overlay);

    /** @type {Array<{point:[number,number,number], kind:string}>} */
    let candidates = [];
    /** @type {HTMLDivElement[]} */
    let markerPool = [];
    let visible = false;
    let lastSnap = null;

    function setVisible(on) {
        visible = !!on;
        overlay.style.display = visible ? 'block' : 'none';
        if (!visible) {
            for (const m of markerPool) m.style.display = 'none';
            lastSnap = null;
        }
    }

    function setCandidates(arr) {
        candidates = Array.isArray(arr) ? arr.slice() : [];
        lastSnap = null;
    }

    function ensureMarker(idx) {
        let el = markerPool[idx];
        if (el) return el;
        el = document.createElement('div');
        Object.assign(el.style, {
            position: 'absolute',
            width: (MARKER_RADIUS_PX * 2) + 'px',
            height: (MARKER_RADIUS_PX * 2) + 'px',
            borderRadius: '50%',
            border: '2px solid #fff',
            boxShadow: '0 0 4px rgba(0,0,0,0.55)',
            transform: 'translate(-50%, -50%)',
            pointerEvents: 'none',
            display: 'none',
        });
        overlay.appendChild(el);
        markerPool[idx] = el;
        return el;
    }

    const _v = new THREE.Vector3();
    function projectToScreen(p) {
        _v.set(p[0], p[1], p[2]).project(camera);
        if (_v.z < -1 || _v.z > 1) return null;          // behind camera / outside near-far
        const rect = renderer.domElement.getBoundingClientRect();
        const hostRect = host.getBoundingClientRect();
        const sx = ( _v.x + 1) * 0.5 * rect.width  + (rect.left - hostRect.left);
        const sy = (-_v.y + 1) * 0.5 * rect.height + (rect.top  - hostRect.top);
        return { x: sx, y: sy };
    }

    /**
     * Pipe a pointer event in. Returns the magnetized snap target or null.
     * @param {{clientX:number, clientY:number}} ev
     */
    function update(ev) {
        if (!visible) return null;
        const hostRect = host.getBoundingClientRect();
        const cx = ev.clientX - hostRect.left;
        const cy = ev.clientY - hostRect.top;
        let best = null;
        let bestDist = Infinity;
        // Hide all markers; we'll un-hide visible ones below.
        for (let i = 0; i < markerPool.length; i++) markerPool[i].style.display = 'none';
        let visibleIdx = 0;
        for (let i = 0; i < candidates.length; i++) {
            const c = candidates[i];
            const sp = projectToScreen(c.point);
            if (!sp) continue;
            const d = Math.hypot(sp.x - cx, sp.y - cy);
            if (d > SHOW_PX) continue;
            const colour = COLOURS[c.kind] || COLOURS.center;
            const m = ensureMarker(visibleIdx++);
            m.style.left = sp.x + 'px';
            m.style.top  = sp.y + 'px';
            m.style.background = colour.css;
            m.style.display = 'block';
            // Highlight the magnetized winner with a brighter ring.
            m.style.opacity = (d <= MAGNET_PX) ? '1' : '0.5';
            if (d < bestDist && d <= MAGNET_PX) {
                bestDist = d;
                best = { point: c.point.slice(), kind: c.kind, screen: sp };
            }
        }
        lastSnap = best;
        return best;
    }

    function dispose() {
        try { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); } catch {}
        markerPool = [];
        candidates = [];
        lastSnap = null;
    }

    return {
        setCandidates,
        setVisible,
        update,
        get last() { return lastSnap; },
        dispose,
    };
}

export const SNAP_COLOURS = COLOURS;
