/**
 * Tangent-walk for "Select Tangent" on an edge.
 *
 * Given a picked edge ref and the kernel topology, find all edges connected
 * at the picked edge's endpoints whose tangent direction at the shared
 * endpoint matches the picked edge's tangent within `angleToleranceDeg`
 * (default 5°). Walks transitively (an edge tangent to a tangent edge is
 * also included).
 *
 * Topology shape (from bridge.lastResult.topology):
 *   nodes: [
 *     {
 *       bodyId,
 *       edges: [
 *         { index, hash?, start: [x,y,z], end: [x,y,z],
 *           startTangent?: [x,y,z], endTangent?: [x,y,z] }
 *       ]
 *     }
 *   ]
 *
 * FALLBACK: If tangent vectors are absent, we degrade to a "connected at
 * endpoint" walk and emit a console.warn TODO. True tangent detection
 * requires the kernel to populate startTangent/endTangent on each edge.
 */

const POINT_EPS = 1e-4;     // 0.1 µm at mm scale — endpoints share within this
const DEFAULT_ANGLE_DEG = 5;

export function selectTangentEdges(pickedRef, topology, { angleToleranceDeg = DEFAULT_ANGLE_DEG } = {}) {
    if (!pickedRef || pickedRef.kind !== 'edge' || !topology) return [];
    const node = findNode(topology, pickedRef.bodyId);
    if (!node || !Array.isArray(node.edges)) return [];

    const picked = findEdge(node, pickedRef);
    if (!picked) return [];

    const cosTol = Math.cos((angleToleranceDeg * Math.PI) / 180);
    const hasTangents = edgeHasTangents(picked);
    if (!hasTangents) {
        console.warn(
            '[picking/tangent] Edge tangent vectors not present in topology. ' +
            'Falling back to connectivity-only walk. ' +
            'TODO: have the kernel populate edge.startTangent / edge.endTangent ' +
            'so true tangent selection can work.'
        );
    }

    // BFS over edges: enqueue edges that share an endpoint AND (if tangents
    // available) whose tangent at the shared endpoint matches within tol.
    const visited = new Set([edgeKey(picked)]);
    const queue   = [picked];
    const result  = [];

    while (queue.length) {
        const cur = queue.shift();
        for (const e of node.edges) {
            const k = edgeKey(e);
            if (visited.has(k)) continue;
            const shared = sharedEndpoint(cur, e);
            if (!shared) continue;
            if (hasTangents && edgeHasTangents(e)) {
                const t1 = tangentAt(cur, shared.curEnd);
                const t2 = tangentAt(e,   shared.otherEnd);
                if (!areTangent(t1, t2, cosTol)) continue;
            }
            visited.add(k);
            queue.push(e);
            result.push({ kind: 'edge', bodyId: pickedRef.bodyId, index: e.index, hash: e.hash });
        }
    }
    return result;
}

// ── helpers ───────────────────────────────────────────────────────────────

function findNode(topology, bodyId) {
    if (!topology.nodes) return null;
    return topology.nodes.find((n) => n.bodyId === bodyId) || null;
}

function findEdge(node, ref) {
    return node.edges.find((e) =>
        (ref.hash != null && e.hash === ref.hash) ||
        (ref.index != null && e.index === ref.index)
    ) || null;
}

function edgeKey(e) {
    return e.hash != null ? `h:${e.hash}` : `i:${e.index}`;
}

function edgeHasTangents(e) {
    return Array.isArray(e.startTangent) && Array.isArray(e.endTangent);
}

/**
 * Returns { curEnd, otherEnd } where each is 'start' or 'end' indicating
 * which endpoint of cur and e meet. Null if no shared endpoint.
 */
function sharedEndpoint(cur, other) {
    if (pointsEqual(cur.start, other.start)) return { curEnd: 'start', otherEnd: 'start' };
    if (pointsEqual(cur.start, other.end))   return { curEnd: 'start', otherEnd: 'end' };
    if (pointsEqual(cur.end,   other.start)) return { curEnd: 'end',   otherEnd: 'start' };
    if (pointsEqual(cur.end,   other.end))   return { curEnd: 'end',   otherEnd: 'end' };
    return null;
}

function pointsEqual(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    return Math.abs(a[0] - b[0]) < POINT_EPS
        && Math.abs(a[1] - b[1]) < POINT_EPS
        && Math.abs(a[2] - b[2]) < POINT_EPS;
}

function tangentAt(edge, which) {
    // Return outward-pointing tangent at the chosen endpoint.
    // Edge tangents are stored along the parameter direction; flip the start
    // tangent so both vectors point "away from" the shared endpoint.
    const t = which === 'start' ? edge.startTangent : edge.endTangent;
    if (!t) return null;
    if (which === 'end') return t.slice();
    return [-t[0], -t[1], -t[2]];
}

function areTangent(t1, t2, cosTol) {
    if (!t1 || !t2) return false;
    const a = normalize(t1);
    const b = normalize(t2);
    if (!a || !b) return false;
    // Two tangents at a shared endpoint are "tangent" when their directions
    // are anti-parallel (one points into the vertex, one out). Compare
    // magnitudes of dot product against tolerance.
    const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    return Math.abs(dot) >= cosTol;
}

function normalize(v) {
    const m = Math.hypot(v[0], v[1], v[2]);
    if (m < 1e-9) return null;
    return [v[0] / m, v[1] / m, v[2] / m];
}
