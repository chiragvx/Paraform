/**
 * Eval scorer — pure, kernel-free evaluation of a compiled document against a
 * task spec.
 *
 *   scoreTask(task, docResult) → TaskScore
 *   scoreCheck(check, docResult) → CheckResult
 *
 * The scorer NEVER touches the live kernel, network, or three.js. It scores a
 * plain *measured* result object (`DocResult`) that some caller has already
 * extracted from a compiled build — exactly the shape the kernel's geometry
 * extraction + the mate solver already produce. That separation is deliberate:
 * the runner (online) compiles; the scorer (offline, deterministic, unit
 * testable) judges. The same scorer judges synthesized triplets in
 * `data_synth.js`'s `verifyTriplet`, so a triplet can never enter the dataset
 * unless its geometry actually satisfies its own spec.
 *
 * Every check is expressed as *data* in `benchmark/tasks.js` (see that file for
 * the closed set of `kind`s). A check returns { check, passed, expected,
 * actual } — never throws. A missing measured field is a FAIL (not a crash),
 * because "we couldn't measure it" must not silently pass an acceptance gate.
 *
 * Determinism: no Date.now / Math.random anywhere in this file. Float compares
 * use an explicit mm tolerance (`TOL_MM`), matching the size tolerance the mate
 * solver uses for nominal sizes.
 */

// Geometric comparison tolerance, mm. Lines up with SIZE_TOL_MM in the mate
// solver so a "5 mm" acceptance and a "5 mm" mate agree on what counts as equal.
export const TOL_MM = 0.25;

/**
 * @typedef {object} MateResult
 * @property {boolean} solved        — did the mate solver land a finite transform?
 * @property {('fixed'|'revolute'|'prismatic'|null)} inducedJoint
 * @property {string} [hostConnectorId]
 * @property {string} [partConnectorId]
 */

/**
 * The measured result of compiling a document. Plain data — produced by the
 * kernel geometry extraction + the mate solver, consumed by the scorer. All
 * fields optional; an absent field fails any check that needs it.
 *
 * @typedef {object} DocResult
 * @property {{ min:[number,number,number], max:[number,number,number] }} [bbox]
 *           — overall axis-aligned bounding box, world mm, Z-up.
 * @property {number} [volume]        — total solid volume, mm³.
 * @property {number} [solidCount]    — number of disjoint solids in the result.
 * @property {number} [holeCount]     — number of through/blind holes drilled.
 * @property {boolean} [interference] — true = two parts overlap (clash).
 * @property {MateResult[]} [mates]   — one entry per recorded mate.
 * @property {Array<{ origin:[number,number,number], aligned:boolean }>} [casingBosses]
 *           — screw bosses in a generated casing and whether each lines up with
 *           its lid counterpart.
 * @property {boolean} [swapStable]   — did the last replace_component keep every
 *           mate bound (no unresolved)?
 * @property {Array<{ origin:[number,number,number] }>} [holes]
 *           — drilled-hole entry points, world mm (for mustNotHaveHoleAt).
 * @property {number} [chamferDistance] — single-part metric placeholder (mm).
 * @property {number} [iou]             — single-part metric placeholder [0..1].
 */

/**
 * @typedef {object} CheckResult
 * @property {object} check     — the original check record (echoed back).
 * @property {boolean} passed
 * @property {*} expected
 * @property {*} actual
 */

/**
 * @typedef {object} TaskScore
 * @property {string} taskId
 * @property {boolean} passed   — every acceptance + negative + assembly check passed.
 * @property {number} total     — number of checks evaluated.
 * @property {number} passedCount
 * @property {Array<{check:object, expected:*, actual:*}>} failures
 * @property {number} score     — passedCount / total in [0..1] (1 when total===0).
 */

// ── leaf helpers ─────────────────────────────────────────────────────────────

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const approx = (a, b, tol = TOL_MM) =>
    a != null && b != null && Math.abs(a - b) <= tol;

/** Pull a numeric bbox extent for an axis, or null if the bbox is absent. */
function bboxExtent(docResult, axis) {
    const i = { x: 0, y: 1, z: 2 }[axis];
    if (i === undefined) return null;
    const b = docResult && docResult.bbox;
    if (!b || !Array.isArray(b.min) || !Array.isArray(b.max)) return null;
    const lo = num(b.min[i]);
    const hi = num(b.max[i]);
    if (lo == null || hi == null) return null;
    return { min: lo, max: hi, size: hi - lo };
}

const mateList = (docResult) => (Array.isArray(docResult && docResult.mates) ? docResult.mates : []);

// ── the single check evaluator ───────────────────────────────────────────────

/**
 * Evaluate one acceptance / negative / assembly check against a DocResult.
 * Pure; never throws. An unknown `kind` fails closed with a clear `actual`.
 *
 * @param {object} check
 * @param {DocResult} docResult
 * @returns {CheckResult}
 */
export function scoreCheck(check, docResult) {
    const c = check || {};
    const res = (passed, expected, actual) => ({ check: c, passed: !!passed, expected, actual });
    const dr = docResult || {};

    switch (c.kind) {
        // ── single-part dimensional checks ───────────────────────────────────
        case 'bbox': {
            const ext = bboxExtent(dr, c.axis);
            if (!ext) return res(false, { axis: c.axis, min: c.min, max: c.max }, 'no bbox measured');
            // `min`/`max` bound the extent on that axis; either may be omitted.
            let ok = true;
            if (c.min !== undefined) ok = ok && (ext.min >= num(c.min) - TOL_MM);
            if (c.max !== undefined) ok = ok && (ext.max <= num(c.max) + TOL_MM);
            if (c.size !== undefined) ok = ok && approx(ext.size, num(c.size));
            return res(ok, { axis: c.axis, min: c.min, max: c.max, size: c.size }, ext);
        }
        case 'bboxSize': {
            // Whole-box size triple {x,y,z} (any subset).
            const out = {};
            let ok = true;
            for (const axis of ['x', 'y', 'z']) {
                if (c[axis] === undefined) continue;
                const ext = bboxExtent(dr, axis);
                out[axis] = ext ? ext.size : null;
                ok = ok && ext != null && approx(ext.size, num(c[axis]));
            }
            return res(ok, { x: c.x, y: c.y, z: c.z }, out);
        }
        case 'volume': {
            const v = num(dr.volume);
            const ok = v != null &&
                (c.min === undefined || v >= num(c.min)) &&
                (c.max === undefined || v <= num(c.max)) &&
                (c.equals === undefined || approx(v, num(c.equals), c.tol != null ? num(c.tol) : 1));
            return res(ok, { equals: c.equals, min: c.min, max: c.max }, v);
        }
        case 'solidCount': {
            const n = num(dr.solidCount);
            const ok = n != null &&
                (c.equals === undefined || n === num(c.equals)) &&
                (c.min === undefined || n >= num(c.min)) &&
                (c.max === undefined || n <= num(c.max));
            return res(ok, { equals: c.equals, min: c.min, max: c.max }, n);
        }
        case 'holeCount': {
            const n = num(dr.holeCount);
            const ok = n != null &&
                (c.equals === undefined || n === num(c.equals)) &&
                (c.min === undefined || n >= num(c.min)) &&
                (c.max === undefined || n <= num(c.max));
            return res(ok, { equals: c.equals, min: c.min, max: c.max }, n);
        }
        case 'noInterference': {
            // Pass when interference is explicitly false. An undefined measure
            // fails closed — we must not claim "no clash" we never checked.
            const measured = dr.interference;
            return res(measured === false, false, measured === undefined ? 'not measured' : measured);
        }

        // ── negative checks ───────────────────────────────────────────────────
        case 'mustNotHaveHoleAt': {
            const want = Array.isArray(c.origin) ? c.origin.map(num) : null;
            const holes = Array.isArray(dr.holes) ? dr.holes : [];
            const tol = c.tol != null ? num(c.tol) : TOL_MM;
            const offender = want && holes.find((h) =>
                Array.isArray(h.origin) &&
                approx(num(h.origin[0]), want[0], tol) &&
                approx(num(h.origin[1]), want[1], tol) &&
                approx(num(h.origin[2]), want[2], tol));
            return res(!offender, `no hole at [${(c.origin || []).join(', ')}]`,
                offender ? `hole present at [${offender.origin.join(', ')}]` : 'none');
        }
        case 'maxVolume': {
            const v = num(dr.volume);
            return res(v != null && v <= num(c.max), { max: c.max }, v);
        }

        // ── assembly-specific checks (our differentiators) ───────────────────
        case 'mateSolved': {
            const mates = mateList(dr);
            const want = c.equals !== undefined ? num(c.equals) : null;   // exact count, optional
            const solved = mates.filter((m) => m && m.solved === true).length;
            const ok = mates.length > 0 && mates.every((m) => m && m.solved === true) &&
                (want == null || solved === want);
            return res(ok, want == null ? 'every mate solved' : `${want} mates solved`,
                { solved, total: mates.length });
        }
        case 'inducedJoint': {
            const mates = mateList(dr);
            const has = mates.some((m) => m && m.inducedJoint === c.equals);
            return res(has, c.equals, mates.map((m) => m && m.inducedJoint));
        }
        case 'casingBossAligned': {
            const bosses = Array.isArray(dr.casingBosses) ? dr.casingBosses : [];
            const want = c.equals !== undefined ? num(c.equals) : null;
            const aligned = bosses.filter((b) => b && b.aligned === true).length;
            const ok = bosses.length > 0 && bosses.every((b) => b && b.aligned === true) &&
                (want == null || bosses.length === want);
            return res(ok, want == null ? 'all bosses aligned' : `${want} bosses aligned`,
                { aligned, total: bosses.length });
        }
        case 'swapStable': {
            return res(dr.swapStable === true, true,
                dr.swapStable === undefined ? 'not measured' : dr.swapStable);
        }

        default:
            return res(false, c.kind, `unknown check kind ${JSON.stringify(c.kind)}`);
    }
}

/**
 * Score one task's whole spec (acceptance + negative + assembly) against a
 * measured DocResult. Pure; never throws.
 *
 * @param {{ id:string, spec?:{ acceptance?:object[], negative?:object[], assembly?:object[] } }} task
 * @param {DocResult} docResult
 * @returns {TaskScore}
 */
export function scoreTask(task, docResult) {
    const t = task || {};
    const spec = t.spec || {};
    const checks = [
        ...(Array.isArray(spec.acceptance) ? spec.acceptance : []),
        ...(Array.isArray(spec.negative) ? spec.negative : []),
        ...(Array.isArray(spec.assembly) ? spec.assembly : []),
    ];

    const failures = [];
    let passedCount = 0;
    for (const check of checks) {
        const r = scoreCheck(check, docResult);
        if (r.passed) passedCount += 1;
        else failures.push({ check: r.check, expected: r.expected, actual: r.actual });
    }

    const total = checks.length;
    return {
        taskId: t.id || '(unnamed)',
        passed: total > 0 && failures.length === 0,
        total,
        passedCount,
        failures,
        score: total === 0 ? 1 : passedCount / total,
    };
}

/**
 * Score a whole benchmark suite. `results` maps taskId → DocResult. A task with
 * no provided result is scored against an empty DocResult (so its acceptance
 * checks fail closed rather than being silently skipped).
 *
 * @param {Array} tasks
 * @param {Record<string, DocResult>} results
 * @returns {TaskScore[]}
 */
export function scoreSuite(tasks, results) {
    const r = results || {};
    return (Array.isArray(tasks) ? tasks : []).map((task) =>
        scoreTask(task, r[task && task.id] || {}));
}
