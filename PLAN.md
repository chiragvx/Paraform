# PLAN — From ParaForm to AI-native assembly CAD

> **Goal.** A user describes a mechatronic build (e.g. "a robotic arm") in a prompt,
> the app assembles it from a library of pre-made components, lets them swap a part
> (e.g. the servo type) with one click or one prompt, and then generates a fitted
> casing/cover around the assembly. Built entirely via AI; the operator is not a
> hand-coder.
>
> **Positioning.** Do **not** chase "Fusion 360 breadth" (surfacing, CAM, sim,
> drawings, 20 yrs of sketch-solver hardening). Win a vertical: **AI-native
> assembly-from-library with connector-driven generative enclosures** for the
> mechatronics / maker space. Our stack is already better-shaped than Fusion's for
> this because we have (a) a semantic connector layer and (b) a kernel-verified AI
> loop. Lean into both.

> **Progress (updated 2026-06-10). ALL SIX PHASES IMPLEMENTED** on branch
> `ai-assembly-phases`:
> **1 ✅** real Claude agent in-app (`1fb937e`) · **2 ✅** first-class mates + swap
> (`1fb937e`) · **3 ✅** kernel transform emission (`1fb937e`) · **4 ✅** library
> growth + authoring (`07d5005`) · **6 ✅** kinematics articulation (`07d5005`) ·
> **5 ✅** connector-driven casing (`2fb3807`).
>
> **Verified:** full unit/integration test battery green — document suite, spec08(22),
> spec17(26), spec18(35), spec18_snap_v2(17), phase2_mates(12), ai tools(8),
> articulation(13), invariants(69), casing(10); `npm run eval` 35/35 baseline OK;
> `npm run build` succeeds (all Svelte components compile). Generated build123d for
> placement + casing is AST-validated.
>
> **AI provider:** switchable, **Gemini default** (`gemini-2.5-flash`); Anthropic Claude
> selectable in Settings → AI. Set `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) in the kernel env
> (auto-loaded from a gitignored `.env` by `server.py`).
>
> **Live smoke test — PASSED (2026-06-10).** Verified against a running kernel + Gemini key:
> (a) `/ai/health` reports `gemini: configured` (dotenv load works); (b) a **placed +
> cased assembly compiled in live OCCT** — `emitDocument` → `/execute` → `ok:true`, 6.9KB
> GLB, 3 bodies; emitted Python contained `.moved(Location(...))` placement + casing
> `offset` shell + boss/pilot at the connector's world point `(9,0,30)` + shaft cutout +
> split-with-lip (closes the Phase 3/5 "AST-only" gap); (c) the **real Gemini agent loop**
> drove `addBox → addFillet → measure → search_library` through the proxy (prompt-caching
> active), mutating the document, 0 errors, and found the real `lib-part-servo-sg90`;
> (d) the **studio boots clean** in Chromium — viewport canvas, "AI ASSISTANT" chat panel
> ("Describe a part or assembly…"), and "KINEMATICS" panel all render with 0 console/page
> errors.
>
> **Remaining honest gaps:** the `measure` tool reads geometry via the viewport bridge,
> so it only works in the browser (returned not-configured in the headless agent run) —
> fine in-app, unproven headless. No human-driven multi-turn assemble→swap→casing run
> through the chat UI yet (each piece is verified independently). Per-phase v1 deferrals
> remain logged in their sections.

This file is the working roadmap. It complements:
- `STRATEGY.md` — the "kernel is the arbiter, not the model" philosophy (still correct).
- `TRACKER.md` — phase/feature sequencing.
- `CLAUDE.md` — coordinate-system & viewport conventions (Z-up, GLB Y→Z, etc.).

---

## Where we actually are

The hard, unglamorous foundation that most "AI CAD" attempts skip — and then die on —
is already built and solid:

- **Parametric document model** — append-only changelog, dependency DAG, named
  parameters with expressions, deterministic fold/replay. (`lib/document/*`)
- **Topological naming + query DSL** — `qOp('face','box_x','box','+Z')`-style
  references that survive regeneration, with a fingerprint fallback.
  (`lib/document/queries.js`, `descriptor.js`, `resolver.js`, `NAMING_CONTRACT.md`)
- **Connector/mate system** — real SE(3) math, gender/size compatibility,
  induced joints (bore+shaft → revolute), drag-snap UX, derived connectors from
  raw geometry. (`src/lib/library/mate_solver.js`, `place.js`, `src/lib/snap/*`,
  `app/viewport/snap_drag.js`)
- **Measurement-first verification** — 27 invariants, DFM checks, measure API, and
  a repair-loop harness already wired (with a *mock* LLM). (`src/lib/invariants/*`,
  `src/lib/dfm/*`, `src/lib/measure/*`, `src/lib/repair/*`)
- **Clean execution pipeline** — Svelte 5 studio → typed ops → `emit.js` (doc →
  build123d Python) → Flask kernel → GLB + topology back. (`b123d_server/*`)

What's missing is concentrated in five gaps below. The distance to the goal is real
but **localized** — not a rewrite.

### Known structural debt (address along the way, not up front)
- **Two frontends.** New Svelte 5 studio (`src/lib/components/studio/*`) vs. legacy
  `app/v4_panel/`, `app/sketch_3d/`. Sketch tooling still routes through legacy.
  → Retire legacy during Phase 1 rather than carry two UIs through all phases.
- **Two picking paths.** Exact proxy picker (`lib/picking/pick_proxies.js`,
  production) vs. heuristic fallback (`face_picker.js`). Delete the heuristic once
  all callers are migrated.
- **Server cache is single-worker.** `b123d_server/server.py` process-level cache
  won't survive multi-worker deploy → needs Redis/memcached before cloud.
- **Misc bugs** in the current build — fix opportunistically as each phase touches
  the relevant area; track them in `TRACKER.md`, don't block the roadmap on them.

---

## The five gaps (priority order)

### Gap 1 — The AI isn't in the app yet *(highest leverage)*
`src/lib/repair/llm_client.js` is a 5-rule mock with a literal
`TODO: wire real LLM provider here`. No Anthropic SDK, no chat panel, no
prompt-to-CAD path. The plumbing (repair loop, typed-op safety rail, measure/invariant
feedback) is done — the expensive part — but no real model is connected.

**Principle:** the AI is an **agent with tools**, never a raw code generator. Our
~70 typed operations in `lib/document/operations.js` map one-to-one onto Claude tool
definitions. The model never writes Python; the typed-op layer is the safety rail.

### Gap 2 — Mates aren't first-class, so "swap the servo" can't exist
Today `placeLibraryPart` solves a mate **once** and collapses it into a component
transform + joint. The document remembers *where* a part landed, not *why*. Swap the
part and there's nothing to re-solve against. This is the architectural blocker for
the headline feature.

### Gap 3 — Library depth is a content problem (and AI is great at it)
~12 parts today (nuts, screws, t-nuts, one NEMA17 composite). A robotic arm needs
servo families, horns/splines, bearings, standoffs, brackets, extrusions, and
electronics (as keep-out volumes with connectors). The `PartRecord` schema +
`standard_parts/build.py` pattern is right; authoring is datasheet→JSON translation,
which the model does extremely well — a batch job, not a grind.

### Gap 4 — Assembly execution is half-landed
- Component transforms (`component.origin`) **exist but aren't emitted to the kernel**,
  so compiled geometry ignores placement. Blocks casings and correct multi-part compiles.
- Single-mate snap only; no DOF tracking; joint limits stored but not enforced.
- Joints defined but kinematics solver not wired into the UI (no articulation drag).

We do **not** need a Fusion-grade simultaneous constraint solver. Sequential mate
solving + the joint graph covers ~90% of hobbyist assemblies.

### Gap 5 — Casing/cover generation doesn't exist *(the differentiator)*
Naive convex-hull enclosures are garbage. The right approach exploits our unique
asset — **semantic connectors** — so the casing is *derived* from the assembly and
auto-updates when a part is swapped. Hardest item; do it last.

---

## Phased roadmap

| Phase | Deliverable | Status |
|---|---|---|
| **1** | Real Claude in the app: chat panel + tool layer over `operations.js` + repair loop on the real model | ✅ done (`1fb937e`) |
| **2** | Persistent Mate records + interface contracts + `replaceComponent` swap-with-rebind | ✅ done (`1fb937e`) |
| **3** | Finish component-transform emission to the kernel (Foundation 6 commits 2–4) | ✅ done (`1fb937e`) |
| **4** | AI part-authoring pipeline; grow library to ~100 parts | 🔄 in progress |
| **5** | Casing generator (offset shell + connector-driven bosses/cutouts + split line) | 🔄 in progress |
| **6** | Joint limits, DOF display, articulation drag; eval corpus of arm-class prompts | 🔄 in progress |

---

## Phase 1 — Real Claude, as a tool-using agent ✅ DONE (`1fb937e`)

**Outcome:** user types a prompt in a chat panel; Claude calls typed operations; the
document mutates; the kernel compiles; measure/invariants feed failures back; the
model iterates until invariants pass or it asks a clarifying question.

**Shipped:** `b123d_server/ai_proxy.py` (server-side key, `/ai/chat` SSE + `/ai/health`);
`src/lib/ai/{tools,agent,provider,system_prompt}.js` (30 typed tools + 5 read tools,
streaming agent loop capped at 12 tool-iterations); `ChatPanel.svelte` wired into
`App.svelte`; `llm_client.js` routes repair through the real model with mock fallback.
Tests: `src/lib/ai/__tests__/tools.mjs`.

**Switchable provider (added `6c3ab93`):** the AI layer is now provider-abstracted —
`src/lib/ai/providers/{index,gemini,anthropic}.js` behind a common interface
(`toolsForProvider`/`buildBody`/`parseResponse`/`makeStreamHandler`). **Default is
Google Gemini** (`gemini-2.5-flash`, key `GEMINI_API_KEY`/`GOOGLE_API_KEY`), with
Anthropic Claude (`claude-opus-4-8`, `ANTHROPIC_API_KEY`) selectable in Settings → AI.
`/ai/health` reports per-provider readiness; the proxy routes to the right upstream and
injects the right key. `settings.ai = {provider, geminiModel, anthropicModel, maxTokens}`.
Tests: `providers.mjs` (11/11). **To run:** set `GEMINI_API_KEY` in the kernel env,
`npm run start`.

- [x] **Tool layer over `operations.js`.** Generate Anthropic tool definitions for the
      ~70 typed ops (`addBox`, `addCylinder`, `addExtrude`, `addFillet`, `addHole`,
      booleans, patterns, `placeLibraryPart`, `setDocumentParameter`, sketch ops…).
      One adapter that validates args against each op's schema before applying.
      *Never* expose raw-Python execution to the model.
- [ ] **Library search as a tool.** `searchLibrary(query)` → catalog hits with
      connectors, so the agent assembles from parts instead of modeling from scratch.
- [ ] **Read/observe tools.** `getDocumentSummary`, `measure(...)`, `runInvariants()`,
      `listComponents()`, `listConnectors(componentId)` — the model's eyes.
- [ ] **Agent loop = the existing repair loop, real model.** Replace
      `callLlmClient` mock in `src/lib/repair/llm_client.js`; dispatch on
      `settings.aiProvider`. Loop: prompt → tool calls → compile → measure/check →
      feed failures → repeat (bounded iterations, then surface assumptions/questions).
- [ ] **Chat panel** in the Svelte studio (`src/lib/components/studio/`), with
      streaming, tool-call display ("placed M3 nut", "filleted +Z edge"), and an
      approve/undo affordance tied to the changelog.
- [ ] **System prompt + few-shot.** Encode Z-up, mm units, "parts before primitives,"
      `Align.MIN`, and the kernel-as-arbiter contract.
- [ ] **Key + cost handling.** API key in settings; token/cost telemetry via existing
      `src/lib/repair/telemetry.js`.
- [ ] **Cleanup:** begin retiring legacy `app/` UI so the agent maintains one frontend.

*Model:* default to the latest Claude (Fable 5 / Opus 4.x) for the agent; see
`claude-api` skill for ids/params. Use tool-use + streaming; consider prompt caching
for the system prompt + tool defs.

---

## Phase 2 — Mates first-class + swap-with-rebind ✅ DONE (`1fb937e`)

**Outcome:** "switch the servo" = one UI dropdown on a component, or one agent tool
call; all mates re-solve, joints rebind, dependent geometry re-derives.

**Shipped:** persistent `Mate` records (`doc.mates`, factories, changelog kinds, fold
handlers, ops); connector `role` + `interfaceId` contracts with interfaceId-precedence
in `connectorsCompatible`; `placeLibraryPart` records a Mate; `replaceComponent()` in
`src/lib/library/replace.js` matches new-part connectors by role>interfaceId>kind,
rebinds mates+joints, surfaces `unresolved` (never silently drops). Tests:
`spec_phase2_mates.mjs` (12/12). **Follow-up:** expose `replaceComponent` as an AI tool
(Phase 4/integration); annotate catalog parts with role/interfaceId (Phase 4).

- [ ] **Persistent `Mate` record** in the document: `{ id, hostConnectorRef,
      partConnectorRef, offset, inducedJoint }`, surviving fold/replay. Stop
      collapsing the solve into an opaque transform.
- [ ] **Interface contracts in the catalog.** Connectors gain stable **role names**
      (`mount-pattern`, `output-shaft`) and standardized **interface IDs**
      (`servo-mount-9g`, `spline-25T`). SG90 + MG90S both declare `servo-mount-9g`;
      MG996R declares `servo-mount-standard`. Compatibility checks against interface
      IDs, not just kind/size.
- [ ] **`replaceComponent(oldId, newPartId)`** operation: match new part's connectors
      to existing mates by role/interface → re-solve every mate transform → rebind
      joints → re-derive downstream geometry (bracket holes, casing cutouts driven by
      connector *queries*, not frozen coords) → flag unresolved mates as warnings.
- [ ] **Agent tool + UI affordance** for the swap.
- [ ] **Tests:** swap SG90↔MG90S keeps mounts aligned; swap to a non-conforming part
      surfaces a clear warning, not a silent break.

---

## Phase 3 — Finish assembly execution in the kernel 🔄 PARTIAL (`1fb937e`)

**Outcome:** placement is real geometry, not just scene-graph decoration.

**Shipped:** `emit.js` composes each leaf feature's world transform from its component
chain (frame-aware 4×4 chaining, radians→degrees) and emits `body.moved(Location(...))`;
root-owned features byte-identical to before; `bridge.js` neutralizes the duplicate
scene-graph transform and documents the "kernel bakes placement" contract. Tests:
`emit_component_transform.mjs` (7/7), `emit.mjs` (26/26 unchanged).
**Known v1 gap (revisit in Phase 5 prep):** a boolean whose operands live in *different*
component frames isn't composed yet (operands at identity, only the result placed).
Reparenting/hierarchy-navigation UI and STEP-insert-as-component still pending.

- [ ] **Emit `component.origin` transforms to Python** (Foundation 6 commits 2–4):
      per-component `featureOrder`, path-qualified features
      (`root/plate_left/hole_1`), transforms applied in the build123d program.
- [ ] **Multi-body / multi-component compile** verified end-to-end (each component
      isolatable; STEP/GLB inserts as components).
- [ ] **Reparenting + hierarchy navigation** in the document and UI.
- [ ] **Regression:** existing single-part docs compile bit-identically (determinism).

---

## Phase 4 — AI part-authoring pipeline + library growth ✅ DONE (`07d5005`)

**Outcome:** library goes from ~12 → ~100 parts via a repeatable, verified pipeline.

**Shipped:** 105 parts (servos, horns/couplers, bearings, standoffs, brackets,
2020–8080 extrusions, electronics keep-outs incl. panel switches), all connectors
carrying `role`/`interfaceId` (vocabulary in `src/lib/library/AUTHORING.md`); kernel
parametric builders (`mechatronic.py`); `scripts/author_part.mjs` datasheet→PartRecord
pipeline with `validatePartRecord` gate; `test_new_parts.py` verifies built bbox vs
datasheet (44/44); AI tools `replace_component` + `add_mate` (29 tools). The headline
"switch the servo with one prompt" is now reachable end-to-end: agent calls
`search_library` → `replace_component`.

- [ ] **Authoring pipeline:** datasheet/dimensions in → AI emits the
      `standard_parts/build.py` builder + catalog JSON + connectors (with roles &
      interface IDs) → eval harness verifies bounding box and connector positions
      against datasheet numbers → commit on green.
- [ ] **Families to cover:** servos (SG90, MG90S, MG996R, Dynamixel-class), horns &
      splines, bearings (608, etc.), standoffs, brackets, aluminium extrusions,
      electronics as keep-out boxes with connectors (driver board, battery, **switch**).
- [ ] **Composite parts** (cf. `nema17-mount.json`) for common subassemblies.
- [ ] Run as a batch / parallel dispatch (fits the swing-for-fences working style).

---

## Phase 5 — Connector-driven casing & cover generator ✅ DONE (`2fb3807`)

**Outcome:** a `Casing` feature that wraps selected components in a fitted, split,
manufacturable enclosure — and updates automatically when a part is swapped.

**Shipped:** `addCasing({targets, wall, clearance, splitPlane, splitAt, lip, bosses,
cutouts})` + `lib/document/casing.js`; emitter unions enclosed world-frame bodies →
`offset(clearance)` / `offset(clearance+wall)` → uniform wall; `CONNECTOR_GEOMETRY_MAP`
turns connectors (world-transformed via `composeComponentTransform`) into screw bosses,
cutouts, or skips mate-only sites; split into top/bottom halves with a lip/groove rabbet;
**auto-updates on swap** (reads connectors fresh each emit); defensive nested try/except
in the emitted Python; `add_casing` AI tool (30 tools). Tests: `casing.mjs` (10/10).

**v1 gaps to revisit:** (1) boss/cutout tools are axis-aligned (+Z) translated to the
connector point — not yet rotated to a non-Z connector axis; (2) corner self-tapping
bosses at the split line not emitted (lip/groove is); (3) standoffs-under-mount-pattern
folded into per-connector bosses; (4) casing geometry is AST-validated but not yet
kernel-executed in CI (no live OCCT here) — needs a real-kernel smoke run.

- [ ] **`Casing` feature** over a component set:
  - [ ] Offset shell: union components → offset outward by clearance → shell at wall
        thickness (build123d offset/shell).
  - [ ] **Connector-driven functional geometry:** screw **bosses** at fastener
        connectors; **cutouts** where shafts/rails/cables cross a wall (any connector
        whose axis pierces the shell); **standoffs** under mount patterns.
  - [ ] **Split** along a chosen plane into halves with lip/groove + self-tapping
        bosses.
  - [ ] Run DFM checks (min wall, draft) on the result.
- [ ] **Auto-update on swap:** because geometry is derived from connectors, a Phase-2
      part swap moves bosses/cutouts for free. This is the jaw-drop demo.
- [ ] Expect iteration; budget accordingly.

---

## Phase 6 — Kinematics polish + eval corpus ✅ DONE (`07d5005`)

**Outcome:** assemblies articulate; "build a robotic arm"-class prompts are a
regression net, not a one-off demo.

**Shipped:** `src/lib/kinematics/limits.js` — `clampJointValue` (limit-aware),
`driveJoint` (clamps → persists drive → recomputes child origins through the ops
pipeline, so a parent joint moves the whole chain), `computeDof`
(mobile/locked/over-constrained); `KinematicsPanel.svelte` with per-joint sliders that
articulate the assembly live (mounted via the Inspector tab); `i-assembly-dof-sane`
invariant; arm-class eval corpus (2/3/6-DOF). Tests: `articulation.mjs` (13/13),
eval 35/35. **Note:** articulation is slider-driven (3D drag gizmo deferred as planned).

- [ ] **Joint limits enforced** during drag (clamp revolute deg / prismatic mm).
- [ ] **DOF display** — visualize "slides along rail" vs. "locked"; flag
      under/over-constrained subassemblies.
- [ ] **Articulation drag** — wire `src/lib/kinematics/solver.js` into the viewport.
- [ ] **Eval corpus** of arm-class prompts with geometric assertions (reach,
      part count, no interference at rest, no interference along trajectory).

---

## Working-style guardrails (operator builds via AI, not by hand)

- **Eval harness is the substitute for a developer's eye.** Every new capability
  ships with geometric assertions (`tests/eval/*`, invariants, measure API). This is
  non-negotiable given measurement-first design.
- **Typed ops are the safety rail.** The agent calls schema-validated operations;
  it never emits raw Python. Keep it that way.
- **One frontend.** Retire legacy `app/` UI early (Phase 1) so each AI agent has half
  the surface to keep consistent.
- **Bugs handled inline.** Fix current-build bugs as each phase touches the area;
  log them in `TRACKER.md`; don't gate the roadmap on a bug backlog.
