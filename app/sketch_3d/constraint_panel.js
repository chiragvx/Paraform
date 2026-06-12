/**
 * Constraint panel — selection-aware toolbar for applying geometric
 * constraints to the current selection.
 *
 * Each constraint from `CONSTRAINT_TOOLS` renders as a `<button>`. On every
 * selection change the panel calls each tool's `try(selection, sketch)`
 * helper to decide whether the button is enabled. Buttons keep their
 * tooltip explaining why they're disabled ("Select two lines.").
 *
 * Clicking an enabled button calls the helper again and commits the
 * returned constraint via the standard `addConstraint` path.
 */

import { CONSTRAINT_TOOLS, evaluateAll } from '../../lib/sketch/constraint_apply.js';
import { addConstraint } from '../../lib/sketch/sketch_data.js';

export class ConstraintPanel {
    /**
     * @param {object} args
     * @param {HTMLElement} args.host           — overlay container (controller.overlayEl)
     * @param {object}      args.sketchData
     * @param {() => string[]} args.getSelection
     * @param {(msg:string, kind?:string) => void} [args.toast]
     * @param {() => void}  [args.onApply]      — called after constraint commits
     */
    constructor({ host, sketchData, getSelection, toast = null, onApply = null }) {
        if (!host) throw new Error('ConstraintPanel: missing host');
        if (typeof getSelection !== 'function') throw new Error('ConstraintPanel: getSelection required');

        this.host         = host;
        this.sketchData   = sketchData;
        this.getSelection = getSelection;
        this.toast        = toast || ((m) => console.info('[constraint-panel]', m));
        this.onApply      = onApply;

        this.el = document.createElement('div');
        this.el.className = 'pf4-sk3d-cstr-panel';
        host.appendChild(this.el);

        /** @type {Map<string, HTMLElement>} */
        this._buttons = new Map();
        this._build();
        this.refresh();
    }

    setSketchData(sketch) {
        this.sketchData = sketch;
        this.refresh();
    }

    /** Re-evaluate every button's enabled state from the current selection. */
    refresh() {
        const sel    = this.getSelection() || [];
        const sketch = this.sketchData;
        const results = evaluateAll(sel, sketch);
        for (const tool of CONSTRAINT_TOOLS) {
            const btn = this._buttons.get(tool.key);
            if (!btn) continue;
            const r = results[tool.key];
            const ok = !!(r && r.ok);
            btn.disabled = !ok;
            btn.title = ok ? tool.label : `${tool.label} — ${r ? r.reason : ''}`;
            btn.classList.toggle('pf4-sk3d-cstr-disabled', !ok);
        }
    }

    destroy() {
        this._buttons.clear();
        if (this.el && this.el.parentNode) this.el.parentNode.removeChild(this.el);
    }

    // ── DOM construction ───────────────────────────────────────────────────

    _build() {
        for (const tool of CONSTRAINT_TOOLS) {
            const btn = document.createElement('button');
            btn.className = `pf4-sk3d-cstr-btn pf4-sk3d-cstr-${escClass(tool.key)}`;
            btn.textContent = tool.symbol;
            btn.title = tool.label;
            btn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                this._apply(tool);
            });
            this.el.appendChild(btn);
            this._buttons.set(tool.key, btn);
        }
    }

    _apply(tool) {
        const sel = this.getSelection() || [];
        const r = tool.try(sel, this.sketchData);
        if (!r.ok) {
            this.toast(`${tool.label}: ${r.reason}`, 'error');
            return;
        }
        try {
            addConstraint(this.sketchData, r.constraint);
        } catch (err) {
            this.toast(`${tool.label} failed: ${err.message}`, 'error');
            return;
        }
        this.toast(`${tool.label} added.`, 'success');
        if (this.onApply) {
            try { this.onApply(r.constraint); }
            catch (e) { console.error('[constraint-panel onApply]', e); }
        }
        this.refresh();
    }
}

function escClass(s) { return String(s).replace(/[^a-zA-Z0-9_-]/g, '-'); }
