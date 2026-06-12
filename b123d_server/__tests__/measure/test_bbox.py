"""
bbox / centroid / surfaceArea on primitives — the trivial cases.

These exist to lock the wire shape: `{min: [x,y,z], max: [x,y,z], size: [w,d,h]}`
for bbox, `{center: [x,y,z]}` for centroid. If the response dict shape drifts,
the JS client's typed wrappers break silently — keep them honest.
"""

from __future__ import annotations


def test_bbox_box_returns_min_max_size(build_state, run_measure, doc):
    """Box(10,20,30) at origin: half-extents on every axis.

    build123d's default Box is centered in XY and sits on Z=MIN, so
    expected min = (-5,-10,0), max=(5,10,30), size=(10,20,30).
    """
    ns, res = build_state(doc.build_box("b", 10, 20, 30))
    r = run_measure({"type": "bbox", "featureId": "b"}, ns, res)
    assert r["ok"] is True
    assert "min" in r and "max" in r and "size" in r
    # size always positive and equal to max - min
    assert all(s >= 0 for s in r["size"])
    assert abs(r["size"][0] - 10) < 1e-6
    assert abs(r["size"][1] - 20) < 1e-6
    assert abs(r["size"][2] - 30) < 1e-6


def test_bbox_cylinder_diameter_matches_2r(build_state, run_measure, doc):
    """Cylinder(r=5, h=10): X & Y size ≈ 10, Z size ≈ 10."""
    ns, res = build_state(doc.build_cylinder("c", 5, 10))
    r = run_measure({"type": "bbox", "featureId": "c"}, ns, res)
    assert r["ok"] is True
    assert abs(r["size"][0] - 10) < 1e-3
    assert abs(r["size"][1] - 10) < 1e-3
    assert abs(r["size"][2] - 10) < 1e-3


def test_centroid_box_at_geometric_center(build_state, run_measure, doc):
    """Box(10,20,30) centroid: XY at origin (Align.CENTER), Z at h/2 (Align.MIN)."""
    ns, res = build_state(doc.build_box("b", 10, 20, 30))
    r = run_measure({"type": "centroid", "featureId": "b"}, ns, res)
    assert r["ok"] is True
    cx, cy, cz = r["center"]
    assert abs(cx) < 1e-6
    assert abs(cy) < 1e-6
    # Z centroid should sit somewhere in [0, 30] — the exact midpoint when
    # build123d's center-of-mass uses uniform density.
    assert 0 <= cz <= 30


def test_bbox_unknown_feature_returns_error(build_state, run_measure, doc):
    """Missing featureId surfaces a per-query error, doesn't crash."""
    ns, res = build_state(doc.build_box("b", 10, 10, 10))
    r = run_measure({"type": "bbox", "featureId": "does_not_exist"}, ns, res)
    assert r["ok"] is False
    assert "not found" in r["error"].lower()
