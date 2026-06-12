// Newton-Raphson constraint solver with Levenberg-Marquardt damping
// Solves parametric 2D sketch constraints to find entity positions that satisfy all constraints.

export const CONSTRAINT_TYPES = {
    COINCIDENT:     'coincident',
    HORIZONTAL:     'horizontal',
    VERTICAL:       'vertical',
    PARALLEL:       'parallel',
    PERPENDICULAR:  'perpendicular',
    TANGENT:        'tangent',
    EQUAL_LENGTH:   'equal_length',
    EQUAL_RADIUS:   'equal_radius',
    MIDPOINT:       'midpoint',
    FIXED_DISTANCE: 'fixed_distance',
    FIXED_ANGLE:    'fixed_angle',
    FIXED_RADIUS:   'fixed_radius',
    FIXED_POINT:    'fixed_point',
};

// Build flat DOF vector from entities
function buildX(entities) {
    const x = [];
    const idx = {};  // entity_id -> start index in x
    for (const e of entities) {
        idx[e.id] = x.length;
        switch (e.type) {
            case 'point':
                if (!e.fixed) { x.push(e.x, e.y); }
                break;
            case 'line':
                if (!e.fixedP1) { x.push(e.x1, e.y1); }
                if (!e.fixedP2) { x.push(e.x2, e.y2); }
                break;
            case 'circle':
                if (!e.fixedCenter) { x.push(e.cx, e.cy); }
                if (!e.fixedRadius) { x.push(e.r); }
                break;
            case 'arc':
                if (!e.fixedCenter) { x.push(e.cx, e.cy); }
                if (!e.fixedRadius) { x.push(e.r); }
                if (!e.fixedAngles) { x.push(e.a0, e.a1); }
                break;
        }
    }
    return { x: new Float64Array(x), idx };
}

// Write solved X values back to entities
function writeX(x, entities, idx) {
    for (const e of entities) {
        let i = idx[e.id];
        switch (e.type) {
            case 'point':
                if (!e.fixed) { e.x = x[i++]; e.y = x[i++]; }
                break;
            case 'line':
                if (!e.fixedP1) { e.x1 = x[i++]; e.y1 = x[i++]; }
                if (!e.fixedP2) { e.x2 = x[i++]; e.y2 = x[i++]; }
                break;
            case 'circle':
                if (!e.fixedCenter) { e.cx = x[i++]; e.cy = x[i++]; }
                if (!e.fixedRadius) { e.r = Math.max(0.01, x[i++]); }
                break;
            case 'arc':
                if (!e.fixedCenter) { e.cx = x[i++]; e.cy = x[i++]; }
                if (!e.fixedRadius) { e.r = Math.max(0.01, x[i++]); }
                if (!e.fixedAngles) { e.a0 = x[i++]; e.a1 = x[i++]; }
                break;
        }
    }
}

// Helper: get entity params at current x for residual computation
function getParams(e, x, idx) {
    const i = idx[e.id];
    switch (e.type) {
        case 'point':  return e.fixed  ? { x: e.x, y: e.y } : { x: x[i], y: x[i+1] };
        case 'line': {
            const x1 = e.fixedP1 ? e.x1 : x[i];
            const y1 = e.fixedP1 ? e.y1 : x[i + (e.fixedP1 ? 0 : 1) - 1 + 1];
            // More explicit:
            let j = i;
            const rx1 = e.fixedP1 ? e.x1 : x[j++];
            const ry1 = e.fixedP1 ? e.y1 : x[j++];
            const rx2 = e.fixedP2 ? e.x2 : x[j++];
            const ry2 = e.fixedP2 ? e.y2 : x[j++];
            return { x1: rx1, y1: ry1, x2: rx2, y2: ry2 };
        }
        case 'circle': {
            let j = i;
            const cx = e.fixedCenter ? e.cx : x[j++];
            const cy = e.fixedCenter ? e.cy : x[j++];
            const r  = e.fixedRadius ? e.r  : Math.max(0.01, x[j++]);
            return { cx, cy, r };
        }
        case 'arc': {
            let j = i;
            const cx = e.fixedCenter ? e.cx : x[j++];
            const cy = e.fixedCenter ? e.cy : x[j++];
            const r  = e.fixedRadius ? e.r  : Math.max(0.01, x[j++]);
            const a0 = e.fixedAngles ? e.a0 : x[j++];
            const a1 = e.fixedAngles ? e.a1 : x[j++];
            return { cx, cy, r, a0, a1 };
        }
    }
}

// Build residual vector F(x) for all constraints
function buildResiduals(x, entities, constraints, idx) {
    const F = [];
    const eMap = Object.fromEntries(entities.map(e => [e.id, e]));

    for (const c of constraints) {
        const [eA, eB] = c.entities.map(id => eMap[id]);
        const pA = eA ? getParams(eA, x, idx) : null;
        const pB = eB ? getParams(eB, x, idx) : null;

        switch (c.type) {
            case CONSTRAINT_TYPES.COINCIDENT: {
                // Points coincide: point-point, or point-on-line-endpoint
                const ax = pA.x ?? pA.x1; const ay = pA.y ?? pA.y1;
                const bx = pB.x ?? pB.x1; const by = pB.y ?? pB.y1;
                F.push(ax - bx, ay - by);
                break;
            }
            case CONSTRAINT_TYPES.HORIZONTAL: {
                // y1 = y2 for a line
                F.push(pA.y1 - pA.y2);
                break;
            }
            case CONSTRAINT_TYPES.VERTICAL: {
                F.push(pA.x1 - pA.x2);
                break;
            }
            case CONSTRAINT_TYPES.PARALLEL: {
                // Cross product of direction vectors = 0
                const dx1 = pA.x2 - pA.x1; const dy1 = pA.y2 - pA.y1;
                const dx2 = pB.x2 - pB.x1; const dy2 = pB.y2 - pB.y1;
                F.push(dx1 * dy2 - dy1 * dx2);
                break;
            }
            case CONSTRAINT_TYPES.PERPENDICULAR: {
                const dx1 = pA.x2 - pA.x1; const dy1 = pA.y2 - pA.y1;
                const dx2 = pB.x2 - pB.x1; const dy2 = pB.y2 - pB.y1;
                F.push(dx1 * dx2 + dy1 * dy2);
                break;
            }
            case CONSTRAINT_TYPES.TANGENT: {
                // Circle tangent to line: dist(center, line) = r
                const cx = pA.cx; const cy = pA.cy; const r = pA.r;
                const lx1 = pB.x1; const ly1 = pB.y1; const lx2 = pB.x2; const ly2 = pB.y2;
                const ldx = lx2 - lx1; const ldy = ly2 - ly1;
                const len = Math.sqrt(ldx * ldx + ldy * ldy) || 1e-9;
                const dist = Math.abs((cy - ly1) * ldx - (cx - lx1) * ldy) / len;
                F.push(dist - r);
                break;
            }
            case CONSTRAINT_TYPES.EQUAL_LENGTH: {
                const la2 = (pA.x2-pA.x1)**2 + (pA.y2-pA.y1)**2;
                const lb2 = (pB.x2-pB.x1)**2 + (pB.y2-pB.y1)**2;
                F.push(la2 - lb2);
                break;
            }
            case CONSTRAINT_TYPES.EQUAL_RADIUS: {
                F.push(pA.r - pB.r);
                break;
            }
            case CONSTRAINT_TYPES.MIDPOINT: {
                // Entity c = midpoint of line eA
                const [lineE, ptE] = [eA, eB];
                const lp = pA; const pp = pB;
                F.push((lp.x1 + lp.x2) / 2 - (pp.x ?? pp.x1));
                F.push((lp.y1 + lp.y2) / 2 - (pp.y ?? pp.y1));
                break;
            }
            case CONSTRAINT_TYPES.FIXED_DISTANCE: {
                const dx = pA.x2 - pA.x1; const dy = pA.y2 - pA.y1;
                F.push(dx*dx + dy*dy - c.value * c.value);
                break;
            }
            case CONSTRAINT_TYPES.FIXED_ANGLE: {
                const dx = pA.x2 - pA.x1; const dy = pA.y2 - pA.y1;
                const angle = Math.atan2(dy, dx);
                F.push(angle - c.value * Math.PI / 180);
                break;
            }
            case CONSTRAINT_TYPES.FIXED_RADIUS: {
                F.push(pA.r - c.value);
                break;
            }
            case CONSTRAINT_TYPES.FIXED_POINT: {
                F.push((pA.x ?? pA.x1) - c.value[0]);
                F.push((pA.y ?? pA.y1) - c.value[1]);
                break;
            }
        }
    }
    return new Float64Array(F);
}

// Numerical Jacobian via central differences
function buildJacobian(x, entities, constraints, idx, F) {
    const m = F.length;
    const n = x.length;
    const J = new Float64Array(m * n);
    const h = 1e-7;
    const xPlus = x.slice();
    const xMinus = x.slice();

    for (let j = 0; j < n; j++) {
        xPlus[j]  = x[j] + h;
        xMinus[j] = x[j] - h;
        const Fp = buildResiduals(xPlus,  entities, constraints, idx);
        const Fm = buildResiduals(xMinus, entities, constraints, idx);
        for (let i = 0; i < m; i++) {
            J[i * n + j] = (Fp[i] - Fm[i]) / (2 * h);
        }
        xPlus[j]  = x[j];
        xMinus[j] = x[j];
    }
    return { J, m, n };
}

// Gaussian elimination to solve A * delta = b
function gaussSolve(A, b, n) {
    const M = new Float64Array(n * (n + 1));
    for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) M[i*(n+1)+j] = A[i*n+j];
        M[i*(n+1)+n] = b[i];
    }
    for (let col = 0; col < n; col++) {
        let pivot = col;
        for (let row = col+1; row < n; row++) {
            if (Math.abs(M[row*(n+1)+col]) > Math.abs(M[pivot*(n+1)+col])) pivot = row;
        }
        // Swap rows
        for (let k = 0; k <= n; k++) {
            const tmp = M[col*(n+1)+k]; M[col*(n+1)+k] = M[pivot*(n+1)+k]; M[pivot*(n+1)+k] = tmp;
        }
        const diag = M[col*(n+1)+col];
        if (Math.abs(diag) < 1e-14) continue;
        for (let row = col+1; row < n; row++) {
            const factor = M[row*(n+1)+col] / diag;
            for (let k = col; k <= n; k++) M[row*(n+1)+k] -= factor * M[col*(n+1)+k];
        }
    }
    const delta = new Float64Array(n);
    for (let i = n-1; i >= 0; i--) {
        let s = M[i*(n+1)+n];
        for (let j = i+1; j < n; j++) s -= M[i*(n+1)+j] * delta[j];
        delta[i] = Math.abs(M[i*(n+1)+i]) > 1e-14 ? s / M[i*(n+1)+i] : 0;
    }
    return delta;
}

// Main solver entry point
export function solve(entities, constraints) {
    if (constraints.length === 0) return { status: 'ok', dof: countDOF(entities) };

    const { x, idx } = buildX(entities);
    const n = x.length;
    if (n === 0) return { status: 'ok', dof: 0 };

    let lambda = 1e-4;
    const MAX_ITER = 60;
    const TOL = 1e-8;

    let xCurr = x.slice();
    let residual = Infinity;

    for (let iter = 0; iter < MAX_ITER; iter++) {
        const F = buildResiduals(xCurr, entities, constraints, idx);
        residual = Math.sqrt(F.reduce((s, v) => s + v*v, 0));
        if (residual < TOL) break;

        const { J, m } = buildJacobian(xCurr, entities, constraints, idx, F);

        // Build normal equations: (JᵀJ + λI) delta = Jᵀ F
        const JtJ = new Float64Array(n * n);
        const JtF = new Float64Array(n);
        for (let i = 0; i < m; i++) {
            for (let j = 0; j < n; j++) {
                JtF[j] += J[i*n+j] * F[i];
                for (let k = 0; k < n; k++) {
                    JtJ[j*n+k] += J[i*n+j] * J[i*n+k];
                }
            }
        }
        for (let j = 0; j < n; j++) JtJ[j*n+j] += lambda;

        const delta = gaussSolve(JtJ, JtF, n);

        const xNext = xCurr.slice();
        for (let j = 0; j < n; j++) xNext[j] -= delta[j];

        const FNext = buildResiduals(xNext, entities, constraints, idx);
        const rNext = Math.sqrt(FNext.reduce((s,v) => s+v*v, 0));
        if (rNext < residual) { xCurr = xNext; lambda *= 0.5; }
        else { lambda *= 4; }
    }

    writeX(xCurr, entities, idx);

    const m = buildResiduals(xCurr, entities, constraints, idx).length;
    const dof = Math.max(0, n - m);

    if (residual < TOL) return { status: 'ok', dof };
    if (residual < 1)   return { status: 'under', dof };
    return { status: 'failed', dof, residual };
}

function countDOF(entities) {
    let dof = 0;
    for (const e of entities) {
        if (e.type === 'point')  dof += e.fixed ? 0 : 2;
        if (e.type === 'line')   dof += (e.fixedP1 ? 0 : 2) + (e.fixedP2 ? 0 : 2);
        if (e.type === 'circle') dof += (e.fixedCenter ? 0 : 2) + (e.fixedRadius ? 0 : 1);
        if (e.type === 'arc')    dof += (e.fixedCenter ? 0 : 2) + (e.fixedRadius ? 0 : 1) + (e.fixedAngles ? 0 : 2);
    }
    return dof;
}
