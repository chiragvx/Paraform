"""
Tiny DSL for assembling v4 result dicts that `harness._extract_topology_v4`
can consume — without round-tripping through emitted Python source.

The v4 emitter produces:

    namespace = { var_name: body_object, ... }
    result    = {
        "feature_types":  { fid: feature_type_string, ... },
        "feature_inputs": { fid: [upstream_fid, ...], ... },
        "feature_bodies": { fid: var_name_in_namespace, ... },
    }

These helpers build the same shape from a flat list of feature specs, so a
test reads like:

    ns, res = build_doc(
        ("box_x",  Box(10, 10, 10), "Box", []),
        ("cyl_a",  Cylinder(2, 5),  "Cylinder", []),
        ("u",      box_body - cyl_body, "Cut", ["box_x", "cyl_a"]),
    )
    topology = harness._extract_topology_v4(ns, res)

The DSL uses `fid` as the variable name as well; the namespace key matches
the feature id so `feature_bodies[fid] == fid`. The harness already accepts
this convention (`var_name = feature_bodies.get(fid) or f"n_{fid}"`).

`build123d` imports are kept inside the `build_*` constructors so a test
file that uses doc_builder.build_doc() with already-built bodies doesn't
pay an import cost twice. The convenience `build_box` / `build_cylinder` /
etc. wrappers exist for tests that just want a primitive without naming
the parameters at the top.
"""

from __future__ import annotations

from typing import Any, List, Sequence, Tuple


# ─── Primitive constructors ────────────────────────────────────────────────


def build_box(fid: str, length: float = 10, width: float = 10, height: float = 10):
    """Return `(fid, body, "Box", inputs)` ready to drop into `build_doc(...)`."""
    from build123d import Box
    return (fid, Box(length, width, height), "Box", [])


def build_cylinder(fid: str, radius: float = 5, height: float = 10):
    from build123d import Cylinder
    return (fid, Cylinder(radius, height), "Cylinder", [])


def build_sphere(fid: str, radius: float = 5):
    from build123d import Sphere
    return (fid, Sphere(radius), "Sphere", [])


def build_torus(fid: str, major_radius: float = 10, minor_radius: float = 2):
    from build123d import Torus
    return (fid, Torus(major_radius, minor_radius), "Torus", [])


# ─── Boolean wrappers ──────────────────────────────────────────────────────
# These take pre-built bodies (so the test can construct them with whatever
# transforms / positions it needs) and just stamp the boolean op tag + inputs.


def build_union(fid: str, target_body, tool_body, parents: Sequence[str]):
    body = target_body + tool_body
    return (fid, body, "Union", list(parents))


def build_cut(fid: str, target_body, tool_body, parents: Sequence[str]):
    body = target_body - tool_body
    return (fid, body, "Cut", list(parents))


def build_intersect(fid: str, target_body, tool_body, parents: Sequence[str]):
    body = target_body & tool_body
    return (fid, body, "Intersect", list(parents))


# ─── Pattern + Mirror wrappers ─────────────────────────────────────────────
# These take a pre-built source body, materialise N translated/rotated/mirrored
# copies, and fuse them into a single Part. The harness only needs `.faces()`
# on the resulting body — a fused Part exposes every per-instance face just
# like a Compound would, but is more reliable to construct across build123d
# versions (Compound(children=...) constructor signature has shifted).
#
# Compound API note: build123d 0.10 ships both `Compound(children=[...])` and
# a free `Compound.make_compound([...])` classmethod, but neither reliably
# round-trips through `.faces()` for OCCT Compound shapes assembled out of
# loose Parts in every environment we test against. Pairwise fusion via `+=`
# (which lowers to BRepAlgoAPI_Fuse) produces a Part whose `.faces()` walks
# every constituent face deterministically — which is exactly what the
# naming.py pattern namers need.


def _fuse_copies(copies):
    """Pairwise-fuse a list of bodies into one Part via the `+` operator.

    Why not Compound? See module note above — fusion gives a body whose
    `.faces()` is guaranteed to walk every per-instance face under OCCT's
    TopExp_Explorer, which is what `name_linear_pattern` /
    `name_circular_pattern` / `name_mirror` consume.
    """
    if not copies:
        raise ValueError("_fuse_copies needs at least one body")
    body = copies[0]
    for c in copies[1:]:
        body = body + c
    return body


def build_linear_pattern(fid: str, source_body, *, count: int, spacing: float,
                         direction: tuple = (1, 0, 0),
                         parents: Sequence[str] = ()):
    """Create a linearly-patterned compound body from an existing source.

    Each instance is the source body translated by `i * spacing * direction`
    for i in 0..count-1. The result is a fused Part the harness can call
    `.faces()` on; `name_linear_pattern` (naming.py) walks every face and
    emits `inst[i]-<srcPart>` descriptors.

    Returns `(fid, body, "LinearPattern", list(parents))`.

    API used: pairwise fusion via `+`. We tried `Compound(children=copies)`
    first but the resulting Compound's `.faces()` traversal is fragile across
    build123d 0.10.x point releases.
    """
    from build123d import Location, Vector
    dx, dy, dz = direction
    copies = [source_body.moved(Location(Vector(dx * spacing * i,
                                                dy * spacing * i,
                                                dz * spacing * i)))
              for i in range(count)]
    return (fid, _fuse_copies(copies), "LinearPattern", list(parents))


def build_circular_pattern(fid: str, source_body, *, count: int,
                           angle: float = 360, axis: str = "Z",
                           parents: Sequence[str] = ()):
    """Rotate `count` copies around `axis` evenly spread over `angle` degrees.

    `axis` is one of 'X'|'Y'|'Z'. v1: rotate around the origin axis only.
    Each instance gets `step = angle / count` degrees of rotation. The result
    is a fused Part — see `_fuse_copies` for the Compound-vs-fusion choice.
    """
    from build123d import Rotation
    step = angle / count
    copies = []
    for i in range(count):
        if axis == "Z":
            rot = Rotation(0, 0, step * i)
        elif axis == "Y":
            rot = Rotation(0, step * i, 0)
        elif axis == "X":
            rot = Rotation(step * i, 0, 0)
        else:
            raise ValueError(f"axis must be 'X'|'Y'|'Z', got {axis!r}")
        copies.append(source_body.moved(rot))
    return (fid, _fuse_copies(copies), "CircularPattern", list(parents))


def build_mirror(fid: str, source_body, *, plane: str = "XY",
                 parents: Sequence[str] = ()):
    """Mirror source about a stock plane (XY / XZ / YZ).

    Returns the original + mirrored body as a single fused Part. The
    contract (NAMING_CONTRACT.md §Mirror row) says mirrored faces carry
    `mir-<originalPart>`. Including both halves is the conservative v1
    choice — `name_mirror` walks every face and tags it `mir-<srcPart>`
    regardless of which half it came from (a known v1 limitation: we don't
    distinguish mirrored from source faces inside the namer; the corpus
    test asserting plane-independence still holds because plane is not
    encoded in the part tag).
    """
    from build123d import Plane, mirror as b3d_mirror
    pmap = {"XY": Plane.XY, "XZ": Plane.XZ, "YZ": Plane.YZ}
    if plane not in pmap:
        raise ValueError(f"plane must be 'XY'|'XZ'|'YZ', got {plane!r}")
    mirrored = b3d_mirror(source_body, about=pmap[plane])
    return (fid, _fuse_copies([source_body, mirrored]), "Mirror", list(parents))


# ─── Composer ──────────────────────────────────────────────────────────────


SpecTuple = Tuple[str, Any, str, Sequence[str]]


def build_doc(*specs: SpecTuple) -> Tuple[dict, dict]:
    """Compose feature specs into `(namespace, result)` the harness expects.

    Each spec is a 4-tuple: `(feature_id, body, feature_type, inputs)`.

    The variable name in the namespace is the feature id itself — the harness
    falls back to `n_<fid>` only if `feature_bodies[fid]` isn't set, so we
    set it explicitly to keep the test deterministic.
    """
    namespace: dict = {}
    feature_types: dict = {}
    feature_inputs: dict = {}
    feature_bodies: dict = {}

    for fid, body, ftype, inputs in specs:
        namespace[fid] = body
        feature_types[fid] = ftype
        feature_inputs[fid] = list(inputs)
        feature_bodies[fid] = fid

    result = {
        "feature_types":  feature_types,
        "feature_inputs": feature_inputs,
        "feature_bodies": feature_bodies,
    }
    return namespace, result


def collect_descriptors(topology: dict, kind: str = "face") -> set:
    """Standalone version of the `descriptor_set` fixture for non-test usage."""
    import sys, os
    _b123d = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
    if _b123d not in sys.path:
        sys.path.insert(0, _b123d)
    import harness  # type: ignore

    out: set = set()
    bucket = f"{kind}s"
    for node in topology.get("nodes") or []:
        for entry in node.get(bucket) or []:
            d = entry.get("descriptor")
            if d:
                out.add(harness._descriptor_canonical(d))
    return out
