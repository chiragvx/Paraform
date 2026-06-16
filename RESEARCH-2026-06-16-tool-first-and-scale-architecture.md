# Tool-First Generators + Scale Architecture — Future-Phase Vision

**Status:** Parked 2026-06-16. Discussion only — **no implementation yet**. This is a
direction doc to pick up cold in a later phase. The running method of the discussion was
"poke holes": every time a single bottleneck was proposed, it turned out to be a *layered*
system, and the real value was separating concerns that were being conflated.

---

## Part 1 — Tool-first / domain-generator vision

**Motivating failure.** Asked to "build a laptop stand," the AI can't even define the
artifact, let alone assemble it from primitive ops (fillet/shell/extrude). The current
pipeline asks the LLM to be a CAD engineer from first principles using low-level ops. That
is the foundational flaw.

**Two *distinct* failures hide in this complaint (do not conflate):**

1. **Geometry generation** — even knowing what it wants, the LLM can't produce the
   geometry (NACA camber math, involute gear tooth, gyroid cell). It hallucinates
   plausible-but-wrong math. → Fixed by **parametric generators**.
2. **Specification / decomposition** — the AI can't figure out *what a thing is*
   functionally (laptop stand = inclined surface @ θ + stability footprint + anti-slip lip
   + cable channel + vents). This is NOT geometry-math; it's that the AI reasons in
   primitives instead of *functional features*. → Fixed by a **functional decomposition /
   planning vocabulary**, not by more generators.

**The reframe that unifies both:**
> The generators become the **planning vocabulary**. When the planner thinks in
> {airfoil, spar, rib, lattice-fill} instead of {extrude, loft, shell}, both planning AND
> generation happen at the altitude of engineering intent. Engineering knowledge moves out
> of the LLM's reasoning and into deterministic, validated tools. (Consistent with the
> existing finding: "accuracy is in the scaffold, not the model.")

**Altitude question (where tool designs go wrong):**
- Too low (`fillet`, `shell`): LLM must compose everything → fails today.
- Too high (`make_laptop_stand`): infinite long tail, template gallery, zero differentiation.
- **Right (`airfoil(naca, chord)`, `spur_gear(module, teeth, pressure_angle)`):** a
  parametric **domain primitive** — a *family* of real artifacts, parameterized by the
  *industry's own parameters*.

**Test for a good tool:** does it encode knowledge the LLM provably can't reproduce,
parameterized the way a domain expert would describe it? Heuristic: *build tools in inverse
proportion to how well the LLM already does them, weighted by how often the target domain
needs them.*

**Taxonomy of "more-than-one-function" tools:**

| Class | Examples | Encodes (LLM can't) |
|---|---|---|
| Section generators | airfoil (NACA/Selig), gear (spur/helical/bevel/rack), thread (ISO/ACME), timing pulley (GT2/HTD), sprocket, cam, spring | profile math |
| Fill / structure | lattice infill (gyroid/honeycomb/octet), ribbing/gusseting, topology-lite | cellular geometry + printability |
| Functional features | snap-fit cantilever, living hinge, heat-set insert boss, bearing seat, shaft coupler | load/strain limits |
| Kinematic subassemblies | n-bar linkage, parallel-link leg (SpotMicro), lead-screw stage, gear train | DOF + clearance |
| Packaging | PCB-aware enclosure (board outline → standoffs/ports/vents) | fit to a real component |

---

## Part 2 — Math-first feasibility (the gearbox stress test)

**"Ratio in → gearbox out" is NOT feasible as a black box.** Decomposed:

1. Tooth profile — pure involute math. **Fully feasible / bedrock.**
2. Train selection — integer/Diophantine optimization (factor R into stages, integer teeth,
   min ~17T to avoid undercut). Feasible, but it's a **solver you write**, not a formula.
3. **Underspecification** — ratio alone can't size gears; *module* comes from *torque*
   (tooth stress), not ratio. Need torque + RPM + material + envelope, or every output
   shears under load. The naive input set is wrong.
4. Shaft layout / packing — 2D packing search, not closed-form.
5. The real artifact (housing, bearings, shafts, retention) is ~80% of a gearbox; gears ~20%.

**"Math-first" is four tiers, not one thing:**

| Tier | What | Gearbox piece | Feasible? |
|---|---|---|---|
| Closed-form geometry | formula → shape | involute tooth | ✅ fully |
| Constrained solver | search under constraints | train factorization, module-from-torque | ✅ needs right inputs |
| Layout / packing | spatial arrangement | shaft centers, stage stacking | ⚠️ heuristic/search |
| Architecture synthesis | *which* topology | parallel vs planetary vs harmonic | ❌ templated choices only |

A feature is "cleanly math-first" only to the degree its tiers sit high in this table. Don't
ship a black-box gearbox — ship "pick a topology template → solve the train → generate the
teeth," exposing the tier where it becomes deterministic.

**Second, separate limit — the kernel, not the math:** some features are math-trivial but
**kernel-expensive or numerically fragile**:
- **Threads** — helix math is trivial, but cutting a real thread is an expensive/fragile
  OCCT boolean. Industry default = **cosmetic threads**, cut real only on export.
- **Lattices** — gyroid is a clean implicit field, but trimming it to a shell is a
  million-triangle boolean. Limit = compute budget, not the surface equation.

So tag every tool by **two limits**: closed-form? AND can OCCT produce it fast/robustly?

**"Normalize" = extract a small shared math basis** and express every feature as
composition + solver over it:
- Parametric profile (formula → 2D wire): involute, NACA, thread section, structural section, cam.
- Section-along-path (loft/sweep/revolve w/ twist+scale): wing, thread, spring, worm.
- Implicit field → volume: gyroid/honeycomb/lattice.
- Pattern/transform engine (already exists: `tools_patterns.js`).
- **Constraint solver** — the one genuinely *new* infra (not geometry): integer/continuous
  optimization for teeth, module-from-load, beam sizing, bolt spacing.

So `spur/helical/bevel/planetary/rack` all collapse to: involute profile + path primitive +
pattern engine + solver. ~5 primitives + 1 solver cover most geometry; everything else is
composition.

**Methodology (amended):**
1. **Feature inventory** — 20–40 functional features in the target domain.
2. **Tier + limit classify each** — which of the four tiers it spans, and whether the
   binding limit is *math* or *kernel*. ← This step decides which features can be normalized.
3. **Extract the shared basis** from the closed-form tiers.
4. **Build each feature = basis composition + solver + (sometimes) a small template library.**

The deliverable of step 2 is the most valuable artifact: **the line between "deterministic
generator" and "needs template/library/LLM-proposes-then-math-validates."** Drawing that
line *is* the architecture.

---

## Part 3 — Communication layer & how the leaders handle it

The kernel is **server-side** (b123d_server / OCCT on an HF Space); the browser is a thin
three.js viewer. Complexity is paid across **three walls**, and for the hard tools the
browser is the *tail*, not the head:

| Wall | Where | Chokes on | Hits first for |
|---|---|---|---|
| 1. Kernel / OCCT | server CPU | boolean trim, real-thread cut, meshing dense B-rep | lattice, threads, dense booleans |
| 2. Transport / serialize | network | shipping million-tri mesh + per-edge polylines | anything big after wall 1 |
| 3. Browser render | GPU + CPU | draw calls, GPU upload, **EdgesGeometry extraction** | only what survives 1–2 |

Existing cache/incremental-compile speeds **re-edits**, not the first novel boolean
("novel OCCT is irreducible").

**The reframe:** *B-rep boolean is the wrong representation for field/repetition geometry.*
Industry (nTopology) does lattices via **implicit modeling / signed-distance fields** —
intersect the shell SDF ∩ lattice SDF, mesh once at the end. OCCT B-rep is where lattices
and threads go to die.

**Two different problems → two different industry answers:**

| Problem | Bottleneck | Solved by | How |
|---|---|---|---|
| Lots of *ordinary* geometry | transport + render | **Onshape** | streaming architecture |
| Dense *field* geometry (lattice) | kernel boolean | **nTopology** | implicit/SDF kernel |

**Onshape architecture (the mature version of our stack):** Parasolid kernel server-side;
browser thin WebGL client holding **only triangles, never B-rep**. Sophistication is all in
streaming — (1) **view-dependent progressive LOD** tessellation (screen-space error, finer
on zoom), (2) **graphics deltas** not full re-sends, (3) compressed binary + occlusion.
Onshape with all its streaming would still choke on a gyroid — it's still B-rep underneath.

**Our gaps vs Onshape:** no view-dependent LOD (presets are global), no sub-body graphics
delta / progressive stream (we ship full GLB mesh). We DO have some delta-ness (incremental
compile, bridge skips unchanged code, per-leaf tagging).

**Implication:** two separable bets — (1) comms/streaming upgrade (copy Onshape; benefits
every B-rep tool) and (2) implicit/SDF path (copy nTopology; the *only* way lattice/infill
ships). Each candidate tool rides one lane. Gears/airfoils/threads/brackets = B-rep +
better-streaming lane; lattice/infill/organic = implicit lane or it doesn't ship.

**Third classification axis added:** every tool tagged by (a) math tier,
(b) binding limit (math vs kernel), (c) **representation** (B-rep-OK / needs-proxy /
needs-implicit).

---

## Part 4 — Scaling for ultra-complex parts (engine, cockpit) + new architecture

**Reframe:** "ultra-complex part" here = ultra-complex **assembly**, not ultra-complex
*geometry*. An 8-cyl engine = ~1,500 *moderate* parts (block, 8 pistons, 8 rods, crank,
hundreds of bolts). Per-part B-rep is fine. The killer is **count, instancing, composition**
— NOT kernel blowup. So the lattice fear (wall 1) is mostly not the enemy here;
**materialization** is — any layer that touches the *whole* model at once.

**Unifying principle:**
> **Bound the working set, not the model.** Full engine can be arbitrarily large on the
> server; the live/interactive/in-context footprint stays bounded regardless of total size.
> Hierarchy + references + caching + laziness at every layer — never materialize the whole
> (not in fold, kernel, transport, browser, or AI context). This is how CATIA/NX run a whole
> aircraft on a workstation.

**Where the stack breaks, in order (assembly scale):**

| # | Wall | Breaks at | Fix |
|---|---|---|---|
| 1 | Emit/fold whole doc per edit | ~100 parts | per-**part/subassembly** compile units + dependency DAG |
| 2 | Instance explosion (8 pistons = 8 unique compiles) | ~hundreds | instance-aware: compile once, reference N× with transforms |
| 3 | Browser render (thousands of meshes) | ~few thousand | `InstancedMesh` + frustum/occlusion culling + LOD + lazy load |
| 4 | AI reasoning (flat 1,500-part list) | ~dozens | hierarchical plan-graph; edit one subassembly; summarized digest |
| 5 | Cross-part ops (clash, mass, section) | ~hundreds | spatial index (BVH/hash), pairwise not fused |

**How aerospace/auto future-proofed:** strict part/assembly separation (assembly =
references + mates, never refold parts); lightweight tessellated viz reps + LOD (B-rep stays
server-side); design-in-context / load-on-demand working set; instancing; spatial
partitioning. Boeing never loads a full 747 B-rep.

### The "show ALL parts at once" question + new architecture

**Key correction:** showing everything is the *cheap* axis (display/GPU — games render a
whole city). The trap is assuming "show everything" ⇒ "compute everything." A shown-but-not-
edited part is **static bytes on the GPU**; no kernel touches it.

**New architecture = decouple the 3 concerns the current execute→mesh→render pipeline fuses:**

| Tier | Job | Holds | New approach |
|---|---|---|---|
| **Display** | show *everything* | all parts as baked meshes | GPU-driven renderer (**WebGPU**): instancing + culling + LOD; static parts ~free |
| **Compute** | edit *one thing* live | active part/subassembly B-rep | **stateful resident kernel** — recompute the edit, emit a graphics delta; rest cost zero |
| **Data** | hold *everything* | parts + instances + mates as references | referential, incrementally-materialized scene graph (per-element addressable, DB-backed) |

> render = whole model; compute = bounded working set; wired so the first never forces the second.

**Three bold moves, rated:**
1. **Stateful resident kernel** — *highest leverage / the real fork.* Today we're stateless
   (re-emit + recompile from changelog every time → fatal at 1,500 parts). Hold the
   assembly B-rep resident in a live session, accept *edits* (deltas) that mutate in place,
   recompute only the touched part. This is what Onshape does. **Worth it.**
2. **WebGPU GPU-driven display tier** — *worth it, lower risk.* three.js already has a
   WebGPU renderer; compute-shader culling shows the whole engine. Mostly game-engine
   technique, stageable.
3. **WASM kernel in browser** — *trap at this scale.* Full resident B-rep in OCCT-WASM hits
   browser memory (~2–4 GB) + single-thread. Viable only as **hybrid**: WASM holds *only the
   active part* for instant local edits; server stateful kernel stays authoritative. Later.

**UX this unlocks (better than Onshape):** one editor, whole engine visible,
**click any part to make it "live"** (promotes it from baked display tier into compute tier,
in-place, no Part-Studio/Assembly tab split). Fits the AI-native, approachable positioning.
The AI does the same — focuses compute on one subassembly, sees the rest as summarized
hierarchy.

---

## Cross-cutting prerequisite: the four seams (do these first — cheap, prevent a rewrite)

Future-proofing is NOT "build the CATIA/streaming stack now." The thing that kills you is
baking in a flatten/materialize-everything assumption so deep that adding hierarchy later
means a rewrite. **Harden the seams now; defer the heavy machinery:**

1. **Compile unit = part/subassembly**, not the document (cache keyed per-part).
2. **Instance ≠ copy** — first-class in the data model.
3. **Incremental fold** — snapshot + replay the tail, not O(n) refold.
4. **Hierarchical / summarized AI digest** — tree with counts + roles, not a flat dump.

Get these right and model size is unbounded *in principle*; the WebGPU display tier and the
stateful resident kernel become **additive upgrades**, not rewrites.

---

## Open decisions for the later phase

1. **Tool-first scope** — lock Tier-1 generators to the functional-machine / robotics domain
   (lean), or go broad (airfoil etc.) for a breadth demo?
2. **Implicit/SDF kernel** — core to differentiation (changes the kernel story now) or a
   later luxury (lane 1 alone gets most functional-machine tools)?
3. **Self-extending tool library** — AI authors + saves new parametric generators (a
   generator is just parameterized, validated build123d w/ a typed signature, and
   `writeBuildScript` already exists), or hand-curate the catalog?
4. **Generators replace vs. sit above the typed-op vocabulary** for the AI?
5. **Scale machinery now vs. just harden the four seams now** and defer? (Rec: latter.)
6. **Forks:** stateless → stateful resident kernel (editing-at-scale) and WebGL → WebGPU
   (showing-at-scale) are independent. Rec: prove WebGPU display first, design the kernel
   seams in parallel.

## Immediate next artifacts (when picked up)
- The **feature-inventory + tier/limit/representation classification** table (Part 1+2+3
  axes) for the functional-machine domain — decides where the deterministic/non-deterministic
  line falls before any tool is built.
- A **seams audit** of the current compile-unit / fold / instance model — where the
  flatten-everything assumptions actually live (the real rewrite-risk).

## Related
- Competitive analysis (accuracy in the scaffold; connector/mate moat) — `project_competitive_analysis_t2c`
- Functional-assembly north star (machines not boxes; NovaSpotMicro) — `project_functional_assembly_vision`
- Deterministic design plan (plan-graph, DOF solver, BOM, pattern tools) — `project_deterministic_design_plan`
- Compile interactivity perf (hide-flag, incremental compile, EdgesGeometry memo) — `project_compile_interactivity_perf`
- AI context + project structure (what the model sees per turn) — `reference_ai_context_and_project_structure`
