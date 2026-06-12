# Phase 2c — Kinematics oracle (the second engine)

> **Status (2026-06-08): 🟡 v1 + v2 + v3 inverse kinematics landed.**
>
> v3 follow-up shipped:
>
> - `src/lib/kinematics/linalg.js` — small dense linear algebra
>   (identity, transpose, multiply, multiplyVec, add, scale, and
>   Gauss-Jordan invert with partial pivoting). Pure JS, sized for
>   3×3 / 6×6 systems; throws on singular matrices.
> - `src/lib/kinematics/jacobian.js` — `resolveChain(doc, eeId)`
>   walks parent joints root-to-leaf, returning the serial chain
>   and the revolute/prismatic DOF subset. `computeJacobian(...)`
>   builds a 6×N numerical (central-difference) Jacobian — linear
>   rows 0..2, angular-proxy rows 3..5 (gated on `orientation`).
> - `src/lib/kinematics/ik.js` — `solveIK({ doc, endEffector,
>   target, initialPose, maxIter=50, tol=1e-4, lambda=0.01 })`
>   runs Damped Least Squares: Δq = Jᵀ (J Jᵀ + λ²I)⁻¹ e, position-
>   only target for v1, with per-step backtracking (α halving up to
>   5 times) and joint-limit clamping at every step. Returns
>   `{ pose, converged, iterations, residual, dofJointIds }`.
> - `KinematicsPanel.svelte` gains an **IK mode** toggle with an
>   end-effector dropdown (auto-populated from the chains in the
>   doc), XYZ target inputs, a *Use current* primer button, a
>   *Solve* action, and a ✓/⚠ status line. Solved joint values
>   write back into the existing pose state so the sliders + live
>   interference report update in step.
> - Test suite `src/lib/__tests__/spec17_v3_ik.mjs` — 16 assertions
>   covering linalg primitives (identity, transpose, multiply,
>   3×3 invert round-trip, singular throw), chain resolution,
>   Jacobian shape + 1-DOF value, 1-DOF / 2-DOF / 3-DOF IK
>   convergence, unreachable-target failure mode, joint-limit
>   clamping, full-extension singularity damping, and the zero-DOF
>   degenerate case.
>
> The deferred "Inverse kinematics solver — no Jacobian, no
> end-effector pose targeting" bullet below is ✅. Orientation
> targeting (full 6-DOF goals), analytical Jacobian, adaptive
> Levenberg-Marquardt damping, and singularity-locus detection
> remain deferred.

> **Status (2026-06-08): 🟡 v1 + v2 triangle-mesh interference landed.**
>
> v2 follow-up shipped:
>
> - `src/lib/kinematics/interference_mesh.js` — per-component triangle
>   BVH (via `three-mesh-bvh`), pairwise BVH-against-BVH triangle
>   intersection (`findIntersectingTriangles`), with worldspace
>   centroid + contact-point output. Cached by `componentMeshes`
>   object identity.
> - `src/lib/kinematics/interference_overlay.js` — three.js Group of
>   red line-segments + point markers between intersecting triangle
>   centroids. Mounts directly into the Z-up scene root.
> - `checkInterferenceAtPose({ detailed: true, componentMeshes })` —
>   AABB phase becomes broad-phase; mesh phase prunes AABB false
>   positives and attaches `pairs[]` to each hit.
> - `KinematicsPanel.svelte` exposes a **Highlight contact** toggle
>   that mounts/disposes the overlay and shows the triangle-pair
>   count under the live interference status.
> - Test `src/lib/__tests__/spec17_v2_interference_mesh.mjs` —
>   13 assertions covering BVH build/cache, overlapping +
>   non-overlapping cubes, transform compose, `mat4 → THREE.Matrix4`
>   correctness, detailed-mode wiring, and overlay group lifecycle.
>
> The deferred "OBB / triangle interference" item below is ✅ for the
> **triangle** side. OBB-only path and kernel-side swept-volume CSG
> remain deferred.

> **Status (2026-06-07): 🟡 v1 slice landed.**
>
> What's in (this commit):
>
> - `Joint` type on the document (`doc.joints`: `{kind, parent, child, origin, axis, limits, drive}`)
>   with `addJoint` / `updateJoint` / `removeJoint` ops, changelog kinds
>   (`add-joint`/`update-joint`/`remove-joint`), fold handlers, and serialize
>   round-trip.
> - Pure-JS forward-kinematics solver
>   (`src/lib/kinematics/solver.js`) supporting `revolute`, `prismatic`,
>   `fixed`. Walks the kinematic tree, accumulates 4×4 transforms,
>   returns per-component world matrices. Z-up math.
> - **AABB stand-in** interference check at a pose
>   (`src/lib/kinematics/interference.js`) — transforms each component's
>   local AABB into world frame and pairs-tests overlap. Skips
>   parent-child pairs (they touch at the joint origin) by default;
>   caller can opt in.
> - Pose timeline (`src/lib/kinematics/pose.js`):
>   `makePose`, `interpolatePose`, `sampleTrajectory` (N=10 default
>   sweep), and a UI-side `PoseLibrary` helper.
> - `KinematicsPanel.svelte` Inspector panel: per-joint slider clamped
>   to limits, live interference status, snapshot-pose / play-trajectory
>   controls.
> - Invariant `i-no-interference-along-trajectory` (per-document) added
>   to spec-16 library. Benign-passes when no pose library is supplied.
> - Test suite `src/lib/__tests__/spec17_kinematics.mjs` — 26 assertions
>   cover the joint factory, ops, FK on revolute / prismatic / chained
>   revolute, AABB transform + overlap, sampled-trajectory collision
>   detection, and invariant fire.
>
> What's deferred (still scoping doc below):
>
> - **Kernel-side OBB / triangle interference.** ✅ for **triangle**
>   side as of v2 (2026-06-08) — client-side BVH-against-BVH via
>   `three-mesh-bvh`. Per-component OBBs still deferred, as is the
>   kernel `measure({type:'interference'})` endpoint that would
>   produce true swept-volume CSG bodies. Triangle-pair output is
>   sufficient for the UI contact-region overlay.
> - **Inverse kinematics solver** — ✅ as of v3 (2026-06-08).
>   Numerical Jacobian + DLS solver in
>   `src/lib/kinematics/{linalg,jacobian,ik}.js`, with panel
>   integration. Position-only target; orientation goals and
>   analytical Jacobian remain deferred.
> - **Dynamics + collision response** — joint torque envelopes, motor
>   catalog, gravity-loaded torque check. Tracked under "Engine choice"
>   below.
> - **Trajectory optimization** — v1 only samples linearly; no
>   minimum-jerk / time-optimal pathing.
> - **Singularity detection** — Jacobian rank / condition-number
>   analysis is in the original scoping but out of v1.
> - **Reach envelope / workspace boundary topology** — original
>   scoping intent; v1 ships none.
> - **Per-component bbox population from the kernel** — the v1 panel
>   reads `component.bbox` if it's there; the kernel-side hook that
>   stamps it after every emit lands when OBB lands.
>
> Path from v1 to the original scoping ambition: replace the AABB
> stand-in with a kernel `interference` endpoint, ship inertia / COM
> queries (spec 07 extension), and graduate the JS solver to a hybrid
> JS-orchestration + PyBullet-engine model per the discussion below.



> Phase 2c of [TRACKER.md](../TRACKER.md). **The dynamic-truth oracle**
> — a peer to the kernel's static-truth oracle, not an extension of it.
> Scoping doc, not an execution spec. Multi-quarter; spec only when
> it's the next item to ship.

## TL;DR

Articulation requires a different kind of oracle than the static
measure API. Reach, swept-volume interference, singularities,
workspace boundaries, dynamic interference at speed — these aren't
properties of one fixed pose. They're integrals over the joint
configuration space. The current architecture has *one* oracle (the
B-rep kernel + measure layer); a second engine bolts alongside it.
This document scopes what it has to do and what its interface to the
repair loop looks like. It does *not* spec the build.

## Why a second oracle, not another measure query

The previous plan implied adding `measure({type:'kinematic-reach',
chain})` and `measure({type:'swept-interference', ...})` as
extensions of the static measure layer. That hides the architecture
gap.

The kernel measure layer evaluates *properties of a fixed shape*. It
takes a body, returns a number. It can be made arbitrarily expressive
in that frame (every query it doesn't support today, we could add).
But:

- **Reach** is not a property of an assembly. It's a function over
  the joint configuration space — for each joint configuration in the
  reachable set, where does the end-effector tip lie. The "reach
  envelope" is the boundary of that set's image. Computing it
  requires forward kinematics + workspace boundary algorithms +
  potentially numerical optimization for irregular workspaces.

- **Swept-volume interference** is not pairwise body interference.
  It's the question: for joint axes θ₁..θₙ in their ranges, does
  there exist a configuration at which body A intersects body B?
  Sampling can miss; analytical sweeps need Minkowski-sum-style math.
  A SCARA folded back on itself at extremes can be inches inside
  itself at a pose the rest-pose interference check sees as clear.

- **Singularities** require Jacobian analysis along the chain.
  The Jacobian is a derivative of forward kinematics with respect to
  joint variables; it's not a property of geometry, it's a property of
  the *mechanism*.

- **Joint travel limits** are constraints on the configuration space
  itself, not the body in it.

These are different math. They need an engine that takes (joint
topology + per-joint range + body geometry) and produces
configuration-space facts.

## What the engine has to know

- **Joint topology** — which components are connected by which
  joints; for each joint: type (revolute / prismatic / cylindrical /
  ball / planar), axis, range. The F6 joint stubs need real semantics.
- **Body geometry per component** — already in the kernel (each
  component's subgroup, BRep available via the existing /measure).
- **Inertia + COM per component** — derived from build123d; surface
  via the measure API.
- **Joint stops + initial pose** — per joint, hard limits + a home
  pose.

## What the engine produces

Output is a set of analyses, run on demand by the repair loop or by
the user:

- **Reach envelope** — convex hull or implicit boundary of reachable
  end-effector positions. Visualizable in viewport; queryable as
  "is point P reachable."
- **Swept-volume per joint** — for each joint, the volume swept by
  all downstream components through the joint range. Pairwise
  intersection between swept volumes reveals self-collision *over
  motion*.
- **Configuration-space samples** — discretized samples of valid
  configurations; check arbitrary points.
- **Singularity locus** — set of configurations where the Jacobian
  rank drops. For control purposes, also identify "near-singular"
  regions where condition number explodes.
- **Joint torque envelope** — for each pose, the gravitational
  torque each joint must produce. Compare to motor catalog torques
  (Phase 3 motor catalog parallel to the bearing catalog).
- **Workspace boundary topology** — for SCARAs, the workspace is
  annular; for 6-axis arms, it's a shell with holes. Knowing this
  topology informs "does this part have an unreachable region?"

## How it integrates with the repair loop

Same shape as the static measure layer integrates today:

- Repair loop produces a candidate document.
- Static measure runs → bbox, volume, manifold OK.
- Kinematics oracle runs → reach=205mm (spec said 200; pass),
  swept-self-collision at θ₁=120° / θ₂=−90° (FAIL — link 2 housing
  intersects link 1).
- Failure feeds back as a classified kinematic delta. The repair
  loop knows this is a topology-change signal, not a parameter nudge.

The "kinematic delta" classification matters: if measure says hole
diameter is off by 0.4mm, the loop nudges `holeDiameter`. If
kinematics says link 2 collides at extreme pose, the loop has to
*move geometry* — offset the link's housing, change cross-section,
or relocate the joint. A delta classifier that doesn't distinguish
these spirals.

## Engine choice

Three serious candidates:

- **PyBullet** — fast, simple Python API, well-documented for
  robotic arms. Pre-existing; bolts onto a Python sidecar. Lower
  accuracy on continuous-collision detection.
- **Drake** (TRI / MIT) — research-grade, slow, accurate, vast
  documentation. Probably overkill; certainly more than 2025-Q1
  staffing can absorb.
- **Custom on top of OCCT + Eigen** — full control over what
  interfaces to the measure layer; reuses the kernel's B-rep
  fidelity. Build effort: substantial.

Recommend a v0 against **PyBullet** (low integration cost) on a
second sidecar (`b123d_server/kinematics.py` or a sibling service),
deferred to its own engine once usage justifies it. The interface to
the JS side is symmetric to the existing measure layer:
`POST /kinematics` returning typed results.

## Dependencies — many, deep

- **F6 joints stop being stubs** — joint topology is the input.
  Without real joint semantics, none of this runs. Estimate:
  joints-real is itself ~4-8 weeks of work (per F6's commit 3
  deferrals), and the spec for that hasn't been written.
- **Inertia / mass measure queries** — extend [spec 07](07-measure-api.md)
  with `inertia(featureId)` and `centerOfMass(componentId)`.
- **Motor catalog parallel to standard parts** — for torque envelope
  checks; sibling of [spec 10](10-standard-parts.md) with NEMA frame
  sizes, holding torques, gearbox ratios.
- **Component activation / chain construction UX** — user has to be
  able to declare "this is the kinematic chain" in the document; the
  viewport has to show joint axes; the repair loop has to know which
  chain to analyze.

## What it does NOT replace

- Static interference within a component — still spec 11.
- Manifoldness — still spec 16 invariants.
- Geometric DFM — still spec 11.

The kinematics oracle is *additional*, not *substitutional*. The
existing layers stay intact; this is the layer that handles motion.

## When to spec this for real

Not now. The right trigger is one of:

1. The fit check ([spec 13](13-standard-parts-fit-check.md)) and
   the deterministic extractor + invariants ([15](15-deterministic-extractor.md) + [16](16-invariant-library.md))
   are landed, and the corpus shows that "design verifies
   statically" parts still fail when assembled or actuated — the
   gap kinematics is supposed to close.
2. A user explicitly designs a robotic arm or a parallel mechanism
   and surfaces the absence as a blocker.
3. The repair loop ([spec 08](08-repair-loop.md)) is shipped and
   stabilized on static-only parts.

Until then, this doc exists as the scoping anchor — to keep
"kinematics is just another measure query" from sneaking back into
the plan.

## Effort

Whole workstream — **multi-quarter** at minimum. Not on the
near-term Phase 2 roadmap. v0 against PyBullet for SCARA-style
chains: ~4-6 weeks once joints are real. Production-grade engine:
multiple quarters.
