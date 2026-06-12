# Phase 2a — Standard-parts relational fit check

> **Status (2026-06-07):** ✅ landed. 37 new tests across two suites
> (31 fit_check + 6 partref); existing DFM tests (15 checks + 6
> runner) still green; build clean. ISO 286 (4 classes × 7 size
> ranges = 28 bands) + ISO 273 clearance holes (8 sizes × 3 fits =
> 24 entries) mirrored as JS literals. 4 new checks
> (bearingBoreFit / shaftBearingFit / clearanceHoleSize /
> threadEngagement) registered in CHECK_REGISTRY and enabled per
> profile with engineering-justified per-process overrides (3d-print
> H7/g6, cnc-mill H7/h6, injection-mold H7/k6 with 1.5×
> warningMultiplier for shrinkage uncertainty). partRef shape
> documented on Cylinder/Hole/Box; Inspector "Standard-part mate"
> section renders the mating chip + edit form with catalog/role/
> fit-class picker; auto-suggest fires when Cylinder diameter ≈
> bearing OD within ±0.1mm. setFeatureProvider /
> setCatalogProvider injection hatches keep the checks testable
> without three.js / Svelte runes in the suite.



> Phase 2a (cheap-now tier) of [TRACKER.md](../TRACKER.md).
> Promoted out of "assembly-level checks" (Phase 2c) on the
> recognition that this is **bounded, data-already-in-repo, days not
> quarters**. Catches genuine assembly-killing bugs without any
> kinematics, ML, or sim engine.

## TL;DR

Cross-reference [spec 10](10-standard-parts.md)'s dimensional catalog
against host-feature dimensions in the document. Bearing OD vs bore
Ø within ISO 286 fit-class band; fastener thread engagement vs
nominal; bearing seat width vs cylinder height; clearance hole vs
fastener nominal per ISO 273. Pure relational checks; no model
inference, no swept volumes, no solver — just `|host - part| < band`.

## Why it's promoted ahead of bigger work

The previous Phase 2 ordering put this under "assembly-level checks"
alongside swept-volume interference and kinematic reach, which are
multi-quarter (separate sim engine, config-space integration). That
buried a cheap, bounded, high-value win under an expensive
long-horizon workstream. The right slot is its own tracker item,
ahead of every multi-week effort in Phase 2.

Spec 10 ships 148 entries with exact ISO dimensions; `iso_fits.json`
has H7/g6, H7/h6, H7/k6 tolerance bands per nominal-size range; spec
11's DFM runner is the natural host. The gap is purely wiring — no
new data, no new capability.

It also catches a class of failure the rest of the loop misses
silently: a bore designed at Ø22.0 mm for a 608 bearing (OD 22) with
no fit allowance is press-fit if Ø22.0 actually measures Ø21.99 in
manufacture, slide-fit if Ø22.01. Same drawing, same model, same
green DFM gate. The check converts "the bore matches the bearing" from
intent into measurement.

## Current state

- [src/lib/library/standard.js](../src/lib/library/standard.js) —
  `insertEntry` creates a StandardPart feature with the catalog
  entry stamped on metadata via `feature.params.entryId` (since the
  StandardPart closure in commit c3c6c83).
- [src/lib/dfm/checks.js](../src/lib/dfm/checks.js) — 5 checks today;
  no relational/cross-feature checks.
- No `partRef` field on host features (Cylinder / Hole / etc.)
  pointing at a standard-part it's intended to mate.
- No surface for the user to declare a fit-class intent on a feature
  ("this bore is a slip fit for a 608").

## Scope

**In:**

1. **`partRef` field on selected feature types** — Cylinder, Hole,
   Box (for slot-shaped bores) gain an optional
   `params.partRef: { entryId: string, role: 'bore'|'shaft'|'clearance'|'tap'|'seat-width', fitClass?: 'H7/g6'|'H7/h6'|'H7/k6'|... }`.
   Pure data — doesn't change emit, doesn't change the kernel-side
   build. Stored, surfaced in Inspector, consumed by the check.

2. **Four new DFM checks** in [src/lib/dfm/checks.js](../src/lib/dfm/checks.js):

   - **`bearingBoreFit(featureId, profile)`** — for a Cylinder with
     `partRef.role === 'bore'`: look up the standard part's OD, the
     declared fit class, the ISO 286 band; assert
     `|cylinder.diameter - part.OD| within band(class, part.OD)`.
     Warning on out-of-band; error on > 5× band.
   - **`shaftBearingFit(featureId, profile)`** — same for shafts: a
     Cylinder used as a shaft that mates with a bearing's bore (ID).
   - **`clearanceHoleSize(featureId, profile)`** — for Hole with
     `partRef.role === 'clearance'`: assert hole diameter matches
     one of `iso_metric_clearance.json`'s close/medium/loose values
     for the nominal fastener size. Warn if it doesn't match any of
     the three; error if it's smaller than close (won't fit at all).
   - **`threadEngagement(featureId, profile)`** — for Hole with
     `partRef.role === 'tap'` + fastener entryId: assert tapped
     depth ≥ nominal Ø × profile-dependent multiplier (1.0× for
     steel, 1.5× for aluminum, 2.0× for plastic — from
     `profiles.js`). Warn if shorter; this is a stress-of-bolt-load
     check, not a geometric one.

3. **Profile thresholds** in [profiles.js](../src/lib/dfm/profiles.js):
   - `bearingFitDefaults: { class: 'H7/g6', warningMultiplier: 1.0, errorMultiplier: 5.0 }`
   - `threadEngagementMultiplier: { steel: 1.0, aluminum: 1.5, plastic: 2.0 }`
   - Per-process overrides where they differ.

4. **Inspector surface** — when a feature has `partRef` set, show
   it in [RelationshipsPanel.svelte](../src/lib/components/studio/inspector/RelationshipsPanel.svelte)
   ("Mates with: 608 bearing (bore, H7/g6)"). Click-to-edit fit class.

5. **Auto-suggest `partRef`** when a Cylinder's diameter matches a
   bearing OD within 0.1 mm — small "Looks like a 608 bearing seat;
   set partRef?" affordance in the Inspector. Optional v1.

**Out:**

- Bolt-pattern moment-load analysis (this is "fastener loading"
  proper, needs distance-from-centroid math; defer).
- Bearing L10 life calc — needs load info we don't capture yet.
- Preload analysis (angular-contact bearings, taper bushings).
- Fasteners with non-standard heads.
- Imperial sizes.

## Dependencies

- **[Spec 07 Measure API](07-measure-api.md)** — for the bore-diameter
  query (`measure({type:'holes', featureId})` returns hole diameters
  already).
- **[Spec 10 Standard parts](10-standard-parts.md)** — catalog data
  is the LHS of every check.
- **[Spec 11 Cheap DFM](11-cheap-dfm.md)** — runner is where these
  plug in.
- F4 Query DSL — `partRef` is just data, but selecting/inspecting
  the related feature in Inspector reuses query infra.

## Critical files

- Modify: [lib/document/types.js](../lib/document/types.js) — add
  `partRef` to relevant feature param schemas.
- Modify: [src/lib/dfm/checks.js](../src/lib/dfm/checks.js) — 4 new
  check functions.
- Modify: [src/lib/dfm/profiles.js](../src/lib/dfm/profiles.js) — fit
  class defaults + thread-engagement multipliers.
- Modify: [src/lib/components/studio/inspector/RelationshipsPanel.svelte](../src/lib/components/studio/inspector/RelationshipsPanel.svelte)
  — render `partRef` row + edit.
- New: `src/lib/dfm/iso286.js` — ISO 286 band lookup
  (`band(class, nominal_size)` returns ± microns).
- Tests: `src/lib/dfm/__tests__/fit_check.mjs` — ≥ 10 cases covering
  each check function + each profile.

## Acceptance

- Bore at Ø22.0 with `partRef: {entryId:'bearing-608', role:'bore', fitClass:'H7/g6'}`
  → check passes (608 OD is 22, H7/g6 at Ø22 band is +21/−0 µm on
  bore; Ø22.0 is within tolerance).
- Same bore at Ø22.5 → warning (out of band by 500 µm; warningMultiplier×band).
- Same bore at Ø21.5 → error (5× band on the negative side).
- M3 clearance hole at Ø3.4 with `partRef: {entryId:'iso4762-m3-16', role:'clearance'}`
  → passes (matches medium clearance).
- M3 clearance hole at Ø2.9 → error (smaller than close clearance 3.2).
- M3 tap in aluminum at depth 4 mm → warning (1.5× × 3 mm = 4.5 mm
  minimum engagement; 4 mm is short).
- All checks plug into the existing DFM runner; per-feature results
  appear in DfmPanel; aggregate count contributes to StatusBar chip.

## Open questions

- **`partRef` UX**: how does the user set it? Inline edit in Inspector
  is minimal; a more discoverable affordance is a "Mate with…"
  context-menu action that opens a small picker (filtered catalog,
  fit-class dropdown). Recommend the latter for v1.
- **Auto-suggest tolerance**: 0.1 mm threshold for "looks like a 608
  seat" is arbitrary. Tune from corpus runs.
- **Should the AI emit `partRef`?** Yes — the LLM op schema
  ([spec 08](08-repair-loop.md)) should produce `partRef` alongside
  geometric params when a bore is "for a 608." This makes the
  catalog-correctness gate automatic on AI-generated parts.

## Effort

**~3 days.** Half a day per check function + iso286 band lookup;
half a day for `partRef` data plumbing + Inspector surface; ~1 day
for tests + corpus tuning + auto-suggest UX. Bounded; no blocker.
