/**
 * Inferred-constraint glyph layer.
 *
 * As the user is drawing (anchor → cursor) we render a horizontal stack of
 * tiny pill-shaped icons a few pixels below-right of the cursor showing every
 * constraint that WOULD be applied if they clicked right now:
 *
 *     H        — horizontal       (line within 3° of ±x)
 *     V        — vertical         (line within 3° of ±y)
 *     ∥        — parallel         (within 3° of an existing line)
 *     ⊥        — perpendicular    (within 3° of perpendicular to a line)
 *     =        — equal length     (within 2 % of another line's length)
 *     ⊙        — coincident       (vertex snap)
 *     ●        — midpoint         (midpoint snap)
 *     T        — tangent          (tangent-to-circle snap)
 *     ○        — point-on-circle  (on-circle snap, no anchor)
 *     |        — point-on-line    (on-line snap)
 *     ×        — intersection     (two lines crossing)
 *
 * Glyphs are plain HTML — one `<div>` per glyph inside a single host
 * container. Position is updated every frame via the controller's
 * `_localToScreen`. The layer is opt-in: tools call `show(hints, screenAt)`
 * during `onPointerMove` and `hide()` when there's nothing to show.
 *
 * Cosmetic only — no constraints are added by this module. The tool reads
 * the same hint list (or recomputes it) at the click site.
 */

const PILL_CLASS = 'pf4-sk3d-glyph';
const ROW_CLASS  = 'pf4-sk3d-glyph-row';

export class InferredGlyphLayer {
    /**
     * @param {HTMLElement} hostEl — the sketcher's overlay <div>
     */
    constructor(hostEl) {
        if (!hostEl) throw new Error('InferredGlyphLayer: missing host');
        this.host = hostEl;
        this.row = (typeof document !== 'undefined') ? document.createElement('div') : null;
        if (this.row) {
            this.row.className = ROW_CLASS;
            this.row.style.display = 'none';
            this.host.appendChild(this.row);
        }
        /** Cached hash of the currently-rendered hint set so we avoid pointless
         *  DOM churn each frame when nothing has changed. */
        this._hash = '';
    }

    /**
     * @param {Array<{kind:string,note?:string,refId?:string}>} hints
     * @param {{x:number,y:number}} screenAt — viewport-local px coords
     */
    show(hints, screenAt) {
        if (!this.row) return;
        if (!hints || hints.length === 0) { this.hide(); return; }
        const hash = hints.map(h => h.kind + (h.refId || '')).join('|');
        if (hash !== this._hash) {
            this.row.innerHTML = '';
            for (const h of hints) {
                const pill = document.createElement('div');
                pill.className = PILL_CLASS;
                pill.dataset.kind = h.kind;
                pill.textContent = h.note || symbolFor(h.kind);
                pill.title = labelFor(h.kind);
                this.row.appendChild(pill);
            }
            this._hash = hash;
        }
        // Below-right of the cursor, well clear of the dim-readout (which
        // already sits at +14,+14 from the cursor).
        this.row.style.left = `${(screenAt?.x || 0) + 18}px`;
        this.row.style.top  = `${(screenAt?.y || 0) + 28}px`;
        this.row.style.display = 'flex';
    }

    hide() {
        if (this.row) { this.row.style.display = 'none'; this._hash = ''; }
    }

    destroy() {
        if (this.row && this.row.parentNode) this.row.parentNode.removeChild(this.row);
        this.row = null;
        this._hash = '';
    }
}

const SYMBOLS = Object.freeze({
    'horizontal':      'H',
    'vertical':        'V',
    'parallel':        '∥',
    'perpendicular':   '⊥',
    'equal-length':    '=',
    'coincident':      '⊙',
    'midpoint':        '●',
    'tangent':         'T',
    'point-on-line':   '|',
    'point-on-circle': '○',
    'intersect':       '×',
});
const LABELS = Object.freeze({
    'horizontal':      'Horizontal',
    'vertical':        'Vertical',
    'parallel':        'Parallel',
    'perpendicular':   'Perpendicular',
    'equal-length':    'Equal length',
    'coincident':      'Coincident',
    'midpoint':        'Midpoint',
    'tangent':         'Tangent',
    'point-on-line':   'On line',
    'point-on-circle': 'On circle',
    'intersect':       'Intersection',
});

export function symbolFor(kind) { return SYMBOLS[kind] || '·'; }
export function labelFor(kind)  { return LABELS[kind] || kind; }
