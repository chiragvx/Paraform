/**
 * FeatureMenu — categorised pop-up that exposes every v4 operation as a
 * proper UI button instead of the Cmd-K fuzzy-search path.
 *
 * The menu is pure DOM glue: it doesn't import `lib/document/operations`
 * directly. Instead it dispatches action ids (`add-box`, `add-fillet`, …)
 * that the host (main.js) registers via `V4Panel.setQuickAction(name, fn)`.
 * This keeps the panel module decoupled from kernel/sketch-builder logic.
 *
 * Categories are taken verbatim from the FEATURE_TYPES table. Each item
 * may declare:
 *
 *   action      — string id passed to `setQuickAction`
 *   label       — display text
 *   description — short hover hint
 *   needs       — 'body' | '2bodies' | 'sketch' | null
 *                  drives the enable/disable state of the button using the
 *                  current document. Multi-body ops accept "2bodies".
 *
 * Public API:
 *   const fm = new FeatureMenu(parentEl, { onAction, getDoc, getSelection });
 *   fm.toggle(anchorEl);    // open/close, positioned next to the anchor
 *   fm.close();
 */

export const FEATURE_MENU_GROUPS = [
    {
        heading: 'Primitive',
        items: [
            { action: 'add-box',      label: 'Box',      description: 'Rectangular block.' },
            { action: 'add-cylinder', label: 'Cylinder', description: 'Circular extrusion.' },
            { action: 'add-sphere',   label: 'Sphere',   description: 'Solid ball.' },
            { action: 'add-torus',    label: 'Torus',    description: 'Doughnut / O-ring.' },
            { action: 'add-helix',    label: 'Helix',    description: '3D helical wire — useful as a sweep path for threads.' },
        ],
    },
    {
        heading: 'Sketch',
        items: [
            { action: 'sketch-xy', label: 'New Sketch on XY', description: 'Enter the in-viewport sketcher on the XY plane.' },
            { action: 'sketch-xz', label: 'New Sketch on XZ', description: 'Front plane.' },
            { action: 'sketch-yz', label: 'New Sketch on YZ', description: 'Right plane.' },
            { action: 'sketch-on-face', label: 'Sketch on Face',
              description: 'Open the in-viewport sketcher anchored on the selected face.',
              needs: 'face' },
        ],
    },
    {
        heading: 'Sketch-based',
        items: [
            { action: 'add-extrude', label: 'Extrude…',  description: 'Pull a sketch into 3D.',         needs: 'sketch' },
            { action: 'add-revolve', label: 'Revolve…',  description: 'Spin a sketch around an axis.',  needs: 'sketch' },
            { action: 'add-sweep',   label: 'Sweep…',    description: 'Sweep a profile along a path.',  needs: 'sketch' },
            { action: 'add-loft',    label: 'Loft…',     description: 'Loft between 2+ sketches.',      needs: 'sketch' },
        ],
    },
    {
        heading: 'Modify',
        items: [
            { action: 'add-fillet',  label: 'Fillet…',     description: 'Round edges of the selected body.',    needs: 'body' },
            { action: 'add-chamfer', label: 'Chamfer…',    description: 'Bevel edges of the selected body.',    needs: 'body' },
            { action: 'add-shell',   label: 'Shell…',      description: 'Hollow the selected body.',            needs: 'body' },
            { action: 'add-hole',    label: 'Hole…',       description: 'Drill a hole through the selected body.', needs: 'body' },
            { action: 'add-offset3d',label: 'Offset Body…',description: 'Offset every face by a distance.',     needs: 'body' },
        ],
    },
    {
        heading: 'Boolean',
        items: [
            { action: 'add-union',     label: 'Union (last 2)',     description: 'Fuse the two most recent bodies.', needs: '2bodies' },
            { action: 'add-cut',       label: 'Cut (last - prev)',  description: 'Subtract previous body from the latest.', needs: '2bodies' },
            { action: 'add-intersect', label: 'Intersect (last 2)', description: 'Keep only the overlap.', needs: '2bodies' },
        ],
    },
    {
        heading: 'Pattern',
        items: [
            { action: 'add-linear-pattern',   label: 'Linear Pattern…',   description: 'Array along an axis.', needs: 'body' },
            { action: 'add-circular-pattern', label: 'Circular Pattern…', description: 'Array around an axis.', needs: 'body' },
            { action: 'add-mirror',           label: 'Mirror',            description: 'Mirror across a plane.', needs: 'body' },
        ],
    },
    {
        heading: 'Transform',
        items: [
            { action: 'add-move',   label: 'Move…',   description: 'Translate the selected body.', needs: 'body' },
            { action: 'add-rotate', label: 'Rotate…', description: 'Rotate around an axis.',       needs: 'body' },
            { action: 'add-scale',  label: 'Scale…',  description: 'Uniform scale.',                needs: 'body' },
        ],
    },
];

/**
 * Returns true if `featureType` produces a body the rest of the document
 * can chain off of (i.e. it's a CAD body, not a sketch / parameter / etc.).
 */
const BODY_TYPES = new Set([
    'Box','Cylinder','Sphere','Torus','Helix',
    'Extrude','Revolve','Sweep','Loft',
    'Fillet','Chamfer','Shell','Hole','Thread','Draft','Offset3D',
    'LinearPattern','CircularPattern','PathPattern','Mirror',
    'Union','Cut','Intersect','Split',
    'Move','Rotate','Scale',
    'ImportSTEP',
]);

function countBodies(doc) {
    if (!doc || !doc.features) return 0;
    let n = 0;
    for (const f of Object.values(doc.features)) {
        if (f && f.enabled && BODY_TYPES.has(f.type)) n++;
    }
    return n;
}
function countSketches(doc) {
    if (!doc || !doc.features) return 0;
    let n = 0;
    for (const f of Object.values(doc.features)) {
        if (f && f.enabled && (f.type === 'Sketch' || f.type === 'SketchOnFace')) n++;
    }
    return n;
}

export class FeatureMenu {
    /**
     * @param {HTMLElement} root  — host element the menu mounts inside
     * @param {object} opts
     * @param {(action: string) => void}     opts.onAction
     * @param {() => object}                 opts.getDoc           returns the live v4 Document
     * @param {() => string|null}           [opts.getSelection]    selected feature id, optional
     * @param {() => number}                [opts.getPickedCount]  picked-face count (drives `needs: 'face'` items)
     */
    constructor(root, { onAction, getDoc, getSelection = null, getPickedCount = null } = {}) {
        if (!root)     throw new Error('FeatureMenu: missing root');
        if (!onAction) throw new Error('FeatureMenu: missing onAction');
        if (!getDoc)   throw new Error('FeatureMenu: missing getDoc');
        this.root        = root;
        this.onAction    = onAction;
        this.getDoc      = getDoc;
        this.getSelection   = getSelection   || (() => null);
        this.getPickedCount = getPickedCount || (() => 0);
        this.open        = false;
        this.el          = null;
        this._closeOnDocClick = (ev) => {
            if (this.open && this.el && !this.el.contains(ev.target) && !ev.target.closest('[data-fm-anchor]')) {
                this.close();
            }
        };
        // Use mousedown so a fresh click on the anchor button doesn't immediately
        // re-close the menu we're about to open.
        if (root.ownerDocument) root.ownerDocument.addEventListener('mousedown', this._closeOnDocClick);
    }

    destroy() {
        if (this.el && this.el.parentNode) this.el.parentNode.removeChild(this.el);
        if (this.root.ownerDocument) this.root.ownerDocument.removeEventListener('mousedown', this._closeOnDocClick);
        this.el = null;
    }

    /** Open the menu next to `anchor`, or close it if already open. */
    toggle(anchor) {
        if (this.open) { this.close(); return; }
        this._render();
        this._position(anchor);
        this.open = true;
    }

    close() {
        if (this.el && this.el.parentNode) this.el.parentNode.removeChild(this.el);
        this.el = null;
        this.open = false;
    }

    _render() {
        const doc        = this.getDoc();
        const bodies     = countBodies(doc);
        const sketches   = countSketches(doc);
        const picked     = this.getPickedCount();
        const hasBody    = bodies >= 1;
        const has2       = bodies >= 2;
        const hasSketch  = sketches >= 1;
        const hasFace    = picked >= 1;
        const ownerDoc   = this.root.ownerDocument;

        const el = ownerDoc.createElement('div');
        el.className = 'pf4-feature-menu';

        for (const group of FEATURE_MENU_GROUPS) {
            const groupEl = ownerDoc.createElement('div');
            groupEl.className = 'pf4-fm-group';
            const heading = ownerDoc.createElement('div');
            heading.className = 'pf4-fm-heading';
            heading.textContent = group.heading;
            groupEl.appendChild(heading);

            for (const item of group.items) {
                let disabled = false;
                let reason = '';
                if (item.needs === 'body'    && !hasBody)   { disabled = true; reason = 'No body in the document yet.'; }
                if (item.needs === '2bodies' && !has2)      { disabled = true; reason = 'Needs at least 2 bodies.'; }
                if (item.needs === 'sketch'  && !hasSketch) { disabled = true; reason = 'Needs a sketch first.'; }
                if (item.needs === 'face'    && !hasFace)   { disabled = true; reason = 'Pick a face first.'; }

                const btn = ownerDoc.createElement('button');
                btn.className = 'pf4-fm-item';
                btn.textContent = item.label;
                btn.dataset.action = item.action;
                if (disabled) btn.disabled = true;
                btn.setAttribute && btn.setAttribute('title', disabled ? reason : (item.description || ''));
                btn.addEventListener('click', () => {
                    if (btn.disabled) return;
                    this.close();
                    this.onAction(item.action);
                });
                groupEl.appendChild(btn);
            }
            el.appendChild(groupEl);
        }
        ownerDoc.body.appendChild(el);
        this.el = el;
    }

    _position(anchor) {
        if (!this.el || !anchor || !anchor.getBoundingClientRect) return;
        const rect = anchor.getBoundingClientRect();
        const top  = rect.bottom + 4;
        const left = Math.max(8, rect.left);
        this.el.style.position = 'fixed';
        this.el.style.top  = `${top}px`;
        this.el.style.left = `${left}px`;
        this.el.style.zIndex = '5500';
    }
}

