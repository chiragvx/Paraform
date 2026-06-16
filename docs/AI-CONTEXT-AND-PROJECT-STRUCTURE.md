# AI Module — What the Model Sees + Project File Structure

> Research note (2026-06-16). No code changes — reference doc for how the AI
> layer is wired and how a single project is stored. Companion to
> `RESEARCH-2026-06-15-step-timeline.md` and the functional-assembly vision.

---

## Part 1 — What the AI model actually "sees"

Every turn, the agent assembles **one request payload** and streams it to the
model through the proxy. That payload has exactly three parts: a **system
prompt**, a **tool catalog**, and the **message history**. The model never sees
your document file, never sees the build123d Python, and never writes geometry
directly — it only calls typed tools and reads back compact JSON summaries.

### A. Orchestration core (drives the whole turn)

| File | Role |
|---|---|
| `src/lib/ai/agent.js` | The loop. Assembles the system prompt each turn (`buildSystem`), picks provider/model, runs tool calls, injects renders, runs the self-repair compile check, auto-mode + visual-gate nudges. The spine. |
| `src/lib/ai/provider.js` | `streamChat` — sends the body to the proxy (`b123d_server/ai_proxy.py`) and streams SSE back. |
| `src/lib/ai/providers/index.js` | Provider registry + neutral history format. Default provider = **`openai`** (OpenAI-compatible). |
| `src/lib/ai/providers/{openai,gemini,anthropic,cerebras,nvidia}.js` | Each serializes neutral history + tools + system prompt into that backend's wire shape. `openai.js` is the live default; `nvidia.js`/`cerebras.js` are newer. |

### B. The system prompt (concatenated fresh each turn — `agent.js:buildSystem`)

| File | Piece |
|---|---|
| `src/lib/ai/system_prompt.js` | Static base (~130 lines): Z-up world, "kernel is the arbiter," self-repair, the **Functional-machines pipeline** (intent→research→morphology→skeleton→structure→verify), connector rules, look-before-done. The bulk of what the model "believes." |
| `src/lib/ai/context.js` | `contextBlock()` — per-session memory: name aliases ("the bracket"→`box_3`), the design brief, open requirements, decisions, and the functional-design spec (committed mechanism/DOF, skeleton, serviceability). |
| `src/lib/ai/tools.js` → `sceneDigest()` | "**Current bodies**" block: every body, id, rough spatial extent ("box 40×20×10 — sits Z 0..10"). The model's only spatial awareness without calling `measure`. |
| `agent.js` → `selectionSummary()` | "**Live viewport selection**" — what the user clicked, so "this/here" resolves. |
| `agent.js` → no-vision note | Appended only when the active model can't see images; redirects to numeric verification. |

### C. The tool catalog (`src/lib/ai/tools.js` aggregates ~90 tools)

Only `{name, description, input_schema}` cross the wire — handlers stay local.

| Module | Tools |
|---|---|
| `tools.js` (core) | `addBox/Cylinder/Sphere`, `addExtrude/Revolve`, `addFillet/Chamfer/Shell/Hole`, `addUnion/Cut/Intersect`, `add_casing`, `addGear`, patterns, `addStandardPart`, `placeLibraryPart`, `replace_component`, `add_mate`, params, `setFeatureParams`, `deleteFeature`, `addComponent`, `get_document_summary`, `get_timeline`, `list_components`, `search_library`, `measure`, `run_invariants` |
| `tools_geometry_ext.js` | `addSweep`, `addLoft`, `addHelix`, `addTorus`, `addMove/Rotate/Scale/Align`, `undo`, `suppressFeature` |
| `tools_sketch.js` | `addSketch` |
| `tools_selection.js` | `get_selection`, `fillet_selected_edges`, `chamfer_selected_edges`, `hole_on_selected_face`, `sketch_on_selected_face`, `cut_pocket_on_selected_face`, `push_pull_selected_face`, `offset_selected_face`, `delete_selected_face` |
| `tools_code.js` | `writeBuildScript`, `editBuildScript` (raw build123d Python) |
| `tools_recipes.js` | `build_part_recipe` (servoMount, legLink, revoluteClevis, ballSocket, bodyShellWithBosses, ventGrille) |
| `tools_mechanism.js` | `plan_mechanism` |
| `tools_planner.js` | `plan_assembly` |
| `tools_assembly.js` | `find_compatible_connectors`, `list_connectors`, `generate_bom`, `plan_serviceability`, `plan_skeleton_envelope` |
| `tools_assembly_check.js` | `check_assembly_constraints` |
| `tools_validation.js` | `compile_status`, `mass_properties`, `self_critique`, `design_review` |
| `tools_dfm.js` | `check_printability`, `export_for_print`, `export_parts`, `recommend_material`, `compute_clearance`, `estimate_print` |
| `tools_vision.js` | `capture_views` (renders→images fed back), `image_to_sketch` |
| `tools_web.js` | `web_search`, `web_fetch` |
| `tools_context.js` | `propose_brief`, `name_feature`, `get_context`, `record_decision`, `explain_decision`, `add_requirement`, `verify_requirement`, `set_units` |

### D. Injected domain knowledge (expertise the scaffold supplies)

| File | Content |
|---|---|
| `src/lib/ai/knowledge.js` | Loader/accessors (`getPatternCard`, `getServoLadder`, `nextServo`, `getDfmRules`) — total functions, never throw. |
| `src/lib/ai/knowledge/mechanisms.json` | Mechanism "pattern cards" (quadruped, arm, gripper…): joint layout, proportions, actuator class, vent strategy, pitfalls, references. Reaches the model via `plan_mechanism`. |
| `src/lib/ai/knowledge/servos.json` | Servo upgrade ladder (SG90→…→DS3218) for `replace_component`. |
| `src/lib/ai/knowledge/dfm.json` | Printed-fit clearance bands, min walls, overhang/support, thread engagement. |
| `src/lib/ai/planner.js`, `src/lib/ai/eval/*` | Planner scoring + eval/benchmark harness (not in the live turn payload). |
| `src/lib/ai/attachments.js` | User reference images → image messages. |

### E. What comes BACK as tool results (the model's only window into geometry)

All abstracted summaries — never the raw document or mesh:

- `documentSummary()` / `timelineSummary()` — compact feature list (id, type, params; big blobs like `code`/`glbBase64` stripped).
- `measure` / `mass_properties` / `run_invariants` — numbers from freshly compiled kernel geometry.
- `capture_views` — JPEG renders re-injected as image messages (vision-capable models only).
- Auto self-repair — when geometry changes, `agent.js` compiles via kernel and feeds back any error as an `[automatic check]` user turn.

**Key takeaway:** there is a thick translation layer between the model and
reality. The model reasons over (a) a static doctrine prompt, (b) a
one-line-per-body spatial digest, and (c) numeric/visual tool results — it never
touches the document JSON or the Python. Output quality is bounded by how
faithfully `sceneDigest`/`documentSummary` describe state and how well the tools
cover intent — not just by the LLM.

---

## Part 2 — Structure of a single project

A project is **one file**: `<name>.paraform.json` (constant `PARAFORM_FILE_EXT`
in `src/lib/document/file_io.js`). Plain JSON, currently **schema version 5**,
serialized by `DocumentStore.toJSON()` (`lib/document/store.js:347`).

### The saved file (`.paraform.json`)

```jsonc
{
  "version": 5,
  "id": "...",
  "units": "mm",
  "metadata": { "name", "title", "createdAt", ... },
  "components": { "root": {…}, "<subassembly-id>": {…} },  // assembly tree
  "assumptions": [ … ],
  "changelog": [ Change, Change, … ],   // ← THE source of truth (append-only)
  "head": 42,                           // playhead index into changelog
  "kernelVersion": "…"                  // optional
}
```

The defining idea (`lib/document/types.js`, `store.js`): **the document is a
*fold* of the changelog up to `head`.** Undo = move `head` back; the timeline
scrubber moves `head`; nothing is mutated in place. Everything below is *derived*
by folding `changelog[0..head]`.

### Derived live document (what the app + AI operate on)

| Object | Shape | Where |
|---|---|---|
| **features** | Map keyed by id: `{ id, type, name, params, inputs{role→ref}, componentId, enabled, warnings }` | `types.js` |
| **featureOrder** | authored display order (separate from DAG exec order in `dag.js`) | `types.js` |
| **parameters** | named document variables (`wall=3`), referenced as `=p_wall` | `types.js` |
| **components** | assembly tree (root + sub-assemblies), each with origin/transform | `types.js` `makeComponent` |
| **connectors** | the snap contract (nine-rule records); immutable once committed | `types.js` `makeConnector` |
| **joints** | fixed / revolute / prismatic / cylindrical / planar | `FEATURE_TYPES` |

### Feature types (the "objects"), from `FEATURE_TYPES` (`types.js:53`)

- **sketch:** Sketch, SketchOnFace, ProjectEdges
- **create:** Box, Cylinder, Sphere, Torus, Extrude, Revolve, Sweep, Loft, Helix, **Gear**, ImportSTEP
- **modify:** Fillet, Chamfer, Shell, Draft, Hole, Thread, CosmeticThread, Offset3D, **Casing**
- **pattern:** Linear / Circular / Path / Mirror
- **combine:** Union, Cut, Intersect, Split, SplitFace
- **direct (face ops):** MoveFace, PushPullFace, DeleteFace, OffsetFace, ReplaceFace
- **transform:** Move, Rotate, Scale, Align
- **reference:** Plane, Axis, Point, **ReferenceImage**
- **assembly:** InsertComponent, JointRigid/Revolute/Slider/Cylindrical/Planar
- **variable:** Parameter, Equation
- **scripted:** **BuildScript**, **StandardPart**, ImportedMesh

### Code scripts inside a project

- **BuildScript** features carry **build123d 0.10 Python** in `params.code`
  (Z-up, mm, must assign `result`). Written/edited by the AI via
  `writeBuildScript`/`editBuildScript`, executed sandboxed in
  `b123d_server/harness.py`. This Python lives *inside the JSON*, not as a
  separate `.py` file.
- For all *other* features, no Python is stored — `lib/document/emit.js`
  **generates** build123d Python on the fly (topological DAG walk) and ships it
  to the kernel. That generated `.py` is transient, never saved.

### Other files in/around a project (by extension)

| Extension | What | Source |
|---|---|---|
| `.paraform.json` | the project document | `file_io.js` |
| `.bundle.zip` | share bundle = `document.paraform.json` + `README.txt` + `screenshot.png` | `buildBundleZip` |
| `.stl` / `.step` | per-part print/CAD exports | `tools_dfm.js` `export_parts` / `export_for_print` |
| `.glb` / glTF | kernel-emitted mesh (Y-up → wrapped to Z-up) — transient render data, not stored | `lib/document/bridge.js` |
| Supabase rows | cloud mirror: `cad_documents` (the JSON), `cad_folders`, `ai_chats` | `library.svelte.js` |
| `.json` | library catalog + AI knowledge packs (mechanisms/servos/dfm) — shared assets, not per-project | `knowledge/*.json` |

**Summary:** one `.paraform.json` per project, whose heart is an append-only
`changelog`; folding it yields features/parameters/components/connectors/joints;
geometry is produced by emitting build123d Python to the kernel and rendering
the returned mesh. The AI never reads that file directly — it sees the compact
summaries from Part 1.
