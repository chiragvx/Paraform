"""Tests for the public `build_from_id` / `get_entry_public` helpers.

These wire the catalog up as a kernel-namespace module so emit.js's
StandardPart emitter can call `standard_parts.build_from_id("...")`
inline. Build-side checks need build123d; the metadata-only checks do
not, so they run unconditionally.
"""

from __future__ import annotations

import types

import pytest


# ── Pure-metadata cases (no build123d required) ──────────────────────────


def test_get_entry_public_strips_private_keys(catalog):
    """Public entry view must omit `_build` and any other `_*` keys."""
    pub = catalog.get_entry_public("iso4762-m3-16")
    assert pub is not None
    assert "_build" not in pub
    assert all(not k.startswith("_") for k in pub.keys())
    # Sanity — payload survives.
    assert pub["id"] == "iso4762-m3-16"
    assert pub["dims"]["threadNominal"] == 3.0


def test_get_entry_public_returns_none_for_unknown(catalog):
    assert catalog.get_entry_public("not-a-real-id") is None


def test_build_from_id_unknown_raises_key_error(catalog):
    with pytest.raises(KeyError):
        catalog.build_from_id("not-a-real-id")


# ── Build-side cases (need build123d) ─────────────────────────────────────


def test_build_from_id_screw_returns_positive_volume(needs_b123d, catalog):
    """ISO 4762 M3x16 builds to a solid with positive volume."""
    body = catalog.build_from_id("iso4762-m3-16")
    assert body is not None
    assert hasattr(body, "volume")
    assert body.volume > 0


def test_build_from_id_nut_returns_positive_volume(needs_b123d, catalog):
    """ISO 4032 M4 hex nut builds to a solid with positive volume."""
    body = catalog.build_from_id("iso4032-m4")
    assert body is not None
    assert body.volume > 0


def test_build_from_id_bearing_returns_positive_volume(needs_b123d, catalog):
    """608 deep-groove bearing builds to a solid with positive volume."""
    body = catalog.build_from_id("bearing-608")
    assert body is not None
    assert body.volume > 0


def test_emit_style_invocation_via_facade(needs_b123d, catalog):
    """Simulate the harness-injected façade: build a SimpleNamespace and
    exec a one-liner that uses it, matching what emit.js will emit."""
    sp_facade = types.SimpleNamespace(
        build_from_id=catalog.build_from_id,
        get_entry_public=catalog.get_entry_public,
    )
    ns: dict = {"sp": sp_facade}
    exec('result = sp.build_from_id("iso4032-m4")', ns)  # noqa: S102
    result = ns["result"]
    assert result is not None
    assert hasattr(result, "volume")
    assert result.volume > 0


def test_facade_get_entry_public_via_exec(catalog):
    """The façade's `get_entry_public` callable also round-trips through
    exec — no build123d needed."""
    sp_facade = types.SimpleNamespace(
        build_from_id=catalog.build_from_id,
        get_entry_public=catalog.get_entry_public,
    )
    ns: dict = {"sp": sp_facade}
    exec('pub = sp.get_entry_public("iso4762-m3-16")', ns)  # noqa: S102
    pub = ns["pub"]
    assert pub is not None
    assert "_build" not in pub
    assert pub["id"] == "iso4762-m3-16"
