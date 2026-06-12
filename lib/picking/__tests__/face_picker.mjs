/**
 * Tests for lib/picking/face_picker.js — the pure-math `pickNearestFace`
 * layer is the critical surface; the Three.js wrapper is exercised with
 * tiny shims.
 *
 * Run via:  node lib/picking/__tests__/face_picker.mjs
 */

import assert from 'node:assert/strict';
import { pickNearestFace, pickFaceFromCursor } from '../face_picker.js';

const _tests = [];
let _suite = '';
function suite(name, fn) { _suite = name; fn(); _suite = ''; }
function test(name, fn) { _tests.push({ suite: _suite, name, fn }); }
async function runAll() {
    let pass = 0, fail = 0;
    for (const t of _tests) {
        try { await t.fn(); pass++; console.log(`  \x1b[32m✓\x1b[0m ${t.suite ? t.suite + ' › ' : ''}${t.name}`); }
        catch (e) { fail++; console.log(`  \x1b[31m✗\x1b[0m ${t.suite ? t.suite + ' › ' : ''}${t.name}`); console.log(`    ${e.message}`); }
    }
    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail > 0) process.exit(1);
}

// Topology fixture mirroring the v4 emitter's _extract_topology_v4 output
// for a 20×20×20 box centred at the origin.
const boxTopology = {
    nodes: [
        {
            featureId: 'box_1',
            faces: [
                { descriptor: { kind: 'face', feature: 'box_1', opTag: 'box', part: '+X' },     centerRounded: [ 10,   0,   0], normalRounded: [ 1,  0,  0] },
                { descriptor: { kind: 'face', feature: 'box_1', opTag: 'box', part: '-X' },     centerRounded: [-10,   0,   0], normalRounded: [-1,  0,  0] },
                { descriptor: { kind: 'face', feature: 'box_1', opTag: 'box', part: '+Y' },     centerRounded: [  0,  10,   0], normalRounded: [ 0,  1,  0] },
                { descriptor: { kind: 'face', feature: 'box_1', opTag: 'box', part: '-Y' },     centerRounded: [  0, -10,   0], normalRounded: [ 0, -1,  0] },
                { descriptor: { kind: 'face', feature: 'box_1', opTag: 'box', part: '+Z' },     centerRounded: [  0,   0,  10], normalRounded: [ 0,  0,  1] },
                { descriptor: { kind: 'face', feature: 'box_1', opTag: 'box', part: '-Z' },     centerRounded: [  0,   0, -10], normalRounded: [ 0,  0, -1] },
            ],
            edges: [],
        },
    ],
};

// ── pickNearestFace ─────────────────────────────────────────────────────────
suite('pickNearestFace › box faces', () => {
    test('click on +Z face returns the +Z descriptor', () => {
        const result = pickNearestFace([0, 0, 10], [0, 0, 1], boxTopology);
        assert.ok(result);
        assert.equal(result.descriptor.part, '+Z');
    });

    test('click on -X face returns the -X descriptor', () => {
        const result = pickNearestFace([-10, 0, 0], [-1, 0, 0], boxTopology);
        assert.equal(result.descriptor.part, '-X');
    });

    test('click slightly off-centre on a face still hits the right face', () => {
        const result = pickNearestFace([3, 4, 10], [0, 0, 1], boxTopology);
        assert.equal(result.descriptor.part, '+Z');
    });

    test('normal hint disambiguates two faces at equal distance', () => {
        // A point on the edge between +X and +Z faces is equidistant from
        // both centres. The normal hint should pick whichever the click came
        // from.
        const fromTop  = pickNearestFace([10, 0, 10], [0, 0, 1],  boxTopology);
        const fromSide = pickNearestFace([10, 0, 10], [1, 0, 0],  boxTopology);
        assert.equal(fromTop.descriptor.part,  '+Z');
        assert.equal(fromSide.descriptor.part, '+X');
    });

    test('back-facing normal still resolves to a face (worst-case fallback)', () => {
        // Click with anti-aligned normal — should still pick *something*
        // rather than null.
        const result = pickNearestFace([0, 0, 10], [0, 0, -1], boxTopology);
        assert.ok(result);
        assert.ok(result.descriptor);
    });

    test('returns null on empty topology', () => {
        assert.equal(pickNearestFace([0, 0, 0], [0, 0, 1], { nodes: [] }), null);
        assert.equal(pickNearestFace([0, 0, 0], [0, 0, 1], null), null);
    });

    test('respects maxDistance cutoff', () => {
        const result = pickNearestFace([1000, 1000, 1000], [0, 0, 1], boxTopology, { maxDistance: 50 });
        assert.equal(result, null);
    });
});

// ── pickNearestFace › multi-body topology ──────────────────────────────────
suite('pickNearestFace › multi-body', () => {
    const twoBoxes = {
        nodes: [
            {
                featureId: 'a',
                faces: [
                    { descriptor: { kind: 'face', feature: 'a', opTag: 'box', part: '+Z' }, centerRounded: [0, 0,   5], normalRounded: [0, 0, 1] },
                ],
                edges: [],
            },
            {
                featureId: 'b',
                faces: [
                    { descriptor: { kind: 'face', feature: 'b', opTag: 'box', part: '+Z' }, centerRounded: [0, 0, 100], normalRounded: [0, 0, 1] },
                ],
                edges: [],
            },
        ],
    };
    test('click near body A picks the face on body A', () => {
        const r = pickNearestFace([0, 0, 5], [0, 0, 1], twoBoxes);
        assert.equal(r.featureId, 'a');
    });
    test('click near body B picks the face on body B', () => {
        const r = pickNearestFace([0, 0, 100], [0, 0, 1], twoBoxes);
        assert.equal(r.featureId, 'b');
    });
});

// ── pickFaceFromCursor (Three.js wrapper) ───────────────────────────────────
suite('pickFaceFromCursor › raycaster wrapper', () => {
    /** Minimal mock matching the bits the wrapper touches. */
    function makeStubs(hitPoint, faceNormal) {
        const calls = [];
        const camera = { isCamera: true };
        const identityMatrix = { elements: [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1] };
        const bodyGroup    = { matrixWorld: identityMatrix };
        const sourceObject = { matrixWorld: identityMatrix };
        const raycaster = {
            setFromCamera(ndc, cam) { calls.push({ ndc, cam }); },
            intersectObject() {
                return hitPoint ? [{
                    point: { x: hitPoint[0], y: hitPoint[1], z: hitPoint[2] },
                    face:  faceNormal ? { normal: { x: faceNormal[0], y: faceNormal[1], z: faceNormal[2] } } : null,
                    object: sourceObject,
                }] : [];
            },
        };
        return { camera, raycaster, bodyGroup, calls };
    }

    test('returns null when the ray misses every mesh', () => {
        const { camera, raycaster, bodyGroup } = makeStubs(null, null);
        const r = pickFaceFromCursor({ camera, raycaster, ndc: { x: 0, y: 0 }, bodyGroup, topology: boxTopology });
        assert.equal(r, null);
    });

    test('hit on the +Z top of a box resolves to the +Z face descriptor', () => {
        const { camera, raycaster, bodyGroup } = makeStubs([0, 0, 10], [0, 0, 1]);
        const r = pickFaceFromCursor({ camera, raycaster, ndc: { x: 0, y: 0 }, bodyGroup, topology: boxTopology });
        assert.ok(r);
        assert.equal(r.descriptor.part, '+Z');
    });

    test('forwards the NDC values to raycaster.setFromCamera', () => {
        const { camera, raycaster, bodyGroup, calls } = makeStubs([0, 0, 10], [0, 0, 1]);
        pickFaceFromCursor({ camera, raycaster, ndc: { x: 0.5, y: -0.3 }, bodyGroup, topology: boxTopology });
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0].ndc, { x: 0.5, y: -0.3 });
        assert.equal(calls[0].cam, camera);
    });

    test('returns null when any required argument is missing', () => {
        const { camera, raycaster, bodyGroup } = makeStubs([0, 0, 10], [0, 0, 1]);
        assert.equal(pickFaceFromCursor({ camera: null, raycaster, ndc: { x: 0, y: 0 }, bodyGroup, topology: boxTopology }), null);
        assert.equal(pickFaceFromCursor({ camera, raycaster: null, ndc: { x: 0, y: 0 }, bodyGroup, topology: boxTopology }), null);
        assert.equal(pickFaceFromCursor({ camera, raycaster, ndc: { x: 0, y: 0 }, bodyGroup: null, topology: boxTopology }), null);
        assert.equal(pickFaceFromCursor({ camera, raycaster, ndc: { x: 0, y: 0 }, bodyGroup, topology: null }), null);
    });
});

await runAll();
