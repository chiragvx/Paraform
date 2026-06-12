"""Lazy GLB cache for standard parts.

`get_glb(entry_id)` returns the raw GLB bytes for one catalog entry,
generating it on first call and caching forever in process memory. No
filesystem cache for v1 — the per-entry GLB is small (a few KB to ~50 KB)
and re-generation costs are a few hundred ms, so an in-process dict is
sufficient until we see real-world cache pressure.

Eviction policy: **none** for v1. The cache is bounded by the catalog
size (~150 entries) so worst-case resident memory is ~7-15 MB of GLB
bytes — comfortable next to OCCT itself. Wipe via `clear()` (used by
tests).
"""

from __future__ import annotations

import os
import tempfile
from typing import Optional

from . import catalog as _catalog


_GLB_CACHE: dict[str, bytes] = {}


def _export_glb(body) -> bytes:
    """Mirror `harness.execute_b123d`'s GLB-via-tempfile pattern.

    build123d's `export_gltf` writes to a path; there's no in-memory API
    on every build123d revision. Write to a NamedTemporaryFile, read it
    back, delete. Same approach as the main /execute pipeline.
    """
    from build123d import export_gltf

    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".glb", delete=False) as f:
            tmp_path = f.name
        export_gltf(body, tmp_path, binary=True)
        with open(tmp_path, "rb") as f:
            return f.read()
    finally:
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


def get_glb(entry_id: str) -> Optional[bytes]:
    """Return GLB bytes for one catalog entry, building+caching on miss.

    Returns None when the entry id is unknown. Build / export failures
    propagate as exceptions so the calling route can render a 500 with
    the underlying message — silently caching an empty blob would mask a
    bad build123d revision or a malformed entry.
    """
    cached = _GLB_CACHE.get(entry_id)
    if cached is not None:
        return cached
    entry = _catalog.get(entry_id)
    if entry is None:
        return None
    builder = entry.get("_build")
    if builder is None:
        # Fallback — shouldn't happen after catalog._build_catalog() tagging.
        from . import build as _build_mod
        builder = _build_mod.builder_for(entry)
    body = builder(entry)
    glb = _export_glb(body)
    _GLB_CACHE[entry_id] = glb
    return glb


def clear() -> None:
    """Drop every cached GLB. Test helper / no production callers."""
    _GLB_CACHE.clear()


def size() -> int:
    """Number of cached entries — observability hook for /health later."""
    return len(_GLB_CACHE)
