/**
 * Phase 5 — Connector-driven Casing / cover generator (emit side).
 *
 * This module owns the heart of Phase 5: turning a `Casing` feature into
 * build123d Python. It is split out of emit.js so the geometry-emit logic
 * (offset-shell, connector→geometry mapping, split-with-lip) stays readable
 * and independently testable.
 *
 * THE BIG IDEA
 * ------------
 * A casing is *derived* from the assembly's semantic connectors, not from
 * frozen coordinates. The emitter, at emit time:
 *   1. Unions the placed (world-frame) bodies of the enclosed features.
 *   2. Offsets that union outward by `clearance` (inner void) and again by
 *      `wall` (outer skin); `outer - inner` is the enclosure wall.
 *   3. Walks `doc.connectors` for the target components, transforms each
 *      connector's local origin/axis into WORLD frame via
 *      `composeComponentTransform`, and adds functional geometry per a
 *      role/kind → op mapping table:
 *        - fastener/thread connectors → a screw BOSS (cylinder + pilot hole)
 *        - shaft / port / panel-switch connectors → a CUTOUT (round or rect)
 *          subtracted where the axis pierces the shell.
 *   4. Optionally SPLITs the casing along a plane into two halves with a
 *      lip/groove rabbet + corner screw bosses.
 *
 * AUTO-UPDATE ON SWAP (Phase 2 ↔ Phase 5)
 * ---------------------------------------
 * Because every boss/cutout position is computed FRESH from `doc.connectors`
 * + `composeComponentTransform` on each emit, a Phase-2 `replaceComponent`
 * that changes a part's connectors (or moves its component) automatically
 * relocates the casing's bosses/cutouts on the very next compile. NOTHING
 * here caches a connector position — the JS builds a Python program that the
 * kernel re-evaluates from current document state every time.
 *
 * DEFENSIVENESS
 * -------------
 * OCCT offset/split can fail on tricky geometry. Every fragile step is
 * wrapped in try/except in the EMITTED Python so a failure degrades to a
 * passthrough body (or skips a single boss/cutout) instead of crashing the
 * whole document compile — mirroring how addSplitFace / addAlign keep the
 * timeline alive. The JS side also guards inputs (wall>0, clearance>=0).
 *
 * DETERMINISM
 * -----------
 * No Date / random. Connectors are processed in a stable order (sorted by
 * connector id). Numbers are emitted via the shared `py()` from emit.js.
 *
 * @module lib/document/casing
 */

import { componentDescendants } from './store.js';

// ── Connector role/kind → geometry-op mapping table ──────────────────────────
//
// EXTENSIBLE: add a row here to teach the casing a new connector semantic.
// `op` is one of:
//   'boss'    — raise a screw boss (cylinder to the wall) + pilot hole.
//   'cutout'  — subtract a hole where the connector axis pierces the shell.
//   'skip'    — connector is purely a mate site; no casing geometry.
//
// `shape` (for cutouts) is 'round' or 'rect'. `size` is derived per-connector
// from the connector's `size.nominal` / `interfaceId` at emit time (see
// `cutoutDimsFor`). Matching is by `role` first, then `kind`, then a default.

export const CONNECTOR_GEOMETRY_MAP = Object.freeze({
    // ── Fastener / thread → boss ────────────────────────────────────────────
    byRole: {
        'servo-mount':    { op: 'boss', pilot: 1.6 },   // M2 self-tap pilot
        'screw-thread':   { op: 'boss', pilot: 2.5 },
        'thread-top':     { op: 'boss', pilot: 2.5 },
        'thread-bottom':  { op: 'boss', pilot: 2.5 },
        'pcb-mount':      { op: 'boss', pilot: 2.5 },
        // ── Things that must pierce the wall → cutout ──────────────────────
        'output-shaft':   { op: 'cutout', shape: 'round' },
        'shaft-bore':     { op: 'cutout', shape: 'round' },
        'horn-spline':    { op: 'cutout', shape: 'round' },
        'panel-port':     { op: 'cutout', shape: 'rect' },
        'panel-switch':   { op: 'cutout', shape: 'rect' },
        'linear-rail':    { op: 'cutout', shape: 'rect' },
        'rail-slide':     { op: 'cutout', shape: 'rect' },
        // ── Pure mate sites — no casing geometry ───────────────────────────
        'battery-bay':    { op: 'skip' },
        'extrusion-end':  { op: 'skip' },
        't-slot':         { op: 'skip' },
        'outer-race':     { op: 'skip' },
    },
    byKind: {
        thread:  { op: 'boss',   pilot: 2.5 },
        bore:    { op: 'cutout', shape: 'round' },
        shaft:   { op: 'cutout', shape: 'round' },
        rail:    { op: 'cutout', shape: 'rect' },
        // planar / tab / slot connectors are mate sites by default
        planar:  { op: 'skip' },
        tab:     { op: 'skip' },
        slot:    { op: 'skip' },
    },
    default: { op: 'skip' },
});

/** Resolve the geometry op for a connector. role wins over kind. */
export function geometryOpFor(connector) {
    if (!connector) return CONNECTOR_GEOMETRY_MAP.default;
    const byRole = connector.role && CONNECTOR_GEOMETRY_MAP.byRole[connector.role];
    if (byRole) return byRole;
    const byKind = connector.kind && CONNECTOR_GEOMETRY_MAP.byKind[connector.kind];
    if (byKind) return byKind;
    return CONNECTOR_GEOMETRY_MAP.default;
}

// ── Size derivation ──────────────────────────────────────────────────────────
//
// A connector declares its physical size in `size.nominal` (e.g. 6.5, "19x13",
// "M3", "mini-usb") plus an `interfaceId`. We map those to concrete mm cutout
// dimensions. Unknown sizes fall back to a generous default so the body still
// compiles; the DFM pass / user can refine later.

const _INTERFACE_CUTOUT = Object.freeze({
    // panel switches: explicit datasheet cutout sizes from AUTHORING.md.
    'panel-cutout-rocker-19x13': { shape: 'rect', w: 19, h: 13 },
    'panel-cutout-toggle-m6':    { shape: 'round', d: 6.5 },
    // ports — approximate connector envelopes (clearance for the plug).
    'port-mini-usb':  { shape: 'rect', w: 8,  h: 4 },
    'port-micro-usb': { shape: 'rect', w: 8,  h: 3 },
    'port-usb-c':     { shape: 'rect', w: 10, h: 4 },
    'port-xt60':      { shape: 'rect', w: 16, h: 8 },
    // splines / shafts — bore the spline diameter + a little clearance.
    'spline-SG90':    { shape: 'round', d: 6 },
    'spline-25T':     { shape: 'round', d: 8 },
});

/**
 * Parse a connector size into concrete mm cutout dimensions for the given
 * `op`. Returns { shape:'round', d } or { shape:'rect', w, h }.
 *
 * Resolution order: interfaceId table → numeric nominal → "WxH" string →
 * "Mn" thread → default. `clearance` mm is added so the cutout isn't a press
 * fit on the part it passes.
 *
 * @param {object} connector
 * @param {{ op:string, shape?:string }} opSpec
 * @param {number} clearance
 * @returns {{ shape:'round', d:number }|{ shape:'rect', w:number, h:number }}
 */
export function cutoutDimsFor(connector, opSpec, clearance = 1) {
    const cl = Number.isFinite(clearance) ? Math.max(0, clearance) : 0;
    const iface = connector && connector.interfaceId;
    const table = iface && _INTERFACE_CUTOUT[iface];
    if (table) {
        if (table.shape === 'round') return { shape: 'round', d: table.d + 2 * cl };
        return { shape: 'rect', w: table.w + 2 * cl, h: table.h + 2 * cl };
    }
    const nominal = connector && connector.size && connector.size.nominal;
    // "WxH" rectangle, e.g. "19x13".
    if (typeof nominal === 'string') {
        const m = nominal.match(/^(\d+(?:\.\d+)?)\s*[xX]\s*(\d+(?:\.\d+)?)$/);
        if (m) return { shape: 'rect', w: Number(m[1]) + 2 * cl, h: Number(m[2]) + 2 * cl };
        // "M3" thread → use nominal diameter for a round cutout.
        const mm = nominal.match(/^M(\d+(?:\.\d+)?)$/i);
        if (mm) return { shape: 'round', d: Number(mm[1]) + 2 * cl };
    }
    if (typeof nominal === 'number' && Number.isFinite(nominal)) {
        return { shape: 'round', d: nominal + 2 * cl };
    }
    // Default per the op's declared shape (or round).
    if (opSpec && opSpec.shape === 'rect') return { shape: 'rect', w: 10 + 2 * cl, h: 8 + 2 * cl };
    return { shape: 'round', d: 8 + 2 * cl };
}

/** Boss outer diameter for a thread connector (pilot + 2× wall-ish collar). */
export function bossDimsFor(connector, opSpec) {
    const pilot = (opSpec && Number.isFinite(opSpec.pilot)) ? opSpec.pilot : 2.5;
    // A boss collar ~2× the pilot gives material around a self-tapping screw.
    const outer = Math.max(pilot + 3, pilot * 2.2);
    return { pilot, outer };
}

// ── Target resolution ────────────────────────────────────────────────────────
/**
 * Given the casing feature's `targets` (component ids and/or feature ids) and
 * the document, return:
 *   - `featureIds`: every enabled body-producing feature to enclose, in stable
 *     order (sorted by id for determinism).
 *   - `componentIds`: the set of component ids those features belong to
 *     (target components + their descendants), used to gather connectors.
 *
 * A target may be a componentId (enclose every feature under that component
 * subtree) or a featureId (enclose that one feature). We accept both because
 * the op stores componentIds but a caller / test may pass a bare feature id.
 *
 * @param {Document} doc
 * @param {string[]} targets
 * @returns {{ featureIds: string[], componentIds: Set<string> }}
 */
export function resolveTargets(doc, targets) {
    const featureIds = new Set();
    const componentIds = new Set();
    const components = (doc && doc.components) || {};
    const features = (doc && doc.features) || {};
    const list = Array.isArray(targets) ? targets : [];

    // Expand a component target to itself + descendants.
    const expandComponent = (cid) => {
        if (!cid) return;
        componentIds.add(cid);
        try {
            for (const c of componentDescendants(doc, cid)) componentIds.add(c.id);
        } catch { /* ignore — single component still added */ }
    };

    for (const t of list) {
        if (!t) continue;
        if (components[t]) { expandComponent(t); continue; }
        if (features[t])  {
            featureIds.add(t);
            const owner = features[t].componentId || 'root';
            componentIds.add(owner);
            continue;
        }
        // Unknown id — tolerate (it may be a component id whose entry was
        // trimmed); add as a component so connector lookup still tries.
        expandComponent(t);
    }

    // Pull in every body-producing feature owned by the target components.
    for (const f of Object.values(features)) {
        if (!f || !f.enabled) continue;
        const owner = f.componentId || 'root';
        if (componentIds.has(owner)) featureIds.add(f.id);
    }

    return {
        featureIds: [...featureIds].sort(),
        componentIds,
    };
}

/**
 * Collect the connectors whose `parent` is one of the target components,
 * sorted by id for deterministic emit. Connector.parent in the document is
 * typically the componentId (placeLibraryPart stamps connectors with the
 * placed componentId); we also accept connectors parented to a featureId
 * owned by a target component.
 *
 * @param {Document} doc
 * @param {Set<string>} componentIds
 * @returns {object[]}
 */
export function connectorsForTargets(doc, componentIds) {
    const connectors = (doc && doc.connectors) || {};
    const features = (doc && doc.features) || {};
    const out = [];
    for (const c of Object.values(connectors)) {
        if (!c || !c.parent) continue;
        if (componentIds.has(c.parent)) { out.push(c); continue; }
        // parent is a feature → check its owning component.
        const f = features[c.parent];
        if (f && componentIds.has(f.componentId || 'root')) out.push(c);
    }
    out.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    return out;
}

// ── Vector math (world-frame connector placement) ────────────────────────────
/**
 * Apply a composed component transform (position mm + rotationDeg XYZ) to a
 * connector's local origin and axis, producing WORLD coordinates. Mirrors the
 * XYZ-intrinsic Euler convention used in emit.js (`composeComponentTransform`
 * returns degrees; we convert back to radians here).
 *
 * @param {[number,number,number]} v        local point/vector
 * @param {{position:number[], rotationDeg:number[]}} t
 * @param {boolean} isDirection  true → ignore translation (rotate only)
 * @returns {[number,number,number]}
 */
export function applyTransform(v, t, isDirection = false) {
    const [x, y, z] = (Array.isArray(v) && v.length === 3) ? v : [0, 0, 0];
    const pos = (t && Array.isArray(t.position)) ? t.position : [0, 0, 0];
    const deg = (t && Array.isArray(t.rotationDeg)) ? t.rotationDeg : [0, 0, 0];
    const D2R = Math.PI / 180;
    const rx = (deg[0] || 0) * D2R, ry = (deg[1] || 0) * D2R, rz = (deg[2] || 0) * D2R;
    const cx = Math.cos(rx), sx = Math.sin(rx);
    const cy = Math.cos(ry), sy = Math.sin(ry);
    const cz = Math.cos(rz), sz = Math.sin(rz);
    // Rotation matrix for Euler XYZ intrinsic (same basis as emit.js _mat4FromPosEuler).
    const m11 = cy * cz;
    const m12 = -cy * sz;
    const m13 = sy;
    const m21 = cx * sz + sx * sy * cz;
    const m22 = cx * cz - sx * sy * sz;
    const m23 = -sx * cy;
    const m31 = sx * sz - cx * sy * cz;
    const m32 = sx * cz + cx * sy * sz;
    const m33 = cx * cy;
    const wx = m11 * x + m12 * y + m13 * z;
    const wy = m21 * x + m22 * y + m23 * z;
    const wz = m31 * x + m32 * y + m33 * z;
    if (isDirection) return [wx, wy, wz];
    return [wx + (pos[0] || 0), wy + (pos[1] || 0), wz + (pos[2] || 0)];
}

/** Clean float dust for stable emit (mirrors emit.js _clean). */
export function cleanNum(n) {
    if (!Number.isFinite(n)) return 0;
    const r = Math.round(n * 1e6) / 1e6;
    return Object.is(r, -0) ? 0 : r;
}
