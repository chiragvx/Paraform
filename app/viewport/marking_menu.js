/**
 * Marking menu — 8-sector radial popup on RMB, with mouse-ahead (Kurtenbach 1993).
 *
 * Behavior:
 *   - On RMB down, start a timer (REVEAL_MS) and watch the pointer.
 *   - If the pointer moves > MOUSE_AHEAD_PX before the timer fires, treat it
 *     as an "expert flick" — pick the sector in the direction of travel and
 *     fire WITHOUT rendering the menu. The user never sees it.
 *   - If the timer fires first, render the pie. Then on RMB-up, pick whichever
 *     sector the cursor is currently nearest to (or none if at center).
 *   - If the pointer travels enough to count as a drag (DRAG_THRESHOLD_PX),
 *     suppress the menu so the orbit handler can take the gesture.
 *
 * Sector layout (clockwise from north): N, NE, E, SE, S, SW, W, NW.
 *
 * Visual:
 *   - 8 wedge labels around a 168 px-diameter ring; CATIA-orange highlight.
 *   - Centred at the RMB-down point. Stays in screen space.
 *
 * Sectors are populated by the host through `getActions(ctx)` returning an
 * array of 8 action ids (or null entries for blanks). On fire, the host's
 * registry runs the action with the ctx.
 */

const SECTORS    = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];
const SECTOR_ANGLES = {
    n:  -Math.PI / 2,
    ne: -Math.PI / 4,
    e:   0,
    se:  Math.PI / 4,
    s:   Math.PI / 2,
    sw:  3 * Math.PI / 4,
    w:   Math.PI,
    nw: -3 * Math.PI / 4,
};

const REVEAL_MS         = 220;   // ms before the menu visually appears
const MOUSE_AHEAD_PX    = 12;    // travel before menu visible → expert flick
const DRAG_THRESHOLD_PX = 28;    // travel beyond → cancel menu (likely an orbit)
const PICK_RADIUS_PX    = 28;    // dead-zone in centre; outside this commits
const RING_RADIUS_PX    = 84;

/**
 * Pick the closest sector for a vector from the menu origin to the cursor.
 * Returns one of SECTORS or null when inside the dead-zone.
 */
export function sectorFor(dx, dy) {
    const r = Math.hypot(dx, dy);
    if (r < PICK_RADIUS_PX * 0.4) return null;
    const angle = Math.atan2(dy, dx);  // (-π, π], 0 = east
    // Snap to nearest of 8 directions.
    const step = Math.PI / 4;
    const idx  = Math.round(angle / step);     // -4 … 4
    const norm = ((idx % 8) + 8) % 8;           // 0=east, 1=SE, …
    return ['e', 'se', 's', 'sw', 'w', 'nw', 'n', 'ne'][norm];
}

export class MarkingMenu {
    /**
     * @param {object} args
     * @param {HTMLElement} args.canvas
     * @param {import('../../lib/viewport/actions.js').ActionRegistry} args.registry
     * @param {() => object} args.getContext
     * @param {(ctx: object) => Array<string|null>} args.getActions
     */
    constructor({ canvas, registry, getContext, getActions, toast = null }) {
        if (!canvas || !registry) throw new Error('MarkingMenu: missing canvas or registry');
        this.canvas     = canvas;
        this.registry   = registry;
        this.getContext = getContext || (() => ({}));
        this.getActions = getActions || (() => Array(8).fill(null));
        this.toast      = toast || (() => {});

        this._down     = null;      // { x, y, t, ctx }
        this._visible  = false;
        this._revealTimer = null;
        this._rootEl   = null;

        this._onDown  = (e) => this._handleDown(e);
        this._onMove  = (e) => this._handleMove(e);
        this._onUp    = (e) => this._handleUp(e);
        this._onContext = (e) => { if (this._down || this._visible) e.preventDefault(); };

        this.canvas.addEventListener('pointerdown', this._onDown);
        window.addEventListener('pointermove', this._onMove);
        window.addEventListener('pointerup',   this._onUp);
        this.canvas.addEventListener('contextmenu', this._onContext);
    }

    dispose() {
        this._teardown();
        this.canvas.removeEventListener('pointerdown', this._onDown);
        window.removeEventListener('pointermove', this._onMove);
        window.removeEventListener('pointerup',   this._onUp);
        this.canvas.removeEventListener('contextmenu', this._onContext);
    }

    _handleDown(ev) {
        if (ev.button !== 2) return;             // RMB only
        if (ev.ctrlKey || ev.shiftKey || ev.altKey) return;
        const ctx = this.getContext();
        const ids = this.getActions(ctx);
        if (!ids || ids.length === 0) return;
        this._down = {
            x: ev.clientX, y: ev.clientY, t: performance.now(),
            ctx, ids,
            committed: false,
            moved: false,
        };
        // Schedule the visible reveal; if the user keeps the pointer still,
        // the pie pops up after REVEAL_MS.
        this._revealTimer = setTimeout(() => {
            if (!this._down) return;
            this._show(this._down.x, this._down.y, this._down.ids, this._down.ctx);
        }, REVEAL_MS);
    }

    _handleMove(ev) {
        if (!this._down) return;
        const dx = ev.clientX - this._down.x;
        const dy = ev.clientY - this._down.y;
        const r  = Math.hypot(dx, dy);
        if (r > DRAG_THRESHOLD_PX && !this._visible) {
            // Treat as drag → cancel menu; let orbit handler take over.
            this._abort();
            return;
        }
        if (!this._visible && r > MOUSE_AHEAD_PX) {
            // Expert flick — commit before reveal.
            const sector = sectorFor(dx, dy);
            this._down.committed = true;
            this._fireSector(sector);
            this._abort();
            return;
        }
        if (this._visible) {
            this._updateHighlight(dx, dy);
        }
        this._down.moved = r > 4;
    }

    _handleUp(ev) {
        if (!this._down) return;
        if (ev.button !== 2) return;
        if (this._visible && !this._down.committed) {
            const dx = ev.clientX - this._down.x;
            const dy = ev.clientY - this._down.y;
            const sector = sectorFor(dx, dy);
            this._fireSector(sector);
        }
        this._teardown();
    }

    _fireSector(sector) {
        if (!sector || !this._down) return;
        const idx = SECTORS.indexOf(sector);
        const id  = this._down.ids[idx];
        if (!id) return;
        // Honor isEnabled — surface a specific hint rather than firing
        // and falling into the generic "is unavailable" message.
        const reason = (typeof this.registry.reasonDisabled === 'function')
            ? this.registry.reasonDisabled(id, this._down.ctx)
            : null;
        if (reason) { this.toast(reason, 'warning'); return; }
        const ok  = this.registry.run(id, this._down.ctx);
        if (!ok) this.toast('Command failed to run', 'error');
    }

    _abort() {
        if (this._revealTimer) { clearTimeout(this._revealTimer); this._revealTimer = null; }
        this._teardown();
    }

    _teardown() {
        if (this._revealTimer) { clearTimeout(this._revealTimer); this._revealTimer = null; }
        if (this._rootEl && this._rootEl.parentNode) this._rootEl.parentNode.removeChild(this._rootEl);
        this._rootEl  = null;
        this._visible = false;
        this._down    = null;
    }

    _show(cx, cy, ids, ctx) {
        this._visible = true;
        const size = RING_RADIUS_PX * 2 + 80;
        const root = document.createElement('div');
        root.className = 'pf-marking-menu';
        Object.assign(root.style, {
            position: 'fixed', left: (cx - size/2) + 'px', top: (cy - size/2) + 'px',
            width: size + 'px', height: size + 'px',
            pointerEvents: 'none', zIndex: '38',
            fontFamily: '"Inter", "Segoe UI", sans-serif', fontSize: '12px',
            color: '#eaeaea',
        });
        // Background ring
        const ring = document.createElement('div');
        const ringSize = RING_RADIUS_PX * 2;
        Object.assign(ring.style, {
            position: 'absolute',
            left: (size/2 - RING_RADIUS_PX) + 'px',
            top:  (size/2 - RING_RADIUS_PX) + 'px',
            width:  ringSize + 'px', height: ringSize + 'px',
            borderRadius: '50%',
            background: 'rgba(28,31,36,0.85)',
            border: '1px solid #2a2f37',
            boxShadow: '0 12px 36px rgba(0,0,0,0.45)',
        });
        const dot = document.createElement('div');
        Object.assign(dot.style, {
            position: 'absolute',
            left: (size/2 - 3) + 'px', top: (size/2 - 3) + 'px',
            width: '6px', height: '6px', borderRadius: '50%',
            background: '#ff8c28',
        });
        root.appendChild(ring); root.appendChild(dot);

        // Sector labels
        this._labelEls = [];
        const labelRadius = RING_RADIUS_PX - 2;
        SECTORS.forEach((sec, i) => {
            const id = ids[i];
            const action = id ? this.registry.get(id) : null;
            const angle  = SECTOR_ANGLES[sec];
            const lx = Math.cos(angle) * labelRadius;
            const ly = Math.sin(angle) * labelRadius;
            const lbl = document.createElement('div');
            lbl.textContent = action ? action.label : '';
            Object.assign(lbl.style, {
                position: 'absolute',
                left: (size/2 + lx) + 'px', top: (size/2 + ly) + 'px',
                transform: 'translate(-50%, -50%)',
                padding: '4px 10px', borderRadius: '6px',
                background: 'rgba(15,18,22,0.95)',
                border: '1px solid #2a2f37',
                whiteSpace: 'nowrap',
                opacity: (action && action.isEnabled(ctx)) ? '1' : '0.45',
                transition: 'background 80ms, border-color 80ms',
            });
            root.appendChild(lbl);
            this._labelEls.push(lbl);
        });
        document.body.appendChild(root);
        this._rootEl = root;
    }

    _updateHighlight(dx, dy) {
        const sec = sectorFor(dx, dy);
        if (!this._labelEls) return;
        SECTORS.forEach((s, i) => {
            const el = this._labelEls[i];
            if (s === sec) {
                el.style.background = 'rgba(255,140,40,0.18)';
                el.style.borderColor = '#ff8c28';
                el.style.color = '#ffd1a1';
            } else {
                el.style.background = 'rgba(15,18,22,0.95)';
                el.style.borderColor = '#2a2f37';
                el.style.color = '#eaeaea';
            }
        });
    }
}
