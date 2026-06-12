"""
interference — boolean intersection volume between two named features.

A box overlapping another box by a known amount has a known intersection
volume. A box that doesn't touch another box has zero intersection.
"""

from __future__ import annotations


def test_interference_disjoint_boxes_have_no_overlap(build_state, run_measure, doc):
    """Two boxes far apart along X — no intersection."""
    from build123d import Box, Pos
    box_a = Box(10, 10, 10)
    box_b = Pos(50, 0, 0) * Box(10, 10, 10)
    ns, res = build_state(
        ("a", box_a, "Box", []),
        ("b", box_b, "Box", []),
    )
    r = run_measure({"type": "interference", "featureIdA": "a", "featureIdB": "b"},
                    ns, res)
    assert r["ok"] is True
    assert r["intersects"] is False
    assert r["volume"] < 1e-6


def test_interference_overlapping_boxes_report_intersection_volume(
    build_state, run_measure, doc
):
    """Two 10×10×10 boxes overlapping by 5 mm on X → 5×10×10 = 500 mm³."""
    from build123d import Box, Pos
    box_a = Box(10, 10, 10)
    box_b = Pos(5, 0, 0) * Box(10, 10, 10)
    ns, res = build_state(
        ("a", box_a, "Box", []),
        ("b", box_b, "Box", []),
    )
    r = run_measure({"type": "interference", "featureIdA": "a", "featureIdB": "b"},
                    ns, res)
    assert r["ok"] is True
    assert r["intersects"] is True
    # The two boxes overlap on X∈[0,5] (each centered at 0 and 5 with ±5 reach),
    # Y∈[-5,5], Z∈[0,10] (Align.MIN on Z). Volume = 5·10·10 = 500.
    assert abs(r["volume"] - 500.0) < 1.0  # 1 mm³ tolerance for OCCT meshing


def test_unknown_query_type_returns_error(build_state, run_measure, doc):
    """Unknown query type doesn't crash; per-query error is reported."""
    ns, res = build_state(doc.build_box("b", 10, 10, 10))
    r = run_measure({"type": "this_does_not_exist", "featureId": "b"}, ns, res)
    assert r["ok"] is False
    assert "unknown query type" in r["error"]
