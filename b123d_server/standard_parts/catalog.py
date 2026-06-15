"""Catalog loader — reads every JSON in this package at import time and
exposes them as a flat `LIST` + an id-keyed `CATALOG`.

Each entry is tagged with its builder reference under the private key
`_build`. Anything prefixed with `_` is stripped before the entry leaves
the server (`public_entry()` below).
"""

from __future__ import annotations

import json
import os
from typing import Any, Callable, Iterable

from . import build as _build_mod


_HERE = os.path.dirname(os.path.abspath(__file__))

_JSON_FILES = (
    "iso_metric_screws.json",
    "iso_metric_nuts.json",
    "iso_metric_threads.json",
    "iso_metric_clearance.json",
    "iso_fits.json",
    "bearings_608.json",
    "bearings_extra.json",
    "extrusions_t_slot.json",
    "t_nuts.json",
    # Phase 4 — mechatronic families.
    "servos.json",
    "standoffs.json",
    "horns.json",
    "electronics.json",
    # Functional-design brain — structural robotics parts.
    "robot_brackets.json",
)


def _load_json(filename: str) -> list:
    path = os.path.join(_HERE, filename)
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _build_catalog() -> tuple:
    """Read all JSONs, tag each entry with its builder, return (list, by_id)."""
    entries: list = []
    for fname in _JSON_FILES:
        try:
            entries.extend(_load_json(fname))
        except FileNotFoundError:
            # Allow partial install — emits a warning at import-time so a
            # missing JSON doesn't take down the whole server.
            import sys
            print(f"[standard_parts] WARNING: missing {fname}", file=sys.stderr)
            continue
    for entry in entries:
        entry["_build"] = _build_mod.builder_for(entry)
    by_id = {e["id"]: e for e in entries}
    return entries, by_id


LIST, CATALOG = _build_catalog()


def public_entry(entry: dict) -> dict:
    """Strip private keys (`_build` and any other `_*`) so the entry is
    safe to ship over the wire."""
    return {k: v for k, v in entry.items() if not k.startswith("_")}


def public_list() -> list:
    """Return every catalog entry in wire-safe form (no `_build` refs)."""
    return [public_entry(e) for e in LIST]


def get(entry_id: str) -> dict | None:
    """Look up one entry by id; returns None when unknown."""
    return CATALOG.get(entry_id)


def build_from_id(entry_id: str) -> Any:
    """Look up a catalog entry and invoke its build function.

    Returns a build123d body (Part / Compound). Raises KeyError if the
    entry id is unknown; raises whatever the builder raises if construction
    fails.

    This is the canonical entry point for emit.js's StandardPart emitter —
    the harness exposes `standard_parts.build_from_id` in the executed
    namespace so emitted Python can call it directly.
    """
    entry = CATALOG.get(entry_id)
    if entry is None:
        raise KeyError(f"unknown standard part: {entry_id}")
    builder = entry.get("_build")
    if builder is None:
        raise KeyError(f"entry {entry_id!r} has no builder function")
    return builder(entry)


def get_entry_public(entry_id: str) -> dict | None:
    """Return the lightweight entry (privates stripped) or None."""
    entry = CATALOG.get(entry_id)
    if entry is None:
        return None
    return {k: v for k, v in entry.items() if not k.startswith("_")}
