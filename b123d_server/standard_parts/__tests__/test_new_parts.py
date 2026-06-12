"""Eval guardrail for the Phase-4 mechatronic standard-parts.

The "eval verifies against datasheet numbers" contract: every NEW catalog
entry with a kernel builder must

  1. build to a non-empty solid (positive volume),
  2. have a finite bounding box, and
  3. match the catalog entry's declared `bbox` within tolerance.

The declared `bbox` is the datasheet envelope the JS-side library record
also advertises, so this test is what keeps the two in sync: change a
servo body dim and forget to update the bbox → this test goes red.

Build-side checks need build123d; if it isn't installed the whole module
skips (so CI without the kernel dep still passes). Run:

    python -m pytest b123d_server/standard_parts/__tests__/test_new_parts.py -q
"""

from __future__ import annotations

import os
import sys

import pytest


_HERE = os.path.dirname(os.path.abspath(__file__))
_B123D_SERVER = os.path.abspath(os.path.join(_HERE, "..", ".."))
if _B123D_SERVER not in sys.path:
    sys.path.insert(0, _B123D_SERVER)


def _require_build123d() -> None:
    try:
        import build123d  # noqa: F401
    except Exception as e:  # pragma: no cover — env-dependent
        pytest.skip(f"build123d not importable: {e}")


# Catalog ids introduced in Phase 4 that carry a kernel builder + a declared
# bbox. (Electronics keep-out boxes are exact by construction; servos/horns/
# standoffs are approximations whose envelope must still match the datasheet.)
NEW_BUILD_IDS = [
    "servo-sg90", "servo-mg90s", "servo-mg996r", "servo-ds3218",
    "servo-dynamixel-ax12",
    "standoff-m3-5", "standoff-m3-10", "standoff-m3-25",
    "standoff-m25-5", "standoff-m25-12",
    "horn-sg90-arm", "horn-sg90-cross", "horn-25t-arm", "horn-25t-disc",
    "keepout-a4988", "keepout-arduino-nano", "keepout-esp32-devkit",
    "keepout-lipo-2s", "keepout-switch-rocker",
    # New bearings re-using the existing build_bearing path.
    "bearing-623", "bearing-6800", "bearing-6900", "bearing-f623",
]

# Tolerance for the built-vs-declared bbox check. Servos/horns are coarse
# approximations (smooth shafts instead of splines, no wiring), so half-extent
# agreement to a couple mm is the bar; the test is here to catch gross drift,
# not sub-mm fidelity.
BBOX_TOL_MM = 2.5


def _catalog():
    from standard_parts import catalog as _c
    return _c


def test_all_new_ids_present_in_catalog():
    """Every Phase-4 id resolves to a catalog entry (no build123d needed)."""
    cat = _catalog()
    missing = [eid for eid in NEW_BUILD_IDS if cat.get(eid) is None]
    assert not missing, f"catalog missing entries: {missing}"


def test_every_new_entry_declares_bbox():
    """Each new entry advertises a datasheet bbox the eval can check against."""
    cat = _catalog()
    no_bbox = []
    for eid in NEW_BUILD_IDS:
        entry = cat.get(eid)
        if entry is None:
            continue
        # Bearings live in the shared bearings JSON without a bbox field; they
        # are validated by volume only (see the build test below).
        if eid.startswith("bearing-"):
            continue
        if "bbox" not in entry:
            no_bbox.append(eid)
    assert not no_bbox, f"entries missing declared bbox: {no_bbox}"


@pytest.mark.parametrize("entry_id", NEW_BUILD_IDS)
def test_build_from_id_non_empty_solid(entry_id):
    """Each new id builds to a solid with positive, finite volume."""
    _require_build123d()
    cat = _catalog()
    body = cat.build_from_id(entry_id)
    assert body is not None, f"{entry_id} built None"
    assert hasattr(body, "volume"), f"{entry_id} has no .volume"
    vol = body.volume
    assert vol > 0, f"{entry_id} volume not positive: {vol}"
    import math
    assert math.isfinite(vol), f"{entry_id} volume not finite: {vol}"


@pytest.mark.parametrize(
    "entry_id",
    [e for e in NEW_BUILD_IDS if not e.startswith("bearing-")],
)
def test_built_bbox_matches_declared(entry_id):
    """Built bounding box agrees with the declared datasheet envelope."""
    _require_build123d()
    cat = _catalog()
    entry = cat.get(entry_id)
    declared = entry.get("bbox")
    assert declared is not None, f"{entry_id} has no declared bbox"

    body = cat.build_from_id(entry_id)
    bb = body.bounding_box()
    bmin = (bb.min.X, bb.min.Y, bb.min.Z)
    bmax = (bb.max.X, bb.max.Y, bb.max.Z)

    import math
    for v in (*bmin, *bmax):
        assert math.isfinite(v), f"{entry_id} bbox not finite"

    for axis in range(3):
        assert abs(bmin[axis] - declared["min"][axis]) <= BBOX_TOL_MM, (
            f"{entry_id} min[{axis}] {bmin[axis]:.3f} vs declared "
            f"{declared['min'][axis]} (tol {BBOX_TOL_MM})"
        )
        assert abs(bmax[axis] - declared["max"][axis]) <= BBOX_TOL_MM, (
            f"{entry_id} max[{axis}] {bmax[axis]:.3f} vs declared "
            f"{declared['max'][axis]} (tol {BBOX_TOL_MM})"
        )
