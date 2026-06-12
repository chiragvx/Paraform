# ParaForm Feature Tracker

Tracks modeling capabilities vs Fusion 360. Source for prioritization, not a
roadmap commitment. Last refresh: 2026-06-06 (post-v0.27).

## Legend

| | Meaning |
|---|---|
| ✅ | Shipped — wired end-to-end, works in browser |
| 🟡 | Partial — wired but limited or only on the happy path |
| ⚠️ | Stub — type/handler exists, kernel emits no-op or comment |
| ❌ | Not started |
| 🚫 | Deferred — blocked by kernel/scope; revisit later |
| 🧪 | Untested in browser (built, but no smoke run yet) |

> Reality check: every shipped feature from v0.23..v0.27 is technically 🧪 —
> nothing has been clicked end-to-end. Treat ✅ as "compile-passes + agent-wired"
> until a smoke pass lands.

---

## Sequenced next-block (post-[STRATEGY.md](STRATEGY.md) re-tier)

The "Tier A quick wins" list this replaces was Fusion-parity-driven.
[STRATEGY.md](STRATEGY.md) re-tiers it around the AI-first /
accurate-mechanical-parts mission. Order is dependency-driven, not
size-driven — items in later phases assume earlier phases are real.

Each Phase 1 item has a dedicated executable spec under [`tracker/`](tracker/)
with current state, scope, dependencies, critical files, acceptance criteria,
and effort estimate.

> **Reality update (from spec exploration):** items 3 and 4 are much more
> advanced than STRATEGY.md treated. The symbolic descriptor system + Query
> DSL + JS resolver + 35-test suite are all implemented; the Python
> `naming.py` is wired through `_extract_topology_v4`. The work for these
> two is **finishing per-feature namer coverage + the 50-edit corpus +
> wiring queries through the emit path** — not "design a fingerprint
> resolver." STRATEGY.md F2's framing is misleading; trust the specs over
> the strategy doc for these items.

### Phase 1 — Foundation (must land before AI accuracy is a real claim)

1. ❌ **Browser smoke harness** → [`tracker/01-smoke-harness.md`](tracker/01-smoke-harness.md). Playwright runner; redefines ✅ to mean "passes smoke." Doubles as Phase 2 eval substrate. ~3–5 days.
2. ❌ **Determinism baseline** → [`tracker/02-determinism.md`](tracker/02-determinism.md). Pin kernel + OCCT; `/version` endpoint; doc carries `kernelVersion`; LLM seed capture stub. Precondition for evals. ~2–3 days.
3. ❌ **Topological naming — finish Phase 1B** → [`tracker/03-topological-naming.md`](tracker/03-topological-naming.md). Per-feature namer audit, 50-edit corpus at `b123d_server/__tests__/naming/`, 80% pass-rate gate, emit-path query support, picker → query conversion. **Not greenfield.** ~2–4 weeks.
4. ❌ **Constraint-graph: wire Queries through emit** → [`tracker/04-constraint-graph.md`](tracker/04-constraint-graph.md). The Query DSL exists; feature inputs don't use it yet. Resolve client-side at emit time; picker emits `qDescriptor`; AI emit schema accepts queries. ~1.5–3 weeks.
5. ❌ **Document Parameters dialog + expression evaluator** → [`tracker/05-parameters.md`](tracker/05-parameters.md). Named parameter table on the store; unit-aware expression parser; feature forms accept expressions. `Parameter` / `Equation` types already in catalog. ~1.5–2 weeks.
6. ❌ **Component + instance layer with stored-doc migration** → [`tracker/06-components.md`](tracker/06-components.md). v4 → v5 schema migration; path-qualified IDs; component browser panel; per-component origin frames. Highest effort of Phase 1. ~4–8 weeks.

### Phase 2 — Accuracy backbone (makes "accurate" measurable)

**Restructured into 2a / 2b / 2c after the LLM-loop feedback exchange.**
The previous flat ordering buried cheap high-value work under expensive
multi-quarter workstreams and listed two parallel hardening efforts
that are actually one. Each spec under [`tracker/`](tracker/).

#### Phase 2a — Cheap-now tier (mostly non-LLM, bounded, days/weeks)

These ship before any LLM emit. They tighten the architecture's
*static-truth* guarantees and shrink the residual-risk surface
the AI loop has to cover.

7. ✅ **Measure as programmatic query API** → [`tracker/07-measure-api.md`](tracker/07-measure-api.md). 11 query types; 23+11 tests; PropertiesPanel rewired.
10. ✅ **Standard-parts library v1** → [`tracker/10-standard-parts.md`](tracker/10-standard-parts.md). 148 ISO entries; round-trip closed via StandardPart feature type.
11. ✅ **Cheap DFM guardrails** → [`tracker/11-cheap-dfm.md`](tracker/11-cheap-dfm.md). 5 checks, 3 profiles, 21 tests.
13. ❌ **Standard-parts relational fit check** → [`tracker/13-standard-parts-fit-check.md`](tracker/13-standard-parts-fit-check.md). Promoted out of "assembly checks"; spec 10 already ships catalog dims, spec 11 didn't cross-reference. Bearing OD vs bore Ø within ISO 286 band; thread engagement; clearance holes per ISO 273. **Bounded; ~3 days.**
14. ❌ **Query-resolver hardening + datum-relative placement** → [`tracker/14-query-resolver-hardening.md`](tracker/14-query-resolver-hardening.md). Unifies what the previous plan listed as parallel (topological-naming residual + datum-relative ops) — they're the same workstream. Kills `<last>` and ordinal refs; adds `expect: exactly-one` strictness; ships datum vocabulary (`from: 'corner-min-min-min'`, `face: <query>`); adds query-stability sweep to eval. ~2 weeks.

#### Phase 2b — The tiered spec compiler (Layers 1 + 2 + LLM residual)

Restructured from the original "Layer 1 = LLM compiler" framing.
Two-LLM-passes-against-the-same-model has correlated blind spots
(self-grading recursion). Structural independence comes from
deterministic + curated layers under the LLM.

15. ❌ **Deterministic spec extractor (Layer 1)** → [`tracker/15-deterministic-extractor.md`](tracker/15-deterministic-extractor.md). Grammar/parser for ISO codes, dimensions, fit classes, fastener callouts, tolerances, materials, processes. Pure JS, no LLM. ~2 weeks; corpus-grounded against existing engineering documentation.
16. ❌ **Invariant constraint library (Layer 2)** → [`tracker/16-invariant-library.md`](tracker/16-invariant-library.md). ~25 hand-curated always-applies constraints (manifold, fastener engagement, bearing fit, material assigned, etc.). The implicit-constraint floor models forget because they think they're free. ~2 weeks.
8. ❌ **AI emit + repair loop (Layer 3 residual)** → [`tracker/08-repair-loop.md`](tracker/08-repair-loop.md) — **scope amended** to consume Layers 1+2 as authority. Op generator stays; spec→acceptance is now tiered (deterministic + invariants + LLM residual). Coverage gate at reify time. Bootstrap loop labeled self-grading for corpus building. Plan-delta vs kernel-delta repair classification. ~3-4 weeks once 14+15+16 are real.
9. ❌ **Assumptions manifest** → [`tracker/09-assumptions-manifest.md`](tracker/09-assumptions-manifest.md). Structured intent capture + overridable chips. ~1-1.5 weeks. Material now tagged with downstream dependencies (DFM, standard-part selection) so overrides re-run exactly the affected stages.
12. ❌ **Eval corpus + automated assertions** → [`tracker/12-eval-corpus.md`](tracker/12-eval-corpus.md) — **amended** with new metrics: constraint coverage rate, query stability, per-invariant pass-rate, cost-per-accepted-part. CI gate + nightly full run. ~2 weeks.

#### Phase 2c — The second oracle (kinematics)

The static-truth oracle (kernel + measure) doesn't extend to
articulated mechanisms. Reach, swept-volume interference,
singularities, joint torque envelopes require config-space
integration, not bigger measure queries. **A second engine bolts
alongside; this is its own multi-quarter workstream.**

17. ❌ **Kinematics oracle (scoping)** → [`tracker/17-kinematics-oracle.md`](tracker/17-kinematics-oracle.md). Engine choice (PyBullet / Drake / custom). Joints stop being F6 stubs. Multi-quarter. **Not on the near-term roadmap**; the doc exists to keep "kinematics is just another measure query" from sneaking back in.

### Phase 3 — Auditable-dimension layer (cluster, designed together)

13. ❌ **Dimensional provenance chain** — intent → param → feature → face on every critical dimension.
14. ❌ **General tolerance band metadata** — ±0.1 vs ±0.01 changes process/cost/inspection; sits on top of nominal geometry.
15. ❌ **Critical-dimension extraction** — AI emits the inspection-plan view alongside geometry.

### Demoted (important, but below foundation)

- ❌ **Press-Pull** — blocked on #3.
- ❌ **Sketch-on-face** — blocked on #3.
- ❌ **Custom construction planes** (offset / 3-point / through-face).
- ❌ **Align command** (stub today).
- ❌ **Tangent Arc / 3-point Arc / Text tool / Conic / Construction-line toggle** — pure Fusion sketch parity.

### Park (harvest from the loop once it exists)

- ❌ **Failure-pattern catalog** — extrude-then-fillet-then-shell works; shell-then-fillet-on-shelled-edge often fails. Build by harvesting repair-loop error logs at volume; optimization *on top of* #7 + #8, not foundation.

### Out of scope for v1 mission

- 🚫 Surface modeling (kernel-bound + scope; raw OCP via BuildScript as escape hatch).
- 🚫 Form / T-Spline sculpt (different kernel; not the mission).
- 🚫 Simulation, CAM (multi-quarter, separate domains).
- 🚫 Drawings (defensible bet *after* #6 lands).

---

## Effort tiers (legacy, kept for reference)

- **Tier A** (days–weeks each): Press-Pull, Project Geometry, sketch-on-face, Tangent Arc, 3-point Arc, Parameters dialog, Construction toggle, Custom planes, Align, Measure.
- **Tier B** (1–3 months each): Components+joints, Drawings, Render, Sheet metal, Cloud collab.
- **Tier C** (multi-quarter / team): Simulation, CAM, T-Spline sculpt, Generative.
- **Tier D** (kernel-bound): Surface modeling ops — build123d's NURBS surface API is thinner than Fusion's underlying kernel; hit walls before UX.

> Note: tier classification is effort-only. The phased block above is the
> *dependency-ordered* sequence — many Tier-A items are now demoted because
> they're blocked on foundation work.

---

## Modeling kernel

### Primitives (4 / ~10)
- ✅ Box ✅ Cylinder ✅ Sphere ✅ Torus
- ❌ Cone ❌ Pipe ❌ Wedge ❌ Coil ❌ Pyramid

### Sketch → Solid (5 nominally wired, 2 to verify)
- ✅ Extrude (amount, both-directions, taper)
- ✅ Revolve (angle, X/Y/Z axis)
- 🟡 Sweep — in [emit.js](lib/document/emit.js), verify end-to-end against kernel
- 🟡 Loft — same; verify
- 🟡 Helix — reference-geom only (used as sweep path)
- ❌ Rib ❌ Web ❌ Emboss
- ⚠️ Thread — `add_thread()` returns body unchanged (Phase 0 stub)

### Modifiers
- ✅ Fillet ✅ Chamfer ✅ Shell ✅ Hole (simple / counterbore / countersink)
- ✅ Offset3D
- ⚠️ Draft (stub) ⚠️ Press-Pull (stub) ⚠️ MoveFace (stub) ⚠️ DeleteFace (stub) ⚠️ ReplaceFace (stub)
- ❌ Offset Face ❌ Combine (booleans cover most cases)

### Booleans
- ✅ Union ✅ Cut ✅ Intersect ✅ Split

### Patterns
- ✅ Linear ✅ Circular ✅ Path ✅ Mirror
- ❌ Pattern-on-face ❌ Derived patterns

### Transforms
- ✅ Move ✅ Rotate ✅ Scale
- ⚠️ Align (stub, Phase 3A)

### Construction geometry
- ✅ Plane (data type) ✅ Axis ✅ Point
- ❌ Construction Plane creation UX (offset / 3-point / through-face / mid)

### Parameters / Equations
- ⚠️ `Parameter(name, value, unit, equation)` — type exists, emits `p_<name> = value`
- ⚠️ `Equation(name, expression)` — type exists, emits raw expression
- ❌ Document-level parameters dialog
- ❌ Expression parser in feature forms (you type `20`, not `2*width`)
- ❌ Unit-aware arithmetic (`1in + 5mm = 30.4mm`)

### Scripted
- ✅ BuildScript — raw user Python passthrough

---

## Sketcher (strongest area)

### Drawing tools (16)
- ✅ Select ✅ Line ✅ Rectangle ✅ Circle ✅ Polygon (N-gon)
- ✅ Slot (linear + arc; no 3-point) ✅ Spline (NURBS / fit-point)
- ✅ Dimension ✅ Fillet ✅ Chamfer ✅ Offset ✅ Trim ✅ Extend
- ✅ Mirror ✅ Linear Pattern ✅ Circular Pattern
- ❌ Tangent Arc ❌ 3-point Arc ❌ Text tool (entity exists)
- ❌ Conic (parabola / hyperbola) — ellipse entity exists, no tool
- ❌ Project Geometry ❌ Intersect Geometry ❌ Break
- ❌ Construction line mid-tool toggle

### Geometric constraints (12)
- ✅ Coincident ✅ Horizontal ✅ Vertical ✅ Parallel ✅ Perpendicular ✅ Tangent
- ✅ Equal-length ✅ Equal-radius ✅ Midpoint ✅ Point-on-line ✅ Point-on-circle
- ✅ Symmetric
- ❌ Curvature (spline blending)

### Dimensional constraints (6, all driving)
- ✅ Fixed Distance ✅ Fixed Radius ✅ Fixed Angle ✅ Fixed Point
- ✅ Horizontal Distance ✅ Vertical Distance
- 🟡 Driven vs reference — all dimensions are driving; no read-only reference dim

### Planes
- ✅ XY ✅ XZ ✅ YZ (stock)
- ⚠️ `SketchOnFace` feature type exists — no face-pick UX wired
- ❌ Offset plane ❌ 3-point plane ❌ Through-face/edge plane ❌ Mid-plane

### Sketcher infra
- ✅ Re-enterable sketches
- ✅ Constraint solver (live during draw)
- ❌ Inferencing during draw (auto-snap horiz/vert/perp from nearby geom)
- ❌ DoF count display

---

## Workspaces (1 of 8)

| | Workspace | Notes |
|---|---|---|
| 🟡 | **Design (Studio)** | Solid + sketch, no assembly |
| 🟡 | **Sketch sub-mode** | Sketching only — NOT Fusion's Form/T-Spline |
| ❌ | Generative Design | |
| 🟡 | Render | Inspector ScenePanel = 8 swatches + 4 finishes + 4 lighting presets. Real workspace = HDRI, ray-tracing, appearance library |
| ❌ | Animation | |
| ❌ | Simulation | |
| ❌ | Manufacture (CAM) | |
| ❌ | Drawing | |
| ❌ | Sheet Metal | |
| ❌ | Form / T-Spline (Sculpt) | Different kernel — build123d won't help |

---

## Assembly / Components / Joints (0 working)

- ❌ Component hierarchy — document is a flat feature timeline
- ❌ Component instances (reuse same part)
- ❌ Sub-assembly nesting
- ❌ Per-component origin frames
- ❌ Activate-component context
- ❌ External component references (.f3d / .step link)
- ⚠️ `InsertComponent` — emits `import_step()` + `translate()` (basic)
- ⚠️ `JointRigid` `JointRevolute` `JointSlider` `JointCylindrical` `JointPlanar` — all 5 emit comment stubs (Phase 3B)
- ❌ `JointBall` ❌ `JointPinSlot`
- ❌ Contact sets ❌ Motion link
- ❌ Motion study timeline
- ❌ As-built joints
- ❌ Capture position / new position

---

## Import / Export

### Import (1 of 5 reliably working)
- ✅ `.glb` / `.gltf` — three's GLTFLoader, Y-up→Z-up applied, lazy-loaded
- 🚫 `.step` / `.iges` — occt-import-js wired but `path`/`crypto` Node deps fail in browser; needs bundler shim
- ❌ `.obj` (listed only) ❌ `.f3d` ❌ `.x_t` ❌ `.sat` ❌ `.dwg`

> Imported geometry rides as raw `THREE.Group` on the scene — not a feature, won't survive reload, no feature-tree entry, can't be exported.

### Export (3 real, 4 fall back)
- ✅ STL binary ✅ STEP ✅ BREP
- 🟡 STL ASCII (collapses to binary)
- 🟡 3MF / OBJ / glTF (cards in dialog, fall back to STL with inline warning)
- ❌ 3MF / OBJ / glTF real exporters
- ❌ DXF / DWG (Fusion's drawing-export targets)

---

## Drawings (0)

- ❌ Sheets ❌ Orthographic projections ❌ Section views ❌ Detail views ❌ Broken views
- ❌ Dimensions / Annotations ❌ Centerlines / Centermarks
- ❌ Balloons + BOM table ❌ Title blocks
- ❌ PDF / DWG / DXF export from drawings

---

## Render workspace (~0)

- 🟡 Scene & Material inspector panel (8 color swatches, 4 finishes, build-plate select, 4 lighting presets, intensity slider) — see [ScenePanel.svelte](src/lib/components/studio/inspector/ScenePanel.svelte)
- ❌ Appearance library (PBR materials, textures) ❌ HDRI environments
- ❌ Ray-traced output ❌ Cloud render
- ❌ Decals ❌ Scene setup ❌ Turntable / animation render

---

## Animation / Storyboard (0)

- ❌ Keyframe timeline ❌ Joint-driven motion ❌ Exploded views
- ❌ Camera animation ❌ MP4 / GIF export

---

## Simulation (0)

- ❌ Static stress ❌ Modal frequency ❌ Thermal ❌ Buckling ❌ Nonlinear
- ❌ Mesh generation ❌ Contact constraints ❌ Results visualization

---

## Manufacture / CAM (0)

- ❌ 2D milling ❌ 3D milling ❌ Turning ❌ Additive ❌ Waterjet
- ❌ Probing ❌ Setup / fixture ❌ Toolpath simulation
- ❌ Post-processor library

---

## Sheet metal (0)

- ❌ Flange ❌ Bend ❌ Unfold ❌ Flat Pattern ❌ Rip ❌ Hem ❌ Bead ❌ Lofted bend

---

## Surface modeling (0)

- ❌ Surface Extrude / Revolve / Sweep / Loft
- ❌ Patch ❌ Stitch ❌ Thicken ❌ Boundary Fill
- ❌ Trim ❌ Extend ❌ Unstitch ❌ Reverse Normal
- 🚫 Kernel-bound — build123d surface API thinner than Fusion's

---

## Collaboration / Data

- ✅ localStorage autosave (single user, single browser)
- ❌ Cloud sync ❌ Version history beyond Ctrl+Z ❌ Comments
- ❌ Share-link viewer ❌ Real-time co-edit
- 🟡 Explore / Manage / Auth views — UI stubs, no backend
- ❌ Project hub ❌ Data panel ❌ Real upload backend ❌ Real auth

---

## Built-in library

- ✅ 12 items in [catalog.js](src/lib/library/catalog.js) across Primitives / Brackets / Enclosures / Fasteners / Joints
- ❌ McMaster-Carr / Misumi fastener integration
- ❌ Parametric instances (every Insert creates a fresh feature chain)

---

## UX polish

| | Item | Notes |
|---|---|---|
| ❌ | Timeline scrub | Roll history marker to suppress later features |
| ❌ | Component visibility tree | Per-component body/sketch/origin toggles |
| ❌ | Origin sketch | XYZ planes / axes / point visible per component |
| 🟡 | Selection filter | 'Bodies' option filters everything out — descriptor.kind is face/edge/vertex only |
| ❌ | Direct manipulation gizmo | 3-axis manipulator for face drag, joint origin |
| ❌ | Sketch inferencing | Auto-snap horiz/vert/perp from nearby geometry |
| ❌ | Measure tool | Point-to-point / edge length / face area / interference |
| ❌ | Section analysis | Clipping planes |
| ❌ | Interference check | Between components |
| ❌ | Curvature comb | Spline analysis |
| ❌ | Marking menu | S-key radial command wheel (CommandPalette covers search use case) |
| 🧪 | Browser smoke test | Nothing across v0.23..v0.27 has been clicked end-to-end |

---

## Cross-cutting infra

- 🟡 Selection model — descriptors with featureId + bodyKey + kind; **topological naming problem** (face IDs surviving topology-changing edits) unproven
- ✅ Units module — mm/cm/m/in, decimals
- ❌ Unit-aware arithmetic in expressions
- ✅ Light/dark theme switch (v0.27)
- 🚫 Scene tones (gradient bg, grid, lights, default material) hardcoded dark — needs theming pass
- ✅ Bridge timing instrumentation (lastCompileMs / lastRenderMs)
- ❌ Lazy three.js chunk (~350-400KB savings; needs async-component refactor)

---

## Tier-A quick wins shortlist

These items should each be doable in days–weeks. They're the highest UX/value-per-effort ratio.

| | Item | Why high-value | Where it lives today |
|---|---|---|---|
| ❌ | Press-Pull | THE direct-edit workhorse | `addPushPullFace` stub in [operations.js](lib/document/operations.js) |
| ❌ | Project Geometry | Compose parts from existing edges | Sketcher tool list, [controller.js](app/sketch_3d/controller.js) |
| ❌ | Sketch-on-face | Escape XY/XZ/YZ | `SketchOnFace` type exists in [types.js](lib/document/types.js) |
| ❌ | Doc Parameters dialog | Real parametric workflow | `Parameter` type exists |
| ❌ | Tangent Arc / 3-pt Arc | Common Fusion sketch ops | Sketcher tool list |
| ❌ | Custom planes | Construction Plane creation UX | Plane data type exists |
| ❌ | Align command | Heavily-used in Fusion | `Align` is a stub |
| ❌ | Measure tool | "Is this the right size" check | Inspect → Measure pattern |
| ❌ | Construction-line toggle | Mid-tool flag during draw | — |
| ❌ | Real STEP browser import | Unlock asset library | Needs occt browser shim |

---

## Maintenance

- Update status emojis as items ship.
- When a feature lands, link the commit/PR next to it.
- New gap discoveries from user feedback → add under the matching section.
- When a Tier promotes (e.g. someone proves NURBS surface work in build123d), shuffle.
