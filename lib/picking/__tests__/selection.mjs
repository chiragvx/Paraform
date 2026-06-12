/**
 * Tests for lib/picking/selection.js — pure-data subscribable selection.
 *
 * Run via:  node lib/picking/__tests__/selection.mjs
 */

import assert from 'node:assert/strict';
import { PickingSelection, getPickingSelection, resetPickingSelection } from '../selection.js';

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

// Helper to fabricate descriptors matching the kernel output shape.
function desc(part, feature = 'feat_a', kind = 'face', opTag = 'box', parents = []) {
    return { kind, feature, opTag, part, parents };
}

// ── add / remove / has ─────────────────────────────────────────────────────
suite('PickingSelection', () => {
    test('starts empty', () => {
        const s = new PickingSelection();
        assert.equal(s.size, 0);
        assert.equal(s.toArray().length, 0);
        assert.equal(s.has(desc('+X')), false);
    });

    test('add stores the descriptor and reports it via has/toArray', () => {
        const s = new PickingSelection();
        const d = desc('+Z');
        const key = s.add(d, { center: [0, 0, 10] });
        assert.ok(key);
        assert.equal(s.size, 1);
        assert.equal(s.has(d), true);
        const arr = s.toArray();
        assert.equal(arr.length, 1);
        assert.equal(arr[0].descriptor, d);
        assert.deepEqual(arr[0].payload, { center: [0, 0, 10] });
    });

    test('adding the same descriptor twice does not duplicate entries', () => {
        const s = new PickingSelection();
        const d = desc('+Z');
        s.add(d);
        s.add(d);
        assert.equal(s.size, 1);
    });

    test('adding the same key replaces the payload', () => {
        const s = new PickingSelection();
        const d = desc('+Z');
        s.add(d, { v: 1 });
        s.add(d, { v: 2 });
        assert.deepEqual(s.toArray()[0].payload, { v: 2 });
    });

    test('two distinct descriptors yield two entries', () => {
        const s = new PickingSelection();
        s.add(desc('+X'));
        s.add(desc('-Z'));
        assert.equal(s.size, 2);
        assert.equal(s.has(desc('+X')), true);
        assert.equal(s.has(desc('-Z')), true);
    });

    test('remove by descriptor returns true on hit, false on miss', () => {
        const s = new PickingSelection();
        s.add(desc('+X'));
        assert.equal(s.remove(desc('+X')), true);
        assert.equal(s.remove(desc('+X')), false);
        assert.equal(s.size, 0);
    });

    test('remove also accepts the raw canonical key', () => {
        const s = new PickingSelection();
        const d = desc('+X');
        const key = s.add(d);
        assert.equal(s.remove(key), true);
        assert.equal(s.size, 0);
    });

    test('toggle adds when missing, removes when present', () => {
        const s = new PickingSelection();
        const d = desc('+Y');
        assert.equal(s.toggle(d), true);
        assert.equal(s.has(d), true);
        assert.equal(s.toggle(d), false);
        assert.equal(s.has(d), false);
    });

    test('clear drops every entry', () => {
        const s = new PickingSelection();
        s.add(desc('+X'));
        s.add(desc('+Y'));
        s.add(desc('+Z'));
        assert.equal(s.size, 3);
        s.clear();
        assert.equal(s.size, 0);
    });

    test('descriptors() returns just the descriptor objects', () => {
        const s = new PickingSelection();
        const a = desc('+X');
        const b = desc('+Y');
        s.add(a);
        s.add(b);
        assert.deepEqual(s.descriptors(), [a, b]);
    });
});

// ── subscribe ──────────────────────────────────────────────────────────────
suite('PickingSelection › subscribe', () => {
    test('subscribers receive an add event with descriptor + key + payload', () => {
        const s = new PickingSelection();
        const events = [];
        s.subscribe((e) => events.push(e));
        const d = desc('+Z');
        s.add(d, { c: [0, 0, 10] });
        assert.equal(events.length, 1);
        assert.equal(events[0].kind, 'add');
        assert.equal(events[0].descriptor, d);
        assert.deepEqual(events[0].payload, { c: [0, 0, 10] });
    });

    test('subscribers do NOT see repeated adds of the same descriptor', () => {
        const s = new PickingSelection();
        const events = [];
        s.subscribe((e) => events.push(e));
        const d = desc('+Z');
        s.add(d);
        s.add(d);
        s.add(d);
        assert.equal(events.filter(e => e.kind === 'add').length, 1);
    });

    test('subscribers receive a remove event with the descriptor that left', () => {
        const s = new PickingSelection();
        s.add(desc('+X'));
        const events = [];
        s.subscribe((e) => events.push(e));
        s.remove(desc('+X'));
        assert.equal(events.length, 1);
        assert.equal(events[0].kind, 'remove');
    });

    test('clear fires a single `clear` event regardless of size', () => {
        const s = new PickingSelection();
        s.add(desc('+X')); s.add(desc('+Y')); s.add(desc('+Z'));
        const events = [];
        s.subscribe((e) => events.push(e));
        s.clear();
        assert.equal(events.length, 1);
        assert.equal(events[0].kind, 'clear');
    });

    test('clear on an empty selection emits nothing', () => {
        const s = new PickingSelection();
        const events = [];
        s.subscribe((e) => events.push(e));
        s.clear();
        assert.equal(events.length, 0);
    });

    test('unsubscribe stops further events', () => {
        const s = new PickingSelection();
        const events = [];
        const unsub = s.subscribe((e) => events.push(e));
        s.add(desc('+X'));
        unsub();
        s.add(desc('+Y'));
        assert.equal(events.length, 1);
    });

    test('one throwing subscriber does not break the others', () => {
        const s = new PickingSelection();
        const bad = []; const good = [];
        s.subscribe(() => { bad.push(1); throw new Error('boom'); });
        s.subscribe((e) => good.push(e));
        // Suppress console.error noise during the test
        const origErr = console.error; console.error = () => {};
        try { s.add(desc('+X')); }
        finally { console.error = origErr; }
        assert.equal(bad.length, 1);
        assert.equal(good.length, 1);
    });
});

// ── singleton ──────────────────────────────────────────────────────────────
suite('getPickingSelection singleton', () => {
    test('returns the same instance across calls', () => {
        resetPickingSelection();
        const a = getPickingSelection();
        const b = getPickingSelection();
        assert.equal(a, b);
    });

    test('resetPickingSelection wipes the singleton', () => {
        resetPickingSelection();
        const a = getPickingSelection();
        a.add(desc('+Z'));
        assert.equal(a.size, 1);
        resetPickingSelection();
        const b = getPickingSelection();
        assert.notEqual(a, b);
        assert.equal(b.size, 0);
    });
});

await runAll();
