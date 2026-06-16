/**
 * Archetype decomposition seeder (Phase 1 of PLAN-deterministic-design.md).
 *
 * Turns a goal ("robot dog") into a STARTER plan-graph the model then refines.
 * The scaffold supplies the morphology (legs × joints, actuators, structural
 * parts, electronics) from the knowledge pattern card; the LLM tunes it via the
 * plan_* tools. Seeding deterministically (no Date/random) means the same goal
 * yields the same skeleton — reproducible, inspectable, diffable.
 *
 * Built parametric from day one: every fabricated structural part declares the
 * actuator/load it serves as a `dep`, so swapping a servo reflows its bracket.
 *
 *   seedPlanGraph(graph, goal) → { ok, archetype, rootId, nodeCount, summary }
 */

import { getPatternCard } from '../knowledge.js';

/** A revolute joint = a servo (buy) + a bracket (fabricate that reflows on it). */
function addJoint(graph, parentId, { label, jointTorqueNmm, actuator }) {
    const joint = graph.addNode({
        kind: 'subassembly', label, parentId,
        spec: { role: 'joint', jointType: 'revolute', jointTorqueNmm, actuator },
    });
    const servo = graph.addNode({
        kind: 'part', label: `${actuator} servo`, cls: 'buy', parentId: joint,
        spec: { role: 'actuator', partRef: actuator, interface: ['servo-horn'] },
    });
    const bracket = graph.addNode({
        kind: 'part', label: `${label} bracket`, cls: 'fabricate', parentId: joint,
        spec: { role: 'structure', interface: ['servo-mount'] },
        binding: { recipe: 'servoMount', params: {}, featureIds: [] },
    });
    graph.addDep(bracket, servo);   // bracket = f(servo) → reflows on a servo swap
    return { joint, servo, bracket };
}

/** Build the quadruped template (matches the NovaSpotMicro / SpotMicro card). */
function seedQuadruped(graph, goal, card) {
    const root = graph.addNode({ kind: 'assembly', label: goal || 'Quadruped robot' });

    // ── Body + electronics (the skeleton the structure serves) ──
    const body = graph.addNode({ kind: 'subassembly', label: 'Body', parentId: root });
    const shell = graph.addNode({
        kind: 'part', label: 'Body shell', cls: 'fabricate', parentId: body,
        spec: { role: 'structure', massG: 250 },
        binding: { recipe: 'bodyShellWithBosses', params: {}, featureIds: [] },
    });
    const controller = graph.addNode({ kind: 'part', label: 'Controller (Pi/ESP32)', cls: 'buy', parentId: body, spec: { role: 'compute', massG: 50 } });
    const driver = graph.addNode({ kind: 'part', label: 'Servo driver (PCA9685)', cls: 'buy', parentId: body, spec: { role: 'driver', massG: 20 } });
    const battery = graph.addNode({ kind: 'part', label: 'Battery (2S LiPo)', cls: 'buy', parentId: body, spec: { role: 'power', massG: 150 } });
    // The shell hosts the electronics → it reflows if any of them change size.
    for (const e of [controller, driver, battery]) graph.addDep(shell, e);

    // ── One parametric leg design (instanced ×4) ──
    const leg = graph.addNode({ kind: 'subassembly', label: 'Leg (design)', parentId: root });
    // Three serial revolute joints, body-outward. Knee carries the highest moment.
    addJoint(graph, leg, { label: 'Hip abduct', jointTorqueNmm: 300, actuator: 'MG996R' });
    addJoint(graph, leg, { label: 'Hip flex', jointTorqueNmm: 600, actuator: 'MG996R' });
    addJoint(graph, leg, { label: 'Knee flex', jointTorqueNmm: 750, actuator: 'DS3218' });
    const femur = graph.addNode({
        kind: 'part', label: 'Femur link', cls: 'fabricate', parentId: leg,
        spec: { role: 'structure', massG: 40 }, binding: { recipe: 'legLink', params: {}, featureIds: [] },
    });
    const tibia = graph.addNode({
        kind: 'part', label: 'Tibia link', cls: 'fabricate', parentId: leg,
        spec: { role: 'structure', massG: 40 }, binding: { recipe: 'legLink', params: {}, featureIds: [] },
    });
    const foot = graph.addNode({ kind: 'part', label: 'Foot tip (compliant)', cls: 'buy', parentId: leg, spec: { role: 'contact', massG: 8 } });
    graph.setAccept(leg, [{ check: 'i-motion-clearance' }, { check: 'i-printed-fit' }]);

    // ── Instance the leg ×4, mirrored L/R (never reuse one chirality) ──
    const legs = graph.instance(leg, { count: 4, chirality: ['left', 'right', 'left', 'right'], parentId: root, labelPrefix: 'Leg' });

    graph.commit('v1 — seed');
    return {
        ok: true, archetype: 'quadruped', rootId: root, nodeCount: graph.allNodes().length,
        summary: `Seeded a quadruped: body + electronics (controller/driver/battery), 1 parametric leg `
            + `(3 revolute joints → 3 servos + 3 brackets, femur, tibia, foot) instanced ×4 (2 mirrored). `
            + `12 servos / 12 DOF. Refine with the plan_* tools, then run_closure_check before the BOM.`,
        legInstances: legs.length,
        cite: Array.isArray(card?.references) ? card.references.slice(0, 2) : [],
    };
}

/** Generic fallback: a root assembly the model decomposes via the plan_* tools. */
function seedGeneric(graph, goal, card) {
    const root = graph.addNode({ kind: 'assembly', label: goal || 'Assembly' });
    graph.commit('v1 — seed');
    return {
        ok: true, archetype: card?.archetype || 'custom', rootId: root, nodeCount: graph.allNodes().length,
        summary: `Seeded a root assembly "${goal}". No specialised template for this archetype — `
            + `decompose it with plan_split_node (subassemblies → parts), classify each leaf `
            + `(plan_set_class buy/reuse/fabricate), wire deps, then run_closure_check.`,
    };
}

/**
 * Seed a plan-graph from a goal. Resets the graph first (one design per seed).
 * @param {import('./graph.js').PlanGraph} graph
 * @param {string} goal
 * @param {{ card?: object|null }} [opts]
 */
export function seedPlanGraph(graph, goal, { card = null } = {}) {
    if (!graph || typeof graph.addNode !== 'function') return { ok: false, error: 'no graph' };
    graph.reset();
    const resolved = card || getPatternCard(goal);
    if (resolved && resolved.archetype === 'quadruped') return seedQuadruped(graph, goal, resolved);
    return seedGeneric(graph, goal, resolved);
}

export default seedPlanGraph;
