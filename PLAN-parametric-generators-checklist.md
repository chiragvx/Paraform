# Parametric Generators — Foundation Checklist

**Goal:** build out the parametric-generator family so the AI assembles real
designs from correct, reusable building blocks instead of hand-composing them
from primitives (where weak models reliably fail). *The correctness lives in the
generator, not the model's spatial reasoning* — the same principle that made
`addGear` / `addFan` work. Each generator is also one **planning-vocabulary
word**: "a motor mount" is one node, not fifteen boolean ops.

Researched against the two dominant parametric CAD libraries — **BOSL2**
(involute gears, ISO/ASME screws & nuts, bearings, motor mounts, sliders) and
**NopSCADlib** (the RepRap "vitamins" set: fans, steppers, bearings, PCBs,
belts/pulleys, extrusions, brackets) — plus the 3D-print, robotics, and
electronics-mounting ecosystems.

---

## The north star: parts as functions, auto-fitting, and cascade

A generator must not emit *frozen* geometry. It is a **function of its
interfaces** — the parts it touches — and that relationship stays **live**:
change an upstream part and everything downstream reflows automatically, with
**no AI turn and no user action**. The user *describes*; the tooling owns the
fit, the holes, the lengths, and the QA. **The user is never asked to validate a
bolt circle.** On a large, complex assembly the user can't know the downstream
consequences of a change — so the scripts must, because they can.

All of this has precedent in the codebase — the **connector contract**, the
**`addCasing`** emitter that stamps bosses/cutouts from enclosed parts'
connectors, the plan-graph **`deps` + `markStale`** transitive propagation, the
**mate solver** that re-places parts on change, and recipes already written as
**f(the component they serve)**. The work is to generalise these into one
**interface spine** every generator plugs into. Three mechanisms:

### 1. Typed interfaces (ports) — the contract between parts
Every generator **publishes** output interfaces and **consumes** input ones,
layered on the connector contract:
- a **motor** publishes `Shaft{dia,length,type}` + `BoltPattern{circle,count,screw}` + `Body{L,W,H}`;
- a **motor mount** consumes a `Motor`, publishes a `MountFace{holePattern}` + a shaft pass-through;
- a **mounting plate / frame** consumes `MountFace`s, publishes anchor faces.

An interface is *typed + parametric* — not "a hole here" but "an M3 bolt circle
Ø46, 4×, concentric with an 8 mm shaft." That is what lets a host fit a guest it
has never seen.

### 2. Host absorbs guest features — the auto-fitting / auto-QA
When a guest attaches to a host, the **host regenerates its own negative
features (holes, pockets, cutouts, reliefs) from the guest's published
interface — on its own.** Drop a motor mount on the plate and the plate *grows
the bolt holes that match the mount*; swap the mount and the holes move. The user
never places a hole. **This already works for one host:** `addCasing` walks the
enclosed components' connectors and stamps bosses + cutouts. We promote that from
a Casing special-case to a general rule — *any* host part receives its guests'
interface features.

### 3. Cascade — the dependency DAG reflows itself
Attachments form a directed graph (motor → mount → frame; motor → shaft → wheel).
The plan-graph already records `deps` and marks dependents **stale** transitively
on a spec edit — but today a stale node waits for the *AI* to rebuild it. We
upgrade that to a **deterministic reflow**: each fabricate node's build is a pure
function of its resolved inputs, so on any edit the engine

1. recomputes the edited node's **published outputs**,
2. walks downstream attachments in **topological order**,
3. for each dependent: re-evaluates its **driven params** (references / equations
   to upstream values — `boltPattern = @motor.boltPattern`,
   `shaftLength = dist(@motorOut, @wheelHub)`), re-emits its geometry, and lets
   the **mate solver** re-place it,
4. re-runs invariants / interference / fit-clearance automatically and
   self-repairs on failure — **no AI in the mechanical loop, no user validation.**

Dimensional cascade (sizes, hole positions, shaft lengths) rides **driven
params**; positional cascade (where parts sit) rides the **mate solver** that
already re-solves on change. Both travel the same DAG.

### Worked example — resize the RC-car motor
User builds: car frame (foundation) → motor mount on it → motor in the mount →
drive shaft from motor to wheel → screws. Later they only say *"use the bigger
2845 motor."* The cascade, with zero further prompting:
- **motor** body + shaft + bolt pattern grow (published outputs change);
- **mount** reflows to the new body/bolt pattern; its `MountFace` hole pattern widens;
- **frame** re-absorbs the mount's `MountFace` → its mounting holes move to match, and the mount's seat shifts to keep wall clearance;
- **drive shaft** `length = dist(motorOutput, wheelHub)` recomputes → it lengthens/shortens; its coupler bore tracks the new shaft Ø;
- **screws** re-place on the moved holes and re-length to the new stack height;
- invariants + interference re-checked; if the bigger motor now clashes the frame wall, self-repair nudges the wall out or flags it — the user isn't asked.

The user changed one number; the assembly stayed correct. *(The order above is
illustrative — propagation is by the DAG, not a fixed sequence.)*

### The interface spine (build it first / alongside P0)
- **Interface/port types** on the connector contract: `Shaft`, `BoltPattern`, `MountFace`, `BoreFit`, `BeltPath`, `Keepout`, …
- **Driven params**: a param may be a literal OR a reference/equation to an upstream published value; a resolver evaluates it (extends `addDocumentParameter` from intra-part to **inter-part**).
- **A reflow executor** over the plan-graph DAG: topological recompute of driven params → re-emit → re-solve mates → auto-QA (upgrades `markStale`-for-the-AI into deterministic reflow).
- **Host feature-stamping** generalised from the `addCasing` emitter to any host.
- Generators built **interface-aware from birth** — each declares its in/out ports and reads them instead of frozen numbers. *Retrofitting later is worse, which is why the spine leads.*

This is the deepest work on the page and the real moat: it is the difference
between a library of static parts and a **self-consistent assembly that the user
edits by describing.**

---

## Status — 2026-06-18

**P0 (14) + P1 (11) are BUILT, kernel-verified, and shipped** — 32 generator
tools total. Each is a full vertical slice (type + op + fail-safe emitter +
EMITTERS hook + index re-export + AI tool + both BODY_EMITTING sets +
`_extentHint` edit-in-place + standard-size tables + tests), all compiling on
real build123d 0.10. Commits: `95360ea` (P0), `c524f22` (P1). Remaining: the
**interface spine / cascade** (the north-star engine — auto-connectors, driven
params, reflow executor; a distinct architectural phase, not yet built) and the
**P2** specialised set (as demand appears).

## Legend

- ✅ **Done** — a first-class generator exists today.
- 🟡 **Partial** — covered by a *scripted recipe* (`build_part_recipe`) or a
  *COTS catalog* part (placed, not generated); worth promoting to a first-class
  one-call generator, or only half-covered.
- ⬜ **To build** — not yet present.
- Priority: **P0** build-first (max reuse × highest AI-failure-without-it),
  **P1** second wave, **P2** specialized / niche.

## What exists today (don't duplicate)

| Generator | Covers | Status |
|---|---|---|
| `addGear` | spur gear, bore, bolt circle, tooth fillet | ✅ |
| `addPulley` | flat / V / round **friction** belt pulley | ✅ |
| `addSprocket` | roller-chain sprocket | ✅ |
| `addTSlotExtrusion` | 2020/3030/4040 framing | ✅ |
| `addScrewBoss` | self-tapping screw post + ribs | ✅ |
| `addStandoff` | hex/round PCB spacer | ✅ |
| `addFan` / `addFanBlade` | twisted-airfoil fan / prop / EDF | ✅ |
| `addCasing` | **fitted** enclosure *around existing components* | ✅ |
| Recipes (`build_part_recipe`) | servoMount, legLink, revoluteClevis, ballSocket, bodyShellWithBosses, ventGrille | 🟡 |
| COTS catalog (place, don't generate) | fasteners, bearings, servos, motors, electronics, sensors, connectors | — |

---

## P0 — Foundational (build these first)

The everyday backbone of printed mechatronics. Every one is high-frequency AND a
common AI-from-primitives failure.

| Tool | Makes | Key params | Notes |
|---|---|---|---|
| `addBracket` | right-angle / L / corner bracket with gusset + bolt holes | armA, armB, thickness, angle, holeSize, holeCount, gusset | The single most common printed part. Catalog has *static* L-brackets — this is the parametric one. |
| `addMountingPlate` | flat plate with a configurable hole **grid / slot pattern** | length, width, thickness, holeGrid {rows,cols,pitch,dia}, slots, cornerRadius, countersink | Foundational base for everything; pairs with every bolt pattern. |
| `addThreadedInsertBoss` | **heat-set insert** boss (knurled-insert pocket) | insertSize (M2–M6 → std OD/depth), bossOD, height, ribs, baseFillet | The #1 pro 3D-print assembly method. Distinct from `addScrewBoss` (self-tap). |
| `addNutTrap` | captive hex-nut pocket / nut trap (side or bottom entry) | nutSize (M2–M6 → AF+thk), entry (side/bottom), captive roof, boltClearance | Bolted printed joints; AI botches the across-flats + trap geometry. |
| `addSnapHook` | cantilever **snap-fit** clip (hook + mating catch) | armLength, armThk, hookDepth, leadAngle, returnAngle, width | Industry-standard hardware-free enclosure join; the deflecting hook is not hand-modelable. |
| `addBearingPocket` | press-fit **bearing seat / housing** sized to a standard bearing | bearing (608/623/6800/…) or {od,id,width}, shoulder, throughHole, retainerLip | The printable mate for a COTS bearing — exact OD + shoulder. |
| `addMotorMount` | mount/faceplate for a **motor** (NEMA / gearmotor / DC / brushless) | motorType (NEMA17/23, N20, 37D, 775, 2208…), boltPattern (derived), shaftHole, standoff, slots | The robotics/CNC workhorse; AI fails the bolt circle. (servoMount recipe covers *servos* only.) |
| `addWheel` | hub + tire-groove wheel | diameter, width, hubBore, shaftType (round/D/hex), setScrew, spokes, tireGroove | Core mobile-robot part. |
| `addShaftCoupler` | rigid / clamp / jaw coupler joining two shafts | bore1, bore2, od, length, clampScrews, flexible | Ubiquitous motor↔shaft link. |
| `addTimingPulley` | **toothed belt** pulley (GT2 / GT3 / HTD) | teeth, beltType (GT2-2 / GT3 / HTD-5), bore, flanges, setScrew | The 3D-printer/CNC belt standard; current `addPulley` is friction-only. |
| `addHinge` | pin / barrel / knuckle / **print-in-place** hinge | hingeType, length, knuckleCount, pinDia, leafWidth, gap | Very common, geometry too fiddly for a model. |
| `addProjectBox` | standalone two-part **enclosure + lid** (snap or screw) | innerL/W/H, wall, lidType (snap/screw/slide), bosses, ventSlots, lip | `addCasing` wraps *existing* parts; this builds a box from scratch. |
| `addPCBTray` | plate with standoff posts placed to a PCB hole pattern | pcbL, pcbW, holeInset/pattern, standoffH, screwSize, walls | Electronics mounting; AI fumbles hole spacing. |
| `addKnob` | knurled / fluted / pointer control knob | diameter, height, gripType (knurl/flute/smooth), shaftBore, dFlat, setScrew | Super common; knurling is not hand-modelable. |

**Interfaces each P0 part declares** (publishes ▸ / consumes ◂ — this is what makes them cascade, not the geometry):
- `addMountingPlate` ▸ anchor faces ◂ absorbs *any* guest's `BoltPattern`/`Keepout` → grows matching holes itself.
- `addBracket` ▸ two `MountFace`s ◂ `BoltPattern` on each arm.
- `addThreadedInsertBoss` / `addNutTrap` ▸ a `Fastener` seat ◂ screw size from the joint.
- `addSnapHook` ▸/◂ a mating `Snap` pair (hook ↔ catch) — the two halves track each other.
- `addBearingPocket` ▸ `BoreFit` + bearing axis ◂ a standard `Bearing` size.
- `addMotorMount` ▸ shaft pass-through + `BoltPattern` ◂ a `Motor` (body, shaft, bolt circle).
- `addWheel` ▸ a `Shaft` bore + hub face ◂ shaft Ø/type.
- `addShaftCoupler` ▸/◂ two `Shaft` ends (bore1 ◂ motor shaft, bore2 ◂ driven shaft).
- `addTimingPulley` ▸ a `BeltPath` + `Shaft` bore ◂ shaft Ø, belt type.
- `addHinge` ▸/◂ a mating leaf pair sharing a pin axis.
- `addProjectBox` ▸ inner `Keepout` + lid seam ◂ the components it must contain.
- `addPCBTray` ▸ standoff posts ◂ a `PCB`'s hole pattern (absorbs it like the plate).
- `addKnob` ▸ a grip face ◂ a `Shaft` (bore/D-flat/set-screw from the shaft).

## P1 — High value (second wave)

| Tool | Makes | Notes |
|---|---|---|
| `addRackGear` | linear rack to pair with a spur pinion | rack-and-pinion linear drive |
| `addLeadScrew` (+ nut) | trapezoidal / ACME lead screw + nut | linear actuators / Z-axes |
| `addCounterbore` / `addCountersink` | screw-head recess on a hole | verify `addHole` doesn't already; promote if not |
| `addBatteryHolder` | 18650 / AA / AAA / 9V / LiPo cradle | cellType, count, arrangement |
| `addDINRailClip` | snap onto 35 mm DIN rail | panel/industrial mounting |
| `addCableClip` | p-clip / adhesive / screw cable clip + strain relief | wire management |
| `addFoot` | rubber-foot seat / leveling foot | base of nearly every enclosure |
| `addGusset` | standalone triangular stiffening rib | reinforce any L-join |
| `addTSlotBracket` | corner bracket / cube for joining extrusions | the joiner for `addTSlotExtrusion` |
| `addGridfinityBin` / `addGridfinityBase` | the dominant maker storage standard | huge community demand |
| `addLid` / `addCover` | a lid for an existing opening | complements `addProjectBox` |
| `addHandle` | bar / loop / T handle | ergonomics |
| `addShaftHub` | shaft-bore → bolt-circle hub adapter | mount wheels/arms/discs to a shaft |
| `addLivingHinge` | thin flexure-strip hinge | flat-fold parts |
| `addPanelCutout` | D-sub / round / switch / USB / barrel-jack cutout | promote from `addCasing` cutouts to standalone |

## P2 — Specialized / niche (as demand appears)

- **Gearing:** `addBevelGear` (right-angle), `addHelicalGear` / `addHerringboneGear`, `addInternalGear` (planetary ring), `addWormGear`, `addCam`.
- **Motion:** `addBushing` (plain sleeve bearing), `addLinearRail` / `addVRail`, `addLinearBushingBlock` (LM8UU), `addIdlerPulley`.
- **Wheels/drive:** `addOmniWheel`, `addMecanumWheel`, `addCaster`, `addPropAdapter`, `addTrackLink` (tank tread).
- **Robotics:** `addGripperFinger` / `addJaw`, promote `ballSocket` recipe → `addBallJoint`.
- **Mechanisms:** `addCableChain` / `addDragChain`, `addSpring` / `addCompliantFlexure`, `addDovetailJoiner`, `addLatch`.
- **Human interface:** `addButtonCap` / `addKeycap`, `addDial` / `addPointer`.
- **Fluid/tubing:** `addHoseBarb` / `addTubeFitting`, `addPipeFlange`, `addFunnel` / `addNozzle`.
- **Enclosure detail:** promote `ventGrille` recipe → first-class `addVentGrille`; `addLabelPlate` / `addTextTag`.

---

## Tier 2 — Complex / specialized generators (the next frontier)

The P0/P1 set is mostly boolean compositions of primitives. Tier 2 is a real
complexity step up — true profile math, helical sweeps, multi-part mechanism
assemblies, and generative structures. It's where the "scaffold not the model"
moat deepens most: a planetary gearbox or an involute worm pair is *completely*
beyond a weak model's spatial reasoning.

**Three infrastructure unlocks gate this tier (build each once, many generators
reuse it):**
- **(H) Robust helical-sweep helper** — `Helix` + `sweep(profile)` exists in
  build123d, but helical sweeps are OCCT-fragile. One shared, fail-safe helper
  (degrade → cosmetic groove → plain cylinder) unlocks *all* threads, springs,
  worms, and helical gears. No `bd_warehouse`/`Thread` class is installed, so we
  generate threads ourselves.
- **(M) Multi-body + joint emit pattern** — an *assembly* generator emits several
  `n_<id>` bodies, declares the **connectors + induced joints** between them
  (revolute/prismatic), and reports a sub-BOM. This is the same machinery the
  interface/cascade spine needs — build it here and the assemblies become live.
- **(S) Implicit / SDF path** — true TPMS lattices (gyroid) are **not** B-rep
  cheap; they need an implicit kernel (a separate compute track, per the
  scale-architecture research). Honeycomb / 2D-voronoi infills ARE B-rep-able now.

### Foundational-complex set (build-first within Tier 2)

| Tool | Makes | Needs | Why foundational |
|---|---|---|---|
| `addGear` **→ true involute** | upgrade the current straight-flank teeth to real involute flanks | profile math | gears are everywhere; correct meshing is the point |
| `addHelicalGear` / `addHerringboneGear` | angled / double-helical involute gear | H | quiet, high-load drives; herringbone = no axial thrust |
| `addBevelGear` | conical involute gear (right-angle drive) | profile math | every right-angle gearbox |
| `addWormGear` (+ wheel) | worm + matching worm wheel **pair** | H + M | high-ratio, self-locking drives |
| `addPlanetaryGearbox` | sun + N planets + ring + carrier, ratio-solved | M + involute | the showcase complex assembly; one node = a gearbox |
| `addThread` (external + internal) | real ISO-metric helical thread on a shaft / in a hole | H | unlocks custom screws, caps, bottle/jar lids, adjusters |
| `addLeadScrew` (+ nut) | ACME / trapezoidal power screw + matching nut | H + M | linear actuators, Z-axes, vises |
| `addCompressionSpring` | real helical coil (compression / extension / torsion) | H | the canonical "can't model by hand" part |
| `addGripper` | parallel-jaw or linkage gripper (jaws + slides/pivots) | M | robotics end-effector; articulating |
| `addUniversalJoint` | Cardan U-joint (two yokes + cross), revolute pairs | M | shaft drives at an angle |
| `addHeatSink` | pin-fin / plate-fin array sized to a footprint + power | (base) | thermal management for any electronics build |
| `addImpeller` (+ volute) | centrifugal pump/blower rotor + spiral housing | loft/revolve | the centrifugal complement to the axial `addFan` |
| `addCam` | disc cam from a motion law (dwell-rise-dwell, follower) | profile math | timing/automation mechanisms |
| `addInfillPanel` | honeycomb / voronoi lightweight panel | (base) / S for gyroid | strength-to-weight; the entry to the lattice track |

### The rest of Tier 2 (second wave)

- **Gear/drive depth:** `addInternalGear` (ring), `addCycloidalDrive` (disc +
  pins, huge ratio), `addDifferential`, `addGenevaWheel` (intermittent),
  `addRatchet` (+ pawl), `addTimingIdler`.
- **Linkages:** `addFourBarLinkage`, `addScissorLift` / `addPantograph`,
  `addSliderCrank`, `addBallJoint` (promote `ballSocket`).
- **Threads/fasteners:** `addThreadedRodCoupler`, `addPipeThread` (NPT/BSP),
  `addBottleThread`, `addKnurledThumbscrew`.
- **Springs/compliant:** `addTorsionSpring`, `addWaveSpring`, `addFlexurePivot`,
  `addConstantForceSpring`, `addLivingHingeArray`.
- **Thermal/fluid:** `addManifold` (branching channels), `addNozzle` /
  `addVenturi`, `addBellows` (corrugated flex), `addHeatExchangerCore`,
  `addCycloneSeparator`.
- **Generative (needs S):** `addGyroidLattice` / `addTPMS`, `addVoronoiShell`,
  `addConformalLattice`, `addTopologyBracket` (load-path).
- **Sheet/frame:** `addSheetMetalBend` (flanges + bend allowance), `addTruss` /
  `addSpaceFrame`, `addPerfPanel`, `addHoneycombCore`.

**Order:** land **(H)** first → ship `addThread` + `addCompressionSpring` +
`addLeadScrew` (immediate, high-want, all reuse H). Then **(M)** → ship
`addPlanetaryGearbox` + `addGripper` + `addUniversalJoint` (the assembly
showcase, and it doubles as the interface/cascade spine's first real users).
The involute-gear upgrade + bevel/helical/worm slot in alongside. `addHeatSink`
+ `addImpeller` + `addCam` need no new infra — quick wins anytime. Defer the
**(S)** lattice track until the implicit-kernel decision.

---

## Cross-cutting multipliers (do alongside the generators — this is the real leverage)

These make the *whole family* more powerful, not just one part:

1. **Auto-declare interfaces (ports), not just connectors.** Every generator
   stamps its typed in/out interfaces on creation (`addBearingPocket` → a
   `BoreFit` + bearing-axis connector; `addMotorMount` → consumes `Motor`,
   publishes a shaft pass-through + `BoltPattern`; `addShaftCoupler` → two
   `Shaft` ends). This is the connector contract applied at generator level and
   the **entry point to the whole interface-spine + cascade model above** — the
   single biggest force-multiplier on the page. Parts then auto-mate AND
   auto-fit (hosts absorb guest holes) instead of the model guessing.
2. **Edit-in-place wiring (every new type).** Register each new feature type in
   **both** `BODY_EMITTING` sets and give it an `_extentHint` case, or a relative
   edit ("make it 12 blades") silently builds a duplicate. (This bit `addFan`
   — see commit f90d8ef.)
3. **Pattern-card routing.** Add knowledge cards so "build a robot car",
   "gearbox", "camera gimbal" decompose (in the plan-graph) into these
   generators with sane defaults, so the planner reaches for them by default.
4. **Standard-size tables.** Bearings (608/623/6800…), NEMA bolt patterns,
   GT2/HTD belt pitches, metric insert/nut dims — bake the lookup tables so a
   user names the standard and the geometry is correct.
5. **DFM defaults.** Each generator emits print-ready by default (wall
   thickness, clearance, overhang-safe, flat base) and degrades fail-safe to a
   primitive, exactly like the existing family.

---

## Recommended build order

0. **The interface spine first** (see "north star" above) — port types on the
   connector contract, driven params (inter-part references/equations), the
   reflow executor over the plan-graph DAG, and host feature-stamping
   generalised from `addCasing`. Land a thin vertical slice (e.g. motor →
   mount → plate cascade) before scaling generators, so each generator is born
   interface-aware. This is the moat; the generators are leaves on it.
1. **`addBracket` + `addMountingPlate`** — unblock generic structure (used everywhere). The plate is the first **host** that absorbs its guests' hole patterns — the auto-fitting proof.
2. **`addThreadedInsertBoss` + `addNutTrap` + `addSnapHook`** — the joining/assembly trio (turns separate prints into assemblies).
3. **`addBearingPocket` + `addMotorMount` + `addShaftCoupler` + `addWheel`** — the drivetrain set (with auto-connectors → snap a motor→coupler→shaft→wheel chain).
4. **`addTimingPulley`** — completes belt drive alongside the existing gear/sprocket/pulley.
5. **`addHinge` + `addProjectBox` + `addPCBTray` + `addKnob`** — the enclosure/UX set.
6. Then P1, then P2 by demand.

Ship each as a vertical slice (op + emitter + EMITTERS hook + index re-export +
AI tool + **both** BODY_EMITTING sets + `_extentHint` + tests + system-prompt
line + auto-connector), verified against the real build123d kernel — the same
recipe that landed `addFan`.

---

## Per-generator wiring recipe (the 8 + 2 points)

For each new generator `X` (see also the project memory note):
1. `lib/document/types.js` — register `X` in `FEATURE_TYPES`.
2. `lib/document/generators.js` — `emitXPython(f)` (fail-safe → degrade to a primitive in an `except`).
3. `lib/document/emit.js` — import + `X(f){ return emitXPython(f) }` in EMITTERS.
4. `lib/document/operations.js` — `addX({…})` (clamp params, sanity warnings, commit).
5. `lib/document/index.js` — re-export `addX`.
6. `src/lib/ai/tools_generators.js` — the AI tool (emphatic "don't hand-build this").
7. `src/lib/ai/tools.js` — add `X` to `BODY_EMITTING` **and** give it an `_extentHint` case. **Also** `src/lib/ai/tools_dfm.js` `BODY_EMITTING`.
8. `src/lib/ai/system_prompt.js` — generator-guidance line (it's a backtick template — no raw backticks).
9. **(+)** Auto-declare connectors on build so the part snap-mates.
10. **(+)** Tests in `lib/document/__tests__/generators.mjs` + a real-kernel compile check.
