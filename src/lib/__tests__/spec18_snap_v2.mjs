/**
 * Spec 18 v2 — assembly snap layer.
 *
 * Run via:
 *   node --import ./src/lib/commands/__tests__/_register.mjs \
 *        src/lib/__tests__/spec18_snap_v2.mjs
 *
 * Covers the four pieces added in v2:
 *   1. mate_solver `connectorsCompatible` accepts derived connectors
 *      (empty mates_with → match-by-kind fallback).
 *   2. `connectorsCompatible` size wildcard ('auto'/'unspecified' matches any).
 *   3. `componentWorldMatrix` composes parent chain translations + rotations.
 *   4. `worldConnectorFor` returns world-frame {origin, axis} when the
 *      owning component is at non-identity origin.
 *   5. `setComponentOrigin` op writes through to doc.components[id].origin.
 *   6. `setComponentOrigin` refuses on 'root' and missing components.
 *   7. End-to-end: place a part, move its component via setComponentOrigin,
 *      and confirm worldConnectorFor reflects the new pose.
 */

import assert from 'node:assert/strict';

import {
    resetDocumentStore, getDocumentStore,
    addComponent, addConnector,
    setComponentOrigin,
    makeConnector,
} from '../../../lib/document/index.js';

import {
    connectorsCompatible,
    solveMateTransform,
    componentWorldMatrix,
    worldConnectorFor,
} from '../library/mate_solver.js';

let _pass = 0, _fail = 0;
function t(name, fn) {
    try {
        const r = fn();
        if (r && typeof r.then === 'function') {
            return r.then(() => { console.log(`  ok  ${name}`); _pass++; })
                    .catch((e) => { console.error(`  FAIL ${name}\n    ${e?.stack || e?.message || e}`); _fail++; });
        }
        console.log(`  ok  ${name}`);
        _pass++;
    } catch (e) {
        console.error(`  FAIL ${name}\n    ${e?.stack || e?.message || e}`);
        _fail++;
    }
}

function approxEq(a, b, eps = 1e-5) { return Math.abs(a - b) <= eps; }
function approxVec(a, b, eps = 1e-4) {
    return approxEq(a[0], b[0], eps) && approxEq(a[1], b[1], eps) && approxEq(a[2], b[2], eps);
}

console.log('── spec 18 v2 — assembly snap ──');

// 1. Derived-connector compatibility (empty mates_with → match by kind) ─────
t('compatibility: empty mates_with falls back to kind match', () => {
    // Both connectors are "derived" (no explicit mates_with list).
    const a = makeConnector({ kind: 'planar', gender: 'neutral', mates_with: [] });
    const b = makeConnector({ kind: 'planar', gender: 'neutral', mates_with: [] });
    assert.equal(connectorsCompatible(a, b), true);
});

t('compatibility: empty mates_with rejects when kinds differ', () => {
    const a = makeConnector({ kind: 'planar', gender: 'neutral', mates_with: [] });
    const b = makeConnector({ kind: 'rail',   gender: 'neutral', mates_with: [] });
    assert.equal(connectorsCompatible(a, b), false);
});

t('compatibility: explicit mates_with still rules when set', () => {
    // a accepts only bore; both planar but explicit list overrides kind-match.
    const a = makeConnector({ kind: 'planar', mates_with: ['bore'] });
    const b = makeConnector({ kind: 'planar', mates_with: ['planar'] });
    assert.equal(connectorsCompatible(a, b), false);
});

// 2. Size wildcards ─────────────────────────────────────────────────────────
t('compatibility: auto size matches a real nominal', () => {
    const a = makeConnector({ kind: 'shaft',  gender: 'male',
        size: { nominal: 'auto', unit: 'mm' }, mates_with: ['bore'] });
    const b = makeConnector({ kind: 'bore',   gender: 'female',
        size: { nominal: 5, unit: 'mm' }, mates_with: ['shaft'] });
    assert.equal(connectorsCompatible(a, b), true);
});

t('compatibility: unspecified size matches anything', () => {
    const a = makeConnector({ kind: 'planar', gender: 'neutral',
        size: { nominal: 'unspecified', unit: 'mm' }, mates_with: ['planar'] });
    const b = makeConnector({ kind: 'planar', gender: 'neutral',
        size: { nominal: 20, unit: 'mm' }, mates_with: ['planar'] });
    assert.equal(connectorsCompatible(a, b), true);
});

t('compatibility: distinct numeric sizes outside tolerance reject', () => {
    const a = makeConnector({ kind: 'bore', gender: 'female',
        size: { nominal: 3.0, unit: 'mm' }, mates_with: ['shaft'] });
    const b = makeConnector({ kind: 'shaft', gender: 'male',
        size: { nominal: 8.0, unit: 'mm' }, mates_with: ['bore'] });
    assert.equal(connectorsCompatible(a, b), false);
});

// 3. componentWorldMatrix ───────────────────────────────────────────────────
t('componentWorldMatrix: identity for root', () => {
    resetDocumentStore();
    const M = componentWorldMatrix(getDocumentStore().doc, 'root');
    assert.deepEqual(M, [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
});

t('componentWorldMatrix: applies translation', () => {
    resetDocumentStore();
    addComponent({ name: 'A', parentId: 'root', componentId: 'A',
        origin: { position: [10, 20, 30], rotation: [0, 0, 0], scale: [1,1,1] } });
    const M = componentWorldMatrix(getDocumentStore().doc, 'A');
    // Translation lives in the last column.
    assert.ok(approxEq(M[3],  10));
    assert.ok(approxEq(M[7],  20));
    assert.ok(approxEq(M[11], 30));
});

t('componentWorldMatrix: composes nested translations', () => {
    resetDocumentStore();
    addComponent({ name: 'A', parentId: 'root', componentId: 'A',
        origin: { position: [10, 0, 0], rotation: [0, 0, 0], scale: [1,1,1] } });
    addComponent({ name: 'B', parentId: 'A', componentId: 'B',
        origin: { position: [0, 20, 0], rotation: [0, 0, 0], scale: [1,1,1] } });
    const M = componentWorldMatrix(getDocumentStore().doc, 'B');
    assert.ok(approxEq(M[3],  10));   // parent x
    assert.ok(approxEq(M[7],  20));   // own y
});

// 4. worldConnectorFor ──────────────────────────────────────────────────────
t('worldConnectorFor: translates origin by parent component', () => {
    resetDocumentStore();
    addComponent({ name: 'A', parentId: 'root', componentId: 'A',
        origin: { position: [100, 0, 0], rotation: [0, 0, 0], scale: [1,1,1] } });
    const c = addConnector({ parent: 'A', kind: 'planar', gender: 'neutral',
        axis: [0, 0, 1], origin: [5, 0, 0] });
    const world = worldConnectorFor(getDocumentStore().doc, c);
    assert.ok(approxVec(world.origin, [105, 0, 0]));
    assert.ok(approxVec(world.axis,   [0, 0, 1]));
});

t('worldConnectorFor: rotates axis by parent component', () => {
    resetDocumentStore();
    // 90° about world Z: local +X → world +Y.
    addComponent({ name: 'A', parentId: 'root', componentId: 'A',
        origin: { position: [0, 0, 0], rotation: [0, 0, Math.PI / 2], scale: [1,1,1] } });
    const c = addConnector({ parent: 'A', kind: 'planar',
        axis: [1, 0, 0], origin: [0, 0, 0] });
    const world = worldConnectorFor(getDocumentStore().doc, c);
    assert.ok(approxVec(world.axis, [0, 1, 0]),
        `expected [0,1,0], got [${world.axis.join(',')}]`);
});

// 5–6. setComponentOrigin op ────────────────────────────────────────────────
t('setComponentOrigin: writes through to doc.components', () => {
    resetDocumentStore();
    addComponent({ name: 'A', parentId: 'root', componentId: 'A' });
    const ok = setComponentOrigin('A', { position: [7, 8, 9] });
    assert.equal(ok, true);
    const comp = getDocumentStore().doc.components.A;
    assert.deepEqual(comp.origin.position, [7, 8, 9]);
    assert.deepEqual(comp.origin.rotation, [0, 0, 0]);
    assert.deepEqual(comp.origin.scale,    [1, 1, 1]);
});

t('setComponentOrigin: refuses root', () => {
    resetDocumentStore();
    const ok = setComponentOrigin('root', { position: [1, 2, 3] });
    assert.equal(ok, false);
});

t('setComponentOrigin: refuses missing component', () => {
    resetDocumentStore();
    const ok = setComponentOrigin('bogus', { position: [1, 2, 3] });
    assert.equal(ok, false);
});

t('setComponentOrigin: preserves untouched fields', () => {
    resetDocumentStore();
    addComponent({ name: 'A', parentId: 'root', componentId: 'A',
        origin: { position: [1,2,3], rotation: [0.1,0.2,0.3], scale: [1,1,1] } });
    setComponentOrigin('A', { position: [9, 9, 9] });
    const c = getDocumentStore().doc.components.A;
    assert.deepEqual(c.origin.position, [9, 9, 9]);
    // rotation untouched
    assert.ok(approxEq(c.origin.rotation[0], 0.1));
    assert.ok(approxEq(c.origin.rotation[1], 0.2));
    assert.ok(approxEq(c.origin.rotation[2], 0.3));
});

// 7. End-to-end: move a component, worldConnectorFor follows ───────────────
t('end-to-end: setComponentOrigin shifts connector world frame', () => {
    resetDocumentStore();
    addComponent({ name: 'A', parentId: 'root', componentId: 'A' });
    const c = addConnector({ parent: 'A', kind: 'planar',
        axis: [0, 0, 1], origin: [0, 0, 0] });
    // Initially at origin.
    const before = worldConnectorFor(getDocumentStore().doc, c);
    assert.ok(approxVec(before.origin, [0, 0, 0]));
    // Move the parent component +50 mm in X.
    setComponentOrigin('A', { position: [50, 0, 0] });
    const after = worldConnectorFor(getDocumentStore().doc, c);
    assert.ok(approxVec(after.origin, [50, 0, 0]));
});

// 8. Solve smoke: derived planar against derived planar ────────────────────
t('solve: derived planar mate yields anti-parallel axes + coincident origin', () => {
    const host = { kind: 'planar', axis: [0, 0, 1], origin: [10, 20, 30] };
    const part = makeConnector({ kind: 'planar', gender: 'neutral',
        axis: [0, 0, 1], origin: [0, 0, 0], mates_with: [] });
    const solved = solveMateTransform(host, part);
    // Part translates to host origin.
    assert.ok(approxVec(solved.position, [10, 20, 30]));
});

// ── Report ─────────────────────────────────────────────────────────────────
console.log(`\n${_pass} pass, ${_fail} fail`);
if (_fail > 0) process.exit(1);
