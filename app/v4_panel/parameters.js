/**
 * ParametersPanel — v4-aware replacement for the legacy template-parameter
 * slider panel. Reads `doc.parameters`, lets the user add / rename /
 * retype / delete each row. Every edit commits a change to the
 * DocumentStore, so undo + the executor's auto-rerun follow for free.
 *
 * Parameter shape (from lib/document/types.js:makeParameter):
 *   { id, name, value, unit, equation, createdAt }
 *
 * Each row exposes:
 *   - name input
 *   - value input (numeric — or expression starting with `=`)
 *   - unit input
 *   - delete button
 *
 * Equations beat values: if `equation` is non-null the kernel uses it; the
 * value field acts as a fallback. The UI shows whichever is "live"; if the
 * user types `=...` we move it into the equation field on commit.
 */

const DEFAULT_NEW_PARAM = { name: 'param', value: 1, unit: 'mm', equation: null };

export class ParametersPanel {
    /**
     * @param {HTMLElement} host
     * @param {object}      store     DocumentStore-shaped {doc, commit, subscribe}
     * @param {object}      ops       Bound operations { add, set, remove }
     */
    constructor(host, store, ops) {
        if (!host)  throw new Error('ParametersPanel: missing host');
        if (!store) throw new Error('ParametersPanel: missing store');
        if (!ops || !ops.add || !ops.set || !ops.remove) {
            throw new Error('ParametersPanel: ops must provide add/set/remove');
        }
        this.host  = host;
        this.store = store;
        this.ops   = ops;
        this._unsub = store.subscribe(() => this.render());
        this.render();
    }

    destroy() {
        if (this._unsub) this._unsub();
        this.host.innerHTML = '';
    }

    render() {
        const doc = this.store.doc;
        const params = Object.values(doc.parameters || {}).sort(byCreatedAt);

        // Tear down + rebuild — params are few enough that reconciliation
        // isn't worth the complexity.
        this.host.innerHTML = '';
        const ownerDoc = this.host.ownerDocument;

        const head = ownerDoc.createElement('div');
        head.className = 'pf4-param-head';
        const title = ownerDoc.createElement('span');
        title.className = 'pf4-param-title';
        title.textContent = `Parameters · ${params.length}`;
        const addBtn = ownerDoc.createElement('button');
        addBtn.className = 'pf4-param-add';
        addBtn.textContent = '+ Add';
        addBtn.title = 'Add a new document parameter';
        addBtn.addEventListener('click', () => this._addParam());
        head.appendChild(title);
        head.appendChild(addBtn);
        this.host.appendChild(head);

        if (!params.length) {
            const empty = ownerDoc.createElement('div');
            empty.className = 'pf4-param-empty';
            empty.textContent = 'No parameters. Add one to drive feature values via expressions.';
            this.host.appendChild(empty);
            return;
        }

        const list = ownerDoc.createElement('div');
        list.className = 'pf4-param-list';
        for (const p of params) {
            list.appendChild(this._renderRow(p));
        }
        this.host.appendChild(list);
    }

    _renderRow(p) {
        const ownerDoc = this.host.ownerDocument;
        const row = ownerDoc.createElement('div');
        row.className = 'pf4-param-row';
        row.dataset.paramId = p.id;

        const nameIn = ownerDoc.createElement('input');
        nameIn.className = 'pf4-param-name';
        nameIn.value = p.name || '';
        nameIn.title = 'Parameter name. Used in `=name` expressions.';
        nameIn.addEventListener('change', () => this._commitField(p, 'name', nameIn.value.trim()));
        nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') nameIn.blur(); });

        const valIn = ownerDoc.createElement('input');
        valIn.className = 'pf4-param-val';
        valIn.title = 'Numeric value, or expression starting with `=`.';
        // Display the equation if there is one; otherwise the value.
        valIn.value = (p.equation != null) ? p.equation : String(p.value);
        valIn.addEventListener('change', () => this._commitValue(p, valIn.value.trim()));
        valIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') valIn.blur(); });

        const unitIn = ownerDoc.createElement('input');
        unitIn.className = 'pf4-param-unit';
        unitIn.value = p.unit || '';
        unitIn.placeholder = 'mm';
        unitIn.title = 'Unit hint (informational).';
        unitIn.addEventListener('change', () => this._commitField(p, 'unit', unitIn.value.trim()));

        const del = ownerDoc.createElement('button');
        del.className = 'pf4-param-del';
        del.textContent = '×';
        del.title = `Delete ${p.name}`;
        del.addEventListener('click', () => this._removeParam(p));

        row.appendChild(nameIn);
        row.appendChild(valIn);
        row.appendChild(unitIn);
        row.appendChild(del);
        return row;
    }

    _addParam() {
        // Find a unique default name (param, param2, param3, …)
        const existing = new Set(Object.values(this.store.doc.parameters || {}).map(p => p.name));
        let name = DEFAULT_NEW_PARAM.name;
        let i = 2;
        while (existing.has(name)) { name = `${DEFAULT_NEW_PARAM.name}${i++}`; }
        try {
            this.ops.add(name, DEFAULT_NEW_PARAM.value, DEFAULT_NEW_PARAM.unit, DEFAULT_NEW_PARAM.equation);
        } catch (err) {
            this._flash(err.message || String(err), 'error');
        }
    }

    _commitField(p, field, value) {
        if (field === 'name' && !value) {
            this._flash('Parameter name cannot be empty.', 'error');
            this.render();
            return;
        }
        if (field === 'name' && value === p.name) return;
        if (field === 'name') {
            // Block rename to an existing name.
            for (const other of Object.values(this.store.doc.parameters || {})) {
                if (other.id !== p.id && other.name === value) {
                    this._flash(`"${value}" is already used.`, 'error');
                    this.render();
                    return;
                }
            }
        }
        try {
            this.ops.set(p.id, { [field]: value });
        } catch (err) {
            this._flash(err.message || String(err), 'error');
        }
    }

    _commitValue(p, raw) {
        // Expression mode: `=expr` lives on `equation`, value stays as a fallback.
        if (raw.startsWith('=')) {
            this.ops.set(p.id, { equation: raw });
            return;
        }
        // Numeric mode: clear any existing equation.
        const n = Number(raw);
        if (!Number.isFinite(n)) {
            this._flash(`"${raw}" is not a number or expression.`, 'error');
            this.render();
            return;
        }
        const patch = { value: n };
        if (p.equation != null) patch.equation = null;
        this.ops.set(p.id, patch);
    }

    _removeParam(p) {
        try {
            this.ops.remove(p.id);
        } catch (err) {
            this._flash(err.message || String(err), 'error');
        }
    }

    _flash(msg, kind = 'info') {
        // Lightweight inline error — no toast dependency. The host panel's
        // status line is the canonical surface; we'll just log here.
        if (this.onMessage) {
            try { this.onMessage(msg, kind); } catch {}
        } else {
            console.warn('[parameters]', msg);
        }
    }
}

function byCreatedAt(a, b) {
    return (a.createdAt || 0) - (b.createdAt || 0);
}
