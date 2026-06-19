/**
 * Spec 18 v1 — placeLibraryPart operation.
 *
 * High-level op that:
 *   1. Resolves the PartRecord from the library.
 *   2. Resolves the host connector's world transform via the topology
 *      index (when a host connectorRef is supplied).
 *   3. Computes the SE(3) mate transform via mate_solver.
 *   4. Creates a new Component for the part instance (with the solved
 *      origin).
 *   5. Commits Connector records on the new component (one per
 *      PartRecord.connectors entry, re-parented to the component id).
 *   6. If the mate pair has an induced joint, creates a Joint between
 *      the host component and the new component.
 *   7. Recursively expands composite parts — each member becomes its
 *      own component under the parent composite component.
 *
 * The op is pure-call: it stages changes via the existing operations
 * layer (addComponent / addConnector / addJoint), so it inherits the
 * changelog / undo / redo plumbing for free.
 *
 *   placeLibraryPart({ partId, mate, parentComponentId? })
 *
 * `mate.hostConnectorRef` is one of:
 *   - { connectorId: '...' }    — existing connector on the host doc
 *   - { world: { kind, axis, origin } } — free placement (no joint)
 *
 * `mate.partConnectorId` picks which connector on the part lines up
 * with the host. If omitted, the first compatible connector is used.
 */

import {
    getDocumentStore,
    addComponent,
    addJoint,
    addMate,
    addStandardPart,
    addBox,
    makeConnector,
    setComponentOrigin,
} from '../../../lib/document/index.js';
import { addConnectorChange } from '../../../lib/document/changelog.js';
import { getPartById } from './index.js';
import {
    solveMateTransform, inducedJointFromMate, connectorsCompatible, worldConnectorFor,
} from './mate_solver.js';

/**
 * @param {{
 *   partId: string,
 *   mate?: {
 *     hostConnectorRef?: { connectorId?: string, world?: object },
 *     partConnectorId?: string,
 *   },
 *   parentComponentId?: string,
 *   name?: string,
 * }} args
 * @returns {{ ok: boolean, componentId?: string, jointId?: string, mateId?: string, members?: string[], error?: string }}
 */
export function placeLibraryPart(args) {
    const { partId, mate = {}, parentComponentId = 'root', name } = args || {};
    if (!partId) return { ok: false, error: 'partId required' };

    const part = getPartById(partId);
    if (!part) return { ok: false, error: `unknown part ${partId}` };

    const store = getDocumentStore();
    const doc = store.doc;

    // ── 1. Resolve host connector to a world frame ──
    let hostConnectorWorld = null;
    let hostConnectorId = null;
    if (mate.hostConnectorRef) {
        if (mate.hostConnectorRef.connectorId) {
            hostConnectorId = mate.hostConnectorRef.connectorId;
            const hc = doc.connectors && doc.connectors[hostConnectorId];
            if (hc) {
                // Resolve through the host component's world transform.
                // Connector frames are stored component-local; using the raw
                // stored frame placed parts offset by exactly the host's own
                // placement once the host had been moved — the "snaps but
                // lands away from the rail" bug. worldConnectorFor also
                // carries the port-model v2 fields (topology / normal /
                // extent / profile / fit / seatDepth) into the world frame,
                // matching what the drop-ghost preview solves against.
                hostConnectorWorld = worldConnectorFor(doc, hc);
            }
        } else if (mate.hostConnectorRef.world) {
            hostConnectorWorld = mate.hostConnectorRef.world;
        }
    }
    // Free placement default — identity at origin.
    if (!hostConnectorWorld) {
        hostConnectorWorld = { kind: 'planar', axis: [0, 0, 1], origin: [0, 0, 0] };
    }

    // ── 2. Pick part connector ──
    let partConnector = null;
    if (mate.partConnectorId) {
        partConnector = (part.connectors || []).find((c) => c.id === mate.partConnectorId) || null;
    }
    if (!partConnector) {
        // Prefer the first compatible connector for the host.
        for (const c of part.connectors || []) {
            if (connectorsCompatible(hostConnectorWorld, c)) { partConnector = c; break; }
        }
    }
    if (!partConnector && (part.connectors || []).length > 0) {
        partConnector = part.connectors[0];
    }

    // ── 3. Solve mate transform ──
    // `mate.slide` (mm along a channel run) and `mate.roll` (radians about the
    // mate axis / face normal) come from the drop UX so the part lands where
    // the ghost previewed it — not at the channel midpoint in default spin.
    const slide = Number.isFinite(mate.slide) ? mate.slide : undefined;
    const roll  = Number.isFinite(mate.roll)  ? mate.roll  : undefined;
    let solved;
    if (partConnector) {
        solved = solveMateTransform(hostConnectorWorld, partConnector, { slide, roll });
    } else {
        // No connectors at all — drop at host origin without rotation.
        solved = { matrix: null, euler: [0, 0, 0], position: hostConnectorWorld.origin.slice() };
    }

    // ── 4. Create the component ──
    const comp = addComponent({
        name: name || part.name,
        parentId: parentComponentId,
        origin: {
            position: solved.position.slice(),
            rotation: solved.euler.slice(),
            scale: [1, 1, 1],
        },
    });

    // ── 4b. Emit the body. ──
    //   * standard-part  → addStandardPart, kernel resolves & builds the body
    //                      via standard_parts.build_from_id(<id>). The kernel
    //                      id is `kernelEntryId` when present, else the
    //                      `build.catalogId` (every standard-part declares one —
    //                      e.g. hex nuts have catalogId 'iso4032-m4' but no
    //                      kernelEntryId; without this fallback they emit NO
    //                      geometry, so the dropped nut is invisible and the
    //                      move gizmo has nothing to attach to).
    //   * parametric     → Box placeholder sized to boundingBox.
    //   * otherwise      → no feature (composite handled by step 7).
    //
    // Component origin AND feature transform both carry the solved placement
    // for now: doc render is feature-driven (component origin not yet
    // composed into world transforms), but the component widget reads
    // origin to label the placement. Both pointing at solved.position keeps
    // them coherent; one of them will become redundant when component-aware
    // rendering lands.
    const kernelId = part.kernelEntryId
        || (part.build && part.build.type === 'standard-part' ? part.build.catalogId : null)
        || (part.source === 'standard-part' && part.build ? part.build.catalogId : null);
    if (kernelId) {
        try {
            addStandardPart(kernelId, {
                componentId: comp.id,
                transform: {
                    position: solved.position.slice(),
                    rotation: solved.euler.slice(),
                },
                name: part.name,
            });
        } catch (err) {
            // Don't fail the whole placement — log so the user can see the
            // component appeared without geometry and report it.
            // eslint-disable-next-line no-console
            console.error('[placeLibraryPart] addStandardPart failed', err);
        }
    } else if (part.source === 'parametric' && part.boundingBox) {
        // Spec 18 v2 — parametric placeholder fallback. Until full Python-
        // snippet ingestion lands, emit a Box sized to the part's
        // `boundingBox`. This unblocks every parametric placeholder (t-nut,
        // hinge, knob, …) so the user can place + drag-snap them; the
        // visible body is just a stand-in until the kernel wires the real
        // snippet. Box uses ALIGN_BOTTOM (XY-centred, Z=MIN) which matches
        // the convention of every authored bbox in parts/.
        try {
            const bb = part.boundingBox;
            const length = Math.max(0.1, (bb.max?.[0] ?? 5) - (bb.min?.[0] ?? -5));
            const width  = Math.max(0.1, (bb.max?.[1] ?? 5) - (bb.min?.[1] ?? -5));
            const height = Math.max(0.1, (bb.max?.[2] ?? 5) - (bb.min?.[2] ?? 0));
            addBox({ length, width, height, centered: true, componentId: comp.id });
        } catch (err) {
            console.error('[placeLibraryPart] parametric Box fallback failed', err);
        }
    }

    // ── 5. Stamp connectors onto the new component ──
    // Track the stamped connector id that corresponds to the chosen part
    // connector so the persistent Mate (step 6b) can reference it.
    let stampedPartConnectorId = null;
    for (const c of part.connectors || []) {
        const stamped = makeConnector({
            parent: comp.id,
            kind: c.kind, gender: c.gender, size: c.size,
            axis: c.axis, origin: c.origin,
            mates_with: c.mates_with, inducedJoint: c.inducedJoint,
            role: c.role ?? null, interfaceId: c.interfaceId ?? null,
            // Port-model v2 — preserve richer-mating fields on the placed copy.
            topology: c.topology ?? null, normal: c.normal ?? null,
            extent: c.extent ?? null, profile: c.profile ?? null, fit: c.fit ?? null,
            // Library connectors are part of the part's contract — immutable
            // once stamped. See CLAUDE.md "The connector contract".
            locked: true,
            metadata: { ...(c.metadata || {}), sourcePartId: part.id, sourceConnectorId: c.id },
        });
        if (partConnector && c.id === partConnector.id) {
            stampedPartConnectorId = stamped.id;
        }
        store.commit(_addConnectorChangeOrFallback(stamped));
    }

    // ── 6. Induced joint? ──
    let jointId = null;
    let jointKindUsed = null;
    if (hostConnectorId && partConnector && partConnector.inducedJoint !== null) {
        const hc = doc.connectors[hostConnectorId];
        const joinKind = inducedJointFromMate(hc, partConnector);
        if (joinKind) {
            const j = addJoint({
                kind: joinKind,
                parent: hc.parent || parentComponentId,
                child:  comp.id,
                origin: hostConnectorWorld.origin.slice(),
                axis:   hostConnectorWorld.axis.slice(),
            });
            jointId = j.id;
            jointKindUsed = joinKind;
        }
    }

    // ── 6b. Record a persistent Mate (Phase 2 — the source of truth for
    //         re-solving on swap). Only meaningful when the placement is
    //         driven by an actual mate (a host connector + a part connector);
    //         pure free-form drops without a part connector are skipped.
    let mateId = null;
    if (partConnector && (hostConnectorId || (mate.hostConnectorRef && mate.hostConnectorRef.world))) {
        const m = addMate({
            hostConnectorRef: hostConnectorId
                ? { connectorId: hostConnectorId, world: null }
                : { connectorId: null, world: { ...hostConnectorWorld } },
            partConnectorRef: {
                connectorId: stampedPartConnectorId,
                sourceConnectorId: partConnector.id,
            },
            componentId: comp.id,
            // Persist the drop-time slide/roll so a later re-solve (swap,
            // rotate-to-fit) keeps the part where the user placed it.
            offset: (slide !== undefined || roll !== undefined)
                ? {
                    ...(slide !== undefined ? { slide } : {}),
                    ...(roll  !== undefined ? { roll }  : {}),
                }
                : null,
            inducedJoint: { id: jointId, kind: jointKindUsed },
        });
        mateId = m.id;
    }

    // ── 7. Composite recursion ──
    const memberIds = [];
    if (part.source === 'composite' && Array.isArray(part.members)) {
        for (const m of part.members) {
            const child = placeLibraryPart({
                partId: m.partRecordId,
                parentComponentId: comp.id,
                mate: {
                    hostConnectorRef: { world: {
                        kind: 'planar',
                        axis: [0, 0, 1],
                        origin: (m.transform && m.transform.position) || [0, 0, 0],
                    } },
                },
                name: undefined,
            });
            if (child.ok) {
                memberIds.push(child.componentId);
                // Apply the member's local transform onto the child component.
                if (m.transform) {
                    const c = doc.components[child.componentId];
                    if (c) {
                        c.origin = {
                            position: (m.transform.position || [0, 0, 0]).slice(),
                            rotation: (m.transform.rotation || [0, 0, 0]).slice(),
                            scale:    (m.transform.scale    || [1, 1, 1]).slice(),
                        };
                    }
                }
            }
        }
    }

    return {
        ok: true,
        componentId: comp.id,
        jointId,
        mateId,
        members: memberIds,
    };
}

// Local helper — go through the changelog builder directly because the
// addConnector op auto-generates a fresh id, and here we want to preserve
// the makeConnector-stamped id (so callers can reference it).
function _addConnectorChangeOrFallback(connector) {
    return addConnectorChange(connector);
}

/**
 * Mate two ALREADY-PLACED connectors and SOLVE the placement: the part
 * connector's owning component is physically moved so the two connectors meet.
 *
 * This is the missing seam for parts that aren't library placements — two
 * generated/custom parts (e.g. a battery holder seating into a Pi case cavity
 * floor). `placeLibraryPart` positions a part at creation; `add_mate` only
 * RECORDS a constraint and moves nothing. `mateConnectors` does what neither
 * does for existing parts: resolve → solve → reposition → persist.
 *
 * The HOST stays put; the PART connector's component (`partC.parent`) is the one
 * repositioned via `setComponentOrigin`, which both moves the rendered body
 * (emit.js `composeComponentTransform`) and the part's connector world frames
 * (mate_solver `componentWorldMatrix`) — they stay in agreement. A persistent
 * Mate is recorded so a later swap / cascade re-solves against it.
 *
 * @param {string} hostConnectorId  connector that stays put (the seat)
 * @param {string} partConnectorId  connector whose component moves to meet it
 * @param {{ slide?: number, roll?: number }} [opts]
 * @returns {{ ok: boolean, componentId?: string, mateId?: string, jointId?: string, position?: number[], error?: string }}
 */
export function mateConnectors(hostConnectorId, partConnectorId, opts = {}) {
    const store = getDocumentStore();
    const doc = store.doc;
    const hostC = doc.connectors && doc.connectors[hostConnectorId];
    const partC = doc.connectors && doc.connectors[partConnectorId];
    if (!hostC) return { ok: false, error: `unknown host connector ${hostConnectorId}` };
    if (!partC) return { ok: false, error: `unknown part connector ${partConnectorId}` };

    // Compatibility on the RAW records (they carry interfaceId / gender / size);
    // the world frame drops those, so checking against it would silently fall
    // back to kind-only matching.
    if (!connectorsCompatible(hostC, partC)) {
        return { ok: false, error: `connectors are not compatible — interface/kind/gender/size mismatch (host ${hostC.interfaceId || hostC.kind} ⟂ part ${partC.interfaceId || partC.kind})` };
    }

    // The part must be a movable unit. Generator parts get their own component;
    // a connector anchored to a raw feature or 'root' can't be repositioned.
    const partComponentId = partC.parent;
    if (!partComponentId || !(doc.components && doc.components[partComponentId])) {
        return { ok: false, error: `part connector ${partConnectorId} must be anchored to a movable component to be mated (its parent is "${partComponentId}")` };
    }

    const hostWorld = worldConnectorFor(doc, hostC);
    const slide = Number.isFinite(opts.slide) ? opts.slide : undefined;
    const roll  = Number.isFinite(opts.roll)  ? opts.roll  : undefined;
    const solved = solveMateTransform(hostWorld, partC, { slide, roll });

    setComponentOrigin(partComponentId, {
        position: solved.position.slice(),
        rotation: solved.euler.slice(),
        scale: [1, 1, 1],
    });

    // Induced joint (bearing+shaft→revolute, slot+nut→prismatic, else fixed).
    let jointId = null;
    let jointKind = null;
    const jk = inducedJointFromMate(hostC, partC);
    if (jk) {
        const j = addJoint({
            kind: jk,
            parent: hostC.parent || 'root',
            child:  partComponentId,
            origin: hostWorld.origin.slice(),
            axis:   hostWorld.axis.slice(),
        });
        jointId = j.id;
        jointKind = jk;
    }

    const m = addMate({
        hostConnectorRef: { connectorId: hostConnectorId, world: null },
        partConnectorRef: { connectorId: partConnectorId },
        componentId: partComponentId,
        offset: (slide !== undefined || roll !== undefined)
            ? { ...(slide !== undefined ? { slide } : {}), ...(roll !== undefined ? { roll } : {}) }
            : null,
        inducedJoint: { id: jointId, kind: jointKind },
    });

    return { ok: true, componentId: partComponentId, mateId: m.id, jointId, position: solved.position.slice() };
}
