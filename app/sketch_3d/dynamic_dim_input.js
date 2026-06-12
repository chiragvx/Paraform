/**
 * Dynamic dimension input — Fusion/Onshape-style typeable fields that follow
 * the cursor while drawing. Two short input boxes (length + angle for lines;
 * radius for circles; width + height for rectangles) sit just below-right of
 * the cursor. Each box has two modes:
 *
 *   FOLLOW   — the value updates every frame from the current cursor
 *              position (the user has not typed anything).
 *   LOCKED   — the user typed a number; that number is "locked" until they
 *              clear the field or commit. Locked values become DRIVING
 *              DIMENSIONS when the tool commits the new entity.
 *
 * Tab moves focus from length → angle (cycle). Enter commits via the tool's
 * onCommit callback. Escape clears the locks.
 *
 * The input row is mouse-cursor-aware: hovering it does not block clicks on
 * the canvas because `pointer-events: none` is on the container, but the
 * individual `<input>` and `<label>` elements re-enable pointer events so the
 * user can click into a field.
 *
 * Pure HTML / DOM — no Three.js or sketch-data dependency. The owning tool
 * supplies the values and gets back a `getLocks()` callback at commit time.
 */

const ROW_CLASS   = 'pf4-sk3d-dyn';
const FIELD_CLASS = 'pf4-sk3d-dyn-field';

export class DynamicDimInput {
    /** @param {HTMLElement} hostEl */
    constructor(hostEl) {
        if (!hostEl) throw new Error('DynamicDimInput: missing host');
        this.host = hostEl;
        this.el = (typeof document !== 'undefined') ? document.createElement('div') : null;
        if (this.el) {
            this.el.className = ROW_CLASS;
            this.el.style.display = 'none';
            this.host.appendChild(this.el);
        }
        /** Field state. `value` is the live display value; `lock` is non-null
         *  iff the user typed something. `key` matches the descriptor. */
        this._fields = [];
        /** Layout signature for cheap render-skip. */
        this._sig = '';
        /** Latest commit callback, called when Enter is pressed in any field. */
        this._onCommit = null;
    }

    /**
     * Mount fields for a given tool descriptor and supply the per-frame
     * value providers. `descriptor` is an array of:
     *
     *     { key: 'length',  label: 'L', unit: 'mm', step: 0.1 }
     *     { key: 'angle',   label: '∠', unit: '°',  step: 1 }
     *
     * `onCommit({locks})` fires when Enter is pressed. `locks` is a record of
     * `{ key → number }` for every locked field.
     *
     * Calling this again with the same descriptor key list is a no-op
     * (preserves locks). Calling with a different shape rebuilds the DOM.
     */
    open(descriptor, onCommit) {
        if (!this.el) return;
        this._onCommit = onCommit || null;
        const sig = descriptor.map(d => d.key).join('|');
        if (sig === this._sig) return;
        this._sig = sig;
        this.el.innerHTML = '';
        this._fields = [];
        for (const d of descriptor) {
            const field = document.createElement('label');
            field.className = FIELD_CLASS;
            field.dataset.key = d.key;
            field.innerHTML =
                `<span class="pf4-sk3d-dyn-label">${d.label || d.key}</span>` +
                `<input type="text" inputmode="decimal" data-key="${d.key}" tabindex="0" />` +
                `<span class="pf4-sk3d-dyn-unit">${d.unit || ''}</span>`;
            const input = field.querySelector('input');
            input.addEventListener('keydown', (ev) => this._onKey(ev, d.key));
            input.addEventListener('input',   ()   => this._onInput(d.key, input.value));
            this.el.appendChild(field);
            this._fields.push({ key: d.key, descriptor: d, el: field, input, lock: null });
        }
        this.el.style.display = 'flex';
    }

    /**
     * Per-frame update — pump current cursor-derived values into any field
     * that isn't locked. `values` is `{ key → number }`.
     */
    update(values, screenAt) {
        if (!this.el || !this._fields.length) return;
        for (const f of this._fields) {
            const v = values?.[f.key];
            if (f.lock == null && Number.isFinite(v)) {
                // Avoid stealing focus from a user mid-edit: only refresh the
                // display when the input is not focused.
                if (document.activeElement !== f.input) {
                    f.input.value = Number(v).toFixed(2);
                }
            }
        }
        if (screenAt) {
            this.el.style.left = `${screenAt.x + 18}px`;
            this.el.style.top  = `${screenAt.y - 6}px`;
        }
    }

    /** Returns `{ key → number }` for every locked field. */
    getLocks() {
        const locks = {};
        for (const f of this._fields) {
            if (f.lock != null) locks[f.key] = f.lock;
        }
        return locks;
    }

    /** Clear all locks (e.g. after committing one line in a chain). */
    clearLocks() {
        for (const f of this._fields) f.lock = null;
    }

    /** Close the row and forget the descriptor. */
    close() {
        if (this.el) {
            this.el.style.display = 'none';
            this.el.innerHTML = '';
        }
        this._fields = [];
        this._sig = '';
        this._onCommit = null;
    }

    destroy() {
        this.close();
        if (this.el && this.el.parentNode) this.el.parentNode.removeChild(this.el);
        this.el = null;
    }

    /** True if any field has been typed into. */
    hasLocks() {
        return this._fields.some(f => f.lock != null);
    }

    /** Focus the first field (used when the user presses Tab from canvas). */
    focusFirst() {
        if (this._fields[0]) this._fields[0].input.focus();
    }

    // ── Internal ───────────────────────────────────────────────────────────

    _onInput(key, raw) {
        const f = this._fields.find(x => x.key === key);
        if (!f) return;
        const v = parseFloat(raw);
        f.lock = Number.isFinite(v) ? v : null;
    }

    _onKey(ev, key) {
        // Don't let global sketch hotkeys (L, R, V, …) hijack typing.
        ev.stopPropagation();
        if (ev.key === 'Enter') {
            ev.preventDefault();
            // If the user typed in this field but the parser couldn't lock,
            // re-parse defensively.
            const f = this._fields.find(x => x.key === key);
            if (f) {
                const v = parseFloat(f.input.value);
                if (Number.isFinite(v)) f.lock = v;
            }
            if (this._onCommit) {
                try { this._onCommit({ locks: this.getLocks() }); }
                catch (err) { console.error('[sk3d dyn-dim commit]', err); }
            }
            return;
        }
        if (ev.key === 'Tab') {
            ev.preventDefault();
            this._cycleFocus(key, ev.shiftKey ? -1 : 1);
            return;
        }
        if (ev.key === 'Escape') {
            ev.preventDefault();
            this.clearLocks();
            for (const f of this._fields) f.input.blur();
            return;
        }
    }

    _cycleFocus(currentKey, dir) {
        if (!this._fields.length) return;
        const idx = this._fields.findIndex(f => f.key === currentKey);
        const next = ((idx + dir) % this._fields.length + this._fields.length) % this._fields.length;
        const target = this._fields[next];
        if (target) {
            target.input.focus();
            target.input.select();
        }
    }
}
