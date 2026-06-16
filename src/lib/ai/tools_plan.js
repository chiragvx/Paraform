/**
 * Plan-graph AI tools (Phases 1–2 of PLAN-deterministic-design.md).
 *
 * Exposes the plan-graph (graph.js) to the model as the SOURCE OF TRUTH for
 * design intent — decompose → classify → version → physics-close — BEFORE any
 * geometry. Each mutating tool flushes the live graph into the document
 * (syncPlanGraphToDoc) so the plan persists in `.paraform.json` and checkpoints
 * have something to restore.
 *
 * Shape matches the other tool modules: an array of
 * { name, description, input_schema, handler }. Handlers never throw — they
 * return { ok:false, error } on bad input (dispatchTool also guards).
 */

import { getPlanGraph } from './plan/graph.js';
import { syncPlanGraphToDoc } from './plan/sync.js';
import { seedPlanGraph } from './plan/decompose.js';
import { runClosureCheck } from './plan/closure.js';
import { classifyNode, findPartFor } from './plan/classify.js';

const N = (description, opts = {}) => ({ type: 'number', description, ...opts });
const S = (description, opts = {}) => ({ type: 'string', description, ...opts });
const B = (description) => ({ type: 'boolean', description });

const g = () => getPlanGraph();
/** Run after every mutation so the plan persists with the document. */
function sync() { try { syncPlanGraphToDoc(); } catch { /* persistence optional */ } }

/** Compact node view for the model (drops verbose internals). */
function compactNode(n) {
    return {
        id: n.id, kind: n.kind, label: n.label, cls: n.cls, status: n.status,
        parentId: n.parentId, children: n.children,
        instanceOf: n.instanceOf || undefined, chirality: n.chirality || undefined,
        stale: n.stale || undefined,
        role: n.spec?.role || undefined,
        partRef: n.spec?.partRef || undefined,
        recipe: n.binding?.recipe || undefined,
        deps: n.deps?.length ? n.deps : undefined,
    };
}

/** Expand instance/template counts so a BOM reflects real part quantities. */
function bomQuantities(graph) {
    const nodes = graph.allNodes();
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const templateIds = new Set(nodes.map((n) => n.instanceOf).filter(Boolean));
    const inTemplate = new Set();
    const mark = (id) => { if (inTemplate.has(id)) return; inTemplate.add(id); for (const c of (byId.get(id)?.children || [])) mark(c); };
    for (const tid of templateIds) mark(tid);

    // Base multiplier 1 for non-template nodes; instances add their template subtree ×1.
    const tally = new Map();   // key → { node, qty }
    const add = (node, qty) => {
        if (node.kind === 'assembly' || node.kind === 'subassembly' || node.kind === 'instance') return;
        const key = node.id;
        const cur = tally.get(key) || { node, qty: 0 };
        cur.qty += qty; tally.set(key, cur);
    };
    const addSubtree = (id, mult) => { const n = byId.get(id); if (!n) return; add(n, mult); for (const c of (n.children || [])) addSubtree(c, mult); };

    for (const n of nodes) {
        if (inTemplate.has(n.id)) continue;
        if (n.kind === 'instance') { if (n.instanceOf) addSubtree(n.instanceOf, 1); continue; }
        add(n, 1);
    }
    return [...tally.values()];
}

export const PLAN_TOOLS = [
    // ── Read ────────────────────────────────────────────────────────────────────
    {
        name: 'get_plan_graph',
        description: 'Read the current PLAN-GRAPH — the source of truth for the design (assemblies → subassemblies → parts), each leaf classed buy/reuse/fabricate, with version history. Returns the nodes, a mermaid view, the version list, and any STALE nodes that need rebuilding. Call this before editing the plan or building geometry.',
        input_schema: { type: 'object', properties: {} },
        handler: () => {
            const graph = g();
            return {
                ok: true,
                nodeCount: graph.allNodes().length,
                nodes: graph.allNodes().map(compactNode),
                rootIds: graph.rootIds,
                mermaid: graph.toMermaid(),
                versions: graph.listVersions(),
                currentVersion: graph.currentVersionId,
                stale: graph.staleNodes().map((n) => n.id),
            };
        },
    },

    // ── Decompose / seed ──────────────────────────────────────────────────────
    {
        name: 'propose_plan_graph',
        description: 'Seed the plan-graph from a goal ("robot dog", "robot arm"). For a known archetype it lays out the full morphology (e.g. quadruped = body + electronics + ONE parametric leg instanced ×4 with 3 revolute joints each → 12 servos / 12 DOF). REPLACES any existing plan. Use this FIRST for a functional machine, then refine with the plan_* tools, classify leaves, and run_closure_check before building. Returns a summary + mermaid map to show the user for approval.',
        input_schema: {
            type: 'object',
            properties: { goal: S('What to build, in the user\'s words') },
            required: ['goal'],
        },
        handler: (i) => {
            const r = seedPlanGraph(g(), i.goal);
            sync();
            return { ...r, mermaid: g().toMermaid(), nodes: g().allNodes().map(compactNode) };
        },
    },

    // ── Structural edits ──────────────────────────────────────────────────────
    {
        name: 'plan_add_node',
        description: 'Add a node to the plan-graph. kind = assembly | subassembly | part | instance. Use cls to class a part leaf (buy/reuse/fabricate). Optionally bind a fabricate part to a recipe and declare what it depends on (deps) so it reflows when that changes.',
        input_schema: {
            type: 'object',
            properties: {
                kind: S('Node kind', { enum: ['assembly', 'subassembly', 'part', 'instance'] }),
                label: S('Human label'),
                parentId: S('Parent node id (omit for a root)'),
                cls: S('Part class', { enum: ['buy', 'reuse', 'fabricate', 'unknown'] }),
                role: S('Functional role (actuator, structure, compute, power, …)'),
                recipe: S('build_part_recipe name for a fabricate part (e.g. servoMount, legLink)'),
                deps: { type: 'array', items: { type: 'string' }, description: 'Node ids this node is a function of (reflow edges)' },
            },
            required: ['kind', 'label'],
        },
        handler: (i) => {
            const id = g().addNode({
                kind: i.kind, label: i.label, parentId: i.parentId, cls: i.cls,
                spec: i.role ? { role: i.role } : undefined,
                binding: i.recipe ? { recipe: i.recipe, params: {}, featureIds: [] } : undefined,
            });
            if (!id) return { ok: false, error: 'addNode failed' };
            for (const d of (Array.isArray(i.deps) ? i.deps : [])) g().addDep(id, d);
            sync();
            return { ok: true, nodeId: id, summary: `Added ${i.kind} "${i.label}"` };
        },
    },
    {
        name: 'plan_split_node',
        description: 'Decompose a node into child parts/subassemblies (the breakdown step: "a leg → hip, femur, knee, tibia"). Promotes a part to a subassembly. Pass an array of children.',
        input_schema: {
            type: 'object',
            properties: {
                nodeId: S('Node to decompose'),
                children: {
                    type: 'array',
                    description: 'Child nodes',
                    items: {
                        type: 'object',
                        properties: { label: S('Label'), kind: S('Kind', { enum: ['subassembly', 'part'] }), cls: S('Class', { enum: ['buy', 'reuse', 'fabricate', 'unknown'] }), role: S('Role') },
                        required: ['label'],
                    },
                },
            },
            required: ['nodeId', 'children'],
        },
        handler: (i) => {
            const ids = g().splitNode(i.nodeId, (i.children || []).map((c) => ({ ...c, spec: c.role ? { role: c.role } : undefined })));
            if (!ids.length) return { ok: false, error: 'splitNode failed (bad node id or empty children)' };
            sync();
            return { ok: true, childIds: ids, summary: `Split into ${ids.length} child(ren)` };
        },
    },
    {
        name: 'plan_instance',
        description: 'Instance ONE design as N placements (4 legs from 1 leg design — never model four). Each instance references the source and reflows when it changes; pass chirality to mirror left/right (a quadruped needs mirrored legs).',
        input_schema: {
            type: 'object',
            properties: {
                sourceId: S('The design node to instance'),
                count: N('Number of placements'),
                chirality: { type: 'array', items: { type: 'string' }, description: 'Per-instance "left"/"right" (optional)' },
                parentId: S('Parent for the instances (default: source\'s parent)'),
            },
            required: ['sourceId', 'count'],
        },
        handler: (i) => {
            const ids = g().instance(i.sourceId, { count: i.count, chirality: i.chirality, parentId: i.parentId });
            if (!ids.length) return { ok: false, error: 'instance failed (bad source id)' };
            sync();
            return { ok: true, instanceIds: ids, summary: `Instanced ×${ids.length}` };
        },
    },
    {
        name: 'plan_remove_node',
        description: 'Remove a node and its subtree from the plan-graph.',
        input_schema: { type: 'object', properties: { nodeId: S('Node to remove') }, required: ['nodeId'] },
        handler: (i) => { const ok = g().removeNode(i.nodeId); sync(); return ok ? { ok: true, summary: `Removed ${i.nodeId}` } : { ok: false, error: 'no such node' }; },
    },

    // ── Spec / class / status / binding ───────────────────────────────────────
    {
        name: 'plan_set_class',
        description: 'Set a leaf\'s class: buy (COTS — servo/bearing/fastener), reuse (existing library part), or fabricate (generate parametrically). Prefer buy for anything standard.',
        input_schema: { type: 'object', properties: { nodeId: S('Node'), cls: S('Class', { enum: ['buy', 'reuse', 'fabricate', 'unknown'] }) }, required: ['nodeId', 'cls'] },
        handler: (i) => { const ok = g().setClass(i.nodeId, i.cls); sync(); return ok ? { ok: true, summary: `${i.nodeId} → ${i.cls}` } : { ok: false, error: 'bad node/class' }; },
    },
    {
        name: 'plan_set_status',
        description: 'Set a node\'s build status: pending | building | verified | blocked. The executor and the map use this to track progress.',
        input_schema: { type: 'object', properties: { nodeId: S('Node'), status: S('Status', { enum: ['pending', 'building', 'verified', 'blocked'] }) }, required: ['nodeId', 'status'] },
        handler: (i) => { const ok = g().setStatus(i.nodeId, i.status); sync(); return ok ? { ok: true } : { ok: false, error: 'bad node/status' }; },
    },
    {
        name: 'plan_edit_spec',
        description: 'Patch a node\'s spec (dimensions, load, jointTorqueNmm, actuator, partRef, massG, …). This marks the node AND everything that depends on it STALE so only the affected parts reflow — e.g. changing a joint\'s jointTorqueNmm re-checks its actuator; changing a hosted part\'s size reflows its mount.',
        input_schema: {
            type: 'object',
            properties: { nodeId: S('Node'), spec: { type: 'object', description: 'Spec fields to merge', additionalProperties: true } },
            required: ['nodeId', 'spec'],
        },
        handler: (i) => { const ok = g().editNodeSpec(i.nodeId, i.spec); sync(); return ok ? { ok: true, stale: g().staleNodes().map((n) => n.id), summary: `Edited spec of ${i.nodeId}` } : { ok: false, error: 'bad node' }; },
    },
    {
        name: 'plan_replace_part',
        description: 'Swap a part (e.g. "use camera module 123 (50×50) instead of XYZ (10×20)", or step a servo up the ladder). Records the new partRef + any size change and reflows dependents (the mount, the shell cutout). This is how an approved part change versions cleanly.',
        input_schema: {
            type: 'object',
            properties: {
                nodeId: S('Node to swap'),
                partRef: S('New part id / catalog ref'),
                cls: S('Resulting class', { enum: ['buy', 'reuse', 'fabricate'] }),
                spec: { type: 'object', description: 'Spec deltas (e.g. new size)', additionalProperties: true },
            },
            required: ['nodeId'],
        },
        handler: (i) => { const ok = g().replacePart(i.nodeId, { partRef: i.partRef, cls: i.cls || 'buy', spec: i.spec }); sync(); return ok ? { ok: true, stale: g().staleNodes().map((n) => n.id), summary: `Swapped ${i.nodeId}${i.partRef ? ` → ${i.partRef}` : ''}` } : { ok: false, error: 'bad node' }; },
    },
    {
        name: 'plan_add_dep',
        description: 'Declare that one node is a function of another (a bracket depends on the servo it holds), so editing the dependency reflows this node.',
        input_schema: { type: 'object', properties: { nodeId: S('Dependent node'), dependsOn: S('The node it depends on') }, required: ['nodeId', 'dependsOn'] },
        handler: (i) => { const ok = g().addDep(i.nodeId, i.dependsOn); sync(); return ok ? { ok: true } : { ok: false, error: 'bad ids' }; },
    },
    {
        name: 'plan_bind',
        description: 'Bind a fabricate node to how it gets built: a build_part_recipe name + params, and the document featureIds it produced (back-link for reflow). Set after you build the geometry so the plan tracks what realised each part.',
        input_schema: {
            type: 'object',
            properties: {
                nodeId: S('Node'),
                recipe: S('Recipe name (servoMount, legLink, …)'),
                params: { type: 'object', description: 'Recipe params', additionalProperties: true },
                featureIds: { type: 'array', items: { type: 'string' }, description: 'Document feature ids this part produced' },
            },
            required: ['nodeId'],
        },
        handler: (i) => { const ok = g().setBinding(i.nodeId, { recipe: i.recipe, params: i.params, featureIds: i.featureIds }); sync(); return ok ? { ok: true } : { ok: false, error: 'bad node' }; },
    },
    {
        name: 'plan_set_accept',
        description: 'Set a node\'s acceptance tests — the done-criteria checked at build time (e.g. i-motion-clearance, i-printed-fit, or a measure with an expected value). A node is not "verified" until these pass.',
        input_schema: {
            type: 'object',
            properties: { nodeId: S('Node'), accept: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'Acceptance test descriptors' } },
            required: ['nodeId', 'accept'],
        },
        handler: (i) => { const ok = g().setAccept(i.nodeId, i.accept); sync(); return ok ? { ok: true } : { ok: false, error: 'bad node' }; },
    },
    {
        name: 'plan_classify',
        description: 'Classify a leaf as buy/reuse/fabricate from its role + label, and (for buy/reuse) search the library for concrete part candidates. Applies the class and returns candidate partIds you can confirm with plan_replace_part.',
        input_schema: { type: 'object', properties: { nodeId: S('Node to classify'), search: B('Also search the library for a concrete part (default true)') }, required: ['nodeId'] },
        handler: async (i) => {
            const node = g().getNode(i.nodeId);
            if (!node) return { ok: false, error: 'no such node' };
            const c = classifyNode(node);
            g().setClass(i.nodeId, c.cls);
            let candidates = [];
            if (i.search !== false && c.cls !== 'fabricate') {
                const r = await findPartFor(node);
                candidates = r.candidates;
            }
            sync();
            return { ok: true, cls: c.cls, reason: c.reason, candidates, summary: `${node.label} → ${c.cls}` };
        },
    },

    // ── Versioning ──────────────────────────────────────────────────────────────
    {
        name: 'plan_commit',
        description: 'Snapshot the current plan as a named version (a revert point). Commit after the user approves the map, and before a big change, so you can diff and roll back.',
        input_schema: { type: 'object', properties: { label: S('Version label (e.g. "v2 — bigger camera")') }, required: ['label'] },
        handler: (i) => { const id = g().commit(i.label); sync(); return { ok: true, versionId: id, summary: `Committed ${id} (${i.label})` }; },
    },
    {
        name: 'plan_checkout',
        description: 'Restore a committed plan version (revert). Use plan_list_versions to find the id.',
        input_schema: { type: 'object', properties: { versionId: S('Version id') }, required: ['versionId'] },
        handler: (i) => { const ok = g().checkout(i.versionId); sync(); return ok ? { ok: true, summary: `Checked out ${i.versionId}` } : { ok: false, error: 'no such version' }; },
    },
    {
        name: 'plan_list_versions',
        description: 'List the plan\'s committed versions (id, label, when).',
        input_schema: { type: 'object', properties: {} },
        handler: () => ({ ok: true, versions: g().listVersions(), currentVersion: g().currentVersionId }),
    },
    {
        name: 'plan_diff',
        description: 'Diff two plan versions (or a version vs the working draft) — what was added, removed, or changed (e.g. "camera spec: cam-xyz 10×20 → cam-123 50×50"). Show this when the user asks what changed between versions.',
        input_schema: { type: 'object', properties: { fromVersion: S('Earlier version id'), toVersion: S('Later version id (omit for the working draft)') }, required: ['fromVersion'] },
        handler: (i) => ({ ok: true, diff: g().diff(i.fromVersion, i.toVersion) }),
    },

    // ── Analysis: physics closure + BOM ──────────────────────────────────────────
    {
        name: 'run_closure_check',
        description: 'PHYSICS CLOSURE — the gate before the BOM. Symbolic, pre-geometry budgets over the plan: total MASS (vs an optional target), per-joint TORQUE (required ×safety vs the actuator\'s rating — fails with a deterministic servo-step suggestion), and CENTRE OF MASS vs the support polygon when positions are set. Run this before declaring the plan ready; fix what fails (often plan_replace_part to a stronger servo) and re-run. This is what turns "looks like a dog" into "stands up".',
        input_schema: {
            type: 'object',
            properties: { targetMassG: N('Optional mass budget in grams'), safetyFactor: N('Torque safety factor (default 1.5)') },
        },
        handler: (i) => ({ ok: true, ...runClosureCheck(g(), { targetMassG: i.targetMassG ?? null, safetyFactor: i.safetyFactor }) }),
    },
    {
        name: 'plan_bom',
        description: 'Generate the Bill of Materials from the plan-graph, with real quantities (instances expand — 1 leg design × 4 legs = 4× each servo). Splits into BUY (order these), REUSE (existing library parts), and FABRICATE (print/make these). Use to show the user what to purchase vs print.',
        input_schema: { type: 'object', properties: {} },
        handler: () => {
            const rows = bomQuantities(g());
            const group = (cls) => rows.filter((r) => r.node.cls === cls).map((r) => ({ label: r.node.label, qty: r.qty, partRef: r.node.spec?.partRef || null, recipe: r.node.binding?.recipe || null }));
            const buy = group('buy'), reuse = group('reuse'), fabricate = group('fabricate');
            const total = (a) => a.reduce((s, x) => s + x.qty, 0);
            return {
                ok: true,
                buy, reuse, fabricate,
                summary: `BOM: ${total(buy)} to buy, ${total(reuse)} to reuse, ${total(fabricate)} to fabricate.`,
            };
        },
    },
];

export default PLAN_TOOLS;
