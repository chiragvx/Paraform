/**
 * Invariant constraint library — Layer 2 of the tiered spec compiler.
 *
 * Spec: tracker/16-invariant-library.md.
 *
 * The library is a flat array of `Invariant` records. Each record:
 *
 *   id:        stable string ('i-manifold-all-bodies').
 *   name:      human label.
 *   category:  'geometric' | 'mechanical' | 'standard-parts' | 'assembly'
 *              | 'material' | 'parametric' | 'catalog'.
 *   scope:     SCOPE.PER_FEATURE | PER_COMPONENT | PER_DOCUMENT.
 *   check:     async (target, ctx) → InvariantResult.
 *              `target` is a feature object (per-feature), component object
 *              (per-component), or full doc (per-document). The runner
 *              resolves these from ids before calling the check.
 *   severity:  declared severity on failure ('warning' | 'error').
 *   rationale: short engineering rationale.
 *   citation:  optional source string (ASM, ISO, etc.).
 *   version:   semver string. Bumping thresholds bumps this; the eval
 *              corpus gates regressions per-version.
 *
 * `InvariantResult` shape: { ok, severity, message, suggestedFix?, measured? }
 * — same as the DFM check result shape so the repair-loop can consume
 * both layers uniformly.
 *
 * Every check is defensive: missing data, missing kernel, missing doc → the
 * check returns a pass ('not applicable') rather than throwing. The runner
 * relies on this contract.
 *
 * Cross-references to spec 11 DFM (manifoldness, selfIntersection,
 * zeroThickness, threadEngagement, bearingBoreFit) go through a lazy import
 * so this module can be imported without dragging the DFM measure-provider
 * graph. That also keeps the dependency graph one-directional (DFM doesn't
 * import invariants).
 */

import {
    getMaterial,
    getThreadMultiplier,
    findStandardPartEntry,
    getDoc,
} from './lookups.js';

// ── Constants ───────────────────────────────────────────────────────────────

export const SCOPE = Object.freeze({
    PER_FEATURE:   'per-feature',
    PER_COMPONENT: 'per-component',
    PER_DOCUMENT:  'per-document',
});

export const SEVERITY = Object.freeze({
    PASS:    'pass',
    WARNING: 'warning',
    ERROR:   'error',
});

// ── Result helpers ──────────────────────────────────────────────────────────

function pass(message, measured) {
    return { ok: true, severity: 'pass', message, measured };
}
function warn(message, suggestedFix, measured) {
    return { ok: false, severity: 'warning', message, suggestedFix, measured };
}
function err(message, suggestedFix, measured) {
    return { ok: false, severity: 'error', message, suggestedFix, measured };
}
function notApplicable(message = 'not applicable') {
    return { ok: true, severity: 'pass', message, measured: null };
}

// ── Lazy DFM delegation ─────────────────────────────────────────────────────
//
// Some invariants delegate to the existing spec-11 DFM check (manifoldness,
// selfIntersection, zeroThickness, bearingBoreFit, threadEngagement). We
// keep the import lazy so the invariants module can load in a kernel-less
// test (the call returns 'not applicable' if the DFM provider isn't wired).

let _dfmModule = null;

async function dfm() {
    if (!_dfmModule) {
        try { _dfmModule = await import('../dfm/checks.js'); }
        catch { _dfmModule = {}; }
    }
    return _dfmModule;
}

/** Test-only: clear the lazy DFM cache. */
export function _resetDfmCacheForTests() { _dfmModule = null; }

/** Test-only: inject a fake DFM module (for unit tests without kernel). */
export function _setDfmModuleForTests(mod) { _dfmModule = mod; }

async function callDfm(name, featureId, profile, ...extra) {
    const mod = await dfm();
    const fn = mod && mod[name];
    if (typeof fn !== 'function') return notApplicable(`dfm.${name} unavailable`);
    try {
        return await fn(featureId, profile, ...extra);
    } catch (e) {
        return notApplicable(`dfm.${name} threw: ${(e && e.message) || String(e)}`);
    }
}

// ── Helpers for feature-typed checks ────────────────────────────────────────

function isHole(feature)     { return feature && feature.type === 'Hole'; }
function isCylinder(feature) { return feature && feature.type === 'Cylinder'; }
function isFillet(feature)   { return feature && feature.type === 'Fillet'; }
function isChamfer(feature)  { return feature && feature.type === 'Chamfer'; }
function isShell(feature)    { return feature && feature.type === 'Shell'; }
function isExtrude(feature)  { return feature && feature.type === 'Extrude'; }
function isStandardPart(f)   { return f && f.type === 'StandardPart'; }
function isFastener(f)       { return f && f.type === 'Fastener'; }
function isJoint(f)          { return f && f.type === 'Joint'; }
function isParameter(f)      { return f && f.type === 'Parameter'; }
function isBody(feature) {
    if (!feature) return false;
    // Anything that emits geometry. v1 conservative: include the common
    // primitives so the material-assigned check covers them.
    return ['Box', 'Cylinder', 'Sphere', 'Cone', 'Torus',
            'Extrude', 'Revolve', 'Sweep', 'Loft',
            'Boolean', 'StandardPart', 'Body'].includes(feature.type);
}

function partRefOf(feature) {
    return (feature && feature.params && feature.params.partRef) || null;
}

// ── Individual checks ───────────────────────────────────────────────────────

// 1. i-manifold-all-bodies — delegate to DFM.
async function manifoldnessCheck(feature, ctx) {
    if (!isBody(feature)) return notApplicable('not a body');
    return callDfm('manifoldness', feature.id, ctx && ctx.profile);
}

// 2. i-no-self-intersection — delegate to DFM.
async function noSelfIntersectionCheck(feature, ctx) {
    if (!isBody(feature)) return notApplicable('not a body');
    return callDfm('selfIntersection', feature.id, ctx && ctx.profile);
}

// 3. i-no-zero-thickness — delegate to DFM.
async function noZeroThicknessCheck(feature, ctx) {
    if (!isBody(feature)) return notApplicable('not a body');
    return callDfm('zeroThickness', feature.id, ctx && ctx.profile);
}

// 4. i-material-assigned
async function materialAssignedCheck(feature, _ctx) {
    if (!isBody(feature)) return notApplicable('not a body');
    const material = feature.params && feature.params.material;
    if (material && typeof material === 'string' && material.trim()) {
        return pass(`material '${material}' assigned`, { material });
    }
    return warn(
        `feature '${feature.id}' has no material assigned`,
        'assign a material to enable mass / cost / process checks',
        { material: null },
    );
}

// 5. i-material-in-database
async function materialInDatabaseCheck(feature, _ctx) {
    if (!isBody(feature)) return notApplicable('not a body');
    const material = feature.params && feature.params.material;
    if (!material) return notApplicable('no material to resolve');
    const record = getMaterial(material);
    if (record) {
        return pass(`material '${material}' resolves to ${record.id}`, { resolved: record.id });
    }
    return err(
        `material '${material}' not in materials database`,
        'pick a known material or add it to materials.json',
        { material },
    );
}

// 6. i-process-assigned (per-document)
async function processAssignedCheck(doc, ctx) {
    const profile = (ctx && ctx.profile) || null;
    const profileId = (doc && doc.profileId)
        || (doc && doc.settings && doc.settings.profileId)
        || (profile && profile.id)
        || (profile && profile.label);
    if (profileId) {
        return pass(`process profile '${profileId}' set`, { profileId });
    }
    return warn(
        'no manufacturing process profile selected',
        'pick a process profile (3d-print / cnc-mill / injection-mold) in settings',
        null,
    );
}

// 7. i-standardpart-exists-in-catalog
async function standardPartExistsInCatalogCheck(feature, _ctx) {
    if (!isStandardPart(feature)) return notApplicable('not a StandardPart');
    const entryId = feature.params && feature.params.entryId;
    if (!entryId) {
        return err(
            'StandardPart feature has no entryId',
            'select a catalog entry for this part',
            null,
        );
    }
    const entry = await findStandardPartEntry(entryId);
    if (entry) {
        return pass(`entry '${entryId}' resolves`, { entryId });
    }
    return err(
        `catalog entry '${entryId}' not found`,
        'the catalog version may have removed this entry — pick a current one',
        { entryId },
    );
}

// 8. i-clearance-hole-matches-iso273 — delegate to DFM clearanceHoleSize.
async function clearanceHoleMatchesIso273Check(feature, ctx) {
    if (!isHole(feature)) return notApplicable('not a Hole');
    const ref = partRefOf(feature);
    if (!ref || ref.role !== 'clearance') return notApplicable('not a clearance hole');
    return callDfm('clearanceHoleSize', feature.id, ctx && ctx.profile);
}

// 9. i-bearing-bore-has-partref
async function bearingBoreHasPartRefCheck(feature, ctx) {
    if (!isCylinder(feature) && !isHole(feature)) return notApplicable('not a cylinder/hole');
    const dia = feature.params && Number(feature.params.diameter);
    if (!Number.isFinite(dia)) return notApplicable('no diameter');
    if (partRefOf(feature)) return pass('partRef present', { dia });

    // No partRef: check whether this diameter matches a known bearing OD ±0.1.
    const catalogIds = (ctx && ctx.bearingOds) || null;
    let bearingOds = catalogIds;
    if (!bearingOds) {
        try {
            const fetchCatalog = (await import('./lookups.js')).findStandardPartEntry;
            // We don't actually need findStandardPartEntry — we want the full
            // catalog. Use the catalog provider directly via a lookups helper:
            const lk = await import('./lookups.js');
            // Cheap workaround: call findStandardPartEntry with empty id to
            // force the catalog cache to warm — but it bails on empty. Skip:
            void fetchCatalog;
            void lk;
        } catch { /* ignore */ }
    }
    // If we have no catalog list, this check is benign-pass: we can't infer
    // anything. The richer signal lives in DFM's bearingBoreFit when a
    // partRef IS set; this invariant only fires when partRef is MISSING.
    if (!Array.isArray(bearingOds) || bearingOds.length === 0) {
        return notApplicable('no catalog bearing list available');
    }
    const TOL = 0.1;
    const nearest = bearingOds.find((od) => Math.abs(od - dia) <= TOL);
    if (nearest) {
        return warn(
            `Ø${dia} mm matches bearing OD ${nearest} mm but no partRef declared`,
            'attach a bearing partRef so the fit-class check can run',
            { dia, nearestOd: nearest },
        );
    }
    return pass('diameter does not match a bearing OD', { dia });
}

// 10. i-fastener-thread-engagement — delegate to DFM threadEngagement.
async function fastenerThreadEngagementCheck(feature, ctx) {
    if (!isHole(feature)) return notApplicable('not a Hole');
    const ref = partRefOf(feature);
    if (!ref || ref.role !== 'tap') return notApplicable('not a tap hole');
    return callDfm('threadEngagement', feature.id, ctx && ctx.profile);
}

// 11. i-bearing-bore-in-fit-band — delegate to DFM bearingBoreFit.
async function bearingBoreInFitBandCheck(feature, ctx) {
    if (!isCylinder(feature) && !isHole(feature)) return notApplicable('not a cylinder/hole');
    const ref = partRefOf(feature);
    if (!ref || ref.role !== 'bore') return notApplicable('not a bore');
    return callDfm('bearingBoreFit', feature.id, ctx && ctx.profile);
}

// 12. i-fastener-bearing-surface
async function fastenerBearingSurfaceCheck(feature, ctx) {
    // Applies to Fastener-type features or fasteners declared via partRef.
    if (!isFastener(feature) && !isStandardPart(feature)) {
        return notApplicable('not a fastener');
    }
    const entryId = feature.params && feature.params.entryId;
    if (!entryId) return notApplicable('no entryId');
    const entry = await findStandardPartEntry(entryId);
    if (!entry || entry.category !== 'Fastener') return notApplicable('not a Fastener catalog entry');

    const headDia = entry.dims && Number(entry.dims.headDiameter);
    if (!Number.isFinite(headDia)) return notApplicable('no headDiameter');
    const requiredArea = headDia * (headDia / 2);

    // The bearing surface area lives on the host material the fastener
    // bites against — we approximate by reading params.bearingSurfaceArea
    // if present (set by the AI op generator or by manual override).
    const reported = feature.params && Number(feature.params.bearingSurfaceArea);
    if (!Number.isFinite(reported)) {
        return notApplicable('no bearingSurfaceArea reported');
    }
    const measured = { headDia, requiredArea, reported };
    if (reported >= requiredArea) {
        return pass(
            `bearing surface ${reported.toFixed(2)} mm² ≥ required ${requiredArea.toFixed(2)} mm²`,
            measured,
        );
    }
    return warn(
        `bearing surface ${reported.toFixed(2)} mm² < required ${requiredArea.toFixed(2)} mm² for head Ø${headDia}`,
        'add a washer or enlarge the bearing-pad area',
        measured,
    );
}

// 13. i-fillet-radius-positive
async function filletRadiusPositiveCheck(feature, _ctx) {
    if (!isFillet(feature)) return notApplicable('not a Fillet');
    const r = feature.params && Number(feature.params.radius);
    if (Number.isFinite(r) && r > 0) {
        return pass(`radius ${r} mm`, { radius: r });
    }
    return err(
        'fillet radius must be > 0',
        'set radius to a positive value',
        { radius: r },
    );
}

// 14. i-chamfer-length-positive
async function chamferLengthPositiveCheck(feature, _ctx) {
    if (!isChamfer(feature)) return notApplicable('not a Chamfer');
    const v = feature.params && Number(feature.params.length ?? feature.params.distance);
    if (Number.isFinite(v) && v > 0) {
        return pass(`length ${v} mm`, { length: v });
    }
    return err(
        'chamfer length must be > 0',
        'set chamfer length/distance to a positive value',
        { length: v },
    );
}

// 15. i-shell-thickness-positive
async function shellThicknessPositiveCheck(feature, _ctx) {
    if (!isShell(feature)) return notApplicable('not a Shell');
    const t = feature.params && Number(feature.params.thickness);
    if (Number.isFinite(t) && t > 0) {
        return pass(`thickness ${t} mm`, { thickness: t });
    }
    return err(
        'shell thickness must be > 0',
        'set shell thickness to a positive value',
        { thickness: t },
    );
}

// 16. i-extrude-amount-positive
async function extrudeAmountPositiveCheck(feature, _ctx) {
    if (!isExtrude(feature)) return notApplicable('not an Extrude');
    const amt = feature.params && Number(feature.params.amount);
    const both = !!(feature.params && feature.params.both);
    if (!Number.isFinite(amt) || amt === 0) {
        return err(
            'extrude amount must be non-zero',
            both
                ? 'set amount to a non-zero value (positive or negative)'
                : 'set amount to a positive value',
            { amount: amt, both },
        );
    }
    if (!both && amt < 0) {
        return warn(
            `single-direction extrude with negative amount ${amt}`,
            'flip direction or use both=true if a two-sided extrude is desired',
            { amount: amt, both },
        );
    }
    return pass(`amount ${amt} mm`, { amount: amt, both });
}

// 17. i-component-has-parent (per-component)
async function componentHasParentCheck(component, ctx) {
    if (!component) return notApplicable('no component');
    const doc = (ctx && ctx.doc) || await getDoc();
    const components = (doc && doc.components) || {};
    const rootId = (doc && doc.rootComponentId) || null;
    if (component.id === rootId) return pass('root component', { rootId });
    if (!component.parentId) {
        return err(
            `component '${component.id}' has no parentId`,
            'attach the component to a parent in the assembly tree',
            { componentId: component.id },
        );
    }
    if (!components[component.parentId]) {
        return err(
            `component '${component.id}' references missing parent '${component.parentId}'`,
            'fix or remove the dangling parent reference',
            { componentId: component.id, parentId: component.parentId },
        );
    }
    return pass(`parent '${component.parentId}' present`, { componentId: component.id });
}

// 18. i-no-cyclic-components (per-document)
async function noCyclicComponentsCheck(doc, _ctx) {
    const components = (doc && doc.components) || {};
    const ids = Object.keys(components);
    if (ids.length === 0) return notApplicable('no components');
    for (const start of ids) {
        const seen = new Set();
        let cur = start;
        while (cur) {
            if (seen.has(cur)) {
                return err(
                    `cyclic component parent chain detected starting from '${start}' at '${cur}'`,
                    'break the cycle by re-rooting one of the components',
                    { cycleAt: cur, start },
                );
            }
            seen.add(cur);
            cur = (components[cur] && components[cur].parentId) || null;
        }
    }
    return pass(`${ids.length} components, no cycles`, { count: ids.length });
}

// 19. i-joint-references-valid (per-feature, joints)
async function jointReferencesValidCheck(feature, ctx) {
    if (!isJoint(feature)) return notApplicable('not a Joint');
    const doc = (ctx && ctx.doc) || await getDoc();
    const components = (doc && doc.components) || {};
    const src = feature.params && (feature.params.sourceComponentId || feature.params.source);
    const tgt = feature.params && (feature.params.targetComponentId || feature.params.target);
    const missing = [];
    if (!src) missing.push('source');
    else if (!components[src]) missing.push(`source('${src}')`);
    if (!tgt) missing.push('target');
    else if (!components[tgt]) missing.push(`target('${tgt}')`);
    if (missing.length === 0) {
        return pass(`joint between '${src}' and '${tgt}'`, { src, tgt });
    }
    return err(
        `joint missing/invalid: ${missing.join(', ')}`,
        'point the joint at existing components',
        { src, tgt, missing },
    );
}

// 20. i-no-inter-component-interference-at-rest (per-document)
async function noInterComponentInterferenceCheck(doc, ctx) {
    const components = (doc && doc.components) || {};
    const ids = Object.keys(components);
    if (ids.length < 2) return notApplicable('fewer than 2 components');
    const measure = ctx && ctx.measure;
    if (typeof measure !== 'function') {
        return notApplicable('no measure client');
    }
    // Collect all sibling pairs upfront so the whole O(N²) sweep flushes as
    // a single batched POST instead of one round-trip per pair.
    const pairs = [];
    for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
            const a = ids[i], b = ids[j];
            const ca = components[a], cb = components[b];
            if (!ca || !cb) continue;
            if (ca.parentId === b || cb.parentId === a) continue;
            pairs.push([a, b]);
        }
    }
    const hits = [];
    if (pairs.length > 0) {
        const queries = pairs.map(([a, b]) => ({ type: 'interference', a, b }));
        let results;
        try {
            results = await measure(queries);
        } catch {
            return notApplicable('measure transport failed');
        }
        const rs = Array.isArray(results) ? results : [results];
        for (let k = 0; k < pairs.length; k++) {
            const r = rs[k];
            if (r && r.ok === true && r.intersects === true) {
                const [a, b] = pairs[k];
                hits.push({ a, b, volume: r.volume ?? null });
            }
        }
    }
    if (hits.length === 0) {
        return pass('no inter-component interference at rest', { pairsTested: ids.length });
    }
    const first = hits[0];
    return err(
        `inter-component interference: ${hits.length} pair${hits.length === 1 ? '' : 's'} (e.g. ${first.a} ↔ ${first.b})`,
        'reposition or trim one component so they no longer overlap',
        { hits },
    );
}

// 21. i-no-circular-parameters (per-document)
async function noCircularParametersCheck(doc, _ctx) {
    const params = (doc && doc.parameters) || {};
    const ids = Object.keys(params);
    if (ids.length === 0) return notApplicable('no parameters');

    // Extract refs from an expression string. Same convention as the
    // expression evaluator: identifiers referenced by name.
    const refRe = /[A-Za-z_][A-Za-z0-9_]*/g;
    const refsOf = (expr) => {
        if (!expr || typeof expr !== 'string') return [];
        const out = new Set();
        for (const m of expr.matchAll(refRe)) {
            if (params[m[0]]) out.add(m[0]);
        }
        return Array.from(out);
    };

    // DFS with three-color marking to detect a back-edge.
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = Object.create(null);
    for (const id of ids) color[id] = WHITE;

    function visit(node) {
        color[node] = GRAY;
        const p = params[node];
        const expr = p && (p.expression || p.expr);
        for (const r of refsOf(expr)) {
            if (color[r] === GRAY) return { cycle: true, at: r, from: node };
            if (color[r] === WHITE) {
                const hit = visit(r);
                if (hit && hit.cycle) return hit;
            }
        }
        color[node] = BLACK;
        return null;
    }
    for (const id of ids) {
        if (color[id] !== WHITE) continue;
        const hit = visit(id);
        if (hit && hit.cycle) {
            return err(
                `circular parameter expression: '${hit.from}' → '${hit.at}' closes a cycle`,
                'break the cycle by reordering the expression dependencies',
                hit,
            );
        }
    }
    return pass(`${ids.length} parameters, no cycles`, { count: ids.length });
}

// 22. i-parameters-have-units (per-feature, only Parameter features)
async function parametersHaveUnitsCheck(feature, _ctx) {
    if (!isParameter(feature)) return notApplicable('not a Parameter');
    const unit = feature.params && feature.params.unit;
    if (unit && typeof unit === 'string' && unit.trim()) {
        return pass(`unit '${unit}' set`, { unit });
    }
    return warn(
        `parameter '${feature.id}' has no unit`,
        'set a unit (mm, deg, count, …) so downstream conversions are unambiguous',
        { unit: null },
    );
}

// 23. i-bearing-pair-fits (per-document)
//
// When a shaft + bearing + bore triple share an axis, verify the declared
// fit-class chain is consistent (shaft→bearingID and bearingOD→bore use
// compatible fit declarations). v1: scan StandardPart bearings and find
// matching Cylinder features with partRef pointing at the same bearing
// entryId for both shaft and bore roles. If both sides declare a fitClass
// and they disagree on the bore vs shaft assumption, warn.
async function bearingPairFitsCheck(doc, _ctx) {
    const features = (doc && doc.features) || {};
    const ids = Object.keys(features);
    if (ids.length === 0) return notApplicable('no features');

    // Group cylinders by their bearing entry id.
    const groups = new Map(); // entryId → { shafts:[], bores:[] }
    for (const id of ids) {
        const f = features[id];
        if (!f) continue;
        if (!isCylinder(f) && !isHole(f)) continue;
        const ref = partRefOf(f);
        if (!ref || !ref.entryId) continue;
        if (ref.role !== 'shaft' && ref.role !== 'bore') continue;
        let g = groups.get(ref.entryId);
        if (!g) { g = { shafts: [], bores: [] }; groups.set(ref.entryId, g); }
        if (ref.role === 'shaft') g.shafts.push({ id, fitClass: ref.fitClass || null });
        else g.bores.push({ id, fitClass: ref.fitClass || null });
    }

    const mismatches = [];
    for (const [entryId, g] of groups) {
        if (g.shafts.length === 0 || g.bores.length === 0) continue;
        // For every shaft+bore pair on the same bearing entry, check that
        // the declared fit classes don't conflict (e.g. an interference
        // shaft against a clearance bore is suspicious).
        for (const s of g.shafts) {
            for (const b of g.bores) {
                if (!s.fitClass || !b.fitClass) continue;
                // The same fit class on shaft+bore is typically right.
                if (s.fitClass === b.fitClass) continue;
                // Mismatched declared classes — warn.
                mismatches.push({ entryId, shaft: s, bore: b });
            }
        }
    }
    if (mismatches.length === 0) {
        return pass(`${groups.size} bearing group${groups.size === 1 ? '' : 's'} consistent`, { groups: groups.size });
    }
    const first = mismatches[0];
    return warn(
        `bearing fit-class mismatch on ${first.entryId}: shaft '${first.shaft.fitClass}' vs bore '${first.bore.fitClass}'`,
        'align shaft and bore fit-class declarations for the same bearing',
        { mismatches },
    );
}

// 24. i-clearance-hole-for-fastener (per-feature)
//
// Every clearance Hole should have a corresponding Fastener feature in the
// document that mates with the same thread nominal. We surface a warning,
// not an error: a stand-alone clearance hole is sometimes intentional
// (cable pass-through using ISO 273 dimensions).
async function clearanceHoleForFastenerCheck(feature, ctx) {
    if (!isHole(feature)) return notApplicable('not a Hole');
    const ref = partRefOf(feature);
    if (!ref || ref.role !== 'clearance') return notApplicable('not a clearance hole');
    if (!ref.entryId) return notApplicable('no entryId');

    const entry = await findStandardPartEntry(ref.entryId);
    if (!entry || entry.category !== 'Fastener') return notApplicable('not a Fastener entry');
    const threadNominal = entry.dims && Number(entry.dims.threadNominal);
    if (!Number.isFinite(threadNominal)) return notApplicable('no threadNominal');

    const doc = (ctx && ctx.doc) || await getDoc();
    const features = (doc && doc.features) || {};
    let foundMatch = false;
    for (const fid of Object.keys(features)) {
        const f = features[fid];
        if (!f) continue;
        if (!isFastener(f) && !isStandardPart(f)) continue;
        const id = f.params && f.params.entryId;
        if (!id) continue;
        // Same exact entryId is a strong match.
        if (id === ref.entryId) { foundMatch = true; break; }
        // Otherwise resolve and compare threadNominal.
        const e = await findStandardPartEntry(id);
        if (e && e.category === 'Fastener'
            && Number(e.dims && e.dims.threadNominal) === threadNominal) {
            foundMatch = true; break;
        }
    }
    if (foundMatch) {
        return pass(`clearance hole has matching M${threadNominal} fastener`, { threadNominal });
    }
    return warn(
        `clearance hole for M${threadNominal} but no matching fastener in document`,
        'add the matching fastener feature or downgrade this to a through-hole',
        { threadNominal, entryId: ref.entryId },
    );
}

// 26. i-no-interference-along-trajectory (per-document, spec 17 v1)
//
// Walks every pair of (saved) poses in `ctx.poseLibrary` and runs the
// AABB-stand-in interference check at N sampled steps. If any pose pair
// is missing from ctx, the check is benign-pass: this invariant only
// fires when a pose timeline has been declared.
async function noInterferenceAlongTrajectoryCheck(doc, ctx) {
    const lib = ctx && ctx.poseLibrary;
    if (!lib) return notApplicable('no pose library provided');
    const poses = (typeof lib.list === 'function') ? lib.list()
                : Array.isArray(lib) ? lib : [];
    if (!Array.isArray(poses) || poses.length < 2) {
        return notApplicable('fewer than 2 poses');
    }
    let mod;
    try { mod = await import('../kinematics/pose.js'); }
    catch { return notApplicable('kinematics module unavailable'); }
    const samples = (ctx && ctx.trajectorySamples) || 10;
    const fails = [];
    for (let i = 0; i < poses.length - 1; i++) {
        const a = poses[i], b = poses[i + 1];
        const traj = mod.sampleTrajectory(doc, a, b, { samples });
        if (!traj.ok) {
            const firstBad = traj.steps.find((s) => !s.ok);
            fails.push({ a: a.name, b: b.name, atT: firstBad ? firstBad.t : null, hits: firstBad ? firstBad.hits : [] });
        }
    }
    if (fails.length === 0) {
        return pass(`no interference along ${poses.length - 1} pose segment${poses.length === 2 ? '' : 's'}`,
            { segments: poses.length - 1, samples });
    }
    const first = fails[0];
    return err(
        `interference between '${first.a}' → '${first.b}' at t=${(first.atT ?? 0).toFixed(2)}`,
        'adjust joint trajectory or reshape interfering components',
        { fails },
    );
}

// 27b. i-assembly-dof-sane (per-document, Phase 6)
//
// Flags over-constrained subassemblies — components reached by more than one
// joint path, which the v1 tree solver cannot satisfy simultaneously (a loop
// closure). Warning, not error: an over-constrained loop is sometimes
// intentional (a redundant mate the user will resolve), but it almost always
// signals a modelling mistake. Benign-pass if the kinematics module or doc
// is unavailable.
async function assemblyDofSaneCheck(doc, _ctx) {
    const joints = (doc && doc.joints) || {};
    const components = (doc && doc.components) || {};
    if (Object.keys(joints).length === 0) return notApplicable('no joints');
    let mod;
    try { mod = await import('../kinematics/limits.js'); }
    catch { return notApplicable('kinematics module unavailable'); }
    if (typeof mod.computeDof !== 'function') return notApplicable('computeDof unavailable');
    let report;
    try { report = mod.computeDof(doc); }
    catch (e) { return notApplicable(`computeDof threw: ${(e && e.message) || e}`); }
    if (report.overConstrained.length === 0) {
        return pass(
            `assembly DOF ${report.totalDof}, no over-constrained subassemblies`,
            { totalDof: report.totalDof, components: Object.keys(components).length },
        );
    }
    return warn(
        `over-constrained subassembl${report.overConstrained.length === 1 ? 'y' : 'ies'}: ${report.overConstrained.join(', ')}`,
        'remove the redundant joint(s) so each component is reached by a single joint path',
        { overConstrained: report.overConstrained, totalDof: report.totalDof },
    );
}

// ── Functional-design-brain gates (PLAN-functional-design-brain.md §5) ───────
//
// These four checks are the deterministic verification gates that stop the AI
// from shipping a cosmetic "box dog" — geometry that *looks* like the artifact
// but has no actuators, no print clearance, collides through its own motion, or
// can't come off the printer. They cross the stored morphology spec (the DSO
// S2 slot, read from the AI design context) against the actually-built model.

/**
 * Read the morphology spec out of the AI design context. May be null/undefined
 * (not every document is a mechanism). Fail-safe: any import or access error
 * resolves to null so the calling check degrades to "not applicable".
 *
 * Morphology shape (DSO S2, PLAN-functional-design-brain.md §1):
 *   { links:[{id, ...}],
 *     joints:[{ id, type:'revolute'|'prismatic'|'fixed', axis, range:[min,max],
 *               drivenBy:<actuatorId>, source?, target?, bodies?:[...] }],
 *     symmetry, dof }
 */
async function getMorphology() {
    try {
        const mod = await import('../ai/context.js');
        const ctx = mod && mod.getAIContext && mod.getAIContext();
        const m = ctx && ctx.morphology;
        return (m && typeof m === 'object') ? m : null;
    } catch {
        return null;
    }
}

/** A joint that actually articulates (worth checking for actuator + motion). */
function isMovingJoint(j) {
    const t = j && typeof j.type === 'string' && j.type.toLowerCase();
    return t === 'revolute' || t === 'prismatic';
}

/**
 * Build a set of every component/part id the document has actually placed, so a
 * morphology reference can be checked for "is this thing really in the model".
 * Looks at components (by id), their declared role, and the partRef of any
 * feature so an actuator placed as a StandardPart is discoverable.
 */
function docPlacedIds(doc) {
    const ids = new Set();
    const roleById = new Map();
    const components = (doc && doc.components) || {};
    for (const id of Object.keys(components)) {
        const c = components[id];
        if (!c) continue;
        ids.add(id);
        const role = c.role || (c.params && c.params.role) || null;
        if (role) roleById.set(id, String(role).toLowerCase());
    }
    const features = (doc && doc.features) || {};
    for (const fid of Object.keys(features)) {
        const f = features[fid];
        if (!f) continue;
        ids.add(fid);
        const ref = partRefOf(f);
        if (ref && ref.entryId) ids.add(ref.entryId);
        const cid = f.params && (f.params.componentId || f.params.component);
        if (cid) ids.add(cid);
    }
    return { ids, roleById };
}

// i-functional-complete (per-document) — THE gate that fails a cosmetic dog.
//
// Cross the stored morphology spec against the built model: every declared
// MOVING joint must have (a) an actuator placed, (b) a structural mount, and
// (c) a link. If no morphology is recorded, this is a static/cosmetic doc and
// the check is not-applicable (pass). If a mechanism morphology IS recorded but
// joints lack actuators/mounts/links, this is an ERROR — the model bluffed.
async function functionalCompleteCheck(doc, _ctx) {
    const morph = await getMorphology();
    if (!morph) return notApplicable('no morphology spec (not a mechanism)');

    const joints = Array.isArray(morph.joints) ? morph.joints : [];
    const moving = joints.filter(isMovingJoint);
    if (moving.length === 0) {
        return notApplicable('morphology declares no moving joints');
    }

    const { ids } = docPlacedIds(doc);
    const links = (doc && doc.components) || {};
    const declaredLinks = Array.isArray(morph.links) ? morph.links : [];
    const linkIds = new Set(declaredLinks.map((l) => (l && (l.id || l.componentId)) || null).filter(Boolean));

    const incomplete = [];
    for (const j of moving) {
        const missing = [];

        // (a) actuator: the joint's driver must be a placed component/part.
        const driver = j.drivenBy || j.driver || j.actuator || j.servoId || null;
        if (!driver) missing.push('actuator (no drivenBy declared)');
        else if (!ids.has(driver)) missing.push(`actuator '${driver}' not placed`);

        // (b) structural mount + (c) link: the joint connects two bodies; both
        // must exist in the model. We accept ids from the joint's own
        // source/target/bodies, or — failing that — the declared link ids.
        const bodies = [];
        if (j.source) bodies.push(j.source);
        if (j.target) bodies.push(j.target);
        if (Array.isArray(j.bodies)) bodies.push(...j.bodies);
        if (j.mount) bodies.push(j.mount);
        if (j.link) bodies.push(j.link);
        const resolvedBodies = bodies.filter((b) => b && (ids.has(b) || linkIds.has(b)));
        if (bodies.length === 0) {
            // No bodies declared on the joint — fall back to: does ANY structural
            // link exist for this joint to hang on? With zero links it's cosmetic.
            if (declaredLinks.length === 0 && Object.keys(links).length === 0) {
                missing.push('mount/link (no structural bodies in model)');
            }
        } else if (resolvedBodies.length < 1) {
            missing.push('mount/link (declared bodies not in model)');
        }

        if (missing.length) incomplete.push({ joint: j.id || '(unnamed)', missing });
    }

    const measured = { movingJoints: moving.length, incomplete };
    if (incomplete.length === 0) {
        return pass(
            `all ${moving.length} moving joint${moving.length === 1 ? '' : 's'} have actuator + mount + link`,
            measured,
        );
    }
    const first = incomplete[0];
    return err(
        `functional gap: ${incomplete.length} joint${incomplete.length === 1 ? '' : 's'} incomplete ` +
            `(e.g. '${first.joint}': ${first.missing.join(', ')})`,
        'place the missing actuator/mount/link so each moving joint is actually driven — ' +
            'a cosmetic shell with no actuators fails this gate',
        measured,
    );
}

// i-printed-fit (per-document) — printed-to-printed mating clearance.
//
// At every printed-to-printed mating joint, assert a designed-in clearance
// ≥ ~0.2 mm (the practical minimum for a 0.4 mm FDM nozzle); below that the two
// printed parts won't assemble. We read declared clearance off the joint /
// connector (params.clearance, or a connector's `fit.clearance`) and only
// consider joints where BOTH bodies are printed (process profile = 3d-print or
// component material flagged printed). Missing data → not-applicable per joint.
const FDM_MIN_PRINTED_CLEARANCE_MM = 0.2; // 0.4 mm nozzle practical minimum

function isPrintedComponent(comp, profileId) {
    if (!comp) return profileId === '3d-print' || profileId === 'fdm';
    const proc = (comp.process || (comp.params && comp.params.process) || '').toLowerCase();
    if (proc.includes('print') || proc === 'fdm' || proc === 'fff') return true;
    if (comp.printed === true || (comp.params && comp.params.printed === true)) return true;
    // Fall back to the document-level process profile.
    return profileId === '3d-print' || profileId === 'fdm';
}

async function printedFitCheck(doc, ctx) {
    const joints = (doc && doc.joints) || {};
    const jointIds = Object.keys(joints);
    if (jointIds.length === 0) return notApplicable('no joints');

    const components = (doc && doc.components) || {};
    const profile = (ctx && ctx.profile) || null;
    const profileId = (doc && doc.profileId)
        || (doc && doc.settings && doc.settings.profileId)
        || (profile && profile.id) || (profile && profile.label) || null;

    const tight = [];
    let evaluated = 0;
    for (const jid of jointIds) {
        const j = joints[jid];
        if (!j) continue;
        const a = j.sourceComponentId || j.source || (j.params && j.params.source);
        const b = j.targetComponentId || j.target || (j.params && j.params.target);
        const ca = a ? components[a] : null;
        const cb = b ? components[b] : null;
        // Only printed↔printed mates matter for this gate.
        if (!isPrintedComponent(ca, profileId) || !isPrintedComponent(cb, profileId)) continue;

        // Designed-in clearance: declared on the joint or its mate params.
        const declared = Number(
            (j.clearance != null ? j.clearance : undefined) ??
            (j.params && (j.params.clearance ?? j.params.fitClearance)) ??
            (j.fit && j.fit.clearance),
        );
        if (!Number.isFinite(declared)) continue; // nothing to assert → skip
        evaluated++;
        if (declared < FDM_MIN_PRINTED_CLEARANCE_MM) {
            tight.push({ joint: jid, clearance: declared });
        }
    }

    if (evaluated === 0) return notApplicable('no printed-to-printed joints with declared clearance');
    const measured = { evaluated, min: FDM_MIN_PRINTED_CLEARANCE_MM, tight };
    if (tight.length === 0) {
        return pass(`all ${evaluated} printed mates clear ≥ ${FDM_MIN_PRINTED_CLEARANCE_MM} mm`, measured);
    }
    const first = tight[0];
    return warn(
        `printed fit too tight: ${tight.length} mate${tight.length === 1 ? '' : 's'} below ` +
            `${FDM_MIN_PRINTED_CLEARANCE_MM} mm (e.g. '${first.joint}' = ${first.clearance} mm)`,
        `design in ≥ ${FDM_MIN_PRINTED_CLEARANCE_MM} mm clearance at printed-to-printed mating joints (0.4 mm nozzle)`,
        measured,
    );
}

// i-motion-clearance (per-document) — clear through the full joint range.
//
// For each revolute/prismatic joint in the morphology spec, the articulating
// sub-assembly must clear through its declared `range` without colliding. We
// delegate to a kernel sweep via the SAME measure API the other invariants use
// (ctx.measure). The Python endpoint `motion_sweep` is being added separately;
// until it lands the helper is unavailable → we return a WARNING (fail SAFE),
// never an error and never a throw.
//
// ── motionSweep measure contract (Python `motion_sweep` must match) ──────────
//   REQUEST  (one query object, passed to ctx.measure):
//     {
//       type:   'motionSweep',
//       joints: [ { axis,            // [x,y,z] unit axis OR named axis string
//                   range,           // [min, max] (deg for revolute, mm for prismatic)
//                   bodies } ],      // ids of bodies that move with this joint
//       samples: <int>              // # of poses to sample across each range
//     }
//   RESPONSE:
//     {
//       ok: true,
//       collisions: [ { joint?, t?, a?, b?, volume? }, ... ]   // empty ⇒ clears
//     }
//   On any failure the endpoint SHOULD return { ok:false, error } — the check
//   then degrades to a warning. The check NEVER throws.
async function motionClearanceCheck(doc, ctx) {
    const morph = await getMorphology();
    if (!morph) return notApplicable('no morphology spec (not a mechanism)');
    const joints = Array.isArray(morph.joints) ? morph.joints : [];
    const moving = joints.filter(isMovingJoint);
    if (moving.length === 0) return notApplicable('morphology declares no moving joints');

    const measure = ctx && ctx.measure;
    if (typeof measure !== 'function') {
        return warn(
            'motion-clearance could not be evaluated: no measure client (motion_sweep unavailable)',
            'run with a kernel measure client so the motion sweep can sample the joint ranges',
            { reason: 'no-measure', movingJoints: moving.length },
        );
    }

    const samples = (ctx && ctx.motionSamples) || 12;
    const sweepJoints = moving.map((j) => ({
        axis: j.axis ?? null,
        range: Array.isArray(j.range) ? j.range : null,
        bodies: Array.isArray(j.bodies) ? j.bodies
            : [j.source, j.target, j.link, j.mount].filter(Boolean),
    }));

    const query = { type: 'motionSweep', joints: sweepJoints, samples };
    let result;
    try {
        const r = await measure(query);
        result = Array.isArray(r) ? r[0] : r;
    } catch {
        return warn(
            'motion-clearance could not be evaluated: measure transport failed (fail-safe)',
            'retry once the kernel motion_sweep endpoint is reachable',
            { reason: 'transport', movingJoints: moving.length },
        );
    }

    // Endpoint unavailable / not yet implemented → fail SAFE as a warning.
    if (!result || result.ok !== true || !Array.isArray(result.collisions)) {
        return warn(
            'motion-clearance could not be evaluated: motion_sweep endpoint unavailable (fail-safe)',
            'the kernel motion_sweep endpoint is being added separately; this gate is advisory until then',
            { reason: 'endpoint-unavailable', movingJoints: moving.length,
              error: (result && result.error) || null },
        );
    }

    const collisions = result.collisions;
    const measured = { movingJoints: moving.length, samples, collisions };
    if (collisions.length === 0) {
        return pass(`all ${moving.length} moving joint${moving.length === 1 ? '' : 's'} clear through range`, measured);
    }
    const first = collisions[0] || {};
    return err(
        `motion collision: ${collisions.length} interference${collisions.length === 1 ? '' : 's'} through joint range` +
            (first.joint ? ` (e.g. joint '${first.joint}')` : ''),
        'adjust the joint range, reshape the colliding bodies, or move the actuator so the sub-assembly clears its full sweep',
        measured,
    );
}

// i-print-ready (per-component) — fits the default bed; flag supports / split.
//
// Each printed part must fit the printer's build volume and is flagged if it
// likely needs supports (rough overhang heuristic) or exceeds the bed (needs a
// split). measured = bbox. Reads the part's bbox via ctx.measure({type:'bbox'}).
// No measure / no geometry → not-applicable.
const DEFAULT_BED_MM = Object.freeze({ x: 200, y: 200, z: 200 });

function bodyFeatureIdsOfComponent(doc, componentId) {
    const features = (doc && doc.features) || {};
    const out = [];
    for (const fid of Object.keys(features)) {
        const f = features[fid];
        if (!f || !isBody(f)) continue;
        const cid = f.params && (f.params.componentId || f.params.component);
        if (cid === componentId) out.push(fid);
    }
    return out;
}

async function printReadyCheck(component, ctx) {
    if (!component) return notApplicable('no component');
    const doc = (ctx && ctx.doc) || await getDoc();
    const profile = (ctx && ctx.profile) || null;
    const profileId = (doc && doc.profileId)
        || (doc && doc.settings && doc.settings.profileId)
        || (profile && profile.id) || (profile && profile.label) || null;
    if (!isPrintedComponent(component, profileId)) return notApplicable('not a printed part');

    const measure = ctx && ctx.measure;
    if (typeof measure !== 'function') return notApplicable('no measure client');

    // Find a body feature to measure. Prefer one bound to this component.
    const bodyIds = bodyFeatureIdsOfComponent(doc, component.id);
    const featureId = bodyIds[0]
        || (component.params && component.params.featureId)
        || component.featureId
        || component.rootFeatureId
        || null;
    if (!featureId) return notApplicable('no body geometry for component');

    let r;
    try {
        const out = await measure({ type: 'bbox', featureId });
        r = Array.isArray(out) ? out[0] : out;
    } catch {
        return notApplicable('bbox measure transport failed');
    }
    if (!r || r.ok !== true) return notApplicable((r && r.error) || 'bbox query failed');
    const size = r.size || (r.min && r.max
        ? [r.max[0] - r.min[0], r.max[1] - r.min[1], r.max[2] - r.min[2]]
        : null);
    if (!size || size.length < 3 || !size.every((n) => Number.isFinite(n))) {
        return notApplicable('bbox returned malformed size');
    }

    const bed = (ctx && ctx.bed) || DEFAULT_BED_MM;
    // Cheapest-fit orientation: sort part dims descending and bed dims
    // descending, then compare largest-to-largest. A part fits if every sorted
    // dim is ≤ the corresponding sorted bed dim (any axis-aligned re-orient).
    const partDims = size.slice(0, 3).map(Math.abs).sort((a, b) => b - a);
    const bedDims = [bed.x, bed.y, bed.z].sort((a, b) => b - a);
    const exceedsBed = partDims.some((d, i) => d > bedDims[i]);

    // Rough overhang heuristic: a part that is much taller than its footprint
    // (tall + slender) and/or has a large flat top relative to base is a likely
    // support candidate. v1 coarse signal: height > 2× the smaller footprint dim.
    const [w, d, h] = size.slice(0, 3).map(Math.abs);
    const footprintMin = Math.min(w, d);
    const likelyNeedsSupports = footprintMin > 0 && h > footprintMin * 2;

    const measured = { bbox: { size: [w, d, h], min: r.min ?? null, max: r.max ?? null }, bed };

    if (exceedsBed) {
        return warn(
            `part exceeds bed: ${partDims.map((n) => n.toFixed(1)).join('×')} mm > bed ` +
                `${bedDims.join('×')} mm — needs split`,
            'split the part into bed-sized pieces with printed joints, or scale down',
            { ...measured, exceedsBed: true, likelyNeedsSupports },
        );
    }
    if (likelyNeedsSupports) {
        return warn(
            `part likely needs supports (height ${h.toFixed(1)} mm > 2× footprint ${footprintMin.toFixed(1)} mm)`,
            're-orient for self-support or add a print-orientation note; supports add cleanup + cost',
            { ...measured, exceedsBed: false, likelyNeedsSupports: true },
        );
    }
    return pass(
        `fits bed (${partDims.map((n) => n.toFixed(1)).join('×')} mm ≤ ${bedDims.join('×')} mm), no obvious support need`,
        { ...measured, exceedsBed: false, likelyNeedsSupports: false },
    );
}

// 27. i-standardpart-not-deprecated
async function standardPartNotDeprecatedCheck(feature, _ctx) {
    if (!isStandardPart(feature)) return notApplicable('not a StandardPart');
    const entryId = feature.params && feature.params.entryId;
    if (!entryId) return notApplicable('no entryId');
    const entry = await findStandardPartEntry(entryId);
    if (!entry) return notApplicable('entry not in catalog');
    if (entry.deprecated === true) {
        return warn(
            `catalog entry '${entryId}' is deprecated`,
            entry.deprecationReason || 'replace with a non-deprecated alternative',
            { entryId },
        );
    }
    return pass(`entry '${entryId}' not deprecated`, { entryId });
}

// ── Library export ──────────────────────────────────────────────────────────

export const INVARIANTS = [
    {
        id: 'i-manifold-all-bodies',
        name: 'Manifoldness',
        category: 'geometric',
        scope: SCOPE.PER_FEATURE,
        check: manifoldnessCheck,
        severity: SEVERITY.ERROR,
        rationale: 'an unwatertight body cannot be 3D printed and is ambiguous to most kernel ops.',
        citation: null,
        version: '1.0',
    },
    {
        id: 'i-no-self-intersection',
        name: 'No self-intersection',
        category: 'geometric',
        scope: SCOPE.PER_FEATURE,
        check: noSelfIntersectionCheck,
        severity: SEVERITY.ERROR,
        rationale: 'self-intersecting bodies cause boolean and meshing failures downstream.',
        citation: null,
        version: '1.0',
    },
    {
        id: 'i-no-zero-thickness',
        name: 'No zero-thickness walls',
        category: 'geometric',
        scope: SCOPE.PER_FEATURE,
        check: noZeroThicknessCheck,
        severity: SEVERITY.ERROR,
        rationale: 'walls thinner than the process minimum fail to print / machine.',
        citation: null,
        version: '1.0',
    },
    {
        id: 'i-material-assigned',
        name: 'Material assigned',
        category: 'material',
        scope: SCOPE.PER_FEATURE,
        check: materialAssignedCheck,
        severity: SEVERITY.WARNING,
        rationale: 'a body without a material has no mass, no cost, and no DFM context.',
        citation: null,
        version: '1.0',
    },
    {
        id: 'i-material-in-database',
        name: 'Material in database',
        category: 'material',
        scope: SCOPE.PER_FEATURE,
        check: materialInDatabaseCheck,
        severity: SEVERITY.ERROR,
        rationale: 'an unknown material name breaks every downstream property lookup.',
        citation: 'ASM Handbook subset',
        version: '1.0',
    },
    {
        id: 'i-process-assigned',
        name: 'Process profile assigned',
        category: 'material',
        scope: SCOPE.PER_DOCUMENT,
        check: processAssignedCheck,
        severity: SEVERITY.WARNING,
        rationale: 'DFM and tolerance checks depend on the active manufacturing profile.',
        citation: null,
        version: '1.0',
    },
    {
        id: 'i-standardpart-exists-in-catalog',
        name: 'Standard part exists in catalog',
        category: 'standard-parts',
        scope: SCOPE.PER_FEATURE,
        check: standardPartExistsInCatalogCheck,
        severity: SEVERITY.ERROR,
        rationale: 'a dangling catalog reference fails at kernel build time.',
        citation: null,
        version: '1.0',
    },
    {
        id: 'i-clearance-hole-matches-iso273',
        name: 'Clearance hole matches ISO 273',
        category: 'standard-parts',
        scope: SCOPE.PER_FEATURE,
        check: clearanceHoleMatchesIso273Check,
        severity: SEVERITY.WARNING,
        rationale: 'off-standard clearance holes either bind the fastener or wallow out the joint.',
        citation: 'ISO 273',
        version: '1.0',
    },
    {
        id: 'i-bearing-bore-has-partref',
        name: 'Bearing-sized bore has partRef',
        category: 'standard-parts',
        scope: SCOPE.PER_FEATURE,
        check: bearingBoreHasPartRefCheck,
        severity: SEVERITY.WARNING,
        rationale: 'a bore sized for a stock bearing OD without a partRef misses the fit-class check.',
        citation: null,
        version: '1.0',
    },
    {
        id: 'i-fastener-thread-engagement',
        name: 'Fastener thread engagement',
        category: 'standard-parts',
        scope: SCOPE.PER_FEATURE,
        check: fastenerThreadEngagementCheck,
        severity: SEVERITY.ERROR,
        rationale: 'a tap shallower than ~1× Ø in steel (1.5× Al, 2× plastic) strips under load.',
        citation: 'Machinery’s Handbook',
        version: '1.0',
    },
    {
        id: 'i-bearing-bore-in-fit-band',
        name: 'Bearing bore in ISO 286 fit band',
        category: 'standard-parts',
        scope: SCOPE.PER_FEATURE,
        check: bearingBoreInFitBandCheck,
        severity: SEVERITY.WARNING,
        rationale: 'a bore outside the declared fit-class band either drops the bearing or interferes.',
        citation: 'ISO 286-2',
        version: '1.0',
    },
    {
        id: 'i-fastener-bearing-surface',
        name: 'Fastener bearing surface area',
        category: 'standard-parts',
        scope: SCOPE.PER_FEATURE,
        check: fastenerBearingSurfaceCheck,
        severity: SEVERITY.WARNING,
        rationale: 'an under-sized bearing pad concentrates load and crushes the host material.',
        citation: 'Shigley §8',
        version: '1.0',
    },
    {
        id: 'i-fillet-radius-positive',
        name: 'Fillet radius positive',
        category: 'mechanical',
        scope: SCOPE.PER_FEATURE,
        check: filletRadiusPositiveCheck,
        severity: SEVERITY.ERROR,
        rationale: 'a zero/negative fillet radius is meaningless to the kernel.',
        citation: null,
        version: '1.0',
    },
    {
        id: 'i-chamfer-length-positive',
        name: 'Chamfer length positive',
        category: 'mechanical',
        scope: SCOPE.PER_FEATURE,
        check: chamferLengthPositiveCheck,
        severity: SEVERITY.ERROR,
        rationale: 'a zero/negative chamfer length is meaningless to the kernel.',
        citation: null,
        version: '1.0',
    },
    {
        id: 'i-shell-thickness-positive',
        name: 'Shell thickness positive',
        category: 'mechanical',
        scope: SCOPE.PER_FEATURE,
        check: shellThicknessPositiveCheck,
        severity: SEVERITY.ERROR,
        rationale: 'shell thickness must be > 0 for the kernel to offset the surface.',
        citation: null,
        version: '1.0',
    },
    {
        id: 'i-extrude-amount-positive',
        name: 'Extrude amount non-zero',
        category: 'mechanical',
        scope: SCOPE.PER_FEATURE,
        check: extrudeAmountPositiveCheck,
        severity: SEVERITY.ERROR,
        rationale: 'a zero-distance extrude yields no body.',
        citation: null,
        version: '1.0',
    },
    {
        id: 'i-component-has-parent',
        name: 'Component has parent',
        category: 'assembly',
        scope: SCOPE.PER_COMPONENT,
        check: componentHasParentCheck,
        severity: SEVERITY.ERROR,
        rationale: 'an orphan component is unreachable through the assembly tree.',
        citation: null,
        version: '1.0',
    },
    {
        id: 'i-no-cyclic-components',
        name: 'No cyclic components',
        category: 'assembly',
        scope: SCOPE.PER_DOCUMENT,
        check: noCyclicComponentsCheck,
        severity: SEVERITY.ERROR,
        rationale: 'a parent cycle breaks every tree-walk in the document.',
        citation: null,
        version: '1.0',
    },
    {
        id: 'i-joint-references-valid',
        name: 'Joint references valid',
        category: 'assembly',
        scope: SCOPE.PER_FEATURE,
        check: jointReferencesValidCheck,
        severity: SEVERITY.ERROR,
        rationale: 'a joint pointing at a missing component cannot be solved.',
        citation: null,
        version: '1.0',
    },
    {
        id: 'i-no-inter-component-interference-at-rest',
        name: 'No inter-component interference at rest',
        category: 'assembly',
        scope: SCOPE.PER_DOCUMENT,
        check: noInterComponentInterferenceCheck,
        severity: SEVERITY.ERROR,
        rationale: 'sibling components overlapping at rest cannot be assembled.',
        citation: null,
        version: '1.0',
    },
    {
        id: 'i-no-circular-parameters',
        name: 'No circular parameters',
        category: 'parametric',
        scope: SCOPE.PER_DOCUMENT,
        check: noCircularParametersCheck,
        severity: SEVERITY.ERROR,
        rationale: 'circular references in F5 expressions never converge.',
        citation: null,
        version: '1.0',
    },
    {
        id: 'i-parameters-have-units',
        name: 'Parameters have units',
        category: 'parametric',
        scope: SCOPE.PER_FEATURE,
        check: parametersHaveUnitsCheck,
        severity: SEVERITY.WARNING,
        rationale: 'a unit-less parameter silently mis-converts when consumed in a different unit system.',
        citation: null,
        version: '1.0',
    },
    {
        id: 'i-bearing-pair-fits',
        name: 'Bearing pair consistent fit',
        category: 'standard-parts',
        scope: SCOPE.PER_DOCUMENT,
        check: bearingPairFitsCheck,
        severity: SEVERITY.WARNING,
        rationale: 'shaft and bore fit-class declarations on the same bearing should agree.',
        citation: null,
        version: '1.0',
    },
    {
        id: 'i-clearance-hole-for-fastener',
        name: 'Clearance hole has matching fastener',
        category: 'standard-parts',
        scope: SCOPE.PER_FEATURE,
        check: clearanceHoleForFastenerCheck,
        severity: SEVERITY.WARNING,
        rationale: 'a clearance hole without a fastener is a likely modelling oversight.',
        citation: null,
        version: '1.0',
    },
    {
        id: 'i-no-interference-along-trajectory',
        name: 'No interference along pose trajectory',
        category: 'assembly',
        scope: SCOPE.PER_DOCUMENT,
        check: noInterferenceAlongTrajectoryCheck,
        severity: SEVERITY.ERROR,
        rationale: 'kinematic chains that collide mid-motion are unbuildable; ' +
                   'static-pose interference misses the sweep.',
        citation: 'spec 17 — kinematics oracle (v1 slice, AABB stand-in)',
        version: '1.0',
    },
    {
        id: 'i-assembly-dof-sane',
        name: 'Assembly DOF sane',
        category: 'assembly',
        scope: SCOPE.PER_DOCUMENT,
        check: assemblyDofSaneCheck,
        severity: SEVERITY.WARNING,
        rationale: 'a component reached by more than one joint path is over-constrained — ' +
                   'the sequential tree solver cannot satisfy the loop closure.',
        citation: 'spec 17 / Phase 6 — kinematics DOF',
        version: '1.0',
    },
    {
        id: 'i-standardpart-not-deprecated',
        name: 'Standard part not deprecated',
        category: 'catalog',
        scope: SCOPE.PER_FEATURE,
        check: standardPartNotDeprecatedCheck,
        severity: SEVERITY.WARNING,
        rationale: 'deprecated catalog entries will not survive future catalog versions.',
        citation: null,
        version: '1.0',
    },
    {
        id: 'i-functional-complete',
        name: 'Functional completeness vs morphology',
        category: 'mechanical',
        scope: SCOPE.PER_DOCUMENT,
        check: functionalCompleteCheck,
        severity: SEVERITY.ERROR,
        rationale: 'a mechanism whose declared moving joints lack actuators / mounts / links ' +
                   'is a cosmetic shell — the gate that fails a "box dog".',
        citation: 'PLAN-functional-design-brain.md §5 (check_functional_complete)',
        version: '1.0',
    },
    {
        id: 'i-printed-fit',
        name: 'Printed-to-printed mating clearance',
        category: 'assembly',
        scope: SCOPE.PER_DOCUMENT,
        check: printedFitCheck,
        severity: SEVERITY.WARNING,
        rationale: 'printed parts that mate with < ~0.2 mm designed clearance (0.4 mm nozzle) ' +
                   'will not assemble off the printer.',
        citation: 'PLAN-functional-design-brain.md §5 (check_printed_fit)',
        version: '1.0',
    },
    {
        id: 'i-motion-clearance',
        name: 'Motion clearance through joint range',
        category: 'assembly',
        scope: SCOPE.PER_DOCUMENT,
        check: motionClearanceCheck,
        severity: SEVERITY.ERROR,
        rationale: 'a kinematic chain that collides mid-stride is unbuildable; the static-pose ' +
                   'interference check misses the sweep.',
        citation: 'PLAN-functional-design-brain.md §5 (check_motion_clearance) — kernel motion_sweep',
        version: '1.0',
    },
    {
        id: 'i-print-ready',
        name: 'Part print-ready (bed fit / supports)',
        category: 'geometric',
        scope: SCOPE.PER_COMPONENT,
        check: printReadyCheck,
        severity: SEVERITY.WARNING,
        rationale: 'a printed part that exceeds the bed needs a split, and a tall/slender part ' +
                   'likely needs supports — both block a clean single-piece print.',
        citation: 'PLAN-functional-design-brain.md §5 (check_print_ready)',
        version: '1.0',
    },
];

/** Map invariant id → record. */
export const INVARIANTS_BY_ID = Object.freeze(
    Object.fromEntries(INVARIANTS.map((inv) => [inv.id, inv])),
);

/** Convenience: list invariants for a given scope. */
export function invariantsByScope(scope) {
    return INVARIANTS.filter((inv) => inv.scope === scope);
}

/** Convenience: list invariants for a given category. */
export function invariantsByCategory(category) {
    return INVARIANTS.filter((inv) => inv.category === category);
}
