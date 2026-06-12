/**
 * Tests for src/lib/dfm/checks.js.
 *
 * Run with: `node src/lib/dfm/__tests__/checks.mjs`
 *
 * Strategy: each check consumes the Measure API via the module-level
 * `_measureProvider` hatch installed by `setMeasureForTests`. We stub it
 * with a per-test handler returning canned `{ok, ...}` envelopes — exactly
 * the shape the real `/measure` endpoint returns from spec 07. Nothing
 * touches the kernel, the bridge, or three.js.
 */

import assert from 'node:assert/strict';
import {
    manifoldness, selfIntersection, zeroThickness,
    holePatternValidity, filletEdgeLength, allChecks,
    setMeasureForTests, resetMeasureForTests,
} from '../checks.js';
import { getProfile } from '../profiles.js';

// ── Tiny test runner ─────────────────────────────────────────────────────────

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

// Install a handler dispatch that maps query.type → canned result.
function setHandlers(handlers) {
    setMeasureForTests(async (query) => {
        const fn = handlers[query.type];
        if (!fn) throw new Error(`no handler for query type '${query.type}'`);
        return fn(query);
    });
}

const print3d = getProfile('3d-print');

// ── manifoldness ─────────────────────────────────────────────────────────────

test('manifoldness: closed + watertight → pass', async () => {
    setHandlers({
        manifold: () => ({ ok: true, closed: true, watertight: true, eulerNumber: 2 }),
    });
    const r = await manifoldness('f1', print3d);
    assert.equal(r.ok, true);
    assert.equal(r.severity, 'pass');
});

test('manifoldness: open edges → error with suggested fix', async () => {
    setHandlers({
        manifold: () => ({ ok: true, closed: false, watertight: false, openEdgeCount: 3 }),
    });
    const r = await manifoldness('f1', print3d);
    assert.equal(r.ok, false);
    assert.equal(r.severity, 'error');
    assert.match(r.message, /3 open edges/);
    assert.ok(r.suggestedFix);
});

test('manifoldness: kernel unreachable → "measurement unavailable"', async () => {
    setMeasureForTests(async () => { throw new Error('connect ECONNREFUSED'); });
    const r = await manifoldness('f1', print3d);
    assert.equal(r.severity, 'error');
    assert.equal(r.message, 'measurement unavailable');
});

// ── selfIntersection ─────────────────────────────────────────────────────────

test('selfIntersection: selfOk true → pass', async () => {
    setHandlers({
        selfIntersection: () => ({ ok: true, selfOk: true, locations: [] }),
    });
    const r = await selfIntersection('f1', print3d);
    assert.equal(r.severity, 'pass');
});

test('selfIntersection: hits present → error with location string', async () => {
    setHandlers({
        selfIntersection: () => ({
            ok: true,
            selfOk: false,
            hits: [{ point: [1.234, 2.345, 3.456] }, { point: [9, 9, 9] }],
        }),
    });
    const r = await selfIntersection('f1', print3d);
    assert.equal(r.severity, 'error');
    assert.match(r.message, /2 hits/);
    assert.match(r.message, /1\.23/);
});

// ── zeroThickness ────────────────────────────────────────────────────────────

test('zeroThickness: min dim above threshold → pass', async () => {
    setHandlers({ bbox: () => ({ ok: true, min: [0,0,0], max: [10,10,5], size: [10,10,5] }) });
    const r = await zeroThickness('f1', print3d);  // minWallMm = 0.8
    assert.equal(r.severity, 'pass');
});

test('zeroThickness: min dim below threshold → error', async () => {
    setHandlers({ bbox: () => ({ ok: true, min: [0,0,0], max: [10,10,0.5], size: [10,10,0.5] }) });
    const r = await zeroThickness('f1', print3d);
    assert.equal(r.severity, 'error');
    assert.match(r.message, /0\.500/);
});

test('zeroThickness: bbox per-query failure → measurement unavailable', async () => {
    setHandlers({ bbox: () => ({ ok: false, error: 'feature not found' }) });
    const r = await zeroThickness('f1', print3d);
    assert.equal(r.severity, 'error');
    assert.equal(r.message, 'measurement unavailable');
});

// ── holePatternValidity ──────────────────────────────────────────────────────

test('holePatternValidity: well-spaced holes above min diameter → pass', async () => {
    setHandlers({
        holes: () => ({
            ok: true,
            holes: [
                { diameter: 3.0, center: [0, 0, 0] },
                { diameter: 3.0, center: [50, 0, 0] },
            ],
        }),
    });
    const r = await holePatternValidity('f1', print3d);
    assert.equal(r.severity, 'pass');
});

test('holePatternValidity: hole below minHoleMm → warning', async () => {
    setHandlers({
        holes: () => ({
            ok: true,
            holes: [
                { diameter: 0.8, center: [0, 0, 0] },          // below 1.5
                { diameter: 3.0, center: [50, 0, 0] },
            ],
        }),
    });
    const r = await holePatternValidity('f1', print3d);
    assert.equal(r.severity, 'warning');
    assert.match(r.message, /below Ø1\.5/);
});

test('holePatternValidity: holes closer than 2× max diameter → warning', async () => {
    setHandlers({
        holes: () => ({
            ok: true,
            holes: [
                { diameter: 4.0, center: [0, 0, 0] },
                { diameter: 4.0, center: [5, 0, 0] },  // dist=5 < 2*4=8
            ],
        }),
    });
    const r = await holePatternValidity('f1', print3d);
    assert.equal(r.severity, 'warning');
    assert.match(r.message, /closer than 2×/);
});

// ── filletEdgeLength ─────────────────────────────────────────────────────────

test('filletEdgeLength: radius < min/4 → pass', async () => {
    setHandlers({ bbox: () => ({ ok: true, min: [0,0,0], max: [20,20,20], size: [20,20,20] }) });
    const r = await filletEdgeLength('f1', print3d, 2);   // cap = 5
    assert.equal(r.severity, 'pass');
});

test('filletEdgeLength: radius > min/4 → warning', async () => {
    setHandlers({ bbox: () => ({ ok: true, min: [0,0,0], max: [20,20,20], size: [20,20,20] }) });
    const r = await filletEdgeLength('f1', print3d, 10);  // cap = 5
    assert.equal(r.severity, 'warning');
    assert.match(r.message, /5\.000/);
});

test('filletEdgeLength: missing radius → pass (nothing to predict)', async () => {
    // Even with no measure call, the early return makes this pass.
    setMeasureForTests(async () => { throw new Error('should not be called'); });
    const r = await filletEdgeLength('f1', print3d, undefined);
    assert.equal(r.severity, 'pass');
});

// ── allChecks aggregation ────────────────────────────────────────────────────

test('allChecks: all passing checks yield empty warnings/errors and checks map', async () => {
    setHandlers({
        manifold:         () => ({ ok: true, closed: true, watertight: true, eulerNumber: 2 }),
        selfIntersection: () => ({ ok: true, selfOk: true }),
        bbox:             () => ({ ok: true, min:[0,0,0], max:[20,20,20], size:[20,20,20] }),
        holes:            () => ({ ok: true, holes: [] }),
    });
    const out = await allChecks('f1', print3d, { filletRadius: 1 });
    assert.equal(out.warnings.length, 0);
    assert.equal(out.errors.length, 0);
    assert.equal(out.pass, true);
    assert.ok(out.checks.manifoldness);
    assert.equal(out.checks.manifoldness.severity, 'pass');
});

await run();
