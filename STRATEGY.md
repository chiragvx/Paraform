# ParaForm Strategy

Why the next-6 in [TRACKER.md](TRACKER.md) is ordered the way it is, and what
the AI-first / accurate-mechanical-parts mission demands of the foundation.

> **Framing principle:** **the kernel is the arbiter, not the model.** The AI
> proposes; the deterministic kernel decides; every "accurate" claim is
> something we *measure*, not something the model asserts. Everything below
> descends from this rule.

---

## Critical path (sequenced)

1. **Prove what works.** Browser smoke harness. Today every ✅ in the tracker
   means "compiles + agent-wired," not "works." We can't prioritize off a
   tracker we can't trust, and the same harness becomes the eval substrate
   when the AI loop arrives.
2. **Make the kernel the arbiter.** Schema-validated feature-ops + a
   generate → measure → repair loop + classified kernel-error signal.
   Determinism is a precondition — pin the kernel, capture LLM seed,
   version the part definition.
3. **Make output editable, not frozen.** Two existential foundations:
   topological naming AND constraint-graph reasoning. Both required for
   "tweak this parameter" to mean anything. Plus the Parameters dialog +
   expression evaluator that makes them user-facing.
4. **Make output auditable.** The dimensional traceability + tolerance
   metadata + critical-dimension extraction cluster — annotation on
   nominal geometry, not new geometry.
5. **Ground the accuracy.** Standard-parts library (dimensional, not
   application) + cheap DFM guardrails. Defer hard DFM to research.
6. **Add structure when assemblies arrive.** Component / instance layer
   with a migration story for already-stored docs.
7. **Deliberately scope out.** Surface modeling, Form/T-Spline, CAM,
   simulation. Drawings deferred behind components.

---

## Foundations

### F1. Browser smoke harness, which doubles as eval substrate

Playwright-style scripted run that exercises each shipped feature
end-to-end and asserts on real geometry output (bounding box, body
count, mass, manifoldness). Redefines ✅ in the tracker to mean "passes
smoke." Same infra becomes the AI eval harness in **A9** — one
investment, two payoffs.

### F2. Topological naming (existential, paired with F3)

build123d / OCCT selects faces and edges geometrically, not by stable
identity. A reference to "this face" can silently bind to the wrong
face after a topology-changing rebuild. Without a fix, Press-Pull,
MoveFace, Project Geometry, sketch-on-face, and any parameter change
that drives a fillet edge are unreliable. For an AI-first tool this is
*existential* — AI refine-in-place depends on references surviving
edits.

**Two-layer mitigation:**

- **Fingerprint resolver above build123d.** Extend the existing
  `featureId + bodyKey + kind` descriptor with geometric fingerprint
  (centroid, normal, area, adjacency, generating-feature provenance).
  After each rebuild, re-resolve descriptors by scoring candidates
  against the fingerprint. Handle planar faces and cylindrical bores
  first; **surface "reference lost" explicitly** when scoring is
  ambiguous, rather than binding the wrong face silently.
- **Sidestep where possible.** Prefer parametric regeneration over
  face-editing. Many edits ("make the bore 2 mm bigger") are parameter
  changes that never re-pick a face. Requires **A5** (parametric
  output) and **F3** (constraint reasoning) to be real.

### F3. Constraint-graph reasoning (existential, paired with F2)

If the AI emits *independent* dimensions instead of constrained
*relationships*, the user breaks the part the moment they tweak one
parameter. The bolt-pattern stops matching the flange; the clearance
stops tracking the wall thickness. "Parametric not frozen" (A5) is
hollow when the parameters aren't related.

This is the same failure class as F2 — silent breakage on edit — and
deserves co-equal foundation status. Concretely:

- AI emits constraint *graphs* (relationships between dimensions), not
  flat dimension lists.
- Sketch solver already supports a real constraint set ([12 geometric
  + 6 dimensional](TRACKER.md)); extend to document-level relationships
  between features (this hole array references that face normal, this
  wall offsets from that bore by N mm).
- Expose the graph in the Parameters dialog so the user can see
  *why* changing one number cascades.

### F4. Component + instance layer (not thin)

The document is a flat feature timeline today. Multi-body designs, AI
output that spans parts, joints, drawings, and BOM all sit on a
hierarchy we don't have. Introducing it early is far cheaper than
migrating a large flat history later.

**This is not a thin layer.** Every `featureId` becomes
path-qualified, every command operating on "selected feature" needs to
know which component context, every picking descriptor changes,
serialization changes. Add to that: **a migration story for documents
already sitting in users' localStorage** from v0.27 onward. Plan for
the migration, don't paper over it.

### F5. Determinism as eval precondition

Same prompt + same kernel version should produce the same geometry.
Without this, **A9**'s eval harness measures noise. Required pieces:

- Pin kernel version (build123d + OCCT) per part definition.
- Capture LLM seed / temperature alongside the prompt.
- Version the part definition (not just the document — the *generator
  inputs* that produced it).

Has to land before evals are credible. Lightweight scope, large
downstream consequence.

### F6. Server kernel — round-trip + chattiness budget

The architecture is already chosen: Flask sidecar at
[b123d_server/server.py](b123d_server/server.py), Cloudflare-tunneled
kernel URL in [index.html:19](index.html#L19). build123d does not run
in the browser bundle.

The original Pyodide/WASM-envelope worry doesn't apply here — but the
concern *moves*, it doesn't vanish:

- **Round-trip latency.** Every measure → repair iteration is a network
  hop. The loop has to be chatty by design (multiple measurements per
  candidate); the budget has to assume that.
- **Mitigations.** Batch measurement queries into a single kernel call.
  Cache intermediate states server-side so repair iterations don't
  re-execute the whole document. Push cheap client-side approximations
  for hot-path measurements (bbox, manifoldness) where the server can
  be skipped.
- **Offline-capable later** is still a live bet. When it lands,
  Pyodide/WASM bundle size becomes a real concern again. Park it.

### F7. STEP/IGES import — toolchain wall + raw-group problem

occt-import-js is wired but `path`/`crypto` Node deps break in the
browser. Separately, imported geometry currently rides as a raw
`THREE.Group`: doesn't survive reload, no feature-tree entry, can't be
exported.

**Two paths, take both:**

- **Pre-mesh the standard-parts library server-side** and ship as
  structured GLB+JSON. Sidesteps the WASM fight for v1; unlocks
  fasteners + threads + bearings (A6) without solving STEP-in-browser
  first.
- **Fix STEP browser import properly** later, for user uploads. Shim
  the Node deps or move parsing into a web worker. Wrap imports as a
  real feature-tree node so they persist and round-trip.

---

## AI-for-accurate-mechanical-parts

### A1. Kernel as arbiter (architectural rule)

The model never emits geometry, only programs/ops. The kernel produces
ground truth. Accuracy is always measured. Bake it into the architecture
so no feature can violate it.

### A2. Schema-validated feature-ops over raw code-gen

Today [emit.js](lib/document/emit.js) generates build123d Python. Raw
code-gen is expressive but lets the model emit malformed or unsafe
Python. Structured ops validated against the typed catalog
([types.js](lib/document/types.js)) are safer and replayable.

- Constrained / validated decoding into the feature-op schema.
- Auto-repair pass on schema violations.
- BuildScript stays as power-user escape hatch only.

Malformed output becomes impossible by construction; every op is
replayable and editable.

### A3. Generate → measure → repair loop

The heart of credible accuracy. Promote **Measure** from a Tier-A UX
nicety to a **programmatic query API** the AI can call:

- Bounding box, point/edge/face distances, hole positions, mass.
- Manifoldness, self-intersection, interference.
- Wall-thickness *probe* (cheap; not a full DFM check).

After generation, auto-check the result against the captured spec; on
mismatch, feed the delta + classified kernel errors back to the model
to repair. Bounded retry budget.

### A4. Kernel errors as first-class repair signal

The model will emit operations the kernel rejects — boolean failures,
non-manifold results, fillets that won't apply, over/under-constrained
sketches. Catch, classify, and feed back ("fillet radius exceeds
adjacent edge length"). Graceful degradation, no opaque failures.

### A5. Parametric output required, not nice-to-have

If the model dumps baked-in constants, the user can't steer the result
and we can't prove a dimension came from intent rather than a
hallucination. AI output must define named parameters + relationships
(see F3). This finally motivates building the Document Parameters
dialog + expression evaluator + unit-aware arithmetic.

Bonus: many edits become parameter tweaks, sidestepping face-naming
(F2) for the common cases.

### A6. Standard parts: dimensional accuracy, not application correctness

Threads, fasteners, fits, bearings are looked up, not guessed. **But:**
a catalog gives you a geometrically perfect M4 — it does not give you
the *right* M4 for the joint. Bearing surface adequacy, preload,
thread engagement, edge distance, head-clearance, joint stiffness all
sit above the catalog.

Frame as **necessary, not sufficient.** The library closes the
*dimensional* hole. Application correctness is a separate, harder
problem — partly DFM (A7), partly engineering knowledge the AI has to
reason about explicitly, partly things the assumptions manifest (A8)
should surface as user-overridable defaults.

### A7. Manufacturability — split cheap from hard

Don't promise "DFM" as one capability. Two tiers:

- **Ship now (cheap to check).** Manifoldness, self-intersection,
  zero-thickness, basic dimensions, hole-pattern validity, edge length
  vs fillet radius. Runs inside the oracle loop (A3).
- **Research (hard).** Wall thickness via offset-surface analysis
  (build123d's offset API may not expose this; possible kernel wall).
  Tool-access reachability for CNC. Draft analysis. Defer to a real
  DFM workstream.

Ship process-specific profiles (3D print, CNC, injection mold) for the
cheap-tier checks so guardrails match the intended fabrication route.

### A8. Spec capture + assumptions manifest

A silently guessed dimension is a wrong part delivered with confidence
— the worst failure mode. The AI must emit an **assumptions manifest**
alongside the part: "assumed 4 mm wall, 8 mm edge distance, M4
clearance holes." Shown to the user, individually overridable. When
ambiguity is high, ask rather than guess.

Underrated trust UX. Cheap to build. Tied directly to the
auditable-dimension cluster below.

### A9. Eval harness (depends on F1 + F5)

Reuses smoke-harness infra (F1); requires determinism (F5) or it
measures noise. Corpus of (spec → known-good part) with automated
geometric assertions. Track:

- Geometric accuracy (does it match the spec?).
- DFM-pass rate (cheap-tier from A7).
- Parametric validity (does tweaking a parameter still produce a valid
  part?).

Gate model/prompt changes on it. This is also our strongest external
credibility claim — measured accuracy beats "AI-powered."

### A10. Granularity-of-review spectrum (not copilot/autopilot binary)

Modern AI agents (Cursor, v0) blur the line. The real question is
*granularity of human review*:

- **Per-feature.** Interactive, every emitted op approved. Highest
  trust, slowest. Default for high-stakes parts.
- **Per-part.** One-shot generation, review the result. Faster.
  Default for low-stakes / iteration mode.
- **Per-spec.** Review the assumptions manifest + critical dimensions
  (A8 + auditable cluster below), not the steps. Highest leverage for
  experienced users.

The product supports all three; ship per-feature as the default for
v1, expose per-part and per-spec as opt-ins.

---

## The auditable-dimension layer (cluster)

Three things the original sketch missed individually, that belong
together as one foundation cluster:

- **Dimensional provenance chain.** Intent → parameter → feature →
  face. Every critical dimension carries a "where did this come from"
  trail. Required for design-for-manufacture handoff and for AI-output
  trust. Without this, an AI output is unauditable.
- **General tolerance bands + GD&T metadata.** ±0.1 vs ±0.01 changes
  process, cost, inspection. Most drawing dimensions carry one. We
  cover exact fits (H7/g6) in standard parts; general tolerance is a
  separate, broader story.
- **Critical-dimension extraction.** The AI should emit the
  inspection-plan view alongside geometry: which 5 dimensions does the
  manufacturer measure to accept the part?

**Why grouped:** all three are *metadata on nominal geometry*, not new
geometry. OCCT models nominal; tolerance bands, provenance chains, and
inspection-plan annotations are layered annotations sharing one data
model. Designing them together avoids three incompatible metadata
schemas later.

---

## Scope walls (deliberately out)

- **Surface modeling.** build123d's NURBS API is thinner than the OCCT
  kernel underneath; we'd hit the *Python API* wall before the kernel
  wall. Prismatic / solid parts dominate the accurate-mechanical-parts
  mission. Expose raw OCP access as a BuildScript escape hatch for
  rare surface needs; don't build a half-surface workspace.
- **Form / T-Spline.** Different kernel entirely; build123d won't
  help. Out for the mission scope.
- **Simulation.** Separate solver stack, multi-quarter; not on the
  near-term roadmap.
- **CAM.** Separate toolpath engine + post-processor library;
  multi-quarter.
- **Drawings.** Defensible bet after F4 lands (gated on components);
  OCCT has HLR algorithms to lean on. Not before.

---

## Later — harvest from the loop

- **Failure-pattern catalog.** Extrude-then-fillet-then-shell works;
  shell-then-fillet-on-shelled-edge often fails. Build the catalog by
  *harvesting* the repair-loop error logs once the loop exists at
  volume. Useful for biasing generation toward known-good combinations,
  but it's an *optimization on top of A3 + A4*, not a foundation.
  Park.

---

## What gets promoted, what gets demoted

| Item | Was | Becomes |
|---|---|---|
| Measure | Tier-A UX nicety | **Foundation** — AI verification sensor (A3) |
| Parameters + expressions | Tier-A feature | **Required** for steerable output (A5) |
| Topological naming | Unproven infra risk | **Existential**, paired with constraint graph (F2) |
| Constraint-graph reasoning | Not on map | **Existential** foundation (F3) |
| Determinism (pinned kernel + seed + part version) | Not on map | **Precondition** for evals (F5) |
| Auditable-dimension layer | Scattered | **Foundation cluster** — provenance + tolerance + critical-dim |
| Standard parts | 12-item catalog | **Dimensional backbone** (not application correctness) (A6) |
| Smoke harness | Deferred chore | **Foundation** — eval substrate (F1 + A9) |
| Server-kernel concerns | Pyodide-envelope worry | **Round-trip latency + chattiness budget** (F6) |
| Components | Thin layer | **Not thin** — path-qualified IDs + stored-doc migration (F4) |
| DFM | One capability | **Cheap-now vs hard-research split** (A7) |
| Copilot vs autopilot | Binary fork | **Granularity-of-review spectrum** (A10) |
| Tangent Arc / 3-pt Arc / Construction toggle | Tier-A quick wins | **Below foundation** — pure Fusion sketch parity |
| Press-Pull | Top of next-6 | **Blocked on F2** — important, but topological naming first |
| Sketch-on-face | Top of next-6 | **Blocked on F2** |
| Custom planes / Align | Tier-A | **Below foundation** |
| Surface modeling | Tier-D kernel-bound | **Out of scope** for v1 mission |
| Form / T-Spline | Kernel-bound | **Out of scope** |
| Failure-pattern catalog | New suggestion | **Harvest later** from the loop |

---

## Companion: tracker re-tier

[TRACKER.md](TRACKER.md)'s "Recommended next 6" predates this doc and
should be replaced. The surgical block in the next section reflects
the promotions and demotions above, organized into three phases:
**Foundation**, **Accuracy backbone**, **Auditable-dimension layer**,
plus a demoted-but-not-dead list.
