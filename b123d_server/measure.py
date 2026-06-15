"""
Measure API — programmatic query layer over the last-built document.

Wire shape mirrors tracker/07-measure-api.md §"Endpoint shape":

    POST /measure
    { "queries": [ { "type": "bbox", "featureId": "box_x" }, ... ] }
    → { "ok": true, "results": [ <typed result>, ... ], "kernelVersion": {...} }

This module is the dispatch + per-type evaluator. Server.py owns the route
plumbing and the process-local cache of the last execution's namespace +
result dict. We accept those as arguments here so the module stays a pure
function of (queries, namespace, result) — testable without Flask.

Conventions:

  * Per-query failures don't poison the batch — each result is wrapped in
    try/except and surfaces as `{ok: false, error: "..."}`.
  * Units are mm / mm² / mm³ throughout. `mass` is g, with density in g/cm³.
  * `featureId` resolution leans on `result.feature_bodies` (the v4 emitter
    writes that map), then falls back to `n_<fid>` in the namespace.
  * Descriptor resolution uses the topology v4 entries' canonical strings,
    which match `harness._descriptor_canonical` / JS `stringify(descriptor)`.
  * Lazy imports of build123d / OCP so a missing kernel dep produces a
    legible error per-query rather than crashing the whole batch.
"""

from __future__ import annotations

import math
import random
from typing import Any, Callable, Optional


# ─── Body / descriptor resolution ──────────────────────────────────────────


def _resolve_body(feature_id: str, namespace: dict, result: dict) -> Any:
    """Look up the build123d body for a feature.

    Resolution order:
      1. `result.feature_bodies[feature_id]` (v4 emitter convention) → the
         variable name in `namespace` that holds the body.
      2. `n_<feature_id>` fallback (legacy / v3-style naming).
      3. `feature_id` itself as a namespace key (test-DSL convention — the
         naming corpus's `build_doc()` uses fid as the var name).

    Raises `KeyError` with a diagnostic message when nothing matches so the
    per-query try/except can surface a sensible error.
    """
    if not feature_id:
        raise KeyError("featureId is empty")
    feature_bodies = (result or {}).get("feature_bodies") or {}
    var_name = feature_bodies.get(feature_id)
    candidates = [v for v in (var_name, f"n_{feature_id}", feature_id) if v]
    for name in candidates:
        body = namespace.get(name)
        if body is not None:
            return body
    raise KeyError(f"feature '{feature_id}' not found in namespace (tried {candidates})")


def _topology_entries(result: dict) -> list:
    """Flatten the cached topology nodes into one face+edge entry list.

    The harness stashes the most recent topology under `result['__topology__']`
    when the server populates the cache; older callers may pass the topology
    directly under the result. Either path returns the entries flat:

        [ {"kind": "face", "descriptor": {...}, "node": <node dict>,
           "index": <int>, "body_var": <str>}, ... ]
    """
    topology = result.get("__topology__") or result.get("topology") or {}
    nodes = topology.get("nodes") or []
    feature_bodies = (result or {}).get("feature_bodies") or {}
    out: list = []
    for node in nodes:
        feature_id = node.get("featureId")
        body_var = feature_bodies.get(feature_id) or (f"n_{feature_id}" if feature_id else None)
        for i, entry in enumerate(node.get("faces") or []):
            out.append({
                "kind":     "face",
                "entry":    entry,
                "node":     node,
                "index":    i,
                "body_var": body_var,
                "featureId": feature_id,
            })
        for i, entry in enumerate(node.get("edges") or []):
            out.append({
                "kind":     "edge",
                "entry":    entry,
                "node":     node,
                "index":    i,
                "body_var": body_var,
                "featureId": feature_id,
            })
    return out


def _descriptor_canonical(d: Optional[dict]) -> str:
    """Match `harness._descriptor_canonical` so lookups round-trip exactly.

    Duplicated here (not imported) to keep this module independent of the
    harness module — measure.py can be unit-tested without the harness
    sys.path dance.
    """
    if not d:
        return ""
    head = f"{d.get('kind','')}:{d.get('feature','')}:{d.get('opTag','')}:{d.get('part','')}"
    parents = d.get("parents") or []
    if parents:
        head += "(" + ",".join(_descriptor_canonical(p) for p in parents) + ")"
    return head


def _resolve_descriptor(canonical: str, namespace: dict, result: dict) -> tuple:
    """Find the build123d face/edge object for a descriptor canonical string.

    Returns `(kind, occt_shape)` where `kind` is "face" or "edge". The shape
    is the build123d Face / Edge — iterate body.faces() / body.edges() in
    the same order the topology was built (the harness's `_extract_geometry_v4`
    relies on the same alignment, so we mirror it here).

    Raises `KeyError` when the descriptor isn't found.
    """
    if not canonical:
        raise KeyError("descriptor canonical string is empty")
    entries = _topology_entries(result)
    for e in entries:
        if _descriptor_canonical(e["entry"].get("descriptor")) == canonical:
            body = namespace.get(e["body_var"]) if e.get("body_var") else None
            # Fallback to feature_id-as-var (test DSL convention).
            if body is None and e.get("featureId"):
                body = namespace.get(e["featureId"])
            if body is None:
                raise KeyError(
                    f"descriptor '{canonical}' resolves to body var "
                    f"'{e.get('body_var')}' which is not in namespace"
                )
            try:
                items = list(body.faces()) if e["kind"] == "face" else list(body.edges())
            except Exception as ex:
                raise KeyError(f"could not iterate {e['kind']}s on body: {ex}")
            if e["index"] >= len(items):
                raise KeyError(
                    f"descriptor index {e['index']} out of range "
                    f"({len(items)} {e['kind']}s on body)"
                )
            return (e["kind"], items[e["index"]])
    raise KeyError(f"descriptor '{canonical}' not found in topology cache")


# ─── Geometry helpers ───────────────────────────────────────────────────────


def _xyz(v: Any) -> list:
    """Vec3 (build123d Vector / OCCT gp_Pnt / tuple) → [x, y, z] floats."""
    if v is None:
        return [0.0, 0.0, 0.0]
    for attrs in (("X", "Y", "Z"), ("x", "y", "z")):
        try:
            return [float(getattr(v, attrs[0])), float(getattr(v, attrs[1])),
                    float(getattr(v, attrs[2]))]
        except AttributeError:
            continue
        except TypeError:
            # build123d's X/Y/Z may be methods on some classes
            try:
                return [float(getattr(v, attrs[0])()), float(getattr(v, attrs[1])()),
                        float(getattr(v, attrs[2]))()]
            except Exception:
                continue
    try:
        return [float(v[0]), float(v[1]), float(v[2])]
    except Exception:
        return [0.0, 0.0, 0.0]


def _surface_type(face_obj: Any) -> str:
    """build123d geom_type → "planar"/"cylindrical"/... — same vocab as naming."""
    try:
        gt = str(getattr(face_obj, "geom_type", "")).upper()
    except Exception:
        gt = ""
    if "PLANE" in gt:  return "planar"
    if "CYL"   in gt:  return "cylindrical"
    if "SPHERE" in gt: return "spherical"
    if "CONE"  in gt:  return "conical"
    if "TORUS" in gt:  return "toroidal"
    return "other"


# ─── Per-type evaluators ───────────────────────────────────────────────────


def _eval_bbox(query: dict, namespace: dict, result: dict) -> dict:
    body = _resolve_body(query.get("featureId", ""), namespace, result)
    bb = body.bounding_box()
    mn = _xyz(getattr(bb, "min", None) or getattr(bb, "min_point", None))
    mx = _xyz(getattr(bb, "max", None) or getattr(bb, "max_point", None))
    size = [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]]
    return {"ok": True, "min": mn, "max": mx, "size": size}


def _eval_volume(query: dict, namespace: dict, result: dict) -> dict:
    body = _resolve_body(query.get("featureId", ""), namespace, result)
    return {"ok": True, "volume": float(body.volume)}


def _eval_mass(query: dict, namespace: dict, result: dict) -> dict:
    """mass(featureId, density=1.0 g/cm³) → grams.

    build123d body.volume is mm³. Convert mm³ → cm³ (÷1000), multiply by
    density (g/cm³) → grams.
    """
    body = _resolve_body(query.get("featureId", ""), namespace, result)
    try:
        density = float(query.get("density", 1.0))
    except (TypeError, ValueError):
        density = 1.0
    volume_mm3 = float(body.volume)
    mass_g = (volume_mm3 / 1000.0) * density
    return {"ok": True, "mass": mass_g, "density": density}


def _eval_surface_area(query: dict, namespace: dict, result: dict) -> dict:
    """surfaceArea(featureId) → total body area; surfaceArea(descriptor) → one face."""
    descriptor = query.get("descriptor")
    if descriptor:
        kind, shape = _resolve_descriptor(descriptor, namespace, result)
        if kind != "face":
            return {"ok": False, "error": f"surfaceArea expects a face descriptor, got {kind}"}
        return {"ok": True, "area": float(shape.area)}
    body = _resolve_body(query.get("featureId", ""), namespace, result)
    try:
        return {"ok": True, "area": float(body.area)}
    except Exception:
        # Some compound bodies don't expose `.area`; sum face areas as a fallback.
        total = 0.0
        for f in body.faces():
            try:
                total += float(f.area)
            except Exception:
                continue
        return {"ok": True, "area": total}


def _eval_distance(query: dict, namespace: dict, result: dict) -> dict:
    """Minimum point-to-point distance between two faces/edges via OCCT.

    Uses `BRepExtrema_DistShapeShape` — the canonical OCCT distance solver
    over B-Rep shapes. Build123d doesn't ship a wrapper for the multi-shape
    case, so we reach for OCP directly.
    """
    canonical_a = query.get("descriptorA") or query.get("a")
    canonical_b = query.get("descriptorB") or query.get("b")
    if not canonical_a or not canonical_b:
        return {"ok": False, "error": "distance requires descriptorA and descriptorB"}
    _ka, shape_a = _resolve_descriptor(canonical_a, namespace, result)
    _kb, shape_b = _resolve_descriptor(canonical_b, namespace, result)
    try:
        from OCP.BRepExtrema import BRepExtrema_DistShapeShape  # type: ignore
    except Exception as e:
        return {"ok": False, "error": f"OCP.BRepExtrema unavailable: {e}"}
    try:
        dss = BRepExtrema_DistShapeShape(shape_a.wrapped, shape_b.wrapped)
        dss.Perform()
        if not dss.IsDone():
            return {"ok": False, "error": "BRepExtrema_DistShapeShape did not converge"}
        d = float(dss.Value())
        return {"ok": True, "distance": d}
    except Exception as e:
        return {"ok": False, "error": f"distance evaluation failed: {e}"}


def _eval_holes(query: dict, namespace: dict, result: dict) -> dict:
    """Enumerate cylindrical bores on a body.

    v1 heuristic — same spirit as naming.name_hole:
      * Walk every face; keep those with `surface_type == cylindrical`.
      * Group concentric ones (axis + center colinear, similar radius) into a
        single "hole" entry.
      * Center = midpoint of the merged group's centroids.
      * Diameter = 2 × smallest cylindrical face radius (the bore wall).
      * Depth = axial extent along the cylinder axis.

    Limitations: doesn't distinguish counterbore steps (it'll report the wider
    cylinder as a separate hole if the axes aren't merged), and an external
    cylindrical body face (e.g. a pin) will be treated as a hole. Defensive:
    any per-face error is skipped, never raised.
    """
    body = _resolve_body(query.get("featureId", ""), namespace, result)
    holes: list = []
    try:
        cyl_faces = []
        for f in body.faces():
            if _surface_type(f) != "cylindrical":
                continue
            radius = None
            try:
                radius = float(getattr(f, "radius", 0.0)) or None
            except Exception:
                pass
            try:
                center = _xyz(f.center())
            except Exception:
                center = [0.0, 0.0, 0.0]
            axis_dir = None
            try:
                ax = getattr(f, "axis_of_revolution", None) or getattr(f, "axis", None)
                if ax is not None:
                    d = getattr(ax, "direction", ax)
                    axis_dir = _xyz(d)
            except Exception:
                pass
            cyl_faces.append({"face": f, "radius": radius, "center": center, "axis": axis_dir})

        # Group concentric/axial cylinders by axis direction + colinear centers.
        used = [False] * len(cyl_faces)
        for i, ci in enumerate(cyl_faces):
            if used[i]:
                continue
            group = [ci]
            used[i] = True
            for j in range(i + 1, len(cyl_faces)):
                if used[j]:
                    continue
                cj = cyl_faces[j]
                if not ci["axis"] or not cj["axis"]:
                    continue
                # Axis parallelism: |a·b| ≈ 1
                dot = abs(sum(ci["axis"][k] * cj["axis"][k] for k in range(3)))
                if dot < 0.95:
                    continue
                # Center colinearity: vector between centers is parallel to axis
                dv = [cj["center"][k] - ci["center"][k] for k in range(3)]
                dlen = math.sqrt(sum(d * d for d in dv))
                if dlen > 1e-6:
                    cross_dot = abs(sum((dv[k] / dlen) * ci["axis"][k] for k in range(3)))
                    if cross_dot < 0.95:
                        continue
                used[j] = True
                group.append(cj)

            # Reduce the group to one hole entry.
            radii = [g["radius"] for g in group if g["radius"]]
            if not radii:
                continue
            diameter = 2.0 * min(radii)
            # Center: average of group centers
            cx = sum(g["center"][0] for g in group) / len(group)
            cy = sum(g["center"][1] for g in group) / len(group)
            cz = sum(g["center"][2] for g in group) / len(group)
            # Depth: axial extent — bounding box of the group's cylindrical face vertices
            # along the axis. v1: use face bbox spans along the dominant axis.
            try:
                bbs = [g["face"].bounding_box() for g in group]
                mins = [_xyz(getattr(b, "min", None) or getattr(b, "min_point", None)) for b in bbs]
                maxs = [_xyz(getattr(b, "max", None) or getattr(b, "max_point", None)) for b in bbs]
                axis = ci["axis"] or [0.0, 0.0, 1.0]
                # Project mins/maxes onto axis; depth = span.
                projs = []
                for p in mins + maxs:
                    projs.append(p[0] * axis[0] + p[1] * axis[1] + p[2] * axis[2])
                depth = max(projs) - min(projs) if projs else 0.0
            except Exception:
                depth = 0.0
            holes.append({
                "center":   [cx, cy, cz],
                "diameter": diameter,
                "depth":    depth,
            })
    except Exception as e:
        return {"ok": True, "holes": holes, "warning": f"partial enumeration: {e}"}
    return {"ok": True, "holes": holes}


def _eval_manifold(query: dict, namespace: dict, result: dict) -> dict:
    """closed / watertight / eulerNumber via OCCT's BRepCheck_Analyzer.

    Falls back to triangle-mesh closed-edge counting when OCP isn't accessible
    (each edge should be shared by exactly two triangles for a watertight mesh).
    Euler number is computed as V - E + F over the body's topological cells.
    """
    body = _resolve_body(query.get("featureId", ""), namespace, result)
    closed = False
    watertight = False
    euler = 0
    # Topology cell counts → Euler χ = V - E + F.
    try:
        vcount = len(list(body.vertices()))
        ecount = len(list(body.edges()))
        fcount = len(list(body.faces()))
        euler = vcount - ecount + fcount
    except Exception:
        pass
    # OCCT validity check.
    try:
        from OCP.BRepCheck import BRepCheck_Analyzer  # type: ignore
        analyzer = BRepCheck_Analyzer(body.wrapped, True)
        valid = bool(analyzer.IsValid())
        closed = valid
        watertight = valid
    except Exception:
        # Fall back to triangle-mesh closed-edge analysis: every triangle edge
        # must be shared by exactly two triangles for a closed surface.
        try:
            from OCP.BRepMesh import BRepMesh_IncrementalMesh  # type: ignore
            BRepMesh_IncrementalMesh(body.wrapped, 0.1, False, 0.5, True)
            edge_counts: dict = {}
            for f in body.faces():
                tri = None
                try:
                    from OCP.BRep import BRep_Tool  # type: ignore
                    from OCP.TopLoc import TopLoc_Location  # type: ignore
                    loc = TopLoc_Location()
                    tri = BRep_Tool.Triangulation_s(f.wrapped, loc)
                except Exception:
                    pass
                if tri is None:
                    continue
                for i in range(1, tri.NbTriangles() + 1):
                    t = tri.Triangle(i)
                    a, b, c = t.Value(1), t.Value(2), t.Value(3)
                    for u, v in ((a, b), (b, c), (c, a)):
                        key = (min(u, v), max(u, v))
                        edge_counts[key] = edge_counts.get(key, 0) + 1
            if edge_counts:
                watertight = all(v == 2 for v in edge_counts.values())
                closed = watertight
        except Exception:
            pass
    return {"ok": True, "closed": bool(closed), "watertight": bool(watertight),
            "eulerNumber": int(euler)}


def _eval_self_intersection(query: dict, namespace: dict, result: dict) -> dict:
    """Sample-based self-intersection scan.

    v1: pick up to 200 random face pairs and run BRepExtrema_DistShapeShape;
    a pair is considered intersecting when distance == 0 AND the faces are
    NOT topologically adjacent (otherwise every shared edge would count).

    Reports the first 5 intersection points. Sample-based — false negatives
    are possible on large bodies. The OCCT-canonical alternative (BOPCheck)
    is much heavier and reserved for the v2 deep-check mode.
    """
    body = _resolve_body(query.get("featureId", ""), namespace, result)
    locations: list = []
    try:
        from OCP.BRepExtrema import BRepExtrema_DistShapeShape  # type: ignore
    except Exception as e:
        return {"ok": False, "error": f"OCP.BRepExtrema unavailable: {e}"}
    try:
        faces = list(body.faces())
    except Exception as e:
        return {"ok": False, "error": f"could not iterate faces: {e}"}
    n = len(faces)
    if n < 2:
        return {"ok": True, "locations": []}

    # Build adjacency: faces sharing an edge are not considered intersecting.
    edge_faces: dict = {}
    try:
        for fi, f in enumerate(faces):
            for e in f.edges():
                key = id(e.wrapped) if hasattr(e, "wrapped") else id(e)
                edge_faces.setdefault(key, set()).add(fi)
    except Exception:
        pass
    adjacent: set = set()
    for fs in edge_faces.values():
        if len(fs) >= 2:
            lst = sorted(fs)
            for a in range(len(lst)):
                for b in range(a + 1, len(lst)):
                    adjacent.add((lst[a], lst[b]))

    rng = random.Random(0)  # deterministic across reruns — measure is a sensor
    pairs = []
    max_pairs = min(200, n * (n - 1) // 2)
    seen = set()
    while len(pairs) < max_pairs:
        a = rng.randrange(n)
        b = rng.randrange(n)
        if a == b:
            continue
        key = (min(a, b), max(a, b))
        if key in seen or key in adjacent:
            continue
        seen.add(key)
        pairs.append(key)

    for (a, b) in pairs:
        try:
            dss = BRepExtrema_DistShapeShape(faces[a].wrapped, faces[b].wrapped)
            dss.Perform()
            if dss.IsDone() and dss.Value() <= 1e-6:
                try:
                    p = dss.PointOnShape1(1)
                    locations.append([float(p.X()), float(p.Y()), float(p.Z())])
                except Exception:
                    pass
                if len(locations) >= 5:
                    break
        except Exception:
            continue
    return {"ok": len(locations) == 0, "locations": locations}


def _eval_interference(query: dict, namespace: dict, result: dict) -> dict:
    """Boolean-intersection volume between two bodies — `bodyA & bodyB`."""
    body_a = _resolve_body(query.get("featureIdA", "") or query.get("a", ""), namespace, result)
    body_b = _resolve_body(query.get("featureIdB", "") or query.get("b", ""), namespace, result)
    try:
        inter = body_a & body_b
    except Exception as e:
        return {"ok": False, "error": f"intersection failed: {e}"}
    try:
        vol = float(inter.volume)
    except Exception:
        vol = 0.0
    return {"ok": True, "intersects": vol > 1e-9, "volume": vol}


# ─── Motion-range clearance (swept interference) ────────────────────────────

# Hard caps so a pathological request can't wedge the kernel. The JS invariant
# `i-motion-clearance` passes a sane `samples`, but we clamp regardless.
_MOTION_MAX_SAMPLES_PER_JOINT = 64
_MOTION_MAX_JOINTS = 64
_MOTION_MAX_BODY_PAIRS = 4096  # samples × moving × static, summed over joints
_MOTION_AABB_PAD = 1e-6        # mm — broad-phase slop


def _aabb(body: Any) -> Optional[tuple]:
    """(min[xyz], max[xyz]) for a body, or None if it has no usable bbox."""
    try:
        bb = body.bounding_box()
    except Exception:
        return None
    mn = _xyz(getattr(bb, "min", None) or getattr(bb, "min_point", None))
    mx = _xyz(getattr(bb, "max", None) or getattr(bb, "max_point", None))
    return (mn, mx)


def _aabb_overlap(a: Optional[tuple], b: Optional[tuple]) -> bool:
    """Axis-aligned bbox overlap test (broad-phase). Unknown bbox → assume
    overlap so we never skip a narrow-phase check on missing info."""
    if a is None or b is None:
        return True
    (amn, amx), (bmn, bmx) = a, b
    for k in range(3):
        if amx[k] + _MOTION_AABB_PAD < bmn[k] or bmx[k] + _MOTION_AABB_PAD < amn[k]:
            return False
    return True


def _pose_body(body: Any, axis_dir: list, pivot: list, angle_deg: float) -> Any:
    """Rotate `body` by `angle_deg` (degrees) about the line through `pivot`
    along `axis_dir`. Z-up, mm. Reuses build123d's `Shape.rotate(Axis, deg)`
    — the same primitive `pattern_circular` uses — so we don't reinvent the
    transform. Returns a posed copy; the original body is left untouched."""
    from build123d import Axis, Vector  # type: ignore
    ax = Axis(Vector(*pivot), Vector(*axis_dir))
    return body.rotate(ax, float(angle_deg))


def _eval_motion_sweep(query: dict, namespace: dict, result: dict) -> dict:
    """Sweep articulating joints across their range and report collisions.

    Request:
      { type:'motionSweep',
        joints:[ { axis:[x,y,z], pivot:[x,y,z], range:[minDeg,maxDeg],
                   movingBodies:[ids], staticBodies:[ids] } ],
        samples:N }

    Response:
      { ok, collisions:[ { jointIndex, angleDeg, pair:[idA,idB], volume } ],
        clear: bool }

    For each joint we sample `samples` angles across `range` (inclusive of
    both endpoints), re-pose every moving body about the joint axis through
    its pivot, and run pairwise interference against the static bodies. We
    broad-phase with an AABB overlap test before paying for the OCCT boolean
    (the narrow phase = the same `bodyA & bodyB` volume the `interference`
    measure uses). Work is bounded by hard caps so it can't wedge the server.

    Z-up, mm throughout. Angles in degrees (build123d `rotate` takes degrees).
    """
    joints = query.get("joints")
    if not isinstance(joints, list) or not joints:
        return {"ok": False, "error": "motionSweep requires a non-empty 'joints' list"}
    if len(joints) > _MOTION_MAX_JOINTS:
        joints = joints[:_MOTION_MAX_JOINTS]

    try:
        samples = int(query.get("samples", 8))
    except (TypeError, ValueError):
        samples = 8
    samples = max(2, min(samples, _MOTION_MAX_SAMPLES_PER_JOINT))

    collisions: list = []
    pair_budget = _MOTION_MAX_BODY_PAIRS

    for ji, joint in enumerate(joints):
        if not isinstance(joint, dict):
            continue
        axis_dir = joint.get("axis") or [0.0, 0.0, 1.0]
        pivot = joint.get("pivot") or [0.0, 0.0, 0.0]
        rng = joint.get("range") or [0.0, 0.0]
        try:
            lo, hi = float(rng[0]), float(rng[1])
        except (TypeError, ValueError, IndexError):
            return {"ok": False, "error": f"joint {ji}: 'range' must be [minDeg, maxDeg]"}

        moving_ids = [i for i in (joint.get("movingBodies") or []) if i]
        static_ids = [i for i in (joint.get("staticBodies") or []) if i]
        if not moving_ids or not static_ids:
            continue

        # Resolve once; reuse across samples. Static bboxes precomputed for
        # broad-phase. A body that won't resolve is skipped (not fatal).
        moving = []
        for mid in moving_ids:
            try:
                moving.append((mid, _resolve_body(mid, namespace, result)))
            except Exception:
                continue
        statics = []
        for sid in static_ids:
            try:
                sbody = _resolve_body(sid, namespace, result)
                statics.append((sid, sbody, _aabb(sbody)))
            except Exception:
                continue
        if not moving or not statics:
            continue

        # Inclusive sample of [lo, hi]. A zero-width range degenerates to a
        # single repeated pose — still worth one collision check.
        span = hi - lo
        for si in range(samples):
            t = si / (samples - 1) if samples > 1 else 0.0
            angle = lo + span * t
            for (mid, mbody) in moving:
                try:
                    posed = _pose_body(mbody, axis_dir, pivot, angle)
                except Exception:
                    # If a pose can't be formed, skip this body at this angle
                    # rather than failing the whole sweep.
                    continue
                posed_aabb = _aabb(posed)
                for (sid, sbody, saabb) in statics:
                    if pair_budget <= 0:
                        break
                    pair_budget -= 1
                    # Broad-phase: skip the boolean if AABBs can't overlap.
                    if not _aabb_overlap(posed_aabb, saabb):
                        continue
                    # Narrow-phase: same boolean-intersection volume the
                    # `interference` measure uses.
                    try:
                        inter = posed & sbody
                        vol = float(inter.volume)
                    except Exception:
                        vol = 0.0
                    if vol > 1e-9:
                        collisions.append({
                            "jointIndex": ji,
                            "angleDeg":   angle,
                            "pair":       [mid, sid],
                            "volume":     vol,
                        })
                if pair_budget <= 0:
                    break
            if pair_budget <= 0:
                break
        if pair_budget <= 0:
            break

    return {"ok": True, "collisions": collisions, "clear": len(collisions) == 0}


def _eval_centroid(query: dict, namespace: dict, result: dict) -> dict:
    """Centroid: center of mass for a body, face centroid for a face descriptor."""
    descriptor = query.get("descriptor")
    if descriptor:
        kind, shape = _resolve_descriptor(descriptor, namespace, result)
        try:
            c = shape.center()
        except Exception as e:
            return {"ok": False, "error": f"centroid lookup failed: {e}"}
        return {"ok": True, "center": _xyz(c), "kind": kind}
    body = _resolve_body(query.get("featureId", ""), namespace, result)
    # Prefer center-of-mass; fall back to bbox center.
    for method in ("center_of_mass", "center"):
        try:
            c = getattr(body, method)
            if callable(c):
                c = c()
            return {"ok": True, "center": _xyz(c)}
        except Exception:
            continue
    try:
        bb = body.bounding_box()
        mn = _xyz(getattr(bb, "min", None) or getattr(bb, "min_point", None))
        mx = _xyz(getattr(bb, "max", None) or getattr(bb, "max_point", None))
        return {"ok": True, "center": [(mn[i] + mx[i]) / 2.0 for i in range(3)]}
    except Exception as e:
        return {"ok": False, "error": f"centroid unavailable: {e}"}


def _eval_normal(query: dict, namespace: dict, result: dict) -> dict:
    """Face normal at the face centroid — descriptor required."""
    descriptor = query.get("descriptor")
    if not descriptor:
        return {"ok": False, "error": "normal requires a face descriptor"}
    kind, shape = _resolve_descriptor(descriptor, namespace, result)
    if kind != "face":
        return {"ok": False, "error": f"normal expects a face descriptor, got {kind}"}
    try:
        n = shape.normal_at()
    except TypeError:
        try:
            n = shape.normal_at(shape.center())
        except Exception as e:
            return {"ok": False, "error": f"normal evaluation failed: {e}"}
    except Exception as e:
        return {"ok": False, "error": f"normal evaluation failed: {e}"}
    return {"ok": True, "normal": _xyz(n)}


# ─── Dispatch ──────────────────────────────────────────────────────────────


_DISPATCH: dict = {
    "bbox":             _eval_bbox,
    "volume":           _eval_volume,
    "mass":             _eval_mass,
    "surfaceArea":      _eval_surface_area,
    "distance":         _eval_distance,
    "holes":            _eval_holes,
    "manifold":         _eval_manifold,
    "selfIntersection": _eval_self_intersection,
    "interference":     _eval_interference,
    "motionSweep":      _eval_motion_sweep,
    "centroid":         _eval_centroid,
    "normal":           _eval_normal,
}


def measure_query(query: dict, namespace: dict, result: dict) -> dict:
    """Dispatch a single query against the kernel's last execution state.

    Per-query error isolation: any exception inside the evaluator is caught
    and turned into `{ok: false, error: "..."}` so a single malformed entry
    doesn't fail the whole batch. The server wraps a list of these into the
    `results` array on the /measure response.
    """
    if not isinstance(query, dict):
        return {"ok": False, "error": "query must be an object"}
    qtype = query.get("type")
    fn: Optional[Callable] = _DISPATCH.get(qtype)
    if fn is None:
        return {"ok": False, "error": f"unknown query type '{qtype}'"}
    try:
        return fn(query, namespace, result)
    except KeyError as e:
        return {"ok": False, "error": str(e)}
    except Exception as e:
        return {"ok": False, "error": f"{qtype} failed: {e}"}
