"""Pytest fixtures for the standard-parts corpus.

Mirrors `__tests__/measure/conftest.py` — push `b123d_server/` onto sys.path
so the flat modules + the `standard_parts` package are importable, and gate
build123d-dependent tests behind a `pytest.skip` when the kernel dep isn't
available in the test env.
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


@pytest.fixture
def needs_b123d():
    """Use as a function param to skip a test cleanly when build123d isn't
    installed in the test environment."""
    _require_build123d()
    return True


@pytest.fixture
def catalog():
    """The shared catalog module — entries loaded once at import."""
    from standard_parts import catalog as _catalog
    return _catalog


@pytest.fixture
def cache():
    """Clean GLB cache per test."""
    _require_build123d()
    from standard_parts import cache as _cache
    _cache.clear()
    yield _cache
    _cache.clear()


@pytest.fixture
def flask_client():
    """A Flask test client over the production app — same instance the
    real server boots."""
    _require_build123d()
    import server  # noqa: WPS433
    server.app.config["TESTING"] = True
    with server.app.test_client() as client:
        yield client
