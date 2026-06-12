"""
Pytest fixtures + helpers for the topological-naming regression corpus.

Each test in this directory follows the same shape:

    state_a = build a document at parameters A
    state_b = build the same document at parameters B (one parameter changed)
    assert that the descriptor strings for entities that *should* survive
    actually do survive — verbatim, byte-for-byte canonical strings.

The fixtures here drive `harness._extract_topology_v4` directly without
spinning up the Flask server, exec()'ing emitted code, or touching GLB
export.

Imports of `build123d` happen inside the fixtures (lazily) so that missing
kernel deps fail with a clean SKIP at test-collection time rather than
breaking pytest's import phase.
"""

from __future__ import annotations

import os
import sys
from typing import Any, Callable, Iterable, Set

import pytest


# Make `import harness` / `import naming` work no matter where pytest is
# invoked from. The b123d_server/ directory isn't a package, so its modules
# must be on sys.path directly.
_HERE = os.path.dirname(os.path.abspath(__file__))
_B123D_SERVER = os.path.abspath(os.path.join(_HERE, "..", ".."))
if _B123D_SERVER not in sys.path:
    sys.path.insert(0, _B123D_SERVER)


def _require_build123d() -> None:
    """Skip the test if build123d isn't importable in this env."""
    try:
        import build123d  # noqa: F401
    except Exception as e:  # pragma: no cover — env-dependent
        pytest.skip(f"build123d not importable: {e}")


# ─── Core fixtures ──────────────────────────────────────────────────────────


@pytest.fixture
def extract_topology() -> Callable[[dict, dict], dict]:
    """Returns a callable `(namespace, result) -> topology_dict`.

    Wraps `harness._extract_topology_v4` so tests don't have to remember the
    private-ish name. Skips the test if the kernel deps aren't available.
    """
    _require_build123d()
    import harness  # noqa: WPS433  (lazy import — see module docstring)

    def _call(namespace: dict, result: dict) -> dict:
        return harness._extract_topology_v4(namespace, result)

    return _call


@pytest.fixture
def descriptor_set() -> Callable[[dict, str], Set[str]]:
    """Returns a callable `(topology, kind='face') -> Set[str]`.

    Walks every node in the topology and collects the canonical descriptor
    strings for entities of the requested kind. The canonical string is the
    same format `naming.Descriptor.canonical()` produces (and that the JS
    resolver hashes by).
    """
    _require_build123d()
    import harness  # noqa: WPS433

    def _collect(topology: dict, kind: str = "face") -> Set[str]:
        out: Set[str] = set()
        nodes = topology.get("nodes") or []
        bucket = f"{kind}s"  # 'face' → 'faces', 'edge' → 'edges'
        for node in nodes:
            for entry in node.get(bucket) or []:
                desc = entry.get("descriptor")
                if not desc:
                    continue
                # Reuse the harness's canonical-string builder so the format
                # is identical to what the resolver will see on the wire.
                out.add(harness._descriptor_canonical(desc))
        return out

    return _collect


@pytest.fixture
def semantic_match() -> Callable[[Set[str], Set[str], Set[str]], None]:
    """Returns a callable for asserting descriptor persistence across edits.

    Shape: `semantic_match(before, after, expected_persistent)` where
    `expected_persistent` is the set of descriptors that SHOULD have survived
    the edit verbatim.

    The function raises `AssertionError` listing the missing descriptors when
    any expected one didn't appear in `after`, so test output is diagnostic
    rather than "False != True".
    """

    def _match(
        before: Set[str],
        after: Set[str],
        expected_persistent: Set[str],
    ) -> None:
        # Sanity: every expected descriptor must have existed before the edit.
        missing_before = expected_persistent - before
        assert not missing_before, (
            "expected_persistent contains descriptors not in BEFORE set:\n"
            + "\n".join(sorted(missing_before))
        )
        # The real check: every expected descriptor must survive into AFTER.
        missing_after = expected_persistent - after
        assert not missing_after, (
            "descriptors that should have persisted across the edit but "
            "did NOT appear in AFTER:\n"
            + "\n".join(sorted(missing_after))
            + "\n\nfull diff (before XOR after):\n"
            + "\n".join(sorted(before ^ after))
        )

    return _match


# ─── Bonus: a fixture that returns the doc_builder module itself ──────────
# Convenience so tests can do `doc.build_box(...)` instead of importing the
# module explicitly. Lazy so build123d failures land in skip, not collect.


def _import_doc_builder():
    """Import doc_builder regardless of whether `__tests__/naming` is
    importable as a package (it starts with `__` which makes some test
    runners skip package treatment). Falls back to file-path loading.
    """
    try:
        from . import doc_builder  # type: ignore
        return doc_builder
    except (ImportError, ValueError):
        import importlib.util
        path = os.path.join(_HERE, "doc_builder.py")
        spec = importlib.util.spec_from_file_location("doc_builder", path)
        module = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(module)
        return module


@pytest.fixture
def doc():
    """Shortcut: return the doc_builder helper module."""
    _require_build123d()
    return _import_doc_builder()


@pytest.fixture
def build_doc() -> Callable[..., tuple]:
    """Shortcut to `doc_builder.build_doc` — the most common DSL entry point."""
    _require_build123d()
    return _import_doc_builder().build_doc
