/**
 * Global assembly constraint / DOF analysis.
 *
 * The mate solver (mate_solver.js) places one part at a time: each mate is an
 * independent pairwise SE(3) solve with *no global accounting*. That's fine for
 * a tree of parts, but says nothing about the assembly as a whole — whether it
 * is rigid, free to move, or fights itself.
 *
 * This module is the missing global layer. It reads the *mate graph* — parts as
 * nodes, mates as edges carrying an induced joint type from the connector
 * contract — and answers the kinematics questions the pairwise solver can't:
 *
 *   - buildMateGraph         — assemble the adjacency from real Components / Mates.
 *   - countDOF               — Grübler/Kutzbach mobility of the whole assembly.
 *   - detectLoops            — kinematic loops (cycles) where naive pairwise
 *                              solving can conflict.
 *   - classifyConstraint     — under- / exactly- / over-constrained, with a
 *                              human-readable reason and the offending entities.
 *   - findFloatingComponents — parts with no path to the grounded root.
 *
 * Joint DOF model (per the connector contract's `inducedJoint`, 3-D):
 *
 *   | inducedJoint | removes | leaves | meaning                          |
 *   |--------------|---------|--------|----------------------------------|
 *   | 'fixed'      | 6       | 0      | rigid weld                       |
 *   | 'revolute'   | 5       | 1      | one rotational DOF (hinge)       |
 *   | 'prismatic'  | 5       | 1      | one translational DOF (slider)   |
 *
 * Mobility (Grübler/Kutzbach) for a 3-D assembly of `n` bodies (one of them
 * grounded) joined by `m` joints:
 *
 *   M = 6·(n − 1) − Σ_i (6 − f_i)
 *
 * where `f_i` is the DOF left by joint i (0 / 1 / 1 above) and `6 − f_i` is the
 * constraints it imposes. `n − 1` because the first grounded/root body is fixed
 * to ground and contributes no free DOF.
 *
 * Everything here is **pure and deterministic**: no Date.now / Math.random, no
 * DOM, no THREE. Inputs are iterated in a stable order (by id) so the output
 * — including the order of reported loops / offenders — is byte-identical for
 * identical inputs. Operates on the REAL document shapes from
 * lib/document/types.js (Component, Mate, Connector) and the induced-joint
 * vocabulary from src/lib/library/mate_solver.js.
 */

/**
 * @typedef {object} MateGraphNode
 * @property {string} id          — componentId
 * @property {boolean} grounded   — true for the grounded root (fixed to ground)
 * @property {string[]} edgeIds   — incident edge ids (deterministic, sorted)
 * @property {string[]} neighbors — adjacent component ids (deterministic, sorted)
 */

/**
 * @typedef {object} MateGraphEdge
 * @property {string} id          — mate id (or a derived stable id)
 * @property {string} a           — one endpoint componentId
 * @property {string} b           — the other endpoint componentId
 * @property {'fixed'|'revolute'|'prismatic'} joint — induced joint type
 * @property {number} dof         — DOF this joint *leaves* (fixed 0, revolute/prismatic 1)
 * @property {number} constraints — DOF this joint *removes* (6 − dof)
 * @property {string|null} mateId — the source Mate.id, or null if synthesised
 */

/**
 * @typedef {object} MateGraph
 * @property {Map<string, MateGraphNode>} nodes  — componentId → node
 * @property {MateGraphEdge[]} edges             — deterministic, sorted by id
 * @property {string|null} root                  — the grounded root componentId
 */

// DOF *left* by each induced joint kind in 3-D (free body = 6).
const _JOINT_DOF = { fixed: 0, revolute: 1, prismatic: 1 };
const _FREE_BODY_DOF = 6;

/** Stable ascending compare for ids (string-keyed, locale-independent). */
function _cmp(a, b) {
    return a < b ? -1 : (a > b ? 1 : 0);
}

/** Normalise the induced-joint kind to the closed 3-set; default 'fixed'. */
function _jointKind(kind) {
    return kind === 'revolute' || kind === 'prismatic' ? kind : 'fixed';
}

/**
 * Resolve the owning componentId for a mate's *host* side. A Mate carries the
 * host as either a connector id (look its `parent` up in `connectors`) or a
 * free-placement world frame (no host component — the host is ground/root).
 *
 * @param {Mate} mate
 * @param {Record<string, Connector>} connectors
 * @param {string|null} root
 * @returns {string|null} host componentId, or null when none resolves
 */
function _hostComponentId(mate, connectors, root) {
    const ref = mate && mate.hostConnectorRef;
    if (ref && ref.connectorId && connectors) {
        const con = connectors[ref.connectorId];
        if (con && con.parent) return String(con.parent);
    }
    // Free placement (`world` frame, no host connector) ties the part to ground:
    // the grounded root is the host. Returns root so the part isn't left floating.
    if (ref && ref.world && root) return root;
    return null;
}

/**
 * Build the mate-graph adjacency from real Components and Mates.
 *
 * Nodes are componentIds (the `root` component is grounded; if absent, the
 * lexicographically-first component is grounded so the graph still has a base
 * frame). Edges are mates: each resolves a host componentId (from the host
 * connector's `parent`, or root for a free placement) and a part componentId
 * (`mate.componentId`), and carries the induced joint kind
 * (`mate.inducedJoint.kind`, default 'fixed'). Self-edges and edges with an
 * unresolved endpoint are dropped — they can't constrain two distinct bodies.
 *
 * @param {Component[]|Record<string, Component>} components
 * @param {Mate[]|Record<string, Mate>} mates
 * @param {object} [opts]
 * @param {Record<string, Connector>} [opts.connectors] — for host-side resolution
 * @param {string} [opts.root] — explicit grounded root id (default 'root' if present)
 * @returns {MateGraph}
 */
export function buildMateGraph(components, mates, opts = {}) {
    const connectors = (opts && opts.connectors) || {};
    const compList = _asArray(components);
    const mateList = _asArray(mates);

    // Stable node set, id-sorted.
    const ids = compList
        .map((c) => (c && c.id != null ? String(c.id) : null))
        .filter((id) => id != null)
        .sort(_cmp);

    // Pick the grounded root: explicit opt → a node literally named 'root' →
    // the first component in sorted order. Every assembly needs a base frame.
    let root = null;
    if (opts && opts.root && ids.includes(String(opts.root))) root = String(opts.root);
    else if (ids.includes('root')) root = 'root';
    else if (ids.length) root = ids[0];

    const nodes = new Map();
    for (const id of ids) {
        nodes.set(id, { id, grounded: id === root, edgeIds: [], neighbors: [] });
    }

    // Build edges deterministically: iterate mates id-sorted, resolve endpoints.
    const sortedMates = mateList
        .filter((m) => m && m.id != null)
        .slice()
        .sort((m1, m2) => _cmp(String(m1.id), String(m2.id)));

    const edges = [];
    for (const m of sortedMates) {
        const part = m.componentId != null ? String(m.componentId) : null;
        const host = _hostComponentId(m, connectors, root);
        if (!part || !host) continue;          // unresolved endpoint
        if (part === host) continue;           // self-mate constrains nothing
        // Ensure both endpoints exist as nodes (a mate may reference a part not
        // in the component list yet — add it ungrounded so it's still counted).
        if (!nodes.has(part)) nodes.set(part, { id: part, grounded: false, edgeIds: [], neighbors: [] });
        if (!nodes.has(host)) nodes.set(host, { id: host, grounded: host === root, edgeIds: [], neighbors: [] });

        const joint = _jointKind(m.inducedJoint && m.inducedJoint.kind);
        const dof = _JOINT_DOF[joint];
        edges.push({
            id: String(m.id),
            a: host,
            b: part,
            joint,
            dof,
            constraints: _FREE_BODY_DOF - dof,
            mateId: String(m.id),
        });
    }

    // Wire incident-edge / neighbor lists, kept deterministic.
    for (const e of edges) {
        const na = nodes.get(e.a);
        const nb = nodes.get(e.b);
        if (na) { na.edgeIds.push(e.id); na.neighbors.push(e.b); }
        if (nb) { nb.edgeIds.push(e.id); nb.neighbors.push(e.a); }
    }
    for (const n of nodes.values()) {
        n.edgeIds.sort(_cmp);
        n.neighbors = Array.from(new Set(n.neighbors)).sort(_cmp);
    }

    return { nodes, edges, root };
}

/**
 * Grübler/Kutzbach mobility of the assembly.
 *
 *   gross       — total free DOF of all bodies *except* the grounded root:
 *                 6·(n − 1). With no grounded node, 6·n (nothing pins it).
 *   constrained — Σ over edges of constraints removed (Σ (6 − f_i)).
 *   remaining   — gross − constrained = assembly mobility M. Can be negative
 *                 (statically over-determined) or positive (free to move).
 *
 * Only *grounded-component* counting subtracts a body; an assembly with no
 * grounded root reports the full 6·n so the caller can see nothing anchors it.
 *
 * @param {MateGraph} graph
 * @returns {{ gross: number, constrained: number, remaining: number, bodies: number, joints: number }}
 */
export function countDOF(graph) {
    const nodes = graph && graph.nodes ? graph.nodes : new Map();
    const edges = graph && Array.isArray(graph.edges) ? graph.edges : [];
    const n = nodes.size;
    const hasGround = graph && graph.root && nodes.has(graph.root);
    const gross = hasGround ? _FREE_BODY_DOF * Math.max(0, n - 1) : _FREE_BODY_DOF * n;
    let constrained = 0;
    for (const e of edges) constrained += (Number.isFinite(e.constraints) ? e.constraints : 0);
    return {
        gross,
        constrained,
        remaining: gross - constrained,
        bodies: n,
        joints: edges.length,
    };
}

/**
 * Detect kinematic loops (cycles) in the mate graph via union-find: an edge
 * whose endpoints are already in the same connected set closes a loop. For each
 * such back-edge we recover the cycle as the tree path between its endpoints
 * (BFS over the spanning forest), so the returned cycle is the actual ring of
 * component ids — the place where independent pairwise solves can disagree.
 *
 * Deterministic: edges are processed in graph order (already id-sorted), the
 * spanning forest is built BFS with id-sorted adjacency, and each cycle is
 * canonicalised (rotated to start at its lexicographically-smallest member,
 * walked in the direction of its smaller neighbour).
 *
 * @param {MateGraph} graph
 * @returns {Array<{ components: string[], edges: string[] }>}
 */
export function detectLoops(graph) {
    const nodes = graph && graph.nodes ? graph.nodes : new Map();
    const edges = graph && Array.isArray(graph.edges) ? graph.edges : [];

    const parent = new Map();
    const rank = new Map();
    for (const id of nodes.keys()) { parent.set(id, id); rank.set(id, 0); }
    const find = (x) => {
        let r = x;
        while (parent.get(r) !== r) r = parent.get(r);
        // path-compress
        let cur = x;
        while (parent.get(cur) !== r) { const nx = parent.get(cur); parent.set(cur, r); cur = nx; }
        return r;
    };
    const union = (x, y) => {
        const rx = find(x), ry = find(y);
        if (rx === ry) return false;
        const a = rank.get(rx), b = rank.get(ry);
        if (a < b) parent.set(rx, ry);
        else if (a > b) parent.set(ry, rx);
        else { parent.set(ry, rx); rank.set(rx, a + 1); }
        return true;
    };

    // Spanning forest adjacency (only tree edges), plus the back-edges.
    const treeAdj = new Map();   // id → Array<{ to, edgeId }>
    for (const id of nodes.keys()) treeAdj.set(id, []);
    const backEdges = [];
    for (const e of edges) {
        if (!parent.has(e.a) || !parent.has(e.b)) continue;
        if (union(e.a, e.b)) {
            treeAdj.get(e.a).push({ to: e.b, edgeId: e.id });
            treeAdj.get(e.b).push({ to: e.a, edgeId: e.id });
        } else {
            backEdges.push(e);
        }
    }
    for (const list of treeAdj.values()) list.sort((p, q) => _cmp(p.to, q.to));

    const loops = [];
    for (const be of backEdges) {
        const path = _treePath(treeAdj, be.a, be.b);
        if (!path) continue;
        // path is component ids a..b through the tree; closing edge is `be`.
        const comps = path.nodes.slice();
        const edgeIds = path.edges.slice();
        edgeIds.push(be.id);                       // the closing back-edge
        const canon = _canonicalCycle(comps, edgeIds);
        loops.push(canon);
    }
    // Deterministic order: by first component, then length.
    loops.sort((x, y) => _cmp(x.components.join('>'), y.components.join('>')));
    return loops;
}

/** BFS the spanning forest from `src` to `dst`; returns {nodes,edges} path or null. */
function _treePath(treeAdj, src, dst) {
    if (src === dst) return { nodes: [src], edges: [] };
    const prev = new Map();         // node → { from, edgeId }
    const queue = [src];
    const seen = new Set([src]);
    while (queue.length) {
        const cur = queue.shift();
        for (const { to, edgeId } of (treeAdj.get(cur) || [])) {
            if (seen.has(to)) continue;
            seen.add(to);
            prev.set(to, { from: cur, edgeId });
            if (to === dst) {
                const nodesPath = [dst];
                const edgesPath = [];
                let n = dst;
                while (n !== src) {
                    const step = prev.get(n);
                    edgesPath.push(step.edgeId);
                    nodesPath.push(step.from);
                    n = step.from;
                }
                nodesPath.reverse();
                edgesPath.reverse();
                return { nodes: nodesPath, edges: edgesPath };
            }
            queue.push(to);
        }
    }
    return null;
}

/**
 * Rotate a cycle's component ring so it starts at its lexicographically-smallest
 * member and runs toward its smaller neighbour — a canonical form so the same
 * loop always serialises identically regardless of which back-edge found it.
 */
function _canonicalCycle(comps, edgeIds) {
    if (comps.length <= 1) return { components: comps.slice(), edges: edgeIds.slice() };
    // Find index of the smallest component id.
    let start = 0;
    for (let i = 1; i < comps.length; i++) if (_cmp(comps[i], comps[start]) < 0) start = i;
    const n = comps.length;
    const before = comps[(start - 1 + n) % n];
    const after = comps[(start + 1) % n];
    const forward = _cmp(after, before) <= 0;
    const out = [];
    for (let k = 0; k < n; k++) {
        const idx = forward ? (start + k) % n : (start - k + n) % n;
        out.push(comps[idx]);
    }
    return { components: out, edges: edgeIds.slice().sort(_cmp) };
}

/**
 * Components with no path to the grounded root — they'll float (be positioned
 * by nothing) in the assembly. Found by a flood-fill from root over the graph;
 * any node not reached is floating. The root itself is never floating; if there
 * is no grounded root, every node is reported (nothing anchors the assembly).
 *
 * @param {MateGraph} graph
 * @returns {string[]} floating componentIds, id-sorted
 */
export function findFloatingComponents(graph) {
    const nodes = graph && graph.nodes ? graph.nodes : new Map();
    const root = graph && graph.root;
    const all = Array.from(nodes.keys()).sort(_cmp);
    if (!root || !nodes.has(root)) return all;     // nothing grounded → all float

    const reached = new Set([root]);
    const queue = [root];
    while (queue.length) {
        const cur = queue.shift();
        for (const nb of (nodes.get(cur).neighbors || [])) {
            if (!reached.has(nb)) { reached.add(nb); queue.push(nb); }
        }
    }
    return all.filter((id) => !reached.has(id));
}

/**
 * Classify the assembly's constraint state and explain why.
 *
 * Precedence (a real assembly can hit several at once; we report the most
 * actionable first):
 *
 *   1. Floating parts          → 'under-constrained' (something isn't held).
 *   2. Mobility M > 0          → 'under-constrained' (free to move; M DOF).
 *   3. Over-constraint:        → 'over-constrained' when redundant constraints
 *      independent kinematic      exist — a loop of all-fixed joints, or
 *      loops add constraints       negative mobility. Pairwise solving of these
 *      a tree can't carry.         loops can disagree (the contract's warning).
 *   4. Otherwise (M === 0,     → 'exactly-constrained' (rigid, well-posed).
 *      no floats, no redundancy)
 *
 * A loop of fixed joints is the canonical over-constraint: every edge welds 6
 * DOF, but the tree already pinned the bodies, so the closing edge is redundant
 * — geometrically consistent only if the parts were modelled to agree. Loops
 * carrying a revolute/prismatic DOF (a 4-bar) are *mobile* loops and are NOT
 * over-constrained by themselves; the mobility count decides.
 *
 * @param {MateGraph} graph
 * @returns {{ status: 'under-constrained'|'exactly-constrained'|'over-constrained',
 *             mobility: number, reason: string,
 *             floating: string[], loops: Array<{components:string[],edges:string[]}>,
 *             offenders: { components: string[], mates: string[] } }}
 */
export function classifyConstraint(graph) {
    const dof = countDOF(graph);
    const floating = findFloatingComponents(graph);
    const loops = detectLoops(graph);
    const M = dof.remaining;

    // A loop is "redundant" (over-constraining) when it carries no mobility — i.e.
    // every edge in the loop is a fixed (0-DOF) joint. Such a loop's closing edge
    // imposes constraints the spanning tree already satisfied.
    const edgeById = new Map((graph && graph.edges ? graph.edges : []).map((e) => [e.id, e]));
    const rigidLoops = loops.filter((lp) =>
        lp.edges.length > 0 && lp.edges.every((id) => {
            const e = edgeById.get(id);
            return e && e.joint === 'fixed';
        }));

    // 1. Floating parts dominate — they're the clearest authoring error.
    if (floating.length) {
        const noGround = !(graph && graph.root && graph.nodes && graph.nodes.has(graph.root));
        const reason = noGround
            ? 'No grounded root component — nothing anchors the assembly, so every part floats.'
            : `${floating.length} component(s) have no mate path to the grounded root and will float: ${floating.join(', ')}.`;
        return {
            status: 'under-constrained',
            mobility: M,
            reason,
            floating,
            loops,
            offenders: { components: floating.slice(), mates: [] },
        };
    }

    // 2. Positive mobility → free to move.
    if (M > 0) {
        return {
            status: 'under-constrained',
            mobility: M,
            reason: `Assembly mobility is ${M} (Grübler: ${dof.gross} gross − ${dof.constrained} constrained). The mechanism has ${M} free degree(s) of freedom; add mates to fully fix it.`,
            floating,
            loops,
            offenders: { components: [], mates: [] },
        };
    }

    // 3. Over-constraint: negative mobility OR a rigid (all-fixed) loop.
    if (M < 0 || rigidLoops.length) {
        const offenderMates = Array.from(new Set(
            rigidLoops.flatMap((lp) => lp.edges),
        )).sort(_cmp);
        const offenderComps = Array.from(new Set(
            rigidLoops.flatMap((lp) => lp.components),
        )).sort(_cmp);
        const parts = [];
        if (M < 0) parts.push(`mobility is ${M} (more constraints than free DOF)`);
        if (rigidLoops.length) {
            parts.push(`${rigidLoops.length} rigid kinematic loop(s) close on fixed joints, adding redundant constraints`);
        }
        return {
            status: 'over-constrained',
            mobility: M,
            reason: `Over-constrained: ${parts.join('; ')}. Redundant constraints make pairwise mate solving order-dependent — solves can conflict unless the geometry is modelled to agree.`,
            floating,
            loops,
            offenders: { components: offenderComps, mates: offenderMates },
        };
    }

    // 4. Exactly constrained: rigid, well-posed.
    return {
        status: 'exactly-constrained',
        mobility: 0,
        reason: loops.length
            ? `Exactly constrained: mobility 0 with ${loops.length} mobile loop(s) that carry their own DOF — rigid and well-posed.`
            : 'Exactly constrained: mobility 0, every part has a unique mate path to ground. Rigid and well-posed.',
        floating: [],
        loops,
        offenders: { components: [], mates: [] },
    };
}

// ── internals ────────────────────────────────────────────────────────────────

/** Coerce a Map / plain-object / array of records into a flat array. */
function _asArray(coll) {
    if (Array.isArray(coll)) return coll;
    if (coll instanceof Map) return Array.from(coll.values());
    if (coll && typeof coll === 'object') return Object.values(coll);
    return [];
}

// ── Test seam — expose internals to the test suite ──────────────────────────
export const __test__ = {
    _JOINT_DOF, _FREE_BODY_DOF, _jointKind, _hostComponentId, _treePath, _canonicalCycle, _asArray,
};
