/**
 * CreateRibbon — top docked CAD ribbon, Fusion / Onshape style.
 *
 * Sits as a 48 px tall band below the app bar, above the viewport. Holds
 * grouped icon+label buttons for the most-used commands. Each button
 * fires a v4-panel quick action (`add-box`, `add-cylinder`, `add-sketch-xy`,
 * `add-fillet`, …) which in turn opens the floating CommandRuntime dialog
 * — no popup, no menu drill-down.
 *
 * The ribbon is the *discovery surface* the app was missing: a brand-new
 * user can see every primitive + every modify op without opening Ctrl+K
 * or hunting through a feature menu.
 *
 * Mount:
 *   mountCreateRibbon({ host, runAction: (id) => panel.runAction(id) });
 *
 * Lives outside the v4 panel module so it doesn't depend on the panel
 * being open — the ribbon stays mounted even when the user hides the
 * sidebar.
 */

const STYLE_ID = 'pf-create-ribbon-styles';
const CSS = `
.pf-create-ribbon {
    position: fixed;
    left: 0; right: 0;
    top: var(--app-bar-h, 42px);
    /* Height bumped to 64px: the old 48px clipped icon tops and per-button
       labels (each group's button + label + group caption needs ~62px).
       --pf-create-ribbon-h is the single source of truth — style.css
       reads it for #viewport-container's top inset. */
    height: var(--pf-create-ribbon-h, 64px);
    background: linear-gradient(180deg, #1a1c20 0%, #141619 100%);
    border-bottom: 1px solid rgba(255,255,255,0.08);
    /* Sub-chrome slot (z:210) per style.css "Z-INDEX / STACKING ORDER".
       Was z:70, which the legacy #tool-bar (z:299) painted over — the
       ribbon was effectively invisible. */
    z-index: 210;
    display: flex; align-items: stretch;
    padding: 0;
    gap: 0;
    overflow-x: auto; overflow-y: hidden;
    user-select: none;
    font: 11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
.pf-create-ribbon::-webkit-scrollbar { height: 4px; }
.pf-create-ribbon::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.10); border-radius: 2px; }

/* Group = category header on top, row of icon-buttons below. The category
   header sits FIRST in DOM so flex column lays it out at the top; the row
   takes the remaining space. */
.pf-cr-group {
    display: flex; flex-direction: column;
    align-items: stretch;
    padding: 5px 10px 5px;
    border-right: 1px solid rgba(255,255,255,0.05);
    flex: 0 0 auto;
}
.pf-cr-group:last-child { border-right: 0; }
.pf-cr-group-label {
    font-size: 9px; font-weight: 600;
    color: #7a7670;
    text-transform: uppercase; letter-spacing: 0.7px;
    line-height: 1;
    margin-bottom: 4px;
    text-align: center;
    flex: 0 0 auto;
}
.pf-cr-row {
    display: flex; align-items: center; gap: 1px;
    flex: 1; min-height: 0;
}

.pf-cr-btn {
    appearance: none; background: transparent;
    border: 1px solid transparent;
    color: #cfcdc8;
    border-radius: 4px;
    cursor: pointer;
    padding: 3px 4px;
    width: 50px; height: 42px;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 2px;
    transition: background 0.1s, border-color 0.1s, color 0.1s;
    font: inherit;
    flex: 0 0 auto;
}
.pf-cr-btn:hover {
    background: rgba(255,143,107,0.10);
    border-color: rgba(255,143,107,0.30);
    color: #ffd9c8;
}
.pf-cr-btn:active { transform: translateY(1px); }
.pf-cr-btn[disabled] {
    opacity: 0.30; cursor: not-allowed;
    color: #8a8682;
}
.pf-cr-btn[disabled]:hover { background: transparent; border-color: transparent; }
.pf-cr-btn .pf-cr-glyph {
    width: 22px; height: 22px;
    color: var(--gly-color, #cfcdc8);
    display: flex; align-items: center; justify-content: center;
    flex: 0 0 auto;
}
.pf-cr-btn .pf-cr-glyph svg { width: 100%; height: 100%; }
.pf-cr-btn .pf-cr-lbl {
    font-size: 9.5px; line-height: 1;
    color: #b9b6b0;
    letter-spacing: 0.2px;
    text-transform: capitalize;
    flex: 0 0 auto;
}
.pf-cr-btn:hover .pf-cr-lbl { color: #ffe2d4; }

.pf-cr-spacer { flex: 1; }
`;

const SVG_PROPS = `width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"`;

const ICONS = {
    box:       `<svg ${SVG_PROPS}><path d="M3 7l9-4 9 4-9 4-9-4z"/><path d="M3 7v10l9 4 9-4V7"/><path d="M12 11v10"/></svg>`,
    cylinder:  `<svg ${SVG_PROPS}><ellipse cx="12" cy="6" rx="6.5" ry="2"/><path d="M5.5 6v12c0 1.1 2.9 2 6.5 2s6.5-.9 6.5-2V6"/></svg>`,
    sphere:    `<svg ${SVG_PROPS}><circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="9" ry="3"/></svg>`,
    torus:     `<svg ${SVG_PROPS}><ellipse cx="12" cy="12" rx="9" ry="4"/><ellipse cx="12" cy="12" rx="4.5" ry="1.5"/></svg>`,
    sketch:    `<svg ${SVG_PROPS}><path d="M4 20l4-1.5 11.5-11.5-2.5-2.5L5.5 16 4 20z"/><path d="M14 6l3 3"/></svg>`,
    sketchXY:  `<svg ${SVG_PROPS}><rect x="3" y="3" width="18" height="18" rx="1"/><path d="M8 18l2-5 4 3 3-7"/></svg>`,
    extrude:   `<svg ${SVG_PROPS}><rect x="4" y="10" width="10" height="10"/><path d="M14 10l6-6M14 20l6-6M4 10l6-6"/></svg>`,
    revolve:   `<svg ${SVG_PROPS}><path d="M12 3v18"/><path d="M16 6c0 2.2-1.8 4-4 4s-4-1.8-4-4"/><path d="M16 18c0-2.2-1.8-4-4-4s-4 1.8-4 4"/></svg>`,
    fillet:    `<svg ${SVG_PROPS}><path d="M4 20V12a8 8 0 0 1 8-8h8"/><path d="M4 4v6M20 20h-6" opacity="0.4"/></svg>`,
    chamfer:   `<svg ${SVG_PROPS}><path d="M4 20V14L14 4h6"/></svg>`,
    shell:     `<svg ${SVG_PROPS}><rect x="3" y="3" width="18" height="18" rx="1"/><rect x="7" y="7" width="10" height="10" rx="1"/></svg>`,
    hole:      `<svg ${SVG_PROPS}><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3" fill="currentColor"/></svg>`,
    pattern:   `<svg ${SVG_PROPS}><rect x="3" y="3" width="6" height="6"/><rect x="15" y="3" width="6" height="6"/><rect x="3" y="15" width="6" height="6"/><rect x="15" y="15" width="6" height="6"/></svg>`,
    circularP: `<svg ${SVG_PROPS}><circle cx="12" cy="12" r="9"/><circle cx="12" cy="4" r="1.5" fill="currentColor"/><circle cx="20" cy="12" r="1.5" fill="currentColor"/><circle cx="12" cy="20" r="1.5" fill="currentColor"/><circle cx="4" cy="12" r="1.5" fill="currentColor"/></svg>`,
    mirror:    `<svg ${SVG_PROPS}><path d="M12 3v18"/><path d="M8 8L4 12l4 4"/><path d="M16 8l4 4-4 4"/></svg>`,
    union:     `<svg ${SVG_PROPS}><circle cx="9" cy="12" r="6"/><circle cx="15" cy="12" r="6"/></svg>`,
    cut:       `<svg ${SVG_PROPS}><circle cx="9" cy="12" r="6"/><circle cx="15" cy="12" r="6" stroke-dasharray="2 3"/></svg>`,
    helix:     `<svg ${SVG_PROPS}><path d="M8 4c8 2-8 4 0 8s-8 4 0 8"/></svg>`,
};

// Each button: id (panel-action), label, icon, needs (enable predicate
// against the running doc: 'body' | 'sketch' | null).
const GROUPS = [
    {
        label: 'Create',
        items: [
            { id: 'add-box',      label: 'Box',      icon: 'box' },
            { id: 'add-cylinder', label: 'Cylinder', icon: 'cylinder' },
            { id: 'add-sphere',   label: 'Sphere',   icon: 'sphere' },
            { id: 'add-torus',    label: 'Torus',    icon: 'torus' },
            { id: 'add-helix',    label: 'Helix',    icon: 'helix' },
        ],
    },
    {
        label: 'Sketch',
        items: [
            { id: 'sketch-xy', label: 'XY Plane', icon: 'sketchXY' },
            { id: 'sketch-xz', label: 'XZ Plane', icon: 'sketchXY' },
            { id: 'sketch-yz', label: 'YZ Plane', icon: 'sketchXY' },
        ],
    },
    {
        label: 'Sketch-based',
        items: [
            { id: 'add-extrude', label: 'Extrude', icon: 'extrude', needs: 'sketch' },
            { id: 'add-revolve', label: 'Revolve', icon: 'revolve', needs: 'sketch' },
        ],
    },
    {
        label: 'Modify',
        items: [
            { id: 'add-fillet',  label: 'Fillet',  icon: 'fillet',  needs: 'body' },
            { id: 'add-chamfer', label: 'Chamfer', icon: 'chamfer', needs: 'body' },
            { id: 'add-shell',   label: 'Shell',   icon: 'shell',   needs: 'body' },
            { id: 'add-hole',    label: 'Hole',    icon: 'hole',    needs: 'body' },
        ],
    },
    {
        label: 'Pattern',
        items: [
            { id: 'add-linear-pattern',   label: 'Linear',   icon: 'pattern',   needs: 'body' },
            { id: 'add-circular-pattern', label: 'Circular', icon: 'circularP', needs: 'body' },
            { id: 'add-mirror',           label: 'Mirror',   icon: 'mirror',    needs: 'body' },
        ],
    },
    {
        label: 'Boolean',
        items: [
            { id: 'add-union',     label: 'Union',     icon: 'union',  needs: '2bodies' },
            { id: 'add-cut',       label: 'Cut',       icon: 'cut',    needs: '2bodies' },
            { id: 'add-intersect', label: 'Intersect', icon: 'union',  needs: '2bodies' },
        ],
    },
];

function ensureStyle(doc) {
    if (!doc || doc.getElementById(STYLE_ID)) return;
    const el = doc.createElement('style');
    el.id = STYLE_ID;
    el.textContent = CSS;
    doc.head.appendChild(el);
}

let _instance = null;

export function mountCreateRibbon(opts) {
    if (_instance) return _instance;
    _instance = new CreateRibbon(opts);
    return _instance;
}
export function getCreateRibbon() { return _instance; }

class CreateRibbon {
    /**
     * @param {object} opts
     * @param {(actionId: string) => void} opts.runAction
     * @param {() => ({ bodyCount: number, sketchCount: number }|null)} [opts.getDocStats]
     */
    constructor({ runAction, getDocStats = null, doc = (typeof document !== 'undefined' ? document : null) } = {}) {
        if (typeof runAction !== 'function') throw new Error('CreateRibbon: missing runAction');
        if (!doc) throw new Error('CreateRibbon: no document');
        this.doc = doc;
        this.runAction = runAction;
        this.getDocStats = typeof getDocStats === 'function' ? getDocStats : (() => null);
        ensureStyle(doc);
        this._build();
        this.doc.body.classList.add('pf-create-ribbon-mounted');
        this.refresh();
        // Poll for state changes — needs gating updates on doc mutation.
        this._poll = setInterval(() => this.refresh(), 600);
    }

    destroy() {
        if (this._poll) { clearInterval(this._poll); this._poll = null; }
        if (this.root && this.root.parentNode) this.root.parentNode.removeChild(this.root);
        this.doc.body.classList.remove('pf-create-ribbon-mounted');
        if (_instance === this) _instance = null;
    }

    _build() {
        const root = this.doc.createElement('div');
        root.className = 'pf-create-ribbon';
        root.innerHTML = GROUPS.map(g => (
            `<div class="pf-cr-group" data-group="${esc(g.label)}">` +
              `<div class="pf-cr-group-label">${esc(g.label)}</div>` +
              `<div class="pf-cr-row">` +
                g.items.map(it => (
                    `<button class="pf-cr-btn" data-action="${esc(it.id)}"` +
                    (it.needs ? ` data-needs="${esc(it.needs)}"` : '') +
                    ` title="${esc(it.label)}">` +
                      `<span class="pf-cr-glyph">${ICONS[it.icon] || ICONS.box}</span>` +
                      `<span class="pf-cr-lbl">${esc(it.label)}</span>` +
                    `</button>`
                )).join('') +
              `</div>` +
            `</div>`
        )).join('');
        this.doc.body.appendChild(root);
        this.root = root;
        root.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-action]');
            if (!btn || btn.hasAttribute('disabled')) return;
            try { this.runAction(btn.dataset.action); }
            catch (err) { console.warn('[CreateRibbon]', err); }
        });
    }

    /** Enable/disable buttons based on the current doc state. */
    refresh() {
        const stats = this.getDocStats();
        if (!stats) return;
        for (const btn of this.root.querySelectorAll('[data-needs]')) {
            const needs = btn.dataset.needs;
            let enabled = true;
            if (needs === 'body')     enabled = stats.bodyCount > 0;
            else if (needs === '2bodies') enabled = stats.bodyCount >= 2;
            else if (needs === 'sketch')  enabled = stats.sketchCount > 0;
            if (enabled) btn.removeAttribute('disabled');
            else btn.setAttribute('disabled', 'true');
        }
    }
}

function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
