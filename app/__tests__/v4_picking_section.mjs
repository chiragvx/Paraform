/**
 * Tests for app/v4_panel/picking_section.js — the Selection section that
 * mirrors the PickingSelection store into a panel widget.
 *
 * Uses the same lightweight DOM shim as the other v4 panel tests.
 *
 * Run via:  node app/__tests__/v4_picking_section.mjs
 */

import assert from 'node:assert/strict';
import { PickingSection, formatDescriptor } from '../v4_panel/picking_section.js';
import { PickingSelection } from '../../lib/picking/selection.js';

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

// ── DOM shim — mirrors the one in v4_parameters.mjs / v4_feature_menu.mjs ──
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
        title: '', textContent: '',
        _innerHTML: '',
        get innerHTML() { return this._innerHTML; },
        set innerHTML(v) {
            this._innerHTML = String(v == null ? '' : v);
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
        querySelectorAll(/* selector */) {
            const out = [];
            const walk = (n) => {
                if ((n.className || '').includes('pf4-pick-row')) out.push(n);
                for (const c of n.children || []) walk(c);
            };
            walk(this);
            return out;
        },
    });
    dom.createElement = (tag) => makeEl(tag);
    dom.body = makeEl('body');
    return dom;
}

function desc(part, feature = 'box_1', kind = 'face') {
    return { kind, feature, opTag: 'box', part, parents: [] };
}

function dfs(node, pred) {
    if (pred(node)) return node;
    for (const c of node.children || []) {
        const r = dfs(c, pred);
        if (r) return r;
    }
    return null;
}

// ── formatDescriptor ───────────────────────────────────────────────────────
suite('formatDescriptor', () => {
    test('builds a compact "kind · feat : part" string', () => {
        assert.equal(formatDescriptor(desc('+Z', 'short')), 'face · short : +Z');
    });

    test('shortens long feature ids with ellipsis', () => {
        const long = 'box_abcdefghij1234567890';
        const s = formatDescriptor(desc('+Z', long));
        assert.ok(s.includes('box_'), `expected start: ${s}`);
        assert.ok(s.includes('7890'), `expected end: ${s}`);
        assert.ok(s.length < long.length + 20, 'string should not include full id');
    });

    test('null descriptor renders as `?`', () => {
        assert.equal(formatDescriptor(null), '?');
    });
});

// ── rendering ──────────────────────────────────────────────────────────────
suite('PickingSection › rendering', () => {
    function setup() {
        const dom  = makeFakeDoc();
        const host = dom.createElement('div');
        dom.body.appendChild(host);
        const sel  = new PickingSelection();
        const sect = new PickingSection(host, sel);
        return { dom, host, sel, sect };
    }

    test('empty state shows zero count + an instructional message', () => {
        const { host, sel } = setup();
        assert.equal(sel.size, 0);
        const title = dfs(host, n => (n.className || '').includes('pf4-pick-title'));
        assert.ok(title);
        assert.match(title.textContent, /Selection · 0/);
        const empty = dfs(host, n => (n.className || '').includes('pf4-pick-empty'));
        assert.ok(empty, 'should show the instructional empty-state message');
    });

    test('add → row appears + count increments + Clear button shows up', () => {
        const { host, sel } = setup();
        sel.add(desc('+Z'), { center: [0, 0, 10], normal: [0, 0, 1] });
        const rows = host.querySelectorAll('.pf4-pick-row');
        assert.equal(rows.length, 1);
        const title = dfs(host, n => (n.className || '').includes('pf4-pick-title'));
        assert.match(title.textContent, /Selection · 1/);
        const clearBtn = dfs(host, n => (n.className || '').includes('pf4-pick-clear'));
        assert.ok(clearBtn, 'Clear button should appear once selection is non-empty');
    });

    test('clear button drops every row', () => {
        const { host, sel } = setup();
        sel.add(desc('+X'), { center: [10, 0, 0], normal: [1, 0, 0] });
        sel.add(desc('+Y'), { center: [0, 10, 0], normal: [0, 1, 0] });
        assert.equal(host.querySelectorAll('.pf4-pick-row').length, 2);
        const clearBtn = dfs(host, n => (n.className || '').includes('pf4-pick-clear'));
        clearBtn.click();
        assert.equal(host.querySelectorAll('.pf4-pick-row').length, 0);
        assert.equal(sel.size, 0);
    });

    test('row × button removes a single entry', () => {
        const { host, sel } = setup();
        sel.add(desc('+X'), { center: [10, 0, 0], normal: [1, 0, 0] });
        sel.add(desc('+Y'), { center: [0, 10, 0], normal: [0, 1, 0] });
        // Find the row whose dataset.key matches +X and click its × button.
        const rows = host.querySelectorAll('.pf4-pick-row');
        const xRow = rows.find(r => r.dataset.key.includes('+X'));
        const del = xRow.children.find(c => (c.className || '').includes('pf4-pick-del'));
        del.click();
        assert.equal(sel.size, 1);
        const after = host.querySelectorAll('.pf4-pick-row');
        assert.equal(after.length, 1);
        assert.ok(after[0].dataset.key.includes('+Y'));
    });

    test('destroy unsubscribes and clears the host', () => {
        const { host, sel, sect } = setup();
        sel.add(desc('+Z'), { center: [0, 0, 10] });
        assert.equal(host.querySelectorAll('.pf4-pick-row').length, 1);
        sect.destroy();
        sel.add(desc('+Y'), { center: [0, 10, 0] });
        // After destroy, the section must not have re-rendered.
        assert.equal(host.querySelectorAll('.pf4-pick-row').length, 0);
    });
});

await runAll();
