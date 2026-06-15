/**
 * Assembly tool layer — connector-driven mating tools for the AI agent.
 *
 *   ASSEMBLY_TOOLS — array of { name, description, input_schema, handler }
 *
 * This module is the studio's differentiator surface: it lets the model
 * declare snap points (connectors) on custom geometry, discover compatible
 * mating sites, and read the assembly back out (connector list + BOM).
 *
 * The CONNECTOR CONTRACT (see CLAUDE.md "The connector contract") governs
 * everything here. Two facts shape this file:
 *
 *   1. Connectors are CREATE-ONLY and IMMUTABLE. We wrap `addConnector` and
 *      force `locked: true` on everything we stamp. We deliberately do NOT
 *      import or expose `updateConnector` / `removeConnector` — an AI agent
 *      must never mutate or delete a committed connector. (The op layer would
 *      refuse a locked record without `{ force: true }` anyway; we don't even
 *      give the model the door.)
 *
 *   2. The nine authoring rules are enforced at THIS boundary. makeConnector
 *      silently coerces bad input to safe defaults (kind→'planar',
 *      gender→'neutral', etc.); that's wrong for an AI author, who would then
 *      quietly produce a clip-through neutral connector. So declareConnector
 *      validates BEFORE calling addConnector and rejects with a clear message.
 *
 * Every handler is defensive and NEVER throws — try/catch → { ok:false, error }.
 * Write ops return { ok:true, connectorId, summary }; reads return their payload.
 */

import { N, S, B, ARR, fail } from './tools_util.js';
import { getDocumentStore, addConnector, addBox } from '../../../lib/document/index.js';
import { connectorsCompatible } from '../library/mate_solver.js';
import { getAIContext } from './context.js';

// ── Closed sets mirrored from lib/document/types.js (makeConnector) ──────────
// We re-declare them here so we can REJECT (not silently coerce) bad input.
const CONNECTOR_KINDS   = new Set(['thread', 'bore', 'planar', 'shaft', 'tab', 'slot', 'rail']);
const CONNECTOR_GENDERS = new Set(['male', 'female', 'neutral']);
const INDUCED_JOINTS    = new Set(['fixed', 'revolute', 'prismatic']);

/** A finite [x,y,z] number triple, or null. */
function vec3(v) {
    if (!Array.isArray(v) || v.length !== 3) return null;
    const out = v.map(Number);
    return out.every((n) => Number.isFinite(n)) ? out : null;
}

/** Normalise a vec3; returns null on a zero / degenerate vector. */
function normalize3(v) {
    const len = Math.hypot(v[0], v[1], v[2]);
    if (!(len > 1e-9)) return null;
    return [v[0] / len, v[1] / len, v[2] / len];
}

/** A one-line, human-readable size string for summaries / hints. */
function sizeStr(size) {
    if (!size || size.nominal === undefined || size.nominal === null) return 'unspecified';
    return `${size.nominal}${size.unit ? ` ${size.unit}` : ''}`;
}

// ── Design-for-Serviceability classification ────────────────────────────────
//
// The studio's standard-part catalog ids (b123d_server/standard_parts/*.json)
// carry a stable prefix that tells us the part class. The JS document only
// stores `params.entryId`, so we key the heuristic on that string (plus the
// feature name as a fallback). Break-prone, powered, or wear parts (servos,
// motors, batteries, electronics boards, sensors, cameras) must stay
// REPLACEABLE — reachable + fastened, never glued or buried. Passive
// commodities (bearings, standoffs, fasteners) are part of the fasten plan but
// are not standalone serviceable line-items. Everything we MODEL ourselves
// (Box / Cylinder / Extrude / …) is custom structure that can be BAKED IN
// (integrated / permanent).

/** Custom modelled body feature types — fabricable structure, bake-in candidates. */
const STRUCTURAL_BODY_TYPES = new Set([
    'Box', 'Cylinder', 'Sphere', 'Torus',
    'Extrude', 'Revolve', 'Sweep', 'Loft', 'Helix',
    'BuildScript', 'ImportSTEP', 'ImportedMesh',
]);

/** entryId / name substrings that mark a break-prone, must-stay-accessible part. */
const REPLACEABLE_PATTERNS = [
    'servo', 'motor', 'actuator', 'stepper', 'dynamixel',
    'keepout', 'electronic', 'board', 'pcb', 'mcu', 'esp32', 'arduino',
    'nano', 'devkit', 'a4988', 'driver',
    'battery', 'lipo', 'cell', 'power',
    'sensor', 'imu', 'lidar', 'encoder', 'camera', 'lens',
    'controller', 'switch', 'relay',
];

/** Passive commodity parts — fastened/seated but not a serviceable line-item. */
const PASSIVE_PATTERNS = ['bearing', 'standoff', 'tnut', 't-nut', 'screw', 'bolt', 'nut', 'washer', 'iso', 'fastener'];

/** Classify a feature → 'replaceable' | 'passive' | 'structural' | 'other'. */
function classifyFeature(f) {
    if (!f) return 'other';
    const entryId = String((f.params && f.params.entryId) || '').toLowerCase();
    const name = String(f.name || '').toLowerCase();
    const hay = `${entryId} ${name}`;
    if (f.type === 'StandardPart') {
        if (REPLACEABLE_PATTERNS.some((p) => hay.includes(p))) return 'replaceable';
        if (PASSIVE_PATTERNS.some((p) => hay.includes(p))) return 'passive';
        // An unrecognised catalog part is treated as passive hardware by default.
        return 'passive';
    }
    if (STRUCTURAL_BODY_TYPES.has(f.type)) return 'structural';
    return 'other';
}

/** A short, human-readable label for a feature in plan summaries. */
function featLabel(f) {
    return (f && (f.name || (f.params && f.params.entryId) || f.type || f.id)) || 'part';
}

/** Compact connector view for read tools. */
function connectorView(c) {
    return {
        id:      c.id,
        kind:    c.kind,
        gender:  c.gender,
        size:    c.size,
        owner:   c.parent || null,   // owning feature / component id
        profile: c.profile || null,
        interfaceId: c.interfaceId || null,
        inducedJoint: c.inducedJoint || null,
        locked:  c.locked === true,
    };
}

// ── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS = [
    {
        name: 'declareConnector',
        description:
            'Declare a NEW snap point (connector) on a part you built from custom geometry, so other parts can mate to it. This is CREATE-ONLY: connectors are immutable once committed — there is no edit/remove for the agent. You MUST honour the connector contract or the call is rejected: ' +
            'origin is the exact CONTACT point (hole entry / face center / lip edge) in PART-LOCAL mm, Z-up — NOT the body center; ' +
            'axis points OUTWARD toward the mate (down a bolt shank away from the head, out of a tapped hole); ' +
            'gender must be stated explicitly (male mates female, neutral mates anything — do NOT use neutral as a lazy default or parts clip through each other); ' +
            'size must be { nominal, unit:"mm" } where nominal is a number or "unspecified"; ' +
            'inducedJoint declares the joint kind (bearing+shaft→revolute, slot+nut→prismatic, otherwise fixed).',
        input_schema: {
            type: 'object',
            properties: {
                featureId: S('Id of the part (feature) this connector belongs to. Required — a connector is anchored to exactly one part.'),
                kind: S('Mate-site family', { enum: ['thread', 'bore', 'planar', 'shaft', 'tab', 'slot', 'rail'] }),
                gender: S('Fit direction. male mates female; neutral mates anything. Declare it explicitly — never leave it to default.', { enum: ['male', 'female', 'neutral'] }),
                size: {
                    type: 'object',
                    description: 'Nominal size, e.g. { nominal: 5, unit: "mm" } for M5, or { nominal: "unspecified", unit: "mm" } when truly unknown.',
                    properties: {
                        nominal: { description: 'Numeric nominal (mm) or the string "unspecified".' },
                        unit: S('Unit — use "mm".'),
                    },
                    required: ['nominal'],
                },
                origin: ARR('number', 'Contact point [x,y,z] in PART-LOCAL mm, Z-up — where the two parts physically touch, NOT the body center.'),
                axis: ARR('number', 'Outward direction [x,y,z] toward the mate (will be normalised).'),
                normal: ARR('number', 'For line/slot/rail ports only: the seating-face outward normal [x,y,z], perpendicular to axis. axis is the slide direction.'),
                profile: S('Optional cross-section family id (e.g. "tslot-2020"). Overrides kind/interface for compatibility.'),
                interfaceId: S('Optional named-contract id (e.g. "servo-mount-9g"). Two connectors with the same interfaceId interchange.'),
                role: S('Optional stable role name (e.g. "mount-pattern") used when re-binding mates on part swap.'),
                inducedJoint: S('Joint kind this mate induces', { enum: ['fixed', 'revolute', 'prismatic'] }),
            },
            required: ['featureId', 'kind', 'gender', 'size', 'origin', 'axis', 'inducedJoint'],
        },
        handler: (i) => {
            try {
                const input = i || {};

                // Rule 1 — Anchored: belongs to exactly one part.
                if (!input.featureId || typeof input.featureId !== 'string') {
                    return { ok: false, error: 'featureId is required — a connector must be anchored to exactly one part.' };
                }

                // Rule 4 — kind is part of the explicit compatibility contract.
                if (!CONNECTOR_KINDS.has(input.kind)) {
                    return { ok: false, error: `kind must be one of ${[...CONNECTOR_KINDS].join(', ')} (got ${JSON.stringify(input.kind)}).` };
                }

                // Rule 5 — gender enforces fit direction. Never default to neutral.
                if (input.gender === undefined || input.gender === null) {
                    return { ok: false, error: 'gender is required — declare male, female, or neutral explicitly. Do NOT omit it (neutral-by-default makes parts clip through each other).' };
                }
                if (!CONNECTOR_GENDERS.has(input.gender)) {
                    return { ok: false, error: `gender must be one of ${[...CONNECTOR_GENDERS].join(', ')} (got ${JSON.stringify(input.gender)}).` };
                }

                // Rule 6 — size is declared or sentinel; never empty.
                const size = input.size;
                if (!size || typeof size !== 'object' || size.nominal === undefined || size.nominal === null) {
                    return { ok: false, error: 'size is required as { nominal, unit:"mm" } — nominal is a number (mm) or the string "unspecified". Never empty.' };
                }
                const nominalOk = Number.isFinite(Number(size.nominal)) || String(size.nominal).toLowerCase() === 'unspecified';
                if (!nominalOk) {
                    return { ok: false, error: `size.nominal must be a number (mm) or "unspecified" (got ${JSON.stringify(size.nominal)}).` };
                }
                const safeSize = {
                    nominal: Number.isFinite(Number(size.nominal)) ? Number(size.nominal) : 'unspecified',
                    unit: size.unit || 'mm',
                };

                // Rule 2 — Contact: origin is the touch point in part-local mm.
                const origin = vec3(input.origin);
                if (!origin) {
                    return { ok: false, error: 'origin must be an array of 3 finite numbers [x,y,z] in part-local mm.' };
                }

                // Rule 3 — Outward: axis points toward the mate. Normalise it.
                const rawAxis = vec3(input.axis);
                if (!rawAxis) {
                    return { ok: false, error: 'axis must be an array of 3 finite numbers [x,y,z].' };
                }
                const axis = normalize3(rawAxis);
                if (!axis) {
                    return { ok: false, error: 'axis is degenerate (zero length) — it must point outward toward the mate.' };
                }

                // Rule 8 — Joint declared.
                if (!INDUCED_JOINTS.has(input.inducedJoint)) {
                    return { ok: false, error: `inducedJoint must be one of ${[...INDUCED_JOINTS].join(', ')} (got ${JSON.stringify(input.inducedJoint)}).` };
                }

                // Rule 4 — Compatibility must be EXPLICIT. A 'neutral' gender with
                // an 'unspecified' size and no profile/interfaceId mates with
                // ANYTHING — exactly how parts clip through each other. Reject a
                // connector with no real discriminator so an AI author can't stamp
                // a promiscuous (immutable) snap point.
                const hasProfile   = typeof input.profile === 'string' && input.profile.length > 0;
                const hasInterface = typeof input.interfaceId === 'string' && input.interfaceId.length > 0;
                const sizeKnown    = Number.isFinite(Number(safeSize.nominal));
                if (input.gender === 'neutral' && !sizeKnown && !hasProfile && !hasInterface) {
                    return { ok: false, error: 'This connector is too permissive to mate safely: gender "neutral" + size "unspecified" with no profile or interfaceId matches anything and will let parts clip through (Rule 4 — compatibility must be explicit). Give it a real discriminator: a numeric size (mm), an explicit male/female gender, a profile (e.g. "tslot-2020"), or an interfaceId.' };
                }

                // Rule 9 — Channels: line/slot/rail ports need a perpendicular
                // seating normal. axis is the slide direction; normal is the
                // seating face outward. Optional but validated when present.
                const isChannel = input.kind === 'slot' || input.kind === 'rail';
                let normal = null;
                let topology = null;
                if (input.normal !== undefined && input.normal !== null) {
                    const rawNormal = vec3(input.normal);
                    if (!rawNormal) {
                        return { ok: false, error: 'normal must be an array of 3 finite numbers [x,y,z].' };
                    }
                    normal = normalize3(rawNormal);
                    if (!normal) {
                        return { ok: false, error: 'normal is degenerate (zero length).' };
                    }
                    // Perpendicularity check — axis ⟂ normal for a channel.
                    const dot = axis[0] * normal[0] + axis[1] * normal[1] + axis[2] * normal[2];
                    if (Math.abs(dot) > 0.087) {  // ~5° tolerance
                        return { ok: false, error: 'For a channel port, axis (slide direction) and normal (seating face outward) must be perpendicular — they are not interchangeable.' };
                    }
                    topology = 'line';   // a port carrying a normal is a line/channel port
                }
                if (isChannel && !normal) {
                    return { ok: false, error: `kind "${input.kind}" is a channel port — you must also supply a perpendicular "normal" (the seating-face outward direction). axis is the slide direction.` };
                }

                // Build the field object exactly as makeConnector/addConnector
                // expect. Note: the owner field is `parent` (a partId/componentId);
                // there is no `partFeatureId`/`owner` key on the record.
                const fields = {
                    parent: input.featureId,
                    kind: input.kind,
                    gender: input.gender,
                    size: safeSize,
                    origin,
                    axis,
                    inducedJoint: input.inducedJoint,
                    // Rule 4 precedence helpers — kept only when supplied.
                    role: (typeof input.role === 'string' && input.role.length) ? input.role : null,
                    interfaceId: (typeof input.interfaceId === 'string' && input.interfaceId.length) ? input.interfaceId : null,
                    profile: (typeof input.profile === 'string' && input.profile.length) ? input.profile : null,
                    // Rule 9 channel fields.
                    normal,
                    topology,
                    // Immutability — every AI-authored connector is locked.
                    locked: true,
                };

                const created = addConnector(fields);
                if (!created || !created.id) {
                    return { ok: false, error: 'addConnector did not return a connector record.' };
                }

                // Best-effort advisory: we cannot fully verify the contact rule
                // (we lack the part body here), so flag an origin that looks like
                // it might be a body center (all-zero) for the author to confirm.
                const warning = (origin[0] === 0 && origin[1] === 0 && origin[2] === 0)
                    ? 'origin is [0,0,0] — confirm this is the actual contact point and not the body center (Rule 2).'
                    : undefined;

                return {
                    ok: true,
                    connectorId: created.id,
                    summary: `Declared ${input.kind}/${input.gender} connector (${sizeStr(safeSize)}) on ${input.featureId} — ${input.inducedJoint} joint, locked`,
                    ...(warning ? { warning } : {}),
                };
            } catch (e) {
                return fail(e);
            }
        },
    },

    {
        name: 'find_compatible_connectors',
        description:
            'Find connectors that can mate with a given host connector, so you can plan a mate BEFORE placing a part. Tests the host against every other connector in the document (or against a supplied candidate list) using the same compatibility logic the mate solver uses (profile → interfaceId → kind/gender/size). Returns the compatible partners with the reason they matched.',
        input_schema: {
            type: 'object',
            properties: {
                hostConnectorId: S('Id of the host connector to find partners for (from list_connectors).'),
                partConnectorIds: ARR('string', 'Optional candidate connector ids to test against. If omitted, every other connector in the document is tested.'),
            },
            required: ['hostConnectorId'],
        },
        handler: (i) => {
            try {
                const input = i || {};
                const doc = getDocumentStore().doc;
                const connectors = (doc && doc.connectors) || {};

                const host = connectors[input.hostConnectorId];
                if (!host) {
                    return { ok: false, error: `host connector ${JSON.stringify(input.hostConnectorId)} not found in the document.` };
                }

                // Resolve the candidate set.
                let candidateIds;
                if (Array.isArray(input.partConnectorIds) && input.partConnectorIds.length) {
                    candidateIds = input.partConnectorIds;
                } else {
                    candidateIds = Object.keys(connectors).filter((id) => id !== host.id);
                }

                const compatible = [];
                for (const id of candidateIds) {
                    const cand = connectors[id];
                    if (!cand || cand.id === host.id) continue;
                    let ok = false;
                    try { ok = connectorsCompatible(host, cand) === true; } catch (_) { ok = false; }
                    if (!ok) continue;
                    // A short "why" hint, mirroring the solver's precedence.
                    let why;
                    if (host.profile && cand.profile && host.profile === cand.profile) {
                        why = `profile ${host.profile}`;
                    } else if (host.interfaceId && cand.interfaceId && host.interfaceId === cand.interfaceId) {
                        why = `interfaceId ${host.interfaceId}`;
                    } else {
                        why = `${cand.kind}/${cand.gender} (${sizeStr(cand.size)})`;
                    }
                    compatible.push({
                        id: cand.id,
                        kind: cand.kind,
                        gender: cand.gender,
                        size: cand.size,
                        why,
                    });
                }

                return { ok: true, compatible, count: compatible.length };
            } catch (e) {
                return fail(e);
            }
        },
    },

    {
        name: 'list_connectors',
        description:
            'List the snap points (connectors) that exist in the document so you can see what is matable and pick host/part connector ids for a mate. Read-only. Optionally scope to one component.',
        input_schema: {
            type: 'object',
            properties: {
                componentId: S('Optional: only list connectors owned by this component/feature id.'),
            },
        },
        handler: (i) => {
            try {
                const input = i || {};
                const doc = getDocumentStore().doc;
                const connectors = (doc && doc.connectors) || {};
                let rows = Object.values(connectors).filter(Boolean).map(connectorView);
                if (input.componentId) {
                    rows = rows.filter((r) => r.owner === input.componentId);
                }
                return { ok: true, connectors: rows, count: rows.length };
            } catch (e) {
                return fail(e);
            }
        },
    },

    {
        name: 'generate_bom',
        description:
            'Generate a bill of materials for the assembly. Walks the document\'s features and splits them into ORDERABLE parts (placed library / standard catalog parts, grouped by catalog id with a quantity) and FABRICATE parts (custom bodies you modelled from primitives / sketches that must be made). Use this to summarise what the user needs to buy vs build. Optionally scope to one component subtree.',
        input_schema: {
            type: 'object',
            properties: {
                componentId: S('Optional: only include features owned by this component id.'),
            },
        },
        handler: (i) => {
            try {
                const input = i || {};
                const doc = getDocumentStore().doc;
                const features = (doc && doc.features) || {};

                // Feature types that produce a standalone fabricable body. We
                // count the "create" primitives/profiles; modify/pattern features
                // (Fillet, Hole, LinearPattern, …) operate on an existing body
                // and are NOT separate BOM lines.
                const FABRICATE_TYPES = new Set([
                    'Box', 'Cylinder', 'Sphere', 'Torus',
                    'Extrude', 'Revolve', 'Sweep', 'Loft', 'Helix',
                    'ImportSTEP', 'ImportedMesh',
                ]);

                let note;
                // Orderable parts: StandardPart features carry the catalog id in
                // params.entryId (set by addStandardPart). Group by that id.
                const orderableByKey = new Map();
                const fabricate = [];

                for (const f of Object.values(features)) {
                    if (!f || f.enabled === false) continue;
                    if (input.componentId && f.componentId !== input.componentId) continue;

                    if (f.type === 'StandardPart') {
                        // Orderable — group by catalog entry id.
                        const entryId = (f.params && f.params.entryId) || null;
                        const key = entryId || f.name || f.id;
                        const existing = orderableByKey.get(key);
                        if (existing) {
                            existing.qty += 1;
                        } else {
                            orderableByKey.set(key, {
                                id: entryId || f.id,
                                name: f.name || entryId || f.type,
                                qty: 1,
                                source: 'orderable',
                            });
                        }
                        if (!entryId) {
                            note = 'Some standard parts lacked a catalog entryId; grouped them by name/id as a best-effort fallback.';
                        }
                    } else if (FABRICATE_TYPES.has(f.type)) {
                        // Fabricate — each modelled body is its own line (qty 1).
                        fabricate.push({
                            id: f.id,
                            name: f.name || f.type,
                            qty: 1,
                            source: 'fabricate',
                        });
                    }
                    // All other feature types (modify/pattern/sketch) are not
                    // standalone BOM lines.
                }

                const orderable = [...orderableByKey.values()];
                const lines = [...orderable, ...fabricate];

                return {
                    ok: true,
                    lines,
                    orderableCount: orderable.length,
                    fabricateCount: fabricate.length,
                    ...(note ? { note } : {}),
                };
            } catch (e) {
                return fail(e);
            }
        },
    },

    // ── S4 — Design-for-Assembly / Serviceability sort ───────────────────────
    {
        name: 'plan_serviceability',
        description:
            'Design-for-Assembly / Serviceability planning (pipeline stage S4). Sorts the assembly into break-prone parts that must stay REPLACEABLE (servos, motors, batteries, electronics boards, sensors, cameras — fastened, never glued, with a clear removal path) versus structural bodies that can be BAKED IN (integrated / permanent). Produces an acyclic assembly order (structure first, then powered/electronic parts last so they stay on top and reachable) and a per-part fasten plan with an access note. Read-mostly: it reasons over the document (or a supplied component list) and records the plan to the design context — it does not modify geometry. Run it after the skeleton is laid out (S3) and before building detailed structure (S5).',
        input_schema: {
            type: 'object',
            properties: {
                componentIds: ARR('string', 'Optional: scope the sort to features owned by these component ids. If omitted, the whole document is sorted.'),
            },
        },
        handler: (i) => {
            try {
                const input = i || {};
                const doc = getDocumentStore().doc;
                const features = (doc && doc.features) || {};
                const order = (doc && doc.featureOrder) || Object.keys(features);
                const scope = (Array.isArray(input.componentIds) && input.componentIds.length)
                    ? new Set(input.componentIds)
                    : null;

                const inScope = (f) => {
                    if (!f || f.enabled === false) return false;
                    if (!scope) return true;
                    return scope.has(f.componentId || 'root');
                };

                const replaceable = [];   // break-prone componentIds (feature ids)
                const bakedIn = [];       // structural bodies that can be integrated
                const passive = [];       // fasteners/bearings/standoffs (hardware)
                const fastenPlan = [];

                // Walk in build order so the plan is deterministic & stable.
                for (const id of order) {
                    const f = features[id];
                    if (!inScope(f)) continue;
                    const klass = classifyFeature(f);
                    const label = featLabel(f);

                    if (klass === 'replaceable') {
                        replaceable.push(f.id);
                        fastenPlan.push({
                            part: f.id,
                            fasteners: 'screws (M2/M2.5/M3) — bolted to a mount face',
                            accessNote: `${label}: keep the removal path clear — mount on an outer/top face so it can be unbolted and swapped without disassembling structure.`,
                        });
                    } else if (klass === 'passive') {
                        passive.push(f.id);
                        fastenPlan.push({
                            part: f.id,
                            fasteners: 'press-fit / seated hardware',
                            accessNote: `${label}: seated commodity hardware — fits during sub-assembly, no standalone service access required.`,
                        });
                    } else if (klass === 'structural') {
                        bakedIn.push(f.id);
                    }
                    // 'other' (modify/pattern/sketch features) carry no own line.
                }

                // Acyclic assembly order: structural shells/brackets go down first,
                // then passive seated hardware, then the break-prone powered parts
                // last so they end up on top and remain reachable for service.
                const assemblyOrder = [...bakedIn, ...passive, ...replaceable];

                const spec = { replaceable, bakedIn, assemblyOrder, fastenPlan };

                // Persist to the design context (DSO `assembly` slot). The method
                // is provided centrally; tolerate its absence in headless/tests.
                let persisted = false;
                try {
                    const ctx = getAIContext();
                    if (ctx && typeof ctx.setAssemblyPlan === 'function') {
                        ctx.setAssemblyPlan(spec);
                        persisted = true;
                    }
                } catch (_) { /* never blocks the plan */ }

                return {
                    ok: true,
                    ...spec,
                    passive,
                    persisted,
                    summary: `Serviceability sort: ${replaceable.length} replaceable (break-prone, fastened, accessible), ${bakedIn.length} baked-in structural, ${passive.length} seated hardware; assembly order has ${assemblyOrder.length} steps.`,
                };
            } catch (e) {
                return fail(e);
            }
        },
    },

    // ── S3 — Skeleton massing envelope ───────────────────────────────────────
    {
        name: 'plan_skeleton_envelope',
        description:
            'Lay out the SKELETON massing envelope (pipeline stage S3): the compound shape that defines WHERE the functional parts — electronics, camera, servos, battery — sit, BEFORE any detailed structure is built. Advisory and read-mostly: it records the envelope and per-host placement (frame + keep-out) to the design context (DSO `skeleton` slot), and can optionally drop a rough translucent box feature so the layout is visible in the viewport. This locks down massing/host frames so downstream structural parts (S5) can be authored as functions of the components they carry. Z-up, all dimensions in mm.',
        input_schema: {
            type: 'object',
            properties: {
                envelope: {
                    type: 'object',
                    description: 'Rough overall bounding box of the machine body in world mm, Z-up: { min:[x,y,z], max:[x,y,z] }.',
                    properties: {
                        min: ARR('number', 'Envelope minimum corner [x,y,z] mm.'),
                        max: ARR('number', 'Envelope maximum corner [x,y,z] mm.'),
                    },
                    required: ['min', 'max'],
                },
                hosts: {
                    type: 'array',
                    description: 'The functional components to host inside the envelope and where each sits.',
                    items: {
                        type: 'object',
                        properties: {
                            componentId: S('Id of the functional component/part this host slot is for (or a role placeholder if not yet placed).'),
                            role: S('Functional role', { enum: ['actuator', 'controller', 'battery', 'sensor', 'camera', 'other'] }),
                            frame: ARR('number', 'Seat position [x,y,z] in world mm, Z-up — where the part is centred / mounted.'),
                            keepout: ARR('number', 'Reserved clearance box [dx,dy,dz] in mm around the frame the structure must not intrude on.'),
                        },
                        required: ['componentId', 'role', 'frame'],
                    },
                },
                visualize: B('If true, drop a rough box feature spanning the envelope so the massing is visible in the viewport (advisory geometry). Default false.'),
            },
            required: ['envelope', 'hosts'],
        },
        handler: (i) => {
            try {
                const input = i || {};

                const min = vec3(input.envelope && input.envelope.min);
                const max = vec3(input.envelope && input.envelope.max);
                if (!min || !max) {
                    return { ok: false, error: 'envelope must be { min:[x,y,z], max:[x,y,z] } with finite numbers (world mm, Z-up).' };
                }
                // Normalise so max >= min on every axis.
                const lo = [Math.min(min[0], max[0]), Math.min(min[1], max[1]), Math.min(min[2], max[2])];
                const hi = [Math.max(min[0], max[0]), Math.max(min[1], max[1]), Math.max(min[2], max[2])];
                const size = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
                if (!(size[0] > 0 && size[1] > 0 && size[2] > 0)) {
                    return { ok: false, error: 'envelope is degenerate — min and max must differ on every axis (non-zero size in mm).' };
                }

                // Validate / normalise the host list.
                const rawHosts = Array.isArray(input.hosts) ? input.hosts : [];
                if (!rawHosts.length) {
                    return { ok: false, error: 'hosts must be a non-empty array of { componentId, role, frame } — these are the functional parts the skeleton positions.' };
                }
                const hosts = [];
                for (const h of rawHosts) {
                    if (!h || typeof h.componentId !== 'string' || !h.componentId.length) {
                        return { ok: false, error: 'every host needs a string componentId.' };
                    }
                    const frame = vec3(h.frame);
                    if (!frame) {
                        return { ok: false, error: `host ${JSON.stringify(h.componentId)} needs a frame [x,y,z] in world mm (the seat position).` };
                    }
                    const keepout = vec3(h.keepout);   // optional; null if absent/degenerate
                    hosts.push({
                        componentId: h.componentId,
                        role: typeof h.role === 'string' ? h.role : 'other',
                        frame,
                        keepout: keepout ? keepout.map(Math.abs) : null,
                    });
                }

                const spec = { envelope: { min: lo, max: hi }, hosts };

                // Optionally visualise the massing as a rough box. addBox sits on
                // Z=0 (Align.MIN, centred in XY), so a box at the origin won't sit
                // where the envelope is — we report the offset to apply so the
                // advisory box reads as the envelope footprint, and flag it.
                let envelopeFeatureId = null;
                let visualizeNote;
                if (input.visualize === true) {
                    try {
                        const f = addBox({ length: size[0], width: size[1], height: size[2], centered: true });
                        if (f && f.id) {
                            envelopeFeatureId = f.id;
                            spec.envelopeFeatureId = f.id;
                            visualizeNote = `Advisory massing box created (${envelopeFeatureId}) sized ${size[0]}×${size[1]}×${size[2]}mm. It sits centred-in-XY on Z=0; move it to envelope center [${((lo[0] + hi[0]) / 2)}, ${((lo[1] + hi[1]) / 2)}, ${lo[2]}] if the envelope is offset from the origin.`;
                        }
                    } catch (_) { /* visualization is best-effort; never blocks the plan */ }
                }

                // Coverage advisory: warn about host frames outside the envelope.
                const outside = hosts.filter((h) => (
                    h.frame[0] < lo[0] || h.frame[0] > hi[0] ||
                    h.frame[1] < lo[1] || h.frame[1] > hi[1] ||
                    h.frame[2] < lo[2] || h.frame[2] > hi[2]
                )).map((h) => h.componentId);

                // Persist to the design context (DSO `skeleton` slot).
                let persisted = false;
                try {
                    const ctx = getAIContext();
                    if (ctx && typeof ctx.setSkeleton === 'function') {
                        ctx.setSkeleton(spec);
                        persisted = true;
                    }
                } catch (_) { /* never blocks the plan */ }

                return {
                    ok: true,
                    ...spec,
                    persisted,
                    ...(envelopeFeatureId ? { envelopeFeatureId } : {}),
                    ...(outside.length ? { warning: `host frame(s) outside the envelope: ${outside.join(', ')} — re-check their placement or grow the envelope.` } : {}),
                    ...(visualizeNote ? { note: visualizeNote } : {}),
                    summary: `Skeleton envelope ${size[0]}×${size[1]}×${size[2]}mm hosting ${hosts.length} functional part(s)${envelopeFeatureId ? ' + advisory massing box' : ''}.`,
                };
            } catch (e) {
                return fail(e);
            }
        },
    },
];

export const ASSEMBLY_TOOLS = TOOLS;
