"""
holes / manifold — defensive enumeration over a hole-bearing body.

A plain box has no cylindrical faces, so `holes` returns `[]`. A box with
a hole drilled through it should produce exactly one cylindrical hole
group. `manifold` should report closed/watertight for a primitive solid.
"""

from __future__ import annotations


def test_holes_empty_on_plain_box(build_state, run_measure, doc):
    """Box without any cylindrical faces → empty hole list, ok=True."""
    ns, res = build_state(doc.build_box("b", 10, 10, 10))
    r = run_measure({"type": "holes", "featureId": "b"}, ns, res)
    assert r["ok"] is True
    assert r["holes"] == []


def test_holes_on_drilled_box_finds_one_cylinder(build_state, run_measure, doc):
    """Box - Cylinder = box with through-hole. Hole enumeration sees the bore.

    The cut tool here is a cylinder along Z taller than the box, so OCCT
    produces a clean through-cut leaving exactly one cylindrical face on
    the result body.
    """
    from build123d import Box, Cylinder, Pos
    box = Box(20, 20, 10)
    cyl = Cylinder(2, 30)
    drilled = box - cyl
    ns, res = build_state(
        ("box_a", box, "Box", []),
        ("drilled", drilled, "Cut", ["box_a"]),
    )
    r = run_measure({"type": "holes", "featureId": "drilled"}, ns, res)
    assert r["ok"] is True
    assert len(r["holes"]) == 1
    h = r["holes"][0]
    # Diameter ≈ 4 (radius 2). OCCT cylindrical face radius is exact.
    assert abs(h["diameter"] - 4.0) < 1e-3
    # Center should be near the box's XY origin (the cylinder is centered there).
    assert abs(h["center"][0]) < 1e-3
    assert abs(h["center"][1]) < 1e-3


def test_manifold_box_is_closed_and_watertight(build_state, run_measure, doc):
    """A primitive solid box is BRep-valid → closed, watertight, χ = 2."""
    ns, res = build_state(doc.build_box("b", 10, 10, 10))
    r = run_measure({"type": "manifold", "featureId": "b"}, ns, res)
    assert r["ok"] is True
    assert r["closed"] is True
    assert r["watertight"] is True
    # χ for a convex topological ball: V - E + F = 8 - 12 + 6 = 2.
    assert r["eulerNumber"] == 2


def test_manifold_cylinder_euler_number(build_state, run_measure, doc):
    """Cylinder: 2 vertices (seam endpoints) - 3 edges (top ring, bottom ring,
    seam) + 3 faces (top, bottom, lateral) = 2. OCCT topology cell counts
    can differ across versions, so we just assert validity + presence of χ."""
    ns, res = build_state(doc.build_cylinder("c", 5, 10))
    r = run_measure({"type": "manifold", "featureId": "c"}, ns, res)
    assert r["ok"] is True
    assert r["closed"] is True
    assert isinstance(r["eulerNumber"], int)
