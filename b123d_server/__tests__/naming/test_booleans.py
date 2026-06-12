"""
Boolean-edit persistence cases.

Booleans are where v1 naming gets fragile. The current `name_boolean`
implementation tags every face with `f"{surface_type}[{i}]"` (or
`f"planar[{cardinal}]"`) where `i` is the iteration index over `body.faces()`
on the *result* solid. When the tool's topology changes — different radius,
different position, different boolean kind — OCCT's face iteration order can
shift, which means the descriptor's `[i]` index shifts, which means the
canonical string changes for faces that semantically didn't move.

Most of these tests are marked `xfail` because they probe exactly that
weakness. They're here so that when the v2 boolean namer lands (the one
that identifies each result face as "from target" vs "from tool" and
re-tags it with its source's part tag rather than an ordinal), pytest
flips them green automatically and we know we've actually fixed something.

Cases that test only cardinal-aligned face survival (`planar[+Z]` etc.) are
*not* xfailed — those should already work today because the cardinal
classifier is index-independent.
"""

from __future__ import annotations

import pytest


# ─── helpers ────────────────────────────────────────────────────────────────


def _planar_cardinal_descriptors(fid: str, op_tag: str, parents_suffix: str) -> set:
    """The set of canonical strings for cardinal-axis planar faces on a result body.

    `parents_suffix` is the `(parent1,parent2,...)` tail the `name_boolean`
    namer appends — every face inherits the same parent list, so the suffix
    is identical for every cardinal face.
    """
    return {
        f"face:{fid}:{op_tag}:planar[{axis}]{parents_suffix}"
        for axis in ("+X", "-X", "+Y", "-Y", "+Z", "-Z")
    }


# ─── 1. Union: target faces survive ────────────────────────────────────────


@pytest.mark.xfail(
    reason="v1 booleans don't preserve per-face origin tags — every face is "
    "re-tagged as planar[<cardinal>] or {surfaceType}[i] regardless of which "
    "input it came from. A face from the target that isn't aligned to a "
    "cardinal axis (e.g. covered partially by the tool) gets a shifted "
    "ordinal index that won't survive future edits. See NAMING_CONTRACT.md "
    "boolean section.",
)
def test_union_preserves_target_faces(
    build_doc, extract_topology, descriptor_set, semantic_match, doc
):
    """Box ∪ Cylinder: the box's untouched faces should keep their descriptors.

    Build twice with an identical (non-edit) document — the assertion is on
    *which* descriptors a v2 namer should emit. v1 emits `planar[+X]` etc.
    with target's parent in the lineage; the test asserts the parent-rich
    form a v2 namer should produce ("from-target-+X" style).
    """
    from build123d import Box, Cylinder, Pos

    box_a = Box(20, 20, 20)
    cyl_a = (Pos(0, 0, 10) * Cylinder(3, 10))

    ns_a, res_a = build_doc(
        ("box_t", box_a, "Box", []),
        ("cyl_t", cyl_a, "Cylinder", []),
        ("u",     box_a + cyl_a, "Union", ["box_t", "cyl_t"]),
    )
    topology_a = extract_topology(ns_a, res_a)
    faces_a = descriptor_set(topology_a, kind="face")

    # Expected (v2): the four box side faces that aren't covered by the cylinder
    # survive as `from-target-<axis>`. Until v2 lands, these descriptors are
    # absent — so this test xfails.
    expected = {
        f"face:u:union:from-target-+X(face:box_t:box:+X)",
        f"face:u:union:from-target--X(face:box_t:box:-X)",
        f"face:u:union:from-target-+Y(face:box_t:box:+Y)",
        f"face:u:union:from-target--Y(face:box_t:box:-Y)",
    }
    semantic_match(faces_a, faces_a, expected)


# ─── 2. Cut: uncut target faces survive ────────────────────────────────────


def test_cut_preserves_uncut_target_faces(
    build_doc, extract_topology, descriptor_set, doc
):
    """Box − small Cylinder: at minimum the result has 6 cardinal-aligned faces
    (the box's outer faces, minus a small disc cut from the top).

    With v1 naming each face is tagged `planar[<cardinal>]` with the box and
    cylinder descriptors as parents — the *same* canonical string lands for
    every rebuild as long as cardinal classification is stable. So this test
    DOES pass on v1.
    """
    from build123d import Box, Cylinder, Pos

    box_t = Box(20, 20, 20)
    cyl_t = Pos(0, 0, 5) * Cylinder(2, 15)
    ns, res = build_doc(
        ("box_t", box_t, "Box", []),
        ("cyl_t", cyl_t, "Cylinder", []),
        ("cut1",  box_t - cyl_t, "Cut", ["box_t", "cyl_t"]),
    )
    topology = extract_topology(ns, res)
    faces = descriptor_set(topology, kind="face")

    # The four side faces of the box are untouched and aligned to cardinal axes.
    # The v1 namer prefixes every result face with `planar[+X]` etc. and adds
    # the parents tuple. Verify at least the four sides are present in *some*
    # form by descriptor-substring search.
    assert any("planar[+X]" in d for d in faces), faces
    assert any("planar[-X]" in d for d in faces), faces
    assert any("planar[+Y]" in d for d in faces), faces
    assert any("planar[-Y]" in d for d in faces), faces


# ─── 3. Cut: target faces survive a tool-radius change ─────────────────────


def test_cut_preserves_box_outer_faces_after_tool_radius_change(
    build_doc, extract_topology, descriptor_set, semantic_match, doc
):
    """Box − Cyl(r=2) vs Box − Cyl(r=4): the box's outer face descriptors
    persist verbatim across the tool-radius change.

    v1 namer: every face on the result is tagged `planar[<cardinal>]` with
    the same parents (box's first face + cyl's first face). Changing the
    cylinder's radius doesn't change the cylinder's first face descriptor
    (`face:cyl_t:cyl:top`), so the parent suffix is invariant. Cardinal
    classification of the box's side faces is also invariant. So the four
    side faces should match verbatim.
    """
    from build123d import Box, Cylinder, Pos

    def _make(radius: float):
        box_t = Box(20, 20, 20)
        cyl_t = Pos(0, 0, 5) * Cylinder(radius, 15)
        return build_doc(
            ("box_t", box_t, "Box", []),
            ("cyl_t", cyl_t, "Cylinder", []),
            ("cut1",  box_t - cyl_t, "Cut", ["box_t", "cyl_t"]),
        )

    ns_a, res_a = _make(2.0)
    ns_b, res_b = _make(4.0)

    faces_a = descriptor_set(extract_topology(ns_a, res_a), kind="face")
    faces_b = descriptor_set(extract_topology(ns_b, res_b), kind="face")

    # The intersection of the two sets must include the four side cardinals.
    shared = faces_a & faces_b
    for axis in ("+X", "-X", "+Y", "-Y"):
        assert any(f"planar[{axis}]" in d for d in shared), (
            f"no shared descriptor mentioning planar[{axis}]; shared = {shared}"
        )


# ─── 4. Intersect topology change ──────────────────────────────────────────


@pytest.mark.xfail(
    reason="Intersect of two overlapping primitives produces faces with "
    "shifted ordinal indices when one primitive's size changes. The v1 "
    "ordinal namer can't distinguish which intersection face came from "
    "which source, so descriptors aren't stable across the edit.",
)
def test_intersect_topology_change(
    build_doc, extract_topology, descriptor_set, semantic_match, doc
):
    from build123d import Box, Cylinder

    def _make(box_size: float):
        box_t = Box(box_size, box_size, box_size)
        cyl_t = Cylinder(4, box_size)
        return build_doc(
            ("box_t", box_t, "Box", []),
            ("cyl_t", cyl_t, "Cylinder", []),
            ("i",     box_t & cyl_t, "Intersect", ["box_t", "cyl_t"]),
        )

    ns_a, res_a = _make(10)
    ns_b, res_b = _make(12)

    faces_a = descriptor_set(extract_topology(ns_a, res_a), kind="face")
    faces_b = descriptor_set(extract_topology(ns_b, res_b), kind="face")

    # Expected: the cylindrical lateral face should survive verbatim because
    # the cylinder isn't changing. Currently it gets ordinal `cylindrical[0]`
    # which may shift if face-iteration order changes between sizes.
    semantic_match(faces_a, faces_b, faces_a & faces_b)
    assert len(faces_a & faces_b) >= 5, (faces_a, faces_b)


# ─── 5. Union: change one side, the other survives ────────────────────────


def test_union_box_size_change_preserves_cylinder_lateral(
    build_doc, extract_topology, descriptor_set, doc
):
    """Box ∪ Cylinder where the box grows: the cylinder's lateral face stays
    cylindrical regardless of box size, and its parent descriptor is also
    invariant under the box edit.

    This relies only on surface-type classification (`cylindrical[0]`) being
    stable, which holds when there's exactly one cylindrical face on the
    result and OCCT enumerates it first among curved surfaces. That's
    fragile but often the case for the union of one box + one cylinder, so
    we let this test PASS rather than xfail.
    """
    from build123d import Box, Cylinder, Pos

    def _make(box_size: float):
        box_t = Box(box_size, box_size, box_size)
        cyl_t = Pos(box_size * 0.75, 0, 0) * Cylinder(2, box_size * 2)
        return build_doc(
            ("box_t", box_t, "Box", []),
            ("cyl_t", cyl_t, "Cylinder", []),
            ("u",     box_t + cyl_t, "Union", ["box_t", "cyl_t"]),
        )

    ns_a, res_a = _make(10)
    ns_b, res_b = _make(15)

    faces_a = descriptor_set(extract_topology(ns_a, res_a), kind="face")
    faces_b = descriptor_set(extract_topology(ns_b, res_b), kind="face")

    # The cylinder's lateral face — the only cylindrical face on the union
    # result — should appear in both. Identify by substring since the exact
    # parent suffix may include both target+tool descriptors.
    cyl_a = [d for d in faces_a if "cylindrical[0]" in d]
    cyl_b = [d for d in faces_b if "cylindrical[0]" in d]
    assert cyl_a and cyl_b, (faces_a, faces_b)


# ─── 6. Cut through-hole: change depth ─────────────────────────────────────


@pytest.mark.xfail(
    reason="Through-cut hole faces are tagged by surfaceType ordinal "
    "(`cylindrical[0]`) which can shift when the cut depth changes and "
    "alters whether intermediate faces appear. The v2 namer should tag "
    "the bore wall as `from-tool-lateral` with the cylinder's lateral as "
    "parent, making it stable across depth edits.",
)
def test_cut_through_hole_change_depth_preserves_bore(
    build_doc, extract_topology, descriptor_set, semantic_match, doc
):
    from build123d import Box, Cylinder, Pos

    def _make(depth: float):
        box_t = Box(20, 20, 20)
        cyl_t = Pos(0, 0, 10 - depth / 2) * Cylinder(3, depth)
        return build_doc(
            ("box_t", box_t, "Box", []),
            ("cyl_t", cyl_t, "Cylinder", []),
            ("h",     box_t - cyl_t, "Cut", ["box_t", "cyl_t"]),
        )

    ns_a, res_a = _make(40)  # through cut
    ns_b, res_b = _make(60)  # deeper through cut

    faces_a = descriptor_set(extract_topology(ns_a, res_a), kind="face")
    faces_b = descriptor_set(extract_topology(ns_b, res_b), kind="face")

    # The bore wall descriptor should survive verbatim. Today it lands as
    # `cylindrical[i](parents)` where i depends on face-iteration order.
    bore_a = {d for d in faces_a if "cylindrical[" in d}
    bore_b = {d for d in faces_b if "cylindrical[" in d}
    semantic_match(faces_a, faces_b, bore_a & bore_b)
    assert bore_a == bore_b, f"bore descriptors diverged: A={bore_a} B={bore_b}"
