# Phase 2.6 — Eval harness + corpus

> Phase 2 of [TRACKER.md](../TRACKER.md). Strategy: [STRATEGY.md](../STRATEGY.md) §A9.
> Reuses F1 smoke harness infra; requires F2 determinism baseline.

**Status (2026-06-07): ✅ landed.** Pure-Node eval harness shipped at
`tests/eval/{runner.mjs,corpus/,__tests__/}`. Seed corpus is 32 entries
(primitives 6, fasteners 5, fits 4, materials 4, spatial 4, kinematic 4,
end-to-end 5) — reuses a subset of the spec-15 extractor corpus + 5 fresh
end-to-end specs. First-run baseline: 100% overall pass rate. Per-invariant
regression gate fires when any invariant pass-rate drops > 5% vs
`tests/eval/baseline.json` (or use `npm run eval:update-baseline` to roll
forward). Wired into `.github/workflows/ci.yml` as `npm run eval`. Runner's
own tests: 14 assertions, all green.

## TL;DR

A corpus of `(spec → known-good part)` cases with automated
geometric assertions. Tracks accuracy, DFM-pass rate, parametric
validity. Gates model + prompt changes. **Closes the "we can't
honestly call it accurate without measuring it" gap from STRATEGY.md A9.**

## Why foundation

You can't call AI output accurate without measuring it. You'll
regress silently on every prompt tweak without an eval. This is also
the strongest external credibility claim — *measured* accuracy beats
"AI-powered" marketing.

The corpus is also where the **failure-pattern catalog** mentioned
in STRATEGY.md gets harvested from: log every retry-loop step + its
classified error; over time the patterns reveal which feature
combinations the kernel reliably handles vs which it rejects.

## Current state

- F1 smoke harness has 32 cases — but they're **feature wiring
  tests** (does `primitive.box` execute without error?), not
  spec-correctness tests.
- F2 determinism captured; reruns are deterministic.
- No AI yet — eval harness ships in lockstep with 08.

## Scope

**In:**
- New `tests/eval/` directory mirroring `tests/smoke/` structure:
  - `harness.mjs` — extends smoke harness; reads spec corpus, runs
    AI emit loop (08), asserts measure (07) results, tracks pass/
    fail/repair-iterations per case.
  - `cases/*.mjs` — spec → expected-output cases. Per case:
    ```js
    {
      id: 'm3-clearance-plate-4hole',
      spec: 'A 60×40×3 mm aluminum plate with four M3 clearance holes
             at the corners, 5 mm from each edge.',
      expect: {
        bbox: { size: { x: [59, 61], y: [39, 41], z: [2.9, 3.1] } },
        holes: { count: 4, diameter: { min: 3.2, max: 3.4 } },
        dfm: { profile: '3d-print', pass: true },
        parametric: { hasParameters: ['plateThickness'] },
      },
    }
    ```
  - `cases/primitives/`, `cases/brackets/`, `cases/enclosures/`,
    `cases/mechanisms/` etc.
- Corpus target: 50 cases at first ship; 200 by end of quarter.
- Metrics tracked:
  - **Geometric accuracy** — % of cases passing measure assertions.
  - **DFM-pass rate** — % of cases passing the active DFM profile.
  - **Parametric validity** — % of cases whose parameters survive
    a perturbation edit.
  - **Repair-loop convergence** — avg retries per pass; % of cases
    requiring 0 / 1 / 2 / 3+ retries.
  - **Constraint coverage rate** — % of atomic constraints extracted
    by [spec 15](15-deterministic-extractor.md)'s deterministic
    parser that have a corresponding acceptance check at reify time.
    Drives the coverage gate from [spec 08](08-repair-loop.md).
  - **Query stability rate** — for each generated part, sweep its
    parameters across the design range; assert every query (datum-
    relative ref, face/edge selection) still resolves to the same
    descriptor canonical. Hard-fails detect topological-naming
    regressions ([spec 14](14-query-resolver-hardening.md)).
  - **Invariant pass-rate per invariant** — track each [spec 16](16-invariant-library.md)
    invariant's pass-rate independently. Regressing any single
    invariant by > 5% fails CI.
  - **Cost-per-accepted-part** — (per-attempt model cost + per-
    attempt kernel + measure + DFM + invariant compute) ×
    (attempts to acceptance). The honest cost unit. Drives the
    Gemma-vs-Gemini swap decision per [spec 08](08-repair-loop.md).
- Per-case logging: store every retry-loop step under
  `tests/eval/logs/<run-id>/<case-id>.jsonl`. This is the data the
  failure-pattern catalog harvests later.
- CI gate (`.github/workflows/eval.yml` or analog): run a fixed
  subset on every model / prompt change; fail PR if accuracy drops
  more than 5%.
- Dashboard `tests/eval/report.mjs` — emits a markdown summary of
  the latest run.

**Out:**
- Crowd-sourced corpus building (just hand-authored at v1).
- Production telemetry (separate problem).
- Multi-model comparison harness (future enhancement).

## Dependencies

- **F1 smoke harness** — reuse runtime + assertion library.
- **F2 determinism** — eval results meaningless without pinned
  kernel + captured seed.
- **07 Measure API** — every assertion is a measure call.
- **08 repair loop** — eval drives the AI emit path.
- **11 cheap DFM** — DFM pass-rate is a tracked metric.

## Critical files

- New: `tests/eval/{harness.mjs, runner.mjs, asserts.mjs, report.mjs}`.
- New: `tests/eval/cases/**/*.mjs` — corpus (50 at v1, growing).
- New: `tests/eval/logs/.gitkeep` — directory for per-run dumps.
- Modify: [package.json](../package.json) — add `"test:eval"` and
  `"eval:report"` scripts.
- New: `.github/workflows/eval.yml` — CI gate (or analog).
- New: `tracker/EVAL_RESULTS.md` — running log of pass-rate trend
  + known-bad cases.

## Acceptance

- `npm run test:eval` runs the corpus, exits 0 if accuracy ≥
  baseline, non-zero otherwise.
- First run produces ≥ 50 spec-to-part cases with measure
  assertions.
- Dashboard markdown report includes the four tracked metrics +
  per-category breakdown.
- A deliberate prompt regression (e.g. removing the "use parameters"
  instruction) causes the parametric-validity metric to drop and CI
  to fail.
- Eval logs preserve every retry step in a format the failure-
  pattern catalog can consume.

## Open questions

- Test corpus authoring: who hand-builds the spec library? Initial
  pass: domain expertise + open-source mechanical CAD repos. The
  corpus is the most-curated artifact in Phase 2.
- Scoring "close enough": measure tolerances are case-specific.
  Recommendation: per-case tolerance bands authored alongside the
  expected values.
- How often eval runs in CI: full corpus is slow; recommend a fast
  subset (~10 cases) on every commit + full corpus nightly.
- Visualization beyond markdown report: a small static-HTML
  dashboard? Defer until corpus is real.

## Effort

~2 weeks. Harness + assertion library + report (~5 days). Initial
50 cases (~5 days; the slow part — each case is hand-authored). CI
integration (~2 days).
