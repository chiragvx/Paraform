# Foundation 4 — Constraint-graph reasoning: wire queries through emit

> **Status (2026-06-07):** ✅ landed. Emit pipeline accepts Queries
> (resolved via `bridge.topologyIndex` at emit time, fingerprint
> fallback when topology unavailable). Picker emits `qDescriptor(d)`
> automatically alongside the fingerprint. Inspector
> RelationshipsPanel renders upstream refs with discrimination
> (query > descriptor > fingerprint > body-of-feature > opaque) plus
> parameter dependency chips. AI emit schema producing queries is
> Phase 2 work.



> Phase 1 of [TRACKER.md](../TRACKER.md). Strategy rationale in
> [STRATEGY.md](../STRATEGY.md) §F3.

> **Reality check (from spec exploration):** the document-level
> "constraint graph" mechanism is **already implemented** as the Query
> DSL in [lib/document/queries.js](../lib/document/queries.js). The work
> is making feature inputs actually *use it* (instead of fingerprints
> or concrete descriptors) and giving the AI emit path a constraint-
> graph-shaped output format.

## TL;DR

Feature inputs already CAN reference upstream entities as Queries
("every +Z face of the box," "the edge that descends from this
sketch loop"). Today they don't — they reference concrete
descriptors or fingerprints. Land Queries as the canonical input
shape so AI output emits *relationships* instead of frozen
references. Pair with Foundation 3 (descriptors), which the Query
DSL evaluates against.

## Why foundation

If the AI emits "fillet the edge at (12.5, 0, 5.0)," tweaking a
parameter that moves that edge silently breaks the fillet. If it
emits "fillet every edge that descends from `box_x:+Z`," the fillet
survives any parameter change that keeps that face. Same failure
class as wrong-face-binding (Foundation 3) and same fix philosophy:
symbolic over geometric.

Per STRATEGY.md F3, this co-equal foundation with naming. Without
it, "parametric output is required" (A5) is hollow — the parameters
exist, but downstream features don't relate to them.

## Current state

**Query DSL — done:**
- [lib/document/queries.js](../lib/document/queries.js) (Phase 1B
  foundation) — full DSL: `qDescriptor`, `qFeatureFaces`,
  `qFeatureEdges`, `qOp`, `qUnion`, `qSubtract`, `qNth`, `qFilter`,
  `qByDirection`, `qDescendsFrom`. Predicate language: `PRED.planar`,
  `PRED.cylindrical`, `PRED.opTag`, `PRED.partMatches`. Validate
  helper for round-trip safety.
- [lib/document/resolver.js](../lib/document/resolver.js) evaluates
  queries against a `TopologyIndex` (built from kernel response).
- Test suite at
  [lib/document/__tests__/naming.mjs](../lib/document/__tests__/naming.mjs)
  covers query composition, predicate filtering, determinism, kernel
  reorder robustness.

**Feature inputs — partial:**
- [lib/document/types.js](../lib/document/types.js) feature inputs
  reference upstream entities by `bodyRef`/`faceRef`/`edgeRef` shapes
  that mostly carry fingerprints today (`{ kind, featureId, bodyKey }`
  plus fingerprint blob from picker via
  [lib/picking/refs.js](../lib/picking/refs.js)).
- [lib/document/emit.js](../lib/document/emit.js) translates feature
  inputs to Python kernel calls; references are emitted as
  fingerprint blobs that the kernel's v3 fingerprint resolver
  consumes. The Query path is not yet wired through.
- [b123d_server/harness.py](../b123d_server/harness.py)
  `resolve_faces` / `resolve_edges` (v3 path) does 2mm spatial
  matching. The v4 topology-emission path is in
  `_extract_topology_v4` but downstream features don't yet emit
  *queries* the kernel can re-evaluate.

**What's missing:**
- ❌ Feature input shapes that hold a Query alongside (or instead of)
  the fingerprint.
- ❌ Emit path that translates a stored Query into kernel-readable
  form (probably "resolve client-side via resolver.js using the last
  topology, emit the resolved descriptor list to Python," NOT
  "re-implement queries.js in Python" — see open questions).
- ❌ Picker → Query conversion (currently picker emits fingerprints
  via `entryToEdgeRef` / `entryToFaceRef`).
- ❌ AI emit path: structured ops that produce *queries* for feature
  inputs, not concrete descriptors.

## Scope

**In:**
- Extend feature input shapes in [types.js](../lib/document/types.js)
  to accept `{ query: Query }` alongside the existing fingerprint
  shape (coexist, like descriptors/fingerprints coexist for now).
- Add a client-side resolve step in
  [lib/document/emit.js](../lib/document/emit.js): when a feature
  input carries a Query, run `resolver.resolve(query,
  bridge.topologyIndex)` against the **most recent successful
  rebuild's** topology to get a concrete descriptor list, then emit
  that list to Python. Re-resolves on every emit, so parameter
  changes upstream propagate.
- Update [lib/picking/refs.js](../lib/picking/refs.js): when a pick
  has a descriptor (post-Foundation 3), emit
  `qDescriptor(descriptor)` as the query alongside (or instead of)
  the fingerprint.
- Define the AI emit schema (precursor to Phase 2 / A2 in STRATEGY.md):
  feature ops that take Queries as inputs ("Fillet every edge in
  `qOp(kind:'edge', feature:'box_x', opTag:'box', part:'+X+Z')`").
- Surface queries in the Inspector Parameters panel so a user can
  see *why* tweaking a parameter cascades. Even a read-only "this
  fillet references: every +Z face of box_x" line is huge for trust.

**Out:**
- Re-implementing queries.js in Python. The kernel doesn't need to
  evaluate queries — the client resolves them just before emit. The
  kernel only needs to know descriptors for entity attachment (which
  it already does per Foundation 3).
- Sketch-level constraints. Those are already a working solver
  inside `app/sketch_3d/controller.js`; this Foundation is about
  *document-level* references between features, not in-sketch
  geometric relations.

## Dependencies

- **Foundation 3 (topological naming)** is a hard prerequisite. The
  Query DSL evaluates against descriptors. Without Phase 1B closed,
  queries can resolve to wrong faces and the whole thing is hollow.
- Foundation 2 (determinism) carries over — query resolution depends
  on stable canonical strings.
- Foundation 5 (Parameters dialog) is a soft dependency. Queries are
  most useful when the user can *see* the relationship graph; the
  Parameters dialog is where that lives.

## Critical files

- Modify: [lib/document/types.js](../lib/document/types.js) — add
  `query` field on `faceRef` / `edgeRef` / `bodyRef`.
- Modify: [lib/document/emit.js](../lib/document/emit.js) — resolve
  queries via `resolver.resolve(...)` against the live topology
  before emitting to Python.
- Modify: [lib/document/bridge.js](../lib/document/bridge.js) — expose
  `bridge.topologyIndex` (the result of `buildIndex(topology)` from
  resolver.js) so emit can use it.
- Modify: [lib/picking/refs.js](../lib/picking/refs.js) — emit
  `qDescriptor` shape from picker selections.
- Modify: [src/lib/components/studio/inspector/PropertiesPanel.svelte](../src/lib/components/studio/inspector/PropertiesPanel.svelte)
  or add a new InspectorRelationships panel — render the query DSL
  human-readably for selected features.
- Later (AI emit): a new module under `src/lib/ai/emit.js` that
  produces feature ops with queries instead of bare descriptors.

## Acceptance

- A fillet feature referencing `qByDirection(qFeatureFaces('box_x'),
  '+Z')` survives a parameter change to `box_x` that re-emits the
  topology in a different order.
- The picker, when clicking a face on a v4 body, produces a feature
  input whose `query` field is `qDescriptor(face:box_x:box:+Z)` —
  verifiable via Foundation 1's smoke harness.
- The Inspector shows at least one human-readable form of every
  feature's upstream relationships.
- A documented "manual stress case" — sketch a hole pattern,
  reference its instances via `qFilter(qFeatureFaces('cirpat_a'),
  PRED.opTag('hole'))`, change pattern count from 4 → 8, fillets
  re-resolve.

## Open questions

- Where does the client resolve queries — at emit time (every kernel
  call) or eagerly when the feature is created? Recommendation: at
  emit time, on every rebuild, so upstream parameter changes
  re-resolve naturally. The cost is one resolver pass per
  feature-with-query per rebuild, which is cheap (canonical strings
  + a Map lookup).
- What if the resolver returns an empty set (the upstream feature
  was deleted or the query no longer matches anything)? Two options:
  (a) emit nothing → silent feature no-op, (b) emit a kernel error
  → loud failure. Recommendation: (b), surface as kernel error in
  the existing error chip. Silent failure here is exactly the trust
  problem we're trying to avoid.
- How to render a query human-readably? Queries.js has a
  `describeQuery` helper; verify it produces something the user can
  read. If not, write a renderer that translates `qFilter(qOp(...),
  PRED.opTag('hole'))` to "all hole faces from box_x."
- Do queries need their own canonical-string form for storage /
  diffing? The objects round-trip via JSON; that's probably enough.

## Effort

1.5–3 weeks. The plumbing (input shapes + emit path + picker) is
~1 week; the AI emit schema is ~1 week; the Inspector surface is
~3-5 days. Most of the cost is the emit-path resolve step
integration, which has to interact carefully with the kernel error
path.
