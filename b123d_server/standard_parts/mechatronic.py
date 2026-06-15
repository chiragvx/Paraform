"""Parametric body generators for Phase-4 mechatronic standard-parts.

Adds builders for servos, brass standoffs, and keep-out volumes that the
robotic-arm library needs. Same conventions as `build.py`:

  * build123d imports are local (slim cold-start path).
  * bodies are MIN-aligned on Z (bottom face on z=0) unless noted, matching
    `Align.MIN` everywhere else in the kernel (see CLAUDE.md).
  * all dimensions in mm, Z-up.

Each `build_*` takes one catalog entry dict (the parsed JSON, carrying a
`dims` block from the datasheet) and returns a build123d `Part`.

These builders are intentionally *parametric*: a servo builder takes body
L/W/H + flange + shaft dims so the same function covers SG90 → MG996R →
DS3218. The eval guardrail (`__tests__/test_new_parts.py`) checks the built
bounding box against the catalog's declared `bbox` within tolerance — the
"verify against datasheet numbers" contract from PLAN.md Phase 4.
"""

from __future__ import annotations

from typing import Any


# ── Servos ────────────────────────────────────────────────────────────────


def build_servo(entry: dict) -> Any:
    """RC servo — body block + mounting flange + output-shaft boss.

    Geometry (Z-up, bottom face on z=0, output shaft along +Z):

        body:   Box(bodyL, bodyW, bodyH)              z ∈ [0, bodyH]
        flange: Box(bodyL + 2*flangeEar, bodyW, flangeT)
                centred at z = flangeZ (the mount plane)
        holes:  Ø(mountHoleD) cut through the flange at each mountHoles[x,y]
        boss:   Cylinder(bossR, bossH) on top of the body (gearbox hub)
        shaft:  Cylinder(shaftR, shaftH) at (shaftX, 0) — the output spline

    `dims` keys (mm): bodyL, bodyW, bodyH, flangeEar, flangeT, flangeZ,
    bossR, bossH, shaftR, shaftH, shaftX. Optional: mountHoles (list of
    [x, y] in the flange plane) + mountHoleD; when omitted, two holes are
    derived at the ear centres so the geometry carries the mounting holes
    the `mount-hole` connectors point at.
    """
    from build123d import Align, BuildPart, Box, Cylinder, Locations, Mode

    d = entry["dims"]
    bodyL = float(d["bodyL"])
    bodyW = float(d["bodyW"])
    bodyH = float(d["bodyH"])
    ear = float(d.get("flangeEar", 0.0))
    ft = float(d.get("flangeT", 0.0))
    fz = float(d.get("flangeZ", bodyH))
    boss_r = float(d.get("bossR", 0.0))
    boss_h = float(d.get("bossH", 0.0))
    shaft_r = float(d.get("shaftR", 0.0))
    shaft_h = float(d.get("shaftH", 0.0))
    shaft_x = float(d.get("shaftX", 0.0))

    # Flange mounting holes — explicit from the datasheet, else derived at
    # the ear centres (±(bodyL/2 + ear/2), on the body midline).
    hole_d = float(d.get("mountHoleD", 2.0))
    holes = d.get("mountHoles")
    if holes is None and ear > 0.0:
        hx = bodyL / 2.0 + ear / 2.0
        holes = [[-hx, 0.0], [hx, 0.0]]
    holes = holes or []

    with BuildPart() as p:
        # Main body — XY-centred, sits on z=0.
        Box(bodyL, bodyW, bodyH,
            align=(Align.CENTER, Align.CENTER, Align.MIN))
        # Mounting flange (ears extend beyond the body in X).
        if ear > 0.0 and ft > 0.0:
            with Locations((0, 0, fz)):
                Box(bodyL + 2.0 * ear, bodyW, ft,
                    align=(Align.CENTER, Align.CENTER, Align.MIN))
            # Through-holes in the flange ears — a margin past both faces so
            # the boolean is clean. Skipped if the flange is absent.
            if hole_d > 0.0:
                for hx, hy in holes:
                    with Locations((float(hx), float(hy), fz - 0.5)):
                        Cylinder(hole_d / 2.0, ft + 1.0,
                                 align=(Align.CENTER, Align.CENTER, Align.MIN),
                                 mode=Mode.SUBTRACT)
        # Gearbox boss on top of the body.
        if boss_r > 0.0 and boss_h > 0.0:
            with Locations((shaft_x, 0, bodyH)):
                Cylinder(boss_r, boss_h,
                         align=(Align.CENTER, Align.CENTER, Align.MIN))
        # Output shaft (spline approximated as a smooth cylinder — v2 swaps
        # in a fluted profile; bbox + pick are correct now).
        if shaft_r > 0.0 and shaft_h > 0.0:
            with Locations((shaft_x, 0, bodyH + boss_h)):
                Cylinder(shaft_r, shaft_h,
                         align=(Align.CENTER, Align.CENTER, Align.MIN))
    return p.part


# ── Standoffs (hex brass, threaded both ends) ───────────────────────────────


def build_standoff(entry: dict) -> Any:
    """Hex brass standoff — hex prism with a central through/blind bore.

    `dims` (mm): acrossFlats, length, threadNominal. v1 bore is a smooth
    cylinder at the tap diameter (no modelled thread), matching `build_nut`.
    """
    import math

    from build123d import (
        Align, BuildPart, BuildSketch, Cylinder, Mode, RegularPolygon, extrude,
    )

    d = entry["dims"]
    af = float(d["acrossFlats"])
    length = float(d["length"])
    bore = float(d["threadNominal"]) / 2.0
    across_corners_r = af / (2.0 * math.cos(math.radians(30.0)))

    with BuildPart() as p:
        with BuildSketch():
            RegularPolygon(radius=across_corners_r, side_count=6)
        extrude(amount=length)
        # Central bore — through-hole at tap Ø.
        Cylinder(bore, length + 1.0,
                 align=(Align.CENTER, Align.CENTER, Align.MIN),
                 mode=Mode.SUBTRACT)
    return p.part


# ── Servo horns ─────────────────────────────────────────────────────────────


def build_horn(entry: dict) -> Any:
    """Servo horn — a hub cylinder with one or more radial arms.

    `dims` (mm): hubR, thickness, armLength, armWidth, arms (count),
    boreR (spline socket radius). Arms are laid out evenly around the hub.
    """
    import math

    from build123d import (
        Align, BuildPart, Box, Cylinder, Locations, Mode,
    )

    d = entry["dims"]
    hub_r = float(d["hubR"])
    t = float(d["thickness"])
    arm_l = float(d.get("armLength", 0.0))
    arm_w = float(d.get("armWidth", 0.0))
    arms = int(d.get("arms", 0))
    bore_r = float(d["boreR"])

    # Row of attachment holes along each arm — explicit count/size from the
    # datasheet, else a sensible default (the line of small holes every RC
    # horn has). Holes step from just past the hub to near the arm tip.
    arm_holes = int(d.get("armHoles", 3 if arm_l > 8.0 else 0))
    arm_hole_r = float(d.get("armHoleR", min(arm_w * 0.18, 0.9) if arm_w > 0 else 0.0))

    with BuildPart() as p:
        Cylinder(hub_r, t, align=(Align.CENTER, Align.CENTER, Align.MIN))
        # Radial arms — each a box reaching out from the hub, MIN-aligned in
        # its own local X so it spans hub centre → arm tip, rotated about Z.
        if arms > 0 and arm_l > 0.0 and arm_w > 0.0:
            for k in range(arms):
                ang = 360.0 / arms * k
                rad = math.radians(ang)
                cx = math.cos(rad) * arm_l / 2.0
                cy = math.sin(rad) * arm_l / 2.0
                with Locations((cx, cy, 0)):
                    Box(arm_l, arm_w, t,
                        align=(Align.CENTER, Align.CENTER, Align.MIN),
                        rotation=(0, 0, ang))
            # Attachment holes — spaced along each arm's centreline, from
            # ~hub edge out to ~1.5mm short of the tip.
            if arm_holes > 0 and arm_hole_r > 0.0:
                r_start = hub_r + max(arm_hole_r + 0.8, 1.5)
                r_end = arm_l - 1.5
                if r_end > r_start:
                    step = (r_end - r_start) / max(arm_holes - 1, 1)
                    for k in range(arms):
                        rad = math.radians(360.0 / arms * k)
                        ux, uy = math.cos(rad), math.sin(rad)
                        for h in range(arm_holes):
                            r = r_start + step * h
                            with Locations((ux * r, uy * r, -0.5)):
                                Cylinder(arm_hole_r, t + 1.0,
                                         align=(Align.CENTER, Align.CENTER, Align.MIN),
                                         mode=Mode.SUBTRACT)
        # Spline socket bore.
        Cylinder(bore_r, t + 1.0,
                 align=(Align.CENTER, Align.CENTER, Align.MIN),
                 mode=Mode.SUBTRACT)
    return p.part


# ── Structural robotics brackets ────────────────────────────────────────────


def build_bracket(entry: dict) -> Any:
    """Structural mounting bracket — dispatches on `dims.kind`.

    Two archetypes carry the robotics catalog:

      * ``u-cradle`` — a 3-sided servo cradle: an outer block with a central
        servo-shaped pocket cut out the +Z face (the seat the flange drops
        into) plus a clear-through window so wiring/horn pass. The base floor
        carries the M3/M4 mount holes the `base-bore-*` connectors point at.
        `dims`: outerL, outerW, outerH, wall, cradleL, cradleW, mountHoleD,
        baseHoles.
      * ``l-angle`` — a right-angle bracket: a horizontal foot on z=0 plus a
        vertical web rising from the -Y edge, both `wall` thick, with M3 bores
        through each leg. `dims`: legL, legW, legH, wall, mountHoleD.

    Bodies are XY-centred, MIN-aligned on Z (CLAUDE.md convention) so the
    declared `bbox` matches the built bounding box within the eval tolerance.
    """
    from build123d import Align, BuildPart, Box, Cylinder, Locations, Mode

    d = entry["dims"]
    kind = d.get("kind", "u-cradle")

    if kind == "l-angle":
        leg_l = float(d["legL"])
        leg_w = float(d["legW"])
        leg_h = float(d["legH"])
        wall = float(d.get("wall", 3.0))
        hole_d = float(d.get("mountHoleD", 3.2))
        with BuildPart() as p:
            # Horizontal foot — full LxW footprint, `wall` thick on z=0.
            Box(leg_l, leg_w, wall,
                align=(Align.CENTER, Align.CENTER, Align.MIN))
            # Vertical web — rises from the -Y edge, `wall` thick in Y.
            with Locations((0, -leg_w / 2.0 + wall / 2.0, 0)):
                Box(leg_l, wall, leg_h,
                    align=(Align.CENTER, Align.CENTER, Align.MIN))
            # Two M3 bores in the foot (axis -Z) and two in the web (axis -Y).
            if hole_d > 0.0:
                hx = leg_l / 4.0
                for sx in (-hx, hx):
                    with Locations((sx, 5.0, -0.5)):
                        Cylinder(hole_d / 2.0, wall + 1.0,
                                 align=(Align.CENTER, Align.CENTER, Align.MIN),
                                 mode=Mode.SUBTRACT)
                for sx in (-hx, hx):
                    with Locations((sx, -leg_w / 2.0 + wall + 0.5, leg_h * 0.4),
                                   ):
                        Cylinder(hole_d / 2.0, wall + 1.0,
                                 align=(Align.CENTER, Align.CENTER, Align.MIN),
                                 rotation=(90, 0, 0),
                                 mode=Mode.SUBTRACT)
        return p.part

    # ── default: u-cradle ───────────────────────────────────────────────
    L = float(d["outerL"])
    W = float(d["outerW"])
    H = float(d["outerH"])
    wall = float(d.get("wall", 3.0))
    cradle_l = float(d.get("cradleL", L - 2.0 * wall))
    cradle_w = float(d.get("cradleW", W - 2.0 * wall))
    hole_d = float(d.get("mountHoleD", 3.2))
    base_holes = d.get("baseHoles") or []

    with BuildPart() as p:
        # Outer block.
        Box(L, W, H, align=(Align.CENTER, Align.CENTER, Align.MIN))
        # Servo pocket — cut down from the +Z face, leaving a `wall`-thick
        # floor so the base holes have material to thread into.
        pocket_h = H - wall
        with Locations((0, 0, wall)):
            Box(cradle_l, cradle_w, pocket_h + 1.0,
                align=(Align.CENTER, Align.CENTER, Align.MIN),
                mode=Mode.SUBTRACT)
        # Base mount holes through the floor (axis -Z).
        if hole_d > 0.0:
            for hx, hy in base_holes:
                with Locations((float(hx), float(hy), -0.5)):
                    Cylinder(hole_d / 2.0, wall + 1.0,
                             align=(Align.CENTER, Align.CENTER, Align.MIN),
                             mode=Mode.SUBTRACT)
    return p.part


# ── Structural linkages (leg segments, horn couplers) ────────────────────────


def build_linkage(entry: dict) -> Any:
    """Structural linkage — dispatches on `dims.kind`.

      * ``bar`` — a flat leg-link: a rounded-end bar (length × width ×
        thickness) with a pivot bore at each end. `dims`: length, width,
        thickness, endR, pivotD, centerDistance.
      * ``coupler`` — a servo-horn coupler: a hub cylinder with a spline
        socket bore up the axis and an M3 bolt circle through the top deck.
        `dims`: hubR, thickness, boreR, boltCircleR, boltD, boltCount.

    XY-centred, MIN-aligned on Z.
    """
    import math

    from build123d import (
        Align, BuildPart, Box, Cylinder, Locations, Mode,
    )

    d = entry["dims"]
    kind = d.get("kind", "bar")

    if kind == "coupler":
        hub_r = float(d["hubR"])
        t = float(d["thickness"])
        bore_r = float(d.get("boreR", 2.87))
        bc_r = float(d.get("boltCircleR", hub_r * 0.7))
        bolt_d = float(d.get("boltD", 3.2))
        bolt_n = int(d.get("boltCount", 4))
        with BuildPart() as p:
            Cylinder(hub_r, t, align=(Align.CENTER, Align.CENTER, Align.MIN))
            # Spline socket — blind bore from the bottom face up most of t.
            Cylinder(bore_r, t * 0.7,
                     align=(Align.CENTER, Align.CENTER, Align.MIN),
                     mode=Mode.SUBTRACT)
            # M3 bolt circle through the deck.
            if bolt_d > 0.0 and bolt_n > 0:
                for k in range(bolt_n):
                    ang = math.radians(360.0 / bolt_n * k)
                    with Locations((math.cos(ang) * bc_r,
                                    math.sin(ang) * bc_r, -0.5)):
                        Cylinder(bolt_d / 2.0, t + 1.0,
                                 align=(Align.CENTER, Align.CENTER, Align.MIN),
                                 mode=Mode.SUBTRACT)
        return p.part

    # ── default: bar ────────────────────────────────────────────────────
    length = float(d["length"])
    width = float(d["width"])
    t = float(d["thickness"])
    end_r = float(d.get("endR", width / 2.0))
    pivot_d = float(d.get("pivotD", 4.0))
    cdist = float(d.get("centerDistance", length - 2.0 * end_r))
    half = cdist / 2.0

    with BuildPart() as p:
        # Straight shank between the two pivot centres.
        Box(cdist, width, t, align=(Align.CENTER, Align.CENTER, Align.MIN))
        # Rounded ends (cylinders at each pivot centre).
        for sx in (-half, half):
            with Locations((sx, 0, 0)):
                Cylinder(end_r, t, align=(Align.CENTER, Align.CENTER, Align.MIN))
        # Pivot bores.
        if pivot_d > 0.0:
            for sx in (-half, half):
                with Locations((sx, 0, -0.5)):
                    Cylinder(pivot_d / 2.0, t + 1.0,
                             align=(Align.CENTER, Align.CENTER, Align.MIN),
                             mode=Mode.SUBTRACT)
    return p.part


# ── Keep-out boxes (electronics) ────────────────────────────────────────────


def build_keepout(entry: dict) -> Any:
    """Simple rectangular keep-out volume for electronics / batteries.

    `dims` (mm): length, width, height. The body is XY-centred and sits on
    z=0 so it occupies the same envelope as the JS-side library bounding box.
    """
    from build123d import Align, BuildPart, Box

    d = entry["dims"]
    with BuildPart() as p:
        Box(float(d["length"]), float(d["width"]), float(d["height"]),
            align=(Align.CENTER, Align.CENTER, Align.MIN))
    return p.part
