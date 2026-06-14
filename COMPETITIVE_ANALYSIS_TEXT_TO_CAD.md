# Text-to-CAD Competitive Analysis & Phased Build-out

> How Zoo.dev (Zookeeper / Text-to-CAD / KCL) and earthtojake ("CAD Skills")
> achieve accuracy and repeatable complex models, where **3d_play** stands, and
> how we reach then surpass them. Includes the implementation shipped in this
> pass and a manual test checklist.
>
> Date: 2026-06-15 · Sources: primary docs (Zoo blog/FAQ/docs/research, the CAD
> Skills `SKILL.md` + reference files read verbatim) + the research literature,
> adversarially fact-checked (high confidence). Corrections applied: Zoo's
> self-repair cap is documented at **5 fixes**; CAD Skills' workflow is **9
> steps**; Zoo returns **GLTF+STEP** by default; the claim that Zoo's old
> "ML-ephant" trained on *NX/Creo/CATIA/SolidWorks feature trees* is
> **unsupported** (Zoo only says "trained on proprietary data") and is softened
> throughout.

---

## 0. The finding that reframes the question

The premise — "how do they get high accuracy from *basic* models?" — is false on
inspection. **The accuracy was never mostly in the model; it's in the scaffold
around a strong model.**

1. **Zoo pivoted.** Their 2023 bet *was* a fine-tuned model ("ML-ephant"). In
   **Jan–Feb 2026 they abandoned it** and rebuilt Text-to-CAD as **Zookeeper —
   an agentic loop over general-purpose frontier LLMs**, described in their own
   docs as *"similar to Codex and Claude Code, with strict context management."*
   They now run o3 / Opus / Gemini-2.5-Pro-class models and **explicitly select
   the best spatial reasoner** (their open-source `llm-spatial-reasoning-tests`
   benchmarks 6 frontier models on 60 prompts).
2. **earthtojake's "text-to-cad" ships no model at all.** It rebranded to **"CAD
   Skills"** — a library of agent *skills* (markdown system-prompts +
   deterministic Python/JS CLI tools) you install into Claude Code or Codex.

So the lever is the scaffold. Our scaffold is comparable or better in places —
but **we starved it** by hard-locking to free `gpt-oss-120b` and leaving our
best loops (visual review, assembly self-repair) optional. **We are at/ahead on
the foundation, we own a moat nobody else has (the connector/mate assembly
model), and we lose on three fixable things: model quality, an enforced visual
loop, and the absence of any eval.**

---

## 1. The field's converged recipe (macro)

Everyone converged on the same 4-layer stack. Unifying insight: *a deterministic
geometry kernel is simultaneously the data engine, the verifier, and the reward
signal that turns a stochastic LLM into a repeatable CAD generator.*

| Layer | What it does | Why it raises accuracy/repeatability | Us |
|---|---|---|---|
| **1. Symbolic, executable output** | Emit a *program* — DSL (KCL), typed op-sequence, or parametric code — **never mesh** | Constrained grammar = far fewer invalid programs; text plays to LLM strengths; editable/diffable/re-runnable | **Ahead** (typed ops, never raw code) |
| **2. Deterministic kernel** | One canonical engine executes the program | Same input → same geometry → reproducible regeneration | **At parity** |
| **3. Execute → verify → repair** | Run it, measure it, *look* at it, feed errors back | Converts one-shot gen into convergent search; invalidity → ~1% | **At parity** (with 2 holes, now fixed) |
| **4. Eval + data flywheel** | Benchmark (Chamfer/IoU/validity/negative); synthesize verified data | You can't improve or prove what you can't measure | **Was zero → now seeded** |

---

## 2. The specific techniques (micro), ranked by accuracy bought

1. **Mandatory multi-view snapshot review + "convert every visual concern to a
   measurement."** CAD Skills mandates two opposed isometrics + top + front;
   *"Visual review is diagnostic, not authoritative"* — any visual suspicion
   must become a `measure` call. **CADSmith: removing visual feedback caused
   ~35× Chamfer regression.** The single biggest lever; we under-used it.
2. **Execute-and-feedback self-repair on every mutating op.** Zoo caps at **5
   fixes**; CAD Skills has an 8-class failure taxonomy + "smallest responsible
   change." We had it — with two holes (mates/connectors skipped the check).
3. **Constrained symbolic output (DSL / typed ops, never mesh).** We're *ahead*:
   ~70 JSON-schema-validated ops, `dispatchTool` never throws, atomic sketch
   commit — more constrained and weak-model-robust than free-form KCL/Python.
4. **Research + design-plan-before-modeling + proactive clarification.** ProCAD:
   clarifying ambiguity first dropped invalidity **14.6% → 0.9%** (a
   repeatability lever — variance comes from under-specified prompts).
5. **Model selection across frontier LLMs.** Zoo picks the best spatial
   reasoner. Our biggest single gap.
6. **Data/eval flywheel.** Procedurally generate → verify by kernel within a
   Chamfer threshold → keep. **CAD-Coder: 8k high-quality > 70k medium**; then
   RL (GRPO/DPO) with a geometric reward (CD 6.54 vs Text2CAD 29.29).
7. **The technique only we have: a semantic connector/mate assembly model** (§4).

---

## 3. The three players

- **earthtojake → "CAD Skills"** (6,351★, MIT, created Apr 2026): an
  agent-skills library (build123d/OCCT, STEP-authoritative). Strength is
  *methodology discipline* (lazy-loaded skill markdown, mandatory snapshot,
  8-class repair taxonomy, 10-task benchmark with acceptance tables, off-the-
  shelf STEP sourcing). Assembles via raw build123d joints — **no assembly
  contract**.
- **Zoo.dev → Zookeeper** (formerly KittyCAD): Era 1 fine-tuned model abandoned;
  Era 2 = agentic loop over frontier LLMs emitting **KCL** (deterministic
  parametric DSL) to a closed-source **GPU-native cloud B-rep engine** (3D view
  is a WebRTC video stream). Self-repair ≤5 fixes; computes mass/CoM/area/volume;
  multimodal ingest; metered by reasoning time. **No published accuracy
  numbers.** Complex-model answer (*"fleets of agents"*) is roadmap, **unbuilt**.
- **Research frontier** (DeepCAD, Text2CAD, CAD-Coder, CADSmith, Query2CAD,
  AIDL, SketchGraphs): where the techniques originate. Flagged limit: multiple
  valid feature trees per shape, so *construction-sequence* determinism is
  genuinely unsolved — most metrics score geometry, not build steps.

---

## 4. Where 3d_play stands

**Strengths (parity or ahead):** deterministic feature-DAG → build123d emitter
(float-cleaned, byte-identical, locked Euler-XYZ with a compound-rotation
regression test); a more-constrained-than-KCL typed-op surface; three working
self-repair nets (compile-check, vision re-injection, dup-fail guard);
kernel-as-arbiter verification (`measure`/`mass_properties`/`run_invariants`/
`self_critique`); viewport deixis + rich per-turn context.

**Gaps (all fixable, addressed below):** (1) hard-locked to free `gpt-oss-120b`,
no escalation; (2) no mandatory visual gate; (3) no eval/benchmark/flywheel;
(4) self-repair holes — `add_mate`/`declareConnector` were allowlisted
non-mutating; (5) no complex-model decomposition / no global DOF accounting;
(6) casing bosses were +Z-only (non-Z connectors mis-orient).

**The moat — only we have it:** a semantic connector/mate assembly model — the
9-rule connector contract, a pure SE(3) mate solver with compatibility
precedence (`profile > interfaceId > kind/gender/size`), induced joints,
profile-generated T-slot ports, persistent mates that re-solve on part swap, and
a connector-driven casing generator. Competitors emit *a solid*; **we emit a
fit-checked, swap-stable assembly.**

> Note discovered while implementing: `declareConnector` is **already fully
> implemented** and works on custom-built features (it takes a `featureId`). The
> real gap was *orchestration* — nothing planned a decompose→build→declare→mate→
> verify flow. The new planner closes that.

---

## 5. How we reach, then surpass

**Reach:** enforce the visual loop, unlock a strong model for hard steps, plug
the self-repair holes, build an eval harness. None of it is novel research — it's
turning on loops we already half-built.

**Surpass:** make the assembly moat *measurable* and *AI-native*. Our
decomposition seams are **semantic** (components = sub-assembly tree, connectors
= attachment boundaries), so a connector-aware planner beats Zoo's generic
"fleets of agents" and CADSmith's part-agnostic pipeline. Pair it with an
**assembly-aware benchmark** (mate solved? zero interference? correct induced
joint? casing boss aligned? swap-stable?) — checks **no competitor benchmark
has** — and an **assembly-aware data flywheel** (synthesize
`(assembly-spec, connector/mate program, verified assembly)` triplets nobody
else can generate). The moat becomes a provable lead on multi-part design, which
is exactly where single-shot text-to-CAD collapses.

---

## 6. What was implemented in this pass

All phases one-shot. Unit-tested (not browser-tested — see the checklist in §7).
Actual RL *training* is offline-GPU and intentionally **not** coded — only its
data + reward substrate is, with an honest plan in `FLYWHEEL.md`.

### Phase 0 — turn on the loops we already built
- **P0.1 Mandatory visual-verify gate.** `agent.js`: the loop now refuses to
  finish a turn that built/changed geometry without a `capture_views` since the
  last mutation — one forced reminder (`VISUAL_GATE_NUDGE`), bounded so it can't
  loop. `system_prompt.js`: "Seeing your work" is now MANDATORY with the *"a
  render is diagnostic, not authoritative — convert every visual concern into a
  measure call"* rule.
- **P0.2 Self-repair allowlist fix.** `agent.js`: removed `add_mate` and
  `declareConnector` from `NON_MUTATING_TOOLS`, so a build-breaking mate or a
  bad connector now trips the auto compile-check (assembly failures self-heal
  like geometry failures). `tools_assembly.js`: `declareConnector` now rejects a
  connector too permissive to mate safely (gender `neutral` + size
  `unspecified` + no profile/interfaceId → clip-through; Rule 4).
- **P0.3 Proactive brief gate.** `system_prompt.js`: vague/multi-part goals MUST
  call `propose_brief` first (before any mutating op) with ≤2 geometry-changing
  questions, and check against the brief at the end.

### Phase 1 — stop starving the scaffold + start measuring
- **P1.1 Stronger-model escalation.** `agent.js` + `settings`: new opt-in
  `ai.escalationModel` (blank = off, so the deliberate free-model lock stands).
  When set, the loop switches to it **only for hard steps** (self-repair after a
  compile failure, or a stuck repeated-failure) for the rest of the turn — the
  cheap default still drives the easy majority of steps.
- **P1.2 Assembly-aware eval harness.** New `src/lib/ai/eval/`: a 10-task
  benchmark (single-part + assembly tasks) with deterministic acceptance +
  **negative** + **assembly-specific** checks (`mateSolved`, `inducedJoint`,
  `casingBossAligned`, `swapStable`); a pure `scorer.js`; a markdown
  `scoreboard.js` with literature-comparable metric placeholders (Chamfer/IoU/
  invalidity); a deterministic `data_synth.js` triplet generator with a
  verify-keep gate; `FLYWHEEL.md`. Kernel-free + import-only, 15/15 tests pass.
- **P1.3 Axis-aware casing.** `lib/document/emit.js`: a deterministic
  `_zToAxisRotation` helper now reorients every boss (and its coaxial pilot
  bore) and every cutout tool onto the connector's **world axis** before
  translating to the contact point — a side-facing fastener finally gets a
  side-facing boss instead of a +Z one.

### Phase 2 — the moat plays
- **P2.1 AI connectors on custom bodies.** Confirmed already shipped
  (`declareConnector`), now hardened (P0.2) and orchestrated by the planner.
- **P2.2 Connector-aware decomposition planner.** New
  `src/lib/ai/planner.js` + `tools_planner.js`: `plan_assembly` returns the
  canonical, seam-aware step list (decompose → place/build → declareConnector on
  custom parts → mate at connectors → verify after each mate + a final
  whole-assembly verify). Wired into the agent surface; the system prompt tells
  the agent to call it first on multi-part goals. 8/8 tests pass.

### Phase 3 — the heavy layers (buildable parts)
- **P3.1 Data flywheel substrate** — shipped as `data_synth.js` + `verifyTriplet`
  + `FLYWHEEL.md` (RL training itself is offline-GPU, documented not coded).
- **P3.2 Global assembly DOF/constraint solver.** New
  `src/lib/library/assembly_constraints.js`: Grübler/Kutzbach mobility, loop
  detection, under/exactly/over-constrained classification, floating-part
  detection — pure + deterministic over the real mate graph. Exposed read-only
  to the agent as `check_assembly_constraints`
  (`src/lib/ai/tools_assembly_check.js`). 6/6 tests pass.
- **P3.3 RL post-training** — honest plan only (prerequisite-gated on the
  benchmark + flywheel; needs offline GPU runs).

**Files touched:** `src/lib/ai/agent.js`, `system_prompt.js`, `tools.js`,
`tools_assembly.js`, `app/settings/index.js`, `lib/document/emit.js`,
`package.json`. **New files:** `src/lib/ai/tools_planner.js`,
`tools_assembly_check.js`, `planner.js`, `src/lib/ai/eval/*` (tasks/scorer/
scoreboard/data_synth/FLYWHEEL.md + test), `src/lib/library/assembly_constraints.js`
(+ test).

**Automated tests run this pass (all green):** emit 30 · eval 15 · DOF 6 ·
planner 8 · AI tools 14 · AI tools extended 10 · auto-mode 3 · agent e2e 9 ·
syntax-check on all 7 hand-edited files.

---

## 7. Manual test checklist (for you to run later)

> Not run by me. The app boots dark; these are behaviors to verify in the
> running studio + a few `node` one-liners.

### Phase 0
- [ ] **Visual gate:** in AI chat, ask it to build a part *without* asking for a
  render. Confirm it is forced to `capture_views` and inspect before it claims
  done (you'll see an `[automatic check]` visual nudge), and that it turns a
  visual concern into a `measure` call rather than asserting from the picture.
- [ ] **Visual gate doesn't loop:** confirm it nudges at most once — if the model
  ignores it, the turn still completes (no infinite loop).
- [ ] **Self-repair on mates:** create a mate that breaks the compile; confirm the
  `[automatic check]` compile-repair now fires *after* `add_mate` (previously it
  was skipped).
- [ ] **declareConnector hardening:** ask the AI to declare a connector with
  `gender:"neutral"`, size `"unspecified"`, no profile/interfaceId → expect a
  rejection ("too permissive to mate safely"). A connector with a numeric size
  *or* explicit gender *or* a profile still succeeds.
- [ ] **Brief gate:** give a vague multi-part request ("design a wall-mount for my
  router") → confirm it calls `propose_brief` first, surfaces assumptions, asks
  ≤2 geometry-changing questions, *then* builds. A single primitive ("a 20mm
  cube") should still build immediately with no brief.

### Phase 1
- [ ] **Model escalation:** set `ai.escalationModel` (settings) to a stronger
  OpenRouter id; force a compile failure and confirm the *repair* turn uses the
  escalation model (watch the proxy/network). With `escalationModel` blank,
  confirm behavior is unchanged (free model throughout).
- [ ] **Eval harness:** `node src/lib/ai/eval/__tests__/eval.test.mjs` → "15
  passed". Render the empty scoreboard:
  `node -e "Promise.all([import('./src/lib/ai/eval/scorer.js'),import('./src/lib/ai/eval/scoreboard.js'),import('./src/lib/ai/eval/benchmark/tasks.js')]).then(([s,b,t])=>console.log(b.formatScoreboard(s.scoreSuite(t.BENCHMARK_TASKS,{}))))"`
- [ ] **Data-synth determinism:**
  `node -e "import('./src/lib/ai/eval/data_synth.js').then(m=>console.log(JSON.stringify(m.synthDataset(20))===JSON.stringify(m.synthDataset(20))))"`
  → `true`. Eyeball an assembly triplet: `synthTriplet(3)` has
  `placeLibraryPart` + `declareConnector` + `add_mate` and an `inducedJoint`
  assertion.
- [ ] **Axis-aware casing:** build an enclosure around a part that has a
  **side-facing (non-Z)** connector (e.g. an X-axis bolt/port); generate casing;
  confirm the boss/cutout is oriented along the connector axis (not straight up),
  visually and via `measure`. A +Z connector should look unchanged.

### Phase 2
- [ ] **plan_assembly:** ask for "M5 bolt and nut clamping two plates"; confirm
  the agent calls `plan_assembly` first and returns a step checklist before
  building; a custom-built part gets a `declareConnector` step *before* its mate.
- [ ] **Template plan:** `plan_assembly` with no `parts` returns
  `plan.template === true` for the agent to fill in.
- [ ] **AI connectors on custom bodies:** have the AI build a custom bracket,
  `declareConnector` on it, then mate another part to that connector.

### Phase 3
- [ ] **check_assembly_constraints:** mate two parts fixed → expect
  `exactly-constrained`, mobility 0. Bearing + shaft revolute → `under-constrained`,
  mobility 1. A part dropped but never mated → listed in `floating`. A closed
  4-bar loop → `detectLoops` returns the cycle. Two fixed mates welding the same
  part twice → `over-constrained` with the redundant mate ids.
- [ ] **FLYWHEEL.md / RL scope:** read `src/lib/ai/eval/FLYWHEEL.md`; confirm the
  RL section is honestly scoped (verifier + data engine shipped; GRPO/DPO
  training is offline-GPU, not in this repo).

### Integration
- [ ] `npm run build` — confirm all new ESM imports resolve in the bundler.
- [ ] `node --import ./src/lib/commands/__tests__/_register.mjs src/lib/ai/__tests__/tools_extended.mjs`
  → confirms `plan_assembly` / `check_assembly_constraints` are in `AGENT_TOOLS`
  with unique names.

---

## 8. Next moves (post-merge, by impact)

1. **Wire a live benchmark runner** (`tests/eval/cad_bench_runner.mjs`) that
   drives the agent over `BENCHMARK_TASKS`, compiles, measures a `DocResult`, and
   prints the scoreboard — the first real model-quality number, and the proof of
   the assembly lead.
2. **Run a small spatial/CAD probe** (mirror Zoo's harness) to pick the default
   `escalationModel`.
3. **Expand the verified library** (brackets/pulleys/rails/washers → real
   geometry with connectors) — each compounds the assembly advantage.
4. **Surface `check_assembly_constraints` in the UI** (a DOF/mobility readout per
   the `PLAN.md` KinematicsPanel) once the agent path is proven.
5. **Then** the data flywheel at volume → RL post-training with a geometric **+
   assembly** reward (unique to us).
