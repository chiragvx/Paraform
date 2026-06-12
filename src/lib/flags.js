// Feature flags for launch gating. See GTM_EXECUTION.md Phase 1.
//
// V1 hides every non-hero surface (sketching, patterns, direct-edit beyond
// press-pull, ref geometry, script editor, DFM/invariants panels, …).
// Nothing is deleted — set VITE_FULL_UI=1 to restore the full UI in dev.

const env = typeof import.meta !== 'undefined' && import.meta.env ? import.meta.env : {};

export const FULL_UI = env.VITE_FULL_UI === '1' || env.VITE_FULL_UI === 'true';
export const V1 = !FULL_UI;
