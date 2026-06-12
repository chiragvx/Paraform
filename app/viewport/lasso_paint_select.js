/**
 * LassoPaintSelect — freehand lasso + paint-select gestures.
 *
 *   Shift + LMB drag (from empty space) → freehand polygon → point-in-poly
 *                                          membership on release. Point used
 *                                          per body is the screen projection
 *                                          of its AABB centre.
 *   P + LMB drag                         → "paint-select" — every body whose
 *                                          screen-projected AABB centre falls
 *                                          within a small radius of the cursor
 *                                          path joins the selection.
 *
 * Both gestures call `onCommit(pickedObjects, mode, additive)` with mode
 * ∈ {'lasso', 'paint'} and additive=true (these are extension gestures —
 * they're always additive on top of the existing selection).
 *
 * The lasso visual is a stroked SVG polyline; the paint visual is a small
 * outlined cursor disc.
 *
 * The host gates the gesture with `isEnabled()` so we don't compete with
 * the rubber-band (which fires on plain Shift-less LMB drag).
 */

import * as THREE from 'three';

const MIN_DRAG_PX     = 4;
const PAINT_RADIUS_PX = 12;
const _v = new THREE.Vector3();

export class LassoPaintSelect {
    /**
     * @param {object} args
     * @param {HTMLElement}       args.container
     * @param {HTMLCanvasElement} args.canvas
     * @param {THREE.Camera}      args.camera
     * @param {() => THREE.Object3D[]} args.pickablesProvider
     * @param {(picks: THREE.Object3D[], mode: 'lasso'|'paint', additive: boolean) => void} args.onCommit
     * @param {() => boolean} [args.isEnabled]
     */
    constructor({ container, canvas, camera, pickablesProvider, onCommit, isEnabled = () => true }) {
        this.container = container;
        this.canvas    = canvas;
        this.camera    = camera;
        this.pickablesProvider = pickablesProvider;
        this.onCommit  = onCommit || (() => {});
        this.isEnabled = isEnabled;

        this._down = null;     // { mode, points: [{x,y}, …], shift, paintHits: Set<obj> }
        this._svg = null;
        this._poly = null;
        this._paintCursor = null;
        this._paintActive = false;  // P key held

        this._onKey  = (e) => this._handleKey(e);
        this._onKeyUp = (e) => this._handleKeyUp(e);
        this._onDown = (e) => this._handleDown(e);
        this._onMove = (e) => this._handleMove(e);
        this._onUp   = (e) => this._handleUp(e);

        window.addEventListener('keydown', this._onKey);
        window.addEventListener('keyup', this._onKeyUp);
        this.canvas.addEventListener('pointerdown', this._onDown);
        window.addEventListener('pointermove', this._onMove);
        window.addEventListener('pointerup', this._onUp);
    }

    dispose() {
        window.removeEventListener('keydown', this._onKey);
        window.removeEventListener('keyup', this._onKeyUp);
        this.canvas.removeEventListener('pointerdown', this._onDown);
        window.removeEventListener('pointermove', this._onMove);
        window.removeEventListener('pointerup', this._onUp);
        this._teardownVisual();
    }

    _isTyping(t) {
        return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    }

    _handleKey(e) {
        if (this._isTyping(e.target)) return;
        if (e.key === 'p' || e.key === 'P') this._paintActive = true;
    }
    _handleKeyUp(e) {
        if (e.key === 'p' || e.key === 'P') this._paintActive = false;
    }

    _handleDown(ev) {
        if (!this.isEnabled()) return;
        if (ev.button !== 0) return;
        // Paint-select: requires P held.
        if (this._paintActive) {
            this._down = {
                mode: 'paint',
                points: [{ x: ev.clientX, y: ev.clientY }],
                shift: true,
                paintHits: new Set(),
                started: false,
            };
            this._ensurePaintCursor();
            this._positionPaintCursor(ev.clientX, ev.clientY);
            return;
        }
        // Lasso: Shift + drag from empty (no body under cursor).
        if (!ev.shiftKey) return;
        if (this._pointerHitsBody(ev)) return;
        this._down = {
            mode: 'lasso',
            points: [{ x: ev.clientX, y: ev.clientY }],
            shift: true,
            started: false,
        };
    }

    _pointerHitsBody(ev) {
        const items = this.pickablesProvider();
        if (!items || items.length === 0) return false;
        const rect = this.canvas.getBoundingClientRect();
        const ndc = {
            x:  ((ev.clientX - rect.left) / rect.width)  * 2 - 1,
            y: -((ev.clientY - rect.top)  / rect.height) * 2 + 1,
        };
        const rc = new THREE.Raycaster();
        rc.setFromCamera({ x: ndc.x, y: ndc.y }, this.camera);
        const hits = rc.intersectObjects(items, true);
        return !!(hits && hits.length);
    }

    _handleMove(ev) {
        if (!this._down) return;
        const pts = this._down.points;
        const last = pts[pts.length - 1];
        const d = Math.hypot(ev.clientX - last.x, ev.clientY - last.y);
        if (!this._down.started && d < MIN_DRAG_PX) return;
        if (!this._down.started) {
            this._down.started = true;
            if (this._down.mode === 'lasso') this._ensureLassoVisual();
        }
        // Decimate: only sample if we've moved at least 3 px since last point.
        if (d >= 3) pts.push({ x: ev.clientX, y: ev.clientY });
        if (this._down.mode === 'lasso') {
            this._updateLassoVisual();
        } else {
            this._positionPaintCursor(ev.clientX, ev.clientY);
            this._accumulatePaintHits(ev.clientX, ev.clientY);
        }
    }

    _handleUp(ev) {
        if (!this._down) return;
        const drag = this._down;
        this._down = null;
        this._teardownVisual();
        if (!drag.started) return;
        if (drag.mode === 'lasso') {
            const picks = this._collectLasso(drag.points);
            this.onCommit(picks, 'lasso', true);
        } else {
            const picks = [...drag.paintHits];
            this.onCommit(picks, 'paint', true);
        }
    }

    // ── Lasso geometry ─────────────────────────────────────────────────
    _collectLasso(points) {
        const items = this.pickablesProvider() || [];
        if (items.length === 0 || points.length < 3) return [];
        const rect = this.canvas.getBoundingClientRect();
        // Convert lasso points from clientX/Y to canvas-local px.
        const poly = points.map((p) => ({ x: p.x - rect.left, y: p.y - rect.top }));
        const W = rect.width, H = rect.height;
        const picks = [];
        for (const obj of items) {
            const centre = this._projectAABBCenter(obj, W, H);
            if (!centre) continue;
            if (_pointInPolygon(centre.x, centre.y, poly)) picks.push(obj);
        }
        return picks;
    }

    _accumulatePaintHits(cx, cy) {
        const items = this.pickablesProvider() || [];
        if (items.length === 0) return;
        const rect = this.canvas.getBoundingClientRect();
        const W = rect.width, H = rect.height;
        const localX = cx - rect.left, localY = cy - rect.top;
        for (const obj of items) {
            if (this._down.paintHits.has(obj)) continue;
            const c = this._projectAABBCenter(obj, W, H);
            if (!c) continue;
            const d = Math.hypot(c.x - localX, c.y - localY);
            if (d <= PAINT_RADIUS_PX) this._down.paintHits.add(obj);
        }
    }

    _projectAABBCenter(obj, W, H) {
        const box = new THREE.Box3().setFromObject(obj);
        if (box.isEmpty()) return null;
        const c = box.getCenter(new THREE.Vector3());
        _v.copy(c).project(this.camera);
        return {
            x: ( _v.x + 1) * 0.5 * W,
            y: (-_v.y + 1) * 0.5 * H,
        };
    }

    // ── Visuals ────────────────────────────────────────────────────────
    _ensureLassoVisual() {
        if (this._svg) return;
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        Object.assign(svg.style, {
            position: 'absolute', inset: '0',
            pointerEvents: 'none', zIndex: '5',
            overflow: 'visible',
        });
        const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
        poly.setAttribute('fill', 'rgba(79,179,255,0.10)');
        poly.setAttribute('stroke', '#4FB3FF');
        poly.setAttribute('stroke-width', '1.5');
        poly.setAttribute('stroke-dasharray', '4 3');
        svg.appendChild(poly);
        this.container.appendChild(svg);
        this._svg = svg;
        this._poly = poly;
    }

    _updateLassoVisual() {
        if (!this._poly || !this._down) return;
        const rect = this.container.getBoundingClientRect();
        const pts = this._down.points
            .map((p) => `${p.x - rect.left},${p.y - rect.top}`)
            .join(' ');
        this._poly.setAttribute('points', pts);
    }

    _ensurePaintCursor() {
        if (this._paintCursor) return;
        const el = document.createElement('div');
        Object.assign(el.style, {
            position: 'absolute',
            width:  (PAINT_RADIUS_PX * 2) + 'px',
            height: (PAINT_RADIUS_PX * 2) + 'px',
            borderRadius: '50%',
            border: '1.5px dashed #ff8c28',
            background: 'rgba(255,140,40,0.10)',
            transform: 'translate(-50%, -50%)',
            pointerEvents: 'none',
            zIndex: '6',
        });
        this.container.appendChild(el);
        this._paintCursor = el;
    }

    _positionPaintCursor(cx, cy) {
        if (!this._paintCursor) return;
        const rect = this.container.getBoundingClientRect();
        this._paintCursor.style.left = (cx - rect.left) + 'px';
        this._paintCursor.style.top  = (cy - rect.top)  + 'px';
    }

    _teardownVisual() {
        if (this._svg && this._svg.parentNode) this._svg.parentNode.removeChild(this._svg);
        this._svg = null; this._poly = null;
        if (this._paintCursor && this._paintCursor.parentNode) this._paintCursor.parentNode.removeChild(this._paintCursor);
        this._paintCursor = null;
    }
}

/** Even-odd point-in-polygon test. Polygon is an array of {x,y}. */
function _pointInPolygon(px, py, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i].x, yi = poly[i].y;
        const xj = poly[j].x, yj = poly[j].y;
        const intersect = ((yi > py) !== (yj > py)) &&
            (px < (xj - xi) * (py - yi) / ((yj - yi) || 1e-12) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}

export { _pointInPolygon as pointInPolygon };
