/**
 * Phase 2a tests for query DSL hardening + resolver enforcement.
 *
 * Covers:
 *   - `expect` modifier on every factory + resolver enforcement.
 *   - qDatum vocabulary (corner / face / edge) + min/max shorthand.
 *   - containsOrdinalRef walker.
 *   - validateStrict rejecting ordinal refs / missing expect.
 *   - QueryResolutionError carries candidate descriptors.
 *   - describeQuery renders the expect modifier.
 *   - Legacy callers without `expect` continue to resolve unchanged.
 *
 * Zero-dep — uses Node's `assert/strict`. Run via:
 *   node lib/document/__tests__/strict_queries.mjs
 */

import assert from 'node:assert/strict';
import {
    OP_TAGS,
    face, edge, vertex,
    stringify as descriptorString,
} from '../descriptor.js';
import {
    qDescriptor, qFeatureFaces, qFeatureEdges, qFeatureVertices,
    qOp, qUnion, qSubtract, qNth, qFilter, qByDirection, qDescendsFrom,
    qDatum,
    describeQuery,
    validate as validateQuery,
    validateStrict,
    containsOrdinalRef,
    EXPECT,
    PRED,
} from '../queries.js';
import {
    buildIndex,
    resolve as resolveQuery,
    QueryResolutionError,
} from '../resolver.js';

// ── tiny harness ─────────────────────────────────────────────────────────────
const _tests = [];
let _suite = '';
function suite(name, fn) { _suite = name; fn(); _suite = ''; }
function test(name, fn)  { _tests.push({ suite: _suite, name, fn }); }
async function runAll() {
    let pass = 0, fail = 0;
    for (const t of _tests) {
        try {
            await t.fn();
            pass++;
            console.log(`  \x1b[32m✓\x1b[0m ${t.suite ? t.suite + ' › ' : ''}${t.name}`);
        } catch (e) {
            fail++;
            console.log(`  \x1b[31m✗\x1b[0m ${t.suite ? t.suite + ' › ' : ''}${t.name}`);
            console.log(`    ${e.message}`);
            if (e.actual !== undefined || e.expected !== undefined) {
                console.log(`    actual:   ${JSON.stringify(e.actual)}`);
                console.log(`    expected: ${JSON.stringify(e.expected)}`);
            }
        }
    }
    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail > 0) process.exit(1);
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** Box `box_x` with 6 faces, 12 edges, 8 vertices — each correctly part-tagged. */
function synthBoxTopology(featureId, opTag = OP_TAGS.BOX) {
    const F = (part, normal) => ({
        descriptor: face(featureId, opTag, part),
        normalRounded: normal,
        surfaceType: 'planar',
        area: 100,
    });
    const E = (part) => ({ descriptor: edge(featureId, opTag, part) });
    const V = (part) => ({ descriptor: vertex(featureId, opTag, part) });
    const cornerParts = [];
    for (const sx of ['+', '-'])
    for (const sy of ['+', '-'])
    for (const sz of ['+', '-']) cornerParts.push(`${sx}X${sy}Y${sz}Z`);
    return {
        featureId,
        faces: [
            F('+X', [+1, 0, 0]),
            F('-X', [-1, 0, 0]),
            F('+Y', [0, +1, 0]),
            F('-Y', [0, -1, 0]),
            F('+Z', [0, 0, +1]),
            F('-Z', [0, 0, -1]),
        ],
        edges: [
            E('+X+Z'), E('-X+Z'), E('+X-Z'), E('-X-Z'),
            E('+Y+Z'), E('-Y+Z'), E('+Y-Z'), E('-Y-Z'),
            E('+X+Y'), E('-X+Y'), E('+X-Y'), E('-X-Y'),
        ],
        vertices: cornerParts.map(V),
    };
}

function synthCylTopology(featureId) {
    return {
        featureId,
        faces: [
            { descriptor: face(featureId, OP_TAGS.CYL, 'top'),    normalRounded: [0, 0, +1], surfaceType: 'planar' },
            { descriptor: face(featureId, OP_TAGS.CYL, 'bottom'), normalRounded: [0, 0, -1], surfaceType: 'planar' },
            { descriptor: face(featureId, OP_TAGS.CYL, 'lateral'),                            surfaceType: 'cylindrical' },
        ],
        edges: [],
        vertices: [],
    };
}

function makeIndex() {
    return buildIndex({
        nodes: [
            synthBoxTopology('box_x'),
            synthCylTopology('cyl_y'),
        ],
    });
}

// ── Expect modifier — legacy back-compat ─────────────────────────────────────
suite('expect: legacy', () => {
    test('qFeatureFaces with no expect, multi-result → legacy success (no throw)', () => {
        const idx = makeIndex();
        const q = qFeatureFaces('box_x');
        assert.equal(q.expect, null);
        const out = resolveQuery(q, idx);
        assert.equal(out.length, 6);  // all six box faces
    });

    test('qOp legacy 4-arg call signature still works', () => {
        const q = qOp('face', 'box_x', OP_TAGS.BOX, '+Z');
        assert.equal(q.part, '+Z');
        assert.equal(q.expect, null);
        const idx = makeIndex();
        const out = resolveQuery(q, idx);
        assert.equal(out.length, 1);
    });

    test('all factories accept an empty opts bag (no expect leakage)', () => {
        assert.equal(qFeatureFaces('a', {}).expect, null);
        assert.equal(qFeatureEdges('a', {}).expect, null);
        assert.equal(qFeatureVertices('a', {}).expect, null);
        assert.equal(qFilter(qFeatureFaces('a'), PRED.planar(), {}).expect, null);
        assert.equal(qByDirection(qFeatureFaces('a'), '+Z', {}).expect, null);
        assert.equal(qNth(qFeatureFaces('a'), 0, {}).expect, null);
    });
});

// ── Expect modifier — enforcement ────────────────────────────────────────────
suite('expect: exactly-one', () => {
    test('multi-result throws QueryResolutionError with candidates listed', () => {
        const idx = makeIndex();
        const q = qFeatureFaces('box_x', { expect: 'exactly-one' });
        let caught;
        try { resolveQuery(q, idx); }
        catch (e) { caught = e; }
        assert.ok(caught, 'expected throw');
        assert.ok(caught instanceof QueryResolutionError, 'wrong error class');
        assert.equal(caught.expect, 'exactly-one');
        assert.equal(caught.candidates.length, 6);
        // Error message must mention the count.
        assert.match(caught.message, /6/);
        // The query record is attached for caller diagnostics.
        assert.equal(caught.query, q);
    });

    test('candidate list contains canonical descriptors', () => {
        const idx = makeIndex();
        const q = qFeatureFaces('box_x', { expect: 'exactly-one' });
        try {
            resolveQuery(q, idx);
            assert.fail('should have thrown');
        } catch (e) {
            const parts = e.candidates.map(d => d.part).sort();
            assert.deepEqual(parts, ['+X', '+Y', '+Z', '-X', '-Y', '-Z']);
        }
    });

    test('disambiguated to one via qByDirection resolves cleanly', () => {
        const idx = makeIndex();
        const q = qByDirection(qFeatureFaces('box_x'), '+Z', { expect: 'exactly-one' });
        const out = resolveQuery(q, idx);
        assert.equal(out.length, 1);
        assert.equal(out[0].descriptor.part, '+Z');
    });

    test('zero-result + exactly-one throws with empty candidates', () => {
        const idx = makeIndex();
        const q = qFeatureFaces('nope', { expect: 'exactly-one' });
        let caught;
        try { resolveQuery(q, idx); }
        catch (e) { caught = e; }
        assert.ok(caught instanceof QueryResolutionError);
        assert.equal(caught.candidates.length, 0);
        assert.match(caught.message, /zero/);
    });
});

suite('expect: at-least-one', () => {
    test('zero-result → throws QueryResolutionError', () => {
        const idx = makeIndex();
        const q = qFeatureFaces('does_not_exist', { expect: 'at-least-one' });
        assert.throws(() => resolveQuery(q, idx), QueryResolutionError);
    });

    test('one-result → resolves', () => {
        const idx = makeIndex();
        const q = qByDirection(qFeatureFaces('box_x'), '+Z', { expect: 'at-least-one' });
        const out = resolveQuery(q, idx);
        assert.equal(out.length, 1);
    });

    test('multi-result → resolves (no upper-bound check)', () => {
        const idx = makeIndex();
        const q = qFeatureFaces('box_x', { expect: 'at-least-one' });
        const out = resolveQuery(q, idx);
        assert.equal(out.length, 6);
    });
});

suite('expect: all', () => {
    test('all is no-op: 0 results OK, N results OK', () => {
        const idx = makeIndex();
        assert.deepEqual(resolveQuery(qFeatureFaces('nope', { expect: 'all' }), idx), []);
        assert.equal(resolveQuery(qFeatureFaces('box_x', { expect: 'all' }), idx).length, 6);
    });
});

suite('expect: validation', () => {
    test('invalid expect value rejected at factory time', () => {
        assert.throws(() => qFeatureFaces('box_x', { expect: 'maybe-one' }), /invalid value/);
    });

    test('EXPECT enum exposes the three valid keys', () => {
        assert.equal(EXPECT.EXACTLY_ONE,  'exactly-one');
        assert.equal(EXPECT.AT_LEAST_ONE, 'at-least-one');
        assert.equal(EXPECT.ALL,          'all');
    });
});

// ── qDatum ───────────────────────────────────────────────────────────────────
suite('qDatum: parsing', () => {
    test('corner-+X+Y+Z resolves to vertex with part=+X+Y+Z', () => {
        const idx = makeIndex();
        const out = resolveQuery(qDatum('box_x', 'corner-+X+Y+Z'), idx);
        assert.equal(out.length, 1);
        assert.equal(out[0].descriptor.kind, 'vertex');
        assert.equal(out[0].descriptor.part, '+X+Y+Z');
    });

    test('corner-min-min-min resolves to vertex with part=-X-Y-Z (synonym)', () => {
        const idx = makeIndex();
        const out = resolveQuery(qDatum('box_x', 'corner-min-min-min'), idx);
        assert.equal(out.length, 1);
        assert.equal(out[0].descriptor.part, '-X-Y-Z');
    });

    test('corner-max-min-min resolves to part=+X-Y-Z', () => {
        const idx = makeIndex();
        const out = resolveQuery(qDatum('box_x', 'corner-max-min-min'), idx);
        assert.equal(out.length, 1);
        assert.equal(out[0].descriptor.part, '+X-Y-Z');
    });

    test('corner spec canonicalises axis order (+Y+X+Z → +X+Y+Z)', () => {
        const q = qDatum('box_x', 'corner-+Y+X+Z');
        assert.equal(q.resolvedPart, '+X+Y+Z');
    });

    test('face-+Z resolves to face with part=+Z', () => {
        const idx = makeIndex();
        const out = resolveQuery(qDatum('box_x', 'face-+Z'), idx);
        assert.equal(out.length, 1);
        assert.equal(out[0].descriptor.kind, 'face');
        assert.equal(out[0].descriptor.part, '+Z');
    });

    test('face-min-z shorthand resolves to face with part=-Z', () => {
        const idx = makeIndex();
        const out = resolveQuery(qDatum('box_x', 'face-min-z'), idx);
        assert.equal(out.length, 1);
        assert.equal(out[0].descriptor.part, '-Z');
    });

    test('edge-+X+Z resolves to edge with part=+X+Z', () => {
        const idx = makeIndex();
        const out = resolveQuery(qDatum('box_x', 'edge-+X+Z'), idx);
        assert.equal(out.length, 1);
        assert.equal(out[0].descriptor.kind, 'edge');
        assert.equal(out[0].descriptor.part, '+X+Z');
    });

    test('face-top resolves to cylinder top face (literal part vocabulary)', () => {
        const idx = makeIndex();
        const out = resolveQuery(qDatum('cyl_y', 'face-top'), idx);
        assert.equal(out.length, 1);
        assert.equal(out[0].descriptor.part, 'top');
    });

    test('missing datum throws QueryResolutionError (default expect=exactly-one)', () => {
        const idx = makeIndex();
        let caught;
        try { resolveQuery(qDatum('box_x', 'face-+W'), idx); }  // +W doesn't exist
        catch (e) { caught = e; }
        assert.ok(caught instanceof QueryResolutionError);
        assert.equal(caught.candidates.length, 0);
    });

    test('qDatum on missing feature throws QueryResolutionError', () => {
        const idx = makeIndex();
        assert.throws(
            () => resolveQuery(qDatum('does_not_exist', 'face-+Z'), idx),
            QueryResolutionError,
        );
    });

    test('qDatum default expect is exactly-one', () => {
        const q = qDatum('box_x', 'face-+Z');
        assert.equal(q.expect, 'exactly-one');
    });

    test('qDatum honours explicit expect:all override', () => {
        const idx = makeIndex();
        const q = qDatum('box_x', 'face-+W', { expect: 'all' });
        assert.deepEqual(resolveQuery(q, idx), []);  // no-op enforcement
    });

    test('qDatum rejects bad datumKey', () => {
        assert.throws(() => qDatum('box_x', ''),       /missing datumKey/);
        assert.throws(() => qDatum('box_x', 'noKind'), /bad datumKey/);
        assert.throws(() => qDatum('box_x', 'wat-+Z'), /kind "wat"/);
        assert.throws(() => qDatum('', 'face-+Z'),     /missing feature/);
    });
});

// ── Ordinal-ref detection ────────────────────────────────────────────────────
suite('containsOrdinalRef', () => {
    test('bare string with <last> returns the offending ref', () => {
        assert.equal(containsOrdinalRef('<last>'), '<last>');
        assert.equal(containsOrdinalRef('<previous>'), '<previous>');
        assert.equal(containsOrdinalRef('<2-back>'),    '<2-back>');
    });

    test('bare stable feature id returns null', () => {
        assert.equal(containsOrdinalRef('box_x'), null);
        assert.equal(containsOrdinalRef('fillet_a_2'), null);
    });

    test('walks into qFeatureFaces and surfaces ordinal feature ref', () => {
        const q = qFeatureFaces('<last>');
        assert.equal(containsOrdinalRef(q), '<last>');
    });

    test('walks into qOp and surfaces ordinal feature ref', () => {
        const q = qOp('face', '<head>', OP_TAGS.BOX, '+Z');
        assert.equal(containsOrdinalRef(q), '<head>');
    });

    test('walks into nested qFilter / qByDirection', () => {
        const q = qByDirection(qFeatureFaces('<previous>'), '+Z');
        assert.equal(containsOrdinalRef(q), '<previous>');
    });

    test('walks into qUnion sub-queries', () => {
        const q = qUnion(qFeatureFaces('box_x'), qFeatureFaces('<last>'));
        assert.equal(containsOrdinalRef(q), '<last>');
    });

    test('walks into qDescriptor value.feature', () => {
        const q = qDescriptor({ kind: 'face', feature: '<last>', opTag: 'box', part: '+Z', parents: [] });
        assert.equal(containsOrdinalRef(q), '<last>');
    });

    test('clean composite query returns null', () => {
        const q = qNth(qFilter(qFeatureFaces('box_x'), PRED.planar()), 0);
        assert.equal(containsOrdinalRef(q), null);
    });
});

// ── validateStrict ───────────────────────────────────────────────────────────
suite('validateStrict', () => {
    test('rejects query with ordinal ref', () => {
        const q = qFeatureFaces('<last>', { expect: 'all' });
        assert.throws(() => validateStrict(q), /positional\/ordinal/);
    });

    test('rejects top-level query missing expect modifier', () => {
        const q = qFeatureFaces('box_x');  // null expect
        assert.throws(() => validateStrict(q), /missing an `expect`/);
    });

    test('accepts query with explicit expect + stable refs', () => {
        const q = qByDirection(qFeatureFaces('box_x'), '+Z', { expect: 'exactly-one' });
        validateStrict(q);  // no throw
    });

    test('plain validate (loose) still accepts null expect for legacy callers', () => {
        const q = qFeatureFaces('box_x');
        validateQuery(q);  // no throw — legacy contract preserved
    });
});

// ── describeQuery / expect modifier rendering ───────────────────────────────
suite('describeQuery: expect modifier', () => {
    test('renders "exactly-one" prefix on feature-entities', () => {
        const q = qFeatureFaces('box_x', { expect: 'exactly-one' });
        const s = describeQuery(q);
        assert.match(s, /exactly-one/);
        assert.match(s, /box_x/);
    });

    test('renders "all" prefix readably', () => {
        const q = qFeatureFaces('box_x', { expect: 'all' });
        const s = describeQuery(q);
        assert.match(s, /all/);
        assert.match(s, /faces of box_x/);
    });

    test('renders "at-least-one" prefix', () => {
        const q = qFeatureFaces('box_x', { expect: 'at-least-one' });
        assert.match(describeQuery(q), /at-least-one/);
    });

    test('omits prefix when expect is null (legacy)', () => {
        const q = qFeatureFaces('box_x');
        const s = describeQuery(q);
        assert.ok(!/exactly-one|at-least-one|all /.test(s), `unexpected modifier in "${s}"`);
    });

    test('renders qDatum descriptor including resolvedPart', () => {
        const q = qDatum('box_x', 'face-+Z');
        const s = describeQuery(q);
        assert.match(s, /box_x/);
        assert.match(s, /face-\+Z/);
        assert.match(s, /\+Z/);
    });
});

// ── Composition with strict modifier ─────────────────────────────────────────
suite('composition', () => {
    test('qFilter wrapping a multi-result source with expect:exactly-one throws if filter does not narrow', () => {
        const idx = makeIndex();
        const q = qFilter(qFeatureFaces('box_x'), PRED.planar(), { expect: 'exactly-one' });
        assert.throws(() => resolveQuery(q, idx), QueryResolutionError);
    });

    test('qNth(0) + expect:exactly-one resolves cleanly', () => {
        const idx = makeIndex();
        const q = qNth(qFeatureFaces('box_x'), 0, { expect: 'exactly-one' });
        const out = resolveQuery(q, idx);
        assert.equal(out.length, 1);
    });

    test('qSubtract with expect:at-least-one + non-empty remainder resolves', () => {
        const idx = makeIndex();
        const all    = qFeatureFaces('box_x');
        const justPZ = qOp('face', 'box_x', OP_TAGS.BOX, '+Z');
        const q = qSubtract(all, justPZ, { expect: 'at-least-one' });
        const out = resolveQuery(q, idx);
        assert.equal(out.length, 5);
    });

    test('sub-query expect is not enforced — only outermost call', () => {
        const idx = makeIndex();
        // inner query asks exactly-one but the outer filter narrows it later;
        // because only the outer enforces, this resolves without throwing.
        const inner = qFeatureFaces('box_x', { expect: 'exactly-one' });
        const outer = qByDirection(inner, '+Z', { expect: 'exactly-one' });
        const out = resolveQuery(outer, idx);
        assert.equal(out.length, 1);
    });
});

runAll();
