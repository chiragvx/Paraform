# Step-Based Timeline — Research & Upgrade Direction

*2026-06-15. Research for a "step-based timeline that users can change and
re-compile to have greater control on their designs."*

---

## TL;DR — the reframe

**We are not missing a timeline. We are missing a few specific things on top of
a timeline that already exists and is unusually complete.**

The hard, expensive part of a parametric timeline — an append-only changelog, a
head pointer, an ordered feature list, a dependency DAG, and a deterministic
fold/replay — **is already built and shipping** (`lib/document/*`). The live
Svelte studio already exposes a feature tree, an inspector that edits a
feature's parameters, a non-destructive rollback scrub marker, undo/redo, and a
diff viewer.

Because our kernel is **code-CAD** (we emit one build123d script and re-run it),
**"go back in the timeline, change a parameter, recompile" already works today**
via the Inspector → re-emit → recompile path. Editing any feature's params
re-runs the whole script deterministically and downstream geometry regenerates.

So the "major upgrade" should **not** rebuild the timeline. It should close four
real gaps:

1. **Authoring on-ramp** — reference-image canvas (absent today) + the
   sketch→extrude flow surfaced in the live studio (today it "routes through
   legacy").
2. **A true rollback-bar UX** — edit/insert *in the past* as a first-class flow,
   not just "hide everything after the marker."
3. **A granularity contract for AI-authored designs** — keep them as editable
   steps, not opaque monolithic `BuildScript` code blobs (this is our version of
   Zoo's "mesh blob is not editable" problem, one level up).
4. **Incremental recompile** — today every edit rebuilds the whole document.
   Fine now; a perf cliff at scale.

And critically: **code-CAD structurally sidesteps the topological-naming
problem** that defines the incumbent category. We should lean into that and
*not* port 25 years of persistent-naming heuristics.

---

## 1. What we actually have today (audit)

### 1.1 The parametric foundation — already built

| Capability | Status | Where |
|---|---|---|
| Document = ordered feature list | ✅ | `lib/document/types.js` — `featureOrder[]` + `features{}` map |
| Append-only change log | ✅ | `doc.changelog[]` + `doc.head` pointer |
| Dependency graph (explicit, not positional) | ✅ | `feature.inputs[role] = Ref`; topo sort in `lib/document/dag.js` |
| Deterministic fold / replay | ✅ | `lib/document/fold.js` — `applyChange` (30+ change kinds) |
| Undo / redo | ✅ | `lib/document/store.js` (refold-from-log) |
| Suppress / unsuppress a feature | ✅ | `feature.enabled` flag, one change record |
| Reorder features | ✅ | `REORDER_FEATURE` change; `app/v4_panel/feature_tree.js` |
| Named parameters + expressions | ✅ (data) | `makeParameter(... equation)` in types.js |
| Rollback / history scrub | ✅ | `setHead` (destructive) **and** render-time marker (`src/lib/document/rollback.js`) |

The smallest atomic "design step" is a single `add-feature` change record. This
is the right granularity.

### 1.2 Two app shells — the source of the "missing" feeling

There are **two** front-ends in the tree:

- **Legacy vanilla `app/`** — has the *rich* timeline: a horizontal feature
  strip with one icon per feature, draggable playhead, playback controls, and a
  per-feature context menu (Edit / Roll History Here / Suppress / Delete) at
  `app/timeline/index.js` (637 lines), plus `app/v4_panel/feature_tree.js` and
  an `edit_feature.js` dialog.
- **Live Svelte `src/`** — what users actually run. Has a unified
  component+feature tree (`src/lib/components/studio/Sidebar.svelte`), an
  Inspector that edits feature params (`Inspector.svelte` → `setParams`), a
  *non-destructive* rollback scrub (`TimelineScrub.svelte`, toggled by the "Roll
  marker" button), a `DiffViewer.svelte`, and undo/redo.

PLAN.md (line 83) confirms: **"Sketch tooling still routes through legacy."**
So the live studio has the *tree + inspector + scrub* but not the polished
horizontal timeline strip or the full sketch on-ramp. **That asymmetry is
probably what reads as "a missing element."**

### 1.3 Compile pipeline — whole-document, monolithic

- `lib/document/emit.js` `emitDocument()` walks the DAG in topo order and emits
  **one** build123d Python script (`p_<name>` params, then `n_<id>` features).
- It runs as a single `exec()` in one namespace on the kernel
  (`b123d_server/harness.py` `execute_b123d`). All-or-nothing: if feature N
  fails, nothing after it compiles.
- **Every edit re-emits the entire document and recompiles from scratch.** There
  is no per-feature incremental build and no dependency-based dirty tracking.
- A **2-tier content-addressed cache** (browser LRU in `executor.js` + server
  LRU in `server.py`) makes *redundant* recompiles (~undo/redo, scrub back and
  forth, param toggled to a seen value) a <10 ms replay. But the key is the hash
  of the **whole** emitted script — change step 47 of 100 and you still pay a
  full 1→100 rebuild.

### 1.4 AI authoring — two granularities, in tension

- **Typed-op path** (~70 schema-validated tools in `src/lib/ai/tools.js`:
  `addBox`, `addExtrude`, `addFillet`, `addGear`, `placeLibraryPart`, `add_mate`,
  `setFeatureParams`, `deleteFeature`, …) → produces **discrete features** =
  real, individually-editable timeline steps.
- **Code path** (`writeBuildScript` / `editBuildScript`, shipped 2026-06-15) →
  produces **one opaque monolithic `BuildScript` feature** = a single timeline
  node with no sub-step granularity. Sandboxed `_bs_run` in harness.py.

The agent loop (`src/lib/ai/agent.js`) builds **forward**: plan → emit → compile
→ observe (vision gate / measure) → self-repair. It can patch one feature
(`setFeatureParams`) or cascade-delete (`deleteFeature`) but has **no "go back to
step N, edit it, regenerate downstream"** capability. Time-travel tools
(`history_seek` / `branch_at`) are described in `ai-plan.md` Pillar 8 but
**unshipped**.

### 1.5 Sketch & reference images

- A real interactive sketcher exists — `app/sketch_3d/` (tools, controller, hit
  test, dynamic dim input, constraint badges) + a constraint solver
  (`lib/sketch_solver.js`), sketch ops (`lib/document/sketch_ops.js`), and
  `extrude`/`revolve` consume sketches. But it "routes through legacy."
- **Reference-image canvas: absent.** We have datum *planes*
  (`app/viewport/reference_planes.js`) and sketch *vectorization*
  (`src/lib/sketch/vectorize.js`), but no "drop an image, calibrate scale, set
  opacity, trace on top" feature. This is the one piece from the user's described
  human workflow that genuinely does not exist.

---

## 2. The human workflow, mapped to our state

The workflow the user described, step by step, and where we stand:

| Human step | Our state |
|---|---|
| Add reference images to the file | ❌ **Missing** — no image canvas |
| Sketch the profile | 🟡 Exists (`app/sketch_3d/`) but legacy-routed |
| Extrude / revolve the sketch | ✅ `addExtrude` / `addRevolve` features |
| Test a few concepts | 🟡 Diff viewer exists; multi-variant branching does not |
| Go back in the timeline | ✅ Rollback scrub marker (render-time) |
| Change a few parameters | ✅ Inspector → `setParams` (commits a change) |
| Re-compile | ✅ Auto re-emit + recompile (whole doc) |

So 4 of 7 are solid, 2 are "exists but not surfaced well," and **1 (reference
images) is truly missing.** The perceived "no timeline" is really "the on-ramp
(images + sketch) and the *feel* of editing-in-the-past are weak," not "no
history model."

---

## 3. How modern CAD does it (mechanics worth stealing / avoiding)

- **Feature tree = an ordered, replayable program.** Fusion / SolidWorks /
  Onshape store the model as a recipe of operations and "regenerate" =
  re-execute in dependency order. *We already do this — the script is the
  recipe.*
- **The rollback bar** moves a marker; everything after it is deactivated so you
  can edit/insert mid-history, then downstream regenerates. *We have the "hide
  after marker" half; we lack the "edit/insert in the past as a first-class
  flow" half.*
- **Direct vs parametric.** Direct modeling (push/pull faces, no history) wins
  for imported dumb solids and concept exploration; parametric wins for
  dimensional variation and intent. *Code-CAD is inherently parametric; we don't
  need to chase direct modeling.*
- **Onshape Part Studios** — one feature list drives **multiple** parts with
  shared references; a **separate Assembly layer** positions them with mates.
  *This maps almost exactly onto our document (many bodies) + connector/mate
  layer. Strong validation of our existing split.*
- **Reference-image canvas idiom** is universal: import image → bind to a plane →
  calibrate by picking two points + typing the real distance → set opacity /
  display-through → trace. *This is the spec for the missing feature.*

### The topological-naming problem (TNP) — and why we dodge it

In GUI history-CAD, a downstream feature stores a reference to a kernel entity
**by volatile internal ID** (`Face13`). Edit an upstream feature → the kernel
**reassigns IDs** on rebuild → the reference silently re-binds to the wrong face
or breaks. This is *intrinsic* to history-based CAD; every vendor ships
heuristic persistent-naming layers and repair tools to paper over it, and they
all still throw rebuild errors.

**Code-CAD structurally avoids classic TNP** because the script recomputes from
text each run and never stores ephemeral kernel IDs. build123d states this as a
design goal: *"we've avoided the classic CAD 'Topological naming problem' by
never referring to features with names or tags."*

The honest caveat: build123d **selectors** ("the highest face," `>Z`,
`sort_by`) reintroduce a *milder* fragility — a selector can silently re-bind to
a different sub-shape after an edit. But (a) that failure is **visible and
editable in the script**, not a hidden corrupted reference, and (b) **our
connector contract is a *better* stable-reference mechanism than geometric
selectors** — it names mating *intent* explicitly (anchored, locked,
compatibility-by-profile) instead of resolving by post-hoc geometric query.
**Do not port persistent-naming heuristics — we don't have the problem they
solve.**

---

## 4. The code-CAD truth: the script *is* the timeline

This is the load-bearing insight for the whole design:

- Our `emitDocument` already walks the DAG and produces the program. The
  timeline is **a view over that program**, not a second source of truth.
- "Edit a step in the past and regenerate" = "commit a `set-params` change to an
  earlier feature → refold → re-emit the whole script → recompile." This is
  **already wired** through the Inspector.
- Therefore the timeline upgrade is mostly **UX + perf + AI-granularity**, not a
  new data model. We should resist building a parallel stored feature-history
  with kernel-ID references — that would *add* the TNP we currently avoid.

---

## 5. AI + timeline

The whole AI-CAD field has converged on one rule: **a generated design is only
useful if it stays an editable parametric program, not a baked blob.** Zoo
frames mesh output as "one large amorphous blob, not editable in any useful
way."

Prior art for *editing a step and regenerating*:
- **HNC-CAD** (ICML 2023) — design as a hierarchical code tree; "edit the code
  nodes… preserve the current design while making local edits." The cleanest
  mental model for "mutate node N, regenerate the rest."
- **Adam CAD** (YC W25) — outputs a **feature tree** (ordered ops + auto-slider
  variables) and a **part-editing "inpainting" mode** that modifies a region and
  regenerates. Closest product analog. (OSS sibling: `Adam-CAD/CADAM`.)
- **Zoo / Zookeeper** — every AI action becomes KCL (traceable, editable), with
  distinct *generate* and *edit-existing* operations. But KCL is a *linear*
  program, so "edit" = AI rewrites the script (≈ our `editBuildScript`), not
  surgical node mutation.

**Implication for us:** our typed-op path already produces an editable feature
sequence — *better* structured than KCL's flat script. The risk is the new
`writeBuildScript` path collapsing that into an opaque blob. We need an explicit
**granularity contract** (see Gap 3).

---

## 6. The actual gaps (what to build)

### G1 — Reference-image canvas *(net-new; highest "human delight" / effort ratio)*
A calibrated, opacity-controlled, **Z-up** image-plane primitive. Per CLAUDE.md
this belongs in `lib/viewport/conventions.js` (do **not** hand-roll a
`PlaneGeometry` floor — that's a Y-up bug). Calibrate by two-points + distance.
Persist as a feature so it round-trips autosave (mirror how `ImportedMesh`
stores base64 GLB in `src/lib/import/cad.js`).

### G2 — First-class "edit / insert in the past" rollback-bar UX
Today's rollback marker only *hides* downstream features. Add:
- **Insert-at-marker**: new features land at the marker position in
  `featureOrder` (the `insertAt` field on the add-feature change already exists).
- **Edit-in-the-past**: rolling the marker back, editing a feature, then
  releasing regenerates downstream — surfaced as one coherent gesture, not
  "scrub, then separately open the inspector."
- Consider porting the **horizontal feature strip** from `app/timeline/` into the
  Svelte studio so the timeline *looks* like a timeline (Fusion-style), or
  consciously decide the vertical tree is enough.

### G3 — AI granularity contract (steps, not blobs)
Decide and enforce: AI-authored designs stay **discrete features** by default;
`writeBuildScript` is a last resort. Options to evaluate:
- Prefer typed ops; only fall back to BuildScript when no typed op fits.
- Make `BuildScript` **decomposable** (multiple named sub-steps) or at least
  **parameter-exposing** (hoist top-of-script variables into doc parameters with
  sliders — the OpenSCAD Customizer / Adam pattern).
- Add AI tools `history_seek` / step-edit so the agent can target an earlier
  feature and regenerate (ai-plan.md Pillar 8).

### G4 — Incremental recompile *(perf, for scale; defer until needed)*
Today: change step 47/100 → full 1→100 rebuild. To make recompile cheap at
scale, design a **per-feature checkpoint cache** keyed by `(feature_id,
upstream_deps_hash, deflection)` whose value includes the serialized
intermediate body (e.g. BREP/STEP) so a later step can resume from a checkpoint
instead of replaying from scratch. This is the heaviest lift — **don't build it
until model sizes justify it.** The content-addressed cache already covers the
common redundant cases.

### G5 — Bring the sketcher into the live studio
`app/sketch_3d/` + the constraint solver exist but route through legacy. Sketch
→ extrude is the spine of the human workflow; finishing its Svelte integration
is higher leverage than most net-new work.

### G6 — Branch / variant exploration *(optional; "test a few concepts")*
The changelog already supports branching (`change.parent`). Exposing
multi-variant "try concept A vs B" is a natural follow-on to the diff viewer,
but lower priority than G1–G3.

---

## 7. Recommended direction & sequencing

**Do not rebuild the timeline. Close the on-ramp and the editing loop, then
decide AI granularity, then (only if needed) make recompile incremental.**

Suggested order by leverage:

1. **G1 reference-image canvas** + **G5 sketcher in the Svelte studio** — these
   two give a human the full "images → sketch → extrude" on-ramp that is the
   actual missing experience.
2. **G2 edit/insert-in-the-past** — make the timeline *feel* like a timeline; the
   data model already supports it, so this is mostly UX wiring.
3. **G3 AI granularity contract** — protect editability before more designs get
   authored as opaque blobs. Highest strategic urgency given the 2026-06-15
   BuildScript direction.
4. **G4 incremental recompile** — only when model sizes make full rebuilds hurt.

**Explicitly do NOT:**
- Build a second stored feature-history with kernel face/edge IDs (re-introduces
  TNP we currently avoid).
- Port commercial persistent-naming heuristics.
- Chase a direct-modeling mode — code-CAD is parametric by nature.

---

## 8. Open decisions for you

1. **Timeline shape**: vertical tree (have it) vs. Fusion-style horizontal strip
   (have it in legacy, would need porting). Which matches the product feel you
   want?
2. **AI granularity policy**: hard-prefer typed ops, or make BuildScript a
   first-class decomposable/parametric citizen?
3. **Incremental compile**: worth the checkpoint-cache complexity now, or wait
   for real large models?
4. **Reference images**: per-document image canvas only, or also per-sketch
   underlay (SolidWorks "sketch picture" style)?

---

*Sources for the external research (CAD timelines, TNP, code-CAD, AI-CAD prior
art) are catalogued in the research session; key ones: FreeCAD TNP wiki, Kripac
1997, build123d/CadQuery selector docs, Onshape Part Studios help, Zoo
text-to-cad blog, HNC-CAD (ICML 2023), Adam CAD / CADAM, DeepCAD, Text2CAD.*
