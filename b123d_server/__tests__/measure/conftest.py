"""
Pytest fixtures for the measure-API corpus.

Mirrors `__tests__/naming/conftest.py` — build a v4 document via the same
`doc_builder` DSL the naming corpus uses, then run `measure.measure_query`
against the resulting namespace + result dict (with topology pre-baked in).

`harness` + `naming` + `measure` modules are loaded by manipulating sys.path
since `b123d_server/` is a flat directory, not a package.
"""

from __future__ import annotations

import os
import sys
from typing import Any, Callable

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


def _import_doc_builder():
    """Borrow the naming corpus's `doc_builder` so we share one DSL."""
    naming_dir = os.path.abspath(os.path.join(_HERE, "..", "naming"))
    if naming_dir not in sys.path:
        sys.path.insert(0, naming_dir)
    import importlib.util
    path = os.path.join(naming_dir, "doc_builder.py")
    spec = importlib.util.spec_from_file_location("doc_builder", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def doc():
    _require_build123d()
    return _import_doc_builder()


@pytest.fixture
def build_doc() -> Callable[..., tuple]:
    _require_build123d()
    return _import_doc_builder().build_doc


@pytest.fixture
def build_state() -> Callable[..., tuple]:
    """Compose a doc and pre-bake the v4 topology so `measure` can resolve
    descriptors without the server re-running the namer.

    Returns `(namespace, result)` where `result` carries
    `__topology__` — the same shape the server stashes after /execute.
    """
    _require_build123d()
    import harness  # noqa: WPS433
    doc_builder = _import_doc_builder()

    def _call(*specs):
        ns, res = doc_builder.build_doc(*specs)
        topology = harness._extract_topology_v4(ns, res)
        res["__topology__"] = topology
        return ns, res

    return _call


@pytest.fixture
def run_measure():
    """`run_measure(query, namespace, result)` → typed result dict.

    Thin shim over `measure.measure_query` so test bodies stay one-liners.
    """
    _require_build123d()
    import measure  # noqa: WPS433

    def _call(query: dict, namespace: dict, result: dict) -> dict:
        return measure.measure_query(query, namespace, result)

    return _call


@pytest.fixture
def first_face_canonical():
    """Return the canonical string of the first face descriptor for a feature.

    Saves test bodies from re-implementing the canonical-builder; the test
    just says "give me a face descriptor on feature X" without caring which.
    """
    _require_build123d()
    import harness  # noqa: WPS433

    def _call(result: dict, feature_id: str, kind: str = "face") -> str:
        topology = result.get("__topology__") or {}
        for node in topology.get("nodes") or []:
            if node.get("featureId") != feature_id:
                continue
            bucket = f"{kind}s"
            for entry in node.get(bucket) or []:
                desc = entry.get("descriptor")
                if desc:
                    return harness._descriptor_canonical(desc)
        raise AssertionError(f"no {kind} descriptor found for feature '{feature_id}'")

    return _call
