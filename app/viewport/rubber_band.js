/**
 * Rubber-band selection — drag in empty space to box-select.
 *
 * AutoCAD/SolidWorks/Fusion convention:
 *   - Drag left-to-right  → WINDOW (solid rectangle); requires entities to
 *                            be FULLY ENCLOSED by the box.
 *   - Drag right-to-left  → CROSSING (dashed rectangle); selects entities
 *                            that ARE TOUCHED OR INTERSECT the box.
 *
 * Visual colours follow the research:
 *   - Window:   #4FB3FF translucent fill, solid blue border
 *   - Crossing: #6BCF63 translucent fill, dashed green border
 *
 * Pickables are supplied by the host as a function returning a flat list
 * of Three.js Object3Ds (typically the bodies group's children). For each
 * pickable, we project its world-space AABB corners to screen space and
 * decide enclosed vs. intersect.
 */

import * as THREE from 'three';

// Fusion / SolidWorks visual conventions:
//   Window  (L→R): thin solid blue border, no fill — the model itself tints
//                  warm orange to PREVIEW what will be selected on release.
//   Crossing (R→L): thin dashed green border, same warm-orange model tint.
const WINDOW_FILL   = 'transparent';
const WINDOW_BORDER = '#4FB3FF';
const CROSS_FILL    = 'transparent';
const CROSS_BORDER  = '#6BCF63';

const MIN_DRAG_PX = 4;   // dead-zone before we treat a click as a drag

const _v = new THREE.Vector3();
const _raycaster = new THREE.Raycaster();

export class RubberBand {
    /**
     * @param {object}   args
     * @param {HTMLElement} args.container         — viewport container (position:relative)
     * @param {HTMLCanvasElement} args.canvas      — the renderer's domElement
     * @param {THREE.Camera} args.camera
     * @param {() => THREE.Object3D[]} args.pickablesProvider
     * @param {(picks: THREE.Object3D[], mode: 'window'|'crossing', additive: boolean) => void} args.onCommit
     * @param {() => boolean} [args.isEnabled]     — return false to suppress
     */
    constructor({ container, canvas, camera, pickablesProvider, onCommit,
                  onCandidateChange = null, isEnabled = () => true }) {
        this.container = container;
        this.canvas    = canvas;
        this.camera    = camera;
        this.pickablesProvider = pickablesProvider;
        this.onCommit  = onCommit || (() => {});
        /** Fires every move while dragging with the current candidate set so
         *  the host can apply a "would-be-selected" preview tint. Null when
         *  the host doesn't want previews — we then skip the per-move
         *  `_collect()` (8-corner projections × N pickables) entirely. */
        this.onCandidateChange = onCandidateChange || null;
        this.isEnabled = isEnabled;

        this._down = null;
        this._rectEl = null;
        this._mode = null;  // 'window' | 'crossing'
        this._lastCandidatesKey = '';   // dedupe rapid onCandidateChange fires

        // rAF-coalesce per-move work. High-Hz mice fire pointermove 120+× per
        // second; we only need to update the rect / candidate preview once
        // per render frame. Store the latest pointer position and flush on
        // the next rAF.
        this._pendingMove = null;
        this._rafId = 0;
        this._flushMove = () => {
            this._rafId = 0;
            const ev = this._pendingMove;
            this._pendingMove = null;
            if (ev) this._applyMove(ev);
        };

        this._onDown = (e) => this._handleDown(e);
        this._onMove = (e) => this._handleMove(e);
        this._onUp   = (e) => this._handleUp(e);

        this.canvas.addEventListener('pointerdown', this._onDown);
        window.addEventListener('pointermove', this._onMove);
        window.addEventListener('pointerup',   this._onUp);
    }

    dispose() {
        this.canvas.removeEventListener('pointerdown', this._onDown);
        window.removeEventListener('pointermove', this._onMove);
        window.removeEventListener('pointerup',   this._onUp);
        if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = 0; }
        this._pendingMove = null;
        this._teardownRect();
    }

    _handleDown(ev) {
        if (!this.isEnabled()) return;
        // Only LMB. Shift+drag-from-empty is reserved for the LassoPaintSelect
        // gesture (viewport-v3 #8); we yield it here so the two gestures don't
        // fight. Additive rectangle selection still available via Ctrl+drag.
        if (ev.button !== 0) return;
        if (ev.altKey) return;
        if (ev.shiftKey) return;
        // Fusion/SW convention: marquee only starts from EMPTY SPACE.
        // If the pointer-down hits a body, leave it to the face/edge picker.
        if (this._pointerHitsBody(ev)) return;
        // Defer commitment to up — the picking wiring may want this click.
        this._down = { x: ev.clientX, y: ev.clientY, shift: ev.shiftKey, started: false };
    }

    /** True if the pointer-down ray hits any pickable body. */
    _pointerHitsBody(ev) {
        const items = this.pickablesProvider();
        if (!items || items.length === 0) return false;
        const rect = this.canvas.getBoundingClientRect();
        const ndc = {
            x:  ((ev.clientX - rect.left) / rect.width)  * 2 - 1,
            y: -((ev.clientY - rect.top)  / rect.height) * 2 + 1,
        };
        _raycaster.setFromCamera({ x: ndc.x, y: ndc.y }, this.camera);
        const hits = _raycaster.intersectObjects(items, true);
        return !!(hits && hits.length);
    }

    _handleMove(ev) {
        if (!this._down) return;
        // Cheap dead-zone check stays on the hot path so a stationary press
        // doesn't even allocate the pending-move record.
        if (!this._down.started) {
            const dx = ev.clientX - this._down.x;
            const dy = ev.clientY - this._down.y;
            if (Math.hypot(dx, dy) < MIN_DRAG_PX) return;
        }
        // Stash the latest position; rAF will flush.
        this._pendingMove = { x: ev.clientX, y: ev.clientY };
        if (!this._rafId) this._rafId = requestAnimationFrame(this._flushMove);
    }

    _applyMove(ev) {
        if (!this._down) return;
        if (!this._down.started) {
            this._down.started = true;
            this._mode = (ev.x - this._down.x) >= 0 ? 'window' : 'crossing';
            this._ensureRect();
        }
        // Mode can flip mid-drag if the user crosses back.
        const mode = (ev.x >= this._down.x) ? 'window' : 'crossing';
        if (mode !== this._mode) {
            this._mode = mode;
            this._styleRect();
        }
        this._positionRect(this._down.x, this._down.y, ev.x, ev.y);
        // Live preview only when the host actually wants it — `_collect()`
        // projects 8 AABB corners per pickable, which dominates per-move
        // cost. Skipping it when no preview callback is wired makes the
        // rubber-band cursor-locked even on dense scenes.
        if (this.onCandidateChange) {
            this._emitCandidates(this._down.x, this._down.y, ev.x, ev.y, mode);
        }
    }

    _emitCandidates(x1, y1, x2, y2, mode) {
        const rectCanvas = this.canvas.getBoundingClientRect();
        const rect = {
            left:   Math.min(x1, x2),
            right:  Math.max(x1, x2),
            top:    Math.min(y1, y2),
            bottom: Math.max(y1, y2),
        };
        const picks = this._collect(mode, rect);
        // Dedupe — onCandidateChange is hot.
        const key = picks.map(o => o.id || o.uuid || '').join(',');
        if (key === this._lastCandidatesKey) return;
        this._lastCandidatesKey = key;
        try { this.onCandidateChange(picks, mode); } catch {}
    }

    _handleUp(ev) {
        if (!this._down) return;
        // Cancel any pending rAF — the up event supersedes the queued move.
        if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = 0; }
        this._pendingMove = null;
        const started = this._down.started;
        const shift = this._down.shift;
        const startX = this._down.x, startY = this._down.y;
        this._down = null;
        this._teardownRect();
        // Clear candidate preview before commit; commit applies the real
        // selection tint.
        if (started) {
            if (this.onCandidateChange) {
                try { this.onCandidateChange([], null); } catch {}
            }
            this._lastCandidatesKey = '';
        }
        if (!started) return;
        // Compute picks.
        const left   = Math.min(startX, ev.clientX);
        const right  = Math.max(startX, ev.clientX);
        const top    = Math.min(startY, ev.clientY);
        const bottom = Math.max(startY, ev.clientY);
        const mode = (ev.clientX >= startX) ? 'window' : 'crossing';
        const picks = this._collect(mode, { left, right, top, bottom });
        this.onCommit(picks, mode, shift);
    }

    _collect(mode, rect) {
        const items = this.pickablesProvider() || [];
        if (items.length === 0) return [];
        const rectCanvas = this.canvas.getBoundingClientRect();
        const screenRect = {
            left:   rect.left   - rectCanvas.left,
            right:  rect.right  - rectCanvas.left,
            top:    rect.top    - rectCanvas.top,
            bottom: rect.bottom - rectCanvas.top,
        };
        const W = rectCanvas.width, H = rectCanvas.height;
        const picks = [];
        for (const obj of items) {
            const proj = this._projectAABB(obj, W, H);
            if (!proj) continue;
            if (mode === 'window') {
                // Fully enclosed.
                if (proj.minX >= screenRect.left && proj.maxX <= screenRect.right
                 && proj.minY >= screenRect.top  && proj.maxY <= screenRect.bottom) {
                    picks.push(obj);
                }
            } else {
                // Intersecting OR enclosed.
                const overlap = !(proj.maxX < screenRect.left || proj.minX > screenRect.right
                              ||  proj.maxY < screenRect.top  || proj.minY > screenRect.bottom);
                if (overlap) picks.push(obj);
            }
        }
        return picks;
    }

    _projectAABB(obj, W, H) {
        const box = new THREE.Box3().setFromObject(obj);
        if (box.isEmpty()) return null;
        const corners = [
            new THREE.Vector3(box.min.x, box.min.y, box.min.z),
            new THREE.Vector3(box.max.x, box.min.y, box.min.z),
            new THREE.Vector3(box.min.x, box.max.y, box.min.z),
            new THREE.Vector3(box.max.x, box.max.y, box.min.z),
            new THREE.Vector3(box.min.x, box.min.y, box.max.z),
            new THREE.Vector3(box.max.x, box.min.y, box.max.z),
            new THREE.Vector3(box.min.x, box.max.y, box.max.z),
            new THREE.Vector3(box.max.x, box.max.y, box.max.z),
        ];
        let minX =  Infinity, minY =  Infinity;
        let maxX = -Infinity, maxY = -Infinity;
        for (const c of corners) {
            _v.copy(c).project(this.camera);
            const sx = ( _v.x + 1) * 0.5 * W;
            const sy = (-_v.y + 1) * 0.5 * H;
            if (sx < minX) minX = sx;
            if (sx > maxX) maxX = sx;
            if (sy < minY) minY = sy;
            if (sy > maxY) maxY = sy;
        }
        return { minX, minY, maxX, maxY };
    }

    _ensureRect() {
        if (this._rectEl) return;
        const el = document.createElement('div');
        el.className = 'pf-rubber-band';
        Object.assign(el.style, {
            position: 'absolute',
            pointerEvents: 'none',
            border:  '1px solid ' + WINDOW_BORDER,
            background: WINDOW_FILL,
            zIndex: '4',
        });
        this.container.appendChild(el);
        this._rectEl = el;
        this._styleRect();
    }

    _styleRect() {
        if (!this._rectEl) return;
        if (this._mode === 'window') {
            this._rectEl.style.borderWidth = '1.5px';
            this._rectEl.style.borderColor = WINDOW_BORDER;
            this._rectEl.style.borderStyle = 'solid';
            this._rectEl.style.background  = WINDOW_FILL;
        } else {
            this._rectEl.style.borderWidth = '1.5px';
            this._rectEl.style.borderColor = CROSS_BORDER;
            this._rectEl.style.borderStyle = 'dashed';
            this._rectEl.style.background  = CROSS_FILL;
        }
    }

    _positionRect(x1, y1, x2, y2) {
        if (!this._rectEl) return;
        const rect = this.container.getBoundingClientRect();
        const left   = Math.min(x1, x2) - rect.left;
        const top    = Math.min(y1, y2) - rect.top;
        const width  = Math.abs(x2 - x1);
        const height = Math.abs(y2 - y1);
        this._rectEl.style.left   = left + 'px';
        this._rectEl.style.top    = top  + 'px';
        this._rectEl.style.width  = width + 'px';
        this._rectEl.style.height = height + 'px';
    }

    _teardownRect() {
        if (!this._rectEl) return;
        if (this._rectEl.parentNode) this._rectEl.parentNode.removeChild(this._rectEl);
        this._rectEl = null;
    }
}

/**
 * Pure helper: given screen-projected AABB corners and a rect, decide
 * window/crossing membership. Exported for testing.
 */
export function decideMembership(mode, rect, projected) {
    if (mode === 'window') {
        return projected.minX >= rect.left && projected.maxX <= rect.right
            && projected.minY >= rect.top  && projected.maxY <= rect.bottom;
    }
    return !(projected.maxX < rect.left || projected.minX > rect.right
          || projected.maxY < rect.top  || projected.minY > rect.bottom);
}
