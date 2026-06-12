/**
 * Spec 18 v1 — KSP-style mate solver.
 *
 * Pure SE(3) math: given a *host* connector in world coordinates and a
 * *part* connector in its part-local coordinates, compute the rigid
 * transform that places the part such that its connector aligns to the
 * host's connector.
 *
 * Mate alignment rules (v1):
 *
 *   - thread / bore / shaft: axes anti-parallel (the male connector
 *     points *into* the female's frame), origins coincident.
 *   - planar:                axes anti-parallel (one normal mates against
 *     the other), origins coincident.
 *   - rail:                  axes parallel (slider runs along the rail),
 *     origins coincident.
 *   - tab / slot:            axes anti-parallel, origins coincident.
 *
 * Compatibility (`connectorsCompatible`) checks:
 *   - kind in mates_with on both sides
 *   - gender complement (male ↔ female; neutral ↔ anything)
 *   - size match (within tolerance for numeric, exact for nominal strings)
 *
 * Induced joints (`inducedJointFromMate`):
 *   - bore (female bearing-ID) + shaft (male) → revolute (axis = bore.axis)
 *   - rail-rail                                → prismatic
 *   - thread/thread, planar/planar, tab/slot   → fixed
 *
 * No three.js dependency — outputs plain 4×4 row-major arrays so the
 * Viewport can apply them via `Matrix4.fromArray()` and the headless
 * tests can verify them with assert.
 */

const TAU_GENDER_COMPLEMENT = {
    male:   new Set(['female', 'neutral']),
    female: new Set(['male',   'neutral']),
    neutral:new Set(['male', 'female', 'neutral']),
};

const SIZE_TOL_MM = 0.5;   // mm — bore vs shaft within 0.5 mm counts as a fit

// ── Vector / matrix primitives ──────────────────────────────────────────────

function _vec3Normalize(v) {
    const x = v[0], y = v[1], z = v[2];
    const m = Math.hypot(x, y, z);
    if (m < 1e-9) return [0, 0, 1];
    return [x / m, y / m, z / m];
}

function _vec3Cross(a, b) {
    return [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ];
}

function _vec3Dot(a, b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function _vec3Neg(v) { return [-v[0], -v[1], -v[2]]; }

/**
 * Build a 3×3 rotation matrix (row-major flat) that maps unit vector `from`
 * to unit vector `to` via Rodrigues' formula. If they're already aligned,
 * returns identity; if anti-parallel, picks an arbitrary perpendicular
 * axis for a 180° rotation.
 */
function _rotBetween(from, to) {
    const f = _vec3Normalize(from);
    const t = _vec3Normalize(to);
    const d = _vec3Dot(f, t);
    if (d > 0.999999) {
        return [1, 0, 0, 0, 1, 0, 0, 0, 1];
    }
    if (d < -0.999999) {
        // Anti-parallel — pick a perpendicular axis.
        let axis = Math.abs(f[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
        axis = _vec3Normalize(_vec3Cross(f, axis));
        const x = axis[0], y = axis[1], z = axis[2];
        // 180° rotation about axis: R = 2*aaᵀ - I
        return [
            2 * x * x - 1, 2 * x * y,     2 * x * z,
            2 * y * x,     2 * y * y - 1, 2 * y * z,
            2 * z * x,     2 * z * y,     2 * z * z - 1,
        ];
    }
    const k = _vec3Cross(f, t);
    const s = Math.hypot(k[0], k[1], k[2]);
    const c = d;
    const K = [
        [0,    -k[2],  k[1]],
        [k[2],  0,    -k[0]],
        [-k[1], k[0],  0  ],
    ];
    const K2 = [
        [K[0][0]*K[0][0] + K[0][1]*K[1][0] + K[0][2]*K[2][0],
         K[0][0]*K[0][1] + K[0][1]*K[1][1] + K[0][2]*K[2][1],
         K[0][0]*K[0][2] + K[0][1]*K[1][2] + K[0][2]*K[2][2]],
        [K[1][0]*K[0][0] + K[1][1]*K[1][0] + K[1][2]*K[2][0],
         K[1][0]*K[0][1] + K[1][1]*K[1][1] + K[1][2]*K[2][1],
         K[1][0]*K[0][2] + K[1][1]*K[1][2] + K[1][2]*K[2][2]],
        [K[2][0]*K[0][0] + K[2][1]*K[1][0] + K[2][2]*K[2][0],
         K[2][0]*K[0][1] + K[2][1]*K[1][1] + K[2][2]*K[2][1],
         K[2][0]*K[0][2] + K[2][1]*K[1][2] + K[2][2]*K[2][2]],
    ];
    const scale = s > 1e-9 ? (1 - c) / (s * s) : 0;
    const R = [
        1 + K[0][0] + scale * K2[0][0], K[0][1] + scale * K2[0][1], K[0][2] + scale * K2[0][2],
        K[1][0] + scale * K2[1][0], 1 + K[1][1] + scale * K2[1][1], K[1][2] + scale * K2[1][2],
        K[2][0] + scale * K2[2][0], K[2][1] + scale * K2[2][1], 1 + K[2][2] + scale * K2[2][2],
    ];
    return R;
}

/** Apply a 3×3 (row-major flat) rotation to a 3-vector. */
function _rotApply(R, v) {
    return [
        R[0] * v[0] + R[1] * v[1] + R[2] * v[2],
        R[3] * v[0] + R[4] * v[1] + R[5] * v[2],
        R[6] * v[0] + R[7] * v[1] + R[8] * v[2],
    ];
}

/** Multiply two 3×3 row-major matrices: returns A·B. */
function _mat3Mul(A, B) {
    const out = new Array(9).fill(0);
    for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) {
            out[r * 3 + c] =
                A[r * 3 + 0] * B[0 * 3 + c] +
                A[r * 3 + 1] * B[1 * 3 + c] +
                A[r * 3 + 2] * B[2 * 3 + c];
        }
    }
    return out;
}

/**
 * Rotation (3×3 row-major) of `angle` radians about unit axis `axis`
 * (Rodrigues). Used to apply a user-driven *roll* about a mate axis so a
 * placed part can be spun to fit without breaking the mate.
 */
function _rotAboutAxis(axis, angle) {
    const a = _vec3Normalize(axis);
    const x = a[0], y = a[1], z = a[2];
    const c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
    return [
        t * x * x + c,     t * x * y - s * z, t * x * z + s * y,
        t * x * y + s * z, t * y * y + c,     t * y * z - s * x,
        t * x * z - s * y, t * y * z + s * x, t * z * z + c,
    ];
}

/** Pack 3×3 R + 3-vec t into a 4×4 row-major SE(3). */
function _se3From(R, t) {
    return [
        R[0], R[1], R[2], t[0],
        R[3], R[4], R[5], t[1],
        R[6], R[7], R[8], t[2],
        0,    0,    0,    1,
    ];
}

/**
 * Recover Euler XYZ rotation (radians) from a 3×3 R.
 *
 * CONVENTION: THREE.Euler order 'XYZ' — R = Rx·Ry·Rz (row-major). This MUST
 * stay in lock-step with the two other consumers of Component.origin.rotation:
 * emit.js `_mat4FromPosEuler` (kernel bake via build123d Location) and
 * snap_frames.js `composeMatrix` (live drag preview). The solver previously
 * composed R = Rz·Ry·Rx, which agrees for single-axis rotations but bakes
 * compound orientations (slot mate + roll, rotated host) wrong.
 * Mirrors THREE.Euler.setFromRotationMatrix('XYZ').
 */
function _eulerXYZFromR(R) {
    const m13 = Math.min(1, Math.max(-1, R[2]));
    const y = Math.asin(m13);
    let x, z;
    if (Math.abs(m13) < 0.9999999) {
        x = Math.atan2(-R[5], R[8]);
        z = Math.atan2(-R[1], R[0]);
    } else {
        x = Math.atan2(R[7], R[4]);
        z = 0;
    }
    return [x, y, z];
}

// ── Public: compatibility check ──────────────────────────────────────────────

/**
 * Two connectors mate iff:
 *   - Each side's `kind` is in the other's `mates_with`, OR the kinds match
 *     directly when either side has an empty `mates_with` list (the
 *     "derived connector" path used by `src/lib/snap/derive.js` for
 *     implicit planar / bore / shaft connectors extracted from raw
 *     geometry — those carry no explicit `mates_with` table).
 *   - Genders are complementary (male↔female; neutral↔anything).
 *   - Nominal sizes match within `SIZE_TOL_MM` (numeric) or exactly
 *     (string nominal like "M3", "MGN12"). The sentinel `'auto'` or
 *     `'unspecified'` on either side matches any size (used by derived
 *     connectors that don't know the host's nominal size).
 *
 * Interface contracts (Phase 2): if BOTH connectors declare a non-empty
 * `interfaceId`, compatibility is decided *solely* by id equality — this
 * takes precedence over the kind/gender/size heuristic below. This lets a
 * part author state "these physically interchange" (e.g. SG90 and MG90S both
 * declare `servo-mount-9g`) without having to align kind/gender/size. If only
 * one side (or neither) declares an `interfaceId`, the legacy kind/gender/size
 * logic runs unchanged, so existing connectors behave exactly as before.
 *
 * @param {Connector} a
 * @param {Connector} b
 * @returns {boolean}
 */
export function connectorsCompatible(a, b) {
    if (!a || !b) return false;

    // Port-model v2 profile fast-path: when either side is a line/slot port
    // and BOTH declare a cross-section `profile`, compatibility is decided by
    // profile equality (plus gender complement). This lets a sliding nut
    // (rail) mate the matching extrusion channel (slot) without forcing their
    // legacy kind/interfaceId to align. Checked BEFORE interfaceId so the
    // extrusion's end-bore interfaceId ('profile-2020') can't veto the slot.
    const aLine = a.topology === 'line' || a.kind === 'slot' || a.kind === 'rail';
    const bLine = b.topology === 'line' || b.kind === 'slot' || b.kind === 'rail';
    if ((aLine || bLine) && a.profile && b.profile) {
        if (a.profile !== b.profile) return false;
        const ag = TAU_GENDER_COMPLEMENT[a.gender] || TAU_GENDER_COMPLEMENT.neutral;
        return ag.has(b.gender);
    }

    // Interface-contract fast path: both sides declare an interfaceId →
    // match iff equal. Precedence over kind/gender/size.
    const aIface = (typeof a.interfaceId === 'string' && a.interfaceId.length) ? a.interfaceId : null;
    const bIface = (typeof b.interfaceId === 'string' && b.interfaceId.length) ? b.interfaceId : null;
    if (aIface && bIface) {
        return aIface === bIface;
    }

    const aMates = Array.isArray(a.mates_with) ? a.mates_with : [];
    const bMates = Array.isArray(b.mates_with) ? b.mates_with : [];
    const aAcceptsB = aMates.length === 0 ? (a.kind === b.kind) : aMates.includes(b.kind);
    const bAcceptsA = bMates.length === 0 ? (a.kind === b.kind) : bMates.includes(a.kind);
    if (!aAcceptsB || !bAcceptsA) return false;

    const aGender = TAU_GENDER_COMPLEMENT[a.gender] || TAU_GENDER_COMPLEMENT.neutral;
    if (!aGender.has(b.gender)) return false;

    // Size match. Auto / unspecified on either side passes (derived
    // connectors don't know the host's nominal size).
    const aSize = (a.size && a.size.nominal !== undefined) ? a.size.nominal : null;
    const bSize = (b.size && b.size.nominal !== undefined) ? b.size.nominal : null;
    if (aSize == null || bSize == null) return true;
    const aStr = String(aSize).toLowerCase();
    const bStr = String(bSize).toLowerCase();
    if (aStr === 'auto' || aStr === 'unspecified' ||
        bStr === 'auto' || bStr === 'unspecified') return true;

    const aNum = Number(aSize);
    const bNum = Number(bSize);
    if (Number.isFinite(aNum) && Number.isFinite(bNum)) {
        return Math.abs(aNum - bNum) <= SIZE_TOL_MM;
    }
    return aStr === bStr;
}

// ── Public: mate-transform solver ────────────────────────────────────────────

/**
 * Compute the SE(3) (4×4 row-major) that, applied to the part's local
 * frame, puts the part's `partConnector` exactly onto the host's
 * `hostConnectorWorld`.
 *
 * The math:
 *   1. Build the desired part-axis-in-world: `-hostAxis` for
 *      thread/bore/shaft/planar/tab/slot; `+hostAxis` for rail.
 *   2. Build R = rotation that maps `partConnector.axis` (in part frame)
 *      → desired-axis-in-world.
 *   3. Build t = hostOrigin − R · partConnector.origin.
 *
 * @param {object} hostConnectorWorld — { kind, axis:[…], origin:[…] } in world
 * @param {Connector} partConnector   — connector record on the part (local)
 * @returns {{ matrix: number[16], euler: [number,number,number], position: [number,number,number] }}
 */
export function solveMateTransform(hostConnectorWorld, partConnector, opts = {}) {
    if (!hostConnectorWorld || !partConnector) {
        return { matrix: _identity4(), euler: [0, 0, 0], position: [0, 0, 0] };
    }

    // Port-model v2 — slot/line mate: a 1-D channel needs a *two-axis* (full
    // frame) alignment, not the single-axis rotation below. We align the
    // part's slide axis to the channel run AND the part's seating normal to
    // the face outward normal, then drop the part into the channel and leave a
    // slide DOF. Triggered when the host is a line port carrying a `normal`.
    const hostIsLine = (hostConnectorWorld.topology === 'line' || hostConnectorWorld.kind === 'slot')
        && Array.isArray(hostConnectorWorld.normal);
    const partIsRail = partConnector.kind === 'rail' || partConnector.kind === 'slot'
        || partConnector.topology === 'line';
    if (hostIsLine && partIsRail) {
        return solveSlotMate(hostConnectorWorld, partConnector, opts);
    }

    const hostAxis = _vec3Normalize(hostConnectorWorld.axis || [0, 0, 1]);
    const partAxis = _vec3Normalize(partConnector.axis || [0, 0, 1]);

    const targetAxis = (partConnector.kind === 'rail' || hostConnectorWorld.kind === 'rail')
        ? hostAxis
        : _vec3Neg(hostAxis);

    let R = _rotBetween(partAxis, targetAxis);
    // Optional user roll about the mate axis. The single-axis mate above pins
    // only the part's connector axis to the host; the remaining spin around
    // that axis is free, so a part can land in any roll (a bracket's holes
    // pointing the "wrong" way, a nut's flats off-grid). `opts.roll` (radians)
    // rotates the whole part about the world mate axis so the user can dial in
    // the orientation — this is what the keyboard rotate-to-fit feeds. Compose
    // in the world frame (Rroll · R) so roll is about the host axis, not the
    // part's pre-mate local axis.
    if (Number.isFinite(opts.roll) && opts.roll !== 0) {
        R = _mat3Mul(_rotAboutAxis(targetAxis, opts.roll), R);
    }
    const partOrigin = partConnector.origin || [0, 0, 0];
    const rotated = _rotApply(R, partOrigin);
    const hostOrigin = hostConnectorWorld.origin || [0, 0, 0];
    const t = [
        hostOrigin[0] - rotated[0],
        hostOrigin[1] - rotated[1],
        hostOrigin[2] - rotated[2],
    ];
    return {
        matrix: _se3From(R, t),
        euler: _eulerXYZFromR(R),
        position: t,
    };
}

/**
 * Build a 3×3 rotation (row-major flat) that maps the part frame (slide axis
 * `fS`, seating normal `fN`) onto the host frame (run `hS`, face normal `hN`).
 * Each frame is orthonormalised (Gram–Schmidt) before composing R = Hw·Hpᵀ.
 */
function _rotFromFrames(fS, fN, hS, hN) {
    const buildFrame = (s, n) => {
        const e1 = _vec3Normalize(s);
        const d = _vec3Dot(n, e1);
        let e2 = _vec3Normalize([n[0] - d * e1[0], n[1] - d * e1[1], n[2] - d * e1[2]]);
        const e3 = _vec3Cross(e1, e2);
        return [e1, e2, e3];
    };
    const [a1, a2, a3] = buildFrame(fS, fN);   // part
    const [b1, b2, b3] = buildFrame(hS, hN);   // host (world)
    // R = [b1 b2 b3] (cols) · [a1 a2 a3]ᵀ (rows). R·a_i = b_i.
    const R = new Array(9).fill(0);
    for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) {
            R[r * 3 + c] = b1[r] * a1[c] + b2[r] * a2[c] + b3[r] * a3[c];
        }
    }
    return R;
}

/**
 * Slot/line mate solver. Places `partConnector` (a sliding nut's rail/slot
 * port) into `hostConnectorWorld` (an extrusion channel) so the part sits *in*
 * the channel, seating normal facing out, with a slide DOF along the run.
 *
 *   1. Frame-align: part slide-axis → host run; part normal → host face normal.
 *   2. Translate so the part port origin meets the channel surface point.
 *   3. Drop into the channel by `seatDepth` (host metadata) along −faceNormal.
 *   4. Optional `opts.slide` mm shifts the part along the run, clamped to the
 *      host `extent` so it can't slide off the ends.
 *
 * Returns the standard {matrix, euler, position} plus `joint` describing the
 * induced prismatic (axis = run, limits = extent).
 */
export function solveSlotMate(hostConnectorWorld, partConnector, opts = {}) {
    const runW    = _vec3Normalize(hostConnectorWorld.axis || [0, 0, 1]);
    const normW   = _vec3Normalize(hostConnectorWorld.normal || [1, 0, 0]);
    const slideP  = _vec3Normalize(partConnector.axis || [1, 0, 0]);
    const normP   = _vec3Normalize(partConnector.normal || [0, 0, 1]);

    let R = _rotFromFrames(slideP, normP, runW, normW);
    // Optional roll about the host FACE NORMAL (not the run): the only spin a
    // channel-seated part can physically take is flipping in place — its
    // seating normal stays pinned to the face, while the slide axis swings in
    // the face plane (180° = reverse along the run). Composed in the world
    // frame so the part pivots about the face it's seated on. Feeds the
    // keyboard rotate-to-fit for slot-mated parts.
    if (Number.isFinite(opts.roll) && opts.roll !== 0) {
        R = _mat3Mul(_rotAboutAxis(normW, opts.roll), R);
    }
    const partOrigin = partConnector.origin || [0, 0, 0];
    const rotated = _rotApply(R, partOrigin);
    const hostOrigin = hostConnectorWorld.origin || [0, 0, 0];

    const seatDepth = Number.isFinite(hostConnectorWorld.seatDepth)
        ? hostConnectorWorld.seatDepth
        : (hostConnectorWorld.metadata && Number.isFinite(hostConnectorWorld.metadata.seatDepth)
            ? hostConnectorWorld.metadata.seatDepth : 0);

    // Slide along the run, clamped to the channel extent.
    const ext = hostConnectorWorld.extent || null;
    let slide = Number.isFinite(opts.slide) ? opts.slide : 0;
    if (ext) slide = Math.max(ext.from, Math.min(ext.to, slide));

    const t = [
        hostOrigin[0] - rotated[0] - normW[0] * seatDepth + runW[0] * slide,
        hostOrigin[1] - rotated[1] - normW[1] * seatDepth + runW[1] * slide,
        hostOrigin[2] - rotated[2] - normW[2] * seatDepth + runW[2] * slide,
    ];
    return {
        matrix: _se3From(R, t),
        euler: _eulerXYZFromR(R),
        position: t,
        joint: {
            kind: 'prismatic',
            axis: runW.slice(),
            limits: ext ? { lower: ext.from, upper: ext.to } : null,
        },
    };
}

function _identity4() {
    return [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
}

/**
 * Compose an extra `angle` (radians) roll about world `axis` onto an existing
 * Euler XYZ orientation, returning the resulting Euler XYZ. Used by the
 * keyboard rotate-to-fit path for *free* placements (no mate to re-solve):
 * R_new = R_axis · R_euler, in the world frame so the part spins about the
 * given world axis (typically +Z for a part sitting on the ground).
 *
 * @param {[number,number,number]} euler — current XYZ rotation (radians)
 * @param {[number,number,number]} axis  — world axis to roll about
 * @param {number} angle                 — radians
 * @returns {[number,number,number]} new XYZ rotation (radians)
 */
export function eulerAfterRoll(euler, axis, angle) {
    const e = Array.isArray(euler) ? euler : [0, 0, 0];
    const Rcur = _eulerXYZToR(e[0] || 0, e[1] || 0, e[2] || 0);
    const Rnew = _mat3Mul(_rotAboutAxis(axis || [0, 0, 1], angle || 0), Rcur);
    return _eulerXYZFromR(Rnew);
}

// ── Public: world-frame connector resolution ────────────────────────────────

/**
 * Walk the parent-component chain from `componentId` up to root, accumulating
 * each component's `origin` (Euler XYZ + position) into a single 4×4. v1
 * ignores per-component scale (asserted = [1,1,1] across the codebase).
 *
 * Returns identity for missing components or root.
 *
 * @param {object} doc — DocumentStore.doc
 * @param {string} componentId
 * @returns {number[16]} row-major 4×4
 */
export function componentWorldMatrix(doc, componentId) {
    if (!doc || !doc.components || !componentId) return _identity4();
    const chain = [];
    let cur = componentId;
    let guard = 64;
    while (cur && cur !== 'root' && guard-- > 0) {
        const c = doc.components[cur];
        if (!c) break;
        chain.push(c);
        cur = c.parentId || 'root';
    }
    // Multiply root-down so children inherit parent transforms.
    let M = _identity4();
    for (let i = chain.length - 1; i >= 0; i--) {
        const c = chain[i];
        const origin = c.origin || {};
        const pos = Array.isArray(origin.position) ? origin.position : [0, 0, 0];
        const rot = Array.isArray(origin.rotation) ? origin.rotation : [0, 0, 0];
        const R = _eulerXYZToR(rot[0] || 0, rot[1] || 0, rot[2] || 0);
        const T = _se3From(R, pos);
        M = _mat4Mul(M, T);
    }
    return M;
}

/**
 * Take a connector stored in component-local coords and return its world-frame
 * `{ kind, axis, origin }` tuple — what `solveMateTransform`'s first argument
 * expects. The walk goes up the parent chain via `componentWorldMatrix`.
 *
 * @param {object} doc
 * @param {Connector} connector — must have `.parent` set to a componentId
 * @returns {{ kind: string, axis: [number,number,number], origin: [number,number,number] }}
 */
export function worldConnectorFor(doc, connector) {
    if (!connector) return { kind: 'planar', axis: [0,0,1], origin: [0,0,0] };
    const M = componentWorldMatrix(doc, connector.parent);
    const origin = connector.origin || [0, 0, 0];
    const axis   = connector.axis   || [0, 0, 1];
    const world = {
        kind:   connector.kind || 'planar',
        origin: _mat4ApplyPoint(M, origin),
        axis:   _mat4ApplyDir(M, axis),
    };
    // Port-model v2 — carry the richer-mating fields into the world frame so
    // the slot solver can read them. `normal` is a direction (no translation);
    // `extent`/`profile`/`fit`/`topology`/seatDepth are frame-independent.
    if (connector.topology) world.topology = connector.topology;
    if (Array.isArray(connector.normal)) world.normal = _mat4ApplyDir(M, connector.normal);
    if (connector.extent) world.extent = { from: connector.extent.from, to: connector.extent.to };
    if (connector.profile) world.profile = connector.profile;
    if (connector.fit) world.fit = connector.fit;
    if (connector.metadata && Number.isFinite(connector.metadata.seatDepth)) {
        world.seatDepth = connector.metadata.seatDepth;
    }
    return world;
}

// ── Internal matrix helpers used above ─────────────────────────────────────

function _eulerXYZToR(x, y, z) {
    const cx = Math.cos(x), sx = Math.sin(x);
    const cy = Math.cos(y), sy = Math.sin(y);
    const cz = Math.cos(z), sz = Math.sin(z);
    // R = Rx·Ry·Rz — THREE.Euler 'XYZ', matches _eulerXYZFromR's recovery
    // and emit.js / snap_frames.js (see the convention note above).
    return [
        cy * cz,                -cy * sz,                sy,
        cx * sz + sx * sy * cz,  cx * cz - sx * sy * sz, -sx * cy,
        sx * sz - cx * sy * cz,  sx * cz + cx * sy * sz,  cx * cy,
    ];
}

function _mat4Mul(A, B) {
    const out = new Array(16).fill(0);
    for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 4; c++) {
            let s = 0;
            for (let k = 0; k < 4; k++) s += A[r * 4 + k] * B[k * 4 + c];
            out[r * 4 + c] = s;
        }
    }
    return out;
}

function _mat4ApplyPoint(M, p) {
    return [
        M[0] * p[0] + M[1] * p[1] + M[2]  * p[2] + M[3],
        M[4] * p[0] + M[5] * p[1] + M[6]  * p[2] + M[7],
        M[8] * p[0] + M[9] * p[1] + M[10] * p[2] + M[11],
    ];
}

function _mat4ApplyDir(M, v) {
    return [
        M[0] * v[0] + M[1] * v[1] + M[2]  * v[2],
        M[4] * v[0] + M[5] * v[1] + M[6]  * v[2],
        M[8] * v[0] + M[9] * v[1] + M[10] * v[2],
    ];
}

// ── Public: induced joints ───────────────────────────────────────────────────

/**
 * Pick the joint kind that the mate pair implies. Reads both connectors'
 * `inducedJoint` field and combines them with a small precedence table.
 *
 *   bore (female, inducedJoint='revolute') + shaft  → revolute
 *   rail + rail                                     → prismatic
 *   otherwise                                       → fixed
 *
 * Returns `null` if either side explicitly opts out (`inducedJoint: 'none'`,
 * not implemented in v1).
 *
 * @param {Connector} a
 * @param {Connector} b
 * @returns {'fixed'|'revolute'|'prismatic'|null}
 */
export function inducedJointFromMate(a, b) {
    if (!a || !b) return null;
    // Slot/line channel + sliding part → prismatic (port-model v2).
    const aSlide = a.topology === 'line' || a.kind === 'slot' || a.kind === 'rail';
    const bSlide = b.topology === 'line' || b.kind === 'slot' || b.kind === 'rail';
    if (aSlide && bSlide) return 'prismatic';
    // Rail pair → prismatic.
    if (a.kind === 'rail' && b.kind === 'rail') return 'prismatic';
    // Bore + shaft, with at least one side marked revolute → revolute.
    if (
        (a.kind === 'bore' && b.kind === 'shaft') ||
        (a.kind === 'shaft' && b.kind === 'bore')
    ) {
        if (a.inducedJoint === 'revolute' || b.inducedJoint === 'revolute') {
            return 'revolute';
        }
        return 'fixed';
    }
    // Otherwise the more restrictive side wins; default fixed.
    const ranking = { revolute: 3, prismatic: 2, fixed: 1, null: 0, undefined: 0 };
    const sa = ranking[a.inducedJoint] || 0;
    const sb = ranking[b.inducedJoint] || 0;
    if (sa === 0 && sb === 0) return 'fixed';
    if (sa >= sb) return a.inducedJoint || 'fixed';
    return b.inducedJoint || 'fixed';
}

// ── Test seam — expose internals to the test suite ──────────────────────────
export const __test__ = {
    _vec3Normalize, _vec3Cross, _vec3Dot, _rotBetween, _rotApply, _eulerXYZFromR,
    _rotAboutAxis, _mat3Mul, _eulerXYZToR,
};
