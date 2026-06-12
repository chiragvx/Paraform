"""Tests for the T-nut catalog entries (Misumi HNTR family).

Validates that:
  * Catalog metadata round-trips (id, dims, fitsExtrusionSeries).
  * The builder produces a solid with the expected dimensional envelope.
  * The bore through the thread axis actually subtracts (i.e. the t-nut is
    a hollow ring on its mid-plane, not a solid block).
  * The neck is narrower than the matching extrusion's slot opening and
    the base is narrower than its channel — the t-nut physically fits.
"""

from __future__ import annotations

import pytest


# ── Pure-metadata cases (no build123d required) ──────────────────────────


def test_catalog_includes_hntr5(catalog):
    """The M5 t-nut for HFS5 / 20-series should be in the catalog."""
    pub = catalog.get_entry_public("tnut-hntr5-m5")
    assert pub is not None
    assert pub["category"] == "T-Nut"
    assert pub["dims"]["thread"] == "M5"
    assert pub["dims"]["series"] == 20
    assert pub["metadata"]["fitsExtrusionSeries"] == [20]


def test_catalog_includes_hntr8(catalog):
    """The M8 t-nut for HFS8 / 40-series should be in the catalog."""
    pub = catalog.get_entry_public("tnut-hntr8-m8")
    assert pub is not None
    assert pub["category"] == "T-Nut"
    assert pub["dims"]["thread"] == "M8"
    assert pub["dims"]["series"] == 40
    assert pub["metadata"]["fitsExtrusionSeries"] == [40]


def test_t_nut_fits_its_extrusion_series(catalog):
    """The HNTR5 t-nut neck must fit through the HFS5 slot opening AND
    its base must fit inside the HFS5 channel — and same for HNTR8/HFS8.
    This is the geometric contract the snap-mate flow assumes."""
    from standard_parts.build import _EXTRUSION_PROFILES

    for tnut_id, series in [("tnut-hntr5-m5", 20), ("tnut-hntr8-m8", 40)]:
        tnut = catalog.get_entry_public(tnut_id)
        prof = _EXTRUSION_PROFILES[series]
        assert tnut["dims"]["neckWidth"] < prof["slot_opening"], \
            f"{tnut_id} neck doesn't fit slot"
        assert tnut["dims"]["baseWidth"] < prof["channel_width"], \
            f"{tnut_id} base doesn't fit channel"
        # Base must be at least as deep as the lip so the t-nut is captured.
        assert tnut["dims"]["baseHeight"] >= prof["lip_depth"], \
            f"{tnut_id} base shallower than lip — won't lock"


# ── Build-side cases (need build123d) ─────────────────────────────────────


def test_build_t_nut_m5_has_positive_volume(needs_b123d, catalog):
    """HNTR5 M5 t-nut builds to a solid with positive volume."""
    body = catalog.build_from_id("tnut-hntr5-m5")
    assert body is not None
    assert hasattr(body, "volume")
    assert body.volume > 0


def test_build_t_nut_m8_has_positive_volume(needs_b123d, catalog):
    body = catalog.build_from_id("tnut-hntr8-m8")
    assert body is not None
    assert body.volume > 0


def test_build_t_nut_m5_envelope_matches_dims(needs_b123d, catalog):
    """Bounding box should match length × baseWidth × (baseHeight+neckHeight)."""
    entry = catalog.get_entry_public("tnut-hntr5-m5")
    d = entry["dims"]
    body = catalog.build_from_id("tnut-hntr5-m5")

    # build123d's `bounding_box()` returns a BoundBox with size attributes.
    bb = body.bounding_box()
    assert bb.size.X == pytest.approx(d["baseLength"], abs=0.05)
    assert bb.size.Y == pytest.approx(d["baseWidth"], abs=0.05)
    assert bb.size.Z == pytest.approx(
        d["baseHeight"] + d["neckHeight"], abs=0.05,
    )


def test_build_t_nut_has_through_hole(needs_b123d, catalog):
    """Bore subtraction worked → solid volume is strictly less than the
    naive base+neck bounding-prism volume."""
    entry = catalog.get_entry_public("tnut-hntr5-m5")
    d = entry["dims"]
    body = catalog.build_from_id("tnut-hntr5-m5")
    # Two-box envelope (base + neck stacked, no bore).
    naive = (d["baseLength"] * d["baseWidth"]  * d["baseHeight"]) + \
            (d["baseLength"] * d["neckWidth"]  * d["neckHeight"])
    assert body.volume < naive, "expected bore to reduce volume below the naive prism"


def test_build_t_nut_sits_on_z_zero(needs_b123d, catalog):
    """T-nut's base must be on z=0 (Align.MIN convention) so the
    component-subgroup origin places it correctly without a Z offset."""
    body = catalog.build_from_id("tnut-hntr5-m5")
    bb = body.bounding_box()
    assert bb.min.Z == pytest.approx(0.0, abs=1e-4)
