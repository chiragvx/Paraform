/**
 * Inspector — property editor for the currently-selected v4 feature.
 *
 * Driven by the schemas in `schemas.js`. For each FieldSpec we render the
 * matching control (numeric input, checkbox, dropdown, vec3, text); on
 * change we coerce the raw value via `coerceField`, build a `set-params`
 * change, and commit it through the DocumentStore. The bridge sees the
 * commit and regenerates.
 *
 * Coercion failures surface inline as a small error message under the field
 * — no toast spam.
 */

import { schemaFor, coerceField, typeLabel } from './schemas.js';

export class Inspector {
    /**
     * @param {HTMLElement} host
     * @param {DocumentStore} store
     */
    constructor(host, store) {
        if (!host) throw new Error('Inspector: missing host');
        if (!store) throw new Error('Inspector: missing store');
        this.host  = host;
        this.store = store;
        this._unsub = this.store.subscribe(() => this.render());
        this.render();
    }

    destroy() {
        if (this._unsub) this._unsub();
        this.host.innerHTML = '';
    }

    /** Re-render. Cheap — the inspector deals with at most a few fields. */
    render() {
        const id   = this.store.selectedFeatureId();
        const feat = id ? this.store.doc.features[id] : null;
        if (!feat) {
            this.host.innerHTML =
                `<div class="pf4-insp-empty">Select a feature in the tree to edit its parameters.</div>`;
            return;
        }
        const schema = schemaFor(feat.type);
        // Honour conditional `hidden(params)` predicates so dependent fields
        // (e.g. Hole counterbore dimensions) only appear when relevant.
        const visibleSchema = schema.filter(spec => {
            if (typeof spec.hidden !== 'function') return true;
            try { return !spec.hidden(feat.params || {}); }
            catch { return true; }
        });
        const rows   = visibleSchema.map(spec => this._renderField(feat, spec)).join('');

        const isSketch = feat.type === 'Sketch' || feat.type === 'SketchOnFace';
        const sketchActions = isSketch
            ? `<div class="pf4-insp-actions"><button class="pf4-insp-btn" data-act="edit-sketch">Edit Sketch</button></div>`
            : '';

        this.host.innerHTML =
            `<div class="pf4-insp-head">` +
              `<div class="pf4-insp-head-title">${esc(feat.name || typeLabel(feat.type))}</div>` +
              `<div class="pf4-insp-head-type">${esc(typeLabel(feat.type))}</div>` +
              `<div class="pf4-insp-head-id">${esc(feat.id)}</div>` +
            `</div>` +
            sketchActions +
            (visibleSchema.length
                ? `<div class="pf4-insp-fields">${rows}</div>`
                : `<div class="pf4-insp-empty">${isSketch ? 'Open Edit Sketch to modify the geometry.' : 'No editable parameters for ' + esc(typeLabel(feat.type)) + '.'}</div>`);

        const editBtn = this.host.querySelector('[data-act="edit-sketch"]');
        if (editBtn) {
            editBtn.addEventListener('click', () => {
                document.dispatchEvent(new CustomEvent('pf4-edit-sketch', { detail: { featureId: feat.id } }));
            });
        }

        // Wire field inputs
        for (const fieldEl of this.host.querySelectorAll('[data-field]')) {
            const key = fieldEl.dataset.field;
            const spec = schema.find(s => s.key === key);
            if (!spec) continue;
            fieldEl.addEventListener('change', (ev) => this._onChange(feat.id, spec, ev.target));
            if (spec.kind === 'number' || spec.kind === 'int' || spec.kind === 'text') {
                fieldEl.addEventListener('keydown', (ev) => {
                    if (ev.key === 'Enter') ev.target.blur();
                });
            }
        }
    }

    _renderField(feat, spec) {
        const value = feat.params?.[spec.key];
        const ctrl  = this._renderControl(spec, value);
        const unit  = spec.unit ? `<span class="pf4-field-unit">${esc(spec.unit)}</span>` : '';
        return (
            `<div class="pf4-field" data-field-row="${esc(spec.key)}">` +
              `<label class="pf4-field-label" for="pf4-f-${esc(spec.key)}">${esc(spec.label)}</label>` +
              `<div class="pf4-field-control">${ctrl}${unit}</div>` +
              `<div class="pf4-field-error" data-error-for="${esc(spec.key)}"></div>` +
            `</div>`
        );
    }

    _renderControl(spec, value) {
        const id = `pf4-f-${esc(spec.key)}`;
        const ro = spec.readOnly ? ' readonly' : '';
        const dis = spec.readOnly ? ' disabled' : '';
        switch (spec.kind) {
            case 'number':
            case 'int': {
                const v = (typeof value === 'string' && value.startsWith('=')) ? value : (value ?? '');
                const step = spec.step != null ? ` step="${spec.step}"` : '';
                const min  = spec.min  != null ? ` min="${spec.min}"`   : '';
                const max  = spec.max  != null ? ` max="${spec.max}"`   : '';
                // text input so we accept expressions (`=wall * 2`)
                return `<input id="${id}" type="text" inputmode="decimal" data-field="${esc(spec.key)}" value="${esc(v)}"${step}${min}${max}${ro} />`;
            }
            case 'bool':
                return `<input id="${id}" type="checkbox" data-field="${esc(spec.key)}" ${value ? 'checked' : ''}${dis} />`;
            case 'enum': {
                const opts = (spec.options || []).map(o =>
                    `<option value="${esc(o.value)}" ${o.value === value ? 'selected' : ''}>${esc(o.label)}</option>`
                ).join('');
                return `<select id="${id}" data-field="${esc(spec.key)}"${dis}>${opts}</select>`;
            }
            case 'vec3': {
                const [x = 0, y = 0, z = 0] = Array.isArray(value) ? value : [0, 0, 0];
                return (
                    `<span class="pf4-vec3">` +
                      `<input data-field="${esc(spec.key)}" data-vec="x" type="text" inputmode="decimal" value="${esc(x)}"${ro} />` +
                      `<input data-field="${esc(spec.key)}" data-vec="y" type="text" inputmode="decimal" value="${esc(y)}"${ro} />` +
                      `<input data-field="${esc(spec.key)}" data-vec="z" type="text" inputmode="decimal" value="${esc(z)}"${ro} />` +
                    `</span>`
                );
            }
            case 'text':
            case 'expr':
            default:
                return `<input id="${id}" type="text" data-field="${esc(spec.key)}" value="${esc(value ?? '')}"${ro} />`;
        }
    }

    _onChange(featureId, spec, el) {
        const errEl = this.host.querySelector(`[data-error-for="${spec.key}"]`);
        if (errEl) errEl.textContent = '';
        try {
            let raw;
            if (spec.kind === 'vec3') {
                const xs = this.host.querySelectorAll(`[data-field="${spec.key}"][data-vec]`);
                raw = [...xs].map(i => i.value);
            } else if (spec.kind === 'bool') {
                raw = el.checked;
            } else {
                raw = el.value;
            }
            const coerced = coerceField(spec, raw);
            import('../../lib/document/changelog.js').then(({ setParamsChange }) => {
                this.store.commit(setParamsChange(featureId, { [spec.key]: coerced }));
            });
        } catch (err) {
            if (errEl) errEl.textContent = err.message;
        }
    }
}

function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
