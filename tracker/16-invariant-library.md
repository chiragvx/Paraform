# Phase 2b — Invariant constraint library

> **Status (2026-06-07):** ✅ landed. 25 invariants across 7
> categories (geometric 3 / material 3 / standard-parts 8 /
> mechanical 4 / assembly 4 / parametric 2 / catalog 1). 23-entry
> materials database covering metals + plastics + composites with
> ASTM/DIN aliases. 77 tests pass (66 invariant cases + 11 runner
> cases).
>
> Cross-imports with DFM use lazy `await import('../dfm/checks.js')`
> via a single-flight `callDfm()` helper — DFM never imports
> invariants back, so the dependency graph stays acyclic. The lazy
> hatch doubles as a test-injection point (`_setDfmModuleForTests`).
>
> UI: InvariantsPanel mounted in Inspector between Manufacturability
> and Scene & Material. Per-feature + per-document runs on selection
> / bridge.lastCompileMs change. Category filter chips, per-row
> rationale + citation. StatusBar amber chip (`⚠ N INV`) alongside
> the DFM chip. settings.manufacturing.invariantShowPasses gates
> showing pass rows.
>
> docs/INVARIANTS.md (480 words) covers the invariant-vs-DFM
> distinction, id/category/scope conventions, citation requirement,
> check-function contract (never throws, defensive on missing data),
> corpus test guidance, semver per-invariant, and a worked example
> for adding `i-fastener-minimum-edge-distance`.



> Phase 2b of [TRACKER.md](../TRACKER.md). **Layer 2 of the tiered
> spec→acceptance compiler.** Sits between the deterministic
> extractor ([spec 15](15-deterministic-extractor.md)) and the LLM
> residual in [spec 08](08-repair-loop.md). Closes the implicit-
> constraint hole: the dangerous ones live in nobody's spec text
> because everyone assumes them.

## TL;DR

A hand-curated set of constraints that **always apply, regardless
of user spec**. Manifold. No inter-feature interference within a
component. Every fastener has thread engagement and bearing surface.
Every body has a material. Bearing bores fall in a fit class. These
are the constraints models forget because models think they're free
— and the constraints users don't write down because they're
engineering convention. Adding them as a separate layer means the
LLM residual (layer 3) is only on top of a substantial floor of
correctness gates the model didn't author.

## Why a library, not LLM-generated

The single sharpest critique of the original spec→acceptance compiler
plan was that an LLM is the wrong tool for enumerating implicit
constraints. The dangerous implicit constraints don't appear in user
text — they're conventions engineers grew up with. Asking an LLM to
"list everything that always has to be true" produces a different
list each time, biased by recent training, with no audit trail.

Invariants are different in kind. They are *finite, enumerable,
versioned, and curated*. The set grows slowly, the consumer (repair
loop in [spec 08](08-repair-loop.md)) sees a stable check API, and
the user can read the list to understand what their part is being
held to.

## Current state

- No invariant library. Spec 11's cheap DFM is the closest analog
  (manifold / self-intersection / etc.) but it's *process-tier*
  conventions, not always-on engineering invariants.

## Scope

**In:**

1. **The library** — typed constraint records under
   `src/lib/invariants/library.js`. Each entry:
   ```js
   Invariant = {
     id: string,              // 'i-manifold-all-bodies'
     name: string,            // 'Manifoldness'
     category: 'geometric' | 'mechanical' | 'standard-parts' | 'assembly' | 'material',
     scope: 'per-feature' | 'per-component' | 'per-document',
     check: (target, ctx) => Promise<CheckResult>,
     severity: 'pass' | 'warning' | 'error',
     rationale: string,       // 'an unwatertight body cannot be 3D printed'
     version: string,         // semantic; gates regression
   }
   ```

2. **Initial invariant set** (~25 at v1):

   **Geometric (overlap with DFM, but always-on):**
   - All bodies are manifold (closed, watertight).
   - No self-intersecting bodies.
   - No zero-thickness walls.

   **Mechanical (the new floor):**
   - Every fastener-bore pairs to a fastener.
   - Every fastener has thread engagement ≥ profile.minimum.
   - Every fastener has bearing surface area ≥ profile.minimum.
   - Every bearing bore fits within the bearing's catalog OD class
     (delegates to [spec 13](13-standard-parts-fit-check.md)).
   - Every shaft mating with a bearing has the catalog ID class.
   - Bolt patterns under known moment loads don't exceed yield on
     worst-loaded bolt (when load info is available).

   **Standard-parts (catalog-cross-reference):**
   - Every StandardPart feature references an entry that exists in
     the catalog version current at document creation.
   - Every Hole tagged 'clearance' matches one of close/medium/loose
     for its nominal fastener size.
   - No StandardPart references an entry that's deprecated.

   **Assembly (cross-component):**
   - No inter-component interference at rest pose.
   - Every component has a parent in the tree (no orphans except root).
   - Every joint references existing source + target components.
   - No cyclic component refs.

   **Material:**
   - Every body has an assigned material.
   - Every material exists in the materials database.

3. **Materials database** — `src/lib/invariants/materials.json`. ISO
   codes + grades + key properties (density, yield, modulus, thermal
   expansion, machinability). Sources: ASM handbook + MMPDS subset.

4. **Runner** — `src/lib/invariants/runner.js`. Walks the document,
   evaluates every applicable invariant against every applicable
   target (per scope). Returns aggregate per-invariant + per-target
   results. Same shape as spec 11's DFM runner.

5. **UI surface** — Inspector "Invariants" panel showing pass/warn/
   error per invariant per selected feature. StatusBar chip for
   total violations. Settings panel for "show passes" vs "violations
   only."

6. **Repair-loop integration** ([spec 08](08-repair-loop.md))
   — every invariant violation feeds the repair loop as a classified
   error with the invariant's `rationale` as the human-readable
   suggested-fix.

7. **Versioning** — each invariant has a semantic version. Bumping
   thresholds (e.g., raising thread-engagement multiplier) bumps the
   version; the eval corpus (spec 12) gates regressions on per-
   invariant pass-rate so a tightening doesn't silently break the
   corpus.

8. **Authoring guide** (`docs/INVARIANTS.md`) — describes the
   conditions for adding a new invariant: must be enumerable, must
   be measurable via the existing measure API or trivially
   extensible, must have a rationale grounded in cited engineering
   convention, must have a v1 corpus case.

**Out:**

- Dynamic / kinematic invariants (interference across motion,
  reach, singularity) — [spec 17](17-kinematics-oracle.md).
- Material-property-derived load checks (yield, modal) — depend on
  FEA, multi-quarter.
- User-customizable invariant subsets — defer; v1 ships the curated
  set, all-on.

## Dependencies

- **[Spec 07 Measure API](07-measure-api.md)** — most invariants
  evaluate as measure queries.
- **[Spec 10 Standard parts](10-standard-parts.md)** — catalog
  cross-references.
- **[Spec 11 Cheap DFM](11-cheap-dfm.md)** — runner pattern;
  overlap in geometric tier.
- **[Spec 13 Fit check](13-standard-parts-fit-check.md)** — bearing
  fit invariant delegates to spec 13's implementation.
- Output consumer: **[Spec 08 Repair loop](08-repair-loop.md)** —
  per-invariant violation feeds repair signal.

## Critical files

- New: `src/lib/invariants/library.js` — the typed invariant set.
- New: `src/lib/invariants/runner.js` — evaluation driver.
- New: `src/lib/invariants/materials.json` — material database.
- New: `src/lib/components/studio/inspector/InvariantsPanel.svelte` —
  UI surface.
- Modify: [src/lib/components/studio/Inspector.svelte](../src/lib/components/studio/Inspector.svelte)
  — slot the panel after DFM (spec 11).
- Modify: [src/lib/components/studio/StatusBar.svelte](../src/lib/components/studio/StatusBar.svelte)
  — invariant-violation chip alongside DFM.
- New: `src/lib/invariants/__tests__/*.mjs` — per-invariant tests
  + runner tests.
- New: `docs/INVARIANTS.md` — authoring guide.

## Acceptance

- `runChecks('box_x')` runs every applicable invariant for that
  feature; results match the type-record shape.
- A body with no material assigned → `i-material-assigned` fires
  error.
- A bore at Ø22.0 with no `partRef` → `i-bearing-bore-has-partref`
  fires warning (not error; some bores are intentionally not for
  bearings).
- 25 invariants ship at v1, ≥ 20 with non-trivial implementation
  (the others can delegate to existing DFM checks).
- Eval corpus tracks per-invariant pass-rate; regressing any
  invariant by > 5% fails CI.

## Open questions

- **Threshold values** — thread engagement multipliers, edge
  distances, etc. — come from where? Recommend citing source per
  invariant (ASM, machinist's handbook, supplier datasheets); track
  as part of the rationale field.
- **Per-process variance** — some invariants change by process
  (min wall thickness vs 3d-print / cnc / injection). Resolve by
  letting invariants reference the active profile from spec 11,
  same as DFM checks do.
- **Should invariants block or warn?** Geometric/manifold:
  block. Standard-parts/material: warn (user may have edge cases).
  Catalog this per-invariant via the `severity` field. The runner
  surfaces both; the repair loop treats blocks differently from
  warnings.
- **AI-emit time vs check time** — could the op schema enforce
  invariants pre-emit (e.g., reject an op that introduces a
  body with no material)? Yes for some — invariant-aware schema
  validation in spec 08 should consume the library directly.

## Effort

~2 weeks. Library design + 25 invariants (~5 days); runner +
materials database (~3 days); UI surfaces (~3 days); tests + corpus
integration (~3 days); authoring guide (~1 day). Pure JS + measure
API; no kernel changes.
