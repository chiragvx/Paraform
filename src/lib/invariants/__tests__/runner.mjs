/**
 * Tests for src/lib/invariants/runner.js.
 *
 * Run with: `node src/lib/invariants/__tests__/runner.mjs`
 *
 * Strategy: inject a fake doc + measure + DFM module, run the public
 * runner entry points, and assert the aggregate shape + per-scope counts.
 */

import assert from 'node:assert/strict';

import { runInvariants, runAllInvariants, SCOPE } from '../runner.js';
import {
    _setDfmModuleForTests,
    _resetDfmCacheForTests,
} from '../library.js';
import {
    setCatalogProviderForInvariants,
    resetCatalogProviderForInvariants,
    setDocProviderForInvariants,
    resetDocProviderForInvariants,
} from '../lookups.js';

// ── tiny test runner ────────────────────────────────────────────────────────

const _tests = [];
function test(name, fn) { _tests.push({ name, fn }); }

async function run() {
    let pass = 0, fail = 0;
    for (const t of _tests) {
        resetCatalogProviderForInvariants();
        resetDocProviderForInvariants();
        _resetDfmCacheForTests();
        // Default: a no-op DFM so per-feature geometric invariants pass.
        _setDfmModuleForTests({
            manifoldness: async () => ({ ok: true, severity: 'pass', message: 'OK', measured: null }),
            selfIntersection: async () => ({ ok: true, severity: 'pass', message: 'OK', measured: null }),
            zeroThickness: async () => ({ ok: true, severity: 'pass', message: 'OK', measured: null }),
            threadEngagement: async () => ({ ok: true, severity: 'pass', message: 'OK', measured: null }),
            bearingBoreFit: async () => ({ ok: true, severity: 'pass', message: 'OK', measured: null }),
            clearanceHoleSize: async () => ({ ok: true, severity: 'pass', message: 'OK', measured: null }),
        });
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

// ── cases ───────────────────────────────────────────────────────────────────

test('runInvariants: unknown scope returns runner error envelope', async () => {
    const r = await runInvariants('not-a-scope', null, { doc: {} });
    assert.equal(r.pass, false);
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0].id, 'runner');
});

test('runInvariants: per-feature clean body → pass', async () => {
    const doc = {
        features: {
            box1: { id: 'box1', type: 'Box', params: { material: '6061-T6' } },
        },
    };
    const r = await runInvariants(SCOPE.PER_FEATURE, 'box1', { doc });
    assert.equal(r.pass, true);
    assert.equal(r.warnings.length, 0);
    assert.equal(r.errors.length, 0);
    // every per-feature invariant ran and is recorded.
    assert.ok(r.results['i-manifold-all-bodies']);
    assert.ok(r.results['i-material-assigned']);
});

test('runInvariants: per-feature missing material warns', async () => {
    const doc = {
        features: {
            box1: { id: 'box1', type: 'Box', params: {} },
        },
    };
    const r = await runInvariants(SCOPE.PER_FEATURE, 'box1', { doc });
    assert.equal(r.pass, false);
    assert.equal(r.warnings.length, 1);
    assert.equal(r.warnings[0].id, 'i-material-assigned');
});

test('runInvariants: per-feature bad fillet errors', async () => {
    const doc = {
        features: {
            f1: { id: 'f1', type: 'Fillet', params: { radius: 0 } },
        },
    };
    const r = await runInvariants(SCOPE.PER_FEATURE, 'f1', { doc });
    assert.equal(r.pass, false);
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0].id, 'i-fillet-radius-positive');
});

test('runInvariants: per-component orphan errors', async () => {
    const doc = {
        components: {
            root: { id: 'root' },
            orphan: { id: 'orphan' },
        },
        rootComponentId: 'root',
    };
    const r = await runInvariants(SCOPE.PER_COMPONENT, 'orphan', { doc });
    assert.equal(r.pass, false);
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0].id, 'i-component-has-parent');
});

test('runInvariants: per-document with cycle errors', async () => {
    const doc = {
        components: {
            a: { id: 'a', parentId: 'b' },
            b: { id: 'b', parentId: 'a' },
        },
        profileId: '3d-print',
    };
    const r = await runInvariants(SCOPE.PER_DOCUMENT, null, { doc });
    assert.equal(r.pass, false);
    assert.equal(r.errors.length >= 1, true);
    const ids = r.errors.map((e) => e.id);
    assert.ok(ids.includes('i-no-cyclic-components'));
});

test('runInvariants: per-document with no profile warns', async () => {
    const doc = {};  // no profileId, no components, no params
    const r = await runInvariants(SCOPE.PER_DOCUMENT, null, { doc });
    assert.equal(r.warnings.length, 1);
    assert.equal(r.warnings[0].id, 'i-process-assigned');
});

test('runInvariants: never throws when a check throws', async () => {
    // Inject a DFM that throws — runner should capture, not crash.
    _setDfmModuleForTests({
        manifoldness: async () => { throw new Error('boom'); },
        selfIntersection: async () => ({ ok: true, severity: 'pass', message: 'OK', measured: null }),
        zeroThickness: async () => ({ ok: true, severity: 'pass', message: 'OK', measured: null }),
        threadEngagement: async () => ({ ok: true, severity: 'pass', message: 'OK', measured: null }),
        bearingBoreFit: async () => ({ ok: true, severity: 'pass', message: 'OK', measured: null }),
        clearanceHoleSize: async () => ({ ok: true, severity: 'pass', message: 'OK', measured: null }),
    });
    const doc = {
        features: { b1: { id: 'b1', type: 'Box', params: { material: '6061-T6' } } },
    };
    const r = await runInvariants(SCOPE.PER_FEATURE, 'b1', { doc });
    // Defensive: callDfm wraps the throw → 'not applicable' pass. Result
    // is a pass for that check; the runner itself never re-throws.
    assert.ok(r.results['i-manifold-all-bodies']);
    assert.equal(typeof r.pass, 'boolean');
});

test('runAllInvariants: aggregates across every scope', async () => {
    const doc = {
        profileId: '3d-print',
        features: {
            box1: { id: 'box1', type: 'Box', params: { material: '6061-T6' } },
            badFillet: { id: 'badFillet', type: 'Fillet', params: { radius: 0 } },
        },
        components: {
            root: { id: 'root' },
            child: { id: 'child', parentId: 'root' },
        },
        rootComponentId: 'root',
    };
    const r = await runAllInvariants({ doc });
    assert.equal(typeof r.pass, 'boolean');
    assert.ok(r.byScope[SCOPE.PER_FEATURE].box1);
    assert.ok(r.byScope[SCOPE.PER_FEATURE].badFillet);
    assert.ok(r.byScope[SCOPE.PER_COMPONENT].root);
    assert.ok(r.byScope[SCOPE.PER_DOCUMENT]);
    // The bad fillet should appear in the aggregate errors with targetId.
    const filletErr = r.errors.find((e) =>
        e.id === 'i-fillet-radius-positive' && e.targetId === 'badFillet');
    assert.ok(filletErr);
});

test('runAllInvariants: clean tiny doc passes overall', async () => {
    const doc = {
        profileId: '3d-print',
        features: {
            box1: { id: 'box1', type: 'Box', params: { material: '6061-T6' } },
        },
        components: { root: { id: 'root' } },
        rootComponentId: 'root',
    };
    const r = await runAllInvariants({ doc });
    assert.equal(r.errors.length, 0, JSON.stringify(r.errors, null, 2));
    assert.equal(r.warnings.length, 0, JSON.stringify(r.warnings, null, 2));
    assert.equal(r.pass, true);
});

test('runAllInvariants: includes profileId pass when set', async () => {
    const doc = { profileId: '3d-print' };
    const r = await runAllInvariants({ doc });
    const procResult = r.byScope[SCOPE.PER_DOCUMENT].results['i-process-assigned'];
    assert.equal(procResult.severity, 'pass');
});

// ── go ──────────────────────────────────────────────────────────────────────

run();
