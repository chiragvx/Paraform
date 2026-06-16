/**
 * Physics closure pass (Phase 2 of PLAN-deterministic-design.md).
 *
 * The gate between "a tree that LOOKS like a dog" and "a dog that STANDS UP".
 * Runs symbolic, pre-geometry budgets over the plan-graph so a non-closing
 * design is caught BEFORE any part is committed or printed:
 *
 *   - MASS budget   — sum estimated part masses vs a target.
 *   - TORQUE budget — each joint's required torque (incl. safety factor) vs the
 *     rated torque of the actuator it declares; on failure, deterministically
 *     suggests the lowest servo-ladder rung that WOULD hold (the "servo too
 *     weak → step up" rule).
 *   - COM          — if nodes carry rough positions, check the centre of mass
 *     falls inside the support polygon (won't tip); otherwise advisory.
 *
 * Pure + total: reads only graph node specs + the static servo knowledge, never
 * the kernel, never throws. Drives `run_closure_check` and a future invariant.
 *
 * Node spec contract (all optional — closure uses whatever is present):
 *   spec.massG            explicit mass in grams
 *   spec.partRef          servo id (e.g. 'MG996R') → mass + rated torque
 *   spec.jointTorqueNmm   required torque at this joint (N·mm)
 *   spec.actuator         servo id driving this joint → rated torque
 *   spec.pos              [x,y,z] rough position (mm) for COM
 *   spec.support          [[x,y],…] support-polygon footprint (mm) on the root
 */

import { getServoLadder } from '../knowledge.js';

const NMM_PER_KGCM = 98.0665;          // 1 kg·cm of torque = 9.80665 N·cm = 98.0665 N·mm
const round = (v, n = 2) => (Number.isFinite(v) ? +v.toFixed(n) : v);
const isObj = (o) => o && typeof o === 'object' && !Array.isArray(o);

/** id (lowercased) → servo record, from the knowledge ladder. */
function servoIndex() {
    const idx = new Map();
    for (const s of getServoLadder()) {
        if (s && typeof s.id === 'string') idx.set(s.id.toLowerCase(), s);
    }
    return idx;
}

/** Lowest ladder rung whose rated torque ≥ need (kg·cm), or null if none fits. */
function smallestServoFor(needKgCm) {
    let best = null;
    for (const s of getServoLadder()) {
        const r = Number(s && s.torqueKgCm);
        if (Number.isFinite(r) && r >= needKgCm) {
            if (!best || r < best.torqueKgCm) best = s;
        }
    }
    return best;
}

function nodeMassG(node, servos) {
    const spec = isObj(node.spec) ? node.spec : {};
    if (Number.isFinite(spec.massG)) return spec.massG;
    if (typeof spec.partRef === 'string') {
        const s = servos.get(spec.partRef.toLowerCase());
        if (s && s.size && Number.isFinite(s.size.massG)) return s.size.massG;
    }
    return 0;
}

function ratedTorqueKgCm(actuatorId, servos) {
    if (typeof actuatorId !== 'string') return null;
    const s = servos.get(actuatorId.toLowerCase());
    return s && Number.isFinite(s.torqueKgCm) ? s.torqueKgCm : null;
}

/**
 * Run the closure pass over a PlanGraph.
 * @param {import('./graph.js').PlanGraph} graph
 * @param {{ targetMassG?: number|null, safetyFactor?: number }} [opts]
 * @returns {{ ok:boolean, totalMassG:number, checks:object[], issues:object[] }}
 */
export function runClosureCheck(graph, { targetMassG = null, safetyFactor = 1.5 } = {}) {
    const nodes = (graph && typeof graph.allNodes === 'function') ? graph.allNodes() : [];
    const servos = servoIndex();
    const sf = Number.isFinite(safetyFactor) && safetyFactor > 0 ? safetyFactor : 1.5;
    const checks = [];
    const issues = [];

    // ── MASS ──────────────────────────────────────────────────────────────────
    // Instances make real copies: a "design" subassembly that is some instance's
    // source is a TEMPLATE (counted per-instance, not once), so 4 legs weigh 4×
    // the leg design — not 1× plus four weightless references.
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const ownMass = (n) => nodeMassG(n, servos);
    const subtreeMass = (id, seen = new Set()) => {
        if (seen.has(id)) return 0; seen.add(id);
        const n = byId.get(id); if (!n) return 0;
        let m = ownMass(n);
        for (const c of (n.children || [])) m += subtreeMass(c, seen);
        return m;
    };
    const templateIds = new Set(nodes.map((n) => n.instanceOf).filter(Boolean));
    // Mark every node inside a template subtree so the direct sum skips it.
    const inTemplate = new Set();
    const markSub = (id) => { if (inTemplate.has(id)) return; inTemplate.add(id); const n = byId.get(id); for (const c of (n?.children || [])) markSub(c); };
    for (const tid of templateIds) markSub(tid);

    let totalMassG = 0;
    const massBreakdown = [];
    for (const n of nodes) {
        if (inTemplate.has(n.id)) continue;             // counted via instances
        if (n.kind === 'instance') {
            const m = round(subtreeMass(n.instanceOf));
            if (m > 0) { totalMassG += m; massBreakdown.push({ id: n.id, label: n.label, massG: m, fromTemplate: n.instanceOf }); }
            continue;
        }
        const m = ownMass(n);
        if (m > 0) { totalMassG += m; massBreakdown.push({ id: n.id, label: n.label, massG: m }); }
    }
    totalMassG = round(totalMassG);
    const massOk = targetMassG == null || totalMassG <= targetMassG;
    checks.push({ check: 'mass-budget', totalMassG, targetMassG, ok: massOk, items: massBreakdown.length });
    if (!massOk) {
        issues.push({
            check: 'mass-budget', severity: 'warning', nodeId: null,
            message: `Estimated mass ${totalMassG} g exceeds the ${targetMassG} g target.`,
            suggestedFix: 'Thin walls on fabricated parts, drop to a lighter battery, or raise the target.',
        });
    }

    // ── TORQUE ──────────────────────────────────────────────────────────────────
    for (const n of nodes) {
        const spec = isObj(n.spec) ? n.spec : {};
        const reqNmm = Number(spec.jointTorqueNmm);
        if (!Number.isFinite(reqNmm) || reqNmm <= 0) continue;
        const reqKgCm = round(reqNmm / NMM_PER_KGCM);
        const reqWithSf = round(reqKgCm * sf);
        const rated = ratedTorqueKgCm(spec.actuator, servos);
        const ok = rated != null && rated >= reqWithSf;
        const entry = {
            check: 'joint-torque', nodeId: n.id, label: n.label,
            requiredKgCm: reqKgCm, requiredWithSafetyKgCm: reqWithSf, safetyFactor: sf,
            actuator: spec.actuator || null, ratedKgCm: rated, ok,
        };
        checks.push(entry);
        if (!ok) {
            const fix = smallestServoFor(reqWithSf);
            entry.suggestedActuator = fix ? fix.id : null;
            issues.push({
                check: 'joint-torque', severity: 'error', nodeId: n.id,
                message: `Joint "${n.label}" needs ${reqWithSf} kg·cm (incl. ×${sf} safety) but `
                    + `${spec.actuator || 'no actuator'} provides ${rated == null ? '—' : rated} kg·cm.`,
                suggestedFix: fix
                    ? `Step the actuator up to ${fix.id} (${fix.torqueKgCm} kg·cm) via plan_replace_part, or shorten the moment arm.`
                    : 'No catalogued servo holds this load — shorten the moment arm or reduce mass.',
            });
        }
    }

    // ── COM (advisory unless positions + a support polygon are present) ──────────
    const positioned = nodes.filter((n) => isObj(n.spec) && Array.isArray(n.spec.pos) && n.spec.pos.length >= 2 && nodeMassG(n, servos) > 0);
    const support = nodes.map((n) => isObj(n.spec) && Array.isArray(n.spec.support) ? n.spec.support : null).find(Boolean);
    if (positioned.length && support && support.length >= 3) {
        let mx = 0, my = 0, m = 0;
        for (const n of positioned) { const w = nodeMassG(n, servos); mx += w * n.spec.pos[0]; my += w * n.spec.pos[1]; m += w; }
        const com = [round(mx / m), round(my / m)];
        const inside = pointInPolygon(com, support);
        checks.push({ check: 'com-support', com, inside, ok: inside });
        if (!inside) {
            issues.push({
                check: 'com-support', severity: 'error', nodeId: null,
                message: `Centre of mass ${JSON.stringify(com)} falls OUTSIDE the support polygon — the machine tips.`,
                suggestedFix: 'Move the heavy items (battery) toward the centre, or widen the stance.',
            });
        }
    } else {
        checks.push({ check: 'com-support', ok: true, advisory: 'positions not yet assigned — COM check deferred' });
    }

    return { ok: issues.filter((i) => i.severity === 'error').length === 0, totalMassG, checks, issues };
}

/** Ray-cast point-in-polygon (2D). */
function pointInPolygon(pt, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
        const hit = ((yi > pt[1]) !== (yj > pt[1])) && (pt[0] < ((xj - xi) * (pt[1] - yi)) / ((yj - yi) || 1e-9) + xi);
        if (hit) inside = !inside;
    }
    return inside;
}

export default runClosureCheck;
