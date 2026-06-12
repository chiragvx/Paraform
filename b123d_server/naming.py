"""
Topological naming — kernel side.

Implements the contract described in lib/document/NAMING_CONTRACT.md. Every
operation that produces a body attaches a Descriptor to every face/edge/vertex
the operation emits. Descriptors are deterministic across rebuilds as long as
the topology of the producing operation is unchanged.

Wire format (JSON):
    {
      "descriptor": {
        "kind":    "face" | "edge" | "vertex",
        "feature": "<feature id>",
        "opTag":   "<op tag>",
        "part":    "<ordinal>",
        "parents": [ <nested Descriptor>, ... ]
      },
      "centerRounded":  [x, y, z],
      "normalRounded":  [x, y, z],   # face only
      "tangentRounded": [x, y, z],   # edge only
      "area":           <float>,     # face only
      "length":         <float>,     # edge only
      "surfaceType":    "planar" | "cylindrical" | "spherical" | "conical" | "toroidal" | "other",
      "closed":         <bool>       # edge only
    }

The same shape lands on lib/document/resolver.js — the JS resolver consumes
these entries verbatim to answer client-side queries.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Iterable, List, Optional, Tuple


# ─── OP_TAGS — keep synchronised with lib/document/descriptor.js OP_TAGS ─────
OP_BOX, OP_CYL, OP_SPHERE, OP_TORUS = "box", "cyl", "sphere", "torus"
OP_EXTRUDE, OP_REVOLVE, OP_SWEEP, OP_LOFT = "extrude", "revolve", "sweep", "loft"
OP_FILLET, OP_CHAMFER, OP_SHELL, OP_DRAFT = "fillet", "chamfer", "shell", "draft"
OP_HOLE, OP_THREAD, OP_OFFSET = "hole", "thread", "offset"
OP_UNION, OP_CUT, OP_INTERSECT, OP_SPLIT = "union", "cut", "intersect", "split"
OP_LIN_PAT, OP_CIR_PAT, OP_PATH_PAT, OP_MIRROR = "linpat", "cirpat", "pathpat", "mirror"
OP_XFORM = "xform"
OP_SKETCH, OP_PROJECT = "sketch", "project"


# ─── Cardinal directions for planar face classification ─────────────────────
_AXES: List[Tuple[str, Tuple[float, float, float]]] = [
    ("+X", (+1.0, 0.0, 0.0)),
    ("-X", (-1.0, 0.0, 0.0)),
    ("+Y", (0.0, +1.0, 0.0)),
    ("-Y", (0.0, -1.0, 0.0)),
    ("+Z", (0.0, 0.0, +1.0)),
    ("-Z", (0.0, 0.0, -1.0)),
]
_AXIS_TOL = 0.985  # ~10° tolerance for "aligned with this axis"


# ─── Descriptor record ──────────────────────────────────────────────────────
@dataclass(frozen=True)
class Descriptor:
    """Mirror of the JS Descriptor shape. Hashable + JSON-able."""
    kind:    str
    feature: str
    op_tag:  str
    part:    str
    parents: Tuple["Descriptor", ...] = field(default_factory=tuple)

    def to_dict(self) -> dict:
        """Serialise to the exact wire shape the JS resolver consumes."""
        return {
            "kind":    self.kind,
            "feature": self.feature,
            "opTag":   self.op_tag,
            "part":    self.part,
            "parents": [p.to_dict() for p in self.parents],
        }

    def canonical(self) -> str:
        """Canonical string — must match lib/document/descriptor.js stringify()."""
        head = f"{self.kind}:{self.feature}:{self.op_tag}:{self.part}"
        if self.parents:
            head += "(" + ",".join(p.canonical() for p in self.parents) + ")"
        return head


def face(feature: str, op_tag: str, part: str, parents: Iterable[Descriptor] = ()) -> Descriptor:
    return Descriptor("face",   feature, op_tag, str(part), tuple(parents))


def edge(feature: str, op_tag: str, part: str, parents: Iterable[Descriptor] = ()) -> Descriptor:
    return Descriptor("edge",   feature, op_tag, str(part), tuple(parents))


def vertex(feature: str, op_tag: str, part: str, parents: Iterable[Descriptor] = ()) -> Descriptor:
    return Descriptor("vertex", feature, op_tag, str(part), tuple(parents))


# ─── Geometry helpers ───────────────────────────────────────────────────────

def _round_vec(v: Any, digits: int = 4) -> List[float]:
    """Vec3 → list of three rounded floats. Accepts build123d Vector or tuple."""
    if v is None:
        return [0.0, 0.0, 0.0]
    try:
        return [round(float(v.X), digits), round(float(v.Y), digits), round(float(v.Z), digits)]
    except AttributeError:
        try:
            return [round(float(v.x), digits), round(float(v.y), digits), round(float(v.z), digits)]
        except AttributeError:
            return [round(float(c), digits) for c in v]


def _normalise(v: Tuple[float, float, float]) -> Tuple[float, float, float]:
    x, y, z = v
    n = math.sqrt(x * x + y * y + z * z) or 1.0
    return (x / n, y / n, z / n)


def _classify_direction(v: Any) -> Optional[str]:
    """Return '+X', '-Z', etc. for vectors within ~10° of a cardinal axis, else None."""
    if v is None:
        return None
    try:
        comp = (float(v.X), float(v.Y), float(v.Z))
    except AttributeError:
        try:
            comp = (float(v.x), float(v.y), float(v.z))
        except AttributeError:
            comp = (float(v[0]), float(v[1]), float(v[2]))
    n = _normalise(comp)
    best_tag, best_dot = None, -1.0
    for tag, axis in _AXES:
        d = n[0] * axis[0] + n[1] * axis[1] + n[2] * axis[2]
        if d > best_dot:
            best_dot = d
            best_tag = tag
    return best_tag if best_dot >= _AXIS_TOL else None


def _surface_type(face_obj: Any) -> str:
    """Map build123d's `geom_type` string → contract's surfaceType vocabulary."""
    try:
        gt = str(getattr(face_obj, "geom_type", "")).upper()
    except Exception:
        gt = ""
    if "PLANE"  in gt: return "planar"
    if "CYL"    in gt: return "cylindrical"
    if "SPHERE" in gt: return "spherical"
    if "CONE"   in gt: return "conical"
    if "TORUS"  in gt: return "toroidal"
    return "other"


def _face_normal(face_obj: Any) -> Any:
    """Normal at the face centroid. Handles build123d's varying signatures."""
    try:
        return face_obj.normal_at()
    except TypeError:
        # Older API requires a point argument
        try:
            return face_obj.normal_at(face_obj.center())
        except Exception:
            return None
    except Exception:
        return None


def _face_center(face_obj: Any) -> Any:
    try:
        return face_obj.center()
    except Exception:
        try:
            return face_obj.position
        except Exception:
            return None


def _face_area(face_obj: Any) -> float:
    try:
        return float(face_obj.area)
    except Exception:
        return 0.0


def _edge_position_mid(edge_obj: Any) -> Any:
    try:
        return edge_obj.position_at(0.5)
    except Exception:
        try:
            return edge_obj.center()
        except Exception:
            return None


def _edge_tangent_mid(edge_obj: Any) -> Any:
    try:
        return edge_obj.tangent_at(0.5)
    except Exception:
        return None


def _edge_length(edge_obj: Any) -> float:
    try:
        return float(edge_obj.length)
    except Exception:
        return 0.0


def _edge_closed(edge_obj: Any) -> bool:
    try:
        return bool(edge_obj.is_closed)
    except Exception:
        try:
            return bool(getattr(edge_obj, "Closed", False))
        except Exception:
            return False


# ─── Entry builders ─────────────────────────────────────────────────────────

def _face_entry(face_obj: Any, descriptor: Descriptor) -> dict:
    return {
        "descriptor":     descriptor.to_dict(),
        "centerRounded":  _round_vec(_face_center(face_obj), 2),
        "normalRounded":  _round_vec(_face_normal(face_obj), 4),
        "area":           round(_face_area(face_obj), 4),
        "surfaceType":    _surface_type(face_obj),
    }


def _edge_entry(edge_obj: Any, descriptor: Descriptor) -> dict:
    return {
        "descriptor":     descriptor.to_dict(),
        "centerRounded":  _round_vec(_edge_position_mid(edge_obj), 2),
        "tangentRounded": _round_vec(_edge_tangent_mid(edge_obj), 4),
        "length":         round(_edge_length(edge_obj), 4),
        "closed":         _edge_closed(edge_obj),
    }


# ─── Per-op naming functions ────────────────────────────────────────────────

def name_box(feature_id: str, body: Any) -> dict:
    """Classify the 6 planar faces of a Box by their cardinal normal direction.

    For non-axis-aligned boxes (built then rotated) the classifier falls back
    to ordinal tagging so descriptors stay stable across rebuilds.
    """
    faces_out: List[dict] = []
    used: dict[str, int] = {}
    for f in body.faces():
        tag = _classify_direction(_face_normal(f))
        if tag is None:
            # Non-axis face — give it a stable ordinal so descriptors stay unique
            ord_idx = used.get("planar", 0)
            tag = f"planar[{ord_idx}]"
            used["planar"] = ord_idx + 1
        else:
            # The 6 cardinal faces should each appear exactly once
            if tag in used:
                used[tag] += 1
                tag = f"{tag}[{used[tag]}]"
            else:
                used[tag] = 1
        faces_out.append(_face_entry(f, face(feature_id, OP_BOX, tag)))

    edges_out: List[dict] = []
    used_e: dict[str, int] = {}
    for e in body.edges():
        # Box edges sit between two cardinal faces — name by the pair of
        # adjacent face directions. Approximated by snapping the edge's
        # midpoint to a face combination — for v1 just use an ordinal index.
        i = used_e.get("e", 0)
        used_e["e"] = i + 1
        edges_out.append(_edge_entry(e, edge(feature_id, OP_BOX, f"e[{i}]")))

    return {
        "featureId": feature_id,
        "faces":     faces_out,
        "edges":     edges_out,
        "vertices":  [],
    }


def name_cylinder(feature_id: str, body: Any) -> dict:
    faces_out: List[dict] = []
    side_idx = 0
    for f in body.faces():
        st = _surface_type(f)
        if st == "planar":
            n = _classify_direction(_face_normal(f))
            tag = "top" if n == "+Z" else "bottom" if n == "-Z" else f"cap[{side_idx}]"
            if n is None: side_idx += 1
        elif st == "cylindrical":
            tag = "lateral"
        else:
            tag = f"face[{side_idx}]"; side_idx += 1
        faces_out.append(_face_entry(f, face(feature_id, OP_CYL, tag)))

    edges_out: List[dict] = []
    ring_idx = 0
    for e in body.edges():
        # Closed circles are the rings; open edges are the seams of the lateral surface
        if _edge_closed(e):
            tag = "top-ring" if ring_idx == 0 else "bottom-ring" if ring_idx == 1 else f"ring[{ring_idx}]"
            ring_idx += 1
        else:
            tag = "seam"
        edges_out.append(_edge_entry(e, edge(feature_id, OP_CYL, tag)))

    return {
        "featureId": feature_id,
        "faces":     faces_out,
        "edges":     edges_out,
        "vertices":  [],
    }


def name_sphere(feature_id: str, body: Any) -> dict:
    return {
        "featureId": feature_id,
        "faces":     [_face_entry(f, face(feature_id, OP_SPHERE, "surface")) for f in body.faces()],
        "edges":     [_edge_entry(e, edge(feature_id, OP_SPHERE, f"seam[{i}]")) for i, e in enumerate(body.edges())],
        "vertices":  [],
    }


def name_torus(feature_id: str, body: Any) -> dict:
    return {
        "featureId": feature_id,
        "faces":     [_face_entry(f, face(feature_id, OP_TORUS, "tube")) for f in body.faces()],
        "edges":     [_edge_entry(e, edge(feature_id, OP_TORUS, f"seam[{i}]")) for i, e in enumerate(body.edges())],
        "vertices":  [],
    }


def name_extrude(feature_id: str, body: Any, sketch_feature_id: Optional[str] = None) -> dict:
    """Extrusion: identify start/end caps by ±Z normal; sides are everything else."""
    faces_out: List[dict] = []
    side_idx = 0
    for f in body.faces():
        st = _surface_type(f)
        if st == "planar":
            n = _classify_direction(_face_normal(f))
            tag = "end" if n == "+Z" else "start" if n == "-Z" else f"side[{side_idx}]"
            if n is None: side_idx += 1
        else:
            tag = f"side[{side_idx}]"; side_idx += 1
        faces_out.append(_face_entry(f, face(feature_id, OP_EXTRUDE, tag)))

    edges_out: List[dict] = []
    for i, e in enumerate(body.edges()):
        edges_out.append(_edge_entry(e, edge(feature_id, OP_EXTRUDE, f"e[{i}]")))

    return {
        "featureId": feature_id,
        "faces":     faces_out,
        "edges":     edges_out,
        "vertices":  [],
    }


def name_revolve(feature_id: str, body: Any) -> dict:
    """Revolve: classify start/end caps when revolution_arc < 360; everything else is lateral."""
    faces_out: List[dict] = []
    lat_idx = 0
    for f in body.faces():
        st = _surface_type(f)
        if st == "planar":
            tag = f"cap[{lat_idx}]"; lat_idx += 1
        else:
            tag = "lateral"
        faces_out.append(_face_entry(f, face(feature_id, OP_REVOLVE, tag)))
    edges_out: List[dict] = []
    for i, e in enumerate(body.edges()):
        edges_out.append(_edge_entry(e, edge(feature_id, OP_REVOLVE, f"e[{i}]")))
    return {
        "featureId": feature_id,
        "faces":     faces_out,
        "edges":     edges_out,
        "vertices":  [],
    }


def _emit_passthrough_face(f: Any, feature_id: str, op_tag: str,
                            used: dict, parents: List[Descriptor]) -> dict:
    """Re-emit a surviving original face under a new feature/op, classifying by
    cardinal direction. Falls back to ordinal `face[i]` when not cardinal.

    `used` is a counter dict mutated in-place to keep `part` tags unique within
    the current feature.
    """
    n = _classify_direction(_face_normal(f))
    if n is not None:
        if n in used:
            used[n] += 1
            part = f"{n}[{used[n]}]"
        else:
            used[n] = 0
            part = n
    else:
        ord_idx = used.get("_planar", 0)
        used["_planar"] = ord_idx + 1
        st = _surface_type(f)
        part = f"{st}[{ord_idx}]"
    return _face_entry(f, face(feature_id, op_tag, part, parents))


def _orig_part_for(f: Any) -> str:
    """Return the `part` tag the parent op would have given this face.

    Used when emitting `inner-<parentTag>` for Shell — we don't have direct
    access to the parent descriptors per-face, so we infer the parent's part
    label from the face's cardinal normal direction. Cylindrical / non-cardinal
    faces fall back to their surface type.
    """
    n = _classify_direction(_face_normal(f))
    if n is not None:
        return n
    return _surface_type(f)


def name_chamfer(feature_id: str, body: Any, parent_descriptors: List[Descriptor] = None) -> dict:
    """Chamfer: planar non-cardinal faces are bevels; cardinal faces pass through.

    Heuristic: an axis-aligned Box has six faces whose normals align with
    +/-X, +/-Y, +/-Z. A chamfer replaces an edge with a planar bevel face
    whose normal is the bisector of two adjacent box-face normals — so the
    bevel's normal is NOT cardinal. We use `_classify_direction` (10° tol)
    to split surviving box faces from new bevel faces.

    Limitations:
    - If the parent body wasn't axis-aligned, surviving faces also won't be
      cardinal and will be misclassified as bevels. Acceptable for v1; the
      corpus only chamfers axis-aligned boxes.
    - Curved bevels (e.g. chamfering a fillet) aren't handled — those faces
      are passed through with their surface type as a fallback tag.
    """
    parents = list(parent_descriptors or [])
    parent0 = [parents[0]] if parents else []

    # First pass: classify faces into bevels vs survivors.
    bevels: List[Tuple[Any, Tuple[float, float, float]]] = []
    survivors: List[Any] = []
    for f in body.faces():
        st = _surface_type(f)
        n = _classify_direction(_face_normal(f))
        if st == "planar" and n is None:
            bevels.append((f, _centroid_xyz(f)))
        else:
            survivors.append(f)

    # Sort bevels by centroid for stable ordinal indexing.
    bevels.sort(key=lambda t: t[1])

    faces_out: List[dict] = []
    if len(bevels) == 1:
        # Single bevel — no index suffix needed
        f, _ = bevels[0]
        faces_out.append(_face_entry(f, face(feature_id, OP_CHAMFER, "bevel", parent0)))
    else:
        for i, (f, _) in enumerate(bevels):
            # First bevel gets bare 'bevel' so the contract substring search
            # finds it; siblings get explicit ordinal suffixes.
            tag = "bevel" if i == 0 else f"bevel[{i}]"
            faces_out.append(_face_entry(f, face(feature_id, OP_CHAMFER, tag, parent0)))

    # Survivors pass through under the chamfer feature.
    used: dict = {}
    for f in survivors:
        faces_out.append(_emit_passthrough_face(f, feature_id, OP_CHAMFER, used, parent0))

    edges_out: List[dict] = []
    for i, e in enumerate(body.edges()):
        edges_out.append(_edge_entry(e, edge(feature_id, OP_CHAMFER, f"e[{i}]", parent0)))

    return {
        "featureId": feature_id,
        "faces":     faces_out,
        "edges":     edges_out,
        "vertices":  [],
    }


def name_shell(feature_id: str, body: Any, parent_descriptors: List[Descriptor] = None) -> dict:
    """Shell: per cardinal direction pair the outer + inner planar faces.

    Heuristic: a hollow-box shell produces two planar faces per cardinal
    normal — one outer (further from the body centroid) and one inner
    (closer). The inner face is tagged `inner-<dir>`; the outer is passed
    through with its cardinal direction tag.

    Limitations:
    - Only handles cardinal-direction planar pairs. Faces whose normals
      aren't axis-aligned (filleted edges shelled, etc.) are emitted with
      a generic `inner-<surfaceType>[i]` / passthrough fallback.
    - The "closer to body centroid" test assumes a convex outer hull; a
      non-convex outer shape can mis-classify.
    """
    parents = list(parent_descriptors or [])
    parent0 = [parents[0]] if parents else []

    # Compute body centroid via face centroid average (cheap, deterministic).
    all_faces = list(body.faces())
    if not all_faces:
        return {"featureId": feature_id, "faces": [], "edges": [], "vertices": []}
    cx = sum(_centroid_xyz(f)[0] for f in all_faces) / len(all_faces)
    cy = sum(_centroid_xyz(f)[1] for f in all_faces) / len(all_faces)
    cz = sum(_centroid_xyz(f)[2] for f in all_faces) / len(all_faces)

    # Bucket planar faces by cardinal direction.
    by_dir: dict[str, List[Tuple[Any, float]]] = {}
    non_cardinal: List[Any] = []
    for f in all_faces:
        st = _surface_type(f)
        n = _classify_direction(_face_normal(f))
        if st == "planar" and n is not None:
            c = _centroid_xyz(f)
            dist = math.sqrt((c[0]-cx)**2 + (c[1]-cy)**2 + (c[2]-cz)**2)
            by_dir.setdefault(n, []).append((f, dist))
        else:
            non_cardinal.append(f)

    faces_out: List[dict] = []
    for direction, entries in by_dir.items():
        # Sort by distance to centroid: smaller-dist faces are inner.
        entries.sort(key=lambda t: t[1])
        if len(entries) >= 2:
            inner_f = entries[0][0]
            faces_out.append(_face_entry(inner_f, face(feature_id, OP_SHELL,
                                                       f"inner-{direction}", parent0)))
            # Remaining faces pass through with their cardinal direction tag.
            for i, (f, _) in enumerate(entries[1:]):
                part = direction if i == 0 else f"{direction}[{i}]"
                faces_out.append(_face_entry(f, face(feature_id, OP_SHELL, part, parent0)))
        else:
            # Only one face with this normal — passthrough as the outer face.
            f, _ = entries[0]
            faces_out.append(_face_entry(f, face(feature_id, OP_SHELL, direction, parent0)))

    # Non-cardinal / curved faces: deterministic ordinal under surface type.
    by_st: dict[str, int] = {}
    for f in non_cardinal:
        st = _surface_type(f)
        i = by_st.get(st, 0)
        by_st[st] = i + 1
        # Use an `inner-<surfaceType>[i]` tag — these are typically the inner
        # offset of curved surfaces. Acceptable v1 fallback.
        faces_out.append(_face_entry(f, face(feature_id, OP_SHELL,
                                             f"inner-{st}[{i}]", parent0)))

    edges_out: List[dict] = []
    for i, e in enumerate(body.edges()):
        edges_out.append(_edge_entry(e, edge(feature_id, OP_SHELL, f"e[{i}]", parent0)))

    return {
        "featureId": feature_id,
        "faces":     faces_out,
        "edges":     edges_out,
        "vertices":  [],
    }


def _cyl_radius_axis(face_obj: Any) -> Tuple[Optional[float], Optional[str]]:
    """Best-effort (radius, axis-dir) extraction for a cylindrical face.

    Returns (None, None) when the underlying surface info isn't accessible.
    Used by `name_hole` to rank bore-side vs counterbore-side by radius and
    to detect the hole's drilling axis.
    """
    radius = None
    axis = None
    # Try common build123d / OCCT introspection paths.
    try:
        radius = float(face_obj.radius)
    except Exception:
        pass
    try:
        # build123d Face has `geometry` or `surface` access; try axis_of_revolution
        ax = getattr(face_obj, "axis_of_revolution", None) or getattr(face_obj, "axis", None)
        if ax is not None:
            d = getattr(ax, "direction", ax)
            axis = _classify_direction(d)
    except Exception:
        pass
    return radius, axis


def name_hole(feature_id: str, body: Any, parent_descriptors: List[Descriptor] = None,
              hole_params: Optional[dict] = None) -> dict:
    """Hole: split the result body into bore / counterbore / countersink / bottom.

    Heuristic, no params required:
      - Cylindrical faces: the wider one (if there are two) is `counterbore-side`,
        the narrower is `bore-side`. A single cylindrical face is `bore-side`.
      - Conical face: `countersink-cone`.
      - Planar faces whose normals are NOT one of the body's "outer" cardinal
        directions are step `bottom` faces. Specifically: faces whose centroids
        are interior to the body's outer bbox along the hole axis (i.e. not on
        the outer envelope) are bottoms.
      - Other planar faces are surviving original body faces; pass them through
        with their cardinal direction.

    Limitations:
      - We don't have the hole's drilling axis directly; we infer it from the
        cylindrical face's axis_of_revolution when accessible, else default to
        +Z (the kernel-side convention for Hole).
      - For a counterbore (two cylinders), only one annular planar `bottom`
        face is expected; through-holes have no `bottom`.
      - We don't currently differentiate multiple holes on one body — all
        bore/counterbore faces share the same tag.
    """
    parents = list(parent_descriptors or [])
    parent0 = [parents[0]] if parents else []

    all_faces = list(body.faces())
    planar_faces = []
    cyl_faces = []
    cone_faces = []
    other_faces = []
    for f in all_faces:
        st = _surface_type(f)
        if st == "planar":
            planar_faces.append(f)
        elif st == "cylindrical":
            cyl_faces.append(f)
        elif st == "conical":
            cone_faces.append(f)
        else:
            other_faces.append(f)

    # Rank cylindrical faces by radius (descending). Larger = counterbore-side.
    cyl_info: List[Tuple[Any, Optional[float]]] = []
    for f in cyl_faces:
        r, _ax = _cyl_radius_axis(f)
        cyl_info.append((f, r))
    # Sort by radius descending; faces with unknown radius go last but stably.
    cyl_info.sort(key=lambda t: (-(t[1] if t[1] is not None else -1.0), _centroid_xyz(t[0])))

    # Identify body bbox to detect interior-vs-envelope planar faces.
    xs = [_centroid_xyz(f)[0] for f in all_faces]
    ys = [_centroid_xyz(f)[1] for f in all_faces]
    zs = [_centroid_xyz(f)[2] for f in all_faces]
    bx = (min(xs), max(xs)) if xs else (0, 0)
    by = (min(ys), max(ys)) if ys else (0, 0)
    bz = (min(zs), max(zs)) if zs else (0, 0)
    # Tolerance for "centroid lies on the body's outer envelope" (mm).
    env_tol = 1e-3

    faces_out: List[dict] = []

    # Cylindrical surfaces → bore-side / counterbore-side.
    if len(cyl_info) == 1:
        faces_out.append(_face_entry(cyl_info[0][0],
                                     face(feature_id, OP_HOLE, "bore-side", parent0)))
    elif len(cyl_info) >= 2:
        faces_out.append(_face_entry(cyl_info[0][0],
                                     face(feature_id, OP_HOLE, "counterbore-side", parent0)))
        faces_out.append(_face_entry(cyl_info[1][0],
                                     face(feature_id, OP_HOLE, "bore-side", parent0)))
        # Any additional cylinders get ordinal-suffixed bore-side tags.
        for i, (f, _r) in enumerate(cyl_info[2:]):
            faces_out.append(_face_entry(f, face(feature_id, OP_HOLE,
                                                 f"bore-side[{i+1}]", parent0)))

    # Conical surface(s) → countersink-cone.
    for i, f in enumerate(cone_faces):
        tag = "countersink-cone" if i == 0 else f"countersink-cone[{i}]"
        faces_out.append(_face_entry(f, face(feature_id, OP_HOLE, tag, parent0)))

    # Planar surfaces: cardinal envelope faces pass through; interior planar
    # faces (counterbore step bottoms, blind-hole floors) are `bottom`.
    used_pass: dict = {}
    bottom_idx = 0
    for f in planar_faces:
        c = _centroid_xyz(f)
        n = _classify_direction(_face_normal(f))

        # Envelope test: centroid lies on the body's outer bbox face in some
        # cardinal direction matching the face's normal.
        on_envelope = False
        if n == "+X" and abs(c[0] - bx[1]) <= env_tol: on_envelope = True
        elif n == "-X" and abs(c[0] - bx[0]) <= env_tol: on_envelope = True
        elif n == "+Y" and abs(c[1] - by[1]) <= env_tol: on_envelope = True
        elif n == "-Y" and abs(c[1] - by[0]) <= env_tol: on_envelope = True
        elif n == "+Z" and abs(c[2] - bz[1]) <= env_tol: on_envelope = True
        elif n == "-Z" and abs(c[2] - bz[0]) <= env_tol: on_envelope = True
        # The +Z / -Z outer face of a hole-bearing body often has an annular
        # cutout but its overall centroid still sits on bz[1]/bz[0]. Treat any
        # cardinal-normal face on the envelope as an outer (passthrough) face.

        if on_envelope and n is not None:
            # Passthrough outer face with its cardinal direction.
            faces_out.append(_emit_passthrough_face(f, feature_id, OP_HOLE, used_pass, parent0))
        else:
            # Interior planar face = bottom step.
            tag = "bottom" if bottom_idx == 0 else f"bottom[{bottom_idx}]"
            bottom_idx += 1
            faces_out.append(_face_entry(f, face(feature_id, OP_HOLE, tag, parent0)))

    # Anything else (toroidal, other) — generic ordinal fallback.
    for i, f in enumerate(other_faces):
        st = _surface_type(f)
        faces_out.append(_face_entry(f, face(feature_id, OP_HOLE, f"{st}[{i}]", parent0)))

    edges_out: List[dict] = []
    for i, e in enumerate(body.edges()):
        edges_out.append(_edge_entry(e, edge(feature_id, OP_HOLE, f"e[{i}]", parent0)))

    return {
        "featureId": feature_id,
        "faces":     faces_out,
        "edges":     edges_out,
        "vertices":  [],
    }


def name_modify(feature_id: str, body: Any, op_tag: str, parent_descriptors: List[Descriptor] = None) -> dict:
    """Fillet / Chamfer / Shell — derived surfaces wrap their parent descriptors.

    v1 simplification: every modified face on the result body carries the *set*
    of parents from this op rather than computing per-face derivation. This is
    enough to make `qDescendsFrom` queries work correctly for simple cases
    (e.g. "every face derived from the original Box.+X face").
    """
    parent_descriptors = list(parent_descriptors or [])
    faces_out: List[dict] = []
    for i, f in enumerate(body.faces()):
        st = _surface_type(f)
        # Heuristic: planar faces are likely surviving original faces; curved
        # faces are likely the new blend/bevel surfaces. The boundary isn't
        # tight enough for production but matches RealThunder's v1 trade-off.
        if op_tag == OP_FILLET and st in ("cylindrical", "toroidal", "spherical"):
            tag = "blend"
        elif op_tag == OP_CHAMFER and st == "planar":
            tag = "bevel"
        elif op_tag == OP_SHELL and st == "planar":
            tag = "inner"
        else:
            tag = f"face[{i}]"
        faces_out.append(_face_entry(f, face(feature_id, op_tag, tag, parent_descriptors)))

    edges_out: List[dict] = []
    for i, e in enumerate(body.edges()):
        edges_out.append(_edge_entry(e, edge(feature_id, op_tag, f"e[{i}]", parent_descriptors)))

    return {
        "featureId": feature_id,
        "faces":     faces_out,
        "edges":     edges_out,
        "vertices":  [],
    }


def name_boolean(feature_id: str, body: Any, op_tag: str, parent_target: Optional[Descriptor] = None,
                 parent_tools: List[Descriptor] = None) -> dict:
    """Union / Cut / Intersect — every face inherits target + tools as ancestors.

    v1 simplification: we don't attempt to identify which surviving face came
    from the target vs. tool. Every face carries both as parents, which is
    pessimistic but never *wrong* for descendsFrom queries.
    """
    parents = []
    if parent_target is not None: parents.append(parent_target)
    parents.extend(parent_tools or [])

    faces_out: List[dict] = []
    for i, f in enumerate(body.faces()):
        st = _surface_type(f)
        if st == "planar":
            n = _classify_direction(_face_normal(f))
            tag = f"planar[{n or i}]"
        else:
            tag = f"{st}[{i}]"
        faces_out.append(_face_entry(f, face(feature_id, op_tag, tag, parents)))

    edges_out: List[dict] = []
    for i, e in enumerate(body.edges()):
        edges_out.append(_edge_entry(e, edge(feature_id, op_tag, f"e[{i}]", parents)))

    return {
        "featureId": feature_id,
        "faces":     faces_out,
        "edges":     edges_out,
        "vertices":  [],
    }


def _centroid_xyz(face_obj: Any) -> Tuple[float, float, float]:
    """Face centroid as a plain (x, y, z) tuple; (0,0,0) if unavailable."""
    c = _face_center(face_obj)
    if c is None:
        return (0.0, 0.0, 0.0)
    try:
        return (float(c.X), float(c.Y), float(c.Z))
    except AttributeError:
        try:
            return (float(c.x), float(c.y), float(c.z))
        except AttributeError:
            try:
                return (float(c[0]), float(c[1]), float(c[2]))
            except Exception:
                return (0.0, 0.0, 0.0)


def _src_part_for(face_obj: Any) -> str:
    """Cheap stand-in for the original face's `part` tag.

    The kernel doesn't (yet) propagate per-face descriptors from the pattern's
    source feature, so we classify by cardinal-normal direction and fall back
    to the face's surface type. Faces sharing this tag are siblings produced
    by the same source face — they get instance indexes 0..N-1 within the
    group, deterministic from centroid order.
    """
    n = _classify_direction(_face_normal(face_obj))
    if n is not None:
        return n
    return _surface_type(face_obj)


def _principal_axis(centroids: List[Tuple[float, float, float]]) -> Tuple[float, float, float]:
    """Pick the bbox axis with the largest spread among the given centroids.

    A cheap, deterministic stand-in for the pattern's `direction` vector — we
    don't have access to the op parameters inside the namer, so we infer the
    layout axis from the instance positions. Returns a unit vector along
    +X / +Y / +Z (whichever covers the longest span). Ties resolve X > Y > Z.
    """
    if not centroids:
        return (1.0, 0.0, 0.0)
    xs = [c[0] for c in centroids]
    ys = [c[1] for c in centroids]
    zs = [c[2] for c in centroids]
    spans = (max(xs) - min(xs), max(ys) - min(ys), max(zs) - min(zs))
    axis_idx = max(range(3), key=lambda i: spans[i])
    return tuple(1.0 if i == axis_idx else 0.0 for i in range(3))  # type: ignore[return-value]


def _group_centroid(centroids: List[Tuple[float, float, float]]) -> Tuple[float, float, float]:
    if not centroids:
        return (0.0, 0.0, 0.0)
    n = float(len(centroids))
    return (sum(c[0] for c in centroids) / n,
            sum(c[1] for c in centroids) / n,
            sum(c[2] for c in centroids) / n)


def name_linear_pattern(feature_id: str, body: Any,
                        source_descriptors: List[Descriptor] = None) -> dict:
    """Linear pattern: emit `inst[i]-<originalPart>` per instance face.

    Indexing scheme: faces are grouped by `_src_part_for` (cardinal normal
    direction or surface type). Within each group, instances are sorted by
    their centroid's projection onto the group's principal bbox axis — the
    axis with the largest centroid spread, a deterministic stand-in for the
    pattern's `direction` parameter (not visible from inside the namer).
    `i` is then 0..N-1 in ascending projection order.
    """
    source_descriptors = list(source_descriptors or [])
    parent = source_descriptors[0] if source_descriptors else None
    parents = [parent] if parent is not None else []

    # Bucket faces by their source-part tag, preserving build123d iteration order.
    by_src: dict[str, List[Tuple[Any, Tuple[float, float, float]]]] = {}
    for f in body.faces():
        key = _src_part_for(f)
        by_src.setdefault(key, []).append((f, _centroid_xyz(f)))

    # Order each bucket deterministically by projection on the per-group
    # principal axis. Order map: face id() → instance index.
    instance_index: dict[int, int] = {}
    for key, entries in by_src.items():
        centroids = [c for _, c in entries]
        axis = _principal_axis(centroids)
        sortable = []
        for f_obj, c in entries:
            proj = c[0] * axis[0] + c[1] * axis[1] + c[2] * axis[2]
            # Tiebreaker: full centroid tuple so equal projections stay stable.
            sortable.append((proj, c, f_obj))
        sortable.sort(key=lambda t: (round(t[0], 4), t[1]))
        for i, (_p, _c, f_obj) in enumerate(sortable):
            instance_index[id(f_obj)] = i

    faces_out: List[dict] = []
    for f in body.faces():
        src_part = _src_part_for(f)
        i = instance_index.get(id(f), 0)
        tag = f"inst[{i}]-{src_part}"
        faces_out.append(_face_entry(f, face(feature_id, OP_LIN_PAT, tag, parents)))

    edges_out: List[dict] = []
    for i, e in enumerate(body.edges()):
        edges_out.append(_edge_entry(e, edge(feature_id, OP_LIN_PAT, f"e[{i}]", parents)))

    return {
        "featureId": feature_id,
        "faces":     faces_out,
        "edges":     edges_out,
        "vertices":  [],
    }


def name_circular_pattern(feature_id: str, body: Any,
                          source_descriptors: List[Descriptor] = None) -> dict:
    """Circular pattern: `inst[i]-<originalPart>` sorted by angular position.

    Indexing scheme: faces are grouped by `_src_part_for`. Within each group
    the instances' centroids are projected onto the plane perpendicular to
    the group's principal axis (axis of largest spread is the pattern's
    rotation axis for axis-aligned patterns). The instance index `i` is
    assigned 0..N-1 in ascending atan2 order around the group centroid.
    """
    source_descriptors = list(source_descriptors or [])
    parent = source_descriptors[0] if source_descriptors else None
    parents = [parent] if parent is not None else []

    by_src: dict[str, List[Tuple[Any, Tuple[float, float, float]]]] = {}
    for f in body.faces():
        key = _src_part_for(f)
        by_src.setdefault(key, []).append((f, _centroid_xyz(f)))

    instance_index: dict[int, int] = {}
    for key, entries in by_src.items():
        centroids = [c for _, c in entries]
        # Pick the rotation axis as the centroid-spread principal axis. For an
        # axis-aligned circular pattern this is the axis perpendicular to the
        # rotation plane.
        axis = _principal_axis(centroids)
        # Cross-axes (the two perpendicular to `axis`) define the rotation plane.
        ax_idx = axis.index(1.0) if 1.0 in axis else 0
        u_idx, v_idx = [i for i in range(3) if i != ax_idx][:2]
        cg = _group_centroid(centroids)
        sortable = []
        for f_obj, c in entries:
            du = c[u_idx] - cg[u_idx]
            dv = c[v_idx] - cg[v_idx]
            ang = math.atan2(dv, du)
            sortable.append((ang, c, f_obj))
        sortable.sort(key=lambda t: (round(t[0], 6), t[1]))
        for i, (_a, _c, f_obj) in enumerate(sortable):
            instance_index[id(f_obj)] = i

    faces_out: List[dict] = []
    for f in body.faces():
        src_part = _src_part_for(f)
        i = instance_index.get(id(f), 0)
        tag = f"inst[{i}]-{src_part}"
        faces_out.append(_face_entry(f, face(feature_id, OP_CIR_PAT, tag, parents)))

    edges_out: List[dict] = []
    for i, e in enumerate(body.edges()):
        edges_out.append(_edge_entry(e, edge(feature_id, OP_CIR_PAT, f"e[{i}]", parents)))

    return {
        "featureId": feature_id,
        "faces":     faces_out,
        "edges":     edges_out,
        "vertices":  [],
    }


def name_path_pattern(feature_id: str, body: Any,
                      source_descriptors: List[Descriptor] = None) -> dict:
    """Path pattern: `inst[i]-<originalPart>` in build123d iteration order.

    Indexing scheme (v1 fallback): the namer doesn't have access to the path
    curve, so true arclength-based ordering isn't computable here. Instead we
    rely on build123d's deterministic face iteration order within each
    src-part group — TopExp_Explorer walks the shape in a stable order across
    rebuilds for unchanged topology, which is enough to keep descriptors
    survivable. If a later harness pass propagates the path curve, swap the
    body of this function for an arclength projection.
    """
    source_descriptors = list(source_descriptors or [])
    parent = source_descriptors[0] if source_descriptors else None
    parents = [parent] if parent is not None else []

    counters: dict[str, int] = {}
    faces_out: List[dict] = []
    for f in body.faces():
        src_part = _src_part_for(f)
        i = counters.get(src_part, 0)
        counters[src_part] = i + 1
        tag = f"inst[{i}]-{src_part}"
        faces_out.append(_face_entry(f, face(feature_id, OP_PATH_PAT, tag, parents)))

    edges_out: List[dict] = []
    for i, e in enumerate(body.edges()):
        edges_out.append(_edge_entry(e, edge(feature_id, OP_PATH_PAT, f"e[{i}]", parents)))

    return {
        "featureId": feature_id,
        "faces":     faces_out,
        "edges":     edges_out,
        "vertices":  [],
    }


def name_mirror(feature_id: str, body: Any,
                source_descriptors: List[Descriptor] = None) -> dict:
    """Mirror: `mir-<originalPart>` for every mirrored face. No instance index.

    A mirror produces one mirrored copy of each source face — the contract
    drops `inst[i]` entirely. We tag each face with the source-part stand-in
    from `_src_part_for`. Faces that share the same cardinal direction after
    mirroring get an ordinal suffix so descriptors stay unique on the body.
    """
    source_descriptors = list(source_descriptors or [])
    parent = source_descriptors[0] if source_descriptors else None
    parents = [parent] if parent is not None else []

    used: dict[str, int] = {}
    faces_out: List[dict] = []
    for f in body.faces():
        src_part = _src_part_for(f)
        tag_base = f"mir-{src_part}"
        if tag_base in used:
            used[tag_base] += 1
            tag = f"{tag_base}[{used[tag_base]}]"
        else:
            used[tag_base] = 0
            tag = tag_base
        faces_out.append(_face_entry(f, face(feature_id, OP_MIRROR, tag, parents)))

    edges_out: List[dict] = []
    for i, e in enumerate(body.edges()):
        edges_out.append(_edge_entry(e, edge(feature_id, OP_MIRROR, f"e[{i}]", parents)))

    return {
        "featureId": feature_id,
        "faces":     faces_out,
        "edges":     edges_out,
        "vertices":  [],
    }


def name_xform(feature_id: str, body: Any,
               parent_descriptors: List[Descriptor] = None) -> dict:
    """Transform (Move / Rotate / Scale): per the contract Transform row,
    descriptors pass through verbatim — only `feature` is rewritten to the
    transform's id and `parents[0]` carries the original.

    v1 implementation: we don't have direct per-face mapping from the parent
    body to the transformed body, so we walk the result's faces and re-tag
    them using the same cardinal-direction classification a primitive namer
    would use, then attach the first parent descriptor as `parents[0]`. This
    is enough for Move + uniform Scale (translation/uniform scaling preserve
    cardinal orientation). Rotate may permute cardinal tags (a +X face
    becomes +Y after Rz=90°) — documented limitation; face count + kind
    still survive.

    Defensive: if `parent_descriptors` is empty, falls back to `name_generic`
    with op_tag=OP_XFORM so output is still well-formed.
    """
    parents = list(parent_descriptors or [])
    if not parents:
        return name_generic(feature_id, body, OP_XFORM)
    parent0 = [parents[0]]

    # Classify each face the same way name_box would so the cardinal tags
    # propagate. Curved / non-cardinal faces fall through to their surface
    # type with a stable ordinal.
    used: dict = {}
    faces_out: List[dict] = []
    for f in body.faces():
        st = _surface_type(f)
        n = _classify_direction(_face_normal(f))
        if st == "planar" and n is not None:
            if n in used:
                used[n] += 1
                part = f"{n}[{used[n]}]"
            else:
                used[n] = 0
                part = n
        else:
            ord_idx = used.get(f"_{st}", 0)
            used[f"_{st}"] = ord_idx + 1
            part = f"{st}[{ord_idx}]"
        faces_out.append(_face_entry(f, face(feature_id, OP_XFORM, part, parent0)))

    edges_out: List[dict] = []
    for i, e in enumerate(body.edges()):
        edges_out.append(_edge_entry(e, edge(feature_id, OP_XFORM, f"e[{i}]", parent0)))

    return {
        "featureId": feature_id,
        "faces":     faces_out,
        "edges":     edges_out,
        "vertices":  [],
    }


def name_offset3d(feature_id: str, body: Any,
                  parent_descriptors: List[Descriptor] = None) -> dict:
    """Offset3D: emit per-face `face(feature_id, OP_OFFSET, classified_part, ...)`.

    The contract doesn't give Offset its own table row; treat it like Shell
    on the whole body — every face is a passthrough of the parent's face
    (offset to a new position) with the original cardinal direction. Acts as
    near-identity on cardinal classification because offset preserves face
    normals (in the small-offset regime).

    Defensive: missing `parent_descriptors` → falls back to name_generic
    with op_tag=OP_OFFSET.
    """
    parents = list(parent_descriptors or [])
    if not parents:
        return name_generic(feature_id, body, OP_OFFSET)
    parent0 = [parents[0]]

    used: dict = {}
    faces_out: List[dict] = []
    for f in body.faces():
        st = _surface_type(f)
        n = _classify_direction(_face_normal(f))
        if st == "planar" and n is not None:
            if n in used:
                used[n] += 1
                part = f"{n}[{used[n]}]"
            else:
                used[n] = 0
                part = n
        else:
            ord_idx = used.get(f"_{st}", 0)
            used[f"_{st}"] = ord_idx + 1
            part = f"{st}[{ord_idx}]"
        faces_out.append(_face_entry(f, face(feature_id, OP_OFFSET, part, parent0)))

    edges_out: List[dict] = []
    for i, e in enumerate(body.edges()):
        edges_out.append(_edge_entry(e, edge(feature_id, OP_OFFSET, f"e[{i}]", parent0)))

    return {
        "featureId": feature_id,
        "faces":     faces_out,
        "edges":     edges_out,
        "vertices":  [],
    }


def name_generic(feature_id: str, body: Any, op_tag: str) -> dict:
    """Fallback for any op without a dedicated namer (Sweep, Loft, Mirror, …).

    Tags faces with `<surfaceType>[<ordinal>]` and edges with `e[<ordinal>]`.
    Stable across rebuilds for unchanged topology.
    """
    faces_out: List[dict] = []
    by_st: dict[str, int] = {}
    for f in body.faces():
        st = _surface_type(f)
        idx = by_st.get(st, 0)
        by_st[st] = idx + 1
        faces_out.append(_face_entry(f, face(feature_id, op_tag, f"{st}[{idx}]")))

    edges_out: List[dict] = []
    for i, e in enumerate(body.edges()):
        edges_out.append(_edge_entry(e, edge(feature_id, op_tag, f"e[{i}]")))

    return {
        "featureId": feature_id,
        "faces":     faces_out,
        "edges":     edges_out,
        "vertices":  [],
    }


# ─── Dispatch ───────────────────────────────────────────────────────────────

# Tag inference from common build123d / OCCT type names. The harness already
# knows the feature type from the v4 emit; this dispatcher is for cases where
# only the body and op tag are available.
_TYPE_DISPATCH = {
    "Box":             (OP_BOX,    name_box),
    "Cylinder":        (OP_CYL,    name_cylinder),
    "Sphere":          (OP_SPHERE, name_sphere),
    "Torus":           (OP_TORUS,  name_torus),
    "Extrude":         (OP_EXTRUDE, name_extrude),
    "Revolve":         (OP_REVOLVE, name_revolve),
    "Sweep":           (OP_SWEEP,   None),
    "Loft":            (OP_LOFT,    None),
    "Helix":           (OP_XFORM,   None),
    "Fillet":          (OP_FILLET,  None),
    "Chamfer":         (OP_CHAMFER, name_chamfer),
    "Shell":           (OP_SHELL,   name_shell),
    "Draft":           (OP_DRAFT,   None),
    "Hole":            (OP_HOLE,    name_hole),
    "Thread":          (OP_THREAD,  None),
    "Offset3D":        (OP_OFFSET,  name_offset3d),
    "Union":           (OP_UNION,     None),
    "Cut":             (OP_CUT,       None),
    "Intersect":       (OP_INTERSECT, None),
    "Split":           (OP_SPLIT,     None),
    "LinearPattern":   (OP_LIN_PAT,   name_linear_pattern),
    "CircularPattern": (OP_CIR_PAT,   name_circular_pattern),
    "PathPattern":     (OP_PATH_PAT,  name_path_pattern),
    "Mirror":          (OP_MIRROR,    name_mirror),
    "Move":            (OP_XFORM, name_xform),
    "Rotate":          (OP_XFORM, name_xform),
    "Scale":           (OP_XFORM, name_xform),
    "Sketch":          (OP_SKETCH,  None),
    "SketchOnFace":    (OP_SKETCH,  None),
    "ProjectEdges":    (OP_PROJECT, None),
}


def name_from_feature_type(feature_id: str, feature_type: str, body: Any,
                            parent_descriptors: List[Descriptor] = None) -> dict:
    """Top-level dispatcher: pick the right namer based on the v4 feature type.

    `parent_descriptors` carries the descriptors from upstream features so
    derived faces can reference them. Empty for primitives.
    """
    op_tag, fn = _TYPE_DISPATCH.get(feature_type, (OP_XFORM, None))

    if fn is not None:
        # Pattern / mirror / specialised modifier namers consume the upstream
        # source descriptors so derived faces can cite their lineage. Other
        # namers ignore them.
        if op_tag in (OP_LIN_PAT, OP_CIR_PAT, OP_PATH_PAT, OP_MIRROR,
                      OP_CHAMFER, OP_SHELL, OP_HOLE,
                      OP_XFORM, OP_OFFSET):
            return fn(feature_id, body, parent_descriptors)
        return fn(feature_id, body)
    # Modify / boolean / transform / pattern fall through to the helpers.
    if op_tag in (OP_FILLET, OP_CHAMFER, OP_SHELL, OP_DRAFT, OP_HOLE, OP_OFFSET):
        return name_modify(feature_id, body, op_tag, parent_descriptors)
    if op_tag in (OP_UNION, OP_CUT, OP_INTERSECT, OP_SPLIT):
        parent_target = parent_descriptors[0] if parent_descriptors else None
        parent_tools  = (parent_descriptors or [])[1:]
        return name_boolean(feature_id, body, op_tag, parent_target, parent_tools)
    return name_generic(feature_id, body, op_tag)
