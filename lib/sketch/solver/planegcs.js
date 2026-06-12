/**
 * PlaneGCS adapter — placeholder.
 *
 * The intended implementation wraps FreeCAD's PlaneGCS solver via the
 * `@salusoft89/planegcs` WASM port. Drops in via `registerSolver(planegcsSolver)`
 * once the dependency lands and the constraint-mapping shim is written.
 *
 * Until then, this module exposes a stub that throws on `solve()` so accidental
 * `setSolver('planegcs')` calls fail loudly rather than silently no-op.
 */

export const planegcsSolver = {
    name:    'planegcs',
    version: '0.0.0-stub',

    solve(_sketchData, _options = {}) {
        throw new Error(
            'planegcsSolver: not yet wired. Install @salusoft89/planegcs and ' +
            'implement the constraint-mapping shim before calling.'
        );
    },
};
