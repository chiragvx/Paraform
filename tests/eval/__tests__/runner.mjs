#!/usr/bin/env node
/**
 * Unit tests for the eval runner itself. These exercise the pure helpers —
 * loadCorpus / compareConstraints / compareAssumptions / synthesiseDoc /
 * aggregate / detectRegressions / baseline I/O — without touching the
 * filesystem outside a temp dir.
 *
 * Run via:
 *   node --import ./src/lib/commands/__tests__/_register.mjs tests/eval/__tests__/runner.mjs
 */

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
    loadCorpus,
    constraintMatches,
    compareConstraints,
    compareAssumptions,
    synthesiseDoc,
    runEntry,
    aggregate,
    detectRegressions,
    loadBaseline,
    writeBaseline,
    runAll,
} from '../runner.mjs';

let pass = 0, fail = 0;
function test(name, fn) {
    return Promise.resolve().then(fn).then(
        () => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); },
        (e) => { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}\n    ${e.message}`); },
    );
}

const tmp = mkdtempSync(path.join(tmpdir(), 'paraform-eval-'));

// 1. corpus loading — happy path.
await test('loadCorpus reads JSON files under a directory', () => {
    const dir = path.join(tmp, 'c1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'a.json'), JSON.stringify([
        { id: 'x1', spec: 'a 10 mm cube' },
    ]));
    const entries = loadCorpus(dir);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].id, 'x1');
});

// 2. corpus loading — missing id/spec throws.
await test('loadCorpus throws on missing id/spec', () => {
    const dir = path.join(tmp, 'c2');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'bad.json'), JSON.stringify([{ id: 'x' }]));
    assert.throws(() => loadCorpus(dir), /missing id\/spec/);
});

// 3. constraintMatches partial.
await test('constraintMatches partial — extras on actual ignored', () => {
    const exp = { _c: 'dimension', axis: 'length', value: 60 };
    const act = { _c: 'dimension', axis: 'length', value: 60, unit: 'mm', _src: 'dimension' };
    assert.equal(constraintMatches(exp, act), true);
    const bad = { _c: 'dimension', axis: 'length', value: 61, unit: 'mm' };
    assert.equal(constraintMatches(exp, bad), false);
});

// 4. compareConstraints — ok=true when all matched.
await test('compareConstraints reports ok+matched when expected covered', () => {
    const expected = [{ _c: 'material', material: '6061' }];
    const actual = [{ _c: 'material', material: '6061', grade: null }];
    const r = compareConstraints(expected, actual);
    assert.equal(r.ok, true);
    assert.equal(r.matched.length, 1);
    assert.equal(r.missing.length, 0);
});

// 5. compareConstraints — missing surfaced.
await test('compareConstraints reports missing entries', () => {
    const expected = [{ _c: 'material', material: '6061' }, { _c: 'dimension', axis: 'length', value: 10 }];
    const actual = [{ _c: 'material', material: '6061' }];
    const r = compareConstraints(expected, actual);
    assert.equal(r.ok, false);
    assert.equal(r.missing.length, 1);
    assert.equal(r.missing[0]._c, 'dimension');
});

// 6. compareAssumptions — kind match.
await test('compareAssumptions matches by kind', () => {
    const r = compareAssumptions(
        [{ kind: 'material-grade' }],
        [{ kind: 'material-grade', span: [0, 8] }],
    );
    assert.equal(r.ok, true);
    assert.equal(r.matched.length, 1);
});

// 7. synthesiseDoc emits a body feature with dims + material.
await test('synthesiseDoc builds doc with body feature for dim+material', () => {
    const doc = synthesiseDoc([
        { _c: 'dimension', axis: 'length', value: 60 },
        { _c: 'material', material: '6061' },
    ]);
    const bodyId = Object.keys(doc.features).find((k) => doc.features[k].type === 'body');
    assert.ok(bodyId);
    assert.equal(doc.features[bodyId].material, '6061');
    assert.equal(doc.features[bodyId].params.length, 60);
});

// 8. synthesiseDoc emits a standardPart feature for part_selection.
await test('synthesiseDoc adds a standardPart feature per part_selection', () => {
    const doc = synthesiseDoc([
        { _c: 'part_selection', catalogPrefix: 'iso273', nominalSize: 'M3', qty: 4, role: 'clearance' },
    ]);
    const sp = Object.values(doc.features).find((f) => f.type === 'standardPart');
    assert.ok(sp);
    assert.equal(sp.partRef.catalogPrefix, 'iso273');
    assert.equal(sp.partRef.qty, 4);
});

// 9. runEntry happy path against extractor.
await test('runEntry runs the extractor + invariants for one entry', async () => {
    const entry = {
        id: 'test-cube',
        category: 'unit',
        spec: '40 mm cube',
        expectedConstraints: [{ _c: 'dimension', axis: 'length', value: 40, unit: 'mm' }],
    };
    const r = await runEntry(entry);
    assert.equal(r.id, 'test-cube');
    assert.equal(r.constraints.ok, true);
    assert.ok(r.perInvariant);
    assert.equal(r.ok, true);
});

// 10. aggregate produces per-category + per-invariant rates.
await test('aggregate computes pass rates per category and per invariant', () => {
    const results = [
        { id: 'a', category: 'x', ok: true,  perInvariant: { 'i-1': true,  'i-2': false } },
        { id: 'b', category: 'x', ok: false, perInvariant: { 'i-1': true,  'i-2': true  } },
        { id: 'c', category: 'y', ok: true,  perInvariant: { 'i-1': false, 'i-2': true  } },
    ];
    const a = aggregate(results);
    assert.equal(a.total, 3);
    assert.equal(a.passed, 2);
    assert.equal(a.byCategory.x.total, 2);
    assert.equal(a.byCategory.x.passed, 1);
    assert.equal(a.byCategory.y.passRate, 1);
    assert.equal(a.perInvariant['i-1'].passed, 2);
    assert.equal(a.perInvariant['i-2'].passed, 2);
});

// 11. detectRegressions catches a > 5% drop.
await test('detectRegressions flags > 5% pass-rate drops', () => {
    const baseline = {
        overallPassRate: 1.0,
        perInvariant: {
            'i-1': { passRate: 1.0 },
            'i-2': { passRate: 0.8 },
        },
    };
    const now = {
        overallPassRate: 0.99,
        perInvariant: {
            'i-1': { passRate: 0.99 },         // tiny drop — allowed.
            'i-2': { passRate: 0.7 },          // 10% drop — regression.
        },
    };
    const gate = detectRegressions(now, baseline);
    assert.equal(gate.ok, false);
    assert.equal(gate.regressions.length, 1);
    assert.equal(gate.regressions[0].invariantId, 'i-2');
});

// 12. detectRegressions passes with missing baseline.
await test('detectRegressions returns ok when baseline missing', () => {
    const gate = detectRegressions({ overallPassRate: 0.5, perInvariant: {} }, null);
    assert.equal(gate.ok, true);
    assert.equal(gate.baselineMissing, true);
});

// 13. writeBaseline + loadBaseline round-trip.
await test('writeBaseline + loadBaseline round-trip', () => {
    const p = path.join(tmp, 'bl.json');
    const agg = { overallPassRate: 0.95, perInvariant: { 'i-1': { passRate: 0.9 } }, byCategory: {} };
    writeBaseline(agg, p);
    assert.equal(existsSync(p), true);
    const loaded = loadBaseline(p);
    assert.equal(loaded.overallPassRate, 0.95);
    assert.equal(loaded.perInvariant['i-1'].passRate, 0.9);
});

// 14. End-to-end: runAll on a tiny corpus.
await test('runAll executes across a directory of corpus files', async () => {
    const dir = path.join(tmp, 'corpus-mini');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'mini.json'), JSON.stringify([
        { id: 'cube', category: 'prim', spec: '40 mm cube',
          expectedConstraints: [{ _c: 'dimension', axis: 'length', value: 40, unit: 'mm' }] },
        { id: 'cyl', category: 'prim', spec: 'Ø22 mm cylinder, 10 mm tall',
          expectedConstraints: [
              { _c: 'dimension', axis: 'diameter', value: 22, unit: 'mm' },
              { _c: 'dimension', axis: 'height', value: 10, unit: 'mm' },
          ] },
    ]));
    const out = await runAll(dir);
    assert.equal(out.results.length, 2);
    assert.equal(out.aggregate.total, 2);
});

// Cleanup tmp.
try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }

console.log(`\neval runner tests: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
