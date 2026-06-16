# PLAN — Deterministic (Governed) Design Pipeline

> 2026-06-16. The north-star flow: a prompt like "robot dog" becomes a
> *clarified spec → decomposed plan-graph → physics-closed BOM → user-approved
> map → goal-driven build*, where the **plan-graph is the source of truth**, the
> **mermaid map is an editable view of it**, and **chat + document + plan-graph
> versions stay coherent** so the user can revert and re-prompt.
>
> Companion to the functional-design brain (already partly built:
> `propose_brief`, `plan_mechanism`, `plan_assembly`, knowledge cards,
> `build_part_recipe`, `run_invariants`). This plan is the *connective tissue*
> that turns those scattered tools into one governed flow.

---

## 0. Premise & reframes (decisions already made)

1. **Not "deterministic LLM" — reproducible + inspectable.** Determinism lives
   in the executor (code + kernel). The LLM is a compiler front-end we can
   re-run; the **plan-graph is the source of truth**, like `changelog` is for
   geometry.
2. **Questions are generated from the decomposition, not front-loaded.** Draft a
   complete default spec → decompose → ask only the 1–2 decisions the
   decomposition exposed as load-bearing.
3. **Physics closure before BOM.** A symbolic mass/torque/COM/clearance pass that
   makes the tree physically *close* before any part is committed.
4. **Code vs tools is the wrong axis** — the axis is *"is this part a parametric
   function of its neighbors?"* Bespoke load-bearing part → code/recipe; standard
   feature/catalog part → typed op/library. **AND the typed surface itself needs
   to grow** (patterns especially — see Phase 6).
5. **Approval is re-entrant.** Build-time deviations that touch an approved
   decision raise a re-approval diff, never silent divergence.
6. **Honest v1 scope:** a verified single leg + complete plan + classified BOM +
   scaffold beats a whole dog that doesn't stand.

---

## 1. The central artifact — the Plan-Graph

A structured, versioned, persisted graph. The mermaid map renders it; user edits
mutate it through ops; the build executor walks it.

### Node schema (draft)
```jsonc
{
  "id": "leg.fl.femur",
  "kind": "assembly | subassembly | part | instance",
  "label": "Front-left femur",
  "class": "buy | reuse | fabricate",      // classification (Phase 1)
  "spec": {                                 // the requirement descriptor
    "role": "structural-link",
    "interface": ["servo-horn-25T", "knee-pivot"],
    "load": { "type": "bending", "value": 1400, "unit": "N·mm" },
    "sizeBand": { "length": [100, 130], "unit": "mm" },
    "partRef": null                         // set when buy/reuse resolves
  },
  "binding": {                              // how it gets built (fabricate)
    "recipe": "legLink",                    // build_part_recipe / writeBuildScript
    "params": { "len": 120, "wall": 3 },
    "featureIds": []                        // back-link to document features
  },
  "instanceOf": null,                       // for kind:"instance" → source node id
  "chirality": "left | right | null",
  "accept": [                               // per-node acceptance tests (Phase 5)
    { "check": "i-motion-clearance" },
    { "check": "measure", "query": {...}, "expect": "..." }
  ],
  "status": "pending | building | verified | blocked",
  "deps": ["leg.fl.knee-servo"],            // sizing + reflow dependencies
  "children": ["..."]
}
```

### Where it lives
- **New module:** `src/lib/ai/plan/graph.js` — schema, factories, structured edit
  ops (`addNode`, `editNodeSpec`, `splitNode`, `mergeNode`, `replacePart`,
  `setClass`, `instance`), each pure + total (never throws), mirroring the
  defensive style of `context.js`.
- **New store:** `src/lib/ai/plan/plan_store.svelte.js` — the live graph +
  version list, Svelte-runes reactive for the UI.
- **Persistence:** serialize into the document JSON under a new top-level
  `planGraph` key (extend `store.js` `toJSON`/`fromJSON`, bump nothing — additive
  like `assumptions`), so a saved project keeps its plan. The DSO blobs in
  `context.js` (morphology/skeleton/assemblyPlan) become *derived/legacy*; the
  graph is canonical.

---

## 2. The three-store coherence problem (this is the version-history core)

Three independent state stores today:
- **Document** — `lib/document/store.js`: append-only `changelog` + `head` (already time-travels).
- **Chat** — `src/lib/ai/chat_store.svelte.js`: `sessions[{ id, items, history }]` (no binding to doc state).
- **Plan-graph** — new (Phase 1).

A "chat version the user can revert to" is **a checkpoint tuple across all
three**, not a chat-only concept:

```jsonc
"checkpoint": {
  "id": "ckpt_7",
  "label": "v2 — bigger camera",
  "chatItemIndex": 14,        // position in chat.items / chat.history
  "docHead": 42,              // changelog head to fold to
  "planVersion": "pg_v2",     // plan-graph version id
  "createdAt": 1718...
}
```

Reverting restores **all three coherently**: fold the document to `docHead`,
truncate chat to `chatItemIndex`, load plan-graph `planVersion`. This is the only
way "I liked 50%, let me re-prompt from there" works without the geometry and the
map drifting out of sync with the conversation.

**Spec-change versioning (the camera example) falls out of this:** changing the
camera node from `{cam-xyz, 10×20}` to `{cam-123, 50×50}` is an `editNodeSpec`
op → new plan-graph version → the node's `deps` (camera mount, shell cutout) are
marked **stale** → targeted reflow rebuilds only those parts. The version list
shows the diff: *"v1: cam-xyz 10×20 → v2: cam-123 50×50 (mount + cutout
reflowed)."*

---

## 3. Phases

Phases 0–2 are the foundation (sequential-ish). Phases 3–6 can be dispatched in
parallel once the schema (Phase 0) lands.

### Phase 0 — Plan-graph schema + store (FOUNDATION, do first)
- **Files:** `src/lib/ai/plan/graph.js`, `src/lib/ai/plan/plan_store.svelte.js`;
  extend `lib/document/store.js` toJSON/fromJSON with `planGraph`.
- **Deliverable:** create/edit/serialize a graph; round-trips through save/load;
  unit tests under the existing `.mjs` harness (local `DocumentStore`, per the
  async-isolation rule).

### Phase 1 — Decomposition + classification (tools write the graph)
- **Files:** `tools_mechanism.js` (`plan_mechanism` → emits graph nodes),
  `tools_planner.js` (`plan_assembly` → seams/subassemblies), new
  `propose_plan_graph` tool; `knowledge.js` cards drive archetype decomposition.
- **Classifier:** each leaf gets `class: buy|reuse|fabricate` by matching its
  **requirement descriptor (interface + load), not name** — upgrade beyond
  `search_library` keyword search. COTS (servos/bearings/fasteners) prefer buy
  hard; fabricating a bearing is a failure.
- **Deliverable:** "robot dog" → a graph with legs (1 design × 4 instances, 2
  mirrored), body, electronics, each leaf classified.

### Phase 2 — Physics closure pass (the missing gate)
- **Files:** new `src/lib/ai/plan/closure.js`; budgets data added to
  `knowledge/*.json` (servo torque ratings already in `servos.json`; add mass
  densities, safety factors).
- **Checks (symbolic, pre-geometry):** mass budget, worst-case joint torque vs
  actuator rating, COM inside support polygon, clearance envelopes. Promote the
  quadruped card's prose pitfalls (knee torque spike, COM too high) to numeric
  gates.
- **Deliverable:** a graph that **closes** (or flags the servo that won't hold,
  pre-build) before BOM lock. Hook into `run_invariants` family.

### Phase 3 — Mermaid view + editable graph UI
- **Files:** `src/lib/components/studio/ChatPanel.svelte` (+ a new
  `PlanGraphView.svelte`); mermaid render is a **view** of the graph JSON.
- **Edits go through structured ops** (rename/split/merge/replace-part/
  change-spec), NOT free-text mermaid editing (avoids picture↔build drift).
- Node coloring by `class` (buy/reuse/fabricate) and by `status`
  (pending/building/verified/blocked).
- **Deliverable:** user sees the map, clicks a node, says "swap this camera" →
  structured `replacePart`/`editNodeSpec` op fires.

### Phase 4 — Checkpoints, versions, revert, spec-reflow
- **Files:** `chat_store.svelte.js` (add `checkpoints[]` + `revertTo(ckpt)`),
  wiring to `store.js` `setHead` + plan_store version load; `agent.js` records a
  checkpoint at each user turn / approval.
- **Spec reflow:** `editNodeSpec` marks dependent nodes stale → targeted rebuild
  of only those parts (uses the back-link `binding.featureIds`).
- **Deliverable:** revert to "v1", re-prompt a different idea; camera swap
  reflows mount+cutout and the version list shows the diff.

### Phase 5 — Build executor with status ledger + re-approval
- **Files:** `agent.js` (plan-aware orchestration), new
  `src/lib/ai/plan/executor.js`; per-node `status` ledger drives resumability.
- **Instancing:** build the leg once, instance 4× (chirality flag) — BOM line is
  "1 design → 4 placements," not 4 builds.
- **Per-node acceptance tests** (`node.accept`) bound at plan time via existing
  `add_requirement`/`verify_requirement` + `i-motion-clearance`/
  `i-functional-complete`; a node can't go `verified` until its test passes.
- **Re-approval on deviation:** a self-repair that changes an approved decision
  (servo SG90→MG996R) raises a diff for the user, not a silent change.
- **Deliverable:** observable, resumable build ("12/16 parts, leg-4 blocked");
  honest v1 = verified leg + scaffold.

### Phase 6 — Expand the typed tool surface (parallel, independent)
The library is thin on patterns and several ops exist without tools.
- **Quick win:** wire `addPathPattern` — it **already exists** in
  `operations.js:809` (and `PathPattern` is a real feature type with emit) but
  has **no AI tool**. Add to `tools.js`/`tools_geometry_ext.js`.
- **New pattern types** (need op + emit + tool):
  - **Grid / rectangular** (2D X×Y, the common case `addLinearPattern` can't do
    in one call).
  - **Mirror-group** (mirror a multi-body selection as a set).
  - **Fill / area pattern** (pack a face/region — vents, perf grids; ties to the
    quadruped vent strategy).
  - **Variable / scaling pattern** (count + per-step delta in size/rotation).
  - **Table-driven pattern** (explicit list of transforms — for irregular bolt
    circles, asymmetric layouts).
- **Files:** `lib/document/operations.js` (ops), `lib/document/emit.js` (build123d
  emission), `lib/document/types.js` (`FEATURE_TYPES` entries), `tools_*.js`
  (surface). Each pattern is one self-contained op→emit→tool slice.
- **Deliverable:** the AI (and manual users) can pattern in grids, along paths,
  over areas, and from tables — not just single-axis linear/radial.

---

## 4. Sequencing & dispatch

```
Phase 0 (schema/store) ─┬─> Phase 1 (decompose+classify) ─> Phase 2 (closure)
                        │
                        ├─> Phase 3 (mermaid view)        [parallel after 0]
                        ├─> Phase 4 (checkpoints/versions) [parallel after 0]
                        └─> Phase 6 (pattern tools)        [fully independent — start anytime]
Phase 5 (executor) depends on 1+2+ (and benefits from 3,4).
```

- **Start now, in parallel:** Phase 0 (unblocks everything) and Phase 6 (pattern
  tools — independent, immediately useful, good warm-up that also improves the
  *current* AI output today).
- Then 1 → 2, with 3 and 4 dispatched alongside once the schema is stable.
- 5 last (it consumes all the others).

---

## 5. Decisions (LOCKED 2026-06-16 — user delegated; bias to scalability)

1. **Plan-graph storage:** inside `.paraform.json` as an **opaque `planGraph`
   POJO** the document store round-trips (additive, like `assumptions`). The AI
   plan module owns the schema; `lib/document` never imports `src/lib/ai` (no
   layering inversion). *Finding:* the `context.js` DSO has `snapshot()`/
   `restore()` but they are **not wired into save/load today** (chat_store only
   `reset()`s it) — so design state is currently volatile. The plan-graph fixes
   that by persisting with the design.
2. **Checkpoint granularity:** auto every user turn (cheap revert points) + a
   "name this version" affordance for the ones the user cares about.
3. **Closure-pass depth for v1:** torque + mass + COM only (covers the
   "won't stand up" failure). FEA-lite deferred.
4. **Plan-graph vs DSO:** the **graph is canonical**; the `context.js` DSO
   becomes derived/legacy for back-compat.

### Scalability principles (the user's explicit instruction — honour these)
- **Pure-data core, reactive wrapper.** `graph.js` is DOM/Svelte-free and
  node-testable; `plan_store.svelte.js` (later) only adds reactivity. Keeps the
  schema portable to server-side / headless / future multiplayer.
- **Open schemas.** Every node carries `spec` (open object) + a `meta` escape
  hatch, so new node attributes never require a migration.
- **Versioning + ids are first-class from day one.** Deterministic counter ids
  (`n1`, `v1`), injectable clock, immutable committed versions, collision-safe
  counter restore — so checkpoints, diffing, and undo scale without rework.
- **Reflow is dependency-driven, not global.** `deps` + reverse-index staleness
  means a 500-part assembly reflows only the touched subtree, not everything.
- **Instancing over duplication.** 1 design → N placements keeps token cost and
  the BOM bounded as assemblies grow.

## 6. Status — FULL PIPELINE LANDED (2026-06-16)

All phases implemented and validated: full `npm test` green (exit 0) + `vite build`
green (Svelte components compile). New tests registered in
`lib/document/__tests__/all.mjs`.

| Phase | What landed | Files |
|---|---|---|
| 0 — Plan-graph | pure/total/versioned graph: node CRUD, dependency reflow, instancing, commit/checkout/diff, mermaid view, POJO persistence | `src/lib/ai/plan/graph.js` + `__tests__/plan_graph.test.mjs` (10) |
| — Persistence | opaque `planGraph` POJO round-trips through `.paraform.json`; reload on document open | `lib/document/store.js`, `src/lib/ai/plan/sync.js` + `plan_persist.test.mjs` (3) |
| 1 — Decompose + classify | quadruped template (body + electronics + 1 leg ×4, 12 DOF) + generic fallback; buy/reuse/fabricate classifier with library match | `plan/decompose.js`, `plan/classify.js` + `plan_closure.test.mjs` |
| 2 — Physics closure | mass + per-joint torque (×safety vs servo rating, deterministic step-up suggestion) + COM-in-support gate; instance mass counted ×N | `plan/closure.js` + `plan_closure.test.mjs` (6) |
| — AI tool surface | ~22 `plan_*` tools (decompose → classify → version → closure → BOM) wired into `AGENT_TOOLS` | `src/lib/ai/tools_plan.js` + `plan_tools.test.mjs` (6) |
| 3 — Map UI | reactive store + interactive native plan-tree (class/status colour, versions, checkpoint revert, closure result) in the chat panel | `plan/plan_store.svelte.js`, `components/studio/PlanMap.svelte`, `ChatPanel.svelte` |
| 4 — Checkpoints | coherent revert across chat + document head + plan snapshot, auto per turn | `plan/checkpoints.js`, `chat_store.svelte.js` + `plan_checkpoints.test.mjs` (4) |
| 6 — Pattern tools | `addGridPattern` (2D rows×cols, composed from linear) + wired the orphan `addPathPattern` | `src/lib/ai/tools_patterns.js` |
| — Activation | governed pipeline taught in the system prompt (decompose → close → approve → build → BOM) | `src/lib/ai/system_prompt.js` |

### Remaining depth (Phase 5 — partial)
The Phase 5 building blocks shipped: `plan_set_status` (status ledger),
`plan_set_accept` (per-node acceptance tests), `plan_bind` (featureId back-links),
and checkpoints. **Not yet automated:** a build-loop in `agent.js` that walks
pending nodes, runs each node's acceptance tests, and raises a re-approval DIFF
when a self-repair changes an approved decision (servo step-up). Today the model
drives status itself, guided by the system prompt; the deterministic executor +
auto re-approval is the next deepening.

---

## 7. Why this fixes "outputs aren't useful yet"

Today the model wanders because nothing holds it to a frozen, inspectable
contract, and there's no per-part acceptance gate. This plan gives it: a
**spec it's held to**, a **map the user can steer**, a **physics gate that
catches non-closing designs before geometry**, **per-node done-criteria**, and
**coherent versioning** so iteration is cheap and safe. The visible part is the
clarify→map→approve UX; the part that actually makes outputs *useful* is the
plan-graph + closure pass + status ledger underneath.
