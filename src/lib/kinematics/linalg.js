/**
 * Small dense linear-algebra helpers — spec 17 v3 slice.
 *
 * Matrices are stored as row-major arrays of arrays (`m[r][c]`),
 * which is the most ergonomic shape for the IK damped-least-squares
 * solver's 6×6 normal-equation system. Sizes up to 6×6 are the
 * intended workload; the routines are O(n³) and have no SIMD path
 * because the working set is tiny.
 *
 * No external dependency — pure JS, runs cleanly under node tests.
 */

/** New zero matrix of shape rows × cols. */
export function zeros(rows, cols) {
    const m = new Array(rows);
    for (let r = 0; r < rows; r++) {
        m[r] = new Array(cols).fill(0);
    }
    return m;
}

/** N×N identity. */
export function identity(n) {
    const m = zeros(n, n);
    for (let i = 0; i < n; i++) m[i][i] = 1;
    return m;
}

/** Transpose. */
export function transpose(A) {
    const rows = A.length;
    const cols = A[0].length;
    const T = zeros(cols, rows);
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) T[c][r] = A[r][c];
    }
    return T;
}

/** A × B (matrix multiply). */
export function multiply(A, B) {
    const aR = A.length;
    const aC = A[0].length;
    const bR = B.length;
    const bC = B[0].length;
    if (aC !== bR) throw new Error(`multiply: shape mismatch ${aR}x${aC} · ${bR}x${bC}`);
    const out = zeros(aR, bC);
    for (let r = 0; r < aR; r++) {
        for (let k = 0; k < aC; k++) {
            const a = A[r][k];
            if (a === 0) continue;
            for (let c = 0; c < bC; c++) out[r][c] += a * B[k][c];
        }
    }
    return out;
}

/** A · v  (matrix × column vector). */
export function multiplyVec(A, v) {
    const rows = A.length;
    const cols = A[0].length;
    if (cols !== v.length) throw new Error(`multiplyVec: shape mismatch ${rows}x${cols} · ${v.length}`);
    const out = new Array(rows).fill(0);
    for (let r = 0; r < rows; r++) {
        let s = 0;
        for (let c = 0; c < cols; c++) s += A[r][c] * v[c];
        out[r] = s;
    }
    return out;
}

/** A + B. */
export function add(A, B) {
    const rows = A.length;
    const cols = A[0].length;
    const out = zeros(rows, cols);
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) out[r][c] = A[r][c] + B[r][c];
    }
    return out;
}

/** A scaled by scalar s. */
export function scale(A, s) {
    const rows = A.length;
    const cols = A[0].length;
    const out = zeros(rows, cols);
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) out[r][c] = A[r][c] * s;
    }
    return out;
}

/**
 * Inverse via Gauss-Jordan elimination with partial pivoting.
 * Throws on singular matrices (no pivot above 1e-12 in absolute value).
 * Works for any N up to ~6 (where the kinematics use cases live).
 */
export function invert(A) {
    const n = A.length;
    if (A[0].length !== n) throw new Error('invert: non-square');
    // Build augmented [A | I]
    const M = new Array(n);
    for (let r = 0; r < n; r++) {
        M[r] = new Array(2 * n).fill(0);
        for (let c = 0; c < n; c++) M[r][c] = A[r][c];
        M[r][n + r] = 1;
    }
    for (let col = 0; col < n; col++) {
        // Partial pivot
        let pivotRow = col;
        let pivotVal = Math.abs(M[col][col]);
        for (let r = col + 1; r < n; r++) {
            const v = Math.abs(M[r][col]);
            if (v > pivotVal) { pivotVal = v; pivotRow = r; }
        }
        if (pivotVal < 1e-12) throw new Error('invert: singular matrix');
        if (pivotRow !== col) {
            const tmp = M[col]; M[col] = M[pivotRow]; M[pivotRow] = tmp;
        }
        // Normalize pivot row
        const pv = M[col][col];
        for (let c = 0; c < 2 * n; c++) M[col][c] /= pv;
        // Eliminate other rows
        for (let r = 0; r < n; r++) {
            if (r === col) continue;
            const f = M[r][col];
            if (f === 0) continue;
            for (let c = 0; c < 2 * n; c++) M[r][c] -= f * M[col][c];
        }
    }
    // Extract inverse
    const inv = zeros(n, n);
    for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) inv[r][c] = M[r][n + c];
    }
    return inv;
}
