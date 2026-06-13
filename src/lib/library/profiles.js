/**
 * T-slot profile registry + slot-port generation.
 *
 * THE INSIGHT (see COMPONENT_LIBRARY plan): an extrusion's slots — the one
 * thing the part is *for* — must not be hand-authored per length. Each
 * extrusion length shares a cross-section *profile*; the four (or more) slot
 * channels are a deterministic function of that profile. So we describe the
 * profile once and *generate* the slot ports for every length.
 *
 * A "slot port" is a richer connector (Phase: port model v2). Beyond the
 * legacy point-connector fields it carries:
 *   - topology: 'line'   — the mating site is a 1-D channel, not a point. The
 *                          mate leaves a slide DOF (→ prismatic joint).
 *   - axis:     run dir  — the channel's running direction (= extrusion long
 *                          axis, +Z in part-local frame).
 *   - normal:   face out — the outward normal of the face the slot opens on.
 *                          A sliding nut's seating-plane normal mates
 *                          anti-/co-linear to this so the part lands *in* the
 *                          channel facing out, not at the centerline.
 *   - extent:   {from,to} slide range along `axis`, relative to the port
 *                          origin (so a dropped nut can't slide off the ends).
 *   - profile:  id        cross-section family ('tslot-2020', …). Two ports
 *                          with the same profile mate (see mate_solver
 *                          connectorsCompatible profile fast-path).
 *   - fit:      'detent'  engagement class (drives DFM + future kernel
 *                          boolean: clearance hole vs. press vs. tapped).
 *
 * Coordinate convention: extrusions are built MIN-aligned on Z, centered in
 * XY, running along +Z (see CLAUDE.md / emit.js). So the long axis is +Z and
 * the four running faces have outward normals ±X / ±Y.
 *
 * Pure module — no THREE, no document store. Tested in
 * __tests__/slot_mate.mjs with synthetic extrusion records.
 */

import { makeConnector } from '../../../lib/document/types.js';

/**
 * Each profile lists its running faces. Per face:
 *   - normal:  outward face normal (unit, ±X/±Y)
 *   - slots:   one entry per channel on that face. `across` is the channel's
 *              offset from the face center along the in-face transverse axis
 *              (transverse = axis × normal), in mm. A face-centered slot is
 *              `across: 0`; multi-cell faces list one slot per cell.
 *
 * `half` is the half-extent of the cross-section along X and Y, used to put
 * each face's surface plane (face center sits at `half[axisOfNormal]`).
 * `seatDepth` is how far below the face surface the seated part's reference
 * point drops (so the nut sits inside the lip, not floating on the surface).
 * `endMargin` keeps the slide range clear of the extruded ends.
 */
export const TSLOT_PROFILES = Object.freeze({
    'tslot-2020': {
        series: 'M5', size: 20, half: [10, 10],
        seatDepth: 1.0, endMargin: 8,
        faces: [
            { normal: [ 1, 0, 0], slots: [{ across: 0 }] },
            { normal: [-1, 0, 0], slots: [{ across: 0 }] },
            { normal: [ 0, 1, 0], slots: [{ across: 0 }] },
            { normal: [ 0,-1, 0], slots: [{ across: 0 }] },
        ],
    },
    // 2040 = two 2020 cells stacked along Y. The 40-mm-wide ±X faces carry one
    // slot per cell (across = ±10); the 20-mm ±Y faces carry one centered slot.
    'tslot-2040': {
        series: 'M5', size: 20, half: [10, 20],
        seatDepth: 1.0, endMargin: 8,
        faces: [
            { normal: [ 1, 0, 0], slots: [{ across: -10 }, { across: 10 }] },
            { normal: [-1, 0, 0], slots: [{ across: -10 }, { across: 10 }] },
            { normal: [ 0, 1, 0], slots: [{ across: 0 }] },
            { normal: [ 0,-1, 0], slots: [{ across: 0 }] },
        ],
    },
    // 4040 (M8 / 40-series) — one centered slot per face.
    'tslot-4040': {
        series: 'M8', size: 40, half: [20, 20],
        seatDepth: 1.5, endMargin: 10,
        faces: [
            { normal: [ 1, 0, 0], slots: [{ across: 0 }] },
            { normal: [-1, 0, 0], slots: [{ across: 0 }] },
            { normal: [ 0, 1, 0], slots: [{ across: 0 }] },
            { normal: [ 0,-1, 0], slots: [{ across: 0 }] },
        ],
    },
});

/**
 * Map an extrusion record's declared `interfaceId` (on its end connectors,
 * e.g. 'profile-2020') to a slot-profile id ('tslot-2020'). Returns null when
 * the part isn't a known T-slot profile.
 */
export function profileIdForRecord(rec) {
    if (!rec) return null;
    // Prefer an explicit profile on any connector.
    for (const c of rec.connectors || []) {
        if (typeof c.profile === 'string' && TSLOT_PROFILES[c.profile]) return c.profile;
    }
    // Fall back to the end-connector interfaceId 'profile-XXXX' → 'tslot-XXXX'.
    for (const c of rec.connectors || []) {
        const iid = c.interfaceId;
        if (typeof iid === 'string' && iid.startsWith('profile-')) {
            const cand = `tslot-${iid.slice('profile-'.length)}`;
            if (TSLOT_PROFILES[cand]) return cand;
        }
    }
    return null;
}

/** Length (mm) of an extrusion record along its +Z long axis, from its bbox. */
function _lengthOf(rec) {
    const bb = rec && rec.boundingBox;
    if (!bb || !Array.isArray(bb.min) || !Array.isArray(bb.max)) return null;
    return bb.max[2] - bb.min[2];
}

/** transverse in-face axis = axis × normal (right-handed). axis is +Z. */
function _transverse(normal) {
    // (0,0,1) × normal
    return [-normal[1], normal[0], 0];
}

/**
 * Generate the slot-port connectors for one extrusion record. Returns a fresh
 * Connector[] (does not mutate `rec`). Each port is a `kind:'slot'`,
 * `topology:'line'` connector in the part-local frame.
 *
 * @param {object} rec — extrusion PartRecord (needs boundingBox + a profile)
 * @returns {object[]}
 */
export function slotPortsForExtrusion(rec) {
    const profileId = profileIdForRecord(rec);
    if (!profileId) return [];
    const prof = TSLOT_PROFILES[profileId];
    const L = _lengthOf(rec);
    if (!(L > 0)) return [];

    const midZ = L / 2;
    const halfRun = midZ - prof.endMargin;          // slide range each way
    const axis = [0, 0, 1];
    const out = [];

    for (const face of prof.faces) {
        const n = face.normal;
        const faceHalf = Math.abs(n[0]) > 0.5 ? prof.half[0] : prof.half[1];
        const tv = _transverse(n);                  // unit (±X or ±Y)
        for (let s = 0; s < face.slots.length; s++) {
            const across = face.slots[s].across || 0;
            // Surface point at mid-run, offset across the face by `across`.
            const origin = [
                n[0] * faceHalf + tv[0] * across,
                n[1] * faceHalf + tv[1] * across,
                midZ,
            ];
            const faceTag = `${n[0]}${n[1]}`.replace('-', 'm');
            out.push(makeConnector({
                id: `slot:${faceTag}:${s}`,
                parent: rec.id,
                kind: 'slot',
                gender: 'neutral',
                size: { nominal: prof.series, unit: 'mm' },
                axis,
                origin,
                normal: n.slice(),
                topology: 'line',
                extent: { from: -halfRun, to: halfRun },
                profile: profileId,
                fit: 'detent',
                mates_with: ['rail', 'slot'],
                inducedJoint: 'prismatic',
                // Profile-generated slot ports are a deterministic function of
                // the cross-section + length. They're part of the part's
                // contract — immutable. See CLAUDE.md "The connector contract".
                locked: true,
                metadata: {
                    description: `${prof.size}-series t-slot channel, face [${n}]`,
                    generated: true,
                    seatDepth: prof.seatDepth,
                },
            }));
        }
    }
    return out;
}

/**
 * Expand a loaded PartRecord in place: if it's a T-slot extrusion, append the
 * generated slot ports to its `connectors`. Idempotent (guards on a flag).
 * Called by the library loader so every length gets its slots for free.
 *
 * @param {object} rec
 * @returns {object} the same record
 */
export function expandPortsInPlace(rec) {
    if (!rec || rec.__portsExpanded) return rec;
    if (rec.category === 'extrusion') {
        const ports = slotPortsForExtrusion(rec);
        if (ports.length) {
            rec.connectors = [...(rec.connectors || []), ...ports];
        }
    }
    Object.defineProperty(rec, '__portsExpanded', { value: true, enumerable: false });
    return rec;
}
