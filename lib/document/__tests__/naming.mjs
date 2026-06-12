/**
 * Tests for the topological-naming subsystem: descriptor, queries, resolver.
 * Zero-dep — uses Node's `assert/strict`. Run via:
 *   node lib/document/__tests__/naming.mjs
 */

import assert from 'node:assert/strict';
import {
    OP_TAGS,
    descriptor, face, edge, vertex,
    stringify as descriptorString,
    parse as parseDescriptor,
    equals as descriptorEquals,
    hash as descriptorHash,
    descendsFrom, lineageFeatures, rootAncestor,
} from '../descriptor.js';
import {
    qDescriptor, qFeatureFaces, qFeatureEdges,
    qOp, qUnion, qSubtract, qNth, qFilter, qByDirection, qDescendsFrom,
    isQuery, describeQuery,
    validate as validateQuery,
    PRED,
} from '../queries.js';
import { buildIndex, resolve as resolveQuery, resolveKeys as resolveQueryKeys, entriesForFeature } from '../resolver.js';

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

// ── Descriptor format ────────────────────────────────────────────────────────
suite('descriptor', () => {
    test('canonical string for a primitive Box +Z face', () => {
        const d = face('box_x', OP_TAGS.BOX, '+Z');
        assert.equal(descriptorString(d), 'face:box_x:box:+Z');
    });

    test('nested fillet descriptor wraps the parent edge descriptor', () => {
        const parentEdge = edge('box_x', OP_TAGS.BOX, '+X+Z');
        const filletFace = face('fill_a', OP_TAGS.FILLET, 'blend', [parentEdge]);
        assert.equal(
            descriptorString(filletFace),
            'face:fill_a:fillet:blend(edge:box_x:box:+X+Z)',
        );
    });

    test('parse/stringify round-trip for nested descriptors', () => {
        const d1 = face('fill_a', OP_TAGS.FILLET, 'blend', [
            edge('box_x', OP_TAGS.BOX, '+X+Z'),
            edge('box_x', OP_TAGS.BOX, '-Y+Z'),
        ]);
        const s = descriptorString(d1);
        const d2 = parseDescriptor(s);
        assert.equal(descriptorString(d2), s);
        assert.equal(descriptorEquals(d1, d2), true);
    });

    test('parse rejects malformed input', () => {
        assert.throws(() => parseDescriptor(''),                  /empty/);
        assert.throws(() => parseDescriptor('face:no-colons'),    /expected kind:feature:op:part/);
        assert.throws(() => parseDescriptor('face:a:b:c('),       /missing closing/);
    });

    test('hash is stable + cheap (8 hex chars)', () => {
        const d = face('box_x', OP_TAGS.BOX, '+Z');
        const h = descriptorHash(d);
        assert.equal(h.length, 8);
        assert.equal(descriptorHash(d), h);
        // Different descriptors hash differently
        assert.notEqual(descriptorHash(face('box_y', OP_TAGS.BOX, '+Z')), h);
    });

    test('descendsFrom walks the parent chain', () => {
        const root = edge('box_x', OP_TAGS.BOX, '+X+Z');
        const f1   = face('fill_a', OP_TAGS.FILLET, 'blend', [root]);
        const f2   = face('chmf_a', OP_TAGS.CHAMFER, 'bevel', [f1]);
        assert.equal(descendsFrom(f2, root),    true);
        assert.equal(descendsFrom(f2, f1),      true);
        assert.equal(descendsFrom(f1, f2),      false);
        const stranger = face('xyz', OP_TAGS.BOX, '-Z');
        assert.equal(descendsFrom(f2, stranger), false);
    });

    test('rootAncestor returns the deepest ancestor', () => {
        const root = edge('box_x', OP_TAGS.BOX, '+X+Z');
        const f1   = face('fill_a', OP_TAGS.FILLET, 'blend', [root]);
        const f2   = face('chmf_a', OP_TAGS.CHAMFER, 'bevel', [f1]);
        assert.equal(descriptorEquals(rootAncestor(f2), root), true);
    });

    test('lineageFeatures collects every contributing feature id', () => {
        const root = edge('box_x', OP_TAGS.BOX, '+X+Z');
        const f    = face('fill_a', OP_TAGS.FILLET, 'blend', [root]);
        const ids  = lineageFeatures(f);
        assert.deepEqual([...ids].sort(), ['box_x', 'fill_a']);
    });

    test('descriptor() rejects bad kind / missing fields', () => {
        assert.throws(() => descriptor('plane', 'a', 'b', 'c'), /bad kind/);
        assert.throws(() => descriptor('face', '',     'b', 'c'), /missing feature/);
        assert.throws(() => descriptor('face', 'a',    '',  'c'), /missing opTag/);
        assert.throws(() => descriptor('face', 'a',    'b', null), /missing part/);
    });
});

// ── Query DSL ────────────────────────────────────────────────────────────────
suite('queries', () => {
    test('qUnion flattens nested unions', () => {
        const q = qUnion(qFeatureFaces('a'), qUnion(qFeatureFaces('b'), qFeatureFaces('c')));
        assert.equal(q.queries.length, 3);
    });

    test('qUnion enforces matching kind', () => {
        assert.throws(() => qUnion(qFeatureFaces('a'), qFeatureEdges('b')), /kind mismatch/);
    });

    test('isQuery type guard', () => {
        assert.equal(isQuery(qFeatureFaces('a')), true);
        assert.equal(isQuery({ wat: 1 }),         false);
        assert.equal(isQuery(null),               false);
    });

    test('describeQuery renders a readable summary', () => {
        const q = qNth(qFilter(qFeatureFaces('a'), PRED.planar()), 0);
        const s = describeQuery(q);
        assert.match(s, /faces\(a\)/);
        assert.match(s, /\|planar/);
        assert.match(s, /\[0\]/);
    });

    test('validateQuery throws on kind mismatch nested inside subtract', () => {
        const base    = qFeatureFaces('a');
        const exclude = qFeatureFaces('b');
        const ok      = qSubtract(base, exclude);
        validateQuery(ok);  // no throw
        // Manually corrupt kind to ensure validate catches it
        const bad = { ...ok, exclude: { ...ok.exclude, kind: 'edge' } };
        assert.throws(() => validateQuery(bad));
    });

    test('PRED helpers produce JSON-serialisable specs', () => {
        const p = PRED.and(PRED.planar(), PRED.not(PRED.opTag('cut')));
        const json = JSON.parse(JSON.stringify(p));
        assert.deepEqual(json, p);
    });
});

// ── Resolver ─────────────────────────────────────────────────────────────────

/**
 * Build a synthetic topology JSON representing a Box `box_x` with 6 faces
 * (±X, ±Y, ±Z), each tagged correctly. Used as the kernel-emitted payload.
 */
function synthBoxTopology(featureId, opTag = OP_TAGS.BOX) {
    const F = (part, normal) => ({
        descriptor: face(featureId, opTag, part),
        normalRounded: normal,
        surfaceType: 'planar',
        area: 100,
    });
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
        edges: [],
        vertices: [],
    };
}

function synthCylTopology(featureId) {
    return {
        featureId,
        faces: [
            { descriptor: face(featureId, OP_TAGS.CYL, 'top'),    normalRounded: [0, 0, +1], surfaceType: 'planar' },
            { descriptor: face(featureId, OP_TAGS.CYL, 'bottom'), normalRounded: [0, 0, -1], surfaceType: 'planar' },
            { descriptor: face(featureId, OP_TAGS.CYL, 'lateral'),                                surfaceType: 'cylindrical' },
        ],
        edges: [
            { descriptor: edge(featureId, OP_TAGS.CYL, 'top-ring'),    closed: true },
            { descriptor: edge(featureId, OP_TAGS.CYL, 'bottom-ring'), closed: true },
        ],
        vertices: [],
    };
}

suite('resolver', () => {
    function makeIndex() {
        return buildIndex({
            nodes: [
                synthBoxTopology('box_x'),
                synthCylTopology('cyl_y'),
            ],
        });
    }

    test('qFeatureFaces returns 6 faces for the Box', () => {
        const idx = makeIndex();
        const out = resolveQuery(qFeatureFaces('box_x'), idx);
        assert.equal(out.length, 6);
    });

    test('qFeatureFaces returns 3 faces for the Cylinder', () => {
        const idx = makeIndex();
        const out = resolveQuery(qFeatureFaces('cyl_y'), idx);
        assert.equal(out.length, 3);
    });

    test('qOp narrows by opTag', () => {
        const idx = makeIndex();
        const out = resolveQuery(qOp('face', 'box_x', OP_TAGS.BOX, '+Z'), idx);
        assert.equal(out.length, 1);
        assert.equal(out[0].descriptor.part, '+Z');
    });

    test('qByDirection narrows Box faces to +Z', () => {
        const idx = makeIndex();
        const all = qFeatureFaces('box_x');
        const out = resolveQuery(qByDirection(all, '+Z'), idx);
        assert.equal(out.length, 1);
        assert.equal(out[0].descriptor.part, '+Z');
    });

    test('qFilter(PRED.planar) excludes the cylinder lateral face', () => {
        const idx = makeIndex();
        const out = resolveQuery(qFilter(qFeatureFaces('cyl_y'), PRED.planar()), idx);
        assert.equal(out.length, 2);
        assert.ok(out.every(e => e.surfaceType === 'planar'));
    });

    test('qFilter(PRED.cylindrical) selects only the lateral face', () => {
        const idx = makeIndex();
        const out = resolveQuery(qFilter(qFeatureFaces('cyl_y'), PRED.cylindrical()), idx);
        assert.equal(out.length, 1);
        assert.equal(out[0].descriptor.part, 'lateral');
    });

    test('qUnion combines two feature face sets without duplicates', () => {
        const idx = makeIndex();
        const out = resolveQuery(
            qUnion(qFeatureFaces('box_x'), qFeatureFaces('cyl_y')),
            idx,
        );
        assert.equal(out.length, 9);
        const keys = new Set(out.map(e => e.descriptor.feature + ':' + e.descriptor.part));
        assert.equal(keys.size, 9);
    });

    test('qSubtract removes excluded faces', () => {
        const idx = makeIndex();
        const all     = qFeatureFaces('box_x');
        const justPZ  = qOp('face', 'box_x', OP_TAGS.BOX, '+Z');
        const out = resolveQuery(qSubtract(all, justPZ), idx);
        assert.equal(out.length, 5);
        assert.ok(out.every(e => e.descriptor.part !== '+Z'));
    });

    test('qNth picks deterministic 0-th element by canonical sort', () => {
        const idx = makeIndex();
        const out = resolveQuery(qNth(qFeatureFaces('box_x'), 0), idx);
        assert.equal(out.length, 1);
        // Canonical strings sort alphabetically; '+X' < '+Y' < '+Z' < '-X' < '-Y' < '-Z'
        assert.equal(out[0].descriptor.part, '+X');
    });

    test('qNth with negative index counts from end', () => {
        const idx = makeIndex();
        const out = resolveQuery(qNth(qFeatureFaces('box_x'), -1), idx);
        assert.equal(out.length, 1);
        assert.equal(out[0].descriptor.part, '-Z');
    });

    test('qNth out-of-range returns empty', () => {
        const idx = makeIndex();
        const out = resolveQuery(qNth(qFeatureFaces('box_x'), 99), idx);
        assert.deepEqual(out, []);
    });

    test('qNth reverse:true flips order before indexing', () => {
        const idx = makeIndex();
        const out = resolveQuery(qNth(qFeatureFaces('box_x'), 0, { reverse: true }), idx);
        assert.equal(out[0].descriptor.part, '-Z');
    });

    test('qDescriptor exact-matches a single descriptor', () => {
        const idx = makeIndex();
        const target = face('box_x', OP_TAGS.BOX, '+Z');
        const out = resolveQuery(qDescriptor(target), idx);
        assert.equal(out.length, 1);
        assert.equal(out[0].descriptor.part, '+Z');
    });

    test('qDescendsFrom finds derived faces', () => {
        // Build a synthetic Fillet face whose parent is box_x's +X+Z edge.
        const parentEdge = edge('box_x', OP_TAGS.BOX, '+X+Z');
        const filletFace = face('fill_a', OP_TAGS.FILLET, 'blend', [parentEdge]);
        const idx = buildIndex({
            nodes: [
                synthBoxTopology('box_x'),
                { featureId: 'fill_a', faces: [{ descriptor: filletFace, surfaceType: 'cylindrical' }], edges: [], vertices: [] },
            ],
        });
        const all = qFeatureFaces('fill_a');
        const out = resolveQuery(qDescendsFrom(all, parentEdge), idx);
        assert.equal(out.length, 1);
        assert.equal(out[0].descriptor.opTag, OP_TAGS.FILLET);
    });

    test('PRED.opTag filters by descriptor opTag', () => {
        const idx = makeIndex();
        const cyl = qFeatureFaces('cyl_y');
        const out = resolveQuery(qFilter(cyl, PRED.opTag(OP_TAGS.CYL)), idx);
        assert.equal(out.length, 3);
    });

    test('PRED.partMatches uses regex', () => {
        const idx = makeIndex();
        const out = resolveQuery(qFilter(qFeatureFaces('box_x'), PRED.partMatches('^\\+')), idx);
        assert.equal(out.length, 3);  // +X, +Y, +Z
    });

    test('resolveKeys yields canonical strings only', () => {
        const idx = makeIndex();
        const keys = resolveQueryKeys(qOp('face', 'box_x', OP_TAGS.BOX, '+Z'), idx);
        assert.deepEqual(keys, ['face:box_x:box:+Z']);
    });

    test('determinism — repeated resolve returns the same ordering', () => {
        const idx = makeIndex();
        const a = resolveQuery(qFeatureFaces('box_x'), idx).map(e => e.descriptor.part);
        const b = resolveQuery(qFeatureFaces('box_x'), idx).map(e => e.descriptor.part);
        assert.deepEqual(a, b);
    });

    test('robustness — kernel emits faces in different order on rebuild, results stable', () => {
        const original = synthBoxTopology('box_x');
        const shuffled = { ...original, faces: original.faces.slice().reverse() };
        const idx1 = buildIndex({ nodes: [original] });
        const idx2 = buildIndex({ nodes: [shuffled] });
        const a = resolveQuery(qOp('face', 'box_x', OP_TAGS.BOX, '+Z'), idx1);
        const b = resolveQuery(qOp('face', 'box_x', OP_TAGS.BOX, '+Z'), idx2);
        assert.equal(a.length, 1);
        assert.equal(b.length, 1);
        assert.equal(a[0].descriptor.part, b[0].descriptor.part);
    });

    test('entriesForFeature handles missing features gracefully', () => {
        const idx = makeIndex();
        assert.deepEqual(entriesForFeature(idx, 'nonexistent', 'face'), []);
    });
});

runAll();
