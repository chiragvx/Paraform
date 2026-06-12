/**
 * Tests for src/lib/dfm/runner.js.
 *
 * Run with: `node src/lib/dfm/__tests__/runner.mjs`
 *
 * Same measure-mocking strategy as checks.mjs: install a stub via
 * `setMeasureForTests` and verify the runner's aggregate.
 */

import assert from 'node:assert/strict';
import { runChecks } from '../runner.js';
import { setMeasureForTests, resetMeasureForTests } from '../checks.js';
import { getProfile } from '../profiles.js';

const _tests = [];
function test(name, fn) { _tests.push({ name, fn }); }

async function run() {
    let pass = 0, fail = 0;
    for (const t of _tests) {
        resetMeasureForTests();
        try {
            await t.fn();
            console.log(`  \x1b[32m✓\x1b[0m ${t.name}`);
            pass++;
        } catch (e) {
            console.log(`  \x1b[31m✗\x1b[0m ${t.name}`);
            console.log(`    ${e.stack || e.message}`);
            fail++;
        }
    }
    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail > 0) process.exit(1);
}

function setHandlers(handlers) {
    setMeasureForTests(async (query) => {
        const fn = handlers[query.type];
        if (!fn) throw new Error(`no handler for query type '${query.type}'`);
        return fn(query);
    });
}

// ── Cases ────────────────────────────────────────────────────────────────────

test('runChecks: all-pass world → pass:true, profileId echoed', async () => {
    setHandlers({
        manifold:         () => ({ ok: true, closed: true, watertight: true, eulerNumber: 2 }),
        selfIntersection: () => ({ ok: true, selfOk: true }),
        bbox:             () => ({ ok: true, min:[0,0,0], max:[20,20,20], size:[20,20,20] }),
        holes:            () => ({ ok: true, holes: [] }),
    });
    const r = await runChecks('f1', '3d-print', { filletRadius: 1 });
    assert.equal(r.pass, true);
    assert.equal(r.profileId, '3d-print');
    assert.equal(r.warnings.length, 0);
    assert.equal(r.errors.length, 0);
});

test('runChecks: a warning is surfaced and pass becomes false', async () => {
    setHandlers({
        manifold:         () => ({ ok: true, closed: true, watertight: true }),
        selfIntersection: () => ({ ok: true, selfOk: true }),
        bbox:             () => ({ ok: true, min:[0,0,0], max:[20,20,20], size:[20,20,20] }),
        holes: () => ({ ok: true, holes: [
            { diameter: 4.0, center: [0, 0, 0] },
            { diameter: 4.0, center: [5, 0, 0] },  // too close
        ] }),
    });
    const r = await runChecks('f1', '3d-print', { filletRadius: 1 });
    assert.equal(r.pass, false);
    assert.equal(r.errors.length, 0);
    assert.equal(r.warnings.length, 1);
    assert.equal(r.warnings[0].name, 'holePatternValidity');
});

test('runChecks: an error in one check is surfaced', async () => {
    setHandlers({
        manifold:         () => ({ ok: true, closed: false, watertight: false, openEdgeCount: 1 }),
        selfIntersection: () => ({ ok: true, selfOk: true }),
        bbox:             () => ({ ok: true, min:[0,0,0], max:[20,20,20], size:[20,20,20] }),
        holes:            () => ({ ok: true, holes: [] }),
    });
    const r = await runChecks('f1', '3d-print', { filletRadius: 1 });
    assert.equal(r.pass, false);
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0].name, 'manifoldness');
});

test('runChecks: switching profile changes the enabled set', async () => {
    // cnc-mill does NOT include zeroThickness. A 0.1 mm body is fine on the
    // mill profile but errors on 3d-print.
    setHandlers({
        manifold:         () => ({ ok: true, closed: true, watertight: true }),
        selfIntersection: () => ({ ok: true, selfOk: true }),
        bbox:             () => ({ ok: true, min:[0,0,0], max:[10,10,0.1], size:[10,10,0.1] }),
        holes:            () => ({ ok: true, holes: [] }),
    });
    const print = await runChecks('f1', '3d-print');
    const cnc   = await runChecks('f1', 'cnc-mill');

    assert.equal(print.pass, false);
    assert.equal(print.errors.find((e) => e.name === 'zeroThickness') !== undefined, true);

    // cnc-mill skips zeroThickness entirely.
    assert.equal(cnc.checks.zeroThickness, undefined);
    // ...so its only complaint would come from the fillet check, which we
    // didn't supply a radius for → pass.
    assert.equal(cnc.pass, true);
});

test('runChecks: missing featureId yields a single runner error', async () => {
    const r = await runChecks('', '3d-print');
    assert.equal(r.pass, false);
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0].name, 'runner');
});

test('runChecks: unknown profile id falls back to default', async () => {
    setHandlers({
        manifold:         () => ({ ok: true, closed: true, watertight: true }),
        selfIntersection: () => ({ ok: true, selfOk: true }),
        bbox:             () => ({ ok: true, min:[0,0,0], max:[20,20,20], size:[20,20,20] }),
        holes:            () => ({ ok: true, holes: [] }),
    });
    const r = await runChecks('f1', 'does-not-exist');
    // Falls back to '3d-print'.
    assert.equal(r.profileId, '3d-print');
    // Verifies profile object resolution happened: zeroThickness is enabled on 3d-print.
    assert.ok('zeroThickness' in r.checks);
    // sanity: profile lookup helper still returns the default
    assert.equal(getProfile('does-not-exist').label, '3D Print (FDM)');
});

await run();
