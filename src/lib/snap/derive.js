/**
 * Spec 18 v2 / Phase 2 — derive implicit connectors from raw geometry.
 *
 * The kernel ships `bridge.geometry.faces` keyed by descriptor:
 *   { [key]: { vertices: Float32Array, indices: Uint32Array,
 *              center?: [x,y,z], normal?: [nx,ny,nz] } }
 * and `bridge.geometry.edges`:
 *   { [key]: { points: Float32Array, center?, tangent? } }
 *
 * For Phase 2 we synthesize a *planar* connector per face that has a
 * `normal` (almost every face the kernel ships does), and a planar
 * connector per edge midpoint where a `tangent` is available. These
 * synthesized records mate with each other via the empty-`mates_with`
 * fallback added to mate_solver (`connectorsCompatible`), and with the
 * `auto`/`unspecified` size sentinel so they don't need a nominal.
 *
 * The result is a flat `Connector[]` that callers can feed to:
 *   - `connectorsCompatible(host, derived)` for compatibility checks
 *   - `solveMateTransform(hostWorld, derived)` for placement
 *
 * What's deliberately NOT here yet (Phase 3+):
 *   - Cylindrical face → bore connector. Needs the topology index's
 *     `surfaceType === 'cylindrical'` to avoid mis-classifying flat faces.
 *   - Rail / t-slot recognition. Pattern match on parallel-face pairs +
 *     channel walls — keeps Phase 3 self-contained.
 *
 * Caching: pure on `geometry` shape, so callers should key by
 *   `bridge.lastCompileMs` if they want a stable identity across frames.
 */

import { makeConnector } from '../../../lib/document/types.js';
import { recognizeRail } from './recognize.js';

/**
 * @param {{faces?:object, edges?:object}} geometry  — bridge.geometry
 * @param {object} [opts]
 * @param {string} [opts.componentId]  — stamp `parent` on every record so
 *   snap_drag can filter out the dragged component's own derived ones.
 *   Defaults to null.
 * @param {boolean} [opts.includeEdges]  — synthesize per-edge-midpoint
 *   planar connectors too. Default false (faces alone usually cover the
 *   useful surface area without overwhelming the magnet contest).
 * @param {boolean} [opts.includeRail]  — run `recognizeRail` and, when
 *   the body shape qualifies, emit a single `rail` connector along the
 *   long axis. Defaults to true — the cost is one O(faces) pass and the
 *   payoff is the t-nut-in-rail flow.
 * @returns {object[]}  array of Connector-shaped records
 */
export function deriveConnectorsFromGeometry(geometry, opts = {}) {
    const out = [];
    if (!geometry) return out;
    const componentId = opts.componentId || null;
    const includeRail = opts.includeRail !== false;

    const faces = geometry.faces || {};
    for (const key of Object.keys(faces)) {
        const f = faces[key];
        if (!f) continue;
        const center = Array.isArray(f.center) ? f.center : _faceCentroid(f.vertices);
        const normal = Array.isArray(f.normal) ? f.normal : _faceNormal(f.vertices, f.indices);
        if (!center || !normal) continue;
        if (!_isUnitish(normal)) continue;       // tessellation-only faces have garbage normals
        out.push(makeConnector({
            id: `derived:face:${key}`,
            parent: componentId,
            kind: 'planar',
            gender: 'neutral',
            size: { nominal: 'auto', unit: 'mm' },
            axis: normal,
            origin: center,
            mates_with: [],          // empty → match by kind via the mate_solver wildcard
            inducedJoint: 'fixed',
            metadata: { derived: true, source: 'face', descriptorKey: key },
        }));
    }

    // Rail recognition — a single 'rail' connector at the body's long-axis
    // midpoint when the geometry passes the rail-shape heuristic. Mates
    // with shaft/t-nut/rail kinds via the explicit mates_with list so
    // sliding parts find it even when the part has its own connector list.
    if (includeRail) {
        const rail = recognizeRail(geometry);
        if (rail) {
            out.push(makeConnector({
                id: `derived:rail:${componentId || 'anon'}`,
                parent: componentId,
                kind: 'rail',
                gender: 'neutral',
                size: { nominal: rail.profile, unit: 'mm' },
                axis: rail.axis,
                origin: rail.origin,
                mates_with: ['rail', 'shaft'],
                inducedJoint: 'prismatic',
                metadata: {
                    derived: true,
                    source: 'rail',
                    profile: rail.profile,
                    length: rail.length,
                    crossSection: rail.crossSection,
                    channelWidth: rail.channelWidth,
                    score: rail.score,
                },
            }));
        }
    }

    if (opts.includeEdges) {
        const edges = geometry.edges || {};
        for (const key of Object.keys(edges)) {
            const e = edges[key];
            if (!e) continue;
            const center = Array.isArray(e.center) ? e.center : _edgeMidpoint(e.points);
            if (!center) continue;
            // Use the tangent as the connector axis when present (so a rail-
            // like edge snaps along its run); fall back to world Z otherwise.
            const axis = Array.isArray(e.tangent) && _isUnitish(e.tangent)
                ? e.tangent
                : [0, 0, 1];
            out.push(makeConnector({
                id: `derived:edge:${key}`,
                parent: componentId,
                kind: 'planar',
                gender: 'neutral',
                size: { nominal: 'auto', unit: 'mm' },
                axis,
                origin: center,
                mates_with: [],
                inducedJoint: 'fixed',
                metadata: { derived: true, source: 'edge', descriptorKey: key },
            }));
        }
    }
    return out;
}

// ── helpers ────────────────────────────────────────────────────────────────

function _faceCentroid(vertices) {
    if (!vertices || vertices.length < 9) return null;
    let sx = 0, sy = 0, sz = 0, n = 0;
    for (let i = 0; i + 2 < vertices.length; i += 3) {
        sx += vertices[i]; sy += vertices[i + 1]; sz += vertices[i + 2];
        n++;
    }
    if (n === 0) return null;
    return [sx / n, sy / n, sz / n];
}

function _faceNormal(vertices, indices) {
    // Average triangle normals — robust enough for v1 derived snap targets.
    if (!vertices || vertices.length < 9) return null;
    let nx = 0, ny = 0, nz = 0;
    const N = (indices && indices.length >= 3)
        ? indices.length
        : Math.floor(vertices.length / 3);
    const get = (i) => indices ? indices[i] : i;
    let count = 0;
    for (let t = 0; t + 2 < N; t += 3) {
        const ia = get(t) * 3, ib = get(t + 1) * 3, ic = get(t + 2) * 3;
        const ax = vertices[ia], ay = vertices[ia + 1], az = vertices[ia + 2];
        const bx = vertices[ib], by = vertices[ib + 1], bz = vertices[ib + 2];
        const cx = vertices[ic], cy = vertices[ic + 1], cz = vertices[ic + 2];
        const ux = bx - ax, uy = by - ay, uz = bz - az;
        const vx = cx - ax, vy = cy - ay, vz = cz - az;
        nx += uy * vz - uz * vy;
        ny += uz * vx - ux * vz;
        nz += ux * vy - uy * vx;
        count++;
    }
    if (count === 0) return null;
    const m = Math.hypot(nx, ny, nz);
    if (m < 1e-9) return null;
    return [nx / m, ny / m, nz / m];
}

function _edgeMidpoint(points) {
    if (!points || points.length < 6) return null;
    const midIdx = Math.floor((points.length / 3) / 2) * 3;
    return [points[midIdx], points[midIdx + 1], points[midIdx + 2]];
}

function _isUnitish(v) {
    if (!v || v.length < 3) return false;
    const m = Math.hypot(v[0], v[1], v[2]);
    return m > 0.5 && m < 1.5;
}
