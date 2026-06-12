# Phase 2a — Query-resolver hardening + datum-relative placement

> **Status (2026-06-07):** ✅ DSL hardening + stability framework
> landed. 47/47 strict-query tests pass; 35/35 legacy queries.mjs
> still pass; build clean.
>
> Query DSL: every factory takes `expect` ('exactly-one' |
> 'at-least-one' | 'all' | null). `qDatum(feature, datumKey)` ships
> with canonicalized parts at factory time (`corner-min-min-min` →
> `'-X-Y-Z'`) and an own resolver branch. `QueryResolutionError`
> carries candidates + expect + query for diagnostic UI.
> `validateStrict()` requires top-level expect + bans ordinal refs
> via `containsOrdinalRef()`. Legacy callers (no `expect`) keep
> working — back-compat preserved.
>
> Stability framework: tests/eval/stability/ with 15 cases (7
> primitives, 5 modifiers, 3 patterns). Snapshots descriptor sets
> before + after a parameter sweep; asserts persistence rate ≥
> threshold. Most cases at 1.0; 3 documented residuals at 0.90-0.95
> (chamfer chains, hole bore-cap migration, pattern boundary
> instances) cited inline against tracker/14's known limitations.
> Runs via `npm run test:stability`. CI gate wired into the existing
> smoke job (shared kernel + Playwright; separate vite port 1421).
>
> Datum vocabulary corpus + descriptor migration warnings deferred
> to a polish pass — the resolver enforces fail-loud today, which
> closes the silent-migration bug per spec.



> Phase 2a of [TRACKER.md](../TRACKER.md). **Unifies what the
> previous plan listed as two parallel items**: closing F3 topological
> naming's residual gaps and shipping datum-relative placement for the
> AI op schema. They're the same workstream — datum-relative ops are
> queries that have to resolve stably against live topology, with the
> exact failure modes F3 already documents. One pass hardens both.

## TL;DR

Make the query resolver strict, disambiguating, stability-tested, and
the syntactic basis for datum-relative ops in the AI emit path. Kill
ordinal refs (`<last>`), reject under-specified queries that match
>1 entity, add parameter-sweep stability gates to the eval corpus,
expose datum-relative placement helpers (`from: 'corner-min-min'`,
`face: <query>`, `offset: [...]`) so the model never has to know
build123d's origin convention.

## Why unified

The previous plan listed `datum-relative placement` (semantic safety)
and `topological-naming hardening` (syntactic safety) as parallel
hardening efforts. They're not. A datum-relative `from:
'corner-min-min'` placement is a query whose evaluation has to
survive:

- A fillet that erodes the corner → datum disappears.
- A parameter sweep that changes which vertex is "min-min" → datum
  migrates.
- Multi-corner symmetric geometry → datum ambiguous.

These are the F3 problems verbatim. Hardening the query resolver
once — and adding stability-over-parameter-sweep to the eval — closes
both. Treating them as separate efforts overcounts the work.

## Current state

**Topological naming (F3) — corpus at ~78%:**
- 51 cases; namers shipped for primitives / extrude / revolve /
  modifiers / booleans / patterns / mirror / transforms / offset3d.
- Strict=False xfails on shell / counterbore / fillet-chamfer chains /
  pattern direction / circular pattern count + angle.
- Estimated 80%+ likely after the next CI run flips remaining flips
  to honest pass.

**Query DSL ([queries.js](../lib/document/queries.js)) — shipped but
under-defended:**
- `qOp`, `qFeatureFaces`, `qByDirection`, `qFilter`, `qDescendsFrom`
  all work for the cases they're called on.
- `qFeatureFaces('box_x')` returns all 6 box faces — no validator
  complains; a downstream consumer picks one arbitrarily.
- No "must resolve to exactly N entities" assertion.
- No stability check across rebuilds.

**Datum-relative placement — does not exist:**
- AI op schema is implied (not shipped). Reading the
  [explainer](../STRATEGY.md), the worked example placed holes at
  `position: ["=edgeDistance", "=edgeDistance", "=plateThickness"]`
  — raw world coordinates, against a build123d Box that's
  origin-centered.

## Scope

**In:**

1. **Query strictness modes** — every query carries an `expect`
   modifier:
   - `expect: 'exactly-one'` — fail if 0 or >1 entities resolve.
   - `expect: 'at-least-one'`
   - `expect: 'all'`
   The validator rejects ops that consume the resolved set without
   specifying an expectation. The op generator (AI emit) must
   declare intent up front.

2. **Disambiguation requirements** — `qFeatureFaces(fid)` paired
   with no filter is REJECTED at validate time when the consumer
   expects-one. Validators require a disambiguator: `qByDirection`,
   `qFilter(PRED.partMatches('+Z'))`, `qNth(0)` — something that
   narrows to a unique entity.

3. **Ordinal-ref ban** — `<last>`, "previous feature", positional
   refs in any form rejected by the schema validator. Every ref is
   by feature id (which is stable across reorders). Catches the
   silent re-pointing failure mode.

4. **Datum-relative placement primitives** in the op schema:
   - `from: { feature: FeatureId, datum: DatumSpec }` where
     `DatumSpec` is `'corner-min-min-min'`, `'face-center-+Z'`,
     `'edge-midpoint-+X+Z'`, etc. — a small enumerated vocabulary
     that resolves to a concrete point in world frame via the query
     resolver.
   - `offset: [x, y, z]` — relative to the resolved datum, in
     world axes.
   - The op handler resolves at reify time, not at the kernel
     boundary, so the model never sees a world coordinate.

5. **Query-stability eval** — new corpus type (`tests/eval/stability/`):
   for each shipped feature kind, generate a doc, snapshot every
   query expression resolvable from descriptors, sweep one parameter
   across the design range, assert every query keeps resolving to
   the *same descriptor canonical string* (or fails noisily with a
   migration warning the loop can show the user).

6. **Stability metric in eval corpus** — track query-resolution
   stability rate as a Phase 2 metric alongside accuracy / DFM /
   parametric validity. A regression here is a structural problem
   even if downstream parts still build.

7. **Datum vocabulary corpus** — ~20 named datums covering 90%+ of
   common placement: each box corner, each face center, each face
   normal, each edge midpoint, principal axes through centroid.
   Extensible; not exhaustive.

**Out:**

- Surface-skinning queries (lofted/swept faces with no cardinal
  classification).
- Custom user-defined datums (compose later).
- Cross-component datums (Phase 3).
- Symbolic algebra over query expressions (one query is a value,
  not an unknown).

## Dependencies

- **F3 topological naming** — 78% baseline; remaining xfails get
  pulled in as part of this hardening.
- **F4 constraint-graph** — Query DSL is the input; hardening adds
  strictness.
- **F5 expression evaluator** — `offset: [=plateLength/2, ...]` runs
  expressions on coordinates.
- Unblocks **[spec 08](08-repair-loop.md)** — the AI op schema
  references this hardened resolver.

## Critical files

- Modify: [lib/document/queries.js](../lib/document/queries.js) —
  `expect` field on every query factory; `qDatum` for named datums.
- Modify: [lib/document/resolver.js](../lib/document/resolver.js) —
  enforce `expect`; emit descriptor migrations on mismatch.
- Modify: [lib/document/__tests__/naming.mjs](../lib/document/__tests__/naming.mjs)
  — expand to cover stability over parameter sweep.
- Modify: [b123d_server/naming.py](../b123d_server/naming.py) —
  expose corner / face-center / edge-midpoint as named datum
  descriptors so they round-trip to JS.
- New: `tests/eval/stability/` — corpus + runner.
- Modify: future op-schema validator (spec 08) — uses the strictness
  modes here.

## Acceptance

- `qFeatureFaces('box_x')` paired with `expect: 'exactly-one'` is
  REJECTED at validate; same query with `expect: 'all'` is accepted.
- `qByDirection(qFeatureFaces('box_x'), '+Z')` paired with
  `expect: 'exactly-one'` resolves correctly.
- A parameter sweep over `box_x.length` (10 → 100 mm in 10 steps)
  keeps `qByDirection(qFeatureFaces('box_x'), '+Z')` resolving to
  the same descriptor canonical at every step. Stability metric: 100%.
- `from: { feature: 'box_x', datum: 'corner-min-min-min' }, offset: [5, 5, 0]`
  places the hole at the box's `-X/-Y/-Z` corner + offset, regardless
  of build123d's centering convention. World coordinates never appear
  in the op.
- Stability corpus: ≥ 50 cases, ≥ 95% pass rate on the corpus's
  designed parameter sweeps.

## Open questions

- **Datum vocabulary extensibility**: users / models will want
  datums not in the v1 list. Reasonable v1 + escape hatch via
  `qFilter` composition; track corpus failures to expand the
  vocabulary.
- **What happens to a query whose target disappeared?** A fillet
  consumed the corner the datum referenced. Choices: (a) hard fail
  the op, (b) migrate to the nearest equivalent and warn, (c) try
  fallback chain. Recommend (a) — silent migration is exactly the
  topological-naming problem we're trying to avoid.
- **Cross-tool stability** — does `corner-min-min-min` mean the same
  in build123d as it would in OCCT Python? Yes if we control the
  resolver, which we do — descriptor canonical strings are the
  authoritative form.

## Effort

~2 weeks. Strictness modes + ordinal-ref ban (~3 days); datum
vocabulary + resolver extensions (~4 days); stability corpus + eval
metric (~3 days); F3 xfail residual closure (~3 days, depends on
real-kernel CI runs to know which to flip).
