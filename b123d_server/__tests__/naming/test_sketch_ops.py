"""
Sketch-op naming corpus — Extrude / Revolve parameter-edit survival.

Mirrors the structure of the primitives corpus (`doc_builder.build_doc` →
`extract_topology` → `descriptor_set` diff) but exercises the sketch-based
create operations that produce `start` / `end` / `side[i]` (Extrude) and
`start` / `end` / `lateral` (Revolve) tagged faces per
`NAMING_CONTRACT.md` §"part tag convention".

Each test builds two documents (state A and state B) that differ in one
parameter, extracts the topology for each, and asserts that the descriptor
strings that *should* survive the edit are present in both sets.

API notes (build123d, verified inside test setup helpers — names may shift
across build123d minor versions):

- `BuildSketch` context: `with BuildSketch() as sk: Rectangle(20, 20)`
  then `sk.sketch` yields the Sketch object that `extrude` / `revolve` take.
  `Rectangle` / `Circle` are the closed-loop primitives (no `RectangleSketch`
  in current build123d). We use the context-manager form rather than free
  classes because build123d enforces it for `extrude` input.
- `extrude(sk_obj, amount=..., both=..., taper=...)` — top-level function.
- `revolve(sk_obj, axis=Axis.Z, revolution_arc=360)` — top-level function.
- `Axis.X` / `Axis.Y` / `Axis.Z` are the standard cardinal axes; for an
  arbitrary axis use `Axis((origin), (direction))` but we stick to cardinals.
- `fillet(body.edges(), radius=...)` — direct call on an edge list.

Tests that we expect to fail under the current namer are marked `xfail`
with a rationale in the marker reason.
"""

from __future__ import annotations

import pytest


# ─── Helpers (kept inline — pattern-mirror with the primitives sibling) ────


def _make_rect_sketch(w: float = 20.0, h: float = 20.0):
    """Return a build123d Sketch with a single closed rectangle loop."""
    from build123d import BuildSketch, Rectangle
    with BuildSketch() as sk:
        Rectangle(w, h)
    return sk.sketch


def _make_circle_sketch(r: float = 10.0):
    """Return a build123d Sketch with a single closed circle loop."""
    from build123d import BuildSketch, Circle
    with BuildSketch() as sk:
        Circle(r)
    return sk.sketch


# ─── Cases ─────────────────────────────────────────────────────────────────


def test_extrude_amount_change(build_doc, extract_topology, descriptor_set):
    """Same sketch, amount 10 → 20. start/end/side[i] should all persist —
    the topology of the extruded prism doesn't change with the height."""
    from build123d import extrude

    sk_a = _make_rect_sketch(20, 20)
    body_a = extrude(sk_a, amount=10)
    ns_a, res_a = build_doc(
        ("sk1", sk_a, "Sketch", []),
        ("ex1", body_a, "Extrude", ["sk1"]),
    )

    sk_b = _make_rect_sketch(20, 20)
    body_b = extrude(sk_b, amount=20)
    ns_b, res_b = build_doc(
        ("sk1", sk_b, "Sketch", []),
        ("ex1", body_b, "Extrude", ["sk1"]),
    )

    faces_a = descriptor_set(extract_topology(ns_a, res_a), kind="face")
    faces_b = descriptor_set(extract_topology(ns_b, res_b), kind="face")
    assert faces_a == faces_b, f"diff: {sorted(faces_a ^ faces_b)}"


def test_extrude_taper_change(build_doc, extract_topology, descriptor_set):
    """Taper 0 → 5°. The side faces become slanted planes (still planar)
    so the descriptor set should remain identical: same count, same `part`
    tags. Taper changes geometry, not topology."""
    from build123d import extrude

    sk_a = _make_rect_sketch(20, 20)
    body_a = extrude(sk_a, amount=10)
    ns_a, res_a = build_doc(
        ("sk1", sk_a, "Sketch", []),
        ("ex1", body_a, "Extrude", ["sk1"]),
    )

    sk_b = _make_rect_sketch(20, 20)
    body_b = extrude(sk_b, amount=10, taper=5)
    ns_b, res_b = build_doc(
        ("sk1", sk_b, "Sketch", []),
        ("ex1", body_b, "Extrude", ["sk1"]),
    )

    faces_a = descriptor_set(extract_topology(ns_a, res_a), kind="face")
    faces_b = descriptor_set(extract_topology(ns_b, res_b), kind="face")
    assert faces_a == faces_b, f"diff: {sorted(faces_a ^ faces_b)}"


@pytest.mark.xfail(reason=(
    "both=True extrudes symmetrically about the sketch plane, so what "
    "was the 'start' (−Z normal) cap can become an internal mid-section "
    "or change orientation. The namer's start/end classification is "
    "normal-direction-based (±Z), so the roles may swap. Documented as "
    "a known limitation until the namer threads through the upstream "
    "sketch-plane orientation."
))
def test_extrude_both_directions_change(build_doc, extract_topology, descriptor_set):
    """both=False → both=True. Expected to fail with current namer."""
    from build123d import extrude

    sk_a = _make_rect_sketch(20, 20)
    body_a = extrude(sk_a, amount=10)
    ns_a, res_a = build_doc(
        ("sk1", sk_a, "Sketch", []),
        ("ex1", body_a, "Extrude", ["sk1"]),
    )

    sk_b = _make_rect_sketch(20, 20)
    body_b = extrude(sk_b, amount=10, both=True)
    ns_b, res_b = build_doc(
        ("sk1", sk_b, "Sketch", []),
        ("ex1", body_b, "Extrude", ["sk1"]),
    )

    faces_a = descriptor_set(extract_topology(ns_a, res_a), kind="face")
    faces_b = descriptor_set(extract_topology(ns_b, res_b), kind="face")
    # start/end descriptors should persist by name
    persistent = {d for d in faces_a if ":start" in d or ":end" in d}
    assert persistent <= faces_b, f"missing: {sorted(persistent - faces_b)}"


def test_extrude_sketch_dimension_change(build_doc, extract_topology, descriptor_set):
    """Sketch rectangle 20×20 → 30×30. Same loop count (4 sides), same
    cap count (start + end). Descriptors should be identical: side[0..3],
    start, end."""
    from build123d import extrude

    sk_a = _make_rect_sketch(20, 20)
    body_a = extrude(sk_a, amount=10)
    ns_a, res_a = build_doc(
        ("sk1", sk_a, "Sketch", []),
        ("ex1", body_a, "Extrude", ["sk1"]),
    )

    sk_b = _make_rect_sketch(30, 30)
    body_b = extrude(sk_b, amount=10)
    ns_b, res_b = build_doc(
        ("sk1", sk_b, "Sketch", []),
        ("ex1", body_b, "Extrude", ["sk1"]),
    )

    faces_a = descriptor_set(extract_topology(ns_a, res_a), kind="face")
    faces_b = descriptor_set(extract_topology(ns_b, res_b), kind="face")
    assert faces_a == faces_b, f"diff: {sorted(faces_a ^ faces_b)}"


def test_extrude_sketch_topology_change(build_doc, extract_topology, descriptor_set):
    """Rectangle (4 sides) → Circle (1 side). The side[i] count must
    change (4 → 1), but the start and end caps are independent of the
    sketch loop topology — their descriptors should persist."""
    from build123d import extrude

    sk_a = _make_rect_sketch(20, 20)
    body_a = extrude(sk_a, amount=10)
    ns_a, res_a = build_doc(
        ("sk1", sk_a, "Sketch", []),
        ("ex1", body_a, "Extrude", ["sk1"]),
    )

    sk_b = _make_circle_sketch(10)
    body_b = extrude(sk_b, amount=10)
    ns_b, res_b = build_doc(
        ("sk1", sk_b, "Sketch", []),
        ("ex1", body_b, "Extrude", ["sk1"]),
    )

    faces_a = descriptor_set(extract_topology(ns_a, res_a), kind="face")
    faces_b = descriptor_set(extract_topology(ns_b, res_b), kind="face")

    # Caps must persist verbatim.
    start_end_a = {d for d in faces_a if ":start" in d or ":end" in d}
    assert start_end_a <= faces_b, (
        f"start/end caps must persist across sketch-topology change. "
        f"missing: {sorted(start_end_a - faces_b)}"
    )
    # Side counts must differ: 4 sides in rect vs. 1 lateral side in circle.
    side_a = {d for d in faces_a if ":side[" in d}
    side_b = {d for d in faces_b if ":side[" in d}
    assert len(side_a) == 4, f"expected 4 sides for rectangle, got {len(side_a)}: {side_a}"
    assert len(side_b) == 1, f"expected 1 side for circle, got {len(side_b)}: {side_b}"


@pytest.mark.xfail(reason=(
    "At 360° the revolve produces a single closed lateral surface (no "
    "planar caps). At 180° two planar caps appear that don't exist in "
    "the 360° case. The 'lateral' descriptor should persist, but the new "
    "cap descriptors have no counterpart in the 360° state. Marked xfail "
    "because the descriptor sets cannot be equal across this edit by "
    "definition — the question is only whether the lateral persists."
))
def test_revolve_angle_change(build_doc, extract_topology, descriptor_set):
    """Revolve angle 360° → 180°. Lateral persists; caps appear de novo."""
    from build123d import revolve, Axis

    # The sketch must be off-axis so it has a body to revolve around Z.
    # Translate the rectangle so all of x > 0.
    from build123d import BuildSketch, Rectangle, Location, Vector
    with BuildSketch() as sk_a:
        Rectangle(5, 10, align=None) if False else Rectangle(5, 10)
    # Move the sketch so it doesn't straddle the axis.
    sk_a_obj = sk_a.sketch.moved(Location(Vector(10, 0, 0)))

    with BuildSketch() as sk_b:
        Rectangle(5, 10)
    sk_b_obj = sk_b.sketch.moved(Location(Vector(10, 0, 0)))

    body_a = revolve(sk_a_obj, axis=Axis.Z, revolution_arc=360)
    ns_a, res_a = build_doc(
        ("sk1", sk_a_obj, "Sketch", []),
        ("rv1", body_a, "Revolve", ["sk1"]),
    )
    body_b = revolve(sk_b_obj, axis=Axis.Z, revolution_arc=180)
    ns_b, res_b = build_doc(
        ("sk1", sk_b_obj, "Sketch", []),
        ("rv1", body_b, "Revolve", ["sk1"]),
    )

    faces_a = descriptor_set(extract_topology(ns_a, res_a), kind="face")
    faces_b = descriptor_set(extract_topology(ns_b, res_b), kind="face")
    # Strong assertion (will fail under xfail until namer aligns):
    assert faces_a == faces_b, f"diff: {sorted(faces_a ^ faces_b)}"


def test_revolve_axis_change(build_doc, extract_topology, descriptor_set):
    """Axis Z → Y. The 'lateral' face descriptor must persist — axis is a
    configuration choice, not a face attribute. Caps (if any) also persist
    since both are 360° here."""
    from build123d import revolve, Axis, BuildSketch, Rectangle, Location, Vector

    with BuildSketch() as sk_a:
        Rectangle(5, 10)
    sk_a_obj = sk_a.sketch.moved(Location(Vector(10, 0, 0)))

    with BuildSketch() as sk_b:
        Rectangle(5, 10)
    sk_b_obj = sk_b.sketch.moved(Location(Vector(10, 0, 0)))

    body_a = revolve(sk_a_obj, axis=Axis.Z, revolution_arc=360)
    ns_a, res_a = build_doc(
        ("sk1", sk_a_obj, "Sketch", []),
        ("rv1", body_a, "Revolve", ["sk1"]),
    )
    body_b = revolve(sk_b_obj, axis=Axis.Y, revolution_arc=360)
    ns_b, res_b = build_doc(
        ("sk1", sk_b_obj, "Sketch", []),
        ("rv1", body_b, "Revolve", ["sk1"]),
    )

    faces_a = descriptor_set(extract_topology(ns_a, res_a), kind="face")
    faces_b = descriptor_set(extract_topology(ns_b, res_b), kind="face")
    # The lateral descriptor must persist.
    lateral_a = {d for d in faces_a if ":lateral" in d}
    assert lateral_a, f"no lateral descriptor in state A: {sorted(faces_a)}"
    assert lateral_a <= faces_b, (
        f"lateral descriptor lost across axis change. "
        f"missing: {sorted(lateral_a - faces_b)}"
    )


def test_revolve_sketch_dimension_change(build_doc, extract_topology, descriptor_set):
    """Same axis + angle, sketch rectangle 5×10 → 8×12. Lateral persists."""
    from build123d import revolve, Axis, BuildSketch, Rectangle, Location, Vector

    with BuildSketch() as sk_a:
        Rectangle(5, 10)
    sk_a_obj = sk_a.sketch.moved(Location(Vector(10, 0, 0)))

    with BuildSketch() as sk_b:
        Rectangle(8, 12)
    sk_b_obj = sk_b.sketch.moved(Location(Vector(10, 0, 0)))

    body_a = revolve(sk_a_obj, axis=Axis.Z, revolution_arc=360)
    ns_a, res_a = build_doc(
        ("sk1", sk_a_obj, "Sketch", []),
        ("rv1", body_a, "Revolve", ["sk1"]),
    )
    body_b = revolve(sk_b_obj, axis=Axis.Z, revolution_arc=360)
    ns_b, res_b = build_doc(
        ("sk1", sk_b_obj, "Sketch", []),
        ("rv1", body_b, "Revolve", ["sk1"]),
    )

    faces_a = descriptor_set(extract_topology(ns_a, res_a), kind="face")
    faces_b = descriptor_set(extract_topology(ns_b, res_b), kind="face")
    lateral_a = {d for d in faces_a if ":lateral" in d}
    assert lateral_a <= faces_b, (
        f"lateral descriptor lost across sketch-dimension change. "
        f"missing: {sorted(lateral_a - faces_b)}"
    )


@pytest.mark.xfail(reason=(
    "name_modify (fillet path) attaches the upstream extrude's first-face "
    "descriptor as parent on every blend face. When the sketch dimension "
    "changes, build123d's TopExp iteration order for the extruded faces "
    "can shift, so the 'first face' picked as parent may differ — making "
    "the blend descriptor's parents diverge byte-for-byte across the "
    "edit. Tracked as a v1 namer limitation."
))
def test_extrude_chain_then_fillet(build_doc, extract_topology, descriptor_set):
    """Rectangle → extrude → fillet on all edges. Change rectangle dim;
    fillet blend descriptors should persist."""
    from build123d import extrude, fillet

    sk_a = _make_rect_sketch(20, 20)
    body_a = extrude(sk_a, amount=10)
    fil_a = fillet(body_a.edges(), radius=1)
    ns_a, res_a = build_doc(
        ("sk1", sk_a, "Sketch", []),
        ("ex1", body_a, "Extrude", ["sk1"]),
        ("fil1", fil_a, "Fillet", ["ex1"]),
    )

    sk_b = _make_rect_sketch(30, 30)
    body_b = extrude(sk_b, amount=10)
    fil_b = fillet(body_b.edges(), radius=1)
    ns_b, res_b = build_doc(
        ("sk1", sk_b, "Sketch", []),
        ("ex1", body_b, "Extrude", ["sk1"]),
        ("fil1", fil_b, "Fillet", ["ex1"]),
    )

    faces_a = descriptor_set(extract_topology(ns_a, res_a), kind="face")
    faces_b = descriptor_set(extract_topology(ns_b, res_b), kind="face")
    # Blend faces are the ones tagged `:blend` on the fillet feature.
    blend_a = {d for d in faces_a if ":fillet:blend" in d}
    assert blend_a, f"no blend descriptors in state A: {sorted(faces_a)}"
    assert blend_a <= faces_b, (
        f"blend descriptors lost across edit. missing: {sorted(blend_a - faces_b)}"
    )


def test_extrude_chain_then_cut(build_doc, extract_topology, descriptor_set):
    """Extrude a box, cut a cylindrical bore through it. Change bore
    diameter — the surviving box faces (target side of boolean) and the
    bore wall (tool's lateral surviving in the result) should both have
    persistent descriptors. We assert against the boolean op's face
    descriptors which carry the upstream parents."""
    from build123d import extrude, Cylinder, Location, Vector

    sk_a = _make_rect_sketch(20, 20)
    box_a = extrude(sk_a, amount=10)
    bore_a = Cylinder(2, 20)  # tall enough to punch through
    bore_a = bore_a.moved(Location(Vector(0, 0, 5)))
    cut_a = box_a - bore_a
    ns_a, res_a = build_doc(
        ("sk1", sk_a, "Sketch", []),
        ("ex1", box_a, "Extrude", ["sk1"]),
        ("cy1", bore_a, "Cylinder", []),
        ("cu1", cut_a, "Cut", ["ex1", "cy1"]),
    )

    sk_b = _make_rect_sketch(20, 20)
    box_b = extrude(sk_b, amount=10)
    bore_b = Cylinder(3, 20)  # bigger bore
    bore_b = bore_b.moved(Location(Vector(0, 0, 5)))
    cut_b = box_b - bore_b
    ns_b, res_b = build_doc(
        ("sk1", sk_b, "Sketch", []),
        ("ex1", box_b, "Extrude", ["sk1"]),
        ("cy1", bore_b, "Cylinder", []),
        ("cu1", cut_b, "Cut", ["ex1", "cy1"]),
    )

    faces_a = descriptor_set(extract_topology(ns_a, res_a), kind="face")
    faces_b = descriptor_set(extract_topology(ns_b, res_b), kind="face")
    # The cut op tags every result face as `face:cu1:cut:<surfaceType>[i]`.
    # We expect the same set of `(surfaceType, i)` ordinals to appear in
    # both states because the boolean topology (6 box faces - 2 cut-through
    # caps + 1 cylindrical bore wall) is dimension-invariant.
    cut_faces_a = {d for d in faces_a if ":cu1:cut:" in d}
    cut_faces_b = {d for d in faces_b if ":cu1:cut:" in d}
    assert cut_faces_a == cut_faces_b, (
        f"cut-feature descriptors diverged. diff: {sorted(cut_faces_a ^ cut_faces_b)}"
    )
