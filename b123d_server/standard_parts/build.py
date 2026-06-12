"""Parametric body generators for standard-parts entries.

Each `build_*` function takes one catalog entry (the parsed JSON dict) and
returns a build123d `Part` (or compatible solid). v1 is geometric — no
modelled thread helix — so the threaded shank of a screw is a smooth
cylinder at the nominal diameter, the threaded bore of a nut is a smooth
cylinder at the nominal diameter, and the bearing is a hollow disc with a
toroidal ball cage approximation. Comments call out every place a v2 pass
should replace the simplification with a cosmetic helix or a swept ISO 68
thread profile.

All imports of build123d are local so the kernel cold-start path stays
slim — same convention as `harness.py` / `measure.py`.
"""

from __future__ import annotations

import math
from typing import Any


# ── Screws (ISO 4762 SHCS) ───────────────────────────────────────────────


def build_screw(entry: dict) -> Any:
    """ISO 4762 Socket Head Cap Screw.

    Geometry — head sits on Z=0 with the screw axis along +Z pointing down:

        head:  Cylinder(headDiameter/2, headHeight)         z ∈ [0, hh]
        shank: Cylinder(threadNominal/2, lengthTotal) seated below z=0
        socket: cylindrical pocket cut from the top of the head

    Notes:
      * Shank is smooth at the nominal Ø. Modelled thread (cosmetic helix /
        swept ISO 68 profile) is a v2 follow-up — the GLB is dimensionally
        correct and the AI / DFM checks reason from `dims` metadata anyway.
      * Hex socket modelled as a cylinder of equivalent across-flats radius.
        Acceptable for visual + bbox-correct picking; a true hex pocket
        wants a regular polygon sketch + extrude, swap in for v2.
      * MIN-aligned cylinder seated `headHeight` mm below the cut plane so
        the socket pokes through the head's top face — mirrors the
        OVERSHOOT trick in `harness.make_hole`.
    """
    from build123d import (
        Align, BuildPart, BuildSketch, Cylinder, Locations, Mode, Plane,
        RegularPolygon, extrude,
    )

    d = entry["dims"]
    head_r  = d["headDiameter"] / 2.0
    head_h  = d["headHeight"]
    shank_r = d["threadNominal"] / 2.0
    length  = d["lengthTotal"]
    # Across-flats → across-corners radius (regular hexagon inscribed in a
    # circle of radius af / (2·cos30°)). This is the hex socket's circumradius.
    socket_r = d["socketAcrossFlats"] / (2.0 * math.cos(math.radians(30.0)))
    socket_depth = head_h * 0.6

    with BuildPart() as p:
        # Head — sits on z=[0, head_h].
        Cylinder(head_r, head_h,
                 align=(Align.CENTER, Align.CENTER, Align.MIN))
        # Shank — drops below z=0 to z=-length.
        with Locations((0, 0, -length)):
            Cylinder(shank_r, length,
                     align=(Align.CENTER, Align.CENTER, Align.MIN))
        # Hex socket — a true 6-sided pocket cut from the head's top face
        # (a real SHCS Allen socket). Falls back to a round bore if the
        # sketch path errors on a given build123d revision.
        try:
            with BuildSketch(Plane.XY.offset(head_h - socket_depth)):
                RegularPolygon(radius=socket_r, side_count=6)
            extrude(amount=socket_depth + 0.5, mode=Mode.SUBTRACT)
        except Exception:
            with Locations((0, 0, head_h - socket_depth)):
                Cylinder(socket_r, socket_depth + 0.5,
                         align=(Align.CENTER, Align.CENTER, Align.MIN),
                         mode=Mode.SUBTRACT)
    return p.part


# ── Nuts (ISO 4032 hex) ──────────────────────────────────────────────────


def build_nut(entry: dict) -> Any:
    """ISO 4032 Hex Nut.

    Geometry:
      * Hex prism, height = `dims.height`, across-flats radius derived
        from the spec's `acrossFlats` value.
      * Cylindrical bore at nominal Ø — v1 simplification; a swept ISO 68
        female thread profile is the v2 upgrade.

    The hex is built as a 6-side regular polygon sketch extruded by height.
    """
    from build123d import (
        Align, Axis, BuildPart, BuildSketch, Cylinder, Mode, RegularPolygon,
        chamfer, extrude,
    )

    d = entry["dims"]
    af   = d["acrossFlats"]
    h    = d["height"]
    bore = d["threadNominal"] / 2.0
    # RegularPolygon's "radius" param is the across-corners radius (circumscribed).
    across_corners_r = af / (2.0 * math.cos(math.radians(30.0)))

    with BuildPart() as p:
        with BuildSketch():
            RegularPolygon(radius=across_corners_r, side_count=6)
        extrude(amount=h)
        # ISO 4032 hex nuts are chamfered top & bottom (the corners are
        # clipped at ~30°). Chamfer the perimeter of both end faces before
        # the bore is cut; guarded so a plain hex still ships if edge
        # selection differs on a given build123d revision.
        try:
            chamfer_len = min((across_corners_r - af / 2.0) * 0.9, h * 0.2)
            if chamfer_len > 0.05:
                end_edges = p.edges().group_by(Axis.Z)[0] + \
                    p.edges().group_by(Axis.Z)[-1]
                chamfer(end_edges, length=chamfer_len)
        except Exception:
            pass
        # Threaded bore — smooth cylinder for v1.
        Cylinder(bore, h + 1.0,
                 align=(Align.CENTER, Align.CENTER, Align.MIN),
                 mode=Mode.SUBTRACT)
    return p.part


# ── Bearings (608 / 6000-series deep-groove ball) ────────────────────────


def build_bearing(entry: dict) -> Any:
    """Deep-groove ball bearing — outer ring + inner ring + ball cage.

    v1 approximation: subtract an inner ring well from an outer ring well
    to form a hollow disc, and place a toroidal "ball track" centered at
    mid-radius. The toroid is cosmetic — real bearing internals (ball
    count, retainer cage, race profile) are out of scope for v1.

    Geometry — bearing axis along +Z, bottom face on z=0:

        outer cylinder OD × W
        - subtract inner cylinder ID × (W + ε) to make the bore
        - the ball track is a torus on the mid-plane at radius
          (ID/2 + OD/2)/2, minor radius ≈ width × 0.18
    """
    from build123d import (
        Align, BuildPart, Cylinder, Locations, Mode, Torus,
    )

    d = entry["dims"]
    id_  = d["innerDiameter"]
    od_  = d["outerDiameter"]
    w    = d["width"]
    ring_mid_r = (id_ + od_) / 4.0   # radius from axis to centre of ball track
    ball_r     = max((od_ - id_) / 6.0, w * 0.18)

    with BuildPart() as p:
        # Outer cylinder.
        Cylinder(od_ / 2.0, w,
                 align=(Align.CENTER, Align.CENTER, Align.MIN))
        # Bore.
        Cylinder(id_ / 2.0, w + 1.0,
                 align=(Align.CENTER, Align.CENTER, Align.MIN),
                 mode=Mode.SUBTRACT)
        # Ball-race torus at mid-height — cosmetic groove.
        try:
            with Locations((0, 0, w / 2.0)):
                Torus(major_radius=ring_mid_r, minor_radius=ball_r,
                      mode=Mode.SUBTRACT)
        except Exception:
            # Some build123d revisions don't expose Torus the same way;
            # the bore + outer is still a usable bearing approximation.
            pass
    return p.part


# ── T-slot aluminum extrusions (Misumi HFS / 8020 family) ────────────────


# Cross-section parameters per metric series. Dimensions follow Misumi
# HFS5 (20-series, M5 channel) and HFS8 (40-series, M8 channel) catalog
# nominals. Bore = M-tap pilot hole at nominal Ø.
#
# An NxM "compound" profile (e.g. 2040 = 1x2, 8080 = 2x2) is built by
# tiling the base BxB cell on the XY plane, cutting one T-slot inward
# from every external cell face, and cutting one central bore per cell.
# Internal cell boundaries become solid interior walls — matching how
# real extrusions are pressed.
_EXTRUSION_PROFILES = {
    20: {
        "base":          20.0,   # cell size (mm)
        "slot_opening":  6.0,    # outward face slit width
        "lip_depth":     1.8,    # depth from face to inner channel
        "channel_width": 10.6,   # internal T-slot width
        "channel_depth": 5.5,    # total depth from face to back of channel
        "bore":          4.2,    # central through-bore Ø (M5 tap drill)
    },
    40: {
        "base":          40.0,
        "slot_opening":  8.2,
        "lip_depth":     2.0,
        "channel_width": 15.4,
        "channel_depth": 7.5,
        "bore":          6.8,    # M8 tap drill
    },
}


def build_extrusion(entry: dict) -> Any:
    """T-slot aluminum extrusion (Misumi HFS5 / HFS8 family).

    Geometry — bottom face on z=0, length along +Z, cross-section centred
    on the Z axis:

        outer:    Rectangle(gridX*B, gridY*B)
        bores:    one Ø(bore) cut per cell, centred on the cell
        T-slots:  cut inward from every external cell face (top/bottom row
                  → ±Y; left/right column → ±X)

    The bore + slot cuts are made in the 2D sketch, then extruded by
    `length` — this guarantees the slots run full-length and the bore is
    a clean through-hole.

    v1 simplification: cell interiors stay solid, so a 4040/4080/8080
    weighs more than a real Misumi HFS8 (real profile has internal
    cavities + cross-ribs to reduce mass). External profile, slot
    positions, and bore positions are dimensionally correct — fit checks
    and AI reasoning work; mass/CG queries will read heavy. v2 should
    cut the internal cavity rectangles between cells.
    """
    from build123d import (
        Align, BuildPart, BuildSketch, Circle, Locations, Mode, Rectangle,
        extrude,
    )

    d = entry["dims"]
    series = d["series"]
    gx     = int(d["gridX"])
    gy     = int(d["gridY"])
    length = float(d["length"])
    p = _EXTRUSION_PROFILES.get(series)
    if p is None:
        raise KeyError(f"unknown extrusion series: {series!r}")
    B  = p["base"]
    so = p["slot_opening"]
    ld = p["lip_depth"]
    cw = p["channel_width"]
    cd = p["channel_depth"]
    br = p["bore"] / 2.0

    W = gx * B
    H = gy * B

    def _cell_center(i: int, j: int) -> tuple[float, float]:
        cx = (i - (gx - 1) / 2.0) * B
        cy = (j - (gy - 1) / 2.0) * B
        return cx, cy

    with BuildPart() as part:
        with BuildSketch():
            Rectangle(W, H)

            # Central bores — one per cell.
            for i in range(gx):
                for j in range(gy):
                    cx, cy = _cell_center(i, j)
                    with Locations((cx, cy)):
                        Circle(br, mode=Mode.SUBTRACT)

            # External T-slots — bottom row faces -Y, top row faces +Y,
            # left column faces -X, right column faces +X.
            for i in range(gx):
                for j in range(gy):
                    cx, cy = _cell_center(i, j)
                    # +Y face (top row)
                    if j == gy - 1:
                        fy = cy + B / 2.0
                        with Locations((cx, fy - ld / 2.0)):
                            Rectangle(so, ld, mode=Mode.SUBTRACT)
                        with Locations((cx, fy - ld - (cd - ld) / 2.0)):
                            Rectangle(cw, cd - ld, mode=Mode.SUBTRACT)
                    # -Y face (bottom row)
                    if j == 0:
                        fy = cy - B / 2.0
                        with Locations((cx, fy + ld / 2.0)):
                            Rectangle(so, ld, mode=Mode.SUBTRACT)
                        with Locations((cx, fy + ld + (cd - ld) / 2.0)):
                            Rectangle(cw, cd - ld, mode=Mode.SUBTRACT)
                    # +X face (right column)
                    if i == gx - 1:
                        fx = cx + B / 2.0
                        with Locations((fx - ld / 2.0, cy)):
                            Rectangle(ld, so, mode=Mode.SUBTRACT)
                        with Locations((fx - ld - (cd - ld) / 2.0, cy)):
                            Rectangle(cd - ld, cw, mode=Mode.SUBTRACT)
                    # -X face (left column)
                    if i == 0:
                        fx = cx - B / 2.0
                        with Locations((fx + ld / 2.0, cy)):
                            Rectangle(ld, so, mode=Mode.SUBTRACT)
                        with Locations((fx + ld + (cd - ld) / 2.0, cy)):
                            Rectangle(cd - ld, cw, mode=Mode.SUBTRACT)

        extrude(amount=length)
    return part.part


# ── T-slot T-nuts (Misumi HNTR family — drop-in / sliding) ────────────────


def build_t_nut(entry: dict) -> Any:
    """Stepped T-nut for HFS-series aluminum extrusion channels.

    The cross-section is a T: a wide flat "base" that captures under the
    extrusion's slot lips, plus a narrow "neck" that protrudes through the
    slot opening. The cross-section runs the length of the body — so a
    single screw can clamp onto the neck from outside while the base
    transfers load to the channel walls. Dimensions follow the Misumi
    HNTR5 (M5) and HNTR8 (M8) catalog nominals so the t-nut actually
    *fits* its matching extrusion (`_EXTRUSION_PROFILES` above):

      HNTR5 in HFS5:  base 9.5 < channel 10.6, neck 5.7 < slot 6.0
                      → tight slide along channel, retained by lips
      HNTR8 in HFS8:  base 15.0 < channel 15.4, neck 8.0 < slot 8.2

    Geometry — t-nut sits with:
        +X      = length along the channel (slide axis)
        +Z      = thread axis (points out through the slot)
        z = 0   = bottom of the base
        z = bh+nh = top of the neck

    Construction: stack two `Box` solids (base + neck), subtract a vertical
    bore for the M-nominal thread. Both boxes are XY-centred; the t-nut
    body straddles `x = 0` so the part's local frame midline matches the
    "rail-slide" connector authored on the JS-side library entry.

    v1 simplification: the threaded hole is a smooth cylinder at nominal
    Ø (5.0 mm for M5, 8.0 mm for M8) — matching the ISO 4032 hex nut
    treatment in `build_nut` above. Swept ISO 68 thread is a v2 follow-up.
    """
    from build123d import (
        Align, BuildPart, Box, Cylinder, Locations, Mode,
    )

    d = entry["dims"]
    L  = float(d["baseLength"])
    bw = float(d["baseWidth"])
    bh = float(d["baseHeight"])
    nw = float(d["neckWidth"])
    nh = float(d["neckHeight"])
    thr_r = float(d["threadNominal"]) / 2.0
    total_h = bh + nh

    with BuildPart() as part:
        # Base — wide bottom slab on z=0..bh, XY-centred.
        Box(L, bw, bh,
            align=(Align.CENTER, Align.CENTER, Align.MIN))
        # Neck — narrower top, stacked at z=bh..bh+nh, also XY-centred.
        with Locations((0, 0, bh)):
            Box(L, nw, nh,
                align=(Align.CENTER, Align.CENTER, Align.MIN))
        # Through-hole at the thread nominal Ø — full height + a margin so
        # the boolean is clean at both faces.
        Cylinder(thr_r, total_h + 1.0,
                 align=(Align.CENTER, Align.CENTER, Align.MIN),
                 mode=Mode.SUBTRACT)
    return part.part


# ── Builders that are catalog-only (no body) ─────────────────────────────


def build_data_only(entry: dict) -> Any:
    """Threads / clearance holes / fits don't have a physical part — the
    entry is dimensional metadata only. Returning a tiny placeholder marker
    cube keeps the cache happy when a caller insists on a GLB; callers that
    care about body-ness check `entry['category']` first.
    """
    from build123d import Align, BuildPart, Cylinder
    with BuildPart() as p:
        Cylinder(0.5, 1.0, align=(Align.CENTER, Align.CENTER, Align.MIN))
    return p.part


# ── Dispatch by category ─────────────────────────────────────────────────


def _mechatronic_builder(name: str):
    """Lazily resolve a Phase-4 mechatronic builder so a partial install (no
    mechatronic.py) doesn't break the screw/nut/bearing path at import time."""
    from . import mechatronic as _m
    return getattr(_m, name)


_BUILDERS = {
    "Fastener-screw":   build_screw,
    "Fastener-nut":     build_nut,
    "Bearing":          build_bearing,
    "Extrusion":        build_extrusion,
    "T-Nut":            build_t_nut,
    "Thread":           build_data_only,
    "ClearanceHole":    build_data_only,
    "Fit":              build_data_only,
    # Phase 4 — mechatronic families (see mechatronic.py).
    "Servo":            lambda e: _mechatronic_builder("build_servo")(e),
    "Standoff":         lambda e: _mechatronic_builder("build_standoff")(e),
    "Horn":             lambda e: _mechatronic_builder("build_horn")(e),
    "KeepOut":          lambda e: _mechatronic_builder("build_keepout")(e),
}


def builder_for(entry: dict):
    """Pick the matching builder for one catalog entry.

    Fasteners fork on `standard`: ISO 4762 → screw, ISO 4032 → nut. Other
    categories map by `category` alone.
    """
    cat = entry.get("category", "")
    std = entry.get("standard", "")
    if cat == "Fastener":
        if "4762" in std:
            return build_screw
        if "4032" in std:
            return build_nut
    return _BUILDERS.get(cat, build_data_only)


def build_entry(entry: dict) -> Any:
    """Build the body for a catalog entry by dispatching to the right builder."""
    return builder_for(entry)(entry)
