/**
 * Phase 6 — articulation + DOF tests.
 *
 * Pure-solver math on the document (no kernel, no three.js, no browser).
 *
 * Run via:
 *   node --import ./src/lib/commands/__tests__/_register.mjs \
 *        src/lib/kinematics/__tests__/articulation.mjs
 *
 * Covers:
 *   1. clampJointValue reports clamped flag (revolute deg / prismatic mm / fixed).
 *   2. driveJoint rotates a single link's world origin as expected.
 *   3. driveJoint on a parent joint moves the whole downstream chain (tip).
 *   4. driveJoint clamps to limits.
 *   5. computeDof: per-component + whole-assembly + over-constrained loop.
 *   6. movableJoints excludes fixed, orders parents before tips.
 */
import assert from 'node:assert/strict';
import {
    resetDocumentStore,
    getDocumentStore,
    addComponent,
    addJoint,
    updateJoint,
    setComponentOrigin,
} from '../../../../lib/document/index.js';
import {
    clampJointValue,
    driveJoint,
    computeDof,
    movableJoints,
    jointMotionAboutFrame,
    mat4ToOrigin,
    _clearRestBaselines,
} from '$lib/kinematics/limits.js';
import { solveForwardKinematics, mat4ApplyPoint, componentOriginToMat4 } from '$lib/kinematics/solver.js';

let _pass = 0, _fail = 0;
async function t(name, fn) {
    try {
        await fn();
        console.log(`  ok  ${name}`);
        _pass++;
    } catch (e) {
        console.error(`  FAIL ${name}\n    ${e?.stack || e?.message || e}`);
        _fail++;
    }
}
function approxEq(a, b, eps = 1e-6) { return Math.abs(a - b) <= eps; }
function approxPoint(p, q, eps = 1e-5) {
    return approxEq(p[0], q[0], eps) && approxEq(p[1], q[1], eps) && approxEq(p[2], q[2], eps);
}

// Local deps so driveJoint routes through the live ops layer.
const deps = { getStore: getDocumentStore, updateJoint, setComponentOrigin };

// World position of a component's local origin, read straight from its
// (possibly driven) component.origin chain. We compose parent origins so the
// assertion reflects exactly what the scene graph renders.
function worldOrigin(doc, cid) {
    let m = componentOriginToMat4(doc.components[cid].origin);
    let cur = doc.components[cid].parentId;
    while (cur && cur !== 'root' && doc.components[cur]) {
        const pm = componentOriginToMat4(doc.components[cur].origin);
        // parent · child
        m = mul(pm, m);
        cur = doc.components[cur].parentId;
    }
    return mat4ApplyPoint(m, [0, 0, 0]);
}
function mul(a, b) {
    const out = new Float64Array(16);
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
        let s = 0; for (let k = 0; k < 4; k++) s += a[r * 4 + k] * b[k * 4 + c];
        out[r * 4 + c] = s;
    }
    return out;
}

console.log('── Phase 6 — articulation + DOF ──');

await t('clampJointValue: revolute reports clamped flag + bounds', () => {
    const j = { kind: 'revolute', limits: { min: -90, max: 90 } };
    assert.deepEqual(clampJointValue(j, 45), { value: 45, clamped: false, min: -90, max: 90 });
    assert.deepEqual(clampJointValue(j, 200), { value: 90, clamped: true, min: -90, max: 90 });
    assert.deepEqual(clampJointValue(j, -200), { value: -90, clamped: true, min: -90, max: 90 });
});

await t('clampJointValue: prismatic clamps in mm', () => {
    const j = { kind: 'prismatic', limits: { min: 0, max: 50 } };
    assert.equal(clampJointValue(j, 25).value, 25);
    assert.equal(clampJointValue(j, 75).value, 50);
    assert.equal(clampJointValue(j, 75).clamped, true);
});

await t('clampJointValue: fixed joint pins to 0', () => {
    const j = { kind: 'fixed', limits: { min: 0, max: 0 } };
    assert.equal(clampJointValue(j, 30).value, 0);
    assert.equal(clampJointValue(j, 30).clamped, true);
});

await t('jointMotionAboutFrame: identity at value 0', () => {
    const M = jointMotionAboutFrame({ kind: 'revolute', origin: [5, 0, 0], axis: [0, 0, 1] }, 0);
    const o = mat4ToOrigin(M);
    assert.ok(approxPoint(o.position, [0, 0, 0]));
    assert.ok(approxPoint(o.rotation, [0, 0, 0]));
});

await t('driveJoint: revolute 90° about Z rotates a single link origin', async () => {
    resetDocumentStore();
    _clearRestBaselines();
    addComponent({ name: 'link1', parentId: 'root', componentId: 'link1' });
    setComponentOrigin('link1', { position: [10, 0, 0] });   // rest 10 mm out on +X
    const j = addJoint({ kind: 'revolute', parent: 'root', child: 'link1',
        origin: [0, 0, 0], axis: [0, 0, 1], limits: { min: -180, max: 180 } });
    const r = await driveJoint(j.id, 90, deps);
    assert.equal(r.ok, true);
    assert.equal(r.clamped, false);
    const doc = getDocumentStore().doc;
    // drive persisted on the joint
    assert.equal(doc.joints[j.id].drive.value, 90);
    // world origin rotated (10,0,0) → (0,10,0)
    assert.ok(approxPoint(worldOrigin(doc, 'link1'), [0, 10, 0]), `got ${worldOrigin(doc, 'link1')}`);
});

await t('driveJoint: driving the BASE joint moves the whole downstream chain (tip)', async () => {
    resetDocumentStore();
    _clearRestBaselines();
    // root → base → tip. base is 10 mm out, tip is another 10 mm out along +X.
    addComponent({ name: 'base', parentId: 'root', componentId: 'base' });
    addComponent({ name: 'tip',  parentId: 'base', componentId: 'tip' });
    setComponentOrigin('base', { position: [10, 0, 0] });
    setComponentOrigin('tip',  { position: [10, 0, 0] });   // 10 mm beyond base, in base frame
    const jBase = addJoint({ kind: 'revolute', parent: 'root', child: 'base',
        origin: [0, 0, 0], axis: [0, 0, 1], limits: { min: -180, max: 180 } });
    const jTip  = addJoint({ kind: 'revolute', parent: 'base', child: 'tip',
        origin: [0, 0, 0], axis: [0, 0, 1], limits: { min: -180, max: 180 } });

    let doc = getDocumentStore().doc;
    // Rest: tip world should be (20,0,0).
    assert.ok(approxPoint(worldOrigin(doc, 'tip'), [20, 0, 0]), `rest tip ${worldOrigin(doc, 'tip')}`);

    // Drive the BASE joint 90° — the tip must swing to (0,20,0) because the
    // child subtree (tip) is parent-relative and rides along.
    await driveJoint(jBase.id, 90, deps);
    doc = getDocumentStore().doc;
    assert.ok(approxPoint(worldOrigin(doc, 'base'), [0, 10, 0]), `base ${worldOrigin(doc, 'base')}`);
    assert.ok(approxPoint(worldOrigin(doc, 'tip'), [0, 20, 0]), `tip after base drive ${worldOrigin(doc, 'tip')}`);

    // Now also drive the tip joint 90° about its own frame (origin at base tip).
    // base frame is rotated 90°; tip swings a further 90° within base frame.
    await driveJoint(jTip.id, 90, deps);
    doc = getDocumentStore().doc;
    // tip local: rotate (10,0,0) by 90° → (0,10,0) in base frame; base frame is
    // base@(0,10,0) rotated 90°. World tip = base + R(90)·(0,10,0) = (0,10)+(-10,0) = (-10,10).
    assert.ok(approxPoint(worldOrigin(doc, 'tip'), [-10, 10, 0]), `tip after both drives ${worldOrigin(doc, 'tip')}`);
});

await t('driveJoint: clamps an out-of-limit request', async () => {
    resetDocumentStore();
    _clearRestBaselines();
    addComponent({ name: 'arm', parentId: 'root', componentId: 'arm' });
    setComponentOrigin('arm', { position: [10, 0, 0] });
    const j = addJoint({ kind: 'revolute', parent: 'root', child: 'arm',
        origin: [0, 0, 0], axis: [0, 0, 1], limits: { min: -45, max: 45 } });
    const r = await driveJoint(j.id, 1000, deps);
    assert.equal(r.clamped, true);
    assert.equal(r.value, 45);
    const doc = getDocumentStore().doc;
    assert.equal(doc.joints[j.id].drive.value, 45);
    // 45° about Z: (10,0,0) → (10·cos45, 10·sin45, 0)
    const w = worldOrigin(doc, 'arm');
    assert.ok(approxPoint(w, [10 * Math.SQRT1_2, 10 * Math.SQRT1_2, 0]), `got ${w}`);
});

await t('driveJoint: re-driving from a driven state is idempotent (no drift)', async () => {
    resetDocumentStore();
    _clearRestBaselines();
    addComponent({ name: 'arm', parentId: 'root', componentId: 'arm' });
    setComponentOrigin('arm', { position: [10, 0, 0] });
    const j = addJoint({ kind: 'revolute', parent: 'root', child: 'arm',
        origin: [0, 0, 0], axis: [0, 0, 1], limits: { min: -180, max: 180 } });
    await driveJoint(j.id, 30, deps);
    await driveJoint(j.id, 60, deps);
    await driveJoint(j.id, 90, deps);   // final value should match a single drive to 90
    const doc = getDocumentStore().doc;
    assert.ok(approxPoint(worldOrigin(doc, 'arm'), [0, 10, 0]), `got ${worldOrigin(doc, 'arm')}`);
});

await t('computeDof: 2-revolute chain = 2 DOF, both mobile', () => {
    resetDocumentStore();
    addComponent({ name: 'base', parentId: 'root', componentId: 'base' });
    addComponent({ name: 'tip',  parentId: 'base', componentId: 'tip' });
    addJoint({ kind: 'revolute', parent: 'root', child: 'base' });
    addJoint({ kind: 'revolute', parent: 'base', child: 'tip' });
    const dof = computeDof(getDocumentStore().doc);
    assert.equal(dof.totalDof, 2);
    assert.equal(dof.components.length, 2);
    assert.ok(dof.components.every((c) => c.status === 'mobile'));
    assert.equal(dof.overConstrained.length, 0);
});

await t('computeDof: fixed joint contributes 0 (locked component)', () => {
    resetDocumentStore();
    addComponent({ name: 'bracket', parentId: 'root', componentId: 'bracket' });
    addJoint({ kind: 'fixed', parent: 'root', child: 'bracket' });
    const dof = computeDof(getDocumentStore().doc);
    assert.equal(dof.totalDof, 0);
    assert.equal(dof.components[0].status, 'locked');
});

await t('computeDof: >1 incoming joint flags over-constrained', () => {
    resetDocumentStore();
    addComponent({ name: 'a', parentId: 'root', componentId: 'a' });
    addComponent({ name: 'loop', parentId: 'a', componentId: 'loop' });
    // Two joints both pointing at 'loop' — a closed loop the tree solver can't honour.
    addJoint({ kind: 'revolute', parent: 'root', child: 'loop' });
    addJoint({ kind: 'revolute', parent: 'a', child: 'loop' });
    const dof = computeDof(getDocumentStore().doc);
    assert.ok(dof.overConstrained.includes('loop'));
    const row = dof.components.find((c) => c.componentId === 'loop');
    assert.equal(row.status, 'over-constrained');
    assert.equal(row.incomingJoints.length, 2);
});

await t('movableJoints: excludes fixed, orders parent before tip', () => {
    resetDocumentStore();
    addComponent({ name: 'base', parentId: 'root', componentId: 'base' });
    addComponent({ name: 'tip',  parentId: 'base', componentId: 'tip' });
    addComponent({ name: 'pin',  parentId: 'root', componentId: 'pin' });
    const jBase = addJoint({ kind: 'revolute', parent: 'root', child: 'base' });
    const jTip  = addJoint({ kind: 'revolute', parent: 'base', child: 'tip' });
    addJoint({ kind: 'fixed', parent: 'root', child: 'pin' });
    const mv = movableJoints(getDocumentStore().doc);
    assert.equal(mv.length, 2);
    assert.equal(mv[0].id, jBase.id);
    assert.equal(mv[1].id, jTip.id);
});

// Cross-check: driveJoint origins agree with the FK solver pose evaluation.
await t('driveJoint origins agree with solveForwardKinematics pose', async () => {
    resetDocumentStore();
    _clearRestBaselines();
    addComponent({ name: 'base', parentId: 'root', componentId: 'base' });
    addComponent({ name: 'tip',  parentId: 'base', componentId: 'tip' });
    setComponentOrigin('base', { position: [10, 0, 0] });
    setComponentOrigin('tip',  { position: [10, 0, 0] });
    const jBase = addJoint({ kind: 'revolute', parent: 'root', child: 'base',
        origin: [0, 0, 0], axis: [0, 0, 1], limits: { min: -180, max: 180 } });
    const jTip  = addJoint({ kind: 'revolute', parent: 'base', child: 'tip',
        origin: [0, 0, 0], axis: [0, 0, 1], limits: { min: -180, max: 180 } });
    // FK at pose {base:90, tip:0} using the ORIGINAL rest origins (snapshot
    // them before driving mutates the doc origins).
    const doc0 = getDocumentStore().doc;
    const restDoc = JSON.parse(JSON.stringify({ components: doc0.components, joints: doc0.joints }));
    const fk = solveForwardKinematics(restDoc, { [jBase.id]: 90, [jTip.id]: 0 });
    const tipWorldFk = mat4ApplyPoint(fk.transforms.get('tip'), [0, 0, 0]);

    await driveJoint(jBase.id, 90, deps);
    const doc = getDocumentStore().doc;
    assert.ok(approxPoint(worldOrigin(doc, 'tip'), tipWorldFk),
        `drive ${worldOrigin(doc, 'tip')} vs fk ${tipWorldFk}`);
});

console.log(`\n  ${_pass} passed, ${_fail} failed`);
process.exit(_fail > 0 ? 1 : 0);
