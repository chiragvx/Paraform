/**
 * Floating dimension readout — an HTML overlay positioned by the controller
 * that displays the current drawing dimensions in real time.
 *
 * Format depends on the tool:
 *   line     → "L = 25.4 mm   ∠ 45°"
 *   rect     → "W × H = 20.0 × 12.5 mm"
 *   circle   → "R = 12.5 mm"
 *   polygon  → "R = 8.0 mm   N = 6"
 */

export class DimReadout {
    constructor(hostEl) {
        if (!hostEl) throw new Error('DimReadout: missing host');
        this.host = hostEl;
        this.el = document.createElement('div');
        this.el.className = 'pf4-sk3d-dim';
        this.el.style.display = 'none';
        this.host.appendChild(this.el);
    }

    /** Hide the readout. */
    clear() {
        this.el.style.display = 'none';
    }

    /**
     * Update the readout text and position.
     *
     * @param {object} info  — { kind, anchor, cursor, length?, angleDeg?, width?, height?, radius?, sides? }
     * @param {{x:number,y:number}} screenAt — screen-relative coords for placement
     */
    update(info, screenAt) {
        if (!info) { this.clear(); return; }
        this.el.innerHTML = this._format(info);
        this.el.style.display = 'flex';
        this.el.style.left = `${screenAt.x + 14}px`;
        this.el.style.top  = `${screenAt.y + 14}px`;
    }

    destroy() {
        if (this.el && this.el.parentNode) this.el.parentNode.removeChild(this.el);
    }

    _format(info) {
        const f = (v) => Number.isFinite(v) ? v.toFixed(2) : '—';
        switch (info.kind) {
            case 'line': {
                const ang = info.angleDeg;
                const a   = Number.isFinite(ang) ? ((ang + 360) % 360).toFixed(1) : '—';
                return (
                    `<span class="pf4-sk3d-dim-num">L</span> ${f(info.length)} <span class="pf4-sk3d-dim-unit">mm</span>` +
                    `<span class="pf4-sk3d-dim-sep">·</span>` +
                    `<span class="pf4-sk3d-dim-num">∠</span> ${a}<span class="pf4-sk3d-dim-unit">°</span>`
                );
            }
            case 'rect':
                return (
                    `<span class="pf4-sk3d-dim-num">W×H</span> ${f(info.width)} × ${f(info.height)} <span class="pf4-sk3d-dim-unit">mm</span>`
                );
            case 'circle':
                return (
                    `<span class="pf4-sk3d-dim-num">R</span> ${f(info.radius)} <span class="pf4-sk3d-dim-unit">mm</span>`
                );
            case 'polygon':
                return (
                    `<span class="pf4-sk3d-dim-num">R</span> ${f(info.radius)} <span class="pf4-sk3d-dim-unit">mm</span>` +
                    `<span class="pf4-sk3d-dim-sep">·</span>` +
                    `<span class="pf4-sk3d-dim-num">N</span> ${info.sides|0}`
                );
            default:
                return '';
        }
    }
}
