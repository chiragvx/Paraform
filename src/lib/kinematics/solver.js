/**
 * Forward kinematics solver — spec 17 v1 slice.
 *
 * Pure JS. No three.js dependency so this module runs cleanly under node
 * for tests. The math is plain 4×4 homogeneous transforms (row-major,
 * `m[row][col]`) — small enough to hand-roll, large enough to compose
 * joint chains correctly.
 *
 * World convention is Z-up (per CLAUDE.md). The "axis" on a joint is in
 * the parent component's local frame; FK composes axis transforms after
 * applying the joint's origin translation.
 *
 * Inputs:
 *   doc   — a folded Document (`doc.components`, `doc.joints` present).
 *   pose  — { jointId → number }  joint parameter map. Degrees for
 *           revolute, mm for prismatic. Missing entries default to 0.
 *
 * Output:
 *   { transforms: Map<componentId, mat4>, order: string[] }
 *
 * Transform semantics: each component's transform is the cumulative
 * world-from-component-local matrix. Multiply a point in component
 * coords by the transform to get world coords.
 */

// ── Mat4 utilities ──────────────────────────────────────────────────────────
// Stored as length-16 Float64Array, row-major: m[r*4+c].

/** Identity matrix. */
export function mat4Identity() {
    const m = new Float64Array(16);
    m[0] = 1; m[5] = 1; m[10] = 1; m[15] = 1;
    return m;
}

/** A × B → new. */
export function mat4Mul(a, b) {
    const out = new Float64Array(16);
    for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 4; c++) {
            let s = 0;
            for (let k = 0; k < 4; k++) s += a[r * 4 + k] * b[k * 4 + c];
            out[r * 4 + c] = s;
        }
    }
    return out;
}

/** Translation matrix. */
export function mat4Translate(x, y, z) {
    const m = mat4Identity();
    m[3] = x; m[7] = y; m[11] = z;
    return m;
}

/** Rotation about an arbitrary unit axis, radians (Rodrigues). */
export function mat4RotateAxis(axis, radians) {
    let [ax, ay, az] = axis;
    const len = Math.hypot(ax, ay, az) || 1;
    ax /= len; ay /= len; az /= len;
    const c = Math.cos(radians), s = Math.sin(radians), t = 1 - c;
    const m = mat4Identity();
    m[0]  = t * ax * ax + c;
    m[1]  = t * ax * ay - s * az;
    m[2]  = t * ax * az + s * ay;
    m[4]  = t * ax * ay + s * az;
    m[5]  = t * ay * ay + c;
    m[6]  = t * ay * az - s * ax;
    m[8]  = t * ax * az - s * ay;
    m[9]  = t * ay * az + s * ax;
    m[10] = t * az * az + c;
    return m;
}

/** Translate along a vector by `dist`. */
export function mat4TranslateAlong(axis, dist) {
    let [ax, ay, az] = axis;
    const len = Math.hypot(ax, ay, az) || 1;
    ax /= len; ay /= len; az /= len;
    return mat4Translate(ax * dist, ay * dist, az * dist);
}

/** Apply transform to a point [x,y,z] → new [x',y',z']. */
export function mat4ApplyPoint(m, p) {
    const [x, y, z] = p;
    return [
        m[0]  * x + m[1]  * y + m[2]  * z + m[3],
        m[4]  * x + m[5]  * y + m[6]  * z + m[7],
        m[8]  * x + m[9]  * y + m[10] * z + m[11],
    ];
}

// ── Component-origin transform helpers ──────────────────────────────────────
/**
 * Convert a Component.origin (position+Euler-XYZ-rad+scale) to a Mat4.
 * Scale is honoured but uniform-ish only — the AABB interference layer
 * uses transformed corners so non-uniform scale stays consistent.
 */
export function componentOriginToMat4(origin) {
    if (!origin) return mat4Identity();
    const [px, py, pz] = origin.position || [0, 0, 0];
    const [rx, ry, rz] = origin.rotation || [0, 0, 0];
    const [sx, sy, sz] = origin.scale    || [1, 1, 1];
    // Euler XYZ: R = Rx · Ry · Rz
    const Rx = mat4RotateAxis([1, 0, 0], rx);
    const Ry = mat4RotateAxis([0, 1, 0], ry);
    const Rz = mat4RotateAxis([0, 0, 1], rz);
    const R = mat4Mul(Rx, mat4Mul(Ry, Rz));
    const T = mat4Translate(px, py, pz);
    const S = mat4Identity();
    S[0] = sx; S[5] = sy; S[10] = sz;
    return mat4Mul(T, mat4Mul(R, S));
}

// ── Joint transform ─────────────────────────────────────────────────────────
/**
 * The transform a joint contributes between parent and child component
 * frames at the given joint parameter value.
 *
 *   childWorld = parentWorld × T(originInParent) × J(kind, axis, value) × T(-originInParent? no)
 *
 * v1 keeps it simple: child frame origin sits at `joint.origin` in the
 * parent frame; the joint variable rotates/translates the child frame
 * about/along `joint.axis` (also expressed in the parent frame).
 */
export function jointTransform(joint, value) {
    const T = mat4Translate(joint.origin[0], joint.origin[1], joint.origin[2]);
    let J;
    if (joint.kind === 'revolute') {
        J = mat4RotateAxis(joint.axis, (value * Math.PI) / 180); // degrees → rad
    } else if (joint.kind === 'prismatic') {
        J = mat4TranslateAlong(joint.axis, value);
    } else {
        // 'fixed' — no joint variable
        J = mat4Identity();
    }
    return mat4Mul(T, J);
}

// ── Joint pose helpers ──────────────────────────────────────────────────────
/**
 * Clamp the requested value to the joint's limits. Missing limits → 0.
 */
export function clampJointValue(joint, value) {
    if (!joint) return 0;
    const v = Number.isFinite(value) ? value : 0;
    const min = Number.isFinite(joint.limits?.min) ? joint.limits.min : -Infinity;
    const max = Number.isFinite(joint.limits?.max) ? joint.limits.max : Infinity;
    return Math.max(min, Math.min(max, v));
}

// ── Topology resolution ────────────────────────────────────────────────────
/**
 * Build the kinematic tree from joints. Each joint says child←parent;
 * we orient every component to its parent and detect/skip cycles.
 *
 * Returns:
 *   {
 *     parentJoint: Map<childComponentId, joint>,
 *     roots: Set<componentId>            — components with no incoming joint
 *     order: string[]                    — topo order, parents before children
 *   }
 */
export function buildKinematicTree(doc) {
    const components = (doc && doc.components) || {};
    const joints = (doc && doc.joints) || {};
    const componentIds = Object.keys(components);
    const parentJoint = new Map();
    for (const jid of Object.keys(joints)) {
        const j = joints[jid];
        if (!j || !j.child) continue;
        if (!components[j.child]) continue;
        // first joint per child wins (later joints over-constraining are skipped)
        if (!parentJoint.has(j.child)) parentJoint.set(j.child, j);
    }
    const roots = new Set();
    for (const cid of componentIds) {
        if (!parentJoint.has(cid)) roots.add(cid);
    }
    // Topo order via DFS from roots; cycle-safe via visited set.
    const order = [];
    const visited = new Set();
    const childrenOf = new Map();
    for (const [cid, j] of parentJoint) {
        const arr = childrenOf.get(j.parent) || [];
        arr.push(cid);
        childrenOf.set(j.parent, arr);
    }
    function visit(cid) {
        if (visited.has(cid)) return;
        visited.add(cid);
        order.push(cid);
        const kids = childrenOf.get(cid) || [];
        for (const k of kids) visit(k);
    }
    for (const r of roots) visit(r);
    // Any unvisited components (orphans or inside a cycle) get appended.
    for (const cid of componentIds) {
        if (!visited.has(cid)) order.push(cid);
    }
    return { parentJoint, roots, order };
}

// ── Forward kinematics ─────────────────────────────────────────────────────
/**
 * @param {Document} doc
 * @param {Record<string, number>} [pose]   joint parameter map by jointId
 * @returns {{ transforms: Map<string, Float64Array>, order: string[] }}
 */
export function solveForwardKinematics(doc, pose = {}) {
    const tree = buildKinematicTree(doc);
    const transforms = new Map();
    const components = (doc && doc.components) || {};
    for (const cid of tree.order) {
        const comp = components[cid];
        const localOrigin = componentOriginToMat4(comp && comp.origin);
        const parentJoint = tree.parentJoint.get(cid);
        if (!parentJoint) {
            transforms.set(cid, localOrigin);
            continue;
        }
        const parentT = transforms.get(parentJoint.parent) || mat4Identity();
        const rawValue = pose && Object.prototype.hasOwnProperty.call(pose, parentJoint.id)
            ? pose[parentJoint.id]
            : 0;
        const value = clampJointValue(parentJoint, rawValue);
        const jT = jointTransform(parentJoint, value);
        const world = mat4Mul(parentT, mat4Mul(jT, localOrigin));
        transforms.set(cid, world);
    }
    return { transforms, order: tree.order };
}
