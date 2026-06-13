/**
 * Rotate-to-fit — pure placement-orientation math for the viewport's keyboard
 * rotation (the "[" / "]" rotate-to-fit gesture).
 *
 * Given a placed component, compute the new component origin after adding a
 * roll increment, so the user can spin a part into the orientation they want
 * without breaking its mate. Two regimes:
 *
 *   1. **Mated** (regular single-axis mate, host resolvable) — re-solve the
 *      mate with an accumulated roll about the mate axis. The part stays
 *      seated on the host connector; only its spin about that axis changes.
 *      The roll is persisted on the Mate (`offset.roll`) so it survives a
 *      swap / re-solve.
 *
 *   2. **Free / slot** (no mate, or a slot/line channel where the slide DOF —
 *      not a roll — is the fitting control) — spin the component in place
 *      about the host axis (or world +Z) by the increment, mutating only the
 *      origin rotation.
 *
 * Pure: takes a doc + ids, returns a patch object. The viewport applies it via
 * the existing commitMove path (updateStandardPart + setComponentOrigin) and
 * persists `roll` on the mate when present. No three.js, no store access — so
 * the headless tests can assert the math directly.
 */

import {
    solveMateTransform, worldConnectorFor, eulerAfterRoll,
} from './mate_solver.js';

/**
 * @param {object} doc          — DocumentStore.doc
 * @param {string} componentId
 * @param {number} deltaRad     — roll increment (radians); sign = direction
 * @returns {null | {
 *   origin: { position:[number,number,number], rotation:[number,number,number] },
 *   mateId?: string,
 *   roll?: number,
 *   regime: 'mated' | 'free',
 * }}
 */
export function computeRolledOrigin(doc, componentId, deltaRad) {
    if (!doc || !componentId) return null;
    const comp = doc.components && doc.components[componentId];
    if (!comp) return null;

    const mate = _firstMateFor(doc, componentId);
    if (mate) {
        const hostWorld = _resolveHostWorld(doc, mate);
        const partConnector = mate.partConnectorRef && mate.partConnectorRef.connectorId
            ? (doc.connectors && doc.connectors[mate.partConnectorRef.connectorId])
            : null;
        // Resolvable mate → re-solve with accumulated roll. Single-axis
        // mates roll about the mate axis; slot/line channels roll about the
        // host FACE NORMAL (solveSlotMate's roll), so the part flips in place
        // on the face it's seated on — 180° reverses it along the run. The
        // old behaviour free-spun channel-mated parts about the RUN axis,
        // which rotated the nut out of its channel.
        //
        // Channels that CAN'T route the slot solver (no `normal` on the host
        // — e.g. a bare rail-rail mate) skip the re-solve: solveMateTransform
        // would fall to the single-axis path and ignore the slide, snapping
        // the part back to the host origin. They free-spin below instead.
        const hostIsChannel = hostWorld
            && (hostWorld.topology === 'line' || hostWorld.kind === 'slot'
                || hostWorld.kind === 'rail');
        const channelSolvable = hostIsChannel
            && (hostWorld.topology === 'line' || hostWorld.kind === 'slot')
            && Array.isArray(hostWorld.normal);
        if (hostWorld && partConnector && (!hostIsChannel || channelSolvable)) {
            const prevRoll = (mate.offset && Number.isFinite(mate.offset.roll))
                ? mate.offset.roll : 0;
            const roll = prevRoll + deltaRad;
            // Preserve the part's position along a channel: persisted slide
            // first, else project its current world seat onto the run.
            const slide = _currentSlide(doc, mate, hostWorld, partConnector);
            const solved = solveMateTransform(hostWorld, partConnector, { roll, slide });
            return {
                origin: {
                    position: solved.position.slice(),
                    rotation: solved.euler.slice(),
                },
                mateId: mate.id,
                roll,
                ...(Number.isFinite(slide) ? { slide } : {}),
                regime: 'mated',
            };
        }
        // Unresolved mate → spin about the host axis through the current
        // origin (keeps the part on the same face/rail visually).
        if (hostWorld && Array.isArray(hostWorld.axis)) {
            return _freeSpin(comp, hostWorld.axis, deltaRad);
        }
    }

    // Free placement — spin about world +Z (a part sitting on the ground).
    return _freeSpin(comp, [0, 0, 1], deltaRad);
}

/**
 * Slide (mm along the channel run) the part currently sits at. Prefers the
 * persisted mate offset; otherwise projects the part connector's current
 * world origin onto the host run axis (the seat-depth offset is along the
 * face normal, perpendicular to the run, so it doesn't pollute the
 * projection). Returns undefined for point hosts — the single-axis solver
 * ignores `slide`.
 */
function _currentSlide(doc, mate, hostWorld, partConnector) {
    const isChannel = hostWorld.topology === 'line' || hostWorld.kind === 'slot'
        || hostWorld.kind === 'rail';
    if (!isChannel || !Array.isArray(hostWorld.axis)) return undefined;
    if (mate.offset && Number.isFinite(mate.offset.slide)) return mate.offset.slide;
    const pw = worldConnectorFor(doc, partConnector);
    const p = pw && Array.isArray(pw.origin) ? pw.origin : null;
    if (!p) return undefined;
    const a = hostWorld.axis;
    const m = Math.hypot(a[0], a[1], a[2]) || 1;
    const o = hostWorld.origin || [0, 0, 0];
    return ((p[0] - o[0]) * a[0] + (p[1] - o[1]) * a[1] + (p[2] - o[2]) * a[2]) / m;
}

/**
 * Slide-along-channel — pure math for the keyboard slide-nudge (the "," / "."
 * gesture, mirror of the "[" / "]" rotate-to-fit). Adjusts where a placed,
 * channel-mated component sits along its slot/rail run, preserving the seat
 * (face normal alignment, seat depth) and any accumulated roll.
 *
 * Returns `null` for components that aren't channel-mated — keyboard handler
 * uses null to fall through (no-op) so non-slot selections don't beep.
 *
 * Channel must be solver-routable (`topology: 'line'` or `kind: 'slot'`, with
 * a `normal` on the host) — bare rail-rail mates fall through. The slide is
 * clamped to the host `extent` so the part can't leave the channel.
 *
 * @param {object} doc          — DocumentStore.doc
 * @param {string} componentId
 * @param {number} deltaMm      — slide increment (mm); sign = direction along run
 * @returns {null | {
 *   origin: { position:[number,number,number], rotation:[number,number,number] },
 *   mateId: string,
 *   slide: number,
 *   roll?: number,
 *   regime: 'channel',
 * }}
 */
export function computeSlidPlacement(doc, componentId, deltaMm, opts = {}) {
    if (!doc || !componentId || !Number.isFinite(deltaMm)) return null;
    const comp = doc.components && doc.components[componentId];
    if (!comp) return null;

    const mate = _firstMateFor(doc, componentId);
    if (!mate) return null;

    const hostWorld = _resolveHostWorld(doc, mate);
    if (!hostWorld) return null;

    const isChannel = hostWorld.topology === 'line'
        || hostWorld.kind === 'slot'
        || hostWorld.kind === 'rail';
    if (!isChannel) return null;

    // We re-solve via solveSlotMate (triggered by line topology + host normal).
    // Bare rail-rail mates would fall through solveMateTransform's single-axis
    // path which ignores `slide` — skip those so we never silently no-op.
    const channelSolvable = (hostWorld.topology === 'line' || hostWorld.kind === 'slot')
        && Array.isArray(hostWorld.normal);
    if (!channelSolvable) return null;

    const partConnector = mate.partConnectorRef && mate.partConnectorRef.connectorId
        ? (doc.connectors && doc.connectors[mate.partConnectorRef.connectorId])
        : null;
    if (!partConnector) return null;

    // Live-edit baseSlide override: the keyboard handler accumulates slide
    // locally during a key-mash without committing each press to the doc, then
    // hands us its running total so we re-solve from the right baseline. With
    // no override we read the persisted offset (or project the current seat),
    // which is what one-shot callers want.
    const prevSlide = Number.isFinite(opts.baseSlide)
        ? opts.baseSlide
        : _currentSlide(doc, mate, hostWorld, partConnector);
    const base = Number.isFinite(prevSlide) ? prevSlide : 0;
    let slide = base + deltaMm;
    if (hostWorld.extent) {
        slide = Math.max(hostWorld.extent.from, Math.min(hostWorld.extent.to, slide));
    }

    const prevRoll = (mate.offset && Number.isFinite(mate.offset.roll))
        ? mate.offset.roll : undefined;
    const solveOpts = Number.isFinite(prevRoll) ? { slide, roll: prevRoll } : { slide };
    const solved = solveMateTransform(hostWorld, partConnector, solveOpts);

    return {
        origin: {
            position: solved.position.slice(),
            rotation: solved.euler.slice(),
        },
        mateId: mate.id,
        slide,
        ...(Number.isFinite(prevRoll) ? { roll: prevRoll } : {}),
        regime: 'channel',
    };
}

/**
 * Pick the component the slide-keys should act on.
 *
 * If `preferredId` is given and that component has a channel mate, return it
 * unchanged. Otherwise, scan every Mate in the doc and collect components whose
 * host is a slot/line/rail port: if exactly ONE exists, return it (the obvious
 * answer when there's a single t-nut on a single extrusion); if more than one,
 * return null with `reason: 'ambiguous'`; if none, `reason: 'none'`. Callers
 * use the reason to surface a helpful toast instead of silently no-op'ing.
 *
 * @param {object} doc
 * @param {string|null} preferredId
 * @returns {{ componentId: string }|{ componentId: null, reason: 'ambiguous'|'none' }}
 */
export function findSlidableComponent(doc, preferredId) {
    if (!doc || !doc.mates) return { componentId: null, reason: 'none' };
    const mates = Object.values(doc.mates);
    const isChannelMate = (m) => {
        if (!m || !m.componentId) return false;
        const ref = m.hostConnectorRef;
        if (!ref) return false;
        let host = null;
        if (ref.connectorId && doc.connectors) host = doc.connectors[ref.connectorId];
        else if (ref.world) host = ref.world;
        if (!host) return false;
        return host.topology === 'line' || host.kind === 'slot' || host.kind === 'rail';
    };
    if (preferredId) {
        const hit = mates.find((m) => m.componentId === preferredId && isChannelMate(m));
        if (hit) return { componentId: preferredId };
    }
    const slidable = new Set();
    for (const m of mates) {
        if (isChannelMate(m)) slidable.add(m.componentId);
    }
    if (slidable.size === 0) return { componentId: null, reason: 'none' };
    if (slidable.size === 1) return { componentId: [...slidable][0] };
    return { componentId: null, reason: 'ambiguous' };
}

function _freeSpin(comp, axis, deltaRad) {
    const o = comp.origin || {};
    const pos = Array.isArray(o.position) ? o.position.slice() : [0, 0, 0];
    const rot = Array.isArray(o.rotation) ? o.rotation : [0, 0, 0];
    return {
        origin: {
            position: pos,
            rotation: eulerAfterRoll(rot, axis, deltaRad),
        },
        regime: 'free',
    };
}

function _firstMateFor(doc, componentId) {
    if (!doc || !doc.mates) return null;
    for (const m of Object.values(doc.mates)) {
        if (m && m.componentId === componentId) return m;
    }
    return null;
}

function _resolveHostWorld(doc, mate) {
    const ref = mate && mate.hostConnectorRef ? mate.hostConnectorRef : null;
    if (!ref) return null;
    if (ref.connectorId && doc.connectors && doc.connectors[ref.connectorId]) {
        return worldConnectorFor(doc, doc.connectors[ref.connectorId]);
    }
    if (ref.world) return ref.world;
    return null;
}
