"""
volume / mass / surfaceArea — the scalar queries.

build123d exposes volume directly; mass derives by unit conversion (mm³ →
cm³ × density). surfaceArea has two flavors — whole-body vs. one face — so
both paths are covered here.
"""

from __future__ import annotations

import math


def test_volume_box_equals_length_width_height(build_state, run_measure, doc):
    """Box(10,10,10) volume = 1000 mm³."""
    ns, res = build_state(doc.build_box("b", 10, 10, 10))
    r = run_measure({"type": "volume", "featureId": "b"}, ns, res)
    assert r["ok"] is True
    assert abs(r["volume"] - 1000.0) < 1e-3


def test_volume_cylinder_equals_pi_r2_h(build_state, run_measure, doc):
    """Cylinder(r=5, h=10) volume ≈ π·25·10 = 785.398 mm³ (OCCT meshing slack)."""
    ns, res = build_state(doc.build_cylinder("c", 5, 10))
    r = run_measure({"type": "volume", "featureId": "c"}, ns, res)
    assert r["ok"] is True
    expected = math.pi * 25 * 10
    # OCCT solid volume is analytic on a true cylinder primitive — tight bound.
    assert abs(r["volume"] - expected) < 1e-3


def test_mass_box_with_default_density(build_state, run_measure, doc):
    """Box(10,10,10) = 1000 mm³ = 1 cm³; at density 1 g/cm³ → 1 g."""
    ns, res = build_state(doc.build_box("b", 10, 10, 10))
    r = run_measure({"type": "mass", "featureId": "b"}, ns, res)
    assert r["ok"] is True
    assert abs(r["mass"] - 1.0) < 1e-6
    assert r["density"] == 1.0


def test_mass_steel_density_scales_linearly(build_state, run_measure, doc):
    """Same 1 cm³ box at density 7.85 (steel) → 7.85 g."""
    ns, res = build_state(doc.build_box("b", 10, 10, 10))
    r = run_measure({"type": "mass", "featureId": "b", "density": 7.85}, ns, res)
    assert r["ok"] is True
    assert abs(r["mass"] - 7.85) < 1e-6


def test_surface_area_box_equals_2lw_plus_2lh_plus_2wh(build_state, run_measure, doc):
    """Box(10,20,30) surface = 2·(200 + 300 + 600) = 2200 mm²."""
    ns, res = build_state(doc.build_box("b", 10, 20, 30))
    r = run_measure({"type": "surfaceArea", "featureId": "b"}, ns, res)
    assert r["ok"] is True
    assert abs(r["area"] - 2200.0) < 1e-3


def test_surface_area_of_one_face_via_descriptor(
    build_state, run_measure, first_face_canonical, doc
):
    """surfaceArea(descriptor) → area of that one face, not the whole body."""
    ns, res = build_state(doc.build_box("b", 10, 20, 30))
    desc = first_face_canonical(res, "b", kind="face")
    r = run_measure({"type": "surfaceArea", "descriptor": desc}, ns, res)
    assert r["ok"] is True
    # The first face of an axis-aligned box must be one of {200, 300, 600} mm².
    assert any(abs(r["area"] - a) < 1e-3 for a in (200.0, 300.0, 600.0))
