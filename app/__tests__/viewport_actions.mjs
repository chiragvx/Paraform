/**
 * Tests for the action layer:
 *   - lib/viewport/actions.js          — ActionRegistry, scoreAction, fuzzyMatch
 *   - lib/viewport/default_actions.js  — defaults shape + marking-menu picker
 *   - app/viewport/marking_menu.js     — sectorFor() math
 *
 * Run via:  node app/__tests__/viewport_actions.mjs
 */

import assert from 'node:assert/strict';
import {
    ActionRegistry, scoreAction, fuzzyMatch,
} from '../../lib/viewport/actions.js';
import {
    buildDefaultActions, defaultMarkingMenu,
} from '../../lib/viewport/default_actions.js';
import { sectorFor } from '../viewport/marking_menu.js';

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
    console.log(`\n  ${pass} passed, ${fail} failed`);
    if (fail > 0) process.exit(1);
}

function memStorage() {
    const data = {};
    return {
        data,
        getItem:    (k) => (k in data ? data[k] : null),
        setItem:    (k, v) => { data[k] = String(v); },
        removeItem: (k) => { delete data[k]; },
    };
}

// ── ActionRegistry ───────────────────────────────────────────────────────────
suite('ActionRegistry', () => {
    test('register + get', () => {
        const r = new ActionRegistry({ storage: memStorage() });
        r.register({ id: 'a.x', label: 'X', run: () => {} });
        assert.equal(r.get('a.x').label, 'X');
        assert.equal(r.all().length, 1);
    });

    test('register rejects missing id / run / label', () => {
        const r = new ActionRegistry({ storage: memStorage() });
        assert.throws(() => r.register({ label: 'no id', run: () => {} }), /missing id/);
        assert.throws(() => r.register({ id: 'a',  label: 'no run' }),     /missing run/);
        assert.throws(() => r.register({ id: 'a',  run: () => {} }),       /missing label/);
    });

    test('isEnabled / isVisible default to true when omitted', () => {
        const r = new ActionRegistry({ storage: memStorage() });
        r.register({ id: 'a', label: 'A', run: () => {} });
        const a = r.get('a');
        assert.equal(a.isEnabled({}), true);
        assert.equal(a.isVisible({}), true);
    });

    test('filter respects isVisible', () => {
        const r = new ActionRegistry({ storage: memStorage() });
        r.register({ id: 'sketch.only', label: 'Sketch Only', run: () => {},
                     isVisible: (c) => c.sketchActive });
        r.register({ id: 'view.always', label: 'View Always', run: () => {} });
        assert.deepEqual(r.filter({ sketchActive: false }).map(a => a.id), ['view.always']);
        assert.deepEqual(
            r.filter({ sketchActive: true }).map(a => a.id).sort(),
            ['sketch.only', 'view.always'],
        );
    });

    test('run records recents on success', () => {
        const r = new ActionRegistry({ storage: memStorage() });
        let called = 0;
        r.register({ id: 'a', label: 'A', run: () => { called++; } });
        r.register({ id: 'b', label: 'B', run: () => { called++; } });
        r.run('a', {});
        r.run('b', {});
        r.run('a', {});
        assert.equal(called, 3);
        assert.deepEqual(r.recents(2).map(a => a.id), ['a', 'b']);
    });

    test('run returns false for unknown / disabled actions and does NOT record recent', () => {
        const r = new ActionRegistry({ storage: memStorage() });
        r.register({ id: 'a', label: 'A', run: () => {}, isEnabled: () => false });
        assert.equal(r.run('a', {}), false);
        assert.equal(r.run('does-not-exist', {}), false);
        assert.deepEqual(r.recents(), []);
    });

    test('reasonDisabled returns null for an enabled action', () => {
        const r = new ActionRegistry({ storage: memStorage() });
        r.register({ id: 'a', label: 'A', run: () => {} });
        assert.equal(r.reasonDisabled('a', {}), null);
    });

    test('reasonDisabled returns the action\'s reason when isEnabled is false', () => {
        const r = new ActionRegistry({ storage: memStorage() });
        r.register({
            id: 'fillet', label: 'Fillet', run: () => {},
            isEnabled: () => false,
            disabledReason: () => 'Select an edge first.',
        });
        assert.equal(r.reasonDisabled('fillet', {}), 'Select an edge first.');
    });

    test('reasonDisabled falls back to a generic message when no disabledReason is provided', () => {
        const r = new ActionRegistry({ storage: memStorage() });
        r.register({
            id: 'foo', label: 'Foo', run: () => {},
            isEnabled: () => false,
        });
        assert.match(r.reasonDisabled('foo', {}), /Foo.*available/i);
    });

    test('reasonDisabled returns null for an unknown action (caller toasts generic)', () => {
        const r = new ActionRegistry({ storage: memStorage() });
        assert.equal(r.reasonDisabled('does-not-exist', {}), null);
    });

    test('togglePin persists and surfaces in pins()', () => {
        const storage = memStorage();
        const r = new ActionRegistry({ storage });
        r.register({ id: 'p.a', label: 'A', run: () => {} });
        r.register({ id: 'p.b', label: 'B', run: () => {} });
        r.togglePin('p.b');
        assert.equal(r.isPinned('p.b'), true);
        assert.deepEqual(r.pins().map(a => a.id), ['p.b']);
        // Rehydrate from storage
        const r2 = new ActionRegistry({ storage });
        r2.register({ id: 'p.b', label: 'B', run: () => {} });
        assert.equal(r2.isPinned('p.b'), true);
    });
});

// ── scoreAction ──────────────────────────────────────────────────────────────
suite('scoreAction', () => {
    const make = (label, extra = {}) => ({ id: label.toLowerCase().replace(/\s/g, '.'), label, category: 'General', ...extra });

    test('empty query yields a positive baseline so original order survives', () => {
        const a = make('Fillet');
        assert.ok(scoreAction('', a) > 0);
        assert.ok(scoreAction('  ', a) > 0);
    });

    test('exact label match beats prefix match', () => {
        const exact = scoreAction('fillet', make('Fillet'));
        const prefix = scoreAction('fill',   make('Fillet'));
        assert.ok(exact > prefix);
    });

    test('word-prefix beats substring', () => {
        const wordHit  = scoreAction('cyl', make('Add Cylinder'));
        const subHit   = scoreAction('cyl', make('Recycle'));
        assert.ok(wordHit > subHit);
    });

    test('keyword hit floats a generic-named action above unrelated ones', () => {
        const kwHit = scoreAction('round', make('Fillet', { keywords: ['round'] }));
        const miss  = scoreAction('round', make('Pad'));
        assert.ok(kwHit > 0);
        assert.equal(miss, 0);
    });

    test('subsequence matches when chars appear in order', () => {
        // 'flt' is a subsequence of 'Fillet'.
        const s = scoreAction('flt', make('Fillet'));
        assert.ok(s > 0);
    });

    test('no match returns 0', () => {
        assert.equal(scoreAction('xyz', make('Fillet')), 0);
    });
});

// ── fuzzyMatch ───────────────────────────────────────────────────────────────
suite('fuzzyMatch', () => {
    const actions = [
        { id: 'add.box',      label: 'Box',      category: 'Primitive' },
        { id: 'add.cylinder', label: 'Cylinder', category: 'Primitive' },
        { id: 'feat.fillet',  label: 'Fillet',   category: 'Feature'   },
        { id: 'view.front',   label: 'Front View', category: 'View'    },
    ];

    test('orders best matches first', () => {
        const ranked = fuzzyMatch('fil', actions);
        assert.equal(ranked[0].id, 'feat.fillet');
    });

    test('pins boost ranking', () => {
        const ranked = fuzzyMatch('', actions, { pins: new Set(['view.front']) });
        assert.equal(ranked[0].id, 'view.front');
    });

    test('recents boost ranking', () => {
        const ranked = fuzzyMatch('', actions, { recents: ['add.cylinder'] });
        assert.equal(ranked[0].id, 'add.cylinder');
    });

    test('zero-score actions drop out of results', () => {
        const ranked = fuzzyMatch('zzz', actions);
        assert.deepEqual(ranked, []);
    });
});

// ── Default actions ──────────────────────────────────────────────────────────
suite('default actions', () => {
    const defaults = buildDefaultActions();

    test('catalogue defines stable Phase-1 ids', () => {
        const ids = defaults.map(a => a.id);
        ['view.front', 'view.top', 'view.iso', 'view.fit', 'view.home',
         'sel.clear', 'sel.hide',
         'sketch.xy', 'sketch.xz', 'sketch.yz',
         'add.box', 'add.cylinder', 'add.sphere', 'add.torus',
         'feat.fillet', 'feat.chamfer', 'feat.shell', 'feat.hole',
         'bool.union', 'bool.cut', 'bool.intersect',
         'doc.undo', 'doc.redo'].forEach(id => {
            assert.ok(ids.includes(id), `missing default action: ${id}`);
        });
    });

    test('every default has label + run', () => {
        for (const a of defaults) {
            assert.ok(a.label, `no label for ${a.id}`);
            assert.equal(typeof a.run, 'function', `no run for ${a.id}`);
        }
    });

    test('sketch.* are hidden when sketchActive', () => {
        const reg = new ActionRegistry({ storage: memStorage() });
        reg.registerAll(defaults);
        const visIds = reg.filter({ sketchActive: true }).map(a => a.id);
        assert.ok(!visIds.includes('sketch.xy'));
        assert.ok(!visIds.includes('add.box'));
    });

    test('feature ops require a non-empty selection (isEnabled)', () => {
        const reg = new ActionRegistry({ storage: memStorage() });
        reg.registerAll(defaults);
        const fillet = reg.get('feat.fillet');
        assert.equal(fillet.isEnabled({ selection: { size: 0 } }), false);
        assert.equal(fillet.isEnabled({ selection: { size: 2 } }), true);
    });

    test('selection-gated defaults surface specific disabledReason strings', () => {
        const reg = new ActionRegistry({ storage: memStorage() });
        reg.registerAll(defaults);
        const ctx = { selection: { size: 0 }, sketchActive: false };
        assert.match(reg.reasonDisabled('feat.fillet',  ctx) || '', /edge/i);
        assert.match(reg.reasonDisabled('feat.chamfer', ctx) || '', /edge/i);
        assert.match(reg.reasonDisabled('feat.shell',   ctx) || '', /face/i);
        assert.match(reg.reasonDisabled('feat.hole',    ctx) || '', /face/i);
        assert.match(reg.reasonDisabled('view.normal',  ctx) || '', /face|plane/i);
        assert.match(reg.reasonDisabled('sel.hide',     ctx) || '', /select|hide/i);
        assert.match(reg.reasonDisabled('sel.clear',    ctx) || '', /selected|nothing/i);
    });

    test('defaultMarkingMenu returns 8 ids for empty-selection context', () => {
        const ids = defaultMarkingMenu({ sketchActive: false, selection: { size: 0 } });
        assert.equal(ids.length, 8);
        ids.forEach(id => assert.equal(typeof id, 'string'));
    });

    test('defaultMarkingMenu swaps to feature ops when something is selected', () => {
        const ids = defaultMarkingMenu({ sketchActive: false, selection: { size: 3 } });
        assert.ok(ids.includes('feat.fillet'));
        assert.ok(ids.includes('feat.chamfer'));
    });

    test('defaultMarkingMenu returns null in sketch mode (the sketcher owns RMB)', () => {
        assert.equal(defaultMarkingMenu({ sketchActive: true, selection: { size: 0 } }), null);
    });
});

// ── sectorFor (marking-menu math) ────────────────────────────────────────────
suite('sectorFor', () => {
    test('inside dead-zone returns null', () => {
        assert.equal(sectorFor(0, 0), null);
        assert.equal(sectorFor(2, 1), null);
    });

    test('east  / west', () => {
        assert.equal(sectorFor( 100, 0), 'e');
        assert.equal(sectorFor(-100, 0), 'w');
    });

    test('north / south (screen Y is +down so north = -y)', () => {
        // In screen coords: dy > 0 = downward (south).
        assert.equal(sectorFor(0,  100), 's');
        assert.equal(sectorFor(0, -100), 'n');
    });

    test('diagonals snap to NE / SE / SW / NW', () => {
        assert.equal(sectorFor( 100, -100), 'ne');
        assert.equal(sectorFor( 100,  100), 'se');
        assert.equal(sectorFor(-100,  100), 'sw');
        assert.equal(sectorFor(-100, -100), 'nw');
    });

    test('angles near a sector boundary still map to the nearer sector', () => {
        // 22.5° above due east is still considered "east" (boundary @ ±22.5°).
        assert.equal(sectorFor(100, -20), 'e');
        assert.equal(sectorFor(100, -60), 'ne');
    });
});

await runAll();
