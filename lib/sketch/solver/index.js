/**
 * Sketch solver — pluggable facade.
 *
 * The facade hides the choice of underlying solver. Today the only built-in
 * is the JS Newton+LM implementation in `newton.js`. Phase 1C polish will
 * land `planegcs.js` (FreeCAD's PlaneGCS as WASM); the facade is set up so
 * that swap is one line of configuration, not a refactor.
 *
 * Solver contract
 * ───────────────
 * Every implementation exposes:
 *   { name: string, version: string,
 *     solve(sketchData, options) → SolveResult }
 *
 * SolveResult:
 *   {
 *     status:    'ok' | 'under' | 'over' | 'conflicting' | 'failed',
 *     dof:       number,             // remaining degrees of freedom
 *     iterations:number,             // iterations spent
 *     residual:  number,             // final L2 residual
 *     elapsedMs: number,
 *     solverName:string,
 *     solverVersion:string,
 *     warnings:  string[],
 *   }
 *
 * Solvers MUST write the solved entity coordinates back into the
 * `sketchData` in place (via `patchEntity`) and update `sketchData.solveStatus`
 * + `sketchData.dof` + `sketchData.solverInfo` to match the returned result.
 */

import { newtonSolver } from './newton.js';

// ── Registry ─────────────────────────────────────────────────────────────────
const _registry = new Map();
let _activeName = null;

/**
 * Register a solver implementation. The first registered solver becomes the
 * active default (lazy: callers can override with `setSolver`).
 */
export function registerSolver(impl) {
    if (!impl || typeof impl.solve !== 'function' || !impl.name) {
        throw new Error('registerSolver: impl must have { name, solve }');
    }
    _registry.set(impl.name, impl);
    if (_activeName == null) _activeName = impl.name;
}

/** Switch the active solver by name. Throws if the name isn't registered. */
export function setSolver(name) {
    if (!_registry.has(name)) throw new Error(`setSolver: unknown solver "${name}"`);
    _activeName = name;
}

/** Return the active solver instance. */
export function getActiveSolver() {
    if (!_activeName) throw new Error('getActiveSolver: no solver registered');
    return _registry.get(_activeName);
}

/** Names of every registered solver — useful for UI pickers. */
export function availableSolvers() { return [..._registry.keys()]; }

// ── Default registration — Newton+LM ──────────────────────────────────────────
registerSolver(newtonSolver);

// ── Public solve() ───────────────────────────────────────────────────────────

import { SOLVE_STATUS } from '../sketch_data.js';

/**
 * Run the active solver against a SketchData. Mutates the sketch in place:
 *   - patches resolved coordinates back onto entities
 *   - sets `solveStatus`, `dof`, `solverInfo`
 *
 * Returns the full SolveResult so callers can introspect convergence.
 *
 * @param {object} sketchData
 * @param {object} [options]
 * @param {string} [options.solver] — override the active solver by name
 * @returns {SolveResult}
 */
export function solve(sketchData, options = {}) {
    const impl = options.solver ? _registry.get(options.solver) : getActiveSolver();
    if (!impl) throw new Error(`solve: solver "${options.solver}" not registered`);

    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const result = impl.solve(sketchData, options);
    const elapsedMs = Math.max(0, (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0);

    const status = result.status || 'failed';
    const dof    = Number.isFinite(result.dof) ? result.dof : -1;

    // Stamp the sketch with the solver's verdict
    sketchData.solveStatus = mapStatus(status);
    sketchData.dof         = dof;
    sketchData.solverInfo  = {
        name:       impl.name,
        version:    impl.version || 'unknown',
        iterations: result.iterations || 0,
        residual:   result.residual   || 0,
        elapsedMs:  Math.round(elapsedMs * 100) / 100,
    };

    return {
        status,
        dof,
        iterations:     result.iterations || 0,
        residual:       result.residual   || 0,
        elapsedMs,
        solverName:     impl.name,
        solverVersion:  impl.version || 'unknown',
        warnings:       result.warnings || [],
    };
}

function mapStatus(status) {
    switch (status) {
        case 'ok':          return SOLVE_STATUS.SOLVED;
        case 'under':       return SOLVE_STATUS.UNDER;
        case 'over':        return SOLVE_STATUS.OVER;
        case 'conflicting': return SOLVE_STATUS.CONFLICTING;
        default:            return SOLVE_STATUS.FAILED;
    }
}

// Re-exports so callers can `import { solve, newtonSolver } from '.../solver'`
export { newtonSolver } from './newton.js';
