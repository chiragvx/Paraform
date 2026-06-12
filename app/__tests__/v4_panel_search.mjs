/**
 * Tests for app/v4_panel/search.js — parseSearch + matchFeature.
 *
 * Run via:  node app/__tests__/v4_panel_search.mjs
 */
import assert from 'node:assert/strict';
import { parseSearch, matchFeature, filterFeatureIds } from '../v4_panel/search.js';

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

function f(over = {}) {
    return {
        id: 'F1', type: 'Box', name: 'Body 1', enabled: true,
        warnings: [], params: {}, inputs: {},
        ...over,
    };
}

suite('parseSearch', () => {
    test('empty query → no filters', () => {
        assert.deepEqual(parseSearch(''), { text: '', filters: {} });
        assert.deepEqual(parseSearch('   '), { text: '', filters: {} });
    });
    test('plain text → lowercased free text', () => {
        assert.deepEqual(parseSearch('Hole'), { text: 'hole', filters: {} });
        assert.deepEqual(parseSearch('Base Plate'), { text: 'base plate', filters: {} });
    });
    test(':type fillet sets type filter', () => {
        assert.deepEqual(parseSearch(':type fillet'), { text: '', filters: { type: 'fillet' } });
    });
    test(':type=fillet inline form', () => {
        assert.deepEqual(parseSearch(':type=fillet'), { text: '', filters: { type: 'fillet' } });
    });
    test(':errors / :suppressed / :variable are flags', () => {
        assert.deepEqual(parseSearch(':errors'),     { text: '', filters: { errors: true } });
        assert.deepEqual(parseSearch(':suppressed'), { text: '', filters: { suppressed: true } });
        assert.deepEqual(parseSearch(':variable'),   { text: '', filters: { variable: true } });
        assert.deepEqual(parseSearch(':param'),      { text: '', filters: { variable: true } });
    });
    test('multiple filters compose with free text', () => {
        assert.deepEqual(parseSearch(':type fillet hole'),
            { text: 'hole', filters: { type: 'fillet' } });
        assert.deepEqual(parseSearch(':errors :suppressed'),
            { text: '', filters: { errors: true, suppressed: true } });
    });
    test('unknown prefix preserved as free text', () => {
        assert.deepEqual(parseSearch(':nope foo'),
            { text: ':nope foo', filters: {} });
    });
});

suite('matchFeature', () => {
    test('empty query matches everything', () => {
        assert.equal(matchFeature(f(), parseSearch('')), true);
    });
    test('free-text matches feature name', () => {
        assert.equal(matchFeature(f({ name: 'Body 1' }), parseSearch('body')), true);
        assert.equal(matchFeature(f({ name: 'Body 1' }), parseSearch('flange')), false);
    });
    test('free-text matches type label and raw type', () => {
        assert.equal(matchFeature(f({ type: 'LinearPattern' }), parseSearch('linear')), true);
        assert.equal(matchFeature(f({ type: 'LinearPattern' }), parseSearch('pattern')), true);
        assert.equal(matchFeature(f({ type: 'LinearPattern' }), parseSearch('fillet')), false);
    });
    test(':type filter matches by type label or raw type', () => {
        assert.equal(matchFeature(f({ type: 'Fillet' }), parseSearch(':type fill')), true);
        assert.equal(matchFeature(f({ type: 'Box' }),    parseSearch(':type fill')), false);
    });
    test(':errors filter only shows features with warnings', () => {
        assert.equal(matchFeature(f({ warnings: ['bad'] }), parseSearch(':errors')), true);
        assert.equal(matchFeature(f({ warnings: [] }),      parseSearch(':errors')), false);
        assert.equal(matchFeature(f(),                       parseSearch(':errors')), false);
    });
    test(':suppressed filter only shows enabled=false', () => {
        assert.equal(matchFeature(f({ enabled: false }), parseSearch(':suppressed')), true);
        assert.equal(matchFeature(f({ enabled: true  }), parseSearch(':suppressed')), false);
    });
    test(':variable filter matches Parameter and Equation only', () => {
        assert.equal(matchFeature(f({ type: 'Parameter' }), parseSearch(':variable')), true);
        assert.equal(matchFeature(f({ type: 'Equation' }),  parseSearch(':variable')), true);
        assert.equal(matchFeature(f({ type: 'Box' }),        parseSearch(':variable')), false);
    });
    test('multiple filters compose with AND', () => {
        const target = f({ type: 'Fillet', enabled: false, warnings: ['x'] });
        const parsed = parseSearch(':type fill :suppressed :errors');
        assert.equal(matchFeature(target, parsed), true);

        const lessGood = f({ type: 'Fillet', enabled: false, warnings: [] });
        assert.equal(matchFeature(lessGood, parsed), false);  // missing :errors
    });
    test('free text + prefix filter compose', () => {
        const target = f({ type: 'Fillet', name: 'Edge Round' });
        assert.equal(matchFeature(target, parseSearch(':type fill round')), true);
        assert.equal(matchFeature(target, parseSearch(':type fill cube')),  false);
    });
});

suite('filterFeatureIds', () => {
    test('returns only matching ids preserving order', () => {
        const byId = {
            a: f({ id: 'a', type: 'Box',    name: 'Body 1', enabled: true }),
            b: f({ id: 'b', type: 'Fillet', name: 'Edge',   enabled: false }),
            c: f({ id: 'c', type: 'Hole',   name: 'M3 Hole', enabled: true, warnings: ['oops'] }),
        };
        const ids = ['a', 'b', 'c'];
        assert.deepEqual(filterFeatureIds(ids, byId, parseSearch(':errors')),     ['c']);
        assert.deepEqual(filterFeatureIds(ids, byId, parseSearch(':suppressed')), ['b']);
        assert.deepEqual(filterFeatureIds(ids, byId, parseSearch(':type box')),   ['a']);
        assert.deepEqual(filterFeatureIds(ids, byId, parseSearch('')),            ['a', 'b', 'c']);
    });
});

runAll();
