# AI eval + data flywheel

This directory is the project's first **eval infrastructure** and the substrate
for a CAD **data flywheel**. It is deliberately *kernel-free and deterministic*:
every module here scores a plain measured result object, so the whole thing is
unit-testable and reproducible. The online parts (compile on the kernel, run the
agent) live in the runner that the orchestrator wires up — see "Wiring" below.

## Files

| File | Role |
| --- | --- |
| `benchmark/tasks.js` | The benchmark suite as data — ~10 CAD tasks, single-part + assembly, each with a deterministic acceptance/negative/assembly spec. |
| `scorer.js` | Pure functions that score a measured `DocResult` against a task spec. No kernel, no network. Defines the `DocResult` typedef. |
| `scoreboard.js` | Formats `TaskScore[]` → a markdown table + aggregate pass-rate, with placeholder columns for the text-to-CAD literature metrics. |
| `data_synth.js` | Deterministic generator of `(prompt, typedOpProgram, acceptanceSpec)` triplets + the `verifyTriplet` keep-gate (reuses the scorer). |
| `__tests__/eval.test.mjs` | Node tests for the scorer, synth determinism, and the gate. |

## The data-flywheel loop

```
        ┌─────────────────────────────────────────────────────────┐
        │                                                         │
        ▼                                                         │
  1. SYNTHESIZE        2. EXECUTE            3. VERIFY            4. KEEP
  data_synth.js   ─▶   on the kernel    ─▶   scorer.js      ─▶   dataset
  synthTriplet(i)      (runner: run the      verifyTriplet()      (prompt,
  → (prompt,           typedOpProgram,       re-scores the         program,
     typedOpProgram,   measure a             executed geometry     spec) kept
     acceptanceSpec)   DocResult)            against its OWN spec   only if ok
        │                                                         │
        └──────────────  grow / mutate the generators  ◀──────────┘
```

1. **Synthesize.** `synthTriplet(index)` deterministically emits a triplet:
   a natural-language `prompt`, a `typedOpProgram` (an array of
   `{ tool, input }` using **real** project tool names — `addBox`,
   `addCylinder`, `addHole`, `addSketch`, `addExtrude`, `placeLibraryPart`,
   `declareConnector`, `add_mate`), and an `acceptanceSpec`. Variation is
   index-seeded only — `synthTriplet(7)` is byte-identical every call.

2. **Execute.** The runner replays the `typedOpProgram` through the same
   `dispatchTool` the agent uses, compiles on the kernel, and measures a
   `DocResult` (bbox / volume / solidCount / holeCount / interference / mates).
   This is the only online step; it is NOT in this directory.

3. **Verify.** `verifyTriplet(triplet, docResult)` reuses `scorer.js` to score
   the executed geometry against the triplet's own `acceptanceSpec`. This is the
   Chamfer-threshold "is this sample good enough to train on" idea, expressed
   with our deterministic acceptance checks instead of a single float — and,
   crucially, with **assembly** checks (`mateSolved`, `inducedJoint`) a
   primitives-only pipeline can't express.

4. **Keep.** Only triplets that pass enter the dataset. Bad generations (a
   program that doesn't actually produce its claimed geometry) are dropped, so
   the dataset is self-cleaning. Failures feed back into improving the
   generators (or, later, the model).

## Eval metrics

`scoreboard.js` reports two pass-rates:

- **task pass-rate** — fraction of tasks where *every* check passed (the headline
  number).
- **check pass-rate** — fraction of individual checks passed (finer signal; an
  8/9 task is distinguishable from a 0/9 one).

The scoreboard also carries a **single-part literature-metrics** block with
placeholder columns so our results become comparable to published text-to-CAD
work once a runner measures them against a reference solid:

- **Chamfer distance** (mm) — point-set distance between generated and reference
  surface; the standard geometric-fidelity metric.
- **IoU** — voxel/mesh intersection-over-union of generated vs. reference solid.
- **Invalidity ratio** — fraction of generations that fail to compile to a valid
  solid at all.

These are intentionally *not* computed here — they require the reference solid
and the kernel. The column exists so the table is already the right shape.

### Assembly metrics (our moat)

No public text-to-CAD benchmark scores assembly. These checks do, because the
connector contract + mate solver make them measurable:

- `mateSolved` — every recorded mate produced a finite SE(3) transform.
- `inducedJoint` — the mate induced the correct joint kind (revolute / prismatic
  / fixed) per the connector contract (bearing+shaft → revolute, slot+nut →
  prismatic).
- `casingBossAligned` — generated-casing screw bosses line up with their lid
  counterparts.
- `swapStable` — `replace_component` rebinds every mate (no unresolved) when a
  part is swapped (SG90 → MG90S).

## RL post-training plan — HONEST scope

**Not implemented in this repo.** What lives here is the **data + reward-scoring
substrate** only: a deterministic way to generate candidate designs and to score
geometry/assembly correctness. A real RL run needs **offline GPU training** and
is out of scope for this browser/Node codebase. The plan, written down so the
substrate is built toward it:

1. **Reward.** Compose a scalar reward from the scorer:
   `R = w_geo · checkPassRate + w_asm · assemblyPassRate − w_inv · invalidity`,
   where the assembly term comes from `mateSolved` / `inducedJoint` — a reward
   signal unique to a connector-native stack. (Optionally add a dense
   geometric term: `−chamferDistance` against a reference solid.)

2. **Rollouts.** For each prompt, sample N candidate `typedOpProgram`s from the
   policy, execute each on the kernel, measure a `DocResult`, score it → reward.
   `verifyTriplet` already gives the binary keep-gate; the reward is the graded
   version.

3. **Algorithm.**
   - **GRPO** (group-relative): rank the N rollouts per prompt by reward and
     push the policy toward the above-average ones — no separate value model,
     which suits a sparse, verifier-style reward like ours.
   - **DPO** (offline preference): from the rollouts, form (chosen, rejected)
     pairs (higher-reward vs. lower-reward program for the same prompt) and run
     standard preference optimization. Cheapest to stand up because it reuses
     logged rollouts and needs no online sampling loop.

4. **Where it runs.** Offline, on GPUs, outside this repo. This directory feeds
   that pipeline the prompts, the executable programs, and the reward function;
   it does not — and is not meant to — train a model.

The honest summary: **we ship the verifier and the data engine, not the trainer.**
A correct, deterministic reward is the hard part of RL for CAD, and that is
exactly what `scorer.js` + the assembly checks provide.

## Wiring

These modules are pure and import-only (`scorer.js` pulls nothing external;
`data_synth.js` imports `scorer.js`). To make the suite *runnable* against the
live kernel, an orchestrator adds a thin runner (online, not in this dir) that:

1. imports `BENCHMARK_TASKS` from `./benchmark/tasks.js`,
2. for each task, runs the agent (or replays a `typedOpProgram` via
   `dispatchTool` from `$lib/ai/tools.js`),
3. compiles via the document executor and measures a `DocResult`,
4. calls `scoreSuite(tasks, results)` from `./scorer.js`,
5. prints `formatScoreboard(scores)` from `./scoreboard.js`.

No build wiring is required for the scoring substrate itself — it is consumed by
that runner and by the tests in `__tests__/`.
