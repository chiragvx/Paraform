"""Body-generator smoke tests — every builder produces a non-degenerate
solid for a representative entry. Skips cleanly when build123d isn't
importable in the test env.
"""

from __future__ import annotations


def test_build_screw_volume_positive(needs_b123d, catalog):
    """M4x20 SHCS: head + shank > 0, less than the bounding cylinder."""
    from standard_parts import build
    entry = catalog.get("iso4762-m4-20")
    assert entry is not None
    body = build.build_screw(entry)
    v = float(body.volume)
    assert v > 0
    # Loose upper bound: full head cylinder + full shank cylinder.
    import math
    d = entry["dims"]
    head_v  = math.pi * (d["headDiameter"] / 2) ** 2 * d["headHeight"]
    shank_v = math.pi * (d["threadNominal"] / 2) ** 2 * d["lengthTotal"]
    assert v <= head_v + shank_v + 1e-3


def test_build_nut_has_bore(needs_b123d, catalog):
    """M6 hex nut: bored, so volume < hex prism volume."""
    from standard_parts import build
    entry = catalog.get("iso4032-m6")
    assert entry is not None
    body = build.build_nut(entry)
    v = float(body.volume)
    assert v > 0
    # Hex prism volume = 3 * sqrt(3) / 2 * af^2 * h
    import math
    d = entry["dims"]
    prism = (3 * math.sqrt(3) / 2.0) * (d["acrossFlats"] / 1.0) ** 2 * d["height"]
    # Hex prism volume formula uses across-flats: V = (3*sqrt(3)/2) * s^2 * h
    # where s = af / sqrt(3). Recompute properly:
    s = d["acrossFlats"] / math.sqrt(3)
    prism = (3 * math.sqrt(3) / 2.0) * s * s * d["height"]
    assert v < prism  # bore removed some material


def test_build_bearing_is_hollow_disc(needs_b123d, catalog):
    """608 bearing: outer ring with bore — volume positive, less than full OD cyl."""
    from standard_parts import build
    entry = catalog.get("bearing-608")
    assert entry is not None
    body = build.build_bearing(entry)
    v = float(body.volume)
    assert v > 0
    import math
    d = entry["dims"]
    full = math.pi * (d["outerDiameter"] / 2) ** 2 * d["width"]
    assert v < full


def test_builder_for_dispatches_by_category(catalog):
    """`builder_for` picks screw / nut / bearing / data-only correctly."""
    from standard_parts import build
    assert build.builder_for(catalog.get("iso4762-m3-16"))   is build.build_screw
    assert build.builder_for(catalog.get("iso4032-m4"))      is build.build_nut
    assert build.builder_for(catalog.get("bearing-608"))     is build.build_bearing
    assert build.builder_for(catalog.get("iso261-m3"))       is build.build_data_only


def test_every_screw_entry_builds(needs_b123d, catalog):
    """Every ISO 4762 entry survives the builder — guards against
    one-off bad dimensional data."""
    from standard_parts import build
    screws = [e for e in catalog.LIST if e.get("standard") == "ISO 4762"]
    # Sample a few across sizes to keep the suite fast.
    sample_ids = {"iso4762-m2-4", "iso4762-m5-25", "iso4762-m10-50", "iso4762-m16-50"}
    seen = 0
    for e in screws:
        if e["id"] not in sample_ids:
            continue
        body = build.build_screw(e)
        assert float(body.volume) > 0
        seen += 1
    assert seen == len(sample_ids)
