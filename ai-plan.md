# The Intelligent Text-to-Design Assistant — Vision & Capability Plan

*A descriptive vision for what an AI chat for text-to-design (3D printing + assembly) should
consist of: capabilities, the concrete tool surface, and how the chat itself should behave.
Synthesized from a 10-agent exploration grounded in this studio (build123d/OCCT kernel,
the 9-rule connector contract, the mate solver) and a scan of the competitive landscape.*

---

## The one big idea

An intelligent design chat is **not a model that writes geometry once**. It's an **agent that loops**:

> *capture intent → propose → emit parametric code → compile on the kernel → **measure and see** the result → critique against requirements → repair → report verified numbers.*

Three commitments separate a serious tool from a toy:

1. **Parametric, never mesh.** The serious field (Zoo's KCL, Adam, CadQuery/build123d, the
   LLM-for-CAD research line) is converging on emitting *editable parametric code* over a real
   B-Rep kernel. Mesh gen-AI (Meshy, Sloyd, Spline) is a separate, non-functional lane —
   pretty blobs with no dimensions, tolerances, or STEP. Our build123d/OCCT architecture is
   already on the winning side.
2. **The kernel is the arbiter.** The assistant never *asserts* a dimension, fit, or clearance
   from the numbers it typed into an op — it states only what it *measured* on the freshly
   compiled body. `measure` already enforces this; the vision makes it a habit.
3. **Assembly + print-readiness are the moat.** Almost every competitor stops at a single part.
   None ship a real connector/mate contract producing fixed/revolute/prismatic joints, and *no
   conversational tool validates printability at all*. Our 9-rule connector contract + mate
   solver is a genuine differentiator — and DfAM is wide-open territory.

---

## Where we are today (the honest baseline)

The AI surface (`src/lib/ai/tools.js`) is already real: primitives, fillet/chamfer/shell/hole,
booleans, patterns, `add_casing`, library search/place/mate, `replace_component`, document
parameters, `measure`, `run_invariants`. The agent loops up to 12 iterations over a
provider-agnostic tool layer (OpenAI-compatible GPT-OSS + Gemini). The system prompt already
encodes "kernel is the arbiter," Z-up/mm, parts-before-primitives, and connector immutability.

The load-bearing **gaps** that define the roadmap:

- **The AI cannot author a sketch.** `addExtrude`/`addRevolve` need a `sketchFeatureId` no tool
  creates. All profile-driven mechanical modeling is unreachable. *Biggest single functional gap.*
- **The AI is blind.** `measure`/`run_invariants` return numbers; the model never *sees* the GLB
  it produced. No screenshot-and-look.
- **No connectors on custom geometry.** The AI can only mate pre-authored library parts; a
  hand-built plate is an assembly dead-end.
- **No print-readiness loop.** No STL/3MF export tool, no DfAM checks — the stated end goal (a
  printable part) has no closing tool.
- **No precise placement.** The rich face/edge picking and query DSL exist, but the AI drills
  holes at the origin along +Z; it can't say "the top face" or "this picked edge."
- **Single-shot, no preview/diff/plan, in-memory history only.**

The eight pillars below close exactly these gaps.

---

## Pillar 1 — The conversation layer: a CAD-literate collaborator

**Capabilities**
- **Intent → visible Design Brief.** Distill "a holder for my Pi" into an *editable card*:
  function, key dimensions, fits, material, target printer, open unknowns — each inferred default
  tagged with its source. Most CAD failures are *spec* failures; surface the brief before a
  single triangle compiles.
- **Surgical questions.** Ask only the 2–3 unknowns that *change the geometry or fail the print*,
  batch with smart defaults, never re-ask. Fixes the current "ask ONE question" rule, which both
  under-asks and over-nags.
- **Persistent design context.** A durable noun→id map ("the bracket" = `box_3`), a decision log
  with rationale, declared units/constraints — serialized with the document so a 20-turn session
  and a reload stay one continuous conversation.
- **Conversational revision with dry-run diff.** "Make the walls 2 mm thicker" → preview *before
  committing*: "wall 2.4→4.4, but the Pi no longer fits (−9.6 mm)." Revision without fear.
- **Explain-why on demand.** Every committed choice records its rationale at commit time, so
  "why 3 mm walls?" is a truthful lookup, not a post-hoc rationalization.
- **Graceful failure as dialogue, audience-adaptive register, live compile progress, opt-in
  next-step chips.**

**Tool surface (new):** `propose_brief`, `get_context`, `name_feature`, `needs_decision`,
`propose_edit`/`commit_edit`/`undo_last`, `explain_decision`, `repair_suggest`, `suggest_next`,
`summarize_turn`.

**Chat behaviors:** act don't stall; make assumptions visible; verify with the kernel; preview
risky edits; resolve nouns through context; treat failure as dialogue; close every turn with a
plain-language receipt of *what changed + the verified numbers*.

---

## Pillar 2 — Geometry generation & model editing (text → editable parts)

**Capabilities**
- **Text → sketch → extrude/revolve/sweep/loft** — the missing primitive. Author a real 2D
  sketch (lines, arcs, slots, polygons) on a plane or picked face, *then* solidify. Today the
  agent can extrude a sketch it cannot create.
- **Sketch constraints + DOF reporting** — fully constrain a profile (the Newton solver exists)
  and warn before extruding an under-constrained sketch.
- **Named parameters & equations** — `wall = 2`, `boss = wall + 2`; edit one number, the part
  reflows.
- **Regen-safe selection by *intent*** — "the top face," "all vertical edges," "edges from the
  last fillet" via the query DSL with explicit cardinality, so a fillet pinned to "the +Z rim"
  survives a parameter edit that renumbers topology. The single biggest robustness lever.
- **Surgical edits** — read the tree, find the *one* feature that owns an attribute, patch only
  it; don't regenerate from scratch.
- **Direct face edits, patterns/mirrors, shells/drafts, measure/query** as the verification verb.

**Tool surface:** `addSketch`, `addSketchEntity`, `addConstraint`, `querySketchState`,
`selectGeometry`, `getSelection`, extended `addFillet`/`addChamfer`/`addHole` (edge/face
selectors), `addRevolve`/`addSweep`/`addLoft`, `addDraft`, `addPushPullFace`/`moveFace`/
`deleteFace`, `explainFeature`, `suppressFeature`/`reorderFeature`. **Most are already lowered
in `emit.js` — just not exposed to the AI.**

**Pitfalls:** topology drift (refuse ordinal refs); Y-up/Z-up confusion; Euler-XYZ lock-step;
silent regenerate-from-scratch; asserting dimensions without measuring.

---

## Pillar 3 — Assembly, mating & mechanism intelligence (the moat)

**Capabilities**
- **Catalog-grounded placement** — resolve "M3×16 socket head" to a real verified part with
  declared connectors, never a stubbed box.
- **Mate-by-language, *audited*** — "bolt the bracket to the servo's top-left hole" → the chat
  *names the connector pair* it solved and the induced joint (`bracket.bore_tl → servo.thread_tl`,
  fixed), never silently grabbing `connectors[0]`.
- **Auto-mate / snap-all** — enumerate compatible pairs, anchor on a keyed dowel to resolve
  rotational symmetry, apply on one confirm.
- **Declare connectors on custom geometry** (create-only, locked) — the gap that turns "place
  catalog parts" into "design a real assembly." Enforces the 9 rules at the boundary.
- **Fit honesty in µm** — "press fit" → ISO 286 H7/r6 interference numbers *and* an FDM reaming
  caveat, not a nominal-equal bore that silently fuses.
- **Ecosystem awareness** — placing one 2020 rail or M5 names the implied stack (T-nuts +
  brackets; nut + washer + clearance hole).
- **Prove it moves** — articulate joints, run IK to a target, sweep the motion envelope for
  self-collision. *The kinematics stack (FK, IK, limits, mesh interference) already exists — just
  not exposed to chat.*
- **Sub-assemblies, instancing, BOM, exploded views + fit-aware assembly instructions** — all
  derived from the mate graph.
- **Swap-safe redesign** — SG90→MG996R re-binds mates by role→interfaceId→kind/size; unresolved
  mates surface as a punch-list, never a silent break.

**Tool surface:** existing `search_library`/`placeLibraryPart`/`add_mate`/`replace_component`;
new `auto_mate`, `declareConnector`, `resolve_fit`, `suggest_companions`, `articulate`,
`solve_ik`, `range_of_motion`, `check_motion_interference`, `group_subassembly`,
`instance_component`, `generate_bom`, `explode_view`, `assembly_instructions`.

**Pitfalls:** Euler-XYZ lock-step on every transform; never default gender to neutral; connector
immutability is *structural* (`{force}` stays system-internal); distinguish intended mate contact
from real collision.

---

## Pillar 4 — Design-for-Additive-Manufacturing (the gap everyone ignores)

**Capabilities**
- **Overhang & support analysis** — per-face normal vs. +Z build direction.
- **True minimum-wall probe** (not bbox heuristic) — thinnest material *anywhere*, in mm *and
  perimeter count* for the nozzle.
- **Build-orientation optimizer that reasons about the load path** — FDM parts are ~50% weaker
  across layers; reorient for ~2× strength and state the print-time trade.
- **Process-specific clearances** — concrete mm, not ISO grades no printer can hold: FDM slide
  ~0.4 mm/side, press ~0.1–0.2 mm interference, print-in-place gap 0.3–0.5 mm.
- **Material as a DfAM input** — "dashboard hits 60–70 °C → PLA sags, use ASA," then auto-adjusts
  wall thickness and corner chamfers.
- **Print-in-place mechanisms** — living hinges, snap-fits with computed cantilever strain.
- **Bridging/teardrop holes, multi-part plating, self-tap vs. heat-set vs. modeled-thread
  decisions, cost & time estimates.**
- **One-shot "will this print?"** → red/yellow/green verdict + one-click "fix it all," then re-run
  and report the delta.
- **3MF handoff** carrying DfAM decisions as per-object slicer settings.

**Tool surface:** `check_printability`, `analyze_overhangs`, `measure_min_wall`,
`optimize_orientation`, `analyze_bridges`, `recommend_material`, `compute_clearance`,
`compute_snap_fit`, `design_living_hinge`, `size_thread_interface`, `estimate_print`,
`plate_parts`, `export_for_print`, `repair_printability`.

**Pitfalls:** measure against world +Z; label time/cost as estimates; modeled fine threads in FDM
are a trap; present orientation as a Pareto choice.

---

## Pillar 5 — Validation & self-correcting feedback loops

**Capabilities**
- **Autonomous compile-failure repair** — the highest-leverage reliability change. The kernel
  already returns `{ok:false, error}` with a traceback; today the agent never sees it. Wire it
  back so the model reads the error + emitted source and applies the smallest corrective op,
  bounded (~3 attempts, per-error-signature counter to prevent thrashing).
- **Geometry validity gate** — watertight/manifold, self-intersection, min-wall — *obligatory*
  before claiming success.
- **Mass properties + budget check** — volume/mass/CoM/inertia, checked against stated budgets.
- **Lightweight structural sanity, explicitly non-authoritative** — closed-form beam estimate
  with confidence tag and assumptions; never presented as certified FEA.
- **Requirements ledger** — extract measurable requirements and re-verify after *every* edit.
- **Regression guard on edits** — before/after diff catches broken mates, new interferences,
  requirements flipped to fail.
- **Self-critique gate** — mandatory pre-summary pass; if *fix-needed*, the turn continues.

**Tool surface:** `compile_status`, `validate_geometry`, `mass_properties`, `structural_estimate`,
`record_requirement`/`verify_requirements`, `verify_dimension`, `snapshot_validation`/
`diff_validation`, `self_critique` — composed over existing `measure`/`run_invariants`.

**Pitfalls:** overclaiming FEA; unbounded repair loops; repair must flow through *typed ops*,
never raw Python; measure-cache staleness across a repair; don't hallucinate requirements.

---

## Pillar 6 — Parts library, knowledge base & manufacturing handoff

**Capabilities**
- **Faceted, McMaster-style catalog** — search by standard/thread/length/head/material *and
  connector compatibility with a selected host*.
- **Parametric generators** for unlisted sizes — any-length screw, custom 2020 extrusion, gears
  by module/teeth — kernel-correct and connector-stamped.
- **A knowledge base the AI *cites*** — ISO 286-2 fits, tap-drill/clearance tables, material
  properties — real deviations with their source standard.
- **Save-as-template** — promote a finished part/sub-assembly to a parametric, connector-bearing
  template.
- **True round-trip** — STEP in as *editable* B-Rep, build around it, export STEP/3MF/STL/GLB,
  with an honest fidelity note. (`import_step` already exists in the engine; the kernel already
  exports step/stl/brep — surface it + add 3MF.)
- **Versioning, sharing, and a sourcing BOM** (orderable vs. fabricate).

**Tool surface:** `search_catalog`, `get_part_detail`, `generate_part`, `kb_lookup`,
`save_template`, `export_design`, `import_step`, `generate_bom`, `snapshot_version`/
`diff_versions`, `share_design`.

**Pitfalls:** Y-up→Z-up on *every* import/export boundary; export fidelity honesty; fine
tessellation for print export; detect import units (inch STEP).

---

## Pillar 7 — Multimodal & viewport-grounded interaction

**Capabilities**
- **Sketch/photo/whiteboard → geometry** — reverse-engineer *design intent* into an editable
  feature tree (never trace pixels), stating interpretation, confidence, and assumed dimensions.
- **Dimension from a photo + scale reference** — "gear next to a 1-euro coin → ~38 mm OD,
  20 teeth, module ≈1.8" — the viral "I have the thing but no drawing" workflow.
- **Spatial deixis — "fillet THIS edge," "M3 hole HERE."** The pick-proxy layer *already* returns
  the exact OCCT descriptor on click; inject the live selection as ambient turn context.
- **AI-generated dimensioned drawings & section views** (drive the existing Z-up section plane
  from a picked face's normal).
- **Descriptor-anchored callouts** — leaders that ride the geometry across edits.
- **Visual before/after diff** — added volume green, removed red, plus a delta table.
- **Voice (push-to-talk)** — "click a face, hold-to-talk: countersink for an M4 right there."

**Tool surface:** `get_active_selection`, `ingest_image`, `measure_from_image`,
`fillet_edges`/`chamfer_edges`/`hole_on_face` (descriptor-targeted), `add_callout`/
`clear_callouts`, `generate_drawing`, `section_view`, `diff_last_edit`, `transcribe_voice`.

**Pitfalls:** stale selection (snapshot with the message, echo back); descriptor invalidation
across regen (fail loudly); overlays must live at **scene identity, world-frame mm** (under the
GLB wrap they land 1 km off); voice number errors need typed confirmation.

---

## Pillar 8 — Agentic planning, exploration & bounded autonomy

**Capabilities**
- **Goal → editable plan** — vague goal → a checklist with surfaced assumptions the user
  edits/approves *before* anything touches the document.
- **Multi-variant generation** — N takes as cheap sibling branches off the changelog; compare
  thumbnail/mass/part-count/print-time/invariants; promote only the winner. *The store already
  supports parent-linked branching — variants are near-free and reversible.*
- **Constraint-driven parametric sweep** — "how thin and still pass min-wall?"; the kernel
  adjudicates.
- **Preview-then-commit** — stage on a sibling branch, render the ghost/diff, fast-forward on
  Apply.
- **Natural-language time travel** — "go back to before the fillet but keep the bosses" → changelog
  seek + cherry-pick.
- **Proactive improvement & risk flagging** (one-click, never silent); **durable curated project
  memory**; **multi-user + AI collaboration with attribution**.
- **The connector-immutability guardrail as a *hard* stop** — enforced in code (the tools don't
  exist), redirecting to re-mate/swap.
- **Bounded autonomy with named risk gates** — sprint the safe 90%, pause at structural cuts,
  foreign-component edits, invariant failures.

**Tool surface:** `propose_plan`/`run_plan`, `branch_variants`, `sweep_parameter`,
`stage_changes`/`apply_branch`, `history_seek`/`branch_at`/`name_checkpoint`/`diff_versions`,
`propose_improvements`, `set_autonomy_policy`, `read`/`write_project_memory`.

**Pitfalls:** branch proliferation (cap counts, draft-deflection previews, GC abandoned branches);
stale measurements (re-verify before Apply); **force-flag leakage** (`{force}` must never be
model-reachable); plan/act threshold keyed off step count + destructiveness.

---

## What the competitive landscape says to bet on

| Player | What it proves | Where it stops |
|---|---|---|
| **Zoo / Zookeeper** | Closest analog: agentic Plan→Act→Observe loop over parametric KCL, with self-execution + snapshots + analysis | Bespoke language; weak assembly; no print-readiness; intent-preservation unsolved |
| **Fusion AI / Project Bernini** | Multimodal input; production generative design is manufacturability-aware | Bernini early research; gen-design is constraint-solver, not conversational; ecosystem-locked |
| **Adam (YC W25)** | Conversational + auto-generated sliders; "Vercel v0 for CAD"; >1M models | Maker altitude; STEP "coming"; no assembly/print validation |
| **Meshy / Sloyd / Spline** | Best for organic/visual assets | Mesh-vs-parametric gap: dimensionless, no STEP, non-functional |
| **CadQuery/build123d + LLM-for-CAD research** | Field converging on *LLM-emits-code → execute → observe visually → repair*; new benchmarks (MUSE) target "assemblable + manufacturable" | ~69% exact-match even fine-tuned; weak/open models struggle with native tool-calls |

**Strategic bets:**

1. **We're already on the winning side** (parametric build123d/OCCT). Don't drift toward mesh.
2. **Make the loop visual** — add a "snapshot the viewport and *look*" tool. Our blindest gap.
3. **Lean into assembly intelligence — the moat.** Surface place / find-compatible-connector /
   mate / assert-joint as explicit, audited tools.
4. **Own 3D-print-readiness** — DfAM checks + *automatic tolerance injection at mating connectors*
   (press ~0.05–0.1 mm, clearance ~0.2–0.4 mm, keyed to joint type and process) → assemblies that
   are **printable-and-fit by construction**.
5. **Adopt proactive clarification** ("Clarify Before You Draw" beats guessing) — disciplined,
   only on load-bearing unknowns.
6. **Connector immutability / withheld-tool discipline is a *correctness feature*** — it keeps the
   assembly contract sound while a fallible model iterates.
7. **Design for weak models.** Tool-call reliability is *the* bottleneck. Tight schemas,
   single-purpose tools, execute-and-repair, validation feedback.

---

## Highest-leverage next moves

The two highest-leverage, lowest-risk unlocks both **expose machinery we already have**:

1. **Sketch authoring tools** (`addSketch`/`addSketchEntity`/`addConstraint`) — unblocks all
   profile-driven mechanical modeling. The kernel side (sketch emit + Newton solver) exists.
2. **The screenshot-and-see loop** — wire the rendered GLB back to the model so it can *observe*
   its own output, plus the `compile_status` error feedback for autonomous repair.

After those: `declareConnector` (connectors on custom geometry, the assembly unlock) and the
`check_printability`/`export_for_print` DfAM closing loop.
