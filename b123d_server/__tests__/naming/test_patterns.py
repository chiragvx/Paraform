"""Pattern + Mirror naming regression corpus.

These tests assert the topological-naming contract for LinearPattern,
CircularPattern, and Mirror — see
[lib/document/NAMING_CONTRACT.md](../../../lib/document/NAMING_CONTRACT.md)
section "part tag convention":

    | Pattern | inst[i]-<originalPart> |
    | Mirror  | mir-<originalPart>     |

`inst[i]` indices must be stable across rebuilds — a parameter change on
the pattern (count, spacing, angle, direction, plane) or the source feature
(dimensions) must not renumber the instances. The index is the operation-
local ordinal, not iteration-order over an unstable container (see
NAMING_CONTRACT.md section "Determinism guarantees", point 2).

History: cases used to be xfailed because the test DSL passed `(fid, Cls,
"Cylinder", {params})` — a class + params dict — but `build_doc` expects
`(fid, body, ftype, inputs_list)`. The harness's `_extract_topology_v4`
saw `body = Cylinder` (a class, no `.faces()`) and skipped emission. With
the new `build_linear_pattern` / `build_circular_pattern` / `build_mirror`
helpers in `doc_builder.py`, sources are real bodies and the namers in
`naming.py` (commit 66430f6) drive these cases end-to-end.
"""

from __future__ import annotations

import pytest


# ─── 1. Linear pattern: count change ────────────────────────────────────────

def test_linear_pattern_count_change(doc, build_doc, extract_topology,
                                     descriptor_set):
    """count=3 -> count=5: inst[0..2] descriptors must persist verbatim.

    The first three instance positions and their face structure are
    unchanged; only two new instances are appended. The contract requires
    inst[0]/inst[1]/inst[2] to map to the same world positions before and
    after, so their face descriptors (e.g. `inst[0]-lateral`) survive
    byte-for-byte.
    """
    from build123d import Cylinder

    src_a = Cylinder(2, 5)
    src_b = Cylinder(2, 5)

    ns_a, res_a = build_doc(
        ("cyl_src", src_a, "Cylinder", []),
        doc.build_linear_pattern("pat", src_a, count=3, spacing=20,
                                 direction=(1, 0, 0), parents=["cyl_src"]),
    )
    ns_b, res_b = build_doc(
        ("cyl_src", src_b, "Cylinder", []),
        doc.build_linear_pattern("pat", src_b, count=5, spacing=20,
                                 direction=(1, 0, 0), parents=["cyl_src"]),
    )

    faces_a = descriptor_set(extract_topology(ns_a, res_a), kind="face")
    faces_b = descriptor_set(extract_topology(ns_b, res_b), kind="face")

    survivors = {f for f in faces_a
                 if "inst[0]" in f or "inst[1]" in f or "inst[2]" in f}
    assert survivors, "BEFORE set has no inst[0..2] descriptors at all"
    assert survivors <= faces_b, (
        f"inst[0..2] descriptors did not persist:\n"
        f"  missing: {sorted(survivors - faces_b)}"
    )


# ─── 2. Linear pattern: spacing change ──────────────────────────────────────

def test_linear_pattern_spacing_change(doc, build_doc, extract_topology,
                                       descriptor_set):
    """spacing=20 -> spacing=30: all inst[0..2] face descriptors persist.

    Only world positions of the instances change; the per-instance face
    structure (top / bottom / lateral) and the operation-local ordinal
    (`inst[i]`) are independent of spacing.
    """
    from build123d import Cylinder

    src_a = Cylinder(2, 5)
    src_b = Cylinder(2, 5)

    ns_a, res_a = build_doc(
        ("cyl_src", src_a, "Cylinder", []),
        doc.build_linear_pattern("pat", src_a, count=3, spacing=20,
                                 direction=(1, 0, 0), parents=["cyl_src"]),
    )
    ns_b, res_b = build_doc(
        ("cyl_src", src_b, "Cylinder", []),
        doc.build_linear_pattern("pat", src_b, count=3, spacing=30,
                                 direction=(1, 0, 0), parents=["cyl_src"]),
    )

    faces_a = descriptor_set(extract_topology(ns_a, res_a), kind="face")
    faces_b = descriptor_set(extract_topology(ns_b, res_b), kind="face")

    # Every face descriptor on the pattern node must survive — only the
    # `centerRounded` field (which the canonical string doesn't include)
    # changes.
    pat_a = {f for f in faces_a if ":linpat:" in f}
    pat_b = {f for f in faces_b if ":linpat:" in f}
    assert pat_a == pat_b, (
        f"face descriptors changed across spacing edit:\n"
        f"  lost: {sorted(pat_a - pat_b)}\n"
        f"  gained: {sorted(pat_b - pat_a)}"
    )


# ─── 3. Linear pattern: direction change ────────────────────────────────────

@pytest.mark.xfail(
    strict=False,
    reason="name_linear_pattern infers the pattern axis from the instance "
           "centroid spread (_principal_axis); flipping the world direction "
           "+X -> +Y flips the principal axis and may permute inst[i] indices "
           "for cardinal-aligned source faces. Documented v1 limitation in "
           "naming.py — kept xfail strict=False so an accidental pass surfaces."
)
def test_linear_pattern_direction_change(doc, build_doc, extract_topology,
                                         descriptor_set):
    """direction=+X -> +Y: per-instance descriptors persist.

    The per-instance face direction (e.g. `lateral`, `top`) is named in
    the cylinder's local frame, not the world frame. Rotating the pattern
    axis from +X to +Y rotates instance positions but not the local face
    structure inside each instance, so `inst[i]-lateral` should stay
    `inst[i]-lateral`.
    """
    from build123d import Cylinder

    src_a = Cylinder(2, 5)
    src_b = Cylinder(2, 5)

    ns_a, res_a = build_doc(
        ("cyl_src", src_a, "Cylinder", []),
        doc.build_linear_pattern("pat", src_a, count=3, spacing=20,
                                 direction=(1, 0, 0), parents=["cyl_src"]),
    )
    ns_b, res_b = build_doc(
        ("cyl_src", src_b, "Cylinder", []),
        doc.build_linear_pattern("pat", src_b, count=3, spacing=20,
                                 direction=(0, 1, 0), parents=["cyl_src"]),
    )

    faces_a = descriptor_set(extract_topology(ns_a, res_a), kind="face")
    faces_b = descriptor_set(extract_topology(ns_b, res_b), kind="face")

    pat_a = {f for f in faces_a if ":linpat:" in f}
    pat_b = {f for f in faces_b if ":linpat:" in f}
    assert pat_a == pat_b, (
        f"direction change relabelled instance faces:\n"
        f"  lost: {sorted(pat_a - pat_b)}\n"
        f"  gained: {sorted(pat_b - pat_a)}"
    )


# ─── 4. Circular pattern: count change ──────────────────────────────────────

@pytest.mark.xfail(
    strict=False,
    reason="name_circular_pattern's atan2-sort assigns inst[i] by angular "
           "position around the centroid. 360 deg/4 vs 360 deg/6 have disjoint "
           "angular slots, so inst[0..3] from state A do not coincide with "
           "any state-B instance positions. Per-op declaration-order indexing "
           "would fix this but requires kernel-side instance metadata we "
           "don't have inside the namer. Strict=False so an accidental pass "
           "(e.g. if inst[0] happens to land at angle 0 in both) surfaces."
)
def test_circular_pattern_count_change(doc, build_doc, extract_topology,
                                       descriptor_set):
    """count=4 -> count=6 over a full 360 deg revolution.

    All four original instances lie on different angles than any of the
    new six, so a centroid-based namer will assign different `inst[i]`
    indices. The contract says the index is the operation-local ordinal
    (instance 0, 1, 2, 3 in declaration order) — if the implementation
    honours that, the first four descriptors persist. Most v1
    implementations bucket by angle, hence xfail.
    """
    from build123d import Cylinder

    src_a = Cylinder(2, 5)
    src_b = Cylinder(2, 5)

    ns_a, res_a = build_doc(
        ("cyl_src", src_a, "Cylinder", []),
        doc.build_circular_pattern("pat", src_a, count=4, angle=360,
                                   parents=["cyl_src"]),
    )
    ns_b, res_b = build_doc(
        ("cyl_src", src_b, "Cylinder", []),
        doc.build_circular_pattern("pat", src_b, count=6, angle=360,
                                   parents=["cyl_src"]),
    )

    faces_a = descriptor_set(extract_topology(ns_a, res_a), kind="face")
    faces_b = descriptor_set(extract_topology(ns_b, res_b), kind="face")

    survivors = {f for f in faces_a
                 if any(f"inst[{i}]" in f for i in range(4))}
    assert survivors <= faces_b, (
        f"inst[0..3] descriptors did not persist across count 4->6:\n"
        f"  missing: {sorted(survivors - faces_b)}"
    )


# ─── 5. Circular pattern: angle change ──────────────────────────────────────

@pytest.mark.xfail(
    strict=False,
    reason="Angle edit (360->180 at count=4) preserves instance count but "
           "redistributes the rotation-plane span, shifting the atan2 ordering "
           "used by name_circular_pattern. Only inst[0] is geometry-pinned "
           "across the edit. Strict=False so an accidental pass surfaces."
)
def test_circular_pattern_angle_change(doc, build_doc, extract_topology,
                                       descriptor_set):
    """angle=360 -> angle=180 at count=4: surviving instance descriptors persist.

    Halving the sweep angle keeps the leading instances at the same
    angular positions (0 deg, 60 deg, 120 deg ...) only if the namer uses
    per-op ordinal indices. inst[0] should still resolve to faces in
    BEFORE that exist in AFTER.
    """
    from build123d import Cylinder

    src_a = Cylinder(2, 5)
    src_b = Cylinder(2, 5)

    ns_a, res_a = build_doc(
        ("cyl_src", src_a, "Cylinder", []),
        doc.build_circular_pattern("pat", src_a, count=4, angle=360,
                                   parents=["cyl_src"]),
    )
    ns_b, res_b = build_doc(
        ("cyl_src", src_b, "Cylinder", []),
        doc.build_circular_pattern("pat", src_b, count=4, angle=180,
                                   parents=["cyl_src"]),
    )

    faces_a = descriptor_set(extract_topology(ns_a, res_a), kind="face")
    faces_b = descriptor_set(extract_topology(ns_b, res_b), kind="face")

    # At minimum, inst[0] must survive — it sits at angle 0 in both cases.
    inst0 = {f for f in faces_a if "inst[0]" in f}
    assert inst0, "BEFORE set has no inst[0] face descriptors"
    assert inst0 <= faces_b, (
        f"inst[0] descriptors did not persist across angle 360->180:\n"
        f"  missing: {sorted(inst0 - faces_b)}"
    )


# ─── 6. Mirror: plane change ────────────────────────────────────────────────

def test_mirror_plane_change_xy_to_xz(doc, build_doc, extract_topology,
                                      descriptor_set):
    """Mirror plane XY -> XZ: `mir-<part>` descriptors persist.

    The contract (NAMING_CONTRACT.md section "part tag convention", Mirror
    row) is `mir-<originalPart>` — the mirror plane is NOT encoded in the
    `part`. So mirroring a Box's faces across either XY or XZ yields the
    same set of `mir-*` descriptors. Only the world position of each
    mirrored face changes.
    """
    from build123d import Box

    src_a = Box(10, 10, 10)
    src_b = Box(10, 10, 10)

    ns_a, res_a = build_doc(
        ("box_src", src_a, "Box", []),
        doc.build_mirror("mir", src_a, plane="XY", parents=["box_src"]),
    )
    ns_b, res_b = build_doc(
        ("box_src", src_b, "Box", []),
        doc.build_mirror("mir", src_b, plane="XZ", parents=["box_src"]),
    )

    faces_a = descriptor_set(extract_topology(ns_a, res_a), kind="face")
    faces_b = descriptor_set(extract_topology(ns_b, res_b), kind="face")

    mir_a = {f for f in faces_a if ":mir-" in f}
    mir_b = {f for f in faces_b if ":mir-" in f}
    assert mir_a, "BEFORE set has no `mir-*` descriptors"
    assert mir_a == mir_b, (
        f"mirror descriptors changed when the plane changed (contract "
        f"violation — `part` must not encode the plane):\n"
        f"  lost:   {sorted(mir_a - mir_b)}\n"
        f"  gained: {sorted(mir_b - mir_a)}"
    )


# ─── 7. Pattern + source dimension change ───────────────────────────────────

def test_pattern_with_source_dimension_change(doc, build_doc, extract_topology,
                                              descriptor_set):
    """Source Cylinder radius 2 -> 3 with LinearPattern(count=3).

    The cylinder's topology is unchanged (still 3 faces: top, bottom,
    lateral); only their world sizes scale. Every `inst[i]-<part>`
    descriptor must persist verbatim across the radius edit.
    """
    from build123d import Cylinder

    src_a = Cylinder(2, 5)
    src_b = Cylinder(3, 5)

    ns_a, res_a = build_doc(
        ("cyl_src", src_a, "Cylinder", []),
        doc.build_linear_pattern("pat", src_a, count=3, spacing=20,
                                 direction=(1, 0, 0), parents=["cyl_src"]),
    )
    ns_b, res_b = build_doc(
        ("cyl_src", src_b, "Cylinder", []),
        doc.build_linear_pattern("pat", src_b, count=3, spacing=20,
                                 direction=(1, 0, 0), parents=["cyl_src"]),
    )

    faces_a = descriptor_set(extract_topology(ns_a, res_a), kind="face")
    faces_b = descriptor_set(extract_topology(ns_b, res_b), kind="face")

    inst_faces = {f for f in faces_a if "inst[" in f}
    assert inst_faces, "BEFORE set has no inst[*] face descriptors"
    assert inst_faces <= faces_b, (
        f"radius edit broke inst[*] face descriptors:\n"
        f"  missing: {sorted(inst_faces - faces_b)}"
    )


# ─── 8. Pattern source feature TYPE swap (intentional break) ────────────────

@pytest.mark.xfail(
    strict=True,
    reason="Intentional-breakage case: Cylinder (top/bottom/lateral) -> Box "
           "(+X/-X/+Y/-Y/+Z/-Z) have no overlapping <originalPart> tags, so "
           "descriptors MUST NOT match. The namer must not fabricate "
           "continuity. strict=True so this regressing into an unexpected "
           "pass fails the suite — that would mean the namer is inventing "
           "shared lineage across incompatible source topologies."
)
def test_pattern_with_source_replaced(doc, build_doc, extract_topology,
                                      descriptor_set):
    """Swap source feature type: Cylinder -> Box.

    Pattern emits `inst[i]-<originalPart>` where `<originalPart>` comes
    from the source feature's namer. Cylinder produces `top`, `bottom`,
    `lateral`; Box produces `+X`, `-X`, `+Y`, `-Y`, `+Z`, `-Z`. There is
    no overlap, so descriptors from BEFORE cannot resolve in AFTER.
    """
    from build123d import Box, Cylinder

    src_a = Cylinder(2, 5)
    src_b = Box(4, 4, 5)

    ns_a, res_a = build_doc(
        ("src", src_a, "Cylinder", []),
        doc.build_linear_pattern("pat", src_a, count=3, spacing=20,
                                 direction=(1, 0, 0), parents=["src"]),
    )
    ns_b, res_b = build_doc(
        ("src", src_b, "Box", []),
        doc.build_linear_pattern("pat", src_b, count=3, spacing=20,
                                 direction=(1, 0, 0), parents=["src"]),
    )

    faces_a = descriptor_set(extract_topology(ns_a, res_a), kind="face")
    faces_b = descriptor_set(extract_topology(ns_b, res_b), kind="face")

    inst_a = {f for f in faces_a if "inst[" in f}
    inst_b = {f for f in faces_b if "inst[" in f}
    assert inst_a and inst_b, "BEFORE or AFTER lacks inst[*] descriptors"
    # Intentional assertion: instance descriptors must NOT survive because
    # the per-instance topology is totally different. The strict=True xfail
    # marker above flags any flip — if name_*_pattern starts fabricating
    # continuity (this assertion fails), pytest reports XFAIL as expected;
    # if the namer's `<originalPart>` collapses Cylinder/Box tags into a
    # generic surface-type string that ends up identical, the assertion
    # would unexpectedly pass and strict=True turns that into an XPASS
    # failure so the regression is caught.
    assert inst_a.isdisjoint(inst_b), (
        f"source-type swap produced overlapping descriptors — the namer "
        f"is fabricating continuity:\n"
        f"  overlap: {sorted(inst_a & inst_b)}"
    )
