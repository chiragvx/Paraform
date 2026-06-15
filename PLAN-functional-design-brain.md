# PLAN — The Functional-Design Brain

> From "a box that looks like a dog" to **a NovaSpotMicro-class functional
> machine you can order, print, assemble, and iterate** — produced by an AI that
> thinks like an expert mechatronics designer, even when the underlying model is
> weak.

**Date:** 2026-06-15
**Status:** proposal — synthesized from the box-dog post-mortem + the
functional-assembly vision conversation.
**Related:** `ai-plan.md`, `PLAN-step-timeline.md`, the connector contract in
`CLAUDE.md`, competitive analysis (memory: scaffold-over-model, Zoo pivot).

---

## 0. Thesis & the bar

### The thesis: make the *scaffold* think

Our own competitive read already says it: **accuracy is in the scaffold, not the
model.** Zoo/CAD-Skills are chasing better single-shot geometry with bigger
models. We win by encoding the *entire reasoning process of an expert designer*
as an opinionated, schema-driven pipeline with deterministic verification — so
the model only has to fill slots, never invent process.

The acid test of a good scaffold: **a silly model (GPT-OSS 120B) shines.** If the
rails are tight enough that a weak model produces an articulated, motion-verified,
print-ready robot, then a strong model produces something extraordinary — and we
improve by editing rails, not by waiting for model upgrades. That is a structural
moat, and it's cheap to run.

### What went wrong (the box-dog)

`make a robot dog` produced a box body + 4 cylinder feet because today's scaffold
is optimized for **valid, printable, verifiable geometry of *known* parts**, and:

1. **Code is forbidden where it's needed.** `system_prompt.js:14,55` — "*you are
   an agent with tools, not primarily a code generator*"; the code path is
   titled "Dropping to code (last resort)." A dog's legs/body/joints are exactly
   the parametric/organic geometry build123d *code* is for.
2. **"Parts before primitives" has nothing to grab.** The library (~198 parts) is
   fasteners/bearings/T-slot + 5 servos + electronics keep-outs — **zero
   structural/linkage parts.** So the fallback is raw boxes.
3. **Nothing can *fail* a cosmetic model.** `self_critique`, `run_invariants`
   (21 checks), the visual gate all check *manufacturing validity* (manifold, no
   interference at rest, wall ≥ min, printable). A box-dog passes them all. There
   is no representation of *what a robot dog even is*, and no gate for *function*.

### The bar (NovaSpotMicro as north star)

A correct `make a robot dog` is not a shape. It is:

- a **BOM** you can order (≈12 servos, a controller, a driver, a battery,
  fasteners) + the printed parts to make;
- a **multipart, individually-editable** tree of structural parts, each justified
  by the actuator it carries or the joint it forms;
- **articulated and motion-verified** — every leg completes its travel without
  self-collision;
- **print-ready** — exported per part, oriented, clearance-toleranced;
- **iterable** — "legs too weak" or "servo too weak" are knob-turns, not re-CADs.

---

## 1. The central inversion: Function → Skeleton → Structure → Surface

Today the AI reasons **shape-first** ("a dog is a body + legs"). The brain must
reason **function-first**:

```
FUNCTION   what must it DO?            quadruped gait, carry a camera, 100 g payload
  ↓
SKELETON   what ACTUATES/SENSES it?    12 servos = 12 joints, controller, battery, camera
  ↓                                     → laid out as a kinematic graph inside a massing envelope
STRUCTURE  what parts SERVE the         each printed part = f(the component it hosts,
           skeleton?                      the load at its joint, its neighbors' frames)
  ↓
SURFACE    make it real & nice          shell, fillets/curves, ventilation where the heat is,
                                          aesthetics from researched patterns
```

The shape is the *last* thing decided and is *downstream* of function. This single
inversion is the spine of the whole plan.

### The Design State Object (DSO) — "the file"

The expert "collects dimensions and images in a file" and grows it. We make that
literal: a structured, evolving **Design State Object** that every stage reads and
writes. It extends the existing design context (`context.js`) from text-only
(brief/requirements/decisions) into a full functional model:

```jsonc
DSO = {
  intent:      { does, payload, env, constraints },          // S0
  research:    { references[], patterns{bodyStyle, legStyle,  // S1
                 ventStrategy, kinematicPoints}, images[] },
  morphology:  { links[], joints[ {id, type:'revolute',       // S2
                 axis, range:[min,max], drivenBy:servoId} ],
                 symmetry, dof },
  skeleton:    { components[ {id, partId, role:'actuator|     // S3
                 controller|battery|sensor', frame, keepout} ],
                 envelope },
  assembly:    { order[], serviceability:{ replaceable[],     // S4
                 bakedIn[] }, fastenPlan[] },
  structure:   { parts[ {id, componentId, recipe, params,     // S5
                 hosts:componentId, load, wall, neighbors[]} ] },
  surface:     { fillets[], vents[], shells[] },              // S6
  verification:{ compile, invariants, motionClearance,        // S7
                 printedFit, serviceAccess, functionalComplete },
  export:      { perPart[ {partId, stl, orientation,          // S9
                 split[]} ], bom, instructions[] }
}
```

The DSO is the artifact that lets a weak model succeed: it never holds the whole
design in its head — it fills one schema slot at a time, and the scaffold carries
state, enforces structure, and verifies.

---

## 2. The pipeline (the wiring) — a staged design state-machine

For a **novel-artifact request** (creature / robot / machine — detected at S0, vs.
a simple "20 mm cube" or a known catalog assembly), the agent runs an explicit,
gated pipeline instead of reacting shape-first. Each stage: reads the DSO,
produces a schema'd artifact via a tool, passes a deterministic gate, writes the
DSO. A stage that fails its gate loops before advancing.

| Stage | Expert step | Produces (DSO slot) | Tool(s) — *exist / NEW* | Gate |
|---|---|---|---|---|
| **S0 Intent** | "think beyond the tools; best output possible" | `intent` | `propose_brief`++ *(extend)* | brief captures function, not just dims |
| **S1 Research** | search online, mine patterns + images | `research` | `web_search`, `web_fetch`, reference-image canvas *(this branch)*, **`mine_patterns`** *(NEW)* | ≥N references; pattern spec filled |
| **S2 Morphology** | mental plan: # moving parts, leg style | `morphology` | **`plan_mechanism`** *(NEW)* | every joint has type+axis+range+driver; DOF computed |
| **S3 Skeleton** | place electronics/camera/servos into a compound shape | `skeleton` | `placeLibraryPart`, keep-outs, `addComponent`, **massing envelope** *(NEW helper)* | every joint in S2 has an actuator; keep-outs fit envelope |
| **S4 Assembly sort** | break-prone parts accessible; others baked in | `assembly` | **`plan_serviceability`** *(NEW)*, `generate_bom` | replaceable parts reachable; assembly order is acyclic |
| **S5 Structure** | build the parts | `structure` | **part recipes** *(NEW, code-first)*, `writeBuildScript`, typed ops | each part binds a component; wall ≥ load-derived min |
| **S6 Surface** | clean up: curves + vents where needed | `surface` | `addFillet`/`addChamfer`, `addHole`+patterns, `addShell` | vents over heat sources; no sharp load-path corners |
| **S7 Assemble & verify** | assemble digitally; iterate | `verification` | mates, `check_assembly_constraints`, **`check_motion_clearance`** *(NEW)*, `measure` | DOF correct; **no collision through motion**; printed fits OK |
| **S8 Iterate** | refine body & legs | (re-enter S5–S7) | `setFeatureParams`, params, `replace_component` | each iteration re-verifies |
| **S9 Export** | piece-by-piece → slicer | `export` | **per-part export + orientation** *(NEW)*, `generate_bom` | every printed part oriented + within bed; BOM complete |
| **S10 Post-print** | reprint thicker legs / upgrade servo | (targeted re-entry) | `setFeatureParams`, `replace_component` | change cascades + re-verifies |

**Why this makes a weak model shine:** the model is never asked "design a robot
dog." It is asked, at S2, "fill the `morphology` schema given this research" — a
constrained, checkable sub-task. The pipeline supplies order, the schemas supply
structure, the gates supply truth. The model supplies only local judgment.

---

## 3. The keystone: parametric skeleton → structure binding

This is the single highest-leverage wire. **Every structural part is authored as a
parametric function of the functional part it serves**, not as static geometry:

```python
# a part RECIPE (code-first), tunable, bound to the skeleton
def servo_leg_bracket(servo, load_Nm, neighbor_frame,
                      WALL=3.0,        # param [2:6] mm — load-derived default
                      CLEAR=0.2):      # param printed-mating clearance mm
    # hole pattern, body envelope, boss depth all DERIVE from `servo.dims`
    # wall thickness DERIVES from load_Nm; mounting frame from neighbor_frame
    ...
    result = bracket
```

Consequences — the whole post-print loop collapses to knob-turns:

- **"Legs too weak"** → bump `WALL` (or a `legWall` document parameter) → every
  leg regenerates deterministically (parametric timeline already supports this).
- **"SG90 too weak → MG945"** → `replace_component` re-binds mates *and* the
  bracket recipe re-evaluates against the new `servo.dims`, so the **mount
  reflows automatically**. Today `replace_component` re-binds mates but cannot
  resize a hand-modeled bracket — recipes fix that.

This is also *why code-first matters*: `bracket = f(servo, load, neighbor)` is
natural in build123d and awkward as a stack of typed primitives. So S5 reframes
code from "last resort" to "the medium for parametric mechanism parts."

**Deliverable: a Part-Recipe Library** — ~6 archetypal, parametric, tunable
build123d generators to start: `servo_mount`, `leg_link`, `revolute_clevis`,
`ball_socket`, `body_shell_with_bosses`, `vent_grille`. Each emits `# param`
constants so the studio surfaces sliders (per `system_prompt.js:58`).

---

## 4. Domain-knowledge injection (the expertise the weak model lacks)

The model doesn't know what a quadruped is. The scaffold will — and inject it.

### Mechanism Pattern Cards (data, retrieved by S1/S2)

Structured knowledge cards for archetypes, matched against the request:

```jsonc
{ "archetype": "quadruped",
  "dof": "12 (4 legs × 3: hip-abduct, hip-flex, knee)",
  "jointLayout": "...", "proportions": {bodyL/legL ratio, ...},
  "actuatorClass": "9g–standard servo per joint",
  "ventStrategy": "over controller + battery",
  "pitfalls": ["thigh collides body at full hip flex", "..."],
  "references": ["spotmicro", "..."] }
```

Seed set: `quadruped`, `robot_arm`, `gripper`, `gimbal`, `differential_drive`,
`gearbox`. This is the "so much detail GPT-OSS shines" payload — expertise lives
in retrievable cards, not in model weights.

### Component-class ladders (for S10 upgrades)

Servo ladder with torque/size so "too weak" has a deterministic next rung:
`SG90 (1.8 kg·cm, 9g) → MG90S (2.2, metal) → MG996R (10) → DS3218 (20)`.
(Catalog already has SG90/MG90S/MG996R/DS3218/AX-12A — add SG92R + an MG945-class
entry; tag each with torque + the ladder.)

### DFM/DFA rule packs (structured checklists, not prose)

Printed-mating clearance bands, min wall by feature, overhang/support rules,
bolt-engagement depth — surfaced as checklist items the gates enforce.

---

## 5. Verification gates — the model can't bluff

Deterministic, kernel-arbitrated checks. Existing (keep): `compile`, the 21
invariants, at-rest interference (`i-no-inter-component-interference-at-rest`),
DOF/mobility (`check_assembly_constraints`). **New:**

1. **`check_motion_clearance`** *(the differentiator).* For each revolute/
   prismatic joint, sample its declared `range[min,max]`, re-pose the articulating
   sub-assembly at each sample, run pairwise interference; **fail on any collision
   through the envelope.** Implementation: sample N poses (bounded for perf),
   reuse the existing interference measure in `harness.py`/`measure.py`. This is
   "the leg completes its stride without hitting the body."
2. **`check_printed_fit`.** At every *printed-to-printed* mating joint, assert a
   designed-in clearance (≥0.2 mm @ 0.4 mm nozzle) or it won't assemble.
3. **`check_serviceability`.** Parts tagged `replaceable` must be reachable
   (removal path not blocked) and fastened (not glued/baked).
4. **`check_functional_complete`.** Cross the `morphology` spec against the built
   model: every declared joint has an actuator + a mount + a structural link.
   **This is the gate that fails a cosmetic box-dog.**
5. **`check_print_ready`.** Per part: within bed, orientable with acceptable
   overhang, or flagged for split.

---

## 6. The design-quality / gestalt critique (`design_review`)

A vision gate beyond the diagnostic visual check. `capture_views` + a rubric the
model must score and that can return `fix-needed` and **loop back into the
pipeline**:

- Does it **read as** the requested artifact (not abstractly box-like)?
- Does it have the **required joints/articulation** from `morphology`?
- **Proportions** sane vs. the pattern card?
- **Not just primitives** — are parts shaped to function?
- **Vents present** over heat sources; **serviceable** parts accessible?

Extends `self_critique` in `tools_validation.js` and the stop-logic in
`agent.js` (it already has visual-gate + auto-mode nudges to build on).

---

## 7. Build inventory (concrete, file-targeted)

| Item | Kind | File target |
|---|---|---|
| Pipeline doctrine + Function→Skeleton→Structure→Surface | prompt | `src/lib/ai/system_prompt.js` (restructure) |
| Code-first reframe (S5) | prompt | `system_prompt.js` §"Dropping to code" → "Authoring mechanism parts" |
| DSO / functional schema | state | extend `src/lib/ai/context.js` |
| `plan_mechanism` (morphology+kinematics) | NEW tool | `src/lib/ai/tools_mechanism.js` |
| `mine_patterns` (research → pattern spec) | NEW tool | extend `src/lib/ai/tools_web.js` |
| `plan_serviceability` / assembly order | NEW tool | `src/lib/ai/tools_assembly.js` |
| Massing-envelope + skeleton layout helper | NEW tool | `tools_assembly.js` / new |
| Part-Recipe Library (6 recipes) | NEW lib | `src/lib/recipes/*` (code-first generators) |
| `check_motion_clearance` | NEW check | invariant in `src/lib/invariants/library.js` + sweep support in `b123d_server/measure.py` |
| `check_printed_fit`, `check_serviceability`, `check_functional_complete`, `check_print_ready` | NEW checks | `src/lib/invariants/library.js` |
| `design_review` gestalt gate | NEW tool + loop | `tools_validation.js`, `agent.js` |
| Per-part export + orientation + split | extend | `export_for_print` path |
| Mechanism Pattern Cards + servo ladder + DFM packs | data | `src/lib/ai/knowledge/*.json` |
| Robotics catalog parts (brackets/links + SG92R/MG945) | data | `b123d_server/standard_parts/*.json` |
| Pipeline state-machine driver | orchestration | `agent.js` (stage gating for novel-artifact intents) |
| Functional-design eval cases | tests | extend the existing eval harness |

---

## 8. Milestones (each independently shippable + eval-gated)

- **M1 — The Spine (wiring, no kernel changes).** DSO schema + functional brief +
  `plan_mechanism` + the staged-pipeline doctrine in the system prompt +
  code-first reframe. *Outcome:* `make a robot dog` stops making boxes and
  produces an actuator-skeleton + parametric structural parts. Biggest perceived
  jump for least risk.
- **M2 — Provable Function.** `check_motion_clearance` + `check_printed_fit` +
  `check_functional_complete` + `design_review`. *Outcome:* output is *provably*
  articulated and assemblable, not just plausible. The differentiator vs. Zoo.
- **M3 — Expertise (make weak models shine).** Mechanism Pattern Cards + servo
  ladder + Part-Recipe Library + robotics catalog parts. *Outcome:* "parts before
  primitives" finally has parts; GPT-OSS-class models hit expert output.
- **M4 — Actionable + Maintainable.** Per-part export + orientation + split +
  assembly instructions + `plan_serviceability` + the S10 post-print loop.
  *Outcome:* straight-to-slicer, field-serviceable, knob-turn iteration.

Sequencing rationale: M1 proves the inversion cheaply; M2 makes it *true*; M3
makes it *expert on weak models* (the headline); M4 makes it *shippable to a
printer and maintainable*. Each milestone adds eval cases (quadruped, robot arm,
gripper) scored by the functional rubric — regressions are caught automatically.

---

## 9. Why Zoo should be scared

| | Zoo / text-to-CAD | Paraform + the Functional-Design Brain |
|---|---|---|
| Output | one impressive *shape* | a *functional machine*: BOM + multipart + motion-verified + print-ready |
| Assembly | none | connector/mate substrate + DOF + motion-range clearance |
| Function | cosmetic | actuator-skeleton-first; fails cosmetic-only output |
| Iteration | re-prompt → new shape | parametric knob-turns + `replace_component` cascades |
| Model dependence | needs a strong model | **scaffold carries the expertise → weak models shine** |
| Improvement loop | wait for a better model | edit rails / add knowledge cards |

Their moat is geometry quality from a big model. Ours is an **expert design
process encoded as deterministic scaffolding** on top of an assembly substrate
they don't have — cheaper to run, and it compounds every time we add a pattern
card, a recipe, or a gate.

---

## 10. Risks & honest hard parts

- **Motion-range clearance is expensive** (swept interference). Mitigate: sample a
  bounded set of poses, broad-phase AABB first, only narrow-phase suspects.
- **Part recipes are real engineering.** Start with 6; grow with demand. A recipe
  that doesn't fit falls back to `writeBuildScript` + the typed ops.
- **Schema tightness vs. flexibility.** Too rigid and creativity dies; too loose
  and the weak model wanders. Tune via the eval harness, not by guessing.
- **Don't regress the strong path.** The existing connector/mate/assembly flow is
  genuinely good — the pipeline *wraps* it, never replaces it. Simple/known
  requests skip straight to the current behavior.

---

## 11. The one-line doctrine (goes at the top of the system prompt)

> **Function before form. Skeleton before surface. Parametric before static.
> Verify motion, not just rest. The kernel is the arbiter — and so is the
> mission: never ship a cosmetic model when a functional machine was asked for.**
