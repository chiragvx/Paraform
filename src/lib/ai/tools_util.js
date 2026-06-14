/**
 * Shared helpers for the AI tool modules.
 *
 * The tool surface is split across several modules (tools.js + tools_*.js) so
 * each capability group stays independently sound — a broken module can be left
 * un-wired without taking down the rest. Every module imports its schema
 * helpers and the `feat` result-wrapper from here so the shape stays uniform.
 *
 * Contract every handler obeys:
 *   - returns a JSON-serialisable object with an `ok` field
 *   - NEVER throws (wrap risky calls; return { ok:false, error } instead)
 *   - write ops that create a feature return feat(f, summary) so the agent can
 *     chain on the returned featureId
 */

/** JSON-Schema property builders. */
export const N = (desc, opts = {}) => ({ type: 'number', description: desc, ...opts });
export const S = (desc, opts = {}) => ({ type: 'string', description: desc, ...opts });
export const B = (desc) => ({ type: 'boolean', description: desc });
export const ARR = (itemType, desc) => ({ type: 'array', items: { type: itemType }, description: desc });

/** Wrap a created feature into the standard write-op result. */
export function feat(f, summary) {
    if (!f || !f.id) return { ok: false, error: 'operation did not return a feature' };
    return { ok: true, featureId: f.id, name: f.name || f.type, summary: summary || `${f.type} ${f.id}` };
}

/** Standard failure envelope — pulls a message out of an Error or string. */
export function fail(error) {
    return { ok: false, error: String((error && error.message) || error) };
}

/** Coerce to a finite number or return the fallback (never NaN). */
export function num(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

/** Coerce to a length-3 number array (a 3D vector), or null if impossible. */
export function vec3(v) {
    if (!Array.isArray(v) || v.length < 3) return null;
    const out = [num(v[0], NaN), num(v[1], NaN), num(v[2], NaN)];
    return out.every(Number.isFinite) ? out : null;
}

/** Normalise a 3-vector; returns null for a zero/invalid vector. */
export function normalize3(v) {
    const a = vec3(v);
    if (!a) return null;
    const len = Math.hypot(a[0], a[1], a[2]);
    if (!(len > 1e-9)) return null;
    return [a[0] / len, a[1] / len, a[2] / len];
}
