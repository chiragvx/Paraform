/**
 * Spec 17 v1 — kinematics oracle.
 *
 * Run via:
 *   node --import ./src/lib/commands/__tests__/_register.mjs \
 *        src/lib/__tests__/spec17_kinematics.mjs
 *
 * Covers (v1 slice):
 *   1. Joint type factory + changelog/fold round-trip.
 *   2. Operations layer (addJoint / updateJoint / removeJoint).
 *   3. FK — revolute 90° about Z places a point correctly.
 *   4. FK — prismatic along axis translates correctly.
 *   5. FK — parent rev + child rev compose.
 *   6. AABB interference positive / negative.
 *   7. Pose interpolation.
 *   8. sampleTrajectory detects mid-motion collision.
 *   9. Invariant i-no-interference-along-trajectory fires.
 */
import assert from 'node:assert/strict';
import {
  resetDocumentStore,
  getDocumentStore,
  addComponent,
  addJoint,
  updateJoint,
  removeJoint,
  makeJoint,
} from '../../../lib/document/index.js';
import {
  solveForwardKinematics,
  mat4ApplyPoint,
  mat4Identity,
  mat4RotateAxis,
  jointTransform,
  componentOriginToMat4,
  clampJointValue,
} from '$lib/kinematics/solver.js';
import {
  checkInterferenceAtPose,
  transformAABB,
  aabbOverlap,
} from '$lib/kinematics/interference.js';
import {
  makePose,
  interpolatePose,
  sampleTrajectory,
  PoseLibrary,
} from '$lib/kinematics/pose.js';
import { INVARIANTS_BY_ID } from '$lib/invariants/library.js';

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

function approxEq(a, b, eps = 1e-6) {
  return Math.abs(a - b) <= eps;
}
function approxPoint(p, q, eps = 1e-6) {
  return approxEq(p[0], q[0], eps) && approxEq(p[1], q[1], eps) && approxEq(p[2], q[2], eps);
}

console.log('── spec 17 — kinematics oracle v1 ──');

// 1. Factory ──────────────────────────────────────────────────────────────────
t('makeJoint: defaults to fixed', () => {
  const j = makeJoint();
  assert.equal(j.kind, 'fixed');
  assert.equal(j.parent, 'root');
  assert.equal(j.child, null);
  assert.deepEqual(j.origin, [0, 0, 0]);
  assert.deepEqual(j.axis, [0, 0, 1]);
});

t('makeJoint: clamps unknown kind', () => {
  const j = makeJoint({ kind: 'bogus' });
  assert.equal(j.kind, 'fixed');
});

t('makeJoint: revolute carries [-180,180] limits by default', () => {
  const j = makeJoint({ kind: 'revolute', child: 'c1' });
  assert.equal(j.limits.min, -180);
  assert.equal(j.limits.max, 180);
});

// 2. Operations + fold ────────────────────────────────────────────────────────
const await1 = (async () => {
  await t('addJoint: persists into doc.joints', () => {
    resetDocumentStore();
    addComponent({ name: 'arm', parentId: 'root', componentId: 'arm' });
    const j = addJoint({ kind: 'revolute', parent: 'root', child: 'arm',
      origin: [0, 0, 0], axis: [0, 0, 1], limits: { min: -90, max: 90 } });
    const doc = getDocumentStore().doc;
    assert.ok(doc.joints[j.id]);
    assert.equal(doc.joints[j.id].kind, 'revolute');
  });

  await t('updateJoint: patches limits', () => {
    resetDocumentStore();
    addComponent({ name: 'arm', parentId: 'root', componentId: 'arm' });
    const j = addJoint({ kind: 'revolute', parent: 'root', child: 'arm', limits: { min: -90, max: 90 } });
    updateJoint(j.id, { limits: { max: 180 } });
    const stored = getDocumentStore().doc.joints[j.id];
    assert.equal(stored.limits.min, -90);
    assert.equal(stored.limits.max, 180);
  });

  await t('removeJoint: deletes by id', () => {
    resetDocumentStore();
    addComponent({ name: 'arm', parentId: 'root', componentId: 'arm' });
    const j = addJoint({ kind: 'revolute', parent: 'root', child: 'arm' });
    removeJoint(j.id);
    assert.equal(getDocumentStore().doc.joints[j.id], undefined);
  });

  await t('serialize round-trip: joints survive toJSON/fromJSON', () => {
    resetDocumentStore();
    addComponent({ name: 'arm', parentId: 'root', componentId: 'arm' });
    const j = addJoint({ kind: 'prismatic', parent: 'root', child: 'arm',
      axis: [1, 0, 0], limits: { min: 0, max: 50 } });
    const json = getDocumentStore().toJSON();
    const store2 = resetDocumentStore();
    store2.fromJSON(json);
    const restored = store2.doc.joints[j.id];
    assert.ok(restored);
    assert.equal(restored.kind, 'prismatic');
    assert.equal(restored.limits.max, 50);
  });

  // 3. FK — revolute 90° about Z ───────────────────────────────────────────────
  await t('FK: revolute 90° about Z maps (1,0,0) → (0,1,0)', () => {
    resetDocumentStore();
    addComponent({ name: 'arm', parentId: 'root', componentId: 'arm' });
    const j = addJoint({ kind: 'revolute', parent: 'root', child: 'arm',
      origin: [0, 0, 0], axis: [0, 0, 1], limits: { min: -180, max: 180 } });
    const fk = solveForwardKinematics(getDocumentStore().doc, { [j.id]: 90 });
    const T = fk.transforms.get('arm');
    const p = mat4ApplyPoint(T, [1, 0, 0]);
    assert.ok(approxPoint(p, [0, 1, 0], 1e-6), `got ${p.join(',')}`);
  });

  await t('FK: revolute respects clamp on out-of-limit pose request', () => {
    resetDocumentStore();
    addComponent({ name: 'arm', parentId: 'root', componentId: 'arm' });
    const j = addJoint({ kind: 'revolute', parent: 'root', child: 'arm',
      origin: [0, 0, 0], axis: [0, 0, 1], limits: { min: -45, max: 45 } });
    const fk = solveForwardKinematics(getDocumentStore().doc, { [j.id]: 1000 });
    const T = fk.transforms.get('arm');
    const p = mat4ApplyPoint(T, [1, 0, 0]);
    // 45° about Z: x' = cos45, y' = sin45
    assert.ok(approxPoint(p, [Math.SQRT1_2, Math.SQRT1_2, 0], 1e-6), `got ${p.join(',')}`);
  });

  // 4. FK — prismatic ─────────────────────────────────────────────────────────
  await t('FK: prismatic along X translates origin by `value` mm', () => {
    resetDocumentStore();
    addComponent({ name: 'slider', parentId: 'root', componentId: 'slider' });
    const j = addJoint({ kind: 'prismatic', parent: 'root', child: 'slider',
      origin: [0, 0, 0], axis: [1, 0, 0], limits: { min: 0, max: 100 } });
    const fk = solveForwardKinematics(getDocumentStore().doc, { [j.id]: 25 });
    const T = fk.transforms.get('slider');
    const p = mat4ApplyPoint(T, [0, 0, 0]);
    assert.ok(approxPoint(p, [25, 0, 0], 1e-6), `got ${p.join(',')}`);
  });

  // 5. FK — joint chain composition ───────────────────────────────────────────
  await t('FK: rev(90°,Z) → rev(90°,Z) chain composes to 180° about Z', () => {
    resetDocumentStore();
    addComponent({ name: 'a', parentId: 'root', componentId: 'a' });
    addComponent({ name: 'b', parentId: 'a',    componentId: 'b' });
    const j1 = addJoint({ kind: 'revolute', parent: 'root', child: 'a',
      origin: [0, 0, 0], axis: [0, 0, 1], limits: { min: -180, max: 180 } });
    const j2 = addJoint({ kind: 'revolute', parent: 'a', child: 'b',
      origin: [0, 0, 0], axis: [0, 0, 1], limits: { min: -180, max: 180 } });
    const fk = solveForwardKinematics(getDocumentStore().doc, { [j1.id]: 90, [j2.id]: 90 });
    const T = fk.transforms.get('b');
    const p = mat4ApplyPoint(T, [1, 0, 0]);
    // Cumulative 180° about Z: (1,0,0) → (-1,0,0)
    assert.ok(approxPoint(p, [-1, 0, 0], 1e-6), `got ${p.join(',')}`);
  });

  await t('FK: rev about Z at origin (1,0,0) translates child frame, then rotates', () => {
    resetDocumentStore();
    addComponent({ name: 'arm', parentId: 'root', componentId: 'arm' });
    // Joint origin at (1,0,0) — child's local origin maps to world (1,0,0)
    // at zero rotation; at 90° about Z the joint still translates first.
    const j = addJoint({ kind: 'revolute', parent: 'root', child: 'arm',
      origin: [1, 0, 0], axis: [0, 0, 1], limits: { min: -180, max: 180 } });
    const fk = solveForwardKinematics(getDocumentStore().doc, { [j.id]: 0 });
    const T = fk.transforms.get('arm');
    const p = mat4ApplyPoint(T, [0, 0, 0]);
    assert.ok(approxPoint(p, [1, 0, 0], 1e-6), `got ${p.join(',')}`);
  });

  // 6. AABB interference ──────────────────────────────────────────────────────
  await t('AABB overlap: trivially overlapping boxes report true', () => {
    const a = { min: [0, 0, 0], max: [2, 2, 2] };
    const b = { min: [1, 1, 1], max: [3, 3, 3] };
    assert.equal(aabbOverlap(a, b), true);
  });

  await t('AABB overlap: disjoint boxes report false', () => {
    const a = { min: [0, 0, 0], max: [1, 1, 1] };
    const b = { min: [2, 2, 2], max: [3, 3, 3] };
    assert.equal(aabbOverlap(a, b), false);
  });

  await t('transformAABB: 90° about Z rotates corners correctly', () => {
    const local = { min: [0, 0, 0], max: [2, 1, 1] };
    const R = mat4RotateAxis([0, 0, 1], Math.PI / 2);
    const world = transformAABB(local, R);
    // After 90° rot about Z: x→y, y→-x. Box previously [0,2]×[0,1]×[0,1]
    // becomes [-1,0]×[0,2]×[0,1].
    assert.ok(approxEq(world.min[0], -1, 1e-6));
    assert.ok(approxEq(world.max[1],  2, 1e-6));
  });

  await t('checkInterferenceAtPose: detects collision at folded-back pose', () => {
    resetDocumentStore();
    // Two-link arm + a fixed obstacle ("base"), all parented to root with
    // a revolute on link b. At j_b near 180° the swung link b crosses the
    // obstacle. The base is NOT joined to b, so the parent-child filter
    // does not mask the collision.
    addComponent({ name: 'base', parentId: 'root', componentId: 'base' });
    addComponent({ name: 'a',    parentId: 'root', componentId: 'a' });
    addComponent({ name: 'b',    parentId: 'root', componentId: 'b' });
    const store = getDocumentStore();
    // Base obstacle sits in -X half-space (well away from rest-pose b
    // which extends [5,10] along +X). At jb=180° b folds back along -X
    // crossing the obstacle.
    store.doc.components.base.bbox = { min: [-2, -0.5, -0.5], max: [-0.5, 0.5, 0.5] };
    store.doc.components.a.bbox = { min: [0, -0.5, -0.5], max: [5, 0.5, 0.5] };
    store.doc.components.b.bbox = { min: [0, -0.5, -0.5], max: [5, 0.5, 0.5] };
    addJoint({ kind: 'fixed', parent: 'root', child: 'base' });
    addJoint({ kind: 'fixed', parent: 'root', child: 'a' });
    // Joint at a's TIP — b swings about (5,0,0).
    const jb = addJoint({ kind: 'revolute', parent: 'a', child: 'b',
      origin: [5, 0, 0], axis: [0, 0, 1], limits: { min: -360, max: 360 } });

    const restReport = checkInterferenceAtPose(store.doc, { [jb.id]: 0 });
    assert.equal(restReport.ok, true, 'rest pose should be clear');

    // At jb=180°, b is mapped (x,y,z) → (5-x, -y, z). Its world bbox
    // becomes x ∈ [0,5] — does NOT reach the base at [-2,-0.5]. Use a
    // joint origin further forward and a longer b so it sweeps past 0.
    // Easier: jb at value=180° + extra translation. Push joint origin to
    // 3,0,0 — at rest b world bbox is [3,8]; at 180° it's [-2,3] (since
    // 3-5 = -2). That straddles base [-2,-0.5]. Rebuild the joint.
    removeJoint(jb.id);
    const jb2 = addJoint({ kind: 'revolute', parent: 'a', child: 'b',
      origin: [3, 0, 0], axis: [0, 0, 1], limits: { min: -360, max: 360 } });
    const restReport2 = checkInterferenceAtPose(store.doc, { [jb2.id]: 0 });
    assert.equal(restReport2.ok, true, 'rest pose (with new origin) should still be clear');
    const foldedReport = checkInterferenceAtPose(store.doc, { [jb2.id]: 180 });
    assert.equal(foldedReport.ok, false, 'folded pose should overlap base');
    assert.ok(foldedReport.hits.length >= 1);
    assert.ok(foldedReport.hits.some(h => h.a === 'base' || h.b === 'base'));
  });

  // 7. Pose interpolation ──────────────────────────────────────────────────────
  await t('interpolatePose: midpoint of (0) and (90) is 45', () => {
    const a = makePose('rest', { j1: 0 });
    const b = makePose('out',  { j1: 90 });
    const mid = interpolatePose(a, b, 0.5);
    assert.ok(approxEq(mid.j1, 45, 1e-9));
  });

  await t('interpolatePose: t clamps to [0,1]', () => {
    const a = makePose('a', { j1: 0 });
    const b = makePose('b', { j1: 10 });
    assert.ok(approxEq(interpolatePose(a, b, -5).j1, 0));
    assert.ok(approxEq(interpolatePose(a, b,  5).j1, 10));
  });

  // 8. sampleTrajectory fires on mid-motion collision ─────────────────────────
  await t('sampleTrajectory: collision between clear endpoints detected mid-sweep', () => {
    resetDocumentStore();
    addComponent({ name: 'base', parentId: 'root', componentId: 'base' });
    addComponent({ name: 'a',    parentId: 'root', componentId: 'a' });
    addComponent({ name: 'b',    parentId: 'root', componentId: 'b' });
    const store = getDocumentStore();
    store.doc.components.base.bbox = { min: [-2, -0.5, -0.5], max: [-0.5, 0.5, 0.5] };
    store.doc.components.a.bbox = { min: [0, -0.5, -0.5], max: [5, 0.5, 0.5] };
    store.doc.components.b.bbox = { min: [0, -0.5, -0.5], max: [5, 0.5, 0.5] };
    addJoint({ kind: 'fixed', parent: 'root', child: 'base' });
    addJoint({ kind: 'fixed', parent: 'root', child: 'a' });
    const jb = addJoint({ kind: 'revolute', parent: 'a', child: 'b',
      origin: [3, 0, 0], axis: [0, 0, 1], limits: { min: -360, max: 360 } });
    // 90° → 270° sweep passes through 180° (collision with base).
    const poseA = makePose('a', { [jb.id]: 90 });
    const poseB = makePose('b', { [jb.id]: 270 });
    const traj = sampleTrajectory(store.doc, poseA, poseB, { samples: 10 });
    assert.equal(traj.ok, false);
    const bad = traj.steps.filter(s => !s.ok);
    assert.ok(bad.length >= 1);
  });

  await t('sampleTrajectory: clean run reports ok', () => {
    resetDocumentStore();
    addComponent({ name: 'a', parentId: 'root', componentId: 'a' });
    addComponent({ name: 'b', parentId: 'root', componentId: 'b' });
    const store = getDocumentStore();
    store.doc.components.a.bbox = { min: [0, -0.5, -0.5], max: [5, 0.5, 0.5] };
    store.doc.components.b.bbox = { min: [0, -0.5, -0.5], max: [5, 0.5, 0.5] };
    addJoint({ kind: 'fixed', parent: 'root', child: 'a' });
    const jb = addJoint({ kind: 'revolute', parent: 'a', child: 'b',
      origin: [5, 0, 0], axis: [0, 0, 1], limits: { min: -90, max: 90 } });
    const poseA = makePose('a', { [jb.id]: 0 });
    const poseB = makePose('b', { [jb.id]: 60 });
    const traj = sampleTrajectory(store.doc, poseA, poseB, { samples: 10 });
    assert.equal(traj.ok, true);
  });

  // 9. Invariant ──────────────────────────────────────────────────────────────
  await t('invariant i-no-interference-along-trajectory is registered', () => {
    const inv = INVARIANTS_BY_ID['i-no-interference-along-trajectory'];
    assert.ok(inv);
    assert.equal(inv.scope, 'per-document');
    assert.equal(inv.category, 'assembly');
  });

  await t('invariant: fires on a colliding trajectory', async () => {
    resetDocumentStore();
    addComponent({ name: 'base', parentId: 'root', componentId: 'base' });
    addComponent({ name: 'a',    parentId: 'root', componentId: 'a' });
    addComponent({ name: 'b',    parentId: 'root', componentId: 'b' });
    const store = getDocumentStore();
    store.doc.components.base.bbox = { min: [-2, -0.5, -0.5], max: [-0.5, 0.5, 0.5] };
    store.doc.components.a.bbox = { min: [0, -0.5, -0.5], max: [5, 0.5, 0.5] };
    store.doc.components.b.bbox = { min: [0, -0.5, -0.5], max: [5, 0.5, 0.5] };
    addJoint({ kind: 'fixed', parent: 'root', child: 'base' });
    addJoint({ kind: 'fixed', parent: 'root', child: 'a' });
    const jb = addJoint({ kind: 'revolute', parent: 'a', child: 'b',
      origin: [3, 0, 0], axis: [0, 0, 1], limits: { min: -360, max: 360 } });
    const lib = new PoseLibrary();
    lib.add('p1', { [jb.id]: 90 });
    lib.add('p2', { [jb.id]: 270 });
    const inv = INVARIANTS_BY_ID['i-no-interference-along-trajectory'];
    const res = await inv.check(store.doc, { poseLibrary: lib });
    assert.equal(res.ok, false);
    assert.equal(res.severity, 'error');
  });

  await t('invariant: notApplicable when no pose library supplied', async () => {
    const inv = INVARIANTS_BY_ID['i-no-interference-along-trajectory'];
    const res = await inv.check({}, {});
    assert.equal(res.ok, true);
    assert.match(res.message, /no pose library/);
  });

  await t('clampJointValue: respects limits', () => {
    const j = { limits: { min: -10, max: 10 } };
    assert.equal(clampJointValue(j, 100), 10);
    assert.equal(clampJointValue(j, -100), -10);
    assert.equal(clampJointValue(j, 5), 5);
  });

  await t('jointTransform: fixed joint yields identity at any value', () => {
    const j = makeJoint({ kind: 'fixed', origin: [0, 0, 0], axis: [0, 0, 1] });
    const T = jointTransform(j, 999);
    const I = mat4Identity();
    for (let i = 0; i < 16; i++) assert.ok(approxEq(T[i], I[i], 1e-12));
  });

  await t('componentOriginToMat4: identity origin returns identity', () => {
    const m = componentOriginToMat4({ position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] });
    const I = mat4Identity();
    for (let i = 0; i < 16; i++) assert.ok(approxEq(m[i], I[i], 1e-12));
  });
})();

await await1;

console.log(`\n  ${_pass} passed, ${_fail} failed`);
process.exit(_fail > 0 ? 1 : 0);
