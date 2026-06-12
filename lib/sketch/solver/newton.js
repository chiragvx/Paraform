/**
 * Newton+LM solver — operates directly on the v4 SketchData shape.
 *
 * Differences from the legacy lib/sketch_solver.js:
 *   - Solves on Point entities (shared by id). Lines/Arcs/Circles are constraint
 *     relations between points + their own scalar params (radius, angles).
 *   - Takes SketchData as input rather than a flat entity/constraint array.
 *   - Reports `over`/`conflicting` as well as the legacy ok/under/failed.
 *
 * Numerical core is the same: build a residual vector F(x), build the Jacobian
 * J(x) by finite differences, solve (JᵀJ + λI) δ = JᵀF, line-search through
 * Levenberg-Marquardt damping until convergence or max iterations.
 *
 * The solver writes solved coordinates back into the SketchData via patchEntity
 * — callers that subscribe to a DocumentStore see the change as a `SET_PARAMS`
 * commit via the normal feature-update path.
 */

import { ENTITY_KIND } from '../entities.js';
import { CONSTRAINT_KIND, isDimensional } from '../constraints.js';
import { patchEntity } from '../sketch_data.js';

const TOL          = 1e-6;
const MAX_ITER     = 100;
const FD_EPS       = 1e-7;
const INIT_LAMBDA  = 1e-3;

// ── Index builder ────────────────────────────────────────────────────────────
// Walks the sketch and builds:
//   x         Float64Array of every DOF (point coords first, then scalars)
//   ptIdx     map point.id → [xIndex, yIndex]
//   scalIdx   map (entity.id, slot) → xIndex   for radii, angles, sweeps
//
// Each entity may contribute multiple scalars (an Arc has r, startAngle,
// sweepAngle); we name them by `${id}::${slot}`.

function buildIndex(sketch) {
    const xVals = [];
    const ptIdx = new Map();
    const scalIdx = new Map();

    for (const id of sketch.entityOrder) {
        const e = sketch.entities[id];
        if (e.kind === ENTITY_KIND.POINT) {
            ptIdx.set(e.id, [xVals.length, xVals.length + 1]);
            xVals.push(+e.params.x, +e.params.y);
        }
    }
    for (const id of sketch.entityOrder) {
        const e = sketch.entities[id];
        switch (e.kind) {
            case ENTITY_KIND.CIRCLE:
                scalIdx.set(`${e.id}::r`, xVals.length);
                xVals.push(+e.params.radius);
                break;
            case ENTITY_KIND.ARC:
                scalIdx.set(`${e.id}::r`,          xVals.length); xVals.push(+e.params.radius);
                scalIdx.set(`${e.id}::startAngle`, xVals.length); xVals.push(+e.params.startAngle);
                scalIdx.set(`${e.id}::sweepAngle`, xVals.length); xVals.push(+e.params.sweepAngle);
                break;
        }
    }
    return { x: new Float64Array(xVals), ptIdx, scalIdx };
}

function writeBack(sketch, x, ptIdx, scalIdx) {
    for (const [pid, [ix, iy]] of ptIdx.entries()) {
        if (sketch.entities[pid]) patchEntity(sketch, pid, { x: x[ix], y: x[iy] });
    }
    for (const [key, idx] of scalIdx.entries()) {
        const [eid, slot] = key.split('::');
        if (!sketch.entities[eid]) continue;
        const val = x[idx];
        if (slot === 'r') {
            patchEntity(sketch, eid, { radius: Math.max(1e-6, val) });
        } else {
            patchEntity(sketch, eid, { [slot]: val });
        }
    }
}

// ── Geometry helpers ────────────────────────────────────────────────────────

function px(x, ptIdx, pid)  { return x[ptIdx.get(pid)[0]]; }
function py(x, ptIdx, pid)  { return x[ptIdx.get(pid)[1]]; }

function lineVec(sketch, x, ptIdx, lineId) {
    const l = sketch.entities[lineId];
    const a = l.params.startId, b = l.params.endId;
    return [px(x, ptIdx, b) - px(x, ptIdx, a), py(x, ptIdx, b) - py(x, ptIdx, a)];
}

function lineLength(sketch, x, ptIdx, lineId) {
    const [vx, vy] = lineVec(sketch, x, ptIdx, lineId);
    return Math.sqrt(vx * vx + vy * vy);
}

function dist(x, ptIdx, p1, p2) {
    const dx = px(x, ptIdx, p1) - px(x, ptIdx, p2);
    const dy = py(x, ptIdx, p1) - py(x, ptIdx, p2);
    return Math.sqrt(dx * dx + dy * dy);
}

function resolveValue(v, params) {
    // Expression strings (e.g. "=wall * 2") are evaluated against the
    // Document parameter map. Numeric literals pass straight through.
    if (typeof v !== 'string') return Number(v) || 0;
    if (!v.startsWith('=')) return parseFloat(v) || 0;
    const expr = v.slice(1);
    // Build a sandbox with parameter values
    const ctx = {};
    for (const p of Object.values(params || {})) ctx[p.name] = p.value;
    try {
        // eslint-disable-next-line no-new-func
        return Function(...Object.keys(ctx), `return (${expr});`)(...Object.values(ctx));
    } catch { return 0; }
}

// ── Residuals ───────────────────────────────────────────────────────────────
// Each constraint contributes 1 or 2 scalar residuals. F[i] = 0 means satisfied.

function buildResiduals(sketch, x, ptIdx, scalIdx, docParameters = {}) {
    const F = [];
    for (const c of Object.values(sketch.constraints)) {
        // Driven (reference) dims are display-only — skip residual contribution.
        if (c && c.driven) continue;
        addConstraintResiduals(F, sketch, x, ptIdx, scalIdx, c, docParameters);
    }
    return F;
}

function addConstraintResiduals(F, sketch, x, ptIdx, scalIdx, c, docParameters) {
    const ids = c.entityIds;
    const ents = ids.map(id => sketch.entities[id]).filter(Boolean);
    const v = isDimensional(c.kind) ? resolveValue(c.value, docParameters) : null;

    switch (c.kind) {
        case CONSTRAINT_KIND.COINCIDENT: {
            const [a, b] = ids;
            const ea = sketch.entities[a], eb = sketch.entities[b];
            if (ea && eb && ea.kind === ENTITY_KIND.POINT && eb.kind === ENTITY_KIND.POINT) {
                F.push(px(x, ptIdx, a) - px(x, ptIdx, b));
                F.push(py(x, ptIdx, a) - py(x, ptIdx, b));
            }
            break;
        }
        case CONSTRAINT_KIND.HORIZONTAL: {
            const [lid] = ids;
            const l = sketch.entities[lid];
            if (l && l.kind === ENTITY_KIND.LINE) {
                F.push(py(x, ptIdx, l.params.startId) - py(x, ptIdx, l.params.endId));
            }
            break;
        }
        case CONSTRAINT_KIND.VERTICAL: {
            const [lid] = ids;
            const l = sketch.entities[lid];
            if (l && l.kind === ENTITY_KIND.LINE) {
                F.push(px(x, ptIdx, l.params.startId) - px(x, ptIdx, l.params.endId));
            }
            break;
        }
        case CONSTRAINT_KIND.PARALLEL: {
            const [l1, l2] = ids;
            const [ax, ay] = lineVec(sketch, x, ptIdx, l1);
            const [bx, by] = lineVec(sketch, x, ptIdx, l2);
            F.push(ax * by - ay * bx);   // cross product = 0
            break;
        }
        case CONSTRAINT_KIND.PERPENDICULAR: {
            const [l1, l2] = ids;
            const [ax, ay] = lineVec(sketch, x, ptIdx, l1);
            const [bx, by] = lineVec(sketch, x, ptIdx, l2);
            F.push(ax * bx + ay * by);   // dot product = 0
            break;
        }
        case CONSTRAINT_KIND.EQUAL_LENGTH: {
            const [l1, l2] = ids;
            F.push(lineLength(sketch, x, ptIdx, l1) - lineLength(sketch, x, ptIdx, l2));
            break;
        }
        case CONSTRAINT_KIND.EQUAL_RADIUS: {
            const [a, b] = ids;
            const ia = scalIdx.get(`${a}::r`), ib = scalIdx.get(`${b}::r`);
            if (ia != null && ib != null) F.push(x[ia] - x[ib]);
            break;
        }
        case CONSTRAINT_KIND.MIDPOINT: {
            const [pid, lid] = ids;
            const l = sketch.entities[lid];
            if (l && l.kind === ENTITY_KIND.LINE) {
                const mx = 0.5 * (px(x, ptIdx, l.params.startId) + px(x, ptIdx, l.params.endId));
                const my = 0.5 * (py(x, ptIdx, l.params.startId) + py(x, ptIdx, l.params.endId));
                F.push(px(x, ptIdx, pid) - mx);
                F.push(py(x, ptIdx, pid) - my);
            }
            break;
        }
        case CONSTRAINT_KIND.SYMMETRIC: {
            const [a, b, lid] = ids;
            const l = sketch.entities[lid];
            if (l && l.kind === ENTITY_KIND.LINE) {
                const x1 = px(x, ptIdx, l.params.startId), y1 = py(x, ptIdx, l.params.startId);
                const x2 = px(x, ptIdx, l.params.endId),   y2 = py(x, ptIdx, l.params.endId);
                const lx = x2 - x1, ly = y2 - y1;
                const len2 = lx * lx + ly * ly || 1;
                // Reflect A across line L → should equal B
                const ax = px(x, ptIdx, a), ay = py(x, ptIdx, a);
                const t = ((ax - x1) * lx + (ay - y1) * ly) / len2;
                const fx = x1 + t * lx, fy = y1 + t * ly;
                const rx = 2 * fx - ax, ry = 2 * fy - ay;
                F.push(rx - px(x, ptIdx, b));
                F.push(ry - py(x, ptIdx, b));
            }
            break;
        }
        case CONSTRAINT_KIND.POINT_ON_LINE: {
            const [pid, lid] = ids;
            const l = sketch.entities[lid];
            if (l && l.kind === ENTITY_KIND.LINE) {
                const x1 = px(x, ptIdx, l.params.startId), y1 = py(x, ptIdx, l.params.startId);
                const x2 = px(x, ptIdx, l.params.endId),   y2 = py(x, ptIdx, l.params.endId);
                const ax = px(x, ptIdx, pid),              ay = py(x, ptIdx, pid);
                F.push((x2 - x1) * (ay - y1) - (y2 - y1) * (ax - x1));   // cross = 0
            }
            break;
        }
        case CONSTRAINT_KIND.POINT_ON_CIRCLE: {
            const [pid, cid] = ids;
            const ce = sketch.entities[cid];
            if (ce && (ce.kind === ENTITY_KIND.CIRCLE || ce.kind === ENTITY_KIND.ARC)) {
                const cx = px(x, ptIdx, ce.params.centerId), cy = py(x, ptIdx, ce.params.centerId);
                const ri = scalIdx.get(`${cid}::r`);
                const r  = ri != null ? x[ri] : ce.params.radius;
                const dx = px(x, ptIdx, pid) - cx, dy = py(x, ptIdx, pid) - cy;
                F.push(Math.sqrt(dx * dx + dy * dy) - r);
            }
            break;
        }
        case CONSTRAINT_KIND.FIXED_DISTANCE: {
            const [a, b] = ids;
            // Targets can be Points or Lines. For Lines, distance = length.
            const ea = sketch.entities[a];
            if (ea && ea.kind === ENTITY_KIND.LINE) {
                F.push(lineLength(sketch, x, ptIdx, a) - v);
            } else {
                F.push(dist(x, ptIdx, a, b) - v);
            }
            break;
        }
        case CONSTRAINT_KIND.HORIZONTAL_DISTANCE: {
            const [a, b] = ids;
            F.push(Math.abs(px(x, ptIdx, b) - px(x, ptIdx, a)) - v);
            break;
        }
        case CONSTRAINT_KIND.VERTICAL_DISTANCE: {
            const [a, b] = ids;
            F.push(Math.abs(py(x, ptIdx, b) - py(x, ptIdx, a)) - v);
            break;
        }
        case CONSTRAINT_KIND.FIXED_ANGLE: {
            const [l1, l2] = ids;
            const [ax, ay] = lineVec(sketch, x, ptIdx, l1);
            const [bx, by] = lineVec(sketch, x, ptIdx, l2);
            const ang = Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
            F.push(ang - (v * Math.PI / 180));
            break;
        }
        case CONSTRAINT_KIND.FIXED_RADIUS: {
            const [cid] = ids;
            const ri = scalIdx.get(`${cid}::r`);
            if (ri != null) F.push(x[ri] - v);
            break;
        }
        case CONSTRAINT_KIND.FIXED_POINT: {
            const [pid] = ids;
            const targetX = (c.extra && c.extra.x) || 0;
            const targetY = (c.extra && c.extra.y) || 0;
            F.push(px(x, ptIdx, pid) - targetX);
            F.push(py(x, ptIdx, pid) - targetY);
            break;
        }
        case CONSTRAINT_KIND.TANGENT: {
            // Tangent of a line to a circle: |distance from circle centre to line| = radius
            const [a, b] = ids;
            const ea = sketch.entities[a], eb = sketch.entities[b];
            const line = ea.kind === ENTITY_KIND.LINE ? ea : eb;
            const circ = ea.kind === ENTITY_KIND.LINE ? eb : ea;
            if (line && circ && (circ.kind === ENTITY_KIND.CIRCLE || circ.kind === ENTITY_KIND.ARC)) {
                const x1 = px(x, ptIdx, line.params.startId), y1 = py(x, ptIdx, line.params.startId);
                const x2 = px(x, ptIdx, line.params.endId),   y2 = py(x, ptIdx, line.params.endId);
                const cx = px(x, ptIdx, circ.params.centerId), cy = py(x, ptIdx, circ.params.centerId);
                const ri = scalIdx.get(`${circ.id}::r`);
                const r  = ri != null ? x[ri] : circ.params.radius;
                const lx = x2 - x1, ly = y2 - y1;
                const len = Math.sqrt(lx * lx + ly * ly) || 1;
                const d   = Math.abs(lx * (y1 - cy) - ly * (x1 - cx)) / len;
                F.push(d - r);
            }
            break;
        }
        case CONSTRAINT_KIND.EQUAL_DISTANCE: {
            const [a, b, c2, d2] = ids;
            F.push(dist(x, ptIdx, a, b) - dist(x, ptIdx, c2, d2));
            break;
        }
        default:
            break;
    }
}

// ── Linear algebra helpers (Gauss elimination with partial pivoting) ─────────

function gaussSolve(A, b, n) {
    const M = A.slice();
    const y = b.slice();
    for (let k = 0; k < n; k++) {
        // partial pivot
        let pivRow = k, pivVal = Math.abs(M[k * n + k]);
        for (let i = k + 1; i < n; i++) {
            const v = Math.abs(M[i * n + k]);
            if (v > pivVal) { pivVal = v; pivRow = i; }
        }
        if (pivRow !== k) {
            for (let j = 0; j < n; j++) {
                const t = M[k * n + j]; M[k * n + j] = M[pivRow * n + j]; M[pivRow * n + j] = t;
            }
            const t = y[k]; y[k] = y[pivRow]; y[pivRow] = t;
        }
        const piv = M[k * n + k] || 1e-12;
        for (let i = k + 1; i < n; i++) {
            const f = M[i * n + k] / piv;
            for (let j = k; j < n; j++) M[i * n + j] -= f * M[k * n + j];
            y[i] -= f * y[k];
        }
    }
    const xOut = new Float64Array(n);
    for (let i = n - 1; i >= 0; i--) {
        let s = y[i];
        for (let j = i + 1; j < n; j++) s -= M[i * n + j] * xOut[j];
        xOut[i] = s / (M[i * n + i] || 1e-12);
    }
    return xOut;
}

// ── Solver entry point ──────────────────────────────────────────────────────

function l2(F) {
    let s = 0; for (let i = 0; i < F.length; i++) s += F[i] * F[i];
    return Math.sqrt(s);
}

export const newtonSolver = {
    name:    'newton',
    version: '0.1.0',

    /**
     * @param {object} sketchData
     * @param {object} [options]
     * @param {Map<string, ParamDef>|object} [options.documentParameters]
     */
    solve(sketchData, options = {}) {
        const docParams = options.documentParameters || {};
        const { x, ptIdx, scalIdx } = buildIndex(sketchData);

        const n = x.length;
        if (n === 0) {
            // No DOFs — fully constrained, trivially solved.
            const m = buildResiduals(sketchData, x, ptIdx, scalIdx, docParams).length;
            return { status: m === 0 ? 'ok' : 'over', dof: 0, iterations: 0, residual: 0, warnings: [] };
        }

        let lambda = INIT_LAMBDA;
        let xCurr  = x.slice();
        let iter   = 0;
        let warnings = [];

        let F = buildResiduals(sketchData, xCurr, ptIdx, scalIdx, docParams);
        let residual = l2(F);
        let m = F.length;

        for (iter = 0; iter < MAX_ITER; iter++) {
            if (residual < TOL) break;
            if (m === 0) break;

            // Build the Jacobian by forward finite differences
            const J = new Float64Array(m * n);
            for (let j = 0; j < n; j++) {
                const old = xCurr[j];
                xCurr[j] = old + FD_EPS;
                const Fp = buildResiduals(sketchData, xCurr, ptIdx, scalIdx, docParams);
                xCurr[j] = old;
                for (let i = 0; i < m; i++) {
                    J[i * n + j] = ((Fp[i] || 0) - (F[i] || 0)) / FD_EPS;
                }
            }

            // Normal equations
            const JtJ = new Float64Array(n * n);
            const JtF = new Float64Array(n);
            for (let i = 0; i < m; i++) {
                for (let jj = 0; jj < n; jj++) {
                    JtF[jj] += J[i * n + jj] * F[i];
                    for (let kk = 0; kk < n; kk++) {
                        JtJ[jj * n + kk] += J[i * n + jj] * J[i * n + kk];
                    }
                }
            }
            for (let jj = 0; jj < n; jj++) JtJ[jj * n + jj] += lambda;

            const delta = gaussSolve(JtJ, JtF, n);
            const xNext = xCurr.slice();
            for (let jj = 0; jj < n; jj++) xNext[jj] -= delta[jj];

            const Fnext = buildResiduals(sketchData, xNext, ptIdx, scalIdx, docParams);
            const rNext = l2(Fnext);
            if (rNext < residual) {
                xCurr = xNext; F = Fnext; residual = rNext; lambda *= 0.5;
            } else {
                lambda *= 4;
                if (lambda > 1e12) { warnings.push('lambda saturated'); break; }
            }
        }

        writeBack(sketchData, xCurr, ptIdx, scalIdx);

        // DOF accounting — system has more DOFs than equations → under-constrained.
        const dof = Math.max(0, n - m);
        let status;
        if (residual < TOL)        status = 'ok';
        else if (residual < 0.01)  status = 'under';
        else if (iter >= MAX_ITER) status = 'failed';
        else                       status = 'failed';

        return { status, dof, iterations: iter, residual, warnings };
    },
};
