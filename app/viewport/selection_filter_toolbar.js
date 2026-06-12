/**
 * SelectionFilterToolbar — always-visible kind filter for the viewport.
 *
 * Mirrors Fusion's selection-filter dropdown but flattened to a row of
 * toggle buttons (Face / Edge / Vertex / Body / Sketch) plus an "All" reset.
 * Multi-toggle: any subset can be active simultaneously. When *every* button
 * is off OR every button is on, the underlying PickingSelection filter is
 * cleared (== "accept all kinds") — the user's intent in both cases is
 * "don't restrict picking."
 *
 * Wire:
 *   const toolbar = new SelectionFilterToolbar({ selection });
 *   toolbar.mount(hostEl);   // hostEl is a positioned div in the viewport
 *   toolbar.dispose();
 *
 * Reads from `selection.getKindFilter()` so external changes (the legacy
 * SelectionFilter dropdown, a future command-palette toggle) round-trip
 * into the visible state.
 *
 * No three.js — pure DOM + the selection singleton.
 */

const KINDS = [
    { id: 'face',   label: 'Face',   short: 'F' },
    { id: 'edge',   label: 'Edge',   short: 'E' },
    { id: 'vertex', label: 'Vertex', short: 'V' },
    { id: 'body',   label: 'Body',   short: 'B' },
    // 'sketch' is accepted by setKindFilter (the API takes any string) even
    // though the kernel doesn't currently emit sketch descriptors through
    // the proxy layer — kept here so the toolbar is forward-compatible with
    // the sketch picking work tracked in EDITOR_READINESS.
    { id: 'sketch', label: 'Sketch', short: 'S' },
];
const ALL_IDS = KINDS.map((k) => k.id);

const STORAGE_KEY = 'paraform.selectionFilterToolbar';

export class SelectionFilterToolbar {
    /**
     * @param {object} args
     * @param {object} args.selection — PickingSelection singleton
     */
    constructor({ selection }) {
        if (!selection) throw new Error('SelectionFilterToolbar: missing selection');
        this.selection = selection;
        this.host = null;
        this.root = null;
        /** @type {Set<string>} active kinds; empty == "all" */
        this.active = this._restore();
        this._buttons = new Map();   // id → HTMLElement
        this._allButton = null;
        this._apply();               // sync the singleton to restored state
    }

    /**
     * Mount the toolbar into the supplied host element. Host should already
     * be absolutely positioned in the viewport (see Viewport.svelte mount
     * snippet). The toolbar owns its own background pill so the host can be
     * a bare wrapper.
     */
    mount(host) {
        if (!host) throw new Error('SelectionFilterToolbar: mount needs a host element');
        this.host = host;
        this.root = document.createElement('div');
        this.root.className = 'pf4-selfilter-toolbar';
        // Inline styles so this module stays independent of the Tailwind
        // build pipeline. Matches the look of the right-edge display-mode
        // column in Viewport.svelte.
        Object.assign(this.root.style, {
            display:         'inline-flex',
            alignItems:      'center',
            gap:             '2px',
            padding:         '3px',
            borderRadius:    '6px',
            border:          '1px solid var(--border, #2a2d33)',
            background:      'var(--card, rgba(28,31,36,0.9))',
            backdropFilter:  'blur(6px)',
            fontSize:        '11px',
            color:           'var(--muted-foreground, #a3a7ad)',
            pointerEvents:   'auto',
            userSelect:      'none',
        });

        // "All" reset chip on the left.
        this._allButton = this._makeButton({
            id:     '__all__',
            label:  'All',
            title:  'Clear the selection filter (accept every kind)',
        });
        this._allButton.addEventListener('click', () => this.reset());
        this.root.appendChild(this._allButton);

        // Thin divider.
        const sep = document.createElement('div');
        Object.assign(sep.style, {
            width:      '1px',
            alignSelf:  'stretch',
            margin:     '2px 2px',
            background: 'var(--border, #2a2d33)',
        });
        this.root.appendChild(sep);

        for (const k of KINDS) {
            const btn = this._makeButton({
                id:    k.id,
                label: k.label,
                title: `Toggle ${k.label} picking (${k.short})`,
            });
            btn.addEventListener('click', () => this.toggle(k.id));
            this._buttons.set(k.id, btn);
            this.root.appendChild(btn);
        }

        host.appendChild(this.root);
        this._refreshButtons();
    }

    /** Toggle a single kind on/off. */
    toggle(id) {
        if (!ALL_IDS.includes(id)) return;
        if (this.active.has(id)) this.active.delete(id);
        else this.active.add(id);
        this._apply();
        this._persist();
        this._refreshButtons();
    }

    /** Clear all toggles — back to "accept everything". */
    reset() {
        this.active.clear();
        this._apply();
        this._persist();
        this._refreshButtons();
    }

    /** @returns {string[]} */
    getActiveKinds() { return [...this.active]; }

    dispose() {
        if (this.root && this.root.parentNode) {
            this.root.parentNode.removeChild(this.root);
        }
        this._buttons.clear();
        this._allButton = null;
        this.root = null;
        this.host = null;
    }

    // ── Internals ────────────────────────────────────────────────────────────

    _makeButton({ id, label, title }) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = label;
        b.title = title;
        b.dataset.kind = id;
        Object.assign(b.style, {
            padding:        '3px 8px',
            borderRadius:   '4px',
            border:         '1px solid transparent',
            background:     'transparent',
            color:          'inherit',
            cursor:         'pointer',
            font:           'inherit',
            lineHeight:     '1.1',
            transition:     'background 80ms ease, color 80ms ease',
        });
        b.addEventListener('pointerenter', () => {
            if (!b.dataset.active) b.style.background = 'var(--accent, rgba(255,255,255,0.06))';
        });
        b.addEventListener('pointerleave', () => {
            if (!b.dataset.active) b.style.background = 'transparent';
        });
        return b;
    }

    _refreshButtons() {
        const noneActive = this.active.size === 0;
        for (const [id, btn] of this._buttons) {
            const on = this.active.has(id);
            if (on) {
                btn.dataset.active = '1';
                btn.style.background = 'var(--primary, #3f8dff)';
                btn.style.color      = 'var(--primary-foreground, #fff)';
                btn.style.borderColor = 'var(--primary, #3f8dff)';
                btn.setAttribute('aria-pressed', 'true');
            } else {
                delete btn.dataset.active;
                btn.style.background = 'transparent';
                btn.style.color      = 'var(--muted-foreground, #a3a7ad)';
                btn.style.borderColor = 'transparent';
                btn.setAttribute('aria-pressed', 'false');
            }
        }
        if (this._allButton) {
            if (noneActive) {
                this._allButton.dataset.active = '1';
                this._allButton.style.background = 'var(--accent, rgba(255,255,255,0.10))';
                this._allButton.style.color      = 'var(--foreground, #e5e7eb)';
                this._allButton.setAttribute('aria-pressed', 'true');
            } else {
                delete this._allButton.dataset.active;
                this._allButton.style.background = 'transparent';
                this._allButton.style.color      = 'var(--muted-foreground, #a3a7ad)';
                this._allButton.setAttribute('aria-pressed', 'false');
            }
        }
    }

    /** Push the current set into the PickingSelection singleton. */
    _apply() {
        try {
            // Empty set OR full set => clear (== accept every kind). The full-set
            // case matters because clicking every button manually should feel
            // identical to clicking "All".
            if (this.active.size === 0 || this.active.size === ALL_IDS.length) {
                this.selection.setKindFilter(null);
            } else {
                this.selection.setKindFilter([...this.active]);
            }
        } catch (err) {
            console.warn('[SelectionFilterToolbar] setKindFilter failed:', err);
        }
    }

    _persist() {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify([...this.active])); }
        catch {}
    }

    _restore() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return new Set();
            const arr = JSON.parse(raw);
            if (!Array.isArray(arr)) return new Set();
            return new Set(arr.filter((id) => ALL_IDS.includes(id)));
        } catch {
            return new Set();
        }
    }
}
