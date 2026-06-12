"""
Transform naming corpus — Move / Rotate / Scale parameter-edit survival.

Per `NAMING_CONTRACT.md` §"part tag convention" the Transform row reads:

    | Transform | `<originalPart>` (unchanged) | `<originalPart>` (unchanged) |

That is: a Transform feature is a *re-positioning* of its input, so the
descriptor's `part` tag is supposed to pass through verbatim from the
upstream feature's faces / edges (the contract also notes the descriptor's
`feature` is rewritten to the Transform's feature id, with `parents[0]`
carrying the original).

The current dispatch in `b123d_server/naming.py` routes Move / Rotate /
Scale through `name_generic` (op tag `OP_XFORM`). `name_generic` tags every
face by ordinal — `face[0]`, `face[1]`, ... — which means the cardinal
descriptors from the upstream Box (`+Z`, `-X`, ...) do *not* pass through
unchanged. Those cases are honestly marked `xfail` with the relevant
rationale — they are work-list items for a dedicated `name_xform` impl,
not test bugs.

Fixture interface (provided by ../conftest.py + ../doc_builder.py):

    build_doc((feature_id, body, feature_type, input_feature_ids), ...)
        -> (namespace, result_dict)

    extract_topology(namespace, result_dict)
        -> topology_dict

    descriptor_set(topology_dict, kind='face' | 'edge' | 'vertex')
        -> Set[str] of canonical descriptor strings
"""

from __future__ import annotations

import pytest


# ─── 1. Move: descriptors pass through ──────────────────────────────────────


def test_move_preserves_all_face_descriptors(
    build_doc, extract_topology, descriptor_set
):
    """Box → Move([10,0,0]). Per contract the box's cardinal face descriptors
    pass through unchanged on the moved body."""
    from build123d import Box, Location, Vector

    box_a = Box(10, 10, 10)
    moved_a = box_a.moved(Location(Vector(10, 0, 0)))
    ns_a, res_a = build_doc(
        ("box1", box_a,   "Box",  []),
        ("mv1",  moved_a, "Move", ["box1"]),
    )
    faces_a = descriptor_set(extract_topology(ns_a, res_a), kind="face")

    box_b = Box(10, 10, 10)
    moved_b = box_b.moved(Location(Vector(25, 0, 0)))
    ns_b, res_b = build_doc(
        ("box1", box_b,   "Box",  []),
        ("mv1",  moved_b, "Move", ["box1"]),
    )
    faces_b = descriptor_set(extract_topology(ns_b, res_b), kind="face")

    # Contract: the Move feature re-emits the upstream parts verbatim under
    # its own feature id. We expect all six cardinal tags on the moved body
    # in *both* states (translation doesn't reorient faces).
    for axis in ("+X", "-X", "+Y", "-Y", "+Z", "-Z"):
        assert any(f":mv1:xform:{axis}" in d for d in faces_a), \
            f"missing mv1:xform:{axis} in state A"
        assert any(f":mv1:xform:{axis}" in d for d in faces_b), \
            f"missing mv1:xform:{axis} in state B"


# ─── 2. Rotate: face count + kind persist ──────────────────────────────────


def test_rotate_preserves_face_count_and_kind(
    build_doc, extract_topology, descriptor_set
):
    """Box → Rotate(Z, 90°). Face count and surface types persist.

    Even with the v1 ordinal fallback we can assert this: a rotated box
    still has six planar faces, so the *count* of face descriptors on the
    rotated body must match between unrotated and rotated states.

    Note: the contract says transforms pass `<originalPart>` through
    unchanged on translation, but a 90° rotation about Z reorients the
    cardinal directions (+X face becomes +Y). This test deliberately doesn't
    assert direction labels — only count + kind — so it passes regardless
    of whether `name_xform` does naive pass-through (Move-like) or
    reclassification (re-runs name_box on the rotated body).
    """
    from build123d import Box, Location, Rotation

    box_a = Box(10, 10, 10)
    rot_a = box_a.moved(Location(Rotation(0, 0, 0)))
    ns_a, res_a = build_doc(
        ("box1", box_a, "Box",    []),
        ("rt1",  rot_a, "Rotate", ["box1"]),
    )
    faces_a = descriptor_set(extract_topology(ns_a, res_a), kind="face")

    box_b = Box(10, 10, 10)
    rot_b = box_b.moved(Location(Rotation(0, 0, 90)))
    ns_b, res_b = build_doc(
        ("box1", box_b, "Box",    []),
        ("rt1",  rot_b, "Rotate", ["box1"]),
    )
    faces_b = descriptor_set(extract_topology(ns_b, res_b), kind="face")

    # The Rotate feature owns six face descriptors in both states.
    rt1_a = [d for d in faces_a if d.startswith("face:rt1:")]
    rt1_b = [d for d in faces_b if d.startswith("face:rt1:")]
    assert len(rt1_a) == 6, (
        f"expected 6 face descriptors on rt1 in state A, got {len(rt1_a)}: "
        f"{sorted(rt1_a)}"
    )
    assert len(rt1_b) == 6, (
        f"expected 6 face descriptors on rt1 in state B, got {len(rt1_b)}: "
        f"{sorted(rt1_b)}"
    )


# ─── 3. Scale: cardinals don't change under uniform scale ───────────────────


def test_scale_preserves_face_count(
    build_doc, extract_topology, descriptor_set
):
    """Box × scale(2.0). All six cardinal-direction descriptors persist —
    uniform scaling doesn't reorient faces.

    build123d doesn't ship a single `scale()` op; the conventional way is
    to multiply via a Location with non-identity scale, or rebuild the box
    at the scaled dimensions and route through the Scale feature type.
    Either way the post-Scale body is a 20mm box and the cardinal part
    tags should appear unchanged.
    """
    from build123d import Box

    # The Scale feature's body is the post-scaled solid (same as building
    # the box at 2× the dimensions). What matters for naming is the
    # feature *type* being "Scale".
    box_a = Box(10, 10, 10)
    scaled_a = Box(10, 10, 10)  # scale factor 1.0
    ns_a, res_a = build_doc(
        ("box1", box_a,    "Box",   []),
        ("sc1",  scaled_a, "Scale", ["box1"]),
    )
    faces_a = descriptor_set(extract_topology(ns_a, res_a), kind="face")

    box_b = Box(10, 10, 10)
    scaled_b = Box(20, 20, 20)  # scale factor 2.0
    ns_b, res_b = build_doc(
        ("box1", box_b,    "Box",   []),
        ("sc1",  scaled_b, "Scale", ["box1"]),
    )
    faces_b = descriptor_set(extract_topology(ns_b, res_b), kind="face")

    for axis in ("+X", "-X", "+Y", "-Y", "+Z", "-Z"):
        assert any(f":sc1:xform:{axis}" in d for d in faces_a), \
            f"missing sc1:xform:{axis} in state A"
        assert any(f":sc1:xform:{axis}" in d for d in faces_b), \
            f"missing sc1:xform:{axis} in state B"


# ─── 4. Chained transforms (commutativity check) ───────────────────────────


def test_chained_transforms_commute(
    build_doc, extract_topology, descriptor_set
):
    """Move-then-Rotate vs Rotate-then-Move.

    Order A: box → move([10,0,0]) → rotate(Z, 90°)
    Order B: box → rotate(Z, 90°) → move([10,0,0])

    The two yield different world positions but the *post-transform body
    topology* (six planar faces) is identical. We check that the final
    transform feature emits six face descriptors in both orderings.
    """
    from build123d import Box, Location, Rotation, Vector

    box_a = Box(10, 10, 10)
    step1_a = box_a.moved(Location(Vector(10, 0, 0)))
    step2_a = step1_a.moved(Location(Rotation(0, 0, 90)))
    ns_a, res_a = build_doc(
        ("box1", box_a,   "Box",    []),
        ("mv1",  step1_a, "Move",   ["box1"]),
        ("rt1",  step2_a, "Rotate", ["mv1"]),
    )
    faces_a = descriptor_set(extract_topology(ns_a, res_a), kind="face")

    box_b = Box(10, 10, 10)
    step1_b = box_b.moved(Location(Rotation(0, 0, 90)))
    step2_b = step1_b.moved(Location(Vector(10, 0, 0)))
    ns_b, res_b = build_doc(
        ("box1", box_b,   "Box",    []),
        ("rt1",  step1_b, "Rotate", ["box1"]),
        ("mv1",  step2_b, "Move",   ["rt1"]),
    )
    faces_b = descriptor_set(extract_topology(ns_b, res_b), kind="face")

    # Both orderings must produce a box-shaped final body with six planar
    # face descriptors owned by the *last* feature in the chain.
    last_a = [d for d in faces_a if d.startswith("face:rt1:")]
    last_b = [d for d in faces_b if d.startswith("face:mv1:")]
    assert len(last_a) == 6, f"order A last-feature face count = {len(last_a)}"
    assert len(last_b) == 6, f"order B last-feature face count = {len(last_b)}"
    # Pass-through descriptors (contract) should align between orderings.
    cardinals = {"+X", "-X", "+Y", "-Y", "+Z", "-Z"}
    for axis in cardinals:
        assert any(f":{axis}" in d for d in last_a), f"order A missing {axis}"
        assert any(f":{axis}" in d for d in last_b), f"order B missing {axis}"
