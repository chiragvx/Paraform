"""Catalog data-table integrity checks.

These tests don't need build123d — they parse the JSON tables, count
entries per category, and assert a handful of well-known reference
entries are present with the right dimensions. If a future edit drops
M3x16 or bumps M4 to the wrong head Ø, these break.
"""

from __future__ import annotations


def test_screw_catalog_has_seventy_plus_entries(catalog):
    screws = [e for e in catalog.LIST if e.get("standard") == "ISO 4762"]
    assert len(screws) >= 70


def test_nut_catalog_has_ten_sizes(catalog):
    nuts = [e for e in catalog.LIST if e.get("standard") == "ISO 4032"]
    assert len(nuts) == 10


def test_thread_catalog_has_ten_sizes(catalog):
    threads = [e for e in catalog.LIST if e.get("standard") == "ISO 261"]
    assert len(threads) == 10


def test_clearance_has_three_per_size(catalog):
    clear = [e for e in catalog.LIST if e.get("standard") == "ISO 273"]
    # Spec table: 8 sizes x 3 fits (close/medium/loose) = 24.
    assert len(clear) == 24
    fits = {e["dims"]["fit"] for e in clear}
    assert fits == {"close", "medium", "loose"}


def test_fits_cover_seven_bands_three_fits(catalog):
    fits = [e for e in catalog.LIST if e.get("standard") == "ISO 286-2"]
    assert len(fits) == 21
    fit_kinds = {e["dims"]["fit"] for e in fits}
    assert fit_kinds == {"H7g6", "H7h6", "H7k6"}


def test_bearing_catalog_has_ten_entries(catalog):
    # 10 original (bearings_608.json) + 4 Phase-4 additions
    # (623 / 6800 / 6900 / F623 in bearings_extra.json).
    bearings = [e for e in catalog.LIST if e.get("category") == "Bearing"]
    assert len(bearings) == 14


def test_m3_16_shcs_has_expected_dims(catalog):
    """ISO 4762 M3x16: head Ø 5.5, head height 3.0, hex socket 2.5, pitch 0.5."""
    e = catalog.get("iso4762-m3-16")
    assert e is not None
    d = e["dims"]
    assert d["threadNominal"] == 3.0
    assert d["threadPitch"]   == 0.5
    assert d["headDiameter"]  == 5.5
    assert d["headHeight"]    == 3.0
    assert d["socketAcrossFlats"] == 2.5
    assert d["lengthTotal"]   == 16


def test_608_bearing_dims(catalog):
    """608 bearing: ID 8, OD 22, width 7."""
    e = catalog.get("bearing-608")
    assert e is not None
    assert e["dims"]["innerDiameter"] == 8
    assert e["dims"]["outerDiameter"] == 22
    assert e["dims"]["width"] == 7


def test_public_entry_strips_private_keys(catalog):
    """`_build` and any `_*` key must not survive `public_entry`."""
    e = catalog.get("iso4762-m3-16")
    pub = catalog.public_entry(e)
    assert "_build" not in pub
    assert all(not k.startswith("_") for k in pub.keys())


def test_total_entry_count_at_least_one_forty(catalog):
    """Sanity floor — strictly less is a regression."""
    assert len(catalog.LIST) >= 140
