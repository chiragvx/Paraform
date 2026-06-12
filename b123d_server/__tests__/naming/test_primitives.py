"""
Primitive-edit persistence cases.

These are the easy ones: changing a primitive's size doesn't change the
*kind* or *direction* of any of its faces, so every face descriptor — which
is keyed on direction (`+Z`, `-X`, ...) or surface type (`lateral`,
`surface`, `tube`) — should survive byte-for-byte across the edit.

If any of these fail, the kernel's primitive namers are non-deterministic
under parameter change and the entire descriptor scheme is broken at the
foundation. That's a different bug than the boolean-naming churn the v1
booleans are known to have.
"""

from __future__ import annotations

import pytest


# ─── Helper: the set of cardinal face descriptors a Box should produce ─────


def _box_faces(fid: str) -> set:
    return {f"face:{fid}:box:{p}" for p in ("+X", "-X", "+Y", "-Y", "+Z", "-Z")}


def _cylinder_faces(fid: str) -> set:
    # Axis-aligned cylinder (default): top=+Z planar, bottom=-Z planar, lateral=cylindrical.
    return {
        f"face:{fid}:cyl:top",
        f"face:{fid}:cyl:bottom",
        f"face:{fid}:cyl:lateral",
    }


def _sphere_faces(fid: str) -> set:
    return {f"face:{fid}:sphere:surface"}


def _torus_faces(fid: str) -> set:
    return {f"face:{fid}:torus:tube"}


# ─── Box ────────────────────────────────────────────────────────────────────


def test_box_dimension_change_preserves_all_faces(
    build_doc, extract_topology, descriptor_set, semantic_match, doc
):
    """Box(10,10,10) → Box(20,10,10). All 6 cardinal face descriptors persist."""
    ns_a, res_a = build_doc(doc.build_box("box_x", 10, 10, 10))
    faces_a = descriptor_set(extract_topology(ns_a, res_a), kind="face")

    ns_b, res_b = build_doc(doc.build_box("box_x", 20, 10, 10))
    faces_b = descriptor_set(extract_topology(ns_b, res_b), kind="face")

    expected = _box_faces("box_x")
    semantic_match(faces_a, faces_b, expected)


def test_box_height_change_preserves_faces(
    build_doc, extract_topology, descriptor_set, semantic_match, doc
):
    """Box(10,10,10) → Box(10,10,25). Cardinal directions don't change."""
    ns_a, res_a = build_doc(doc.build_box("b", 10, 10, 10))
    ns_b, res_b = build_doc(doc.build_box("b", 10, 10, 25))

    faces_a = descriptor_set(extract_topology(ns_a, res_a), kind="face")
    faces_b = descriptor_set(extract_topology(ns_b, res_b), kind="face")

    semantic_match(faces_a, faces_b, _box_faces("b"))


def test_box_uniform_scale_change_preserves_faces(
    build_doc, extract_topology, descriptor_set, semantic_match, doc
):
    """Box(5,5,5) → Box(15,15,15). All three dims change at once."""
    ns_a, res_a = build_doc(doc.build_box("c", 5, 5, 5))
    ns_b, res_b = build_doc(doc.build_box("c", 15, 15, 15))

    faces_a = descriptor_set(extract_topology(ns_a, res_a), kind="face")
    faces_b = descriptor_set(extract_topology(ns_b, res_b), kind="face")

    semantic_match(faces_a, faces_b, _box_faces("c"))


# ─── Cylinder ───────────────────────────────────────────────────────────────


def test_cylinder_radius_change_preserves_faces(
    build_doc, extract_topology, descriptor_set, semantic_match, doc
):
    """Cylinder(5,10) → Cylinder(8,10). top/bottom/lateral all persist."""
    ns_a, res_a = build_doc(doc.build_cylinder("c", 5, 10))
    ns_b, res_b = build_doc(doc.build_cylinder("c", 8, 10))

    faces_a = descriptor_set(extract_topology(ns_a, res_a), kind="face")
    faces_b = descriptor_set(extract_topology(ns_b, res_b), kind="face")

    semantic_match(faces_a, faces_b, _cylinder_faces("c"))


def test_cylinder_height_change_preserves_faces(
    build_doc, extract_topology, descriptor_set, semantic_match, doc
):
    """Cylinder(5,10) → Cylinder(5,30). Caps slide along Z, tags unchanged."""
    ns_a, res_a = build_doc(doc.build_cylinder("cyl_h", 5, 10))
    ns_b, res_b = build_doc(doc.build_cylinder("cyl_h", 5, 30))

    faces_a = descriptor_set(extract_topology(ns_a, res_a), kind="face")
    faces_b = descriptor_set(extract_topology(ns_b, res_b), kind="face")

    semantic_match(faces_a, faces_b, _cylinder_faces("cyl_h"))


# ─── Sphere ─────────────────────────────────────────────────────────────────


def test_sphere_radius_change_preserves_face(
    build_doc, extract_topology, descriptor_set, semantic_match, doc
):
    """Sphere(5) → Sphere(12). The single 'surface' face descriptor persists."""
    ns_a, res_a = build_doc(doc.build_sphere("sph", 5))
    ns_b, res_b = build_doc(doc.build_sphere("sph", 12))

    faces_a = descriptor_set(extract_topology(ns_a, res_a), kind="face")
    faces_b = descriptor_set(extract_topology(ns_b, res_b), kind="face")

    semantic_match(faces_a, faces_b, _sphere_faces("sph"))


# ─── Torus ──────────────────────────────────────────────────────────────────


def test_torus_minor_radius_change_preserves_face(
    build_doc, extract_topology, descriptor_set, semantic_match, doc
):
    """Torus(10,2) → Torus(10,3). 'tube' descriptor persists."""
    ns_a, res_a = build_doc(doc.build_torus("tor", 10, 2))
    ns_b, res_b = build_doc(doc.build_torus("tor", 10, 3))

    faces_a = descriptor_set(extract_topology(ns_a, res_a), kind="face")
    faces_b = descriptor_set(extract_topology(ns_b, res_b), kind="face")

    semantic_match(faces_a, faces_b, _torus_faces("tor"))


def test_torus_major_radius_change_preserves_face(
    build_doc, extract_topology, descriptor_set, semantic_match, doc
):
    """Torus(10,2) → Torus(15,2). The single 'tube' face survives."""
    ns_a, res_a = build_doc(doc.build_torus("tor2", 10, 2))
    ns_b, res_b = build_doc(doc.build_torus("tor2", 15, 2))

    faces_a = descriptor_set(extract_topology(ns_a, res_a), kind="face")
    faces_b = descriptor_set(extract_topology(ns_b, res_b), kind="face")

    semantic_match(faces_a, faces_b, _torus_faces("tor2"))
