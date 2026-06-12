/**
 * Joint-limit enforcement + articulation driver — Phase 6.
 *
 * This module sits on top of the FK solver (`solver.js`) and the document
 * ops layer (`lib/document/index.js`). It owns three concerns:
 *
 *   1. `clampJointValue(joint, value)` — clamp a requested joint value to the
 *      joint's limits (degrees for revolute, mm for prismatic) and report
 *      whether clamping occurred.
 *   2. `driveJoint(jointId, value)` — the articulation primitive: clamp the
 *      request, persist it as the joint's `drive`, then recompute & commit the
 *      child subtree's component origins so the viewport (which renders
 *      `component.origin` directly) shows the chain articulate.
 *   3. `computeDof(doc)` — degrees-of-freedom report per subassembly + whole
 *      assembly, with over-constrained-loop detection.
 *
 * Units / conventions (CLAUDE.md): Z-up, mm, degrees for revolute limits, mm
 * for prismatic limits. Pure JS, no three.js — runs under node for tests.
 *
 * Articulation model
 * ──────────────────
 * Each component's `origin` is its *rest* placement relative to its parent
 * (this is what the scene graph + bridge render, and what the FK solver feeds
 * in as `localOrigin`). Driving a joint must not corrupt that rest placement,
 * so the first time a child is driven we snapshot its rest origin into a
 * baseline map keyed by document id. Subsequent drives rewrite the child's
 * `component.origin` to:
 *
 *     localAtPose = T(jointOrigin) · J(kind, axis, value) · T(jointOrigin)⁻¹ · localAtRest
 *
 * i.e. the joint's motion applied *about the joint frame* on top of the rest
 * placement. Driving a parent joint moves the whole downstream chain because
 * each child below it is recomputed in topo order, and child rest origins are
 * parent-relative — the motion composes naturally through the scene-graph
 * parent chain the bridge already maintains.
 */

import {
    mat4Identity,
    mat4Mul,
    mat4Translate,
    mat4RotateAxis,
    mat4TranslateAlong,
    componentOriginToMat4,
    buildKinematicTree,
} from './solver.js';

// ── Mat4 → origin decomposition ──────────────────────────────────────────────
/**
 * Invert a rigid-ish 4×4 (rotation + translation, possibly uniform scale).
 * We solve the 3×3 linear block by cofactors so non-orthonormal (scaled)
 * matrices still invert correctly, then back out the translation.
 *
 * @param {Float64Array} m   row-major length-16
 * @returns {Float64Array}
 */
export function mat4Invert(m) {
    // 3×3 upper-left.
    const a = m[0], b = m[1], c = m[2];
    const d = m[4], e = m[5], f = m[6];
    const g = m[8], h = m[9], i = m[10];
    const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
    if (Math.abs(det) < 1e-12) return mat4Identity();
    const id = 1 / det;
    // Inverse of the 3×3 (adjugate / det).
    const i00 = (e * i - f * h) * id;
    const i01 = (c * h - b * i) * id;
    const i02 = (b * f - c * e) * id;
    const i10 = (f * g - d * i) * id;
    const i11 = (a * i - c * g) * id;
    const i12 = (c * d - a * f) * id;
    const i20 = (d * h - e * g) * id;
    const i21 = (b * g - a * h) * id;
    const i22 = (a * e - b * d) * id;
    const tx = m[3], ty = m[7], tz = m[11];
    const out = mat4Identity();
    out[0] = i00; out[1] = i01; out[2] = i02;
    out[4] = i10; out[5] = i11; out[6] = i12;
    out[8] = i20; out[9] = i21; out[10] = i22;
    // translation: -R⁻¹ · t
    out[3]  = -(i00 * tx + i01 * ty + i02 * tz);
    out[7]  = -(i10 * tx + i11 * ty + i12 * tz);
    out[11] = -(i20 * tx + i21 * ty + i22 * tz);
    return out;
}

/**
 * Decompose a rigid 4×4 into a Component.origin `{ position, rotation, scale }`,
 * where rotation is Euler-XYZ radians (the convention `componentOriginToMat4`
 * consumes). Scale is assumed uniform-ish and recovered from column norms.
 *
 * @param {Float64Array} m
 * @returns {{ position:number[], rotation:number[], scale:number[] }}
 */
export function mat4ToOrigin(m) {
    const position = [m[3], m[7], m[11]];
    // Column (basis-vector) norms → scale.
    const sx = Math.hypot(m[0], m[4], m[8]) || 1;
    const sy = Math.hypot(m[1], m[5], m[9]) || 1;
    const sz = Math.hypot(m[2], m[6], m[10]) || 1;
    // Normalise rotation block.
    const r00 = m[0] / sx, r01 = m[1] / sy, r02 = m[2] / sz;
    const r10 = m[4] / sx, r11 = m[5] / sy, r12 = m[6] / sz;
    const r20 = m[8] / sx, r21 = m[9] / sy, r22 = m[10] / sz;
    // Euler XYZ extraction (R = Rx·Ry·Rz), matching componentOriginToMat4.
    let rx, ry, rz;
    const sy_ = Math.min(1, Math.max(-1, r02));
    ry = Math.asin(sy_);
    if (Math.abs(r02) < 0.999999) {
        rx = Math.atan2(-r12, r22);
        rz = Math.atan2(-r01, r00);
    } else {
        // Gimbal lock — fold into rx.
        rx = Math.atan2(r21, r11);
        rz = 0;
    }
    return { position, rotation: [rx, ry, rz], scale: [sx, sy, sz] };
}

// ── Clamp with flag ──────────────────────────────────────────────────────────
/**
 * Clamp a requested joint value to its limits and report whether it was
 * clamped. Revolute limits are degrees, prismatic mm. Fixed joints have no
 * variable → always 0.
 *
 * @param {import('../../../lib/document/types.js').Joint} joint
 * @param {number} value
 * @returns {{ value:number, clamped:boolean, min:number, max:number }}
 */
export function clampJointValue(joint, value) {
    if (!joint || joint.kind === 'fixed') {
        return { value: 0, clamped: !!(value && Number(value) !== 0), min: 0, max: 0 };
    }
    const req = Number.isFinite(value) ? Number(value) : 0;
    const min = Number.isFinite(joint.limits?.min) ? joint.limits.min : -Infinity;
    const max = Number.isFinite(joint.limits?.max) ? joint.limits.max : Infinity;
    const clamped = Math.max(min, Math.min(max, req));
    return { value: clamped, clamped: clamped !== req, min, max };
}

// ── Rest-origin baselines ─────────────────────────────────────────────────────
// Driving a joint rewrites the affected children's `component.origin`. To keep
// the *rest* placement recoverable across many drives, we snapshot the origin
// the first time a component is articulated, keyed by document id. The baseline
// is the local origin at the joint's current drive value 0.
const _restBaselines = new Map(); // docId → Map<componentId, Float64Array(localRestMat4)>

/** Test/UI hook — drop cached rest baselines (e.g. after resetDocument). */
export function _clearRestBaselines(docId = null) {
    if (docId == null) _restBaselines.clear();
    else _restBaselines.delete(docId);
}

function baselineMapFor(doc) {
    const id = (doc && doc.id) || '_default';
    let m = _restBaselines.get(id);
    if (!m) { m = new Map(); _restBaselines.set(id, m); }
    return m;
}

/**
 * The rest local origin for a child, recovered as
 *   localRest = T(jointOrigin)⁻¹ · J(value0)⁻¹ · localCurrent
 * but since we only ever rewrite origins through driveJoint, we instead
 * snapshot the *current* origin the first time we see the child and treat that
 * as rest (the document's authored placement). The snapshot is taken while the
 * joint sits at value 0 conceptually — callers that pre-drive must clear the
 * baseline first.
 */
function restOriginMat4(doc, componentId, joint, currentDriveValue) {
    const map = baselineMapFor(doc);
    if (map.has(componentId)) return map.get(componentId);
    // Recover rest from the current (possibly already-driven) origin by
    // dividing out the joint motion currently baked in.
    const comp = doc.components[componentId];
    const localCurrent = componentOriginToMat4(comp && comp.origin);
    const aboutJoint = jointMotionAboutFrame(joint, currentDriveValue);
    const rest = mat4Mul(mat4Invert(aboutJoint), localCurrent);
    map.set(componentId, rest);
    return rest;
}

/**
 * The joint's motion expressed *about its own frame*, so it can be applied as a
 * left-multiply on a child's rest local origin:
 *   M(value) = T(jointOrigin) · J(kind, axis, value) · T(jointOrigin)⁻¹
 * At value 0 this is identity (J = I), so a rest origin passes through unchanged.
 *
 * @param {import('../../../lib/document/types.js').Joint} joint
 * @param {number} value
 * @returns {Float64Array}
 */
export function jointMotionAboutFrame(joint, value) {
    if (!joint || joint.kind === 'fixed' || !value) return mat4Identity();
    const o = joint.origin || [0, 0, 0];
    const T = mat4Translate(o[0], o[1], o[2]);
    const Tinv = mat4Translate(-o[0], -o[1], -o[2]);
    let J;
    if (joint.kind === 'revolute') {
        J = mat4RotateAxis(joint.axis, (value * Math.PI) / 180);
    } else if (joint.kind === 'prismatic') {
        J = mat4TranslateAlong(joint.axis, value);
        // pure translation commutes with T — but keep the form uniform.
    } else {
        return mat4Identity();
    }
    return mat4Mul(T, mat4Mul(J, Tinv));
}

// ── driveJoint ────────────────────────────────────────────────────────────────
/**
 * Articulate the assembly by driving one joint to a value.
 *
 *   1. Clamp the request to the joint's limits.
 *   2. Persist the value as `joint.drive` via `updateJoint` (ops pipeline).
 *   3. Recompute the driven child's new local `component.origin` and commit it
 *      via `setComponentOrigin`. Only the immediate child of the driven joint
 *      needs its local origin rewritten — its descendants are parent-relative
 *      in the scene graph and ride along for free.
 *
 * No direct document mutation — everything routes through the ops layer so it
 * lands in the changelog (undoable).
 *
 * @param {string} jointId
 * @param {number} value                 requested value (deg / mm)
 * @param {object} [deps]                injectable ops for testing
 * @param {() => {doc:object}} [deps.getStore]
 * @param {(id:string, patch:object)=>void} [deps.updateJoint]
 * @param {(id:string, patch:object)=>boolean} [deps.setComponentOrigin]
 * @returns {{ ok:boolean, jointId:string, value:number, clamped:boolean, child:string|null }}
 */
export async function driveJoint(jointId, value, deps = {}) {
    let getStore = deps.getStore;
    let updateJointOp = deps.updateJoint;
    let setComponentOriginOp = deps.setComponentOrigin;
    if (!getStore || !updateJointOp || !setComponentOriginOp) {
        const ops = await import('../../../lib/document/index.js');
        getStore = getStore || ops.getDocumentStore;
        updateJointOp = updateJointOp || ops.updateJoint;
        setComponentOriginOp = setComponentOriginOp || ops.setComponentOrigin;
    }
    const store = getStore();
    const doc = store && store.doc;
    const joint = doc && doc.joints && doc.joints[jointId];
    if (!joint) return { ok: false, jointId, value: 0, clamped: false, child: null };

    const prevValue = (joint.drive && Number.isFinite(joint.drive.value)) ? Number(joint.drive.value) : 0;
    const { value: clampedValue, clamped } = clampJointValue(joint, value);

    // Persist the drive on the joint.
    updateJointOp(jointId, { drive: { type: 'position', value: clampedValue } });

    const childId = joint.child;
    if (!childId || childId === 'root' || !doc.components[childId]) {
        return { ok: true, jointId, value: clampedValue, clamped, child: null };
    }

    // Rest origin baseline (recovered from the pre-drive state).
    const rest = restOriginMat4(doc, childId, joint, prevValue);
    const motion = jointMotionAboutFrame(joint, clampedValue);
    const localAtPose = mat4Mul(motion, rest);
    const origin = mat4ToOrigin(localAtPose);
    setComponentOriginOp(childId, origin);

    return { ok: true, jointId, value: clampedValue, clamped, child: childId };
}

// ── computeDof ────────────────────────────────────────────────────────────────
/**
 * Degrees-of-freedom contributed by a single joint.
 *   revolute / prismatic → 1
 *   fixed                → 0
 */
export function jointDof(joint) {
    if (!joint) return 0;
    return (joint.kind === 'revolute' || joint.kind === 'prismatic') ? 1 : 0;
}

/**
 * @typedef {object} DofReport
 * @property {number} totalDof                      — whole-assembly DOF.
 * @property {Array<{componentId:string, name:string, dof:number, status:'mobile'|'locked'|'over-constrained', incomingJoints:string[]}>} components
 * @property {string[]} overConstrained             — componentIds reachable by >1 joint path.
 * @property {Array<{jointId:string, kind:string, dof:number}>} joints
 */

/**
 * Compute the assembly's degrees of freedom.
 *
 * Each revolute/prismatic joint contributes 1 DOF; fixed contributes 0. A
 * component is classified `mobile` (sum of its incoming movable joints' DOF > 0),
 * `locked` (reachable only through fixed joints / no joint), or
 * `over-constrained` (more than one incoming joint — a kinematic loop closure
 * the v1 tree solver can't satisfy simultaneously).
 *
 * @param {object} doc
 * @returns {DofReport}
 */
export function computeDof(doc) {
    const components = (doc && doc.components) || {};
    const joints = (doc && doc.joints) || {};

    // Count incoming joints per child (over-constrained = >1).
    const incoming = new Map(); // childId → joint[]
    const jointReport = [];
    let totalDof = 0;
    for (const jid of Object.keys(joints)) {
        const j = joints[jid];
        if (!j) continue;
        const dof = jointDof(j);
        totalDof += dof;
        jointReport.push({ jointId: jid, kind: j.kind, dof, child: j.child, parent: j.parent });
        if (j.child && components[j.child]) {
            const arr = incoming.get(j.child) || [];
            arr.push(j);
            incoming.set(j.child, arr);
        }
    }

    const overConstrained = [];
    const componentRows = [];
    for (const cid of Object.keys(components)) {
        if (cid === 'root') continue;
        const inc = incoming.get(cid) || [];
        const dof = inc.reduce((s, j) => s + jointDof(j), 0);
        let status;
        if (inc.length > 1) {
            status = 'over-constrained';
            overConstrained.push(cid);
        } else if (dof > 0) {
            status = 'mobile';
        } else {
            status = 'locked';
        }
        componentRows.push({
            componentId: cid,
            name: (components[cid] && components[cid].name) || cid,
            dof,
            status,
            incomingJoints: inc.map((j) => j.id),
        });
    }

    return {
        totalDof,
        components: componentRows,
        overConstrained,
        joints: jointReport.map(({ jointId, kind, dof }) => ({ jointId, kind, dof })),
    };
}

/**
 * Movable (revolute/prismatic) joints in the document, in a stable order,
 * annotated with their current drive value. Convenience for the UI panel.
 *
 * @param {object} doc
 * @returns {Array<object>}
 */
export function movableJoints(doc) {
    const joints = (doc && doc.joints) || {};
    const tree = buildKinematicTree(doc);
    const orderIndex = new Map(tree.order.map((cid, i) => [cid, i]));
    const out = [];
    for (const jid of Object.keys(joints)) {
        const j = joints[jid];
        if (!j || j.kind === 'fixed') continue;
        out.push(j);
    }
    // Order by child topo position so parents-of-chain list before tips.
    out.sort((a, b) => (orderIndex.get(a.child) ?? 1e9) - (orderIndex.get(b.child) ?? 1e9));
    return out;
}
