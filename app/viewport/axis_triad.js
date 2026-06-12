/**
 * AxisTriad — bottom-left orientation gnomon.
 *
 * Every professional CAD tool shows a tiny three-axis indicator in a
 * fixed corner so the user always knows which way is +X / +Y / +Z. The
 * widget mirrors the main camera's orientation: when the camera orbits,
 * the triad rotates so its axes still point along world +X/+Y/+Z.
 *
 * Implementation: pure SVG. On each frame we project the unit world
 * basis vectors through the camera's *view* matrix (rotation only — no
 * translation, no perspective divide) into a 2D screen-space basis, and
 * redraw the three colored arrows in that orientation.
 *
 * Cheap enough to run every animation frame (3 vec3·mat4 mults, one
 * SVG attribute update). Repaints only when the projected basis
 * meaningfully changes (avoids style thrash when the camera is idle).
 */

import * as THREE from 'three';

const STYLE_ID = 'pf4-vp-triad-styles';
const CSS = `
.pf4-vp-triad {
    position: absolute;
    left: 16px; bottom: 78px;     /* above timeline + HUD */
    width: 72px; height: 72px;
    pointer-events: none;
    z-index: 55;
    opacity: 0.9;
    filter: drop-shadow(0 2px 4px rgba(0,0,0,0.45));
}
.pf4-vp-triad svg { width: 100%; height: 100%; display: block; }
.pf4-vp-triad-line { stroke-width: 2.2; stroke-linecap: round; fill: none; }
.pf4-vp-triad-label {
    font: bold 10px ui-monospace, "SF Mono", Menlo, monospace;
    paint-order: stroke fill;
    stroke: rgba(15,17,21,0.85);
    stroke-width: 3px;
    stroke-linejoin: round;
    text-anchor: middle;
    dominant-baseline: middle;
    user-select: none;
}
`;

function ensureStyle(doc) {
    if (!doc || doc.getElementById(STYLE_ID)) return;
    const el = doc.createElement('style');
    el.id = STYLE_ID;
    el.textContent = CSS;
    doc.head.appendChild(el);
}

// Standard CAD axis colors. Red = X, Green = Y, Blue = Z.
const AXIS_COLORS = {
    x: '#ff5a5f',
    y: '#7fdc52',
    z: '#5aa9ff',
};

const TMP_V = new THREE.Vector3();
const TMP_Q = new THREE.Quaternion();

let _instance = null;

export function mountAxisTriad(opts = {}) {
    if (_instance) return _instance;
    _instance = new AxisTriad(opts);
    return _instance;
}

export function getAxisTriad() { return _instance; }

class AxisTriad {
    /**
     * @param {object} opts
     * @param {HTMLElement} opts.host
     * @param {() => THREE.Camera} opts.getCamera
     */
    constructor({ host, getCamera, doc = (typeof document !== 'undefined' ? document : null) }) {
        if (!host) throw new Error('AxisTriad: missing host');
        if (typeof getCamera !== 'function') throw new Error('AxisTriad: missing getCamera');
        this.host = host;
        this.doc  = doc;
        this.getCamera = getCamera;
        ensureStyle(doc);
        this._build();
        this._lastQuatStr = '';
        this._raf = null;
        this._tick = this._tick.bind(this);
        this._destroyed = false;
        this._raf = requestAnimationFrame(this._tick);
    }

    _build() {
        const root = this.doc.createElement('div');
        root.className = 'pf4-vp-triad';
        // SVG laid out in a 100x100 canvas, origin at center.
        root.innerHTML =
            `<svg viewBox="-50 -50 100 100" xmlns="http://www.w3.org/2000/svg">` +
              // Three axis lines (origin → tip) — order matters: paint the
              // axis pointing *away* from camera first so the nearest axis
              // overlaps on top.
              `<g data-host="axes"></g>` +
              // Three axis labels.
              `<g data-host="labels"></g>` +
              // Center dot.
              `<circle cx="0" cy="0" r="2.5" fill="#e9e6e0"/>` +
            `</svg>`;
        this.host.appendChild(root);
        this.root = root;
        this._axesHost   = root.querySelector('[data-host="axes"]');
        this._labelsHost = root.querySelector('[data-host="labels"]');
    }

    destroy() {
        this._destroyed = true;
        if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
        if (this.root && this.root.parentNode) this.root.parentNode.removeChild(this.root);
        if (_instance === this) _instance = null;
    }

    _tick() {
        if (this._destroyed) return;
        this._raf = requestAnimationFrame(this._tick);
        const cam = this.getCamera();
        if (!cam) return;
        // Coalesce — only redraw when camera orientation has actually
        // moved. Comparing rounded quaternions is cheap and catches all
        // perceptible motion.
        TMP_Q.copy(cam.quaternion);
        const k = `${TMP_Q.x.toFixed(3)},${TMP_Q.y.toFixed(3)},${TMP_Q.z.toFixed(3)},${TMP_Q.w.toFixed(3)}`;
        if (k === this._lastQuatStr) return;
        this._lastQuatStr = k;
        this._render(cam);
    }

    _render(cam) {
        // Project each world axis tip through the camera's inverse rotation
        // to get screen-space directions. We want the screen X axis pointing
        // right and screen Y axis pointing up (so we negate the camera-frame
        // Y for SVG, which has Y growing downward).
        // Camera-frame coords = (camera-world quaternion)^-1 * worldVec.
        const invQ = TMP_Q.copy(cam.quaternion).invert();
        const axes = [
            { id: 'x', dir: new THREE.Vector3(1, 0, 0), label: 'X', color: AXIS_COLORS.x },
            { id: 'y', dir: new THREE.Vector3(0, 1, 0), label: 'Y', color: AXIS_COLORS.y },
            { id: 'z', dir: new THREE.Vector3(0, 0, 1), label: 'Z', color: AXIS_COLORS.z },
        ];
        // Compute screen-space tip positions (rotated only, no perspective).
        const RADIUS = 32;          // arm length in SVG units
        const TIP_R  = 36;          // label distance
        const projected = axes.map(a => {
            TMP_V.copy(a.dir).applyQuaternion(invQ);
            const sx =  TMP_V.x * RADIUS;
            const sy = -TMP_V.y * RADIUS;
            const tx =  TMP_V.x * TIP_R;
            const ty = -TMP_V.y * TIP_R;
            const depth = TMP_V.z;       // +z = points toward camera
            return { ...a, sx, sy, tx, ty, depth };
        });
        // Painters-algorithm sort: far axes (negative depth) drawn first.
        projected.sort((a, b) => a.depth - b.depth);

        const lines = projected.map(p => {
            const opacity = 0.65 + 0.35 * ((p.depth + 1) / 2); // far axes dimmer
            return (
                `<line class="pf4-vp-triad-line"` +
                ` x1="0" y1="0" x2="${p.sx.toFixed(2)}" y2="${p.sy.toFixed(2)}"` +
                ` stroke="${p.color}" opacity="${opacity.toFixed(2)}"/>` +
                // Arrow head — small filled circle at tip
                `<circle cx="${p.sx.toFixed(2)}" cy="${p.sy.toFixed(2)}" r="3.5"` +
                ` fill="${p.color}" opacity="${opacity.toFixed(2)}"/>`
            );
        }).join('');

        const labels = projected.map(p => {
            const opacity = 0.7 + 0.3 * ((p.depth + 1) / 2);
            return (
                `<text class="pf4-vp-triad-label" x="${p.tx.toFixed(2)}" y="${p.ty.toFixed(2)}"` +
                ` fill="${p.color}" opacity="${opacity.toFixed(2)}">${p.label}</text>`
            );
        }).join('');

        this._axesHost.innerHTML = lines;
        this._labelsHost.innerHTML = labels;
    }
}
