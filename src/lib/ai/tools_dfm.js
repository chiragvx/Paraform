/**
 * DFM / printability tool layer — design-for-manufacturing tools the agent
 * can call once a part is modelled, on the road to a 3D-PRINTABLE result.
 *
 *   DFM_TOOLS — array of { name, description, input_schema, handler }
 *
 * Same contract as src/lib/ai/tools.js: each `handler(input)` returns a
 * JSON-serialisable object and NEVER throws (every risky call is wrapped in
 * try/catch and degrades to `{ ok:false, error }`). The kernel is the arbiter
 * for anything geometric — we VERIFY with `measure` / `runAllInvariants`, never
 * assert. Material / clearance / time numbers that aren't kernel-derived are
 * pure data lookups and are explicitly LABELLED as estimates.
 *
 * We only consume the public surfaces other agents own — the measure client,
 * the invariant runner, the v4 exporter, and the document store — and never
 * reach into operations.js / fold.js internals.
 */

import { N, S, B, num, fail } from './tools_util.js';
import { measure } from '../measure/api.js';
import { runAllInvariants } from '../invariants/runner.js';
import { getDocumentStore, exportDocumentAs, downloadDocumentAs, componentDescendants } from '../../../lib/document/index.js';

// ── Doc / body enumeration ────────────────────────────────────────────────────
//
// The kernel's measure(featureId) resolves ONE body at a time — there is no
// "whole document" bbox/volume/manifold query (an empty featureId errors). So
// every "over the part" measure fans out over the body-emitting feature ids,
// the same set the main tool layer's documentSummary() reports as `bodies`.

const BODY_EMITTING = new Set([
    'Box', 'Cylinder', 'Sphere', 'Torus', 'Extrude', 'Revolve', 'Sweep', 'Loft',
    'Fillet', 'Chamfer', 'Shell', 'Hole', 'Union', 'Cut', 'Intersect', 'Split',
    'Move', 'Rotate', 'Scale', 'Align', 'LinearPattern', 'CircularPattern',
    'PathPattern', 'Mirror', 'StandardPart', 'ImportedMesh',
    'PushPullFace', 'MoveFace', 'OffsetFace', 'DeleteFace', 'Draft',
    'Casing', 'Gear',
    'Pulley', 'Sprocket', 'TSlotExtrusion', 'ScrewBoss', 'Standoff', 'Fan',
    'MountingPlate', 'Bracket', 'ThreadedInsertBoss', 'NutTrap', 'SnapHook',
    'BearingPocket', 'MotorMount', 'ShaftCoupler', 'Wheel', 'TimingPulley',
    'Hinge', 'ProjectBox', 'PCBTray', 'Knob',
    'Foot', 'Gusset', 'Handle', 'ShaftHub', 'Lid', 'RackGear', 'BatteryHolder',
    'DINRailClip', 'CableClip', 'GridfinityBin', 'TSlotBracket',
    'Impeller', 'Auger', 'BlowerWheel', 'PaddleWheel', 'PiCase',
]);

/** Live document, or an empty stand-in so callers never see `undefined`. */
function liveDoc() {
    try {
        const doc = getDocumentStore().doc;
        return doc || { features: {}, featureOrder: [], components: {} };
    } catch {
        return { features: {}, featureOrder: [], components: {} };
    }
}

/**
 * Body-emitting feature ids, in authored order. When `componentId` is given we
 * keep only the bodies owned by that component (advisory — falls back to all
 * bodies if the filter would empty the set, so a bad id never blanks a report).
 */
function bodyIds(doc, componentId) {
    const order = doc.featureOrder && doc.featureOrder.length
        ? doc.featureOrder
        : Object.keys(doc.features || {});
    const all = order
        .map((id) => doc.features[id])
        .filter((f) => f && f.enabled !== false && BODY_EMITTING.has(f.type))
        .map((f) => f.id);
    if (!componentId) return all;
    const scoped = order
        .map((id) => doc.features[id])
        .filter((f) => f && f.enabled !== false && BODY_EMITTING.has(f.type) && (f.componentId || 'root') === componentId)
        .map((f) => f.id);
    return scoped.length ? scoped : all;
}

// ── Process tables (pure data — labelled estimates) ───────────────────────────
//
// Wall minima are per-process rules of thumb in mm. FDM minimum is derived
// from the nozzle (≈2× nozzle width); SLA / SLS are fixed resin/powder floors.

const PROCESS = {
    fdm: { label: 'FDM/FFF', minWallFn: (nozzle) => 2 * nozzle, recWallFn: (nozzle) => 3 * nozzle, defaultNozzle: 0.4 },
    sla: { label: 'SLA/resin', minWall: 0.5, recWall: 1.0 },
    sls: { label: 'SLS/powder', minWall: 0.7, recWall: 1.2 },
};

/** Resolve { minWall, recWall, label } for a process + nozzle (mm). */
function wallLimits(process, nozzleMm) {
    const p = PROCESS[process] || PROCESS.fdm;
    if (p.minWallFn) {
        const nozzle = num(nozzleMm, p.defaultNozzle);
        return { label: p.label, minWall: p.minWallFn(nozzle), recWall: p.recWallFn(nozzle), nozzle };
    }
    return { label: p.label, minWall: p.minWall, recWall: p.recWall, nozzle: null };
}

// Default desktop FDM build volume (Ender-class). Larger → warp/fit risk.
const DEFAULT_BED = { x: 220, y: 220, z: 250 };

// ── Tool 1: check_printability ────────────────────────────────────────────────

/**
 * Compose a red/yellow/green printability verdict from kernel truth:
 *   - manifold per body  → RED if any body isn't watertight/closed
 *   - bbox per body      → smallest dimension feeds a LABELLED wall estimate
 *   - whole-assembly bbox vs bed → YELLOW if it overflows the default bed
 *   - existing invariant errors/warnings folded straight into findings
 * Never throws; degrades to whatever it could measure.
 */
async function checkPrintability(input) {
    const i = input || {};
    const process = (PROCESS[i.process] ? i.process : 'fdm');
    const limits = wallLimits(process, i.nozzleMm);
    const findings = [];
    const assumptions = [];

    const doc = liveDoc();
    const ids = bodyIds(doc);

    if (ids.length === 0) {
        return {
            ok: true,
            verdict: 'yellow',
            findings: [{ severity: 'yellow', type: 'empty', message: 'No solid bodies in the document to check.', suggestedFix: 'Model at least one body, then re-check.' }],
            assumptions: [`process=${process} (${limits.label})`],
        };
    }

    assumptions.push(`process=${process} (${limits.label})`);
    if (limits.nozzle != null) assumptions.push(`nozzle=${limits.nozzle}mm → min wall ${round(limits.minWall)}mm, recommended ${round(limits.recWall)}mm (≈2-3× nozzle)`);
    else assumptions.push(`min wall ${round(limits.minWall)}mm, recommended ${round(limits.recWall)}mm for ${limits.label}`);
    assumptions.push('Wall thickness is ESTIMATED from each body\'s smallest bounding-box dimension — it is an upper bound on the thinnest feature, not a true minimum-wall scan.');
    assumptions.push(`Build volume assumed ${DEFAULT_BED.x}×${DEFAULT_BED.y}×${DEFAULT_BED.z}mm (desktop FDM).`);

    // Whole-assembly bbox accumulator (union of per-body boxes).
    let amin = [Infinity, Infinity, Infinity];
    let amax = [-Infinity, -Infinity, -Infinity];
    let sawBbox = false;
    let anyManifoldFail = false;
    let manifoldUnknown = 0;

    // Build one batched measure list: manifold + bbox per body.
    const queries = [];
    for (const id of ids) {
        queries.push({ type: 'manifold', featureId: id });
        queries.push({ type: 'bbox', featureId: id });
    }

    let results = [];
    try {
        results = await measure(queries);
        if (!Array.isArray(results)) results = [results];
    } catch (e) {
        // Transport / batch failure — report what we know and bail to yellow.
        findings.push({ severity: 'yellow', type: 'measure-unavailable', message: `Could not reach the kernel to verify geometry: ${fail(e).error}`, suggestedFix: 'Ensure the part compiles (Ctrl+S) and the kernel is reachable, then re-check.' });
        return { ok: true, verdict: 'yellow', findings, assumptions };
    }

    for (let k = 0; k < ids.length; k++) {
        const id = ids[k];
        const man = results[k * 2];
        const box = results[k * 2 + 1];

        // Manifold — RED on a confirmed open/non-watertight body.
        if (man && man.ok === true) {
            const closed = !!man.closed;
            const watertight = !!man.watertight;
            if (!closed || !watertight) {
                anyManifoldFail = true;
                findings.push({ severity: 'red', type: 'not-manifold', message: `Body "${id}" is not watertight (closed=${closed}, watertight=${watertight}) — most slicers will reject or mis-slice it.`, suggestedFix: 'Heal the geometry: ensure booleans fully fuse, avoid zero-thickness faces, re-run the boolean/shell that produced this body.' });
            }
        } else {
            manifoldUnknown++;
        }

        // Bbox — feeds wall estimate + assembly envelope.
        if (box && box.ok === true && Array.isArray(box.size)) {
            sawBbox = true;
            const [sx, sy, sz] = box.size;
            const smallest = Math.min(sx, sy, sz);
            if (Number.isFinite(smallest)) {
                if (smallest < limits.minWall) {
                    findings.push({ severity: 'red', type: 'thin-wall', message: `Body "${id}" has a smallest dimension of ${round(smallest)}mm, below the ${limits.label} minimum wall of ${round(limits.minWall)}mm (estimate — derived from the bounding box, not a true wall scan).`, suggestedFix: `Thicken the thinnest feature to at least ${round(limits.recWall)}mm, or print on a finer process.` });
                } else if (smallest < limits.recWall) {
                    findings.push({ severity: 'yellow', type: 'thin-but-printable', message: `Body "${id}" smallest dimension ${round(smallest)}mm is printable but below the recommended ${round(limits.recWall)}mm (estimate). Thin features may be fragile.`, suggestedFix: `Consider thickening to ${round(limits.recWall)}mm for strength.` });
                }
                // Large flat base → warp risk (footprint big, height shallow).
                if (Array.isArray(box.min) && Array.isArray(box.max)) {
                    const footprint = sx * sy;
                    if (footprint > 100 * 100 && sz < 0.1 * Math.max(sx, sy)) {
                        findings.push({ severity: 'yellow', type: 'warp-risk', message: `Body "${id}" has a large flat base (~${round(sx)}×${round(sy)}mm, ${round(sz)}mm tall) — prone to corner lift/warp, especially in ABS/ASA.`, suggestedFix: 'Add a brim/raft, use a heated bed/enclosure, or break the base into ribs.' });
                    }
                }
            }
            // Accumulate assembly envelope.
            if (Array.isArray(box.min) && Array.isArray(box.max)) {
                for (let a = 0; a < 3; a++) {
                    amin[a] = Math.min(amin[a], box.min[a]);
                    amax[a] = Math.max(amax[a], box.max[a]);
                }
            }
        }
    }

    if (manifoldUnknown > 0) {
        findings.push({ severity: 'yellow', type: 'manifold-unknown', message: `Could not confirm watertightness for ${manifoldUnknown} body/bodies — the manifold check was unavailable.`, suggestedFix: 'Recompile (Ctrl+S) and re-check; treat unconfirmed bodies as suspect before printing.' });
    }

    // Assembly envelope vs bed.
    if (sawBbox && amin.every(Number.isFinite) && amax.every(Number.isFinite)) {
        const env = [amax[0] - amin[0], amax[1] - amin[1], amax[2] - amin[2]];
        if (env[0] > DEFAULT_BED.x || env[1] > DEFAULT_BED.y || env[2] > DEFAULT_BED.z) {
            findings.push({ severity: 'yellow', type: 'oversize', message: `Assembly envelope ~${round(env[0])}×${round(env[1])}×${round(env[2])}mm exceeds the assumed ${DEFAULT_BED.x}×${DEFAULT_BED.y}×${DEFAULT_BED.z}mm build volume.`, suggestedFix: 'Split into printable sub-parts, scale down, or use a larger printer.' });
        }
    }

    // Fold in the document-wide invariants (manifold, material, clearance, …).
    try {
        const agg = await runAllInvariants({ measure });
        for (const e of (agg.errors || [])) {
            findings.push({ severity: 'red', type: `invariant:${e.category || e.id}`, message: (e.result && e.result.message) || `invariant ${e.id} failed`, suggestedFix: (e.result && e.result.suggestedFix) || null });
        }
        for (const w of (agg.warnings || [])) {
            findings.push({ severity: 'yellow', type: `invariant:${w.category || w.id}`, message: (w.result && w.result.message) || `invariant ${w.id} warned`, suggestedFix: (w.result && w.result.suggestedFix) || null });
        }
    } catch (e) {
        findings.push({ severity: 'yellow', type: 'invariants-unavailable', message: `Invariant checks could not run: ${fail(e).error}`, suggestedFix: 'Recompile and re-check.' });
    }

    // Verdict: any red → red; else any yellow → yellow; else green.
    let verdict = 'green';
    if (findings.some((f) => f.severity === 'red') || anyManifoldFail) verdict = 'red';
    else if (findings.some((f) => f.severity === 'yellow')) verdict = 'yellow';

    return { ok: true, verdict, findings, assumptions };
}

function round(v) {
    if (!Number.isFinite(v)) return v;
    return Math.round(v * 1000) / 1000;
}

// ── Tool 2: export_for_print ──────────────────────────────────────────────────

/**
 * Export the document for printing. STL is the slicer-ready mesh; STEP is the
 * editable solid. Runs a quick manifold pre-flight over the bodies — a non-
 * watertight body still exports (slicers can sometimes repair) but the result
 * carries a warning. `componentId` is ACCEPTED for intent but advisory: the v4
 * exporter emits the whole document, so a per-component export isn't isolated
 * here — the warning flags that.
 */
async function exportForPrint(input) {
    const i = input || {};
    let format = String(i.format || '').toLowerCase();
    if (format === 'stp') format = 'step';
    if (format !== 'stl' && format !== 'step') {
        return { ok: false, error: `unsupported format '${i.format}' — use 'stl' or 'step'` };
    }

    // Manifold pre-flight (non-blocking).
    let warning = null;
    try {
        const doc = liveDoc();
        const ids = bodyIds(doc, i.componentId);
        if (ids.length) {
            const res = await measure(ids.map((id) => ({ type: 'manifold', featureId: id })));
            const list = Array.isArray(res) ? res : [res];
            const bad = list.filter((m) => m && m.ok === true && (!m.closed || !m.watertight)).length;
            if (bad > 0) warning = `${bad} body/bodies are not watertight — the exported ${format.toUpperCase()} may need repair in your slicer.`;
        }
    } catch {
        // Pre-flight is best-effort; a measure failure must not block export.
    }

    if (i.componentId) {
        const note = 'componentId was provided but the exporter emits the whole document; the file contains all bodies.';
        warning = warning ? `${warning} ${note}` : note;
    }

    // Trigger the real export. downloadDocumentAs falls back to returning the
    // payload (no DOM) so it's safe headless; it returns { ok, filename, ... }.
    try {
        const r = await downloadDocumentAs(format);
        if (!r || r.ok === false) {
            return { ok: false, format, error: (r && r.error) || 'export failed', warning };
        }
        const out = { ok: true, format, filename: r.filename || null };
        if (warning) out.warning = warning;
        return out;
    } catch (e) {
        return { ...fail(e), format, warning };
    }
}

// ── Tool 2b: export_parts (per-component STL + orientation) ───────────────────
//
// export_for_print emits the WHOLE document as one blob. For an assembly you
// print part-by-part: each printed component as its OWN STL, oriented for the
// bed. We reuse the single-export kernel path (exportDocumentAs) per component
// by handing it a sub-document scoped to that component's subtree — same emit,
// same kernel render+STL, just a filtered feature set. Loop components, export
// each, return a manifest.

/** Components that own at least one enabled body-emitting feature. */
function printableComponents(doc) {
    const features = (doc && doc.features) || {};
    const components = (doc && doc.components) || {};
    const owners = new Set();
    for (const fid of Object.keys(features)) {
        const f = features[fid];
        if (f && f.enabled !== false && BODY_EMITTING.has(f.type)) owners.add(f.componentId || 'root');
    }
    const out = [];
    for (const cid of owners) {
        const c = components[cid];
        out.push({ id: cid, name: (c && c.name) || (cid === 'root' ? 'Document' : cid) });
    }
    return out;
}

/**
 * Build a shallow sub-document containing ONLY the features owned by `componentId`
 * (and its descendant components, so a parent part still exports its children).
 * The exporter bakes component placement from the tree, so we keep the full
 * `components` map — only the feature set is narrowed. Returns a doc the exporter
 * accepts via `exportDocumentAs(fmt, { doc })`.
 */
function subDocForComponent(doc, componentId) {
    const descendants = componentDescendants(doc, componentId).map((c) => c.id);
    const keep = new Set([componentId, ...descendants]);
    const features = {};
    const order = (doc.featureOrder && doc.featureOrder.length)
        ? doc.featureOrder
        : Object.keys(doc.features || {});
    const subOrder = [];
    for (const fid of order) {
        const f = (doc.features || {})[fid];
        if (!f) continue;
        if (keep.has(f.componentId || 'root')) {
            features[fid] = f;
            subOrder.push(fid);
        }
    }
    return {
        ...doc,
        features,
        featureOrder: subOrder,
        // Scope joints/connectors away so the exporter doesn't try to mate across
        // components that aren't in this slice (best-effort; absent → empty).
        joints: {},
    };
}

/** Pick a print orientation from a body's bbox: lay the largest face on the bed. */
function suggestOrientation(size) {
    if (!Array.isArray(size) || size.length < 3 || !size.every(Number.isFinite)) {
        return { layFlatAxis: null, note: 'Could not measure the bounding box — orient the largest flat face down manually.' };
    }
    const [sx, sy, sz] = size;
    // The bed-down axis is the SHORTEST one (lay flat → minimise height, maximise
    // bed contact). Z already up means no rotation if Z is already shortest.
    const axes = [['X', sx], ['Y', sy], ['Z', sz]];
    axes.sort((a, b) => a[1] - b[1]);
    const shortest = axes[0][0];
    const tallest = axes[2][0];
    let note;
    if (shortest === 'Z') note = 'Already oriented well: shortest dimension is vertical (good bed contact, low height).';
    else note = `Rotate so the ${shortest} axis points up (it is the thinnest) to lay the largest face on the bed and cut print height.`;
    return {
        layFlatAxis: shortest,
        tallestAxis: tallest,
        sizeMm: { x: round(sx), y: round(sy), z: round(sz) },
        note,
    };
}

/**
 * Export EACH printed component as its own STL (not one whole-model blob), with
 * a suggested print orientation per part. Returns a manifest:
 *   [{ componentId, name, filename, orientation, withinBed, needsSplit, ... }]
 * Reuses the single-export kernel path (exportDocumentAs) once per component.
 * Triggers a browser download per part when in a DOM; headless it returns the
 * manifest (and base64 bytes) for the caller. Never throws.
 */
async function exportParts(input) {
    const i = input || {};
    const bed = {
        x: num(i.bedX, DEFAULT_BED.x),
        y: num(i.bedY, DEFAULT_BED.y),
        z: num(i.bedZ, DEFAULT_BED.z),
    };
    const doc = liveDoc();
    const comps = printableComponents(doc);
    if (!comps.length) {
        return { ok: true, parts: [], note: 'No components own any printable bodies — nothing to export.' };
    }

    const wantDownload = i.download !== false; // default: trigger downloads
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const parts = [];

    for (const comp of comps) {
        const slug = String(comp.name || comp.id).replace(/[^a-z0-9_-]+/gi, '_').replace(/^_+|_+$/g, '') || comp.id;
        const filename = `${slug}.stl`;
        const entry = { componentId: comp.id, name: comp.name, filename, withinBed: null, needsSplit: false };

        // Per-part orientation + bed fit from the component's body bbox(es).
        try {
            const ids = bodyIds(doc, comp.id);
            if (ids.length) {
                const res = await measure(ids.map((id) => ({ type: 'bbox', featureId: id })));
                const list = Array.isArray(res) ? res : [res];
                let amin = [Infinity, Infinity, Infinity];
                let amax = [-Infinity, -Infinity, -Infinity];
                let saw = false;
                for (const b of list) {
                    if (b && b.ok === true && Array.isArray(b.min) && Array.isArray(b.max)) {
                        saw = true;
                        for (let a = 0; a < 3; a++) { amin[a] = Math.min(amin[a], b.min[a]); amax[a] = Math.max(amax[a], b.max[a]); }
                    }
                }
                if (saw) {
                    const size = [amax[0] - amin[0], amax[1] - amin[1], amax[2] - amin[2]];
                    entry.orientation = suggestOrientation(size);
                    // withinBed: the part's footprint must fit the bed in SOME
                    // orientation. Sort dims; two smallest are the footprint.
                    const sorted = size.slice().sort((a, b) => a - b);
                    const fitsFlat = sorted[0] <= bed.z && sorted[1] <= Math.max(bed.x, bed.y) && sorted[2] <= Math.max(bed.x, bed.y);
                    entry.withinBed = fitsFlat;
                    entry.needsSplit = !fitsFlat;
                } else {
                    entry.orientation = suggestOrientation(null);
                }
            } else {
                entry.orientation = suggestOrientation(null);
            }
        } catch {
            entry.orientation = suggestOrientation(null);
        }

        // The actual per-part export — reuse the single-export kernel path on a
        // sub-document scoped to this component's subtree.
        try {
            const subDoc = subDocForComponent(doc, comp.id);
            const r = await exportDocumentAs('stl', { doc: subDoc, filename });
            if (!r || r.ok === false) {
                entry.exported = false;
                entry.error = (r && r.error) || 'export failed';
            } else {
                entry.exported = true;
                entry.filename = r.filename || filename;
                // Trigger a browser download per part when we can (best-effort).
                if (wantDownload && typeof document !== 'undefined' && typeof URL !== 'undefined' && typeof Blob !== 'undefined' && r.bytes) {
                    try {
                        const blob = new Blob([r.bytes], { type: r.mime || 'model/stl' });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url; a.download = r.filename || filename;
                        document.body.appendChild(a); a.click(); document.body.removeChild(a);
                        setTimeout(() => URL.revokeObjectURL(url), 1000);
                    } catch { /* download is best-effort */ }
                }
            }
        } catch (e) {
            entry.exported = false;
            entry.error = fail(e).error;
        }

        parts.push(entry);
    }

    const failed = parts.filter((p) => p.exported === false).length;
    const split = parts.filter((p) => p.needsSplit).length;
    const notes = [];
    if (failed) notes.push(`${failed} part(s) failed to export — see their error fields.`);
    if (split) notes.push(`${split} part(s) exceed the ${bed.x}×${bed.y}×${bed.z}mm bed and need splitting.`);
    notes.push('Each part is exported as its own STL with a suggested bed orientation; slice each separately.');

    return {
        ok: true,
        parts,
        bedMm: bed,
        exportedAt: stamp,
        note: notes.join(' '),
    };
}

// ── Tool 3: recommend_material (pure data) ────────────────────────────────────

const MATERIALS = {
    PLA:    { name: 'PLA',     glassTempC: 55,  warpRisk: 'very low', traits: 'easy to print, rigid, biodegradable, low cost; brittle and softens in heat/sun',  geometryAdjustments: ['no enclosure needed', 'sharp overhangs print well'] },
    PETG:   { name: 'PETG',    glassTempC: 80,  warpRisk: 'low',      traits: 'tough, impact-resistant, mild heat resistance, food-safe-ish; can string',          geometryAdjustments: ['add 0.05-0.1mm extra clearance (slightly oozy)', 'dry filament to reduce stringing'] },
    ABS:    { name: 'ABS',     glassTempC: 100, warpRisk: 'high',     traits: 'strong, heat-resistant, machinable; warps badly, fumes, needs enclosure',          geometryAdjustments: ['add a brim/raft', 'avoid large flat bases', 'enclosure required'] },
    ASA:    { name: 'ASA',     glassTempC: 100, warpRisk: 'high',     traits: 'ABS-like but UV-stable for outdoor use; warps, needs enclosure',                    geometryAdjustments: ['brim/raft + enclosure', 'best choice for sun/weather exposure'] },
    TPU:    { name: 'TPU',     glassTempC: 60,  warpRisk: 'low',      traits: 'flexible/rubbery, abrasion-resistant; slow to print, needs direct drive',          geometryAdjustments: ['print slowly', 'avoid steep overhangs', 'thicken thin flexible walls'] },
    Nylon:  { name: 'Nylon (PA)', glassTempC: 70, warpRisk: 'high',   traits: 'very tough, low-friction, chemical-resistant; absorbs moisture, warps',            geometryAdjustments: ['dry filament thoroughly', 'enclosure + adhesion aids', 'glue-stick/garolite bed'] },
    'PA-CF':{ name: 'PA-CF (carbon-filled nylon)', glassTempC: 90, warpRisk: 'medium', traits: 'stiff, dimensionally stable, structural; abrasive (hardened nozzle), absorbs moisture', geometryAdjustments: ['hardened steel nozzle required', 'dry filament', 'enclosure recommended'] },
};

/**
 * Map an intent string + optional must-haves to a recommended filament. Pure
 * keyword reasoning over the table above — no kernel. Always returns a pick
 * (defaults to PLA) plus alternatives and the consequences of the choice.
 */
function recommendMaterial(input) {
    const i = input || {};
    const intent = String(i.intent || '').toLowerCase();
    const must = (Array.isArray(i.mustHave) ? i.mustHave : []).map((m) => String(m).toLowerCase());
    const hay = intent + ' ' + must.join(' ');

    const has = (...words) => words.some((w) => hay.includes(w));

    let pickKey = 'PLA';
    let why = 'Default pick: PLA is the easiest, cheapest, most accurate filament for indoor, low-stress parts.';

    if (has('flex', 'rubber', 'bendy', 'elastic', 'gasket', 'seal', 'grip', 'tire', 'tyre')) {
        pickKey = 'TPU';
        why = 'Flexible/elastomeric requirement → TPU is the rubbery, abrasion-resistant choice.';
    } else if (has('outdoor', 'uv', 'sun', 'weather', 'garden', 'exterior')) {
        pickKey = 'ASA';
        why = 'Outdoor/UV exposure → ASA is UV-stable and weather-resistant (ABS would yellow and crack).';
    } else if (has('hot', 'heat', 'engine', 'car', 'dashboard', 'automotive', 'boiling', 'oven', 'warm')) {
        pickKey = 'PETG';
        why = 'Elevated-temperature use → PETG (Tg ~80°C) handles warm environments; step up to ASA/ABS (~100°C) if it must survive a hot car dashboard.';
    } else if (has('structural', 'load', 'strong', 'gear', 'bracket', 'mount', 'mechanical', 'functional', 'tough', 'impact')) {
        pickKey = 'PETG';
        why = 'Structural/load-bearing → PETG is tough and impact-resistant; for high stiffness or fatigue, prefer Nylon or PA-CF.';
        if (has('stiff', 'rigid', 'precision', 'high load', 'high-load', 'fatigue', 'carbon')) {
            pickKey = 'PA-CF';
            why = 'High-stiffness structural part → PA-CF (carbon-filled nylon) is dimensionally stable and strong; needs a hardened nozzle and dry filament.';
        }
    }

    const m = MATERIALS[pickKey];
    // Alternatives: a couple of sensible neighbours, never echoing the pick.
    const altOrder = pickKey === 'TPU'
        ? ['PETG', 'PLA']
        : pickKey === 'ASA'
            ? ['ABS', 'PETG']
            : pickKey === 'PA-CF'
                ? ['Nylon', 'PETG']
                : pickKey === 'PETG'
                    ? ['PLA', 'ABS', 'Nylon']
                    : ['PETG', 'ABS'];
    const alternatives = altOrder
        .filter((k) => k !== pickKey)
        .map((k) => ({ material: MATERIALS[k].name, when: MATERIALS[k].traits }))
        .slice(0, 3);

    return {
        ok: true,
        pick: m.name,
        why,
        estimateOnly: true,
        note: 'Material guidance is a rule-of-thumb lookup, not a validated engineering spec — confirm against your printer and datasheet.',
        alternatives,
        consequences: {
            glassTempC: m.glassTempC,
            warpRisk: m.warpRisk,
            geometryAdjustments: m.geometryAdjustments,
        },
    };
}

// ── Tool 4: compute_clearance (pure data) ─────────────────────────────────────
//
// Per-side clearance tables in mm. Diametral = 2× per-side (for round mating
// features). Press fits are reported as a NEGATIVE per-side value (interference).

const CLEARANCE = {
    fdm: {
        clearance:    { perSide: 0.4,  note: 'General clearance fit — parts move freely. ~0.8mm diametral on holes.' },
        slide:        { perSide: 0.4,  note: 'Sliding fit (drawer/rail). ~0.8mm diametral; tune ±0.1mm per printer.' },
        press:        { perSide: -0.15, note: 'Press/interference fit — hole 0.1-0.2mm SMALLER than the pin. Reported negative = interference.' },
        printInPlace: { perSide: 0.2,  note: 'Print-in-place joint gap ~0.3-0.5mm total between moving faces so layers don\'t fuse.' },
        snapDetent:   { perSide: 0.15, note: 'Snap/detent feature — ~0.15mm so it clicks without seizing.' },
    },
    sla: {
        clearance:    { perSide: 0.2,  note: 'SLA clearance fit — resin is finer; ~0.2mm/side.' },
        slide:        { perSide: 0.2,  note: 'SLA sliding fit ~0.2mm/side.' },
        press:        { perSide: -0.08, note: 'SLA press fit — ~0.08mm interference (resin is less forgiving than FDM).' },
        printInPlace: { perSide: 0.15, note: 'SLA print-in-place gap ~0.15-0.3mm; account for uncured resin trapping.' },
        snapDetent:   { perSide: 0.1,  note: 'SLA snap/detent ~0.1mm.' },
    },
    sls: {
        clearance:    { perSide: 0.3,  note: 'SLS clearance fit ~0.3mm/side (powder fusion).' },
        slide:        { perSide: 0.3,  note: 'SLS sliding fit ~0.3mm/side.' },
        press:        { perSide: -0.1, note: 'SLS press fit ~0.1mm interference.' },
        printInPlace: { perSide: 0.3,  note: 'SLS print-in-place gap ~0.3-0.5mm; leave a powder-escape path.' },
        snapDetent:   { perSide: 0.15, note: 'SLS snap/detent ~0.15mm.' },
    },
};

function computeClearance(input) {
    const i = input || {};
    const process = (CLEARANCE[i.process] ? i.process : 'fdm');
    const fit = String(i.fit || '');
    const row = CLEARANCE[process][fit];
    if (!row) {
        return { ok: false, error: `unknown fit '${i.fit}' — use clearance | slide | press | printInPlace | snapDetent` };
    }
    const perSideMm = row.perSide;
    return {
        ok: true,
        fit,
        process,
        perSideMm,
        diametralMm: round(perSideMm * 2),
        estimateOnly: true,
        note: row.note + ' Estimate — calibrate with a tolerance test print for your machine.',
    };
}

// ── Tool 5: estimate_print (kernel volume + data density) ─────────────────────

const DENSITY = { PLA: 1.24, PETG: 1.27, ABS: 1.04, ASA: 1.07, TPU: 1.21, Nylon: 1.14, 'PA-CF': 1.16 };

/**
 * Rough mass + time estimate. Mass = summed solid volume (kernel, mm³) → cm³ ×
 * filament density × an infill-adjusted solid fraction. Time is a deliberately
 * coarse proxy from the deposited volume — NOT a slicer simulation.
 */
async function estimatePrint(input) {
    const i = input || {};
    const layerHeightMm = num(i.layerHeightMm, 0.2);
    const infillPct = Math.max(0, Math.min(100, num(i.infillPct, 15)));
    const matKey = DENSITY[i.material] ? i.material : 'PLA';
    const density = DENSITY[matKey];

    const doc = liveDoc();
    const ids = bodyIds(doc, i.componentId);
    if (ids.length === 0) {
        return { ok: false, error: 'no solid bodies to estimate' };
    }

    let volMm3 = 0;
    let measured = 0;
    try {
        const res = await measure(ids.map((id) => ({ type: 'volume', featureId: id })));
        const list = Array.isArray(res) ? res : [res];
        for (const v of list) {
            if (v && v.ok === true && typeof v.volume === 'number' && Number.isFinite(v.volume)) {
                volMm3 += v.volume;
                measured++;
            }
        }
    } catch (e) {
        return { ...fail(e) };
    }
    if (measured === 0) {
        return { ok: false, error: 'kernel returned no usable volumes — recompile (Ctrl+S) and retry' };
    }

    // Solid fraction: walls/top/bottom print near-solid, the interior at the
    // infill ratio. Crude blend: ~35% of the body behaves as solid perimeter,
    // the rest scales with infill. Clearly an estimate.
    const solidShellFraction = 0.35;
    const solidFraction = solidShellFraction + (1 - solidShellFraction) * (infillPct / 100);

    const volCm3 = volMm3 / 1000;
    const massG = round(volCm3 * density * solidFraction);

    // Deposited filament volume (cm³) → very rough time proxy. Assume a typical
    // FDM volumetric flow of ~5 mm³/s of deposited plastic; finer layers print
    // slower per unit volume, so scale inversely with layer height vs 0.2mm.
    const depositedMm3 = volMm3 * solidFraction;
    const flowMm3PerS = 5 * (layerHeightMm / 0.2);
    const seconds = depositedMm3 / Math.max(flowMm3PerS, 0.5);
    const timeHours = round(seconds / 3600);

    return {
        ok: true,
        material: matKey,
        massG,
        bodiesMeasured: measured,
        volumeCm3: round(volCm3),
        solidFractionUsed: round(solidFraction),
        timeHoursEstimate: timeHours,
        estimateOnly: true,
        note: `ESTIMATE ONLY. Mass ≈ ${round(volCm3)}cm³ × ${density}g/cm³ × ${round(solidFraction)} solid-fraction (from ${infillPct}% infill). Time is a coarse flow-rate proxy, not a slicer simulation — slice the STL for real numbers.`,
    };
}

// ── Tool definitions ──────────────────────────────────────────────────────────

export const DFM_TOOLS = [
    {
        name: 'check_printability',
        description: 'Verify the current part is 3D-printable and return a red/yellow/green verdict. Uses the kernel: watertight (manifold) check per body, bounding boxes for an estimated wall-thickness floor, and the document invariants. RED = not watertight or below the process minimum wall. YELLOW = thin-but-printable, warp-prone flat base, or larger than the build volume. GREEN = looks printable. Call this before export_for_print.',
        input_schema: {
            type: 'object',
            properties: {
                process: S('Print process', { enum: ['fdm', 'sla', 'sls'] }),
                material: S('Intended filament/resin (informational)'),
                nozzleMm: N('FDM nozzle diameter in mm (default 0.4); sets the minimum wall ≈ 2× nozzle'),
            },
        },
        handler: (i) => checkPrintability(i),
    },
    {
        name: 'export_for_print',
        description: 'Export the document to a printable file: STL (slicer-ready mesh) or STEP (editable solid). Runs a watertightness pre-flight first and includes a warning if any body is not manifold (the export still proceeds). Triggers a browser download.',
        input_schema: {
            type: 'object',
            properties: {
                format: S('Output format', { enum: ['stl', 'step'] }),
                componentId: S('Component to export (advisory — the whole document is exported)'),
            },
            required: ['format'],
        },
        handler: (i) => exportForPrint(i),
    },
    {
        name: 'export_parts',
        description:
            'Export an ASSEMBLY for printing PART-BY-PART: each printed component as its OWN STL (not one whole-model blob), with a suggested print orientation per part. This is the S9 per-part export — you print an assembly one part at a time, each oriented for the bed. Loops every component that owns geometry, exports each to its own STL via the kernel, and returns a manifest [{ componentId, name, filename, orientation, withinBed, needsSplit }]. A part whose smallest footprint still overflows the bed is flagged needsSplit. Use this instead of export_for_print once a model has multiple components. Triggers a download per part in the browser.',
        input_schema: {
            type: 'object',
            properties: {
                bedX: N('Printer bed X size in mm (default 220).'),
                bedY: N('Printer bed Y size in mm (default 220).'),
                bedZ: N('Printer max build height in mm (default 250).'),
                download: B('Trigger a browser download per part (default true). Set false to only return the manifest.'),
            },
        },
        handler: (i) => exportParts(i),
    },
    {
        name: 'recommend_material',
        description: 'Recommend a 3D-printing filament from a description of how the part will be used. Pure guidance (no geometry): reasons from keywords like outdoor/UV, hot/automotive, flexible, or structural. Returns the pick, why, alternatives, and the consequences (glass temp, warp risk, geometry adjustments needed).',
        input_schema: {
            type: 'object',
            properties: {
                intent: S('How the part will be used (e.g. "outdoor bracket exposed to sun", "flexible phone bumper", "structural gear")'),
                mustHave: { type: 'array', items: { type: 'string' }, description: 'Hard requirements (e.g. ["UV-stable", "food-safe", "flexible"])' },
            },
            required: ['intent'],
        },
        handler: (i) => recommendMaterial(i),
    },
    {
        name: 'compute_clearance',
        description: 'Look up the recommended gap (mm) between two mating 3D-printed features for a given fit type and process. Returns per-side and diametral values. press fits report a NEGATIVE per-side value (interference). Use this to size holes/pins, drawer slides, print-in-place joints, and snap detents. Pure data — calibrate with a test print.',
        input_schema: {
            type: 'object',
            properties: {
                fit: S('Fit type', { enum: ['clearance', 'slide', 'press', 'printInPlace', 'snapDetent'] }),
                process: S('Print process', { enum: ['fdm', 'sla', 'sls'] }),
                nominalMm: N('Nominal feature size in mm (informational — clearances here are absolute, not percentage-scaled)'),
            },
            required: ['fit'],
        },
        handler: (i) => computeClearance(i),
    },
    {
        name: 'estimate_print',
        description: 'Rough filament mass (grams) and a coarse print-time estimate for the current part. Sums body volumes from the kernel, then applies filament density and an infill-adjusted solid fraction. ESTIMATE ONLY — slice the exported STL for accurate numbers.',
        input_schema: {
            type: 'object',
            properties: {
                componentId: S('Component to estimate (advisory — defaults to the whole document)'),
                layerHeightMm: N('Layer height in mm (default 0.2)'),
                infillPct: N('Infill percentage 0-100 (default 15)'),
                material: S('Filament', { enum: ['PLA', 'PETG', 'ABS', 'ASA', 'TPU', 'Nylon', 'PA-CF'] }),
            },
        },
        handler: (i) => estimatePrint(i),
    },
];
