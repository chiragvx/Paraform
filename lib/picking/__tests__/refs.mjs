/**
 * Tests for lib/picking/refs.js — converting picker selection entries to
 * the `{ fingerprint: {...} }` shape the emitter and kernel consume.
 *
 * Run via:  node lib/picking/__tests__/refs.mjs
 */

import assert from 'node:assert/strict';
import {
    entryToEdgeRef, entryToFaceRef, entriesToEdgeRefs, entriesToFaceRefs,
} from '../refs.js';

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

function entry(center, normal, featureId, part) {
    return {
        descriptor: { kind: 'face', feature: featureId, opTag: 'box', part },
        key:        `face:${featureId}:box:${part}`,
        payload:    { center, normal, featureId },
    };
}

// ── entryToEdgeRef / entryToFaceRef ────────────────────────────────────────
suite('entryToRef', () => {
    test('builds a fingerprint with centerRounded + normalRounded from payload', () => {
        const ref = entryToEdgeRef(entry([10, 0, 0], [1, 0, 0], 'box_1', '+X'));
        assert.ok(ref);
        assert.deepEqual(ref.fingerprint.centerRounded, [10, 0, 0]);
        assert.deepEqual(ref.fingerprint.normalRounded, [1, 0, 0]);
        assert.equal(ref.fingerprint.sourceNodeId, 'box_1');
    });

    test('copies the descriptor through so downstream resolution can use it', () => {
        const e = entry([0, 0, 10], [0, 0, 1], 'box_1', '+Z');
        const ref = entryToFaceRef(e);
        assert.equal(ref.descriptor, e.descriptor);
    });

    test('defaults the normal to +Z when payload lacks one', () => {
        const e = { descriptor: { kind: 'face' }, payload: { center: [1, 2, 3], featureId: 'x' } };
        const ref = entryToFaceRef(e);
        assert.deepEqual(ref.fingerprint.normalRounded, [0, 0, 1]);
    });

    test('returns null when payload lacks a center', () => {
        assert.equal(entryToEdgeRef({ descriptor: { kind: 'face' }, payload: { } }), null);
        assert.equal(entryToEdgeRef({ descriptor: { kind: 'face' } }), null);
        assert.equal(entryToEdgeRef(null), null);
    });

    test('falls back to descriptor.feature when payload.featureId is missing', () => {
        const e = {
            descriptor: { kind: 'face', feature: 'cyl_42', opTag: 'cyl', part: '+Z' },
            payload:    { center: [0, 0, 5], normal: [0, 0, 1] },
        };
        const ref = entryToFaceRef(e);
        assert.equal(ref.fingerprint.sourceNodeId, 'cyl_42');
    });

    test('center slice is a copy (mutating it does not affect the source entry)', () => {
        const e = entry([1, 2, 3], [0, 0, 1], 'f', '+Z');
        const ref = entryToEdgeRef(e);
        ref.fingerprint.centerRounded[0] = 99;
        assert.equal(e.payload.center[0], 1);
    });
});

// ── entriesToEdgeRefs / entriesToFaceRefs ──────────────────────────────────
suite('entriesToRefs', () => {
    test('maps every valid entry and drops invalid ones', () => {
        const entries = [
            entry([10, 0, 0], [1, 0, 0], 'box_1', '+X'),
            { descriptor: { kind: 'face' }, payload: { /* no center */ } },   // → dropped
            entry([0, 10, 0], [0, 1, 0], 'box_1', '+Y'),
        ];
        const refs = entriesToEdgeRefs(entries);
        assert.equal(refs.length, 2);
        assert.deepEqual(refs[0].fingerprint.centerRounded, [10, 0, 0]);
        assert.deepEqual(refs[1].fingerprint.centerRounded, [0, 10, 0]);
    });

    test('non-array input returns empty array', () => {
        assert.deepEqual(entriesToEdgeRefs(null), []);
        assert.deepEqual(entriesToFaceRefs(undefined), []);
        assert.deepEqual(entriesToEdgeRefs('not-an-array'), []);
    });

    test('empty input returns empty array', () => {
        assert.deepEqual(entriesToEdgeRefs([]), []);
    });
});

await runAll();
