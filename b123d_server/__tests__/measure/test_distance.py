"""
distance + normal — descriptor-based face queries.

`distance` uses OCCT's BRepExtrema_DistShapeShape for an exact shortest-path
solve between two B-Rep shapes. `normal` returns the face normal at the
centroid in world coords.
"""

from __future__ import annotations


def _box_face_canonical(harness, topology, feature_id, part_tag):
    """Find the canonical string for a Box face by its `part` tag (+Z, -X, ...).

    Saves the test bodies from positionally guessing the descriptor order.
    """
    for node in topology.get("nodes") or []:
        if node.get("featureId") != feature_id:
            continue
        for entry in node.get("faces") or []:
            d = entry.get("descriptor") or {}
            if d.get("part") == part_tag:
                return harness._descriptor_canonical(d)
    raise AssertionError(f"face {part_tag} not found on {feature_id}")


def test_distance_between_opposite_faces_of_box(build_state, run_measure, doc):
    """+Z to -Z faces of a Box(10,10,30): distance = height = 30 mm."""
    import harness
    ns, res = build_state(doc.build_box("b", 10, 10, 30))
    topo = res["__topology__"]
    desc_top    = _box_face_canonical(harness, topo, "b", "+Z")
    desc_bottom = _box_face_canonical(harness, topo, "b", "-Z")
    r = run_measure({"type": "distance", "descriptorA": desc_top,
                    "descriptorB": desc_bottom}, ns, res)
    assert r["ok"] is True
    assert abs(r["distance"] - 30.0) < 1e-3


def test_normal_of_top_face_points_in_plus_z(build_state, run_measure, doc):
    """+Z face normal: (0, 0, +1)."""
    import harness
    ns, res = build_state(doc.build_box("b", 10, 10, 10))
    topo = res["__topology__"]
    desc_top = _box_face_canonical(harness, topo, "b", "+Z")
    r = run_measure({"type": "normal", "descriptor": desc_top}, ns, res)
    assert r["ok"] is True
    nx, ny, nz = r["normal"]
    assert abs(nx) < 1e-6
    assert abs(ny) < 1e-6
    assert nz > 0.99


def test_distance_unknown_descriptor_returns_per_query_error(
    build_state, run_measure, doc
):
    """A garbled descriptor doesn't fail the batch — surfaces as ok=False."""
    ns, res = build_state(doc.build_box("b", 10, 10, 10))
    r = run_measure({"type": "distance",
                    "descriptorA": "face:nonsense:box:+Z",
                    "descriptorB": "face:nonsense:box:-Z"}, ns, res)
    assert r["ok"] is False
    assert "error" in r
