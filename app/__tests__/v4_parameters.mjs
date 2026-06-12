/**
 * Tests for app/v4_panel/parameters.js — the v4-aware Parameters section
 * that drives doc.parameters via the bound ops handlers.
 *
 * Tests use the same lightweight DOM shim as v4_feature_menu.mjs, plus a
 * stub DocumentStore so we don't depend on the real store wiring.
 *
 * Run via:  node app/__tests__/v4_parameters.mjs
 */

import assert from 'node:assert/strict';
import { ParametersPanel } from '../v4_panel/parameters.js';

// ── DOM shim (matches feature_menu's stub) ──────────────────────────────────
function makeFakeDoc() {
    const dom = {};
    const makeEl = (tag) => ({
        tagName: tag.toUpperCase(),
        children: [], childNodes: [],
        attrs: {}, dataset: {},
        classList: { _set: new Set(), add(c) { this._set.add(c); }, remove(c) { this._set.delete(c); }, contains(c) { return this._set.has(c); } },
        style: {},
        ownerDocument: dom,
        parentNode: null,
        _listeners: {},
        value: '',  placeholder: '', title: '', textContent: '',
        _innerHTML: '',
        get innerHTML() { return this._innerHTML; },
        set innerHTML(v) {
            this._innerHTML = String(v == null ? '' : v);
            // Real DOM behaviour: setting innerHTML clears every child.
            if (this._innerHTML === '') {
                for (const child of this.children) child.parentNode = null;
                this.children = [];
                this.childNodes = [];
            }
        },
        get className() { return [...this.classList._set].join(' '); },
        set className(v) { this.classList._set = new Set(String(v || '').split(/\s+/).filter(Boolean)); },
        setAttribute(k, v) { this.attrs[k] = v; },
        appendChild(child) { child.parentNode = this; this.children.push(child); this.childNodes.push(child); return child; },
        removeChild(child) { const i = this.children.indexOf(child); if (i >= 0) { this.children.splice(i, 1); this.childNodes.splice(i, 1); } child.parentNode = null; return child; },
        addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); },
        removeEventListener(type, fn) {
            const a = this._listeners[type] || [];
            const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1);
        },
        click() { for (const fn of (this._listeners.click || [])) fn({ target: this }); },
        // Simulate a real `change` event after editing `.value`.
        change()  { for (const fn of (this._listeners.change  || [])) fn({ target: this }); },
        blur()    { for (const fn of (this._listeners.blur    || [])) fn({ target: this }); },
        querySelectorAll(/* selector */) {
            // Minimal: ".pf4-param-row"
            const out = [];
            const walk = (n) => {
                if ((n.className || '').includes('pf4-param-row')) out.push(n);
                for (const c of n.children || []) walk(c);
            };
            walk(this);
            return out;
        },
        querySelector(selector) {
            const all = this.querySelectorAll(selector);
            return all[0] || null;
        },
    });
    dom.createElement = (tag) => makeEl(tag);
    dom.body = makeEl('body');
    return dom;
}

// ── Stub store + ops ────────────────────────────────────────────────────────
function makeStubStore(initialParams = {}) {
    const doc = { parameters: { ...initialParams } };
    const subs = [];
    return {
        doc,
        subscribe(fn) { subs.push(fn); return () => { const i = subs.indexOf(fn); if (i >= 0) subs.splice(i, 1); }; },
        _notify() { for (const fn of subs) fn(); },
    };
}
function makeOps(store) {
    let counter = 0;
    const add = (name, value, unit, equation) => {
        const id = `prm_${++counter}`;
        store.doc.parameters[id] = { id, name, value, unit, equation, createdAt: counter };
        store._notify();
        return store.doc.parameters[id];
    };
    const set = (id, patch) => {
        if (!store.doc.parameters[id]) return;
        store.doc.parameters[id] = { ...store.doc.parameters[id], ...patch };
        store._notify();
    };
    const remove = (id) => {
        if (!store.doc.parameters[id]) return false;
        delete store.doc.parameters[id];
        store._notify();
        return true;
    };
    return { add, set, remove };
}

const _tests = [];
let _suite = '';
function suite(name, fn) { _suite = name; fn(); _suite = ''; }
function test(name, fn)  { _tests.push({ suite: _suite, name, fn }); }
async function runAll() {
    let pass = 0, fail = 0;
    for (const t of _tests) {
        try { await t.fn(); pass++; console.log(`  \x1b[32m✓\x1b[0m ${t.suite ? t.suite + ' › ' : ''}${t.name}`); }
        catch (e) { fail++; console.log(`  \x1b[31m✗\x1b[0m ${t.suite ? t.suite + ' › ' : ''}${t.name}`); console.log(`    ${e.message}`); }
    }
    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail > 0) process.exit(1);
}

function setupPanel(initialParams = {}) {
    const dom = makeFakeDoc();
    const host = dom.createElement('div');
    dom.body.appendChild(host);
    const store = makeStubStore(initialParams);
    const ops = makeOps(store);
    const panel = new ParametersPanel(host, store, ops);
    return { dom, host, store, ops, panel };
}

// ── Rendering ───────────────────────────────────────────────────────────────
suite('ParametersPanel › rendering', () => {
    test('empty doc shows an empty-state message + Add button', () => {
        const { host } = setupPanel();
        const rows = host.querySelectorAll('.pf4-param-row');
        assert.equal(rows.length, 0);
        // Walk children to find the empty-state node.
        const dfs = (n, pred) => pred(n) ? n : (n.children || []).reduce((r, c) => r || dfs(c, pred), null);
        const empty = dfs(host, (n) => (n.className || '').includes('pf4-param-empty'));
        assert.ok(empty, 'empty-state element missing');
    });

    test('renders one row per parameter, sorted by createdAt', () => {
        const params = {
            p1: { id: 'p1', name: 'second', value: 2, unit: 'mm', equation: null, createdAt: 200 },
            p0: { id: 'p0', name: 'first',  value: 1, unit: 'mm', equation: null, createdAt: 100 },
        };
        const { host } = setupPanel(params);
        const rows = host.querySelectorAll('.pf4-param-row');
        assert.equal(rows.length, 2);
        // dataset.paramId reflects sort order — first row is p0
        assert.equal(rows[0].dataset.paramId, 'p0');
        assert.equal(rows[1].dataset.paramId, 'p1');
    });

    test('re-renders automatically after a store change', () => {
        const { host, ops } = setupPanel();
        let rows = host.querySelectorAll('.pf4-param-row');
        assert.equal(rows.length, 0);
        ops.add('w', 10, 'mm', null);
        rows = host.querySelectorAll('.pf4-param-row');
        assert.equal(rows.length, 1);
    });
});

// ── Add ────────────────────────────────────────────────────────────────────
suite('ParametersPanel › add', () => {
    test('clicking +Add appends a parameter with a unique default name', () => {
        const { host, store } = setupPanel();
        const dfs = (n, pred) => pred(n) ? n : (n.children || []).reduce((r, c) => r || dfs(c, pred), null);
        const addBtn = dfs(host, (n) => (n.className || '').includes('pf4-param-add'));
        assert.ok(addBtn, 'add button missing');
        addBtn.click();
        addBtn.click();
        const params = Object.values(store.doc.parameters);
        assert.equal(params.length, 2);
        // Names must be unique
        const names = new Set(params.map(p => p.name));
        assert.equal(names.size, 2);
        // First default is "param", second falls through to "param2"
        assert.ok(names.has('param'));
        assert.ok(names.has('param2'));
    });
});

// ── Edit ───────────────────────────────────────────────────────────────────
suite('ParametersPanel › edit', () => {
    function rowFor(host, paramId) {
        return host.querySelectorAll('.pf4-param-row').find(r => r.dataset.paramId === paramId);
    }
    function inputIn(row, className) {
        for (const c of row.children) {
            if ((c.className || '').includes(className)) return c;
        }
        return null;
    }

    test('renaming a parameter commits a name patch', () => {
        const params = { p1: { id: 'p1', name: 'w', value: 10, unit: 'mm', equation: null, createdAt: 1 } };
        const { host, store } = setupPanel(params);
        const row = rowFor(host, 'p1');
        const nameIn = inputIn(row, 'pf4-param-name');
        nameIn.value = 'wall';
        nameIn.change();
        assert.equal(store.doc.parameters.p1.name, 'wall');
    });

    test('empty name is rejected; render reverts to the old value', () => {
        const params = { p1: { id: 'p1', name: 'w', value: 10, unit: 'mm', equation: null, createdAt: 1 } };
        const { host, store } = setupPanel(params);
        const row = rowFor(host, 'p1');
        const nameIn = inputIn(row, 'pf4-param-name');
        nameIn.value = '';
        nameIn.change();
        assert.equal(store.doc.parameters.p1.name, 'w');   // unchanged
    });

    test('rename to an existing name is rejected', () => {
        const params = {
            p1: { id: 'p1', name: 'w', value: 10, unit: 'mm', equation: null, createdAt: 1 },
            p2: { id: 'p2', name: 'h', value: 20, unit: 'mm', equation: null, createdAt: 2 },
        };
        const { host, store } = setupPanel(params);
        const row = rowFor(host, 'p2');
        const nameIn = inputIn(row, 'pf4-param-name');
        nameIn.value = 'w';
        nameIn.change();
        assert.equal(store.doc.parameters.p2.name, 'h');   // unchanged
    });

    test('numeric value commit updates `value` and clears any equation', () => {
        const params = { p1: { id: 'p1', name: 'w', value: 10, unit: 'mm', equation: '=foo*2', createdAt: 1 } };
        const { host, store } = setupPanel(params);
        const row = rowFor(host, 'p1');
        const valIn = inputIn(row, 'pf4-param-val');
        valIn.value = '42';
        valIn.change();
        assert.equal(store.doc.parameters.p1.value, 42);
        assert.equal(store.doc.parameters.p1.equation, null);
    });

    test('expression commit (starts with =) populates `equation`', () => {
        const params = { p1: { id: 'p1', name: 'w', value: 10, unit: 'mm', equation: null, createdAt: 1 } };
        const { host, store } = setupPanel(params);
        const row = rowFor(host, 'p1');
        const valIn = inputIn(row, 'pf4-param-val');
        valIn.value = '=wall * 2';
        valIn.change();
        assert.equal(store.doc.parameters.p1.equation, '=wall * 2');
    });

    test('non-numeric / non-expression value is rejected', () => {
        const params = { p1: { id: 'p1', name: 'w', value: 10, unit: 'mm', equation: null, createdAt: 1 } };
        const { host, store } = setupPanel(params);
        const row = rowFor(host, 'p1');
        const valIn = inputIn(row, 'pf4-param-val');
        valIn.value = 'abc';
        valIn.change();
        assert.equal(store.doc.parameters.p1.value, 10);   // unchanged
        assert.equal(store.doc.parameters.p1.equation, null);
    });

    test('unit edit commits as a string patch', () => {
        const params = { p1: { id: 'p1', name: 'w', value: 10, unit: 'mm', equation: null, createdAt: 1 } };
        const { host, store } = setupPanel(params);
        const row = rowFor(host, 'p1');
        const unitIn = inputIn(row, 'pf4-param-unit');
        unitIn.value = 'in';
        unitIn.change();
        assert.equal(store.doc.parameters.p1.unit, 'in');
    });
});

// ── Delete ─────────────────────────────────────────────────────────────────
suite('ParametersPanel › delete', () => {
    test('clicking × removes the parameter and re-renders', () => {
        const params = { p1: { id: 'p1', name: 'w', value: 10, unit: 'mm', equation: null, createdAt: 1 } };
        const { host, store } = setupPanel(params);
        const row = host.querySelectorAll('.pf4-param-row').find(r => r.dataset.paramId === 'p1');
        const del = row.children.find(c => (c.className || '').includes('pf4-param-del'));
        del.click();
        assert.equal(Object.keys(store.doc.parameters).length, 0);
        // Row is gone; empty-state element is back.
        const rows = host.querySelectorAll('.pf4-param-row');
        assert.equal(rows.length, 0);
    });
});

// ── Cleanup ────────────────────────────────────────────────────────────────
suite('ParametersPanel › cleanup', () => {
    test('destroy unsubscribes from the store and clears the host', () => {
        const params = { p1: { id: 'p1', name: 'w', value: 10, unit: 'mm', equation: null, createdAt: 1 } };
        const { host, store, panel } = setupPanel(params);
        assert.ok(host.children.length > 0);
        panel.destroy();
        // Store no-op after destroy — adding a param must NOT re-populate host
        store.doc.parameters.p2 = { id: 'p2', name: 'h', value: 5, unit: 'mm', equation: null, createdAt: 2 };
        store._notify();
        const rows = host.querySelectorAll('.pf4-param-row');
        assert.equal(rows.length, 0);
    });
});

await runAll();
