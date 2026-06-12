"""
Sandboxed execution of build123d Python code emitted by the browser tree.

Returns a manifest of bodies + serialized glb/STEP bytes.
"""

import os
import tempfile
import traceback
from typing import Any

import build123d as _b123d
from build123d import Part, Compound, Solid, Sketch, export_gltf, export_step as _b123d_export_step

from .harness import HARNESS_GLOBALS


# Build the globals dictionary once at import time
def _build_globals() -> dict:
    g = {"__builtins__": __builtins__}
    for name in dir(_b123d):
        if not name.startswith("_"):
            g[name] = getattr(_b123d, name)
    g.update(HARNESS_GLOBALS)
    return g


_BASE_GLOBALS = _build_globals()


def execute_code(code: str) -> dict:
    """
    Execute build123d code, return a result dict:
        { ok, bodies, error?, trace?, locals_summary }

    bodies = { name: shape } — names are the Python variable names of all
    Part/Compound/Solid objects assigned at top-level, or whatever the code
    placed into __paraform_result__["bodies"].
    """
    globals_dict = dict(_BASE_GLOBALS)
    locals_dict: dict[str, Any] = {}

    try:
        exec(code, globals_dict, locals_dict)
    except Exception as e:
        return {
            "ok": False,
            "error": str(e),
            "trace": traceback.format_exc(),
            "bodies": {},
        }

    # Prefer the explicit manifest the emitter writes
    manifest = locals_dict.get("__paraform_result__")
    if isinstance(manifest, dict) and "bodies" in manifest:
        bodies = {k: v for k, v in manifest["bodies"].items() if _is_shape(v)}
        if bodies:
            return {"ok": True, "bodies": bodies, "locals_summary": _summarize(locals_dict)}

    # Fallback: gather all top-level shapes the code defined
    bodies = {k: v for k, v in locals_dict.items()
              if _is_shape(v) and not k.startswith("_")}

    return {
        "ok": True,
        "bodies": bodies,
        "locals_summary": _summarize(locals_dict),
    }


def _is_shape(obj) -> bool:
    return isinstance(obj, (Part, Compound, Solid))


def _summarize(d: dict) -> dict:
    return {k: type(v).__name__ for k, v in d.items() if not k.startswith("_")}


# ── Export ─────────────────────────────────────────────────────────────────
def to_glb_bytes(shape) -> bytes:
    """Serialize a build123d shape to binary glTF (glb) bytes."""
    with tempfile.NamedTemporaryFile(suffix=".glb", delete=False) as f:
        path = f.name
    try:
        export_gltf(shape, path, binary=True)
        with open(path, "rb") as fh:
            return fh.read()
    finally:
        try: os.unlink(path)
        except OSError: pass


def to_step_bytes(shape) -> bytes:
    """Serialize a build123d shape to STEP (AP214) bytes."""
    with tempfile.NamedTemporaryFile(suffix=".step", delete=False) as f:
        path = f.name
    try:
        _b123d_export_step(shape, path)
        with open(path, "rb") as fh:
            return fh.read()
    finally:
        try: os.unlink(path)
        except OSError: pass


def to_stl_bytes(shape) -> bytes:
    """Serialize a build123d shape to binary STL bytes."""
    from build123d import export_stl
    with tempfile.NamedTemporaryFile(suffix=".stl", delete=False) as f:
        path = f.name
    try:
        export_stl(shape, path)
        with open(path, "rb") as fh:
            return fh.read()
    finally:
        try: os.unlink(path)
        except OSError: pass


def combine_bodies(bodies: dict) -> Any:
    """Union all bodies into a single Compound for export."""
    if not bodies:
        return None
    items = list(bodies.values())
    if len(items) == 1:
        return items[0]
    result = items[0]
    for b in items[1:]:
        try:
            result = result + b
        except Exception:
            # If union fails, return a Compound of all parts as-is
            return Compound(items)
    return result
