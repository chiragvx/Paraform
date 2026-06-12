/**
 * Tests for app/v4_panel/feature_menu.js — the popup that replaces the
 * `+ Box`/`+ Cyl` header buttons with a discoverable list of every v4
 * operation.
 *
 * Run via:  node app/__tests__/v4_feature_menu.mjs
 */

import assert from 'node:assert/strict';
import { FEATURE_MENU_GROUPS, FeatureMenu } from '../v4_panel/feature_menu.js';

// ── Tiny DOM shim — just enough for the menu to render & dispatch ──────────
function makeFakeDoc() {
    const listeners = { mousedown: [] };
    const dom = {};
    const makeEl = (tag) => {
        const el = {
            tagName: tag.toUpperCase(),
            children: [],
            childNodes: [],
            attrs: {},
            dataset: {},
            classList: { _set: new Set(), add(c) { this._set.add(c); }, remove(c) { this._set.delete(c); }, contains(c) { return this._set.has(c); } },
            style: {},
            disabled: false,
            ownerDocument: dom,
            parentNode: null,
            _listeners: {},
            innerHTML: '',
            get className() { return [...this.classList._set].join(' '); },
            set className(v) { this.classList._set = new Set(String(v || '').split(/\s+/).filter(Boolean)); },
            setAttribute(k, v) { this.attrs[k] = v; },
            appendChild(child) {
                child.parentNode = this;
                this.children.push(child);
                this.childNodes.push(child);
                return child;
            },
            removeChild(child) {
                const i = this.children.indexOf(child);
                if (i >= 0) { this.children.splice(i, 1); this.childNodes.splice(i, 1); }
                child.parentNode = null;
                return child;
            },
            contains(node) {
                if (node === this) return true;
                for (const c of this.children) if (c.contains && c.contains(node)) return true;
                return false;
            },
            closest() { return null; },   // good-enough no-op for our tests
            addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); },
            removeEventListener(type, fn) {
                const a = this._listeners[type] || [];
                const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1);
            },
            click() {
                for (const fn of (this._listeners.click || [])) fn({ target: this });
            },
            querySelectorAll(/* selector */) {
                // Minimal selector: "button.pf4-fm-item"
                const all = [];
                const walk = (n) => {
                    if (n.tagName === 'BUTTON' && (n.className || '').includes('pf4-fm-item')) all.push(n);
                    for (const c of n.children || []) walk(c);
                };
                walk(this);
                return all;
            },
            getBoundingClientRect() { return { left: 100, top: 50, bottom: 70, right: 160, width: 60, height: 20 }; },
        };
        return el;
    };
    dom.createElement = (tag) => makeEl(tag);
    dom.body = makeEl('body');
    dom.addEventListener = (type, fn) => { (listeners[type] ||= []).push(fn); };
    dom.removeEventListener = (type, fn) => {
        const arr = listeners[type] || [];
        const i = arr.indexOf(fn);
        if (i >= 0) arr.splice(i, 1);
    };
    dom._listeners = listeners;
    return dom;
}

function makeFakeV4Doc(features = {}) {
    return {
        id: 'doc_test',
        features,
        parameters: {},
        bodies: {},
        head: -1,
    };
}
function bodyFeat(id, type = 'Box') { return { id, type, enabled: true, params: {}, inputs: {} }; }
function sketchFeat(id) { return { id, type: 'Sketch', enabled: true, params: { sketch: {} }, inputs: {} }; }

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

// ── Group metadata ─────────────────────────────────────────────────────────
suite('FEATURE_MENU_GROUPS', () => {
    test('declares Primitive / Sketch / Sketch-based / Modify / Boolean / Pattern / Transform groups', () => {
        const headings = FEATURE_MENU_GROUPS.map(g => g.heading);
        for (const h of ['Primitive','Sketch','Sketch-based','Modify','Boolean','Pattern','Transform']) {
            assert.ok(headings.includes(h), `missing group "${h}"`);
        }
    });

    test('every Primitive item creates a body without prerequisites', () => {
        const prim = FEATURE_MENU_GROUPS.find(g => g.heading === 'Primitive');
        for (const item of prim.items) {
            assert.ok(item.action, `primitive missing action: ${JSON.stringify(item)}`);
            assert.ok(!item.needs, `primitive ${item.label} should not declare a precondition`);
        }
    });

    test('Modify items require a body', () => {
        const mod = FEATURE_MENU_GROUPS.find(g => g.heading === 'Modify');
        for (const item of mod.items) {
            assert.equal(item.needs, 'body', `modify ${item.label} should need body`);
        }
    });

    test('Boolean items require 2 bodies', () => {
        const b = FEATURE_MENU_GROUPS.find(g => g.heading === 'Boolean');
        for (const item of b.items) {
            assert.equal(item.needs, '2bodies', `boolean ${item.label} should need 2 bodies`);
        }
    });

    test('Sketch-based items require a sketch', () => {
        const s = FEATURE_MENU_GROUPS.find(g => g.heading === 'Sketch-based');
        for (const item of s.items) {
            assert.equal(item.needs, 'sketch', `${item.label} should need sketch`);
        }
    });

    test('every item declares a non-empty action id', () => {
        for (const g of FEATURE_MENU_GROUPS) {
            for (const item of g.items) {
                assert.ok(typeof item.action === 'string' && item.action.length, `bad action: ${JSON.stringify(item)}`);
            }
        }
    });

    test('action ids are globally unique', () => {
        const seen = new Set();
        for (const g of FEATURE_MENU_GROUPS) {
            for (const item of g.items) {
                assert.ok(!seen.has(item.action), `duplicate action: ${item.action}`);
                seen.add(item.action);
            }
        }
    });
});

// ── Rendering + state ──────────────────────────────────────────────────────
suite('FeatureMenu › rendering', () => {
    test('renders every group and item the first time it opens', () => {
        const dom = makeFakeDoc();
        const root = dom.createElement('div');
        dom.body.appendChild(root);
        const fm = new FeatureMenu(root, {
            onAction: () => {},
            getDoc: () => makeFakeV4Doc(),
        });
        fm.toggle(root);
        const buttons = fm.el.querySelectorAll('button.pf4-fm-item');
        // Sum of items across every group
        const expected = FEATURE_MENU_GROUPS.reduce((n, g) => n + g.items.length, 0);
        assert.equal(buttons.length, expected);
    });

    test('Modify items are disabled when the doc has no bodies', () => {
        const dom = makeFakeDoc();
        const root = dom.createElement('div');
        dom.body.appendChild(root);
        const fm = new FeatureMenu(root, {
            onAction: () => {},
            getDoc: () => makeFakeV4Doc(),     // empty doc → no bodies
        });
        fm.toggle(root);
        const fillet = fm.el.querySelectorAll('button.pf4-fm-item').find(b => b.dataset.action === 'add-fillet');
        assert.ok(fillet);
        assert.equal(fillet.disabled, true);
    });

    test('Modify items enable once a body exists in the doc', () => {
        const dom = makeFakeDoc();
        const root = dom.createElement('div');
        dom.body.appendChild(root);
        const fm = new FeatureMenu(root, {
            onAction: () => {},
            getDoc: () => makeFakeV4Doc({ f1: bodyFeat('f1', 'Box') }),
        });
        fm.toggle(root);
        const fillet = fm.el.querySelectorAll('button.pf4-fm-item').find(b => b.dataset.action === 'add-fillet');
        assert.equal(fillet.disabled, false);
    });

    test('Boolean items are disabled with only 1 body', () => {
        const dom = makeFakeDoc();
        const root = dom.createElement('div');
        dom.body.appendChild(root);
        const fm = new FeatureMenu(root, {
            onAction: () => {},
            getDoc: () => makeFakeV4Doc({ f1: bodyFeat('f1', 'Box') }),
        });
        fm.toggle(root);
        const cut = fm.el.querySelectorAll('button.pf4-fm-item').find(b => b.dataset.action === 'add-cut');
        assert.equal(cut.disabled, true);
    });

    test('Boolean items enable with 2 bodies', () => {
        const dom = makeFakeDoc();
        const root = dom.createElement('div');
        dom.body.appendChild(root);
        const fm = new FeatureMenu(root, {
            onAction: () => {},
            getDoc: () => makeFakeV4Doc({
                f1: bodyFeat('f1', 'Box'),
                f2: bodyFeat('f2', 'Cylinder'),
            }),
        });
        fm.toggle(root);
        const cut = fm.el.querySelectorAll('button.pf4-fm-item').find(b => b.dataset.action === 'add-cut');
        assert.equal(cut.disabled, false);
    });

    test('Sketch-based items disabled when there is no sketch', () => {
        const dom = makeFakeDoc();
        const root = dom.createElement('div');
        dom.body.appendChild(root);
        const fm = new FeatureMenu(root, {
            onAction: () => {},
            getDoc: () => makeFakeV4Doc({ f1: bodyFeat('f1') }),  // body but no sketch
        });
        fm.toggle(root);
        const extr = fm.el.querySelectorAll('button.pf4-fm-item').find(b => b.dataset.action === 'add-extrude');
        assert.equal(extr.disabled, true);
    });

    test('Sketch-based items enable when a sketch exists', () => {
        const dom = makeFakeDoc();
        const root = dom.createElement('div');
        dom.body.appendChild(root);
        const fm = new FeatureMenu(root, {
            onAction: () => {},
            getDoc: () => makeFakeV4Doc({ sk1: sketchFeat('sk1') }),
        });
        fm.toggle(root);
        const extr = fm.el.querySelectorAll('button.pf4-fm-item').find(b => b.dataset.action === 'add-extrude');
        assert.equal(extr.disabled, false);
    });

    test('disabled features in the doc do not count toward prerequisites', () => {
        const dom = makeFakeDoc();
        const root = dom.createElement('div');
        dom.body.appendChild(root);
        const fm = new FeatureMenu(root, {
            onAction: () => {},
            getDoc: () => makeFakeV4Doc({
                f1: { ...bodyFeat('f1'), enabled: false },   // suppressed → ignored
                f2: bodyFeat('f2', 'Cylinder'),
            }),
        });
        fm.toggle(root);
        const cut = fm.el.querySelectorAll('button.pf4-fm-item').find(b => b.dataset.action === 'add-cut');
        // Only 1 enabled body → cut still disabled
        assert.equal(cut.disabled, true);
    });
});

// ── Dispatch ───────────────────────────────────────────────────────────────
suite('FeatureMenu › dispatch', () => {
    test('clicking an enabled item fires onAction with the action id and closes the menu', () => {
        const dom = makeFakeDoc();
        const root = dom.createElement('div');
        dom.body.appendChild(root);
        let fired = null;
        const fm = new FeatureMenu(root, {
            onAction: (a) => { fired = a; },
            getDoc: () => makeFakeV4Doc(),
        });
        fm.toggle(root);
        const box = fm.el.querySelectorAll('button.pf4-fm-item').find(b => b.dataset.action === 'add-box');
        box.click();
        assert.equal(fired, 'add-box');
        assert.equal(fm.open, false);
    });

    test('clicking a disabled item is a no-op (no action, menu stays open)', () => {
        const dom = makeFakeDoc();
        const root = dom.createElement('div');
        dom.body.appendChild(root);
        let fired = null;
        const fm = new FeatureMenu(root, {
            onAction: (a) => { fired = a; },
            getDoc: () => makeFakeV4Doc(),    // no bodies → Modify disabled
        });
        fm.toggle(root);
        const fillet = fm.el.querySelectorAll('button.pf4-fm-item').find(b => b.dataset.action === 'add-fillet');
        fillet.click();
        assert.equal(fired, null);
        assert.equal(fm.open, true);
    });

    test('toggle opens then closes the menu', () => {
        const dom = makeFakeDoc();
        const root = dom.createElement('div');
        dom.body.appendChild(root);
        const fm = new FeatureMenu(root, {
            onAction: () => {},
            getDoc: () => makeFakeV4Doc(),
        });
        fm.toggle(root);
        assert.equal(fm.open, true);
        assert.ok(fm.el);
        fm.toggle(root);
        assert.equal(fm.open, false);
        assert.equal(fm.el, null);
    });

    test('destroy removes the global listener and any open menu element', () => {
        const dom = makeFakeDoc();
        const root = dom.createElement('div');
        dom.body.appendChild(root);
        const fm = new FeatureMenu(root, {
            onAction: () => {},
            getDoc: () => makeFakeV4Doc(),
        });
        fm.toggle(root);
        const before = dom._listeners.mousedown.length;
        fm.destroy();
        assert.equal(fm.el, null);
        assert.equal(dom._listeners.mousedown.length, before - 1);
    });
});

await runAll();
