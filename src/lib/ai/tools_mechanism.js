/**
 * Mechanism-planning tool layer — the Morphology stage (S2) of the
 * Functional-Design Brain (PLAN-functional-design-brain.md §1, §2 S2).
 *
 *   MECHANISM_TOOLS — array of { name, description, input_schema, handler }
 *
 * The central inversion of the brain is Function → Skeleton → Structure →
 * Surface. Before any geometry exists, the agent must decide WHAT ACTUATES the
 * artifact: how many moving parts, which joints, which axes, which actuators.
 * `plan_mechanism` is the strict slot-filling schema that forces a weak model
 * (gpt-oss-120b) to declare that kinematic skeleton — links + joints — instead
 * of jumping straight to "a box with four cylinders." The handler does the
 * thinking the model can't be trusted with: it VALIDATES each joint, fills
 * defaults, and DETERMINISTICALLY computes the degrees of freedom and the count
 * of moving joints, then persists the normalized morphology spec to the design
 * context so every downstream stage (skeleton placement, structure recipes,
 * motion-clearance verification) reads the same kinematic graph.
 *
 * Pure planning + state-write: this tool never touches the kernel and never
 * mutates the document, so it cannot fail on infrastructure. Like every tool
 * handler in this surface it NEVER throws — try/catch → { ok:false, error }.
 *
 * Coordinate convention (CLAUDE.md): joint axes are unit 3-vectors in part-local
 * mm, Z-up, composed under THREE 'XYZ' euler. ranges are in DEGREES.
 */

import { getAIContext } from './context.js';
import { S, ARR, num, normalize3, fail } from './tools_util.js';

/** Degrees of freedom contributed by one joint of each type. */
const JOINT_DOF = { revolute: 1, prismatic: 1, fixed: 0 };
const JOINT_TYPES = ['revolute', 'prismatic', 'fixed'];

/** A safe, non-zero default axis (+Z, the up axis in this Z-up project). */
const DEFAULT_AXIS = [0, 0, 1];

/** Coerce a freeform string to a known joint type, defaulting to 'revolute'. */
function normJointType(t) {
    const v = typeof t === 'string' ? t.trim().toLowerCase() : '';
    return JOINT_TYPES.includes(v) ? v : 'revolute';
}

/**
 * Normalise a [min,max] degree range. A fixed joint has no travel → [0,0].
 * Otherwise default to a sane revolute sweep and keep min ≤ max.
 */
function normRange(range, type) {
    if (type === 'fixed') return [0, 0];
    if (Array.isArray(range) && range.length >= 2) {
        const lo = num(range[0], NaN);
        const hi = num(range[1], NaN);
        if (Number.isFinite(lo) && Number.isFinite(hi)) {
            return lo <= hi ? [lo, hi] : [hi, lo];
        }
    }
    // Default travel: a servo-class revolute sweep, a modest prismatic stroke.
    return type === 'prismatic' ? [0, 30] : [-90, 90];
}

/** Normalise one joint record; returns null if it lacks an identity. */
function normJoint(j, idx) {
    if (!j || typeof j !== 'object') return null;
    const id = (typeof j.id === 'string' && j.id.trim()) ? j.id.trim() : `j${idx + 1}`;
    const type = normJointType(j.type);
    // A fixed joint's axis is meaningless but we keep a valid vector for uniformity.
    const axis = type === 'fixed'
        ? DEFAULT_AXIS.slice()
        : (normalize3(j.axis) || DEFAULT_AXIS.slice());
    const range = normRange(j.range, type);
    return {
        id,
        type,
        axis,
        range,
        drivenBy: (typeof j.drivenBy === 'string' && j.drivenBy.trim()) ? j.drivenBy.trim() : null,
        parentLink: (typeof j.parentLink === 'string' && j.parentLink.trim()) ? j.parentLink.trim() : null,
        childLink: (typeof j.childLink === 'string' && j.childLink.trim()) ? j.childLink.trim() : null,
    };
}

/** Normalise one link record; returns null if it lacks an identity. */
function normLink(l, idx) {
    if (!l || typeof l !== 'object') return null;
    const id = (typeof l.id === 'string' && l.id.trim()) ? l.id.trim() : `link${idx + 1}`;
    return {
        id,
        name: (typeof l.name === 'string' && l.name.trim()) ? l.name.trim() : id,
        role: (typeof l.role === 'string' && l.role.trim()) ? l.role.trim() : null,
    };
}

const TOOLS = [
    {
        name: 'plan_mechanism',
        description:
            'Plan the kinematic skeleton (morphology) of a NOVEL articulated artifact — a robot, creature, or machine — BEFORE you build any geometry. ' +
            'This is the Morphology stage of the functional-design pipeline: call it AFTER research (you know the archetype and its proportions) and BEFORE building structure. ' +
            'You must decompose the artifact down to the ACTUATOR level: list every rigid LINK (body, thigh, shank, foot, ...) and every JOINT that connects two links. ' +
            'Every joint MUST declare: its type (revolute = a hinge/servo, prismatic = a linear slide, fixed = a rigid weld), its axis (a unit 3-vector in part-local mm, Z-up), its range as [minDeg, maxDeg] of travel, and the actuator that DRIVES it (a servo class like "MG90S" or a servo id) — except fixed joints, which are rigid and need no driver. ' +
            'Example decomposition: a quadruped = 1 body + 4 legs, each leg = 3 revolute joints (hip-abduct, hip-flex, knee) driven by 3 servos = 12 actuated joints / 12 DOF. ' +
            'The tool validates your joints, fills defaults, and DETERMINISTICALLY computes total DOF and the moving-joint count, then stores the morphology spec so the skeleton/structure/verification stages reuse it. Returns the normalized spec. It never modifies the document.',
        input_schema: {
            type: 'object',
            properties: {
                archetype: S('The mechanism archetype this artifact belongs to, e.g. "quadruped", "robot_arm", "gripper", "gimbal", "differential_drive", "gearbox". Drives proportions and pitfalls.'),
                links: {
                    type: 'array',
                    description: 'Every rigid link (segment) of the skeleton. A link is a part that moves as one body, e.g. "body", "front_left_thigh", "front_left_shank". Joints connect links.',
                    items: {
                        type: 'object',
                        properties: {
                            id: S('Stable id for the link, e.g. "body", "fl_thigh". Referenced by joints\' parentLink/childLink.'),
                            name: S('Human-readable name, e.g. "Front-left thigh".'),
                            role: S('What this link is FOR, e.g. "chassis", "thigh", "shank", "foot", "gripper_finger".'),
                        },
                        required: ['id'],
                    },
                },
                joints: {
                    type: 'array',
                    description: 'Every joint between two links — one record per actuated/articulating site. Decompose to the actuator level: one revolute joint per servo. A fixed joint is a rigid connection (no actuator).',
                    items: {
                        type: 'object',
                        properties: {
                            id: S('Stable id for the joint, e.g. "fl_hip_flex".'),
                            type: S('Joint type: "revolute" (hinge/servo, 1 DOF), "prismatic" (linear slide, 1 DOF), or "fixed" (rigid, 0 DOF).', { enum: JOINT_TYPES }),
                            axis: ARR('number', 'Joint axis as a 3-vector [x,y,z] in part-local mm, Z-up — the rotation axis for revolute, the slide direction for prismatic. Will be normalized. Ignored for fixed.'),
                            range: ARR('number', 'Travel limits as [minDeg, maxDeg] in DEGREES. Revolute: rotation sweep. Prismatic: treat as stroke. Fixed: ignored (0).'),
                            drivenBy: S('The actuator that drives this joint — a servo class (e.g. "SG90", "MG90S", "MG996R") or an actuator/component id. Required for revolute/prismatic; omit for fixed.'),
                            parentLink: S('Id of the link this joint mounts on (the proximal/base side).'),
                            childLink: S('Id of the link this joint moves (the distal side).'),
                        },
                        required: ['id', 'type'],
                    },
                },
                symmetry: S('The symmetry of the morphology, e.g. "bilateral", "radial-4", "none". Helps downstream mirror legs/arms.'),
                proportions: { type: 'object', additionalProperties: true, description: 'Key proportional ratios / dimensions (mm) driving the layout, e.g. { bodyLength: 200, legLength: 120, bodyToLegRatio: 1.6 }.' },
                notes: S('Design rationale, pitfalls to avoid (e.g. "thigh collides body at full hip flex"), or assumptions.'),
            },
            required: ['archetype', 'joints'],
        },
        handler: async (input) => {
            try {
                const i = input || {};
                const archetype = (typeof i.archetype === 'string' && i.archetype.trim()) ? i.archetype.trim() : '';
                if (!archetype) {
                    return { ok: false, error: 'plan_mechanism needs a non-empty archetype (e.g. "quadruped").' };
                }

                const rawJoints = Array.isArray(i.joints) ? i.joints : [];
                if (!rawJoints.length) {
                    return { ok: false, error: 'plan_mechanism needs at least one joint — decompose the artifact to its actuated joints (e.g. a quadruped has 12).' };
                }

                const joints = rawJoints.map(normJoint).filter(Boolean);
                if (!joints.length) {
                    return { ok: false, error: 'no valid joints found — each joint needs at least an id and a type.' };
                }

                const rawLinks = Array.isArray(i.links) ? i.links : [];
                const links = rawLinks.map(normLink).filter(Boolean);

                // Deterministic kinematics — the scaffold computes this, not the model.
                const dof = joints.reduce((sum, j) => sum + (JOINT_DOF[j.type] || 0), 0);
                const kinematicPoints = joints.filter((j) => j.type !== 'fixed').length;

                // Soft warnings the agent can act on without failing the call.
                const warnings = [];
                for (const j of joints) {
                    if (j.type !== 'fixed' && !j.drivenBy) {
                        warnings.push(`joint "${j.id}" (${j.type}) has no driving actuator — declare drivenBy.`);
                    }
                    if (!j.parentLink || !j.childLink) {
                        warnings.push(`joint "${j.id}" does not connect two links (parentLink/childLink missing).`);
                    }
                }

                const spec = {
                    archetype,
                    links,
                    joints,
                    symmetry: (typeof i.symmetry === 'string' && i.symmetry.trim()) ? i.symmetry.trim() : 'none',
                    dof,
                    kinematicPoints,
                    proportions: (i.proportions && typeof i.proportions === 'object') ? i.proportions : {},
                    notes: (typeof i.notes === 'string' && i.notes.trim()) ? i.notes.trim() : null,
                };

                getAIContext().setMorphology(spec);

                const summary = `Morphology: ${archetype} — ${links.length} link(s), ${joints.length} joint(s), ${kinematicPoints} actuated → ${dof} DOF`;
                return warnings.length
                    ? { ok: true, morphology: spec, summary, warnings }
                    : { ok: true, morphology: spec, summary };
            } catch (e) {
                return fail(e);
            }
        },
    },
];

export const MECHANISM_TOOLS = TOOLS;

export default MECHANISM_TOOLS;
