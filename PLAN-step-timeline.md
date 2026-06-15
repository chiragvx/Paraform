# PLAN — Step-Based Timeline Upgrade

*2026-06-15. Phased implementation plan. Companion to the research writeup in
`RESEARCH-2026-06-15-step-timeline.md`. Scope decided: ship all three gap
clusters (on-ramp, timeline-feel, AI-granularity) in phases; defer incremental
compile (G4) until model sizes justify it.*

## Guiding principles (from the research)

- **The script is the timeline.** The document's DAG + deterministic fold +
  whole-doc emit already *is* the parametric history. Build views and UX over it;
  do **not** create a second stored feature-history with kernel face/edge IDs.
- **Code-CAD dodges the topological-naming problem.** Never store volatile kernel
  topology references. The connector contract stays our stable-reference layer.
- **Keep designs as editable steps.** Discrete features > opaque code blobs.
- **Reuse proven patterns.** `ImportedMesh` is the template for any scene-only,
  asset-carrying, autosave-round-tripping feature.
- **Z-up discipline.** Any new scene object goes through
  `lib/viewport/conventions.js` (see CLAUDE.md). A `PlaneGeometry` placed
  anywhere else is a Y-up bug.

---

## Phase A — Human authoring on-ramp (G1 + G5)

**Goal:** a human can do "drop reference images → sketch over them → extrude →
see it in the timeline," entirely inside the live Svelte studio.

### A1 — Reference-image canvas *(net-new feature, mirrors `ImportedMesh`)*

A `ReferenceImage` is a **scene-only feature** carrying a base64 image, a Z-up
placement, a real-world size (from calibration), and an opacity. The kernel never
sees it (no `n_<id>`), exactly like `ImportedMesh`.

**Data model**
- `lib/document/types.js` — register feature type `ReferenceImage`; param shape:
  `{ dataUrl, mime, origin:[x,y,z], normal:[x,y,z], up:[x,y,z], width_mm, height_mm, opacity, displayThrough }`. Default placement = world XY plane (origin `[0,0,0]`, normal `[0,0,1]`), Z-up.
- `lib/document/operations.js` — add `addReferenceImage({ dataUrl, mime, width_mm, height_mm, ... })`, mirroring `addImportedMesh` (commit an add-feature change; the asset rides in `params`).

**Emit (exclude from kernel)**
- `lib/document/emit.js` — add a `ReferenceImage(f)` emitter that returns only a
  comment (copy the `ImportedMesh` emitter at `emit.js:778`), and add
  `'ReferenceImage'` to the leaf-body skip-list at `emit.js:1277-1281`.

**Scene helper (Z-up)**
- `lib/viewport/conventions.js` — add `createReferenceImagePlane({ dataUrl, width_mm, height_mm, opacity, displayThrough })`: a `PlaneGeometry` (no rotation — its default normal is +Z, correct for Z-up) with a `MeshBasicMaterial({ map, transparent:true, opacity, depthWrite:false })`; `displayThrough` ⇒ `depthTest:false` + render-order bump. Sits alongside `createGroundPlaneMesh`.

**Loader + scene attach (mirror `src/lib/import/cad.js`)**
- New `src/lib/reference/image_canvas.js`: `importImageAsReferenceFeature(file)` →
  read file → dataURL → `addReferenceImage(...)` → return `{ object, feature }`;
  plus `attachReferenceImageToScene(...)` and `decodeReferenceImageFeature(feature)`
  for bridge re-attach on reload (mirror `decodeImportedMeshFeature`).
- Bridge re-attach: wherever `ImportedMesh` is re-mounted on document reload (the
  `attachImportedMeshFromFeature` path referenced in `cad.js`), add the
  `ReferenceImage` branch.

**Calibration UX**
- `src/lib/components/studio/` — image-canvas tool: pick two points on the image
  plane, type the real distance → set `width_mm`/`height_mm` so the picked span
  matches. Opacity + "display through" sliders in the Inspector. Reuse the
  existing measure/pick infrastructure (`app/viewport/measure_tool.js`,
  `pick_proxies`) for the two-point pick.

**Acceptance**
- Drop a PNG, calibrate against a known dimension, sketch a profile over it,
  extrude → reference image shows behind geometry at correct scale, dims to set
  opacity, survives save/reload, and emits **byte-identical kernel code** to a doc
  without it (proves kernel exclusion).
- Unit test in `src/lib/__tests__/`: `addReferenceImage` round-trips through
  fold/replay and is excluded from `emitDocument` output.

### A2 — Bring the sketcher into the Svelte studio (G5)

The interactive sketcher (`app/sketch_3d/` + `lib/sketch_solver.js` +
`lib/document/sketch_ops.js`) exists but "routes through legacy" (PLAN.md:83).

- Mount the sketch controller (`app/sketch_3d/controller.js`) from the Svelte
  viewport (`src/lib/components/studio/Viewport.svelte`) the way other overlays
  (measure, section plane) are mounted, driven by `SketchToolbar.svelte`.
- Ensure a sketch started on the reference-image plane (A1) creates a
  `Sketch`/`SketchOnFace` feature that `addExtrude`/`addRevolve` consume.
- **Acceptance:** start sketch from the Svelte toolbar → draw constrained profile
  → extrude → a `Sketch` + `Extrude` feature pair lands in the timeline; existing
  sketch tests (`app/__tests__/sketch_3d*.mjs`) still pass.

---

## Phase B — Make the timeline *feel* like a timeline (G2)

**Goal:** edit/insert *in the past* as one coherent gesture, and (decision
pending) a horizontal feature strip in the live studio.

### B1 — Edit-in-the-past as a first-class flow
Today: roll the scrub marker (`src/lib/document/rollback.js`) only *hides*
downstream; editing a feature is a separate Inspector action.
- Wire: selecting a feature at/under the rollback marker and editing its params in
  `Inspector.svelte` (which commits `setParams`) **auto-regenerates downstream**
  on marker release (the whole-doc re-emit already does this; this is UX glue +
  clearing the marker after edit).
- **Acceptance:** roll back to feature 3 of 7, change its dimension, release →
  features 4–7 visibly recompute with the new value; undo restores cleanly.

### B2 — Insert-at-marker
The add-feature change already supports `insertAt` (Agent audit confirmed).
- `lib/document/operations.js` add-paths: when a rollback marker is active, new
  features insert at the marker index in `featureOrder` instead of appending.
- Surface in `Sidebar.svelte` / add-palette ("insert here").
- **Acceptance:** with marker on feature 3, "Add Fillet" lands at position 4 (not
  8); downstream order preserved; round-trips fold/replay.

### B3 — (Decision: see Open Questions) Horizontal feature strip
Optionally port `app/timeline/index.js` (legacy horizontal strip: icon-per-feature,
draggable playhead, per-feature context menu) into a Svelte component, OR formally
decide the vertical tree (`Sidebar.svelte`) + scrub is the product's timeline.
- If porting: reuse `app/timeline/icons.js` (already imported by `v4_panel`).
- **Acceptance (if built):** horizontal strip mounts in the studio, playhead
  scrubs `rollbackHead`, context menu offers Edit / Roll-here / Suppress / Delete.

---

## Phase C — AI granularity contract (G3)

**Goal:** AI-authored designs stay editable feature-steps, not opaque
`BuildScript` blobs. This is the most strategically urgent cluster given the
2026-06-15 code-editor direction.

### C1 — Typed-ops-first policy
- `src/lib/ai/agent.js` / system prompt + `src/lib/ai/tools.js`: make
  `writeBuildScript` an explicit **last resort** ("use a typed op if one fits;
  only write raw build123d when no typed op can express the geometry"). Add a
  lint/telemetry counter for blob-vs-typed authoring ratio.
- **Acceptance:** an eval prompt that *can* be built with typed ops produces
  discrete features, not one BuildScript (assert in `src/lib/ai/__tests__/`).

### C2 — Make `BuildScript` less opaque
Pick at least one:
- **Parameter hoisting (OpenSCAD Customizer / Adam pattern):** detect top-of-script
  constants and expose them as document parameters with Inspector sliders, so a
  blob is still tweakable without editing code.
- **Decomposable scripts:** allow a `BuildScript` to declare multiple named
  sub-steps that appear as child timeline nodes.
- **Acceptance:** a generated BuildScript with `width = 40` exposes a `width`
  slider that re-emits + recompiles on change.

### C3 — AI step-editing (`history_seek` / target-an-earlier-step)
From `ai-plan.md` Pillar 8 (unshipped).
- Add read-only `get_timeline()` (ordered features + params) and an edit tool that
  targets an earlier feature by id and commits `setFeatureParams` (reuse the typed
  op; no new connector-mutation surface — respect the immutability contract).
- Extend the agent loop so "go back to the box and make it 10mm taller" resolves to
  the right feature id and regenerates.
- **Acceptance:** a multi-step build followed by "make the base plate thicker"
  edits the *base-plate feature* (not a new one) and downstream regenerates;
  verified via measure.

---

## Deferred — Phase D: incremental recompile (G4)

Not now. Today every edit re-emits + rebuilds the whole document; the 2-tier
content-addressed cache covers the redundant cases. Revisit when real models get
large enough that full rebuilds hurt. Design sketch for later: per-feature
checkpoint cache keyed by `(feature_id, upstream_deps_hash, deflection)` whose
value serializes the intermediate body (BREP/STEP) so a later step resumes from a
checkpoint. **Log any coverage caps when built — don't silently truncate.**

---

## Sequencing & dependencies

```
Phase A (on-ramp)        Phase C (AI granularity)
  A1 ref-image ──┐         C1 typed-first ──┐
  A2 sketcher  ──┤         C2 deopaque    ──┼─ mostly independent of A/B
                 │         C3 step-edit   ──┘   (C3 benefits from B1/B2)
                 ▼
Phase B (timeline feel)
  B1 edit-in-past ── B2 insert-at-marker ── B3 strip (decision)
```

- A1, A2, C1, C2 are largely independent → parallelizable.
- B1/B2 depend on nothing new (data model is ready) but are higher value once A
  gives users reasons to revisit steps.
- C3 reads best after B1/B2 (shared "edit an earlier step" plumbing).

## What NOT to do (guardrails)

- ❌ A second stored feature-history with kernel topology IDs (re-introduces TNP).
- ❌ Persistent-naming heuristics (we don't have the problem they solve).
- ❌ A direct-modeling mode (code-CAD is parametric by nature).
- ❌ New AI surface for `updateConnector`/`removeConnector` (connector immutability
  contract — CLAUDE.md).

## Open questions (carried from research §8)

1. **B3:** horizontal strip (port from legacy) vs. vertical tree (have it) — which
   is the product's timeline?
2. **C2:** parameter-hoisting, decomposable scripts, or both?
3. **A1:** per-document image canvas only, or also per-sketch underlay
   (SolidWorks "sketch picture" style)?

## Test/quality notes

- JS tests: `src/lib/__tests__/` and `app/__tests__/` (run via the existing
  `all.mjs` harness — async tests must use a *local* DocumentStore, not the
  singleton).
- Python kernel tests live in `b123d_server/__tests__/` and are **gitignored** —
  run locally, never force-add.
