/**
 * PromptModal — a small modal that asks the user for feature parameters
 * before the feature is committed.
 *
 * Shape:
 *   const params = await promptForParams({
 *     title:    'Fillet',
 *     subtitle: '3 edges selected',
 *     schema:   schemaFor('Fillet'),     // a FieldSpec[]
 *     initial:  { radius: 1 },           // pre-fill values
 *     submit:   'Apply',                  // button text (default 'OK')
 *   });
 *   if (params) {
 *     // user confirmed — params is { radius: <coerced> }
 *   } else {
 *     // user cancelled (Esc, ✕ button, or backdrop click)
 *   }
 *
 * The modal renders identical controls to the Inspector but never
 * touches the store — its only job is to collect a validated `params`
 * object and resolve. The caller commits the feature.
 *
 * Keyboard:
 *   Enter           — submit (unless the focused control is a textarea)
 *   Esc / backdrop  — cancel
 *
 * Validation:
 *   On submit we run `coerceField` on every key in the schema. Any
 *   failure surfaces inline under the field and the modal stays open.
 *   The Promise only resolves once all fields validate.
 */

import { coerceField } from './schemas.js';

const MODAL_HOST_ID = 'pf4-prompt-modal-host';

export function promptForParams({
    title,
    subtitle = '',
    schema = [],
    initial = {},
    submit = 'OK',
    cancel = 'Cancel',
    /**
     * Optional live-preview hook. Fires (debounced by `liveDebounceMs`) every
     * time the user edits a field AND all currently-visible fields coerce
     * cleanly. Used by Edit-Feature to push a `setParamsChange` so the
     * viewport regenerates while the dialog is still open.
     * Signature: (coercedParams) => void
     */
    onLiveChange = null,
    liveDebounceMs = 150,
} = {}) {
    if (!schema.length) {
        // No fields → resolve immediately with the initial values.
        return Promise.resolve({ ...initial });
    }
    return new Promise((resolve) => {
        const doc = (typeof document !== 'undefined') ? document : null;
        if (!doc) { resolve(null); return; }

        const host = ensureHost(doc);
        host.innerHTML = '';
        host.style.display = 'flex';

        const backdrop = doc.createElement('div');
        backdrop.className = 'pf4-prompt-backdrop';
        host.appendChild(backdrop);

        const modal = doc.createElement('div');
        modal.className = 'pf4-prompt-modal';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        backdrop.appendChild(modal);

        // Header
        const head = doc.createElement('div');
        head.className = 'pf4-prompt-head';
        const titleEl = doc.createElement('div');
        titleEl.className = 'pf4-prompt-title';
        titleEl.textContent = title || '';
        head.appendChild(titleEl);
        if (subtitle) {
            const sub = doc.createElement('div');
            sub.className = 'pf4-prompt-sub';
            sub.textContent = subtitle;
            head.appendChild(sub);
        }
        modal.appendChild(head);

        // Field list
        const fields = doc.createElement('div');
        fields.className = 'pf4-prompt-fields';
        modal.appendChild(fields);

        // Current draft (mutated as user types)
        const draft = { ...initial };

        // Visible schema honours `hidden(params)` predicates so e.g. Hole's
        // counter-bore-only fields stay tucked away when type === 'simple'.
        const visible = () => schema.filter(s => {
            if (typeof s.hidden !== 'function') return true;
            try { return !s.hidden(draft); } catch { return true; }
        });

        // Debounced live-preview. Only fires if every visible field coerces.
        let liveTimer = null;
        const scheduleLivePreview = () => {
            if (typeof onLiveChange !== 'function') return;
            if (liveTimer) clearTimeout(liveTimer);
            liveTimer = setTimeout(() => {
                liveTimer = null;
                const coerced = {};
                for (const spec of visible()) {
                    let raw = draft[spec.key];
                    if (raw === undefined && spec.default !== undefined) raw = spec.default;
                    try { coerced[spec.key] = coerceField(spec, raw); }
                    catch (_) { return; }   // skip preview while invalid
                }
                try { onLiveChange(coerced); }
                catch (err) { console.warn('[promptForParams onLiveChange]', err); }
            }, liveDebounceMs);
        };

        const render = () => {
            fields.innerHTML = '';
            for (const spec of visible()) {
                fields.appendChild(renderField(doc, spec, draft[spec.key], (key, raw) => {
                    draft[key] = raw;
                    // Re-render on any field that other fields' `hidden` predicates
                    // might depend on (e.g. Hole type enum). Cheap; modal is small.
                    if (spec.kind === 'enum' || spec.kind === 'bool') render();
                    scheduleLivePreview();
                }));
            }
        };
        render();

        // Footer (buttons)
        const foot = doc.createElement('div');
        foot.className = 'pf4-prompt-foot';
        const cancelBtn = doc.createElement('button');
        cancelBtn.className = 'pf4-prompt-cancel';
        cancelBtn.type = 'button';
        cancelBtn.textContent = cancel;
        const okBtn = doc.createElement('button');
        okBtn.className = 'pf4-prompt-ok';
        okBtn.type = 'button';
        okBtn.textContent = submit;
        foot.appendChild(cancelBtn);
        foot.appendChild(okBtn);
        modal.appendChild(foot);

        const finish = (result) => {
            if (liveTimer) { clearTimeout(liveTimer); liveTimer = null; }
            doc.removeEventListener('keydown', onKey, true);
            host.style.display = 'none';
            host.innerHTML = '';
            resolve(result);
        };

        const onSubmit = () => {
            // Coerce + collect. Inline errors per field; only resolve when all clean.
            const collected = {};
            let firstError = null;
            for (const spec of visible()) {
                clearError(fields, spec.key);
                let raw = draft[spec.key];
                if (raw === undefined && spec.default !== undefined) raw = spec.default;
                try {
                    collected[spec.key] = coerceField(spec, raw);
                } catch (err) {
                    setError(fields, spec.key, err.message);
                    if (!firstError) firstError = spec.key;
                }
            }
            if (firstError) {
                const el = fields.querySelector(`[data-field="${cssEscape(firstError)}"]`);
                if (el && typeof el.focus === 'function') el.focus();
                return;
            }
            finish(collected);
        };

        const onCancel = () => finish(null);

        cancelBtn.addEventListener('click', onCancel);
        okBtn.addEventListener('click', onSubmit);
        backdrop.addEventListener('click', (ev) => { if (ev.target === backdrop) onCancel(); });

        const onKey = (ev) => {
            if (ev.key === 'Escape') { ev.preventDefault(); onCancel(); return; }
            if (ev.key === 'Enter') {
                // Don't submit if the focus is in a multi-line control.
                if (ev.target && ev.target.tagName === 'TEXTAREA') return;
                ev.preventDefault();
                onSubmit();
            }
        };
        doc.addEventListener('keydown', onKey, true);

        // Auto-focus the first editable input.
        const first = fields.querySelector('input:not([disabled]), select:not([disabled])');
        if (first && typeof first.focus === 'function') {
            first.focus();
            if (typeof first.select === 'function') first.select();
        }
    });
}

// ── DOM helpers ─────────────────────────────────────────────────────────────

function ensureHost(doc) {
    let host = doc.getElementById(MODAL_HOST_ID);
    if (!host) {
        host = doc.createElement('div');
        host.id = MODAL_HOST_ID;
        host.style.position = 'fixed';
        host.style.inset = '0';
        host.style.zIndex = '9999';
        host.style.display = 'none';
        host.style.alignItems = 'center';
        host.style.justifyContent = 'center';
        doc.body.appendChild(host);
    }
    return host;
}

function renderField(doc, spec, value, onChange) {
    const row = doc.createElement('div');
    row.className = 'pf4-prompt-row';

    const label = doc.createElement('label');
    label.className = 'pf4-prompt-label';
    label.textContent = spec.label || spec.key;
    row.appendChild(label);

    const ctrl = renderControl(doc, spec, value, onChange);
    const ctrlWrap = doc.createElement('div');
    ctrlWrap.className = 'pf4-prompt-control';
    ctrlWrap.appendChild(ctrl);
    if (spec.unit) {
        const unit = doc.createElement('span');
        unit.className = 'pf4-prompt-unit';
        unit.textContent = spec.unit;
        ctrlWrap.appendChild(unit);
    }
    row.appendChild(ctrlWrap);

    const err = doc.createElement('div');
    err.className = 'pf4-prompt-error';
    err.dataset.errorFor = spec.key;
    row.appendChild(err);

    return row;
}

function renderControl(doc, spec, value, onChange) {
    switch (spec.kind) {
        case 'bool': {
            const el = doc.createElement('input');
            el.type = 'checkbox';
            el.dataset.field = spec.key;
            el.checked = !!value;
            el.addEventListener('change', () => onChange(spec.key, el.checked));
            return el;
        }
        case 'enum': {
            const el = doc.createElement('select');
            el.dataset.field = spec.key;
            for (const o of spec.options || []) {
                const opt = doc.createElement('option');
                opt.value = o.value;
                opt.textContent = o.label;
                if (o.value === value) opt.selected = true;
                el.appendChild(opt);
            }
            el.addEventListener('change', () => onChange(spec.key, el.value));
            return el;
        }
        case 'vec3': {
            const wrap = doc.createElement('span');
            wrap.className = 'pf4-prompt-vec3';
            const [x = 0, y = 0, z = 0] = Array.isArray(value) ? value : [0, 0, 0];
            const make = (which, initial) => {
                const i = doc.createElement('input');
                i.type = 'text';
                i.inputMode = 'decimal';
                i.dataset.field = spec.key;
                i.dataset.vec = which;
                i.value = String(initial);
                i.addEventListener('input', () => {
                    const xs = wrap.querySelectorAll('input');
                    onChange(spec.key, [...xs].map(n => n.value));
                });
                return i;
            };
            wrap.appendChild(make('x', x));
            wrap.appendChild(make('y', y));
            wrap.appendChild(make('z', z));
            return wrap;
        }
        case 'text':
        case 'expr': {
            const el = doc.createElement('input');
            el.type = 'text';
            el.dataset.field = spec.key;
            el.value = value ?? '';
            el.addEventListener('input', () => onChange(spec.key, el.value));
            return el;
        }
        case 'number':
        case 'int':
        default: {
            const el = doc.createElement('input');
            el.type = 'text';
            el.inputMode = 'decimal';
            el.dataset.field = spec.key;
            const v = (typeof value === 'string' && value.startsWith('=')) ? value : (value ?? '');
            el.value = String(v);
            el.addEventListener('input', () => onChange(spec.key, el.value));
            return el;
        }
    }
}

function setError(host, key, message) {
    const el = host.querySelector(`[data-error-for="${cssEscape(key)}"]`);
    if (el) el.textContent = message;
}

function clearError(host, key) {
    const el = host.querySelector(`[data-error-for="${cssEscape(key)}"]`);
    if (el) el.textContent = '';
}

function cssEscape(s) {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(s);
    return String(s).replace(/[^a-zA-Z0-9_-]/g, ch => `\\${ch}`);
}
