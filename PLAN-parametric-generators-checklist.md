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

## Cross-cutting multipliers (do alongside the generators — this is the real leverage)

These make the *whole family* more powerful, not just one part:

1. **Auto-declare connectors.** Every generator should stamp its snap points on
   creation (a `addBearingPocket` → a bearing-axis connector; a `addMotorMount`
   → a shaft connector + the bolt pattern; a `addShaftCoupler` → two shaft
   ends). Then parts **auto-mate** instead of the model guessing transforms.
   This is the connector contract (CLAUDE.md) applied at generator level — the
   biggest force-multiplier on the list.
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

1. **`addBracket` + `addMountingPlate`** — unblock generic structure (used everywhere).
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
