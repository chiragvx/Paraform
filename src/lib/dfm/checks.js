/**
 * DFM check library (spec tracker/11-cheap-dfm.md).
 *
 * Every check is a pure-async function:
 *
 *   check(featureId, profile, ...args) → Promise<CheckResult>
 *
 *   CheckResult = {
 *     ok:           boolean,                       // pass / fail
 *     severity:    'pass' | 'warning' | 'error',
 *     message:      string,                        // human description
 *     suggestedFix?: string,                       // optional remediation hint
 *     measured?:    any,                           // raw measure payload that drove this
 *   }
 *
 * Checks NEVER throw. A kernel/transport failure surfaces as
 * `{ ok: false, severity: 'error', message: 'measurement unavailable' }`.
 *
 * `profile` is the *resolved* profile object from `./profiles.js` (not its id);
 * each check reads its own thresholds off it.
 *
 * Measure provider injection — tests swap the underlying `measure` call via
 * `setMeasureForTests(fn)`. Prod uses the real client from
 * `$lib/measure/api.js`. We lazy-load the prod client so plain Node tests
 * that don't want any kernel dependency at all can run without ever loading
 * `lib/document/index.js` (which pulls in three.js).
 */

import { fitBand, clearanceHoles } from './iso286.js';

// ── Measure provider injection ───────────────────────────────────────────────

let _measureProvider = null;

/**
 * Install a measure provider. Returns the previously-installed provider so
 * callers can save/restore it (the dfm runner does this to scope a
 * DataLoader-style coalescing session to one `runChecks()` invocation
 * without leaking state into tests that may have installed their own fake).
 *
 * Originally test-only — name retained for backward compatibility with
 * existing test call sites.
 */
export function setMeasureForTests(fn) {
    const prev = _measureProvider;
    _measureProvider = fn;
    return prev;
}

/** Revert to the real client (or to whatever provider was previously installed). */
export function resetMeasureForTests() {
    _measureProvider = null;
}

async function callMeasure(query) {
    if (_measureProvider) return _measureProvider(query);
    // Lazy import so tests that never touch the real client don't drag in
    // the kernel bridge / three.js graph.
    const mod = await import('../measure/api.js');
    return mod.measure(query);
}

// ── Feature + catalog provider injection (spec 13) ───────────────────────────
//
// The four relational fit checks need two things the prior 5 checks didn't:
//   - the host feature itself (to read params.partRef + params.diameter etc.),
//   - the standard-parts catalog (to read the mating part's dims).
//
// Both are injected the same way as measure: test-friendly setter, lazy
// import in prod so plain Node tests don't drag the DocumentStore (which
// transitively pulls three.js) or the kernel fetch path.

let _featureProvider = null;
let _catalogProvider = null;

/** Test-only: install a fake `getFeature(featureId) → feature|null`. */
export function setFeatureProviderForTests(fn) {
    _featureProvider = fn;
}

/** Test-only: install a fake `fetchCatalog() → Promise<entry[]>`. */
export function setCatalogProviderForTests(fn) {
    _catalogProvider = fn;
}

/** Test-only: revert both relational providers. */
export function resetRelationalProvidersForTests() {
    _featureProvider = null;
    _catalogProvider = null;
}

async function callGetFeature(featureId) {
    if (_featureProvider) return _featureProvider(featureId);
    const docMod = await import('../../../lib/document/index.js');
    const store = docMod.getDocumentStore();
    const doc = store && store.getState && store.getState();
    if (!doc || !doc.features) return null;
    return doc.features[featureId] || null;
}

async function callFetchCatalog() {
    if (_catalogProvider) return _catalogProvider();
    const mod = await import('../library/standard.js');
    return mod.fetchCatalog();
}

async function lookupCatalogEntry(entryId) {
    if (!entryId) return null;
    try {
        const entries = await callFetchCatalog();
        if (!Array.isArray(entries)) return null;
        return entries.find((e) => e && e.id === entryId) || null;
    } catch {
        return null;
    }
}

// ── Result helpers ───────────────────────────────────────────────────────────

function pass(message, measured) {
    return { ok: true, severity: 'pass', message, measured };
}
function warn(message, suggestedFix, measured) {
    return { ok: false, severity: 'warning', message, suggestedFix, measured };
}
function err(message, suggestedFix, measured) {
    return { ok: false, severity: 'error', message, suggestedFix, measured };
}
function unavailable(reason) {
    return {
        ok: false,
        severity: 'error',
        message: 'measurement unavailable',
        suggestedFix: reason || 'kernel did not respond — try recompiling',
    };
}

/** Wrap an `await callMeasure(...)` in safe error handling. */
async function safeMeasure(query) {
    try {
        const r = await callMeasure(query);
        return { ok: true, result: r };
    } catch (e) {
        return { ok: false, error: (e && e.message) || String(e) };
    }
}

// ── Individual checks ────────────────────────────────────────────────────────

/**
 * Solid is closed & watertight (manifold). Errors otherwise.
 */
export async function manifoldness(featureId, _profile) {
    const m = await safeMeasure({ type: 'manifold', featureId });
    if (!m.ok) return unavailable(m.error);
    const r = m.result;
    if (!r || r.ok !== true) {
        return unavailable((r && r.error) || 'manifold query failed');
    }
    const closed = !!r.closed;
    const watertight = !!r.watertight;
    const openEdgeCount = typeof r.openEdgeCount === 'number' ? r.openEdgeCount
        : typeof r.openEdges === 'number' ? r.openEdges : 0;

    if (closed && watertight) {
        return pass(`solid is manifold (Euler ${r.eulerNumber ?? 'n/a'})`, r);
    }
    const detail = openEdgeCount > 0
        ? `${openEdgeCount} open edge${openEdgeCount === 1 ? '' : 's'}`
        : 'not closed / not watertight';
    return err(
        `non-manifold geometry — ${detail}`,
        'seal the open boundary or stitch faces before exporting',
        r,
    );
}

/**
 * Body does not self-intersect. Errors when any hits are reported.
 */
export async function selfIntersection(featureId, _profile) {
    const m = await safeMeasure({ type: 'selfIntersection', featureId });
    if (!m.ok) return unavailable(m.error);
    const r = m.result;
    if (!r || r.ok !== true) {
        return unavailable((r && r.error) || 'selfIntersection query failed');
    }
    // Server may return either { selfOk, locations } (Phase 2.1 helper shape)
    // or { hits: [...] }. Accept both.
    const hits = Array.isArray(r.hits) ? r.hits
        : Array.isArray(r.locations) ? r.locations
        : [];
    const ok = (r.selfOk === true) || hits.length === 0;
    if (ok) return pass('no self-intersections', r);
    const first = hits[0];
    const where = first && first.point
        ? ` near (${first.point.map((v) => v.toFixed?.(2) ?? v).join(', ')})`
        : '';
    return err(
        `body self-intersects (${hits.length} hit${hits.length === 1 ? '' : 's'})${where}`,
        'check for overlapping extrudes or a flipped face normal',
        r,
    );
}

/**
 * Coarse zero-thickness probe.
 *
 * v1 approximation: if the smallest bbox dimension is below
 * `profile.minWallMm`, surface the body as a zero-thickness candidate.
 * Proper wall-thickness via offset-surface analysis is deferred to a
 * kernel-side `minWallProbe` (see spec — "Out").
 */
export async function zeroThickness(featureId, profile) {
    const threshold = (profile && profile.minWallMm) ?? 0.4;
    const m = await safeMeasure({ type: 'bbox', featureId });
    if (!m.ok) return unavailable(m.error);
    const r = m.result;
    if (!r || r.ok !== true) {
        return unavailable((r && r.error) || 'bbox query failed');
    }
    const size = Array.isArray(r.size) ? r.size : null;
    if (!size || size.length < 3) {
        return unavailable('bbox returned malformed size');
    }
    const minDim = Math.min(...size);
    if (minDim < threshold) {
        return err(
            `feature dimension ${minDim.toFixed(3)} mm below minimum wall ${threshold} mm`,
            `thicken the thinnest direction to at least ${threshold} mm`,
            r,
        );
    }
    return pass(
        `min dimension ${minDim.toFixed(3)} mm ≥ ${threshold} mm`,
        r,
    );
}

/**
 * Wall-thickness heuristic for a Press-Pull face (E3.1).
 *
 * Press-Pull translates a face along its outward normal by `distance` mm
 * (negative = pull inward, thinning the opposite wall). Without an
 * offset-surface kernel probe we can't compute true min-wall after the
 * op — but we can cheaply bound it:
 *
 *   1. Read the bbox.
 *   2. If |distance| would consume more than `smallestDim - 2 × minWallMm`
 *      we predict the resulting wall is below `minWallMm`.
 *
 * Limitations (intentional in v1):
 *   - bbox.smallestDim is a coarse upper bound — for non-cuboid bodies the
 *     thinnest "wall" may be much smaller than the smallest extent.
 *   - We don't know which wall the face faces; the check is symmetric.
 *
 * The real fix is a kernel `minWallProbe` (tracked in 11-cheap-dfm.md "Out").
 *
 * @param {string} featureId  — the PushPullFace feature id
 * @param {object} profile    — resolved profile (reads `minWallMm`)
 * @param {number} distance   — signed mm
 */
export async function pressPullWallThickness(featureId, profile, distance) {
    const threshold = (profile && profile.minWallMm) ?? 0.4;
    if (typeof distance !== 'number' || !Number.isFinite(distance)) {
        return pass('no press-pull distance supplied', null);
    }
    const m = await safeMeasure({ type: 'bbox', featureId });
    if (!m.ok) return unavailable(m.error);
    const r = m.result;
    if (!r || r.ok !== true) {
        return unavailable((r && r.error) || 'bbox query failed');
    }
    const size = Array.isArray(r.size) ? r.size : null;
    if (!size || size.length < 3) return unavailable('bbox returned malformed size');
    const minDim = Math.min(...size);
    // Predicted thinnest remaining wall after the press-pull op:
    //   minDim − |distance| (when pulling inward, the slab eats from one side
    //   leaving minDim − |d|; when pushing outward, walls grow so the check
    //   is trivially safe — but we still flag if smallestDim itself is already
    //   smaller than 2 × threshold for symmetry with `zeroThickness`).
    const measured = { distance, minDim, threshold };
    const predicted = distance < 0 ? minDim - Math.abs(distance) : minDim;
    if (predicted < threshold) {
        return err(
            `press-pull distance ${distance} mm leaves predicted wall ${predicted.toFixed(3)} mm < ${threshold} mm`,
            `reduce |distance| to ≤ ${(minDim - threshold).toFixed(3)} mm or thicken the body first`,
            measured,
        );
    }
    if (predicted < 2 * threshold) {
        return warn(
            `press-pull distance ${distance} mm leaves predicted wall ${predicted.toFixed(3)} mm — close to ${threshold} mm minimum`,
            'consider a smaller |distance| or thicker stock',
            measured,
        );
    }
    return pass(`predicted wall ${predicted.toFixed(3)} mm ≥ ${threshold} mm`, measured);
}

/**
 * Derive an effective signed press-pull distance from a face-edit feature
 * (E3.2). Used by the runner so `pressPullWallThickness` can be reused
 * across PushPullFace / OffsetFace / MoveFace without per-type forks.
 *
 *   PushPullFace / OffsetFace → params.distance directly.
 *   MoveFace                  → project params.vector onto the face's
 *                               outward normal (read from the descriptor's
 *                               fingerprint when available; falls back to
 *                               +Z when the descriptor doesn't carry one
 *                               so the check still produces a number).
 *
 * Returns NaN when the feature is not a face-edit op, so the caller can
 * skip the check cleanly.
 */
export function effectivePressPullDistance(feature) {
    if (!feature || typeof feature !== 'object') return NaN;
    const p = feature.params || {};
    if (feature.type === 'PushPullFace' || feature.type === 'OffsetFace') {
        const d = Number(p.distance);
        return Number.isFinite(d) ? d : NaN;
    }
    if (feature.type === 'MoveFace') {
        const v = Array.isArray(p.vector) ? p.vector : null;
        if (!v || v.length !== 3) return NaN;
        // Pull normal from the face fingerprint when present; default to +Z.
        const fp = p.face && p.face.fingerprint;
        const n = (fp && Array.isArray(fp.normalRounded)) ? fp.normalRounded : [0, 0, 1];
        const nlen = Math.hypot(n[0] || 0, n[1] || 0, n[2] || 0) || 1;
        const ux = (n[0] || 0) / nlen, uy = (n[1] || 0) / nlen, uz = (n[2] || 0) / nlen;
        return v[0] * ux + v[1] * uy + v[2] * uz;
    }
    return NaN;
}

/**
 * Hole pattern: per-hole minimum diameter + pairwise spacing.
 */
export async function holePatternValidity(featureId, profile) {
    const minHole = (profile && profile.minHoleMm) ?? 1.5;
    const m = await safeMeasure({ type: 'holes', featureId });
    if (!m.ok) return unavailable(m.error);
    const r = m.result;
    if (!r || r.ok !== true) {
        return unavailable((r && r.error) || 'holes query failed');
    }
    const holes = Array.isArray(r.holes) ? r.holes : [];
    if (holes.length === 0) {
        return pass('no holes to validate', r);
    }

    // Per-hole min diameter
    const tooSmall = holes.filter((h) => (h.diameter ?? Infinity) < minHole);

    // Pairwise spacing: warn when distance < 2 * max(d_i, d_j).
    let closeCount = 0;
    let closeExample = null;
    for (let i = 0; i < holes.length; i++) {
        for (let j = i + 1; j < holes.length; j++) {
            const a = holes[i], b = holes[j];
            const pa = a.center || a.position;
            const pb = b.center || b.position;
            if (!Array.isArray(pa) || !Array.isArray(pb)) continue;
            const dx = (pa[0] - pb[0]);
            const dy = (pa[1] - pb[1]);
            const dz = (pa[2] - pb[2]);
            const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
            const dMax = Math.max(a.diameter || 0, b.diameter || 0);
            if (dist < 2 * dMax) {
                closeCount++;
                if (!closeExample) closeExample = { i, j, dist, dMax };
            }
        }
    }

    if (tooSmall.length === 0 && closeCount === 0) {
        return pass(`${holes.length} hole${holes.length === 1 ? '' : 's'} OK`, r);
    }

    const parts = [];
    if (tooSmall.length > 0) {
        parts.push(
            `${tooSmall.length} hole${tooSmall.length === 1 ? '' : 's'} below Ø${minHole} mm`,
        );
    }
    if (closeCount > 0) {
        parts.push(
            `${closeCount} pair${closeCount === 1 ? '' : 's'} closer than 2× max diameter`,
        );
    }
    return warn(
        `hole pattern: ${parts.join('; ')}`,
        tooSmall.length > 0
            ? `enlarge small holes to ≥ Ø${minHole} mm`
            : 'increase spacing between adjacent holes',
        r,
    );
}

/**
 * PRE-emit heuristic for a fillet operation.
 *
 * If the requested radius is comparable to the smallest bbox dimension we
 * predict the kernel will reject the op (no adjacent edge can be filleted
 * that aggressively). Rule of thumb: warn when radius > min(bbox) / 4.
 */
export async function filletEdgeLength(featureId, _profile, radius) {
    if (typeof radius !== 'number' || !(radius > 0)) {
        return pass('no radius supplied', null);
    }
    const m = await safeMeasure({ type: 'bbox', featureId });
    if (!m.ok) return unavailable(m.error);
    const r = m.result;
    if (!r || r.ok !== true) {
        return unavailable((r && r.error) || 'bbox query failed');
    }
    const size = Array.isArray(r.size) ? r.size : null;
    if (!size || size.length < 3) return unavailable('bbox returned malformed size');

    const minDim = Math.min(...size);
    const cap = minDim / 4;
    if (radius > cap) {
        return warn(
            `fillet radius ${radius} mm > smallest bbox dim / 4 (${cap.toFixed(3)} mm)`,
            `reduce fillet radius to below ${cap.toFixed(3)} mm`,
            r,
        );
    }
    return pass(`radius ${radius} mm within edge-length budget`, r);
}

// ── Relational checks (spec 13 — standard-parts fit) ─────────────────────────

/**
 * Common reducer: read a feature, validate the partRef shape, fetch the
 * catalog entry, and require a particular `role` and (optionally) catalog
 * category. Returns either `{ kind: 'short-circuit', result }` (caller
 * should return that result directly) OR `{ kind: 'ok', feature, entry,
 * partRef }`.
 */
async function resolvePartRef(featureId, expectedRole, expectedCategory) {
    let feature = null;
    try {
        feature = await callGetFeature(featureId);
    } catch {
        feature = null;
    }
    if (!feature) {
        // No document store reachable (e.g. plain-Node test for a sibling
        // check, or feature deleted under us): treat as not-applicable
        // rather than blocking other checks with a false error.
        return {
            kind: 'short-circuit',
            result: pass(`no ${expectedRole} partRef`, null),
        };
    }
    const partRef = feature && feature.params && feature.params.partRef;
    if (!partRef || partRef.role !== expectedRole) {
        return {
            kind: 'short-circuit',
            result: pass(`no ${expectedRole} partRef`, null),
        };
    }
    if (!partRef.entryId) {
        return {
            kind: 'short-circuit',
            result: err(
                'partRef has no entryId',
                'pick a catalog part for this feature',
                { partRef },
            ),
        };
    }
    const entry = await lookupCatalogEntry(partRef.entryId);
    if (!entry) {
        return {
            kind: 'short-circuit',
            result: unavailable(`catalog entry '${partRef.entryId}' unavailable`),
        };
    }
    if (expectedCategory && entry.category !== expectedCategory) {
        return {
            kind: 'short-circuit',
            result: err(
                `partRef.entryId not a ${expectedCategory}`,
                `pick a ${expectedCategory} catalog entry instead`,
                { partRef, entryCategory: entry.category },
            ),
        };
    }
    return { kind: 'ok', feature, entry, partRef };
}

/**
 * Classify a fit-band delta into pass / warning / error.
 * `delta` and `band` are both in millimetres.
 */
function classifyFitDelta(delta, band, profile) {
    const fitDefaults = (profile && profile.bearingFitDefaults) || {
        warningMultiplier: 1.0,
        errorMultiplier: 5.0,
    };
    const inBand = delta >= band.clearanceMin && delta <= band.clearanceMax;
    if (inBand) return 'pass';
    const overshoot = delta > band.clearanceMax
        ? delta - band.clearanceMax
        : band.clearanceMin - delta;
    const warnThresh = band.bandWidthMm * fitDefaults.warningMultiplier;
    const errThresh  = band.bandWidthMm * fitDefaults.errorMultiplier;
    if (overshoot <= warnThresh) return 'warning';
    if (overshoot <= errThresh)  return 'warning';
    return 'error';
}

/**
 * Bearing-OD ↔ host-bore fit check.
 *
 * For a Cylinder/Hole feature with `partRef.role === 'bore'` referring to
 * a bearing catalog entry: assert the host's diameter sits within the
 * ISO 286 band for the declared (or profile-default) fit class.
 */
export async function bearingBoreFit(featureId, profile) {
    const resolved = await resolvePartRef(featureId, 'bore', 'Bearing');
    if (resolved.kind === 'short-circuit') return resolved.result;
    const { feature, entry, partRef } = resolved;

    const hostDia = feature.params && Number(feature.params.diameter);
    if (!Number.isFinite(hostDia)) {
        return unavailable('host feature has no diameter param');
    }
    const partOd = entry.dims && Number(entry.dims.outerDiameter);
    if (!Number.isFinite(partOd)) {
        return unavailable('bearing entry has no outerDiameter');
    }

    const defaults = (profile && profile.bearingFitDefaults) || { class: 'H7/g6' };
    const fitClass = partRef.fitClass || defaults.class;
    const band = fitBand(fitClass, partOd);
    if (!band) {
        return err(
            `unknown fit class '${fitClass}'`,
            'use one of H7/g6, H7/h6, H7/k6',
            { hostDia, partOd, fitClass },
        );
    }

    const delta = hostDia - partOd;
    const verdict = classifyFitDelta(delta, band, profile);
    const measured = { host: hostDia, part: partOd, delta, band, class: fitClass };

    if (verdict === 'pass') {
        return pass(
            `bore Ø${hostDia} mm matches ${entry.name || partRef.entryId} OD Ø${partOd} mm within ${fitClass}`,
            measured,
        );
    }
    if (verdict === 'warning') {
        return warn(
            `bore Ø${hostDia} mm vs ${partOd} mm OD: clearance ${delta.toFixed(3)} mm outside ${fitClass} band [${band.clearanceMin.toFixed(3)}, ${band.clearanceMax.toFixed(3)}]`,
            `adjust bore diameter into the ${fitClass} band`,
            measured,
        );
    }
    return err(
        `bore Ø${hostDia} mm vs ${partOd} mm OD: clearance ${delta.toFixed(3)} mm >> ${fitClass} band`,
        `resize the bore — current delta exceeds ${profile?.bearingFitDefaults?.errorMultiplier ?? 5}× the tolerance band`,
        measured,
    );
}

/**
 * Bearing-ID ↔ host-shaft fit check.
 *
 * For a Cylinder feature with `partRef.role === 'shaft'` referring to a
 * bearing entry: assert host diameter sits in the ISO 286 band against
 * the bearing's inner diameter.
 */
export async function shaftBearingFit(featureId, profile) {
    const resolved = await resolvePartRef(featureId, 'shaft', 'Bearing');
    if (resolved.kind === 'short-circuit') return resolved.result;
    const { feature, entry, partRef } = resolved;

    const hostDia = feature.params && Number(feature.params.diameter);
    if (!Number.isFinite(hostDia)) {
        return unavailable('host feature has no diameter param');
    }
    const partId = entry.dims && Number(entry.dims.innerDiameter);
    if (!Number.isFinite(partId)) {
        return unavailable('bearing entry has no innerDiameter');
    }

    const defaults = (profile && profile.bearingFitDefaults) || { class: 'H7/g6' };
    const fitClass = partRef.fitClass || defaults.class;
    const band = fitBand(fitClass, partId);
    if (!band) {
        return err(
            `unknown fit class '${fitClass}'`,
            'use one of H7/g6, H7/h6, H7/k6',
            { hostDia, partId, fitClass },
        );
    }

    // For the shaft side, the relevant comparison is the *shaft band*
    // (positive shaft → interference, negative → clearance). We use the
    // composed band so a slide-fit declaration (H7/g6) reads consistently
    // with the bore check above.
    const delta = hostDia - partId;
    const verdict = classifyFitDelta(delta, band, profile);
    const measured = { host: hostDia, part: partId, delta, band, class: fitClass };

    if (verdict === 'pass') {
        return pass(
            `shaft Ø${hostDia} mm matches ${entry.name || partRef.entryId} ID Ø${partId} mm within ${fitClass}`,
            measured,
        );
    }
    if (verdict === 'warning') {
        return warn(
            `shaft Ø${hostDia} mm vs ${partId} mm ID: clearance ${delta.toFixed(3)} mm outside ${fitClass} band [${band.clearanceMin.toFixed(3)}, ${band.clearanceMax.toFixed(3)}]`,
            `adjust shaft diameter into the ${fitClass} band`,
            measured,
        );
    }
    return err(
        `shaft Ø${hostDia} mm vs ${partId} mm ID: clearance ${delta.toFixed(3)} mm >> ${fitClass} band`,
        `resize the shaft — current delta exceeds ${profile?.bearingFitDefaults?.errorMultiplier ?? 5}× the tolerance band`,
        measured,
    );
}

/**
 * ISO 273 clearance-hole sanity check.
 *
 * For a Hole feature with `partRef.role === 'clearance'` whose entryId is
 * an ISO 4762 fastener: assert the hole diameter is at or above the close
 * clearance for that thread nominal — and ideally matches one of the
 * three tabulated diameters.
 */
export async function clearanceHoleSize(featureId, profile) {
    const resolved = await resolvePartRef(featureId, 'clearance', 'Fastener');
    if (resolved.kind === 'short-circuit') return resolved.result;
    const { feature, entry, partRef } = resolved;

    const hostDia = feature.params && Number(feature.params.diameter);
    if (!Number.isFinite(hostDia)) {
        return unavailable('host feature has no diameter param');
    }
    const threadNominal = entry.dims && entry.dims.threadNominal;
    const table = clearanceHoles(threadNominal);
    if (!table) {
        return unavailable(`no ISO 273 entry for thread nominal '${threadNominal}'`);
    }

    const TOL = 0.05; // mm — match-snap window for close/medium/loose
    const measured = { host: hostDia, threadNominal, table };

    if (Math.abs(hostDia - table.close)  <= TOL
        || Math.abs(hostDia - table.medium) <= TOL
        || Math.abs(hostDia - table.loose)  <= TOL) {
        return pass(
            `Ø${hostDia} mm matches ISO 273 clearance for M${threadNominal}`,
            measured,
        );
    }

    if (hostDia < table.close) {
        return err(
            `Ø${hostDia} mm is below close clearance Ø${table.close} mm for M${threadNominal} — fastener won't pass`,
            `enlarge to ≥ Ø${table.close} mm (close), ${table.medium} (medium) or ${table.loose} (loose)`,
            measured,
        );
    }
    if (hostDia > table.loose + 0.5) {
        return err(
            `Ø${hostDia} mm is far above loose clearance Ø${table.loose} mm for M${threadNominal} — too sloppy`,
            `reduce to ≤ Ø${table.loose} mm (loose) or Ø${table.medium} mm (medium)`,
            measured,
        );
    }
    // hole is in (close, loose] — workable, but doesn't snap to a tabulated
    // value: warn so the designer knows they're off-standard.
    return warn(
        `Ø${hostDia} mm is between ISO 273 standard clearances for M${threadNominal} (close Ø${table.close}, medium Ø${table.medium}, loose Ø${table.loose})`,
        `snap to one of Ø${table.close}, Ø${table.medium}, Ø${table.loose} mm`,
        measured,
    );
}

/**
 * Thread engagement length check.
 *
 * For a Hole feature with `partRef.role === 'tap'` whose entryId is an
 * ISO 4762 fastener: assert tapped depth ≥ nominal Ø × profile-specific
 * multiplier (1× steel, 1.5× aluminum, 2× plastic). Warn at ≥80% of the
 * required depth; error below that.
 *
 * The host's tapped depth is `params.depth` when present; we fall back to
 * the smallest bbox dimension (a coarse approximation that triggers the
 * unavailable path if no measurement is reachable).
 */
export async function threadEngagement(featureId, profile) {
    const resolved = await resolvePartRef(featureId, 'tap', 'Fastener');
    if (resolved.kind === 'short-circuit') return resolved.result;
    const { feature, entry, partRef } = resolved;

    const threadNominal = entry.dims && Number(entry.dims.threadNominal);
    if (!Number.isFinite(threadNominal) || threadNominal <= 0) {
        return unavailable('fastener entry has no usable threadNominal');
    }

    const material = (feature.params && feature.params.material)
        || partRef.material
        || 'steel';
    const multipliers = (profile && profile.threadEngagementMultiplier) || {
        steel: 1.0, aluminum: 1.5, plastic: 2.0,
    };
    const multiplier = multipliers[material] != null
        ? multipliers[material]
        : multipliers.steel;
    const requiredDepth = threadNominal * multiplier;

    // Prefer the explicit `depth` param (Hole / threaded Hole). Fall back
    // to bbox.size's smallest extent so a generic feature still gets
    // *something* to compare. If neither is available, surface as
    // "measurement unavailable".
    let tappedDepth = feature.params && Number(feature.params.depth);
    if (!Number.isFinite(tappedDepth) || tappedDepth <= 0) {
        const m = await safeMeasure({ type: 'bbox', featureId });
        if (m.ok && m.result && m.result.ok === true && Array.isArray(m.result.size)) {
            tappedDepth = Math.min(...m.result.size);
        }
    }
    if (!Number.isFinite(tappedDepth) || tappedDepth <= 0) {
        return unavailable('host feature has no depth and no bbox');
    }

    const measured = {
        threadNominal, material, multiplier, requiredDepth, tappedDepth,
    };

    if (tappedDepth >= requiredDepth) {
        return pass(
            `tap depth ${tappedDepth.toFixed(2)} mm ≥ ${requiredDepth.toFixed(2)} mm required for M${threadNominal} in ${material}`,
            measured,
        );
    }
    if (tappedDepth >= 0.8 * requiredDepth) {
        return warn(
            `tap depth ${tappedDepth.toFixed(2)} mm is short of ${requiredDepth.toFixed(2)} mm required for M${threadNominal} in ${material}`,
            `deepen the tapped hole to ≥ ${requiredDepth.toFixed(2)} mm`,
            measured,
        );
    }
    return err(
        `tap depth ${tappedDepth.toFixed(2)} mm is well below ${requiredDepth.toFixed(2)} mm required for M${threadNominal} in ${material} — bolt will strip`,
        `deepen the tapped hole to ≥ ${requiredDepth.toFixed(2)} mm`,
        measured,
    );
}

// ── Registry ─────────────────────────────────────────────────────────────────

/**
 * Map check name → function. Exported so the runner can look up by name
 * from `profile.enabledChecks`.
 */
export const CHECK_REGISTRY = {
    manifoldness,
    selfIntersection,
    zeroThickness,
    pressPullWallThickness,
    holePatternValidity,
    filletEdgeLength,
    bearingBoreFit,
    shaftBearingFit,
    clearanceHoleSize,
    threadEngagement,
};

/**
 * Convenience: run every check enabled by the profile in parallel and
 * aggregate. Mostly used by the runner; exported so callers that already
 * have a profile object can skip the id lookup.
 *
 * @param {string} featureId
 * @param {object} profile  — resolved profile object
 * @param {object} [opts]   — { filletRadius?: number }
 */
export async function allChecks(featureId, profile, opts = {}) {
    const enabled = Array.isArray(profile && profile.enabledChecks)
        ? profile.enabledChecks
        : Object.keys(CHECK_REGISTRY);
    const radius = opts.filletRadius;

    const entries = await Promise.all(enabled.map(async (name) => {
        const fn = CHECK_REGISTRY[name];
        if (typeof fn !== 'function') {
            return [name, {
                ok: false,
                severity: 'error',
                message: `unknown check '${name}'`,
            }];
        }
        const extra = name === 'filletEdgeLength' ? [radius] : [];
        const result = await fn(featureId, profile, ...extra);
        return [name, result];
    }));

    const warnings = [];
    const errors = [];
    const checks = {};
    for (const [name, result] of entries) {
        checks[name] = result;
        if (result.severity === 'warning') warnings.push({ name, ...result });
        else if (result.severity === 'error') errors.push({ name, ...result });
    }

    return {
        pass: errors.length === 0 && warnings.length === 0,
        warnings,
        errors,
        checks,
    };
}
