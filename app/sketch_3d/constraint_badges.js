/**
 * Constraint badges — small HTML icons positioned over the canvas at each
 * constraint's anchor point. Click a badge to remove that constraint.
 *
 * Rendering:
 *   - Badges are CSS-positioned `<button>` elements inside a single host
 *     `<div>` overlay so we don't churn the DOM tree.
 *   - On every refresh we walk the live SketchData, compute each
 *     constraint's anchor in sketch-local 2D, project to screen via the
 *     controller's `_localToScreen`, and reposition the matching badge.
 *   - We call `refresh()` on every commit + on every camera tick (cheap;
 *     no Three.js calls — just a CSS transform per badge).
 *
 * Badge text is a short symbol per constraint kind (no font dependency).
 */

import { CONSTRAINT_KIND, isDimensional } from '../../lib/sketch/constraints.js';
import { ENTITY_KIND } from '../../lib/sketch/entities.js';
import { removeConstraint, setConstraintValue } from '../../lib/sketch/sketch_data.js';

const SYMBOLS = Object.freeze({
    [CONSTRAINT_KIND.COINCIDENT]:           '◉',
    [CONSTRAINT_KIND.HORIZONTAL]:           'H',
    [CONSTRAINT_KIND.VERTICAL]:             'V',
    [CONSTRAINT_KIND.PARALLEL]:             '∥',
    [CONSTRAINT_KIND.PERPENDICULAR]:        '⊥',
    [CONSTRAINT_KIND.TANGENT]:              'T',
    [CONSTRAINT_KIND.EQUAL_LENGTH]:         '=',
    [CONSTRAINT_KIND.EQUAL_RADIUS]:         'R=',
    [CONSTRAINT_KIND.MIDPOINT]:             '▸',
    [CONSTRAINT_KIND.SYMMETRIC]:            '⇋',
    [CONSTRAINT_KIND.POINT_ON_LINE]:        '•—',
    [CONSTRAINT_KIND.POINT_ON_CIRCLE]:      '•○',
    [CONSTRAINT_KIND.FIXED_DISTANCE]:       '↔',
    [CONSTRAINT_KIND.HORIZONTAL_DISTANCE]:  '↔H',
    [CONSTRAINT_KIND.VERTICAL_DISTANCE]:    '↕V',
    [CONSTRAINT_KIND.EQUAL_DISTANCE]:       '↔=',
    [CONSTRAINT_KIND.FIXED_ANGLE]:          '∠',
    [CONSTRAINT_KIND.FIXED_RADIUS]:         'R',
    [CONSTRAINT_KIND.FIXED_POINT]:          '⌖',
});

const LABELS = Object.freeze({
    [CONSTRAINT_KIND.COINCIDENT]:           'Coincident',
    [CONSTRAINT_KIND.HORIZONTAL]:           'Horizontal',
    [CONSTRAINT_KIND.VERTICAL]:             'Vertical',
    [CONSTRAINT_KIND.PARALLEL]:             'Parallel',
    [CONSTRAINT_KIND.PERPENDICULAR]:        'Perpendicular',
    [CONSTRAINT_KIND.TANGENT]:              'Tangent',
    [CONSTRAINT_KIND.EQUAL_LENGTH]:         'Equal length',
    [CONSTRAINT_KIND.EQUAL_RADIUS]:         'Equal radius',
    [CONSTRAINT_KIND.MIDPOINT]:             'Midpoint',
    [CONSTRAINT_KIND.SYMMETRIC]:            'Symmetric',
    [CONSTRAINT_KIND.POINT_ON_LINE]:        'Point on line',
    [CONSTRAINT_KIND.POINT_ON_CIRCLE]:      'Point on circle',
    [CONSTRAINT_KIND.FIXED_DISTANCE]:       'Distance',
    [CONSTRAINT_KIND.HORIZONTAL_DISTANCE]:  'H-distance',
    [CONSTRAINT_KIND.VERTICAL_DISTANCE]:    'V-distance',
    [CONSTRAINT_KIND.EQUAL_DISTANCE]:       'Equal distance',
    [CONSTRAINT_KIND.FIXED_ANGLE]:          'Angle',
    [CONSTRAINT_KIND.FIXED_RADIUS]:         'Radius',
    [CONSTRAINT_KIND.FIXED_POINT]:          'Fixed point',
});

const UNITS = Object.freeze({
    [CONSTRAINT_KIND.FIXED_DISTANCE]:      'mm',
    [CONSTRAINT_KIND.HORIZONTAL_DISTANCE]: 'mm',
    [CONSTRAINT_KIND.VERTICAL_DISTANCE]:   'mm',
    [CONSTRAINT_KIND.FIXED_RADIUS]:        'mm',
    [CONSTRAINT_KIND.FIXED_ANGLE]:         '°',
});

// ── Anchor computation per constraint kind ──────────────────────────────────

function entityAt(sketch, id) { return sketch.entities[id] || null; }

/**
 * Returns the sketch-local 2D anchor for the given constraint, or null when
 * the underlying entities are missing.
 */
export function constraintAnchor(sketch, constraint) {
    const ids = constraint.entityIds;
    switch (constraint.kind) {
        case CONSTRAINT_KIND.COINCIDENT: {
            const a = entityAt(sketch, ids[0]);
            return a ? { x: a.params.x, y: a.params.y } : null;
        }
        case CONSTRAINT_KIND.HORIZONTAL:
        case CONSTRAINT_KIND.VERTICAL: {
            const l = entityAt(sketch, ids[0]);
            if (!l || l.kind !== ENTITY_KIND.LINE) return null;
            const a = entityAt(sketch, l.params.startId);
            const b = entityAt(sketch, l.params.endId);
            if (!a || !b) return null;
            return midPoint(a.params, b.params);
        }
        case CONSTRAINT_KIND.PARALLEL:
        case CONSTRAINT_KIND.PERPENDICULAR:
        case CONSTRAINT_KIND.EQUAL_LENGTH: {
            // Anchor at the midpoint of the first line; renderer offsets the second badge
            const l = entityAt(sketch, ids[0]);
            if (!l || l.kind !== ENTITY_KIND.LINE) return null;
            const a = entityAt(sketch, l.params.startId);
            const b = entityAt(sketch, l.params.endId);
            if (!a || !b) return null;
            return midPoint(a.params, b.params);
        }
        case CONSTRAINT_KIND.MIDPOINT:
        case CONSTRAINT_KIND.POINT_ON_LINE:
        case CONSTRAINT_KIND.POINT_ON_CIRCLE: {
            const p = entityAt(sketch, ids[0]);
            return p ? { x: p.params.x, y: p.params.y } : null;
        }
        case CONSTRAINT_KIND.TANGENT: {
            // Anchor at the centre of whichever target is a Circle/Arc
            for (const id of ids) {
                const e = entityAt(sketch, id);
                if (!e) continue;
                if (e.kind === ENTITY_KIND.CIRCLE || e.kind === ENTITY_KIND.ARC) {
                    const c = entityAt(sketch, e.params.centerId);
                    if (c) return offsetBy({ x: c.params.x, y: c.params.y }, e.params.radius || 0, 0);
                }
            }
            return null;
        }
        case CONSTRAINT_KIND.FIXED_DISTANCE:
        case CONSTRAINT_KIND.HORIZONTAL_DISTANCE:
        case CONSTRAINT_KIND.VERTICAL_DISTANCE: {
            const [a, b] = ids;
            const ea = entityAt(sketch, a);
            const eb = entityAt(sketch, b);
            if (!ea || !eb) return null;
            // a or b may be a Line (line length) — fall back to its midpoint
            const pa = ea.kind === ENTITY_KIND.LINE ? lineMid(sketch, ea) : { x: ea.params.x, y: ea.params.y };
            const pb = eb.kind === ENTITY_KIND.LINE ? lineMid(sketch, eb) : { x: eb.params.x, y: eb.params.y };
            if (!pa || !pb) return null;
            return midPoint(pa, pb);
        }
        case CONSTRAINT_KIND.FIXED_ANGLE: {
            // Anchor at the average of both lines' midpoints
            const la = entityAt(sketch, ids[0]);
            const lb = entityAt(sketch, ids[1]);
            const pa = la && la.kind === ENTITY_KIND.LINE ? lineMid(sketch, la) : null;
            const pb = lb && lb.kind === ENTITY_KIND.LINE ? lineMid(sketch, lb) : null;
            if (pa && pb) return midPoint(pa, pb);
            return pa || pb;
        }
        case CONSTRAINT_KIND.FIXED_RADIUS:
        case CONSTRAINT_KIND.EQUAL_RADIUS: {
            const c = entityAt(sketch, ids[0]);
            if (!c) return null;
            const centre = entityAt(sketch, c.params.centerId);
            if (!centre) return null;
            const r = c.params.radius || 0;
            return offsetBy({ x: centre.params.x, y: centre.params.y }, r * 0.707, r * 0.707);
        }
        case CONSTRAINT_KIND.FIXED_POINT: {
            const p = entityAt(sketch, ids[0]);
            return p ? { x: p.params.x, y: p.params.y } : null;
        }
        case CONSTRAINT_KIND.SYMMETRIC: {
            const l = entityAt(sketch, ids[2]);
            if (!l || l.kind !== ENTITY_KIND.LINE) return null;
            return lineMid(sketch, l);
        }
        default:
            return null;
    }
}

function midPoint(a, b) { return { x: 0.5 * (a.x + b.x), y: 0.5 * (a.y + b.y) }; }
function lineMid(sketch, line) {
    const a = entityAt(sketch, line.params.startId);
    const b = entityAt(sketch, line.params.endId);
    if (!a || !b) return null;
    return midPoint(a.params, b.params);
}
function offsetBy(p, dx, dy) { return { x: p.x + dx, y: p.y + dy }; }

// ── Overlay manager ─────────────────────────────────────────────────────────

export class ConstraintBadgeLayer {
    /**
     * @param {object} args
     * @param {HTMLElement} args.host             — overlay container (controller's overlayEl)
     * @param {object}    args.sketchData
     * @param {(point2D: {x,y}) => {x:number,y:number}} args.localToScreen
     *        Projects a sketch-local point to screen coords (controller helper).
     * @param {() => void} [args.onAfterRemove]  — invoked after a click-remove
     */
    constructor({ host, sketchData, localToScreen, onAfterRemove = null }) {
        if (!host) throw new Error('ConstraintBadgeLayer: missing host');
        this.host = host;
        this.sketchData = sketchData;
        this.localToScreen = localToScreen;
        this.onAfterRemove = onAfterRemove;

        this.layerEl = document.createElement('div');
        this.layerEl.className = 'pf4-sk3d-badges';
        host.appendChild(this.layerEl);

        /** @type {Map<string, HTMLElement>} constraintId → badge element */
        this._badges = new Map();

        // Lay out badges for whatever constraints already exist in the sketch.
        // The constructor is the most natural place — callers never have to
        // remember a one-line dance to make the overlay show up.
        this.refresh();
    }

    /** Replace the active SketchData (e.g. after `loadFromFeature`). */
    setSketchData(sketch) {
        this.sketchData = sketch;
        this.refresh();
    }

    /** Re-layout every badge. Cheap — pure position updates after the first paint. */
    refresh() {
        const seen = new Set();
        for (const id of this.sketchData.constraintOrder) {
            const c = this.sketchData.constraints[id];
            if (!c) continue;
            const anchor = constraintAnchor(this.sketchData, c);
            if (!anchor) continue;
            const screen = this.localToScreen(anchor);
            if (!screen || !Number.isFinite(screen.x) || !Number.isFinite(screen.y)) continue;
            let el = this._badges.get(id);
            if (!el) {
                el = this._build(c);
                this._badges.set(id, el);
                this.layerEl.appendChild(el);
            }
            el.style.left = `${screen.x}px`;
            el.style.top  = `${screen.y}px`;
            seen.add(id);
        }
        // Remove badges for constraints that no longer exist
        for (const [id, el] of this._badges.entries()) {
            if (!seen.has(id)) {
                if (el.parentNode) el.parentNode.removeChild(el);
                this._badges.delete(id);
            }
        }
    }

    /** Construct the DOM for one badge. */
    _build(constraint) {
        const sym = SYMBOLS[constraint.kind] || '·';
        const label = LABELS[constraint.kind] || constraint.kind;
        const el  = document.createElement('button');
        el.className = `pf4-sk3d-badge pf4-sk3d-badge-${escClass(constraint.kind)}`;
        const dim = isDimensional(constraint.kind) && constraint.kind !== CONSTRAINT_KIND.FIXED_POINT;
        el.title = dim
            ? `${label} — click for menu, double-click to edit value`
            : `${label} — click for menu`;
        el.textContent = sym;
        el.addEventListener('click', (ev) => {
            ev.stopPropagation();
            ev.preventDefault();
            this._openPopover(constraint.id, el, /*focusValue*/ false);
        });
        el.addEventListener('dblclick', (ev) => {
            ev.stopPropagation();
            ev.preventDefault();
            this._openPopover(constraint.id, el, /*focusValue*/ true);
        });
        return el;
    }

    /**
     * Open the floating popover for a constraint badge. Shows the constraint
     * label, a Delete button, and (for dimensional constraints) an inline
     * value input. Clicking outside dismisses the popover. Pressing Enter in
     * the value field commits a new value + re-solves; Esc cancels.
     */
    _openPopover(constraintId, anchorEl, focusValue) {
        this._closePopover();
        const c = this.sketchData.constraints[constraintId];
        if (!c) return;
        const label = LABELS[c.kind] || c.kind;
        const dim   = isDimensional(c.kind) && c.kind !== CONSTRAINT_KIND.FIXED_POINT;
        const unit  = UNITS[c.kind] || '';

        const pop = document.createElement('div');
        pop.className = 'pf4-sk3d-badge-pop';
        // Position just below-right of the badge so it doesn't clip the symbol.
        const ar = anchorEl.getBoundingClientRect();
        const hostRect = this.host.getBoundingClientRect();
        pop.style.left = `${ar.left - hostRect.left + ar.width + 4}px`;
        pop.style.top  = `${ar.top  - hostRect.top  + ar.height + 4}px`;

        const head = document.createElement('div');
        head.className = 'pf4-sk3d-badge-pop-head';
        head.textContent = label;
        pop.appendChild(head);

        let input = null;
        if (dim) {
            const row = document.createElement('div');
            row.className = 'pf4-sk3d-badge-pop-row';
            const val = (typeof c.value === 'number' && Number.isFinite(c.value))
                ? Number(c.value).toFixed(2)
                : (c.value != null ? String(c.value) : '');
            row.innerHTML =
                `<input type="text" inputmode="decimal" value="${escAttr(val)}" />` +
                (unit ? `<span class="pf4-sk3d-badge-pop-unit">${unit}</span>` : '');
            pop.appendChild(row);
            input = row.querySelector('input');
        }

        const actions = document.createElement('div');
        actions.className = 'pf4-sk3d-badge-pop-actions';
        const del = document.createElement('button');
        del.className = 'pf4-sk3d-badge-pop-del';
        del.type = 'button';
        del.textContent = 'Delete';
        del.title = 'Remove this constraint';
        del.addEventListener('click', (ev) => {
            ev.stopPropagation();
            this._closePopover();
            this._remove(constraintId);
        });
        actions.appendChild(del);
        pop.appendChild(actions);

        this.host.appendChild(pop);
        this._popEl = pop;
        this._popConstraintId = constraintId;

        // Wire input commit (Enter) / cancel (Esc / blur).
        if (input) {
            input.addEventListener('keydown', (ev) => {
                ev.stopPropagation();
                if (ev.key === 'Enter') {
                    ev.preventDefault();
                    const v = parseFloat(input.value);
                    if (Number.isFinite(v)) {
                        try { setConstraintValue(this.sketchData, constraintId, v); }
                        catch (e) { console.error('[badges.setValue]', e); }
                        this._closePopover();
                        if (this.onAfterRemove) {
                            // Reuse the post-mutation hook (controller calls
                            // commitDirty(true) which re-solves + refreshes).
                            try { this.onAfterRemove(constraintId); }
                            catch (e) { console.error('[badges.onAfterValue]', e); }
                        }
                    }
                } else if (ev.key === 'Escape') {
                    ev.preventDefault();
                    this._closePopover();
                }
            });
            if (focusValue) {
                // Defer so the appendChild has time to lay out.
                setTimeout(() => { try { input.focus(); input.select(); } catch {} }, 0);
            }
        }

        // Click-outside dismiss. Bind after a tick so the originating click
        // doesn't immediately fire the dismiss handler.
        const onDocClick = (ev) => {
            if (!this._popEl) return;
            if (this._popEl.contains(ev.target)) return;
            // Clicking a different badge: let _openPopover handle the swap.
            this._closePopover();
        };
        setTimeout(() => {
            if (!this._popEl) return;
            document.addEventListener('mousedown', onDocClick, true);
            this._popDocClick = onDocClick;
        }, 0);
    }

    _closePopover() {
        if (this._popDocClick) {
            document.removeEventListener('mousedown', this._popDocClick, true);
            this._popDocClick = null;
        }
        if (this._popEl && this._popEl.parentNode) {
            this._popEl.parentNode.removeChild(this._popEl);
        }
        this._popEl = null;
        this._popConstraintId = null;
    }

    _remove(constraintId) {
        if (!removeConstraint(this.sketchData, constraintId)) return;
        this.refresh();
        if (this.onAfterRemove) {
            try { this.onAfterRemove(constraintId); }
            catch (e) { console.error('[badges.onAfterRemove]', e); }
        }
    }

    destroy() {
        this._closePopover();
        for (const el of this._badges.values()) {
            if (el.parentNode) el.parentNode.removeChild(el);
        }
        this._badges.clear();
        if (this.layerEl && this.layerEl.parentNode) this.layerEl.parentNode.removeChild(this.layerEl);
    }
}

function escAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function escClass(s) { return String(s).replace(/[^a-zA-Z0-9_-]/g, '-'); }
