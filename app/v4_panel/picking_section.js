/**
 * PickingSection — shows the user's current face / edge selection in the
 * v4 panel: count, a short list, and a Clear button.
 *
 * Reads from a `PickingSelection` instance (lib/picking/selection.js) and
 * re-renders on every event. Pure DOM, no Three.js — the visual overlay
 * lives elsewhere; this section is the textual / interactive surface.
 *
 *   const ps = new PickingSection(host, selection);
 *   ps.destroy();
 *
 * Entries render as `<kind> · <featureId-short>:<part>` so the user can
 * tell a +Z face on `box_1` from one on `box_2` at a glance.
 */

export class PickingSection {
    /**
     * @param {HTMLElement}      host
     * @param {object}           selection  - PickingSelection-shaped {toArray, clear, remove, subscribe}
     */
    constructor(host, selection) {
        if (!host)      throw new Error('PickingSection: missing host');
        if (!selection) throw new Error('PickingSection: missing selection');
        this.host      = host;
        this.selection = selection;
        this._hover    = null;          // latest hover pick result, for live status line
        this._unsub = selection.subscribe(() => this.render());
        this.render();
    }

    destroy() {
        if (this._unsub) this._unsub();
        this.host.innerHTML = '';
    }

    /**
     * Update the live "Hovering:" status line. The picker wiring calls this
     * on every pointer-move so the user sees the picker is firing even
     * before they click anything.
     */
    setHover(pickResult) {
        this._hover = pickResult || null;
        this._updateHoverLine();
    }

    _updateHoverLine() {
        if (!this._hoverEl) return;
        if (this._hover && this._hover.descriptor) {
            this._hoverEl.textContent = `Hovering: ${formatDescriptor(this._hover.descriptor)}`;
            this._hoverEl.classList.add('pf4-pick-hover-live');
        } else {
            this._hoverEl.textContent = 'Hover a body to highlight a face.';
            this._hoverEl.classList.remove('pf4-pick-hover-live');
        }
    }

    render() {
        const entries  = this.selection.toArray();
        const ownerDoc = this.host.ownerDocument;
        this.host.innerHTML = '';

        const head = ownerDoc.createElement('div');
        head.className = 'pf4-pick-head';

        const title = ownerDoc.createElement('span');
        title.className = 'pf4-pick-title';
        title.textContent = `Selection · ${entries.length}`;
        head.appendChild(title);

        if (entries.length) {
            const clear = ownerDoc.createElement('button');
            clear.className = 'pf4-pick-clear';
            clear.textContent = 'Clear';
            clear.title = 'Clear the picked face / edge selection';
            clear.addEventListener('click', () => this.selection.clear());
            head.appendChild(clear);
        }
        this.host.appendChild(head);

        // Live hover status — updates every pointermove via setHover().
        const hover = ownerDoc.createElement('div');
        hover.className = 'pf4-pick-hover';
        this.host.appendChild(hover);
        this._hoverEl = hover;
        this._updateHoverLine();

        if (!entries.length) {
            const empty = ownerDoc.createElement('div');
            empty.className = 'pf4-pick-empty';
            empty.textContent = 'Click a highlighted face to select. Shift-click to add to the set.';
            this.host.appendChild(empty);
            return;
        }

        const list = ownerDoc.createElement('div');
        list.className = 'pf4-pick-list';
        for (const entry of entries) {
            list.appendChild(this._renderRow(entry));
        }
        this.host.appendChild(list);
    }

    _renderRow(entry) {
        const ownerDoc = this.host.ownerDocument;
        const row = ownerDoc.createElement('div');
        row.className = 'pf4-pick-row';
        row.dataset.key = entry.key;

        const label = ownerDoc.createElement('span');
        label.className = 'pf4-pick-label';
        label.textContent = formatDescriptor(entry.descriptor);
        row.appendChild(label);

        const del = ownerDoc.createElement('button');
        del.className = 'pf4-pick-del';
        del.textContent = '×';
        del.title = 'Remove from selection';
        del.addEventListener('click', () => this.selection.remove(entry.key));
        row.appendChild(del);
        return row;
    }
}

/**
 * Compact human-readable summary of a descriptor.
 *   { kind:'face', feature:'box_xyz', opTag:'box', part:'+Z' } → 'face · box…xyz : +Z'
 */
export function formatDescriptor(d) {
    if (!d) return '?';
    const feat = d.feature || '';
    const short = feat.length > 10 ? `${feat.slice(0, 4)}…${feat.slice(-4)}` : feat;
    const tail  = d.part ? ` : ${d.part}` : '';
    return `${d.kind || '?'} · ${short}${tail}`;
}
