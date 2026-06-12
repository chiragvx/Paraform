# Phase 2.5 — Cheap DFM guardrails

> **Status (2026-06-07):** ✅ landed (cheap tier). 5 checks
> (manifoldness / selfIntersection / zeroThickness / holePatternValidity
> / filletEdgeLength) running against the Measure API from spec 07.
> 3 process profiles (3d-print / cnc-mill / injection-mold) with
> per-process thresholds. Inspector DfmPanel + StatusBar amber chip +
> ManufacturingPanel in settings + 9th tab in Settings dialog (Factory
> icon). 21/21 unit tests pass. **08 repair-loop wiring deferred** —
> when 08 lands the DFM oracle plugs in as a classified error feeder.
> v1 punts: real wall-thickness via offset-surface analysis (needs
> kernel minWallProbe), tool-access reachability for CNC, draft
> analysis. cnc-mill / injection-mold carry their advanced thresholds
> in profiles.js but no check consumes them yet.



> Phase 2 of [TRACKER.md](../TRACKER.md). Strategy: [STRATEGY.md](../STRATEGY.md) §A7.
> Ship the cheap-to-check tier; defer hard DFM to research per the
> strategy split.

## TL;DR

Manifoldness / self-intersection / zero-thickness / hole-pattern
validity / edge length vs fillet radius — checks that run in
milliseconds on top of the Measure API (07). Run inside the repair
loop (08) so the AI gets feedback when it produces an unmakeable
part. **Wall-thickness via offset surface analysis and tool-access
reachability stay deferred** — they require kernel-side capabilities
build123d may not expose.

## Why foundation

A7 from STRATEGY.md, split tier explicitly. "Accurate" is the wrong
word without "makeable." Even cheap DFM catches:

- Fillet radius > adjacent edge length → kernel rejection.
- Self-intersecting bodies → unprintable.
- Holes overlapping other holes → unmillable.
- Zero-thickness walls → ambiguous geometry.
- Non-manifold edges → unprintable, non-shippable.

The AI is the first consumer (via 08's repair loop). The user is
the second — DFM warnings render in the Inspector + Status bar.

## Current state

- No DFM checks of any kind. Kernel error chip shows raw Python
  exceptions only.
- PropertiesPanel shows triangle count / bbox — pure structural
  metrics, not DFM.

## Scope

**In (cheap-now tier):**
- `src/lib/dfm/checks.js` — pure JS checks that consume Measure API
  results:
  - `manifoldness(featureId)` — wraps `measure({type:'manifold'})`;
    returns `{ ok, eulerNumber, openEdgeCount }`.
  - `selfIntersection(featureId)` — wraps the measure query.
  - `zeroThickness(featureId, minMm = 0.4)` — uses `measure` bbox +
    a kernel-side `minWallProbe` (added in 07 / Measure API).
  - `holePatternValidity(featureId)` — pulls `holes` measure;
    checks pairwise minimum spacing (default 2× max hole diameter).
  - `filletEdgeLength(featureId, radius)` — pre-emit check: for
    every edge the fillet would target, ensure adjacent edge length
    > 2 × radius. Heuristic, runs before kernel.
- Process profiles (`src/lib/dfm/profiles.js`):
  - `3d-print` — min wall 0.8 mm, min hole Ø 1.5 mm, min feature 0.4 mm.
  - `cnc-mill` — min internal corner radius = tool radius (default
    1 mm), max aspect ratio 10:1 on deep pockets.
  - `injection-mold` — draft on all walls > 0.5°, min wall 1 mm,
    uniform thickness ±20%.
- `src/lib/dfm/runner.js`:
  - Runs all enabled checks against a feature; returns
    `{ pass: boolean, warnings: Warning[], errors: Error[] }`.
  - Hooks into 08's repair loop as the manufacturability oracle:
    AI gets each error classified.
- `src/lib/components/studio/DfmPanel.svelte` — Inspector section.
  Per-feature warnings list with rationale + suggested fix.
- StatusBar chip: "⚠ N DFM warnings" linking to Inspector.
- Settings → Manufacturing panel: pick active profile, override
  thresholds.

**Out (defer to research):**
- Wall thickness via offset-surface analysis (requires OCCT offset
  API; build123d may not expose).
- Tool-access reachability for CNC (very hard; needs swept volumes +
  collision detection).
- Real draft analysis (degree-by-face).
- Sheet-metal-specific DFM.

## Dependencies

- 07 Measure API — every check is a measure call.
- 08 repair loop — DFM errors flow into the loop as classified
  warnings.

## Critical files

- New: `src/lib/dfm/{checks, profiles, runner}.js`.
- New: `src/lib/dfm/__tests__/*.mjs` — per-check tests against mocked
  measure responses.
- New: `src/lib/components/studio/DfmPanel.svelte`.
- Modify: [Inspector.svelte](../src/lib/components/studio/Inspector.svelte) —
  slot DFM panel.
- Modify: [StatusBar.svelte](../src/lib/components/studio/StatusBar.svelte) —
  warning chip.
- Modify: [src/lib/settings/schema.js](../src/lib/settings/schema.js) —
  manufacturing profile selector.
- Modify: 08's repair loop — wire DFM oracle.

## Acceptance

- Adding a fillet with radius > edge length surfaces a pre-emit
  warning and a "the kernel will reject this" inline hint.
- A self-intersecting body (e.g. mis-extruded sketch) shows the
  StatusBar chip + DfmPanel row.
- Switching profile from 3d-print to cnc-mill changes the set of
  active checks + thresholds.
- AI generation in 08 produces a part that passes the active
  profile's DFM checks ≥ 90% of the time on the spec corpus (12).

## Open questions

- Wall thickness probe in v1: stub or implement a sample-based
  pseudo-probe? Recommendation: kernel-side `minWallProbe` sampling
  N random surface points + measuring the in-body chord to nearest
  opposite surface. Cheap, approximate, useful.
- Warning vs error: which DFM violations block the AI from emitting
  vs just warn? Recommendation: only manifoldness + self-
  intersection block; everything else warns.

## Effort

~1.5 weeks. Checks + profiles (~4 days). UI panel + StatusBar
integration (~3 days). Wiring into repair loop + tests (~3 days).
