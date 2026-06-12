"""
Test harness._extract_component_meshes — Spec 17 v2 wiring.

Builds two simple boxes assigned to two different components, runs the
extractor, and asserts:
  - each emitted entry has the documented shape (componentId, positions,
    index, bounds);
  - the positions buffer is flat triangle data (len % 9 == 0 for un-indexed
    or len(index) % 3 == 0 in general);
  - bounds enclose every emitted vertex;
  - bodies without a feature_components mapping fall back to 'root'.

Skips cleanly if build123d isn't importable.
"""

from __future__ import annotations

import os
import sys

import pytest

_HERE = os.path.dirname(os.path.abspath(__file__))
_B123D_SERVER = os.path.abspath(os.path.join(_HERE, ".."))
if _B123D_SERVER not in sys.path:
    sys.path.insert(0, _B123D_SERVER)


def _require_build123d() -> None:
    try:
        import build123d  # noqa: F401
    except Exception as e:  # pragma: no cover
        pytest.skip(f"build123d not importable: {e}")


def _make_box(x=10, y=10, z=10):
    from build123d import Box, Align
    return Box(x, y, z, align=(Align.CENTER, Align.CENTER, Align.MIN))


@pytest.fixture
def two_component_doc():
    _require_build123d()
    box_a = _make_box(10, 10, 10)
    box_b = _make_box(5, 5, 5)
    namespace = {"feat_a": box_a, "feat_b": box_b}
    result = {
        "bodies": {"feat_a": box_a, "feat_b": box_b},
        "feature_types":      {"feat_a": "Box", "feat_b": "Box"},
        "feature_inputs":     {"feat_a": [], "feat_b": []},
        "feature_bodies":     {"feat_a": "feat_a", "feat_b": "feat_b"},
        "feature_components": {"feat_a": "compA",  "feat_b": "compB"},
    }
    return namespace, result


def test_component_meshes_two_components(two_component_doc):
    _require_build123d()
    import harness
    namespace, result = two_component_doc
    out = harness._extract_component_meshes(namespace, result, deflection=0.1)

    assert isinstance(out, dict)
    assert set(out.keys()) == {"compA", "compB"}, f"unexpected keys: {list(out.keys())}"

    for cid, entry in out.items():
        assert entry["componentId"] == cid
        assert isinstance(entry["positions"], list)
        assert isinstance(entry["index"], list)
        assert len(entry["positions"]) % 3 == 0, "positions must be flat XYZ"
        assert len(entry["index"]) % 3 == 0, "index must be flat triangle list"
        assert len(entry["index"]) > 0, "expected at least one triangle"

        # Every index points into a valid vertex slot.
        n_verts = len(entry["positions"]) // 3
        assert max(entry["index"]) < n_verts
        assert min(entry["index"]) >= 0

        # Bounds enclose every vertex.
        b = entry["bounds"]
        assert set(b.keys()) == {"min", "max"}
        for j in range(0, len(entry["positions"]), 3):
            x, y, z = entry["positions"][j:j + 3]
            assert b["min"][0] <= x <= b["max"][0]
            assert b["min"][1] <= y <= b["max"][1]
            assert b["min"][2] <= z <= b["max"][2]


def test_component_meshes_missing_mapping_falls_back_to_root():
    _require_build123d()
    import harness
    box = _make_box()
    namespace = {"feat": box}
    result = {
        "bodies": {"feat": box},
        "feature_types":      {"feat": "Box"},
        "feature_inputs":     {"feat": []},
        "feature_bodies":     {"feat": "feat"},
        # NB: no feature_components — should fall back to 'root'
    }
    out = harness._extract_component_meshes(namespace, result)
    assert list(out.keys()) == ["root"]
    assert out["root"]["componentId"] == "root"
    assert len(out["root"]["positions"]) > 0


def test_component_meshes_empty_when_no_bodies():
    _require_build123d()
    import harness
    out = harness._extract_component_meshes({}, {"bodies": {}, "feature_components": {}})
    assert out == {}


def test_component_meshes_bounds_match_input_box():
    _require_build123d()
    import harness
    box = _make_box(20, 30, 40)  # Align.MIN on Z → sits on z=0
    namespace = {"f": box}
    result = {
        "bodies": {"f": box},
        "feature_types":      {"f": "Box"},
        "feature_inputs":     {"f": []},
        "feature_bodies":     {"f": "f"},
        "feature_components": {"f": "root"},
    }
    out = harness._extract_component_meshes(namespace, result)
    b = out["root"]["bounds"]
    # 20×30 centered → -10..10, -15..15; height 40 with Align.MIN → 0..40
    assert b["min"][0] == pytest.approx(-10, abs=0.01)
    assert b["max"][0] == pytest.approx(10,  abs=0.01)
    assert b["min"][1] == pytest.approx(-15, abs=0.01)
    assert b["max"][1] == pytest.approx(15,  abs=0.01)
    assert b["min"][2] == pytest.approx(0,   abs=0.01)
    assert b["max"][2] == pytest.approx(40,  abs=0.01)
