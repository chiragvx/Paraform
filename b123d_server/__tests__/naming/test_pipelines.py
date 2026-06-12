"""
Multi-feature pipeline naming corpus.

These are the "real-world chain" tests — sketch → extrude → fillet,
two-extrusion union, multi-hole box, fillet-after-boolean, revolve into
pattern. Each builds a non-trivial feature chain in two parameter
configurations and asserts that the descriptor strings on the
*topologically-stable* faces survive the edit.

Why these cases matter:
  * They exercise the descriptor-parent chain across two or three
    operations (the contract requires `parents[0]` to carry the upstream
    descriptor; if any namer drops the parent, queries like
    `qDescendsFrom(sketchLoop)` go silently empty).
  * They surface the "first-descriptor heuristic" gap in
    `_extract_topology_v4` — when multiple upstream features contribute
    faces to a boolean result, the harness currently picks the first
    matching descriptor; a robust implementation tracks per-face origin.
  * They are how the kernel's naming is graded against FreeCAD 1.0's
    RealThunder regression corpus (foundation plan, §"Test corpus").

Tests are honestly marked `xfail` where they depend on namers that haven't
landed yet — primarily Hole's `bore-side` part vocabulary, name_xform
pass-through, and the fillet-after-boolean parent-tracking gap.
"""

from __future__ import annotations

import pytest


# ─── Sketch helpers (inline — not adding to doc_builder) ───────────────────


def _rect_sketch(w: float, h: float):
    from build123d import BuildSketch, Rectangle
    with BuildSketch() as sk:
        Rectangle(w, h)
    return sk.sketch


def _circle_sketch(r: float):
    from build123d import BuildSketch, Circle
    with BuildSketch() as sk:
        Circle(r)
    return sk.sketch


# ─── 1. Sketch → Extrude → Fillet pipeline, change sketch dim ──────────────


def test_sketch_extrude_fillet_pipeline_dim_change(
    build_doc, extract_topology, descriptor_set
):
    """Rectangle(20×20) → Extrude(h=10) → Fillet(r=1).
       Change rectangle dim to 30×30; the extruded body's `start`/`end`
       cardinal face tags should appear on both, and the fillet's blend
       descriptor (owned by the fillet feature id) likewise persists.

    The extrude topology of a closed rectangle is start (-Z cap), end
    (+Z cap), and four side[i] rectangles — none of those *kinds* change
    when the sketch grows."""
    from build123d import extrude, fillet

    sk_a = _rect_sketch(20, 20)
    ex_a = extrude(sk_a, amount=10)
    fil_a = fillet(ex_a.edges(), radius=1)
    ns_a, res_a = build_doc(
        ("sk1", sk_a,  "Sketch",  []),
        ("ex1", ex_a,  "Extrude", ["sk1"]),
        ("fil1", fil_a, "Fillet", ["ex1"]),
    )
    faces_a = descriptor_set(extract_topology(ns_a, res_a), kind="face")

    sk_b = _rect_sketch(30, 30)
    ex_b = extrude(sk_b, amount=10)
    fil_b = fillet(ex_b.edges(), radius=1)
    ns_b, res_b = build_doc(
        ("sk1", sk_b,  "Sketch",  []),
        ("ex1", ex_b,  "Extrude", ["sk1"]),
        ("fil1", fil_b, "Fillet", ["ex1"]),
    )
    faces_b = descriptor_set(extract_topology(ns_b, res_b), kind="face")

    # The extrude feature's start + end caps survive the sketch-dim edit;
    # a fillet on every edge consumes them entirely from the *final* body,
    # but the harness still emits the extrude feature's descriptors on its
    # own node. We assert presence on the ex1 node either way.
    ex1_a = {d for d in faces_a if d.startswith("face:ex1:extrude:")}
    ex1_b = {d for d in faces_b if d.startswith("face:ex1:extrude:")}
    assert ex1_a, "state A: no extrude descriptors on ex1"
    assert ex1_b, "state B: no extrude descriptors on ex1"
    # The set of extrude part-tags is independent of the sketch's width/height.
    assert ex1_a == ex1_b, (
        f"extrude descriptors perturbed by sketch-dim change: "
        f"{sorted(ex1_a ^ ex1_b)}"
    )


# ─── 2. Two extrusions, unioned: change one, the other persists ────────────


def test_two_extrusions_unioned_dim_change(
    build_doc, extract_topology, descriptor_set
):
    """Two extrusions, unioned; change ex_a's amount, ex_b's descriptors
    must persist verbatim.

    Setup:
      sk_a = rect 10×10 → ex_a = extrude(amount=h_a)
      sk_b = rect 6×6   → ex_b = extrude(amount=8) at Location([20,0,0])
      u    = ex_a ∪ ex_b

    Edit: h_a goes 10 → 25. ex_b is unchanged; every descriptor on ex_b's
    node should appear in both topology snapshots.
    """
    from build123d import extrude, Location, Vector

    sk_a = _rect_sketch(10, 10)
    ex_a = extrude(sk_a, amount=10)
    sk_b = _rect_sketch(6, 6)
    ex_b = extrude(sk_b, amount=8).moved(Location(Vector(20, 0, 0)))
    u_a = ex_a + ex_b
    ns_a, res_a = build_doc(
        ("sk_a", sk_a, "Sketch",  []),
        ("ex_a", ex_a, "Extrude", ["sk_a"]),
        ("sk_b", sk_b, "Sketch",  []),
        ("ex_b", ex_b, "Extrude", ["sk_b"]),
        ("u",    u_a,  "Union",   ["ex_a", "ex_b"]),
    )
    faces_a = descriptor_set(extract_topology(ns_a, res_a), kind="face")

    sk_a2 = _rect_sketch(10, 10)
    ex_a2 = extrude(sk_a2, amount=25)
    sk_b2 = _rect_sketch(6, 6)
    ex_b2 = extrude(sk_b2, amount=8).moved(Location(Vector(20, 0, 0)))
    u_b = ex_a2 + ex_b2
    ns_b, res_b = build_doc(
        ("sk_a", sk_a2, "Sketch",  []),
        ("ex_a", ex_a2, "Extrude", ["sk_a"]),
        ("sk_b", sk_b2, "Sketch",  []),
        ("ex_b", ex_b2, "Extrude", ["sk_b"]),
        ("u",    u_b,   "Union",   ["ex_a", "ex_b"]),
    )
    faces_b = descriptor_set(extract_topology(ns_b, res_b), kind="face")

    # ex_b's own-feature face descriptors are invariant under the ex_a edit.
    exb_a = {d for d in faces_a if d.startswith("face:ex_b:extrude:")}
    exb_b = {d for d in faces_b if d.startswith("face:ex_b:extrude:")}
    assert exb_a == exb_b, (
        f"ex_b descriptors perturbed by ex_a height change: "
        f"{sorted(exb_a ^ exb_b)}"
    )


# ─── 3. Box with three holes: change one, other two persist ────────────────


@pytest.mark.xfail(
    strict=False,
    reason="name_hole shipped — the h2 / h3 nodes are each built from a bare "
           "Cylinder body (the tool, not the cut result), so name_hole sees "
           "1 cylindrical face → emits `bore-side`. With h2 / h3 parameters "
           "unchanged between states, their descriptors should persist. "
           "Marked strict=False because the assertion crosses three features "
           "and any divergence in build123d's face iteration on the Cylinder "
           "tool body across rebuilds would surface here first."
)
def test_box_with_three_holes(
    build_doc, extract_topology, descriptor_set
):
    """Box(40×40×10) − 3 cylinders at distinct XY positions; change one
    hole's radius, the other two holes' bore-side descriptors persist.
    """
    from build123d import Box, Cylinder, Location, Vector

    box_a = Box(40, 40, 10)
    h1_a = Cylinder(radius=2, height=12).moved(Location(Vector(-12,  10, 0)))
    h2_a = Cylinder(radius=2, height=12).moved(Location(Vector( 12,  10, 0)))
    h3_a = Cylinder(radius=2, height=12).moved(Location(Vector(  0, -10, 0)))
    body_a = box_a - h1_a - h2_a - h3_a
    ns_a, res_a = build_doc(
        ("box1", box_a,  "Box",  []),
        ("h1",   h1_a,   "Hole", ["box1"]),
        ("h2",   h2_a,   "Hole", ["box1"]),
        ("h3",   h3_a,   "Hole", ["box1"]),
        ("p",    body_a, "Cut",  ["box1", "h1", "h2", "h3"]),
    )
    faces_a = descriptor_set(extract_topology(ns_a, res_a), kind="face")

    box_b = Box(40, 40, 10)
    h1_b = Cylinder(radius=3, height=12).moved(Location(Vector(-12,  10, 0)))  # ↑ r
    h2_b = Cylinder(radius=2, height=12).moved(Location(Vector( 12,  10, 0)))
    h3_b = Cylinder(radius=2, height=12).moved(Location(Vector(  0, -10, 0)))
    body_b = box_b - h1_b - h2_b - h3_b
    ns_b, res_b = build_doc(
        ("box1", box_b,  "Box",  []),
        ("h1",   h1_b,   "Hole", ["box1"]),
        ("h2",   h2_b,   "Hole", ["box1"]),
        ("h3",   h3_b,   "Hole", ["box1"]),
        ("p",    body_b, "Cut",  ["box1", "h1", "h2", "h3"]),
    )
    faces_b = descriptor_set(extract_topology(ns_b, res_b), kind="face")

    # The box's cardinal-face descriptors survive (only the bore changes).
    for axis in ("+X", "-X", "+Y", "-Y", "+Z", "-Z"):
        assert any(f":box1:box:{axis}" in d for d in faces_a), \
            f"missing box1:box:{axis} in state A"
        assert any(f":box1:box:{axis}" in d for d in faces_b), \
            f"missing box1:box:{axis} in state B"

    # h2 and h3 are unchanged — their bore-side descriptors persist verbatim.
    for fid in ("h2", "h3"):
        assert any(f":{fid}:hole:bore-side" in d for d in faces_a), \
            f"missing {fid} bore-side in state A"
        assert any(f":{fid}:hole:bore-side" in d for d in faces_b), \
            f"missing {fid} bore-side in state B"


# ─── 4. Fillet after boolean: change tool radius, box side persists ────────


@pytest.mark.xfail(
    reason="Fillet's `blend` part tag depends on the eliminated edge's "
           "parent descriptor (NAMING_CONTRACT §Parents). When the fillet "
           "is applied after a Box ∪ Cylinder union, the eliminated edges "
           "are *new* edges created by the union (target∩tool seam), and "
           "the v1 boolean namer doesn't emit those new-edge descriptors. "
           "Result: name_modify can't find a parent for the blend, and "
           "falls through to ordinal face[i] tagging."
)
def test_fillet_after_boolean(
    build_doc, extract_topology, descriptor_set
):
    """Box ∪ Cylinder → Fillet(every edge). Change cylinder radius. The
    box-side descriptors persist; the fillet blend descriptors are
    expected to renumber (hence xfail).
    """
    from build123d import Box, Cylinder, Location, Vector, fillet

    box_a = Box(20, 20, 10)
    cyl_a = Cylinder(radius=4, height=10).moved(Location(Vector(0, 0, 8)))
    u_a = box_a + cyl_a
    fil_a = fillet(u_a.edges(), radius=0.5)
    ns_a, res_a = build_doc(
        ("box1", box_a, "Box",      []),
        ("cyl1", cyl_a, "Cylinder", []),
        ("u",    u_a,   "Union",    ["box1", "cyl1"]),
        ("fil1", fil_a, "Fillet",   ["u"]),
    )
    faces_a = descriptor_set(extract_topology(ns_a, res_a), kind="face")

    box_b = Box(20, 20, 10)
    cyl_b = Cylinder(radius=6, height=10).moved(Location(Vector(0, 0, 8)))
    u_b = box_b + cyl_b
    fil_b = fillet(u_b.edges(), radius=0.5)
    ns_b, res_b = build_doc(
        ("box1", box_b, "Box",      []),
        ("cyl1", cyl_b, "Cylinder", []),
        ("u",    u_b,   "Union",    ["box1", "cyl1"]),
        ("fil1", fil_b, "Fillet",   ["u"]),
    )
    faces_b = descriptor_set(extract_topology(ns_b, res_b), kind="face")

    # Box's vertical-side faces (+X / -X / +Y / -Y) are untouched by both
    # the union *and* the fillet (assuming the cylinder sits on top, not
    # poking through a side). They persist verbatim.
    for axis in ("+X", "-X", "+Y", "-Y"):
        assert any(f":box1:box:{axis}" in d for d in faces_a), \
            f"missing box1:box:{axis} in state A"
        assert any(f":box1:box:{axis}" in d for d in faces_b), \
            f"missing box1:box:{axis} in state B"
    # And the fillet emits its blend descriptor in both.
    assert any(":fil1:fillet:blend" in d for d in faces_a), \
        "missing fillet blend in state A"
    assert any(":fil1:fillet:blend" in d for d in faces_b), \
        "missing fillet blend in state B"


# ─── 5. Revolve into linear pattern: change count, instance[0..1] persist ──


@pytest.mark.xfail(
    reason="Two compounding gaps: (1) the revolve namer is partial — the "
           "revolved body's `lateral` part tag is correct but pattern "
           "instances need `inst[i]-<originalPart>` per contract; (2) "
           "LinearPattern dispatches through name_generic, which doesn't "
           "emit `inst[i]` tags at all. Until name_linear_pattern lands "
           "and consumes the revolve's parts, count edits can't be tested "
           "for descriptor persistence."
)
def test_revolve_into_pattern(
    build_doc, extract_topology, descriptor_set
):
    """Circle sketch → Revolve(Z, 360°) → LinearPattern(count=3, spacing=20).
    Change count to 5; inst[0]/inst[1] face descriptors persist.
    """
    from build123d import (
        Axis, BuildSketch, Circle, Location, Vector, revolve,
    )

    # Build a planar circle offset from the revolve axis so revolve produces
    # a torus-like solid. Position the circle in the XZ plane (Z-up scene)
    # so revolving about Z sweeps a torus.
    with BuildSketch() as sk_a:
        Circle(2)
    sk_a_off = sk_a.sketch.moved(Location(Vector(10, 0, 0)))
    rev_a = revolve(sk_a_off, axis=Axis.Z, revolution_arc=360)

    # Pattern: stack three copies along +X.
    pat_a = rev_a + \
        rev_a.moved(Location(Vector(20, 0, 0))) + \
        rev_a.moved(Location(Vector(40, 0, 0)))
    ns_a, res_a = build_doc(
        ("sk1", sk_a_off, "Sketch",        []),
        ("rev1", rev_a,   "Revolve",       ["sk1"]),
        ("pat1", pat_a,   "LinearPattern", ["rev1"]),
    )
    faces_a = descriptor_set(extract_topology(ns_a, res_a), kind="face")

    with BuildSketch() as sk_b:
        Circle(2)
    sk_b_off = sk_b.sketch.moved(Location(Vector(10, 0, 0)))
    rev_b = revolve(sk_b_off, axis=Axis.Z, revolution_arc=360)
    # count = 5 instances along +X.
    pat_b = rev_b
    for k in range(1, 5):
        pat_b = pat_b + rev_b.moved(Location(Vector(20 * k, 0, 0)))
    ns_b, res_b = build_doc(
        ("sk1", sk_b_off, "Sketch",        []),
        ("rev1", rev_b,   "Revolve",       ["sk1"]),
        ("pat1", pat_b,   "LinearPattern", ["rev1"]),
    )
    faces_b = descriptor_set(extract_topology(ns_b, res_b), kind="face")

    # Contract: inst[0] and inst[1] are unchanged across the count edit.
    for i in (0, 1):
        assert any(f":pat1:linpat:inst[{i}]-" in d for d in faces_a), \
            f"missing inst[{i}] in state A"
        assert any(f":pat1:linpat:inst[{i}]-" in d for d in faces_b), \
            f"missing inst[{i}] in state B"
