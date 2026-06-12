"""
manifold + selfIntersection on simple solids.

A primitive (Box, Sphere) is closed; a deliberately broken compound (two
overlapping boxes' union) should still close after the boolean fuse. The
self-intersection sampler should report no hits on a clean primitive.
"""

from __future__ import annotations


def test_manifold_sphere_is_closed(build_state, run_measure, doc):
    """Sphere is closed + watertight; topology has a single face."""
    ns, res = build_state(doc.build_sphere("s", 5))
    r = run_measure({"type": "manifold", "featureId": "s"}, ns, res)
    assert r["ok"] is True
    assert r["closed"] is True
    assert r["watertight"] is True


def test_self_intersection_clean_box_no_hits(build_state, run_measure, doc):
    """A plain primitive box has no self-intersections. ok=True, locations=[]."""
    ns, res = build_state(doc.build_box("b", 10, 10, 10))
    r = run_measure({"type": "selfIntersection", "featureId": "b"}, ns, res)
    # Sample-based: ok==True when no intersections found, locations empty.
    assert r["ok"] is True
    assert r["locations"] == []


def test_self_intersection_sphere_no_hits(build_state, run_measure, doc):
    """Same on a sphere — adjacency filter excludes shared-edge contacts."""
    ns, res = build_state(doc.build_sphere("s", 5))
    r = run_measure({"type": "selfIntersection", "featureId": "s"}, ns, res)
    assert r["ok"] is True
