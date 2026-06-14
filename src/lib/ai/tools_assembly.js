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
import { getDocumentStore, addConnector } from '../../../lib/document/index.js';
import { connectorsCompatible } from '../library/mate_solver.js';

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
];

export const ASSEMBLY_TOOLS = TOOLS;
