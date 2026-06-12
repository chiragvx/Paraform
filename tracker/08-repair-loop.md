# Phase 2.2 — Generate → measure → repair loop

> **Status (2026-06-07): ✅ landed (with stubbed LLM client).**
> The tiered pipeline (deterministic extractor → constraint→ops mapper →
> invariants + DFM → LLM residual) ships as `src/lib/repair/`. The LLM
> client is a deterministic mock backed by a small rule table
> (`src/lib/repair/llm_client.js`); real provider wiring is the open
> `// TODO: wire real LLM provider here`. Studio surface:
> `src/lib/components/studio/RepairLoopPanel.svelte`. Per-run telemetry
> appends to `tests/eval/repair_runs.jsonl`. 22 unit assertions in
> `src/lib/__tests__/spec08_repair.mjs`.

> **Scope amended (2026-06-07).** The original framing had the
> acceptance checks co-generated with the ops in one LLM response.
> Feedback-driven critique surfaced that this lets the model grade
> its own homework: the same model writes both halves and the
> measure layer faithfully confirms the model's misreading. The
> spec→acceptance compiler is now **tiered across three layers**:
> [spec 15 deterministic extractor](15-deterministic-extractor.md)
> (layer 1, non-LLM), [spec 16 invariant library](16-invariant-library.md)
> (layer 2, curated), and an LLM residual compiler (layer 3, scoped
> to what 1+2 couldn't structure). The op generator stays in this
> spec but consumes constraints from layer 1+2 as inputs; its
> self-declared acceptance becomes a redundancy signal, not the
> authority. See "Tiered compiler architecture" below.



> Phase 2 of [TRACKER.md](../TRACKER.md). Strategy: [STRATEGY.md](../STRATEGY.md) §A2–A4.
> Heart of credible AI accuracy. Depends on 07 (Measure API).

## TL;DR

The architectural rule from STRATEGY.md A1 made executable: AI emits
**schema-validated feature-ops** (never raw code), kernel produces
ground truth, measure compares result against spec, classified errors
feed back as repair signal. Bounded retry budget. Fallback to "ask
the human" when retry budget exhausted.

## Why foundation

A1+A2+A3+A4 from STRATEGY.md. Without this loop:
- The model emits malformed Python that the kernel can't parse →
  opaque failure.
- The kernel rejects a boolean → no useful signal to the model.
- The model bakes in wrong constants → user has no steering wheel
  (mitigated by F5 parameters, but only if the AI is required to use
  them).
- "Accurate" is unmeasurable.

This is THE Phase 2 deliverable. Everything else is supporting.

## Current state

**Validated emit infrastructure (mostly built):**
- [lib/document/emit.js](../lib/document/emit.js) — typed v4 feature catalog
  emits to build123d Python. F4 wire landed Query DSL through emit at
  resolve time.
- [lib/document/types.js](../lib/document/types.js) — typed Feature factories
  validate shapes today (`makeFeature` etc.).
- F2 captures `kernelVersion` on each response.
- F3 corpus measures naming durability across param edits.
- F5 expression evaluator gives the model parametric output.

**Missing AI surface:**
- No LLM client.
- No prompt/response scaffolding.
- No structured feature-op schema (the model would emit JSON, the JS
  side would validate + reify into v4 ops — distinct from the runtime
  Python emit).
- No repair-loop driver.

**Kernel error pipeline:**
- [lib/document/executor.js](../lib/document/executor.js) catches Python
  errors. [bridge.js](../lib/document/bridge.js) dispatches
  `kernelError` events. UI shows a chip.
- Error strings are unclassified — `"boolean failed"` blends with
  `"non-manifold geometry"` and `"fillet radius exceeds edge length"`.

## Scope

**In:**
- New `src/lib/ai/` directory:
  - `schema.js` — JSON-Schema-ish typed feature-op schema mirroring v4
    catalog. Every op (`AddBox`, `AddExtrude`, `AddFillet`, etc.) has
    a strict input shape; refs use queries (F4) when targeting upstream
    geometry.
  - `validate.js` — validates a model response against the schema
    before reification. Returns `{ ok, ops, errors }`. The model can
    auto-repair on schema violations (one pass).
  - `reify.js` — turns a validated op-list into v4 commits via
    `lib/document/operations.js` calls.
  - `client.js` — thin LLM client (provider-agnostic). Configurable
    via env / settings.
  - `prompts/` — system prompt + task-specific templates.
- Kernel error classifier (`b123d_server/error_classify.py` +
  surfaced into the `/execute` response under
  `error: {category, code, hint}`):
  - Categories: `parse`, `kernel_op_failed`, `boolean_failed`,
    `non_manifold`, `over_constrained_sketch`, `naming_unresolved`,
    `oom`, `timeout`, `unknown`.
- Repair-loop driver (`src/lib/ai/loop.js`):
  - Takes a spec (free text + optional assumptions) → generates an
    op-list → reifies → kernel runs → measure results compared to
    spec acceptance criteria.
  - On mismatch OR classified error: feed delta + error back to the
    model. Up to N retries (default 3).
  - On exhaustion: surface "needs human" in the UI with the last
    valid intermediate state preserved.
- New "Build with AI…" command in the registry + a small dialog for
  the spec input.

**Out:**
- Multi-turn conversation with the model (v1 is single-task, fresh
  state each invocation).
- Function-calling / tool-use APIs beyond the structured output schema.
- Streaming partial results into the UI (one-shot, then commit).

## Dependencies

- **07 Measure API** — the comparison step calls measure to verify
  against the spec.
- F1 smoke harness — same infra as eval (12).
- F2 determinism — captured per-call as part of the manifest.
- F3 / F4 — the AI emit references upstream features via Queries.
- F5 — the AI MUST emit Parameters (not bare constants) so the user
  can edit.

## Critical files

- New: `src/lib/ai/{schema,validate,reify,client,loop}.js`.
- New: `src/lib/ai/prompts/*.md`.
- New: `b123d_server/error_classify.py`.
- Modify: `b123d_server/server.py` — attach classified error to
  `/execute` response.
- Modify: [lib/document/bridge.js](../lib/document/bridge.js) — surface
  classified errors on `lastError`.
- Modify: [src/lib/commands/registry.js](../src/lib/commands/registry.js) —
  add `ai.build` command.
- New: `src/lib/components/studio/AIBuildDialog.svelte` — spec input
  textarea + assumptions panel hook (09) + iteration trace.
- New: `src/lib/ai/__tests__/*.mjs` — schema validation, reification,
  retry budget, error-classification round-trip.

## Acceptance

- "Make a 40 mm cube with a 6 mm through-bore on center" generates a
  Box + Hole pair via the AI emit path, reifies, kernel runs, measure
  confirms bbox + hole diameter within tolerance.
- A deliberately-malformed model response gets schema-rejected and
  auto-repaired in one retry.
- A boolean-fail kernel error classifies as `boolean_failed` and
  surfaces in the UI with the suggested fix the model produced.
- Retry budget exhausts cleanly on an impossible spec (e.g., "5 mm
  fillet on a 1 mm-thick wall") without infinite-looping.

## Open questions

- LLM provider: Anthropic / OpenAI / local. Recommendation: provider-
  agnostic interface; configure via `settings.general.aiProvider`.
- Schema format: hand-rolled vs. zod-like. Hand-rolled is fewer deps.
- Where the model's "assumed" parameters go: into the document's
  parameter table (F5) tagged as AI-generated.

## Tiered compiler architecture

The spec→acceptance compiler is the structural fix for the
self-grading problem. Three layers:

**Layer 1 — Deterministic extractor ([spec 15](15-deterministic-extractor.md)):**
- Pure JS grammar/parser, no LLM.
- Handles the structured part: dimensions, ISO codes, fit classes,
  fastener callouts, tolerances, materials, processes.
- Output: typed atomic constraints with a `residualText` field for
  what didn't parse.
- These constraints flow into the op generator as *input
  constraints* and into the acceptance compiler as *checks*.

**Layer 2 — Invariant library ([spec 16](16-invariant-library.md)):**
- Hand-curated set of constraints that always apply, regardless of
  user spec. Manifold, no inter-feature interference, every
  fastener has thread engagement + bearing surface, every body has
  a material, bearing bores fall in a fit class, etc.
- Versioned. Audited. Cited per-invariant.
- These are the implicit constraints models forget because they
  think they're free. The library makes them explicit and gates
  against them regardless of what the model emitted.

**Layer 3 — LLM residual compiler (this spec):**
- Only runs on the `residualText` from layer 1, on portions of
  the spec that didn't parse deterministically.
- Its output is **labeled accepted-risk surface** — the user sees
  which acceptance checks came from interpretation vs deterministic
  extraction vs invariant library.
- Bootstrap mode (during corpus building): co-generated with ops,
  *explicitly labeled as self-grading*, used to build the eval
  corpus before the rigorous mode is shipped. Documented in the
  UI ("AI-grading mode — verification limited").
- Production mode: only on residuals, with the layers above as
  authority.

**Coverage gate:** at reify time, the union of (layer 1 constraints
+ layer 2 invariants + layer 3 checks) must cover every constraint
the user said and every invariant the engineering convention
requires. Unmapped → loop refuses to commit → "needs human" with
the gap surfaced.

## Repair-signal classification

Following the feedback critique that the loop conflates "bad plan"
with "bad kernel" — and that nothing guarantees convergence — the
repair-signal pipeline distinguishes:

- **Plan delta** — model emitted a parameter that's clearly wrong.
  Repair: ask the model to update that parameter.
- **Semantic / kernel delta** — model emitted the right parameter,
  the kernel produced something else. Repair: ask the model to
  audit the op semantics (radius vs diameter? unit confusion?
  default override?). *Never* let the model compensate by nudging
  the parameter; that masks a kernel bug.
- **Invariant violation** — a layer-2 invariant fired. Repair: feed
  the invariant's `rationale` + a structural hint ("add bearing
  surface area," "increase wall thickness in the load path").
  Convergence not guaranteed; may escalate to "needs human."
- **Coverage gap** — constraint extracted by layer 1+2 has no
  corresponding check produced by the loop. Repair: hard-fail with
  the missing-coverage report.

Convergence enforcement: track a distance metric across retries;
abort early on non-monotonic progress. Forbid any "compensating"
parameter change where the model just set the parameter and the
measured value disagrees. Cap by wall-clock + compute, not retry
count.

## Bootstrap order

Honest acknowledgement of the chicken-and-egg: the eval corpus
needs real generations to know the constraint distribution; the
rigorous compiler needs the corpus to be designed against. The
bootstrap:

1. Ship layer 1 (deterministic extractor) — corpus-grounded against
   existing engineering text (drawings, ECNs, supplier datasheets).
   No own-generations needed.
2. Ship layer 2 (invariant library) — corpus-grounded against
   engineering convention. Authoring is the work.
3. Ship a naive co-generation loop *labeled as self-grading*,
   gated to internal eval use only. Generates the corpus that
   shows the actual residual-text distribution.
4. Design layer 3 against that distribution. Promote loop from
   bootstrap mode to production.

Step 3 *is* the same self-grading the architecture wants to avoid —
but bounded, internal, and explicitly labeled. The alternative
("ship rigorous independence on day one") asserts the property the
architecture is supposed to produce.

## Effort

~3-4 weeks. Schema + validate + reify (~1 week). Error classifier
(~3 days). Repair-loop driver (~1 week). Client + prompts +
iteration (~1 week). Hardest item in Phase 2.
