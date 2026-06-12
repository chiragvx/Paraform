/**
 * ViewportHud — persistent bottom-right corner overlay.
 *
 * Renders, in a small floating panel:
 *   - Live cursor XYZ (mm, Z-up). Derived from a raycast against the
 *     ground plane (Z = 0) when no pick-proxy hit is available, or from
 *     the proxy hit's `worldHit` when the cursor is on geometry.
 *   - Active display units label.
 *   - FPS (rAF sampling over a ~500 ms window).
 *   - Selection count (subscribes to a PickingSelection).
 *
 * Anchored to the bottom-right by default so it doesn't collide with the
 * ViewCube (top-right), the section toolbar (top-right under cube), or the
 * selection-filter toolbar (top-center).
 *
 * Pure DOM + raycaster — no Svelte. The Svelte mount is a thin wrapper that
 * supplies host + viewport + selection and disposes on unmount.
 */

import * as THREE from 'three';

const GROUND_Z = 0;

export class ViewportHud {
    /**
     * @param {object} args
     * @param {HTMLElement} args.host    — element to mount the panel into
     * @param {object}      args.viewport — { renderer, camera }
     * @param {object}      [args.pickProxies]
     *        — if supplied, cursor XYZ is taken from a proxy hit; otherwise
     *          we fall back to ray-vs-ground-plane (Z=0).
     * @param {object}      [args.selection]
     *        — PickingSelection; subscribed to drive the "Sel: N" readout.
     * @param {() => string} [args.getUnitLabel]
     *        — return the active unit string ('mm' / 'in' / …). Default 'mm'.
     */
    constructor({ host, viewport, pickProxies = null, selection = null, getUnitLabel = null }) {
        if (!host) throw new Error('ViewportHud: missing host');
        if (!viewport || !viewport.renderer || !viewport.camera) {
            throw new Error('ViewportHud: missing viewport.renderer/camera');
        }
        this.host = host;
        this.viewport = viewport;
        this.pickProxies = pickProxies;
        this.selection = selection;
        this._getUnitLabel = typeof getUnitLabel === 'function' ? getUnitLabel : (() => 'mm');

        this._raycaster = new THREE.Raycaster();
        this._raycaster.params.Line2 = { threshold: 1 };
        this._groundPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -GROUND_Z);

        this._cursor = null;        // [x,y,z] | null
        this._fps = 0;
        this._selCount = selection ? selection.size : 0;

        // ── DOM ──────────────────────────────────────────────────────────────
        this._panel = _buildPanel(host);

        // ── Pointer wiring ───────────────────────────────────────────────────
        this._canvas = viewport.renderer.domElement;
        this._onMove = (ev) => this._handleMove(ev);
        this._onLeave = () => { this._cursor = null; this._render(); };
        this._canvas.addEventListener('pointermove', this._onMove);
        this._canvas.addEventListener('pointerleave', this._onLeave);

        // ── Selection ─────────────────────────────────────────────────────────
        this._offSel = null;
        if (selection) {
            this._offSel = selection.subscribe(() => {
                this._selCount = selection.size;
                this._render();
            });
        }

        // ── FPS loop ─────────────────────────────────────────────────────────
        this._rafId = 0;
        this._frames = 0;
        this._lastSample = performance.now();
        const loop = () => {
            this._frames++;
            const now = performance.now();
            if (now - this._lastSample > 500) {
                this._fps = Math.round((this._frames * 1000) / (now - this._lastSample));
                this._frames = 0;
                this._lastSample = now;
                this._render();
            }
            this._rafId = requestAnimationFrame(loop);
        };
        this._rafId = requestAnimationFrame(loop);

        this._render();
    }

    dispose() {
        cancelAnimationFrame(this._rafId);
        try { this._canvas.removeEventListener('pointermove', this._onMove); } catch {}
        try { this._canvas.removeEventListener('pointerleave', this._onLeave); } catch {}
        try { this._offSel?.(); } catch {}
        if (this._panel?.root?.parentElement) {
            this._panel.root.parentElement.removeChild(this._panel.root);
        }
    }

    // ── Internals ────────────────────────────────────────────────────────────

    _handleMove(ev) {
        const rect = this._canvas.getBoundingClientRect();
        const ndc = {
            x: ((ev.clientX - rect.left) / rect.width) * 2 - 1,
            y: -((ev.clientY - rect.top) / rect.height) * 2 + 1,
        };
        // First try the pick-proxy layer for a true geometry hit.
        let point = null;
        if (this.pickProxies && typeof this.pickProxies.pick === 'function') {
            try {
                const h = this.pickProxies.pick(this.viewport.camera, this._raycaster, ndc);
                if (h && Array.isArray(h.worldHit)) point = h.worldHit;
            } catch {}
        }
        // Fallback: intersect the world ground plane (Z = 0). Most CAD users
        // expect cursor XYZ to mean "where on the work plane am I" when not
        // hovering geometry.
        if (!point) {
            this._raycaster.setFromCamera({ x: ndc.x, y: ndc.y }, this.viewport.camera);
            const target = new THREE.Vector3();
            const hit = this._raycaster.ray.intersectPlane(this._groundPlane, target);
            if (hit) point = [target.x, target.y, target.z];
        }
        this._cursor = point;
        this._render();
    }

    _render() {
        const { xyzKey, xyzEl, unitEl, fpsEl, selEl } = this._panel;
        // Hide the entire XYZ row when there's no valid cursor position — a
        // dangling "XYZ —" row reads as broken state. The row reappears the
        // moment the cursor enters the viewport (ground-plane fallback gives
        // us a position even when not hovering geometry).
        if (this._cursor) {
            xyzKey.style.display = '';
            xyzEl.style.display = '';
            xyzEl.textContent = `${_fmt(this._cursor[0])}, ${_fmt(this._cursor[1])}, ${_fmt(this._cursor[2])}`;
        } else {
            xyzKey.style.display = 'none';
            xyzEl.style.display = 'none';
        }
        unitEl.textContent = this._getUnitLabel();
        fpsEl.textContent = String(this._fps);
        selEl.textContent = String(this._selCount);
    }
}

function _fmt(n) {
    if (!Number.isFinite(n)) return '—';
    return n.toFixed(2);
}

function _buildPanel(host) {
    const root = document.createElement('div');
    root.className = '__pf4_viewport_hud__';
    root.style.cssText = [
        'position:absolute',
        // Bottom-right, lifted above the existing zoom cluster (bottom-3 right-3).
        'right:12px',
        'bottom:108px',
        'z-index:25',
        'min-width:200px',
        'padding:6px 8px',
        'border:1px solid hsl(0 0% 25%)',
        'background:hsl(0 0% 10% / 0.78)',
        'color:hsl(0 0% 88%)',
        'border-radius:4px',
        'font:10px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace',
        'backdrop-filter:blur(4px)',
        'pointer-events:none',
        'display:grid',
        'grid-template-columns:auto 1fr',
        'column-gap:8px',
        'row-gap:2px',
    ].join(';');

    const mk = (label) => {
        const k = document.createElement('span');
        k.textContent = label;
        k.style.cssText = 'opacity:0.55;';
        const v = document.createElement('span');
        v.style.cssText = 'text-align:right;font-variant-numeric:tabular-nums;';
        root.appendChild(k);
        root.appendChild(v);
        return { k, v };
    };

    const xyz = mk('XYZ');
    const unit = mk('Unit');
    const fps = mk('FPS');
    const sel = mk('Sel');

    host.appendChild(root);
    return {
        root,
        xyzKey: xyz.k, xyzEl: xyz.v,
        unitEl: unit.v,
        fpsEl: fps.v,
        selEl: sel.v,
    };
}
