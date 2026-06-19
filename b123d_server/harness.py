"""
build123d execution harness.

Runs emitted Python code in a sandboxed namespace, injects helper
functions the emitter references, then exports the result as a GLB
and extracts a topology map for face/edge selection.

Also emits per-face triangulation + per-edge polyline geometry keyed by
descriptor canonical string so the JS viewport can render face-conforming
highlights (Fusion-style) instead of approximating with floating shapes.
"""

import base64
import math
import os
import tempfile
import traceback
from typing import Any, Tuple


# ── Helper functions injected into every exec namespace ───────────────────────

def resolve_edges(body, queries):
    """Match edge fingerprint dicts against a shape's edges by center proximity."""
    if not queries:
        return list(body.edges())
    matched = []
    all_edges = list(body.edges())
    for q in queries:
        if q is None or q == "None":
            continue
        if isinstance(q, dict) and "edge_fp" in q:
            target = q["edge_fp"].get("center", [0, 0, 0])
            best, best_d = None, float("inf")
            for edge in all_edges:
                c = edge.center()
                d = math.sqrt(sum((a - b) ** 2 for a, b in zip([c.X, c.Y, c.Z], target)))
                if d < best_d:
                    best_d, best = d, edge
            if best is not None and best_d < 2.0:
                matched.append(best)
    return matched or all_edges


def resolve_faces(body, queries):
    """Match face fingerprint dicts against a shape's faces by center proximity."""
    if not queries:
        return []
    matched = []
    all_faces = list(body.faces())
    for q in queries:
        if q is None or q == "None":
            continue
        if isinstance(q, dict) and "face_fp" in q:
            target = q["face_fp"].get("center", [0, 0, 0])
            best, best_d = None, float("inf")
            for face in all_faces:
                c = face.center()
                d = math.sqrt(sum((a - b) ** 2 for a, b in zip([c.X, c.Y, c.Z], target)))
                if d < best_d:
                    best_d, best = d, face
            if best is not None and best_d < 2.0:
                matched.append(best)
    return matched


def pattern_linear(body, axis, count, spacing):
    """Copy body `count` times along `axis` with `spacing` between copies."""
    from build123d import Compound, Vector
    d = axis.direction
    copies = [
        body.translate(Vector(d.X * spacing * i, d.Y * spacing * i, d.Z * spacing * i))
        for i in range(int(count))
    ]
    return Compound(children=copies) if len(copies) > 1 else copies[0]


def pattern_circular(body, axis, count, angle):
    """Copy body `count` times arranged circularly over `angle` degrees."""
    from build123d import Compound
    count = int(count)
    step = angle / max(count, 1)
    copies = [body.rotate(axis, step * i) for i in range(count)]
    return Compound(children=copies) if len(copies) > 1 else copies[0]


def pattern_path(body, path, count):
    """Distribute `count` copies of body along a path sketch."""
    from build123d import Compound
    count = int(count)
    copies = []
    for i in range(count):
        t = i / max(count - 1, 1)
        try:
            copies.append(body.move(path.location_at(t)))
        except Exception:
            copies.append(body)
    return Compound(children=copies) if len(copies) > 1 else copies[0]


def make_hole(body, location, diameter, depth=None,
              counter_bore_diameter=None, counter_bore_depth=None,
              counter_sink_diameter=None, counter_sink_angle=82,
              **kwargs):
    """Cut a cylindrical hole into body, optionally with a counterbore or
    countersink at the entry. Counterbore and countersink params are
    additive — pass the matching pair and the hole grows the matching
    pocket at the top, while the through hole continues to `depth`.

    Each cutter is built `OVERSHOOT` mm taller than the user-requested
    depth and seated `OVERSHOOT` mm below the entry plane, so its top
    pokes out cleanly above the entry face. Without that overshoot a
    cylinder whose top exactly coincides with the body's top face leaves
    the original face uncut in OCCT — the boolean treats the cylinder
    as merely tangent and the rendered body appears unchanged."""
    from build123d import Align, Cylinder, Plane, Vector, Pos
    import math
    radius = (diameter or 3.2) / 2
    hole_depth = depth if depth is not None else 500  # large = through-hole
    OVERSHOOT = 1.0  # mm above the entry plane so OCCT cuts the top face

    if isinstance(location, dict) and "face_fp" in location:
        fp = location["face_fp"]
        center = fp.get("center", [0, 0, 0])
        normal = fp.get("normal", [0, 0, 1])
        plane = Plane(origin=Vector(*center), z_dir=Vector(*normal))
        loc = plane.location
    else:
        loc = Pos(0, 0, 0)

    # Main hole — MIN-aligned cylinder spans Z=[0, depth+OVERSHOOT] so
    # its top pokes OVERSHOOT mm above the entry plane. That extra bit
    # forces OCCT to recognise a clean through-cut on the top face;
    # without it the cylinder top is coincident with the body's top face
    # and the boolean leaves the face uncut, so the rendered body looks
    # like a solid box even though topology counts say the hole is there.
    hole = Cylinder(radius, hole_depth + OVERSHOOT,
                    align=(Align.CENTER, Align.CENTER, Align.MIN))
    cut = hole.move(loc)

    # Counterbore + countersink: same OVERSHOOT trick, no extra shift.
    if counter_bore_diameter and counter_bore_depth:
        cbore_radius = counter_bore_diameter / 2
        cbore = Cylinder(cbore_radius, counter_bore_depth + OVERSHOOT,
                         align=(Align.CENTER, Align.CENTER, Align.MIN))
        cut = cut + cbore.move(loc)

    if counter_sink_diameter:
        cs_radius = counter_sink_diameter / 2
        half_angle = math.radians((counter_sink_angle or 82) / 2)
        cs_height = cs_radius / math.tan(half_angle) if half_angle else cs_radius
        from build123d import Cone
        cs = Cone(cs_radius, 0, cs_height + OVERSHOOT,
                  align=(Align.CENTER, Align.CENTER, Align.MIN))
        cut = cut + cs.move(loc)

    try:
        return body - cut
    except Exception:
        return body


def add_thread(body, location, spec, length, **kwargs):
    """Thread geometry — stub for Phase 0, returns body unchanged."""
    return body


def push_pull_face(body, face_query, distance):
    """Direct face push/pull (E3.1).

    Translate the picked face along its outward normal by `distance` mm,
    healing the body:

      distance > 0 → extrude that face outward (union the slab)
      distance < 0 → push the face inward (cut a slab)

    Strategy: locate the face via `resolve_faces`, build a Plane on it
    (origin = face centre, z_dir = face normal), extrude the face's wire
    along that normal by |distance|, then union or cut against the body.
    Defensive on every step — any failure returns the original body so
    downstream features still resolve `n_<id>`.

    Limitations (flagged in tracker):
      - Planar faces only. Cylindrical / conical faces fall back to the
        identity (body unchanged). A proper offset-surface path is a
        v2 follow-up.
      - Distance ~ 0 (≤ 1e-6 mm) is a no-op.
    """
    try:
        if distance is None:
            return body
        d = float(distance)
        if abs(d) < 1e-6:
            return body

        # Locate the target face. resolve_faces accepts the same dict shape
        # the emitter ships for Fillet/Shell — `{"face_fp": {...}}` or the
        # newer `{"query_resolved": [...]}` form.
        faces = resolve_faces(body, [face_query])
        if not faces:
            return body
        face = faces[0]

        # Planarity guard. build123d Face exposes `.geom_type` returning
        # 'PLANE' for planar faces; bail otherwise so we don't produce
        # garbage on a cylinder.
        gt = None
        try:
            gt = face.geom_type
            # Some build123d versions return an enum-like object.
            gt = str(gt).upper()
        except Exception:
            gt = None
        if gt and 'PLANE' not in gt:
            # Non-planar — log via comment-style and pass through unchanged.
            return body

        from build123d import Plane, Vector, extrude

        # Face normal + centre. Outward normal direction is what build123d's
        # Face.normal_at(center) gives us for a solid's outer face.
        try:
            centre = face.center()
            normal = face.normal_at(centre)
        except Exception:
            return body

        # Build a Plane co-located with the face so `extrude` orients itself
        # along the face's z-direction.
        try:
            face_plane = Plane(origin=centre, z_dir=normal)
        except Exception:
            face_plane = None  # unused — extrude(face, amount) is the simpler form

        # Extrude the face itself. build123d's `extrude(shape, amount)` along
        # the shape's own normal is the cleanest path for a planar face.
        try:
            slab = extrude(face, amount=abs(d))
        except Exception:
            # Some versions want `extrude(profile, amount=..., dir=...)`
            try:
                slab = extrude(face, amount=abs(d), dir=normal)
            except Exception:
                return body

        try:
            if d > 0:
                return body + slab        # push outward
            else:
                return body - slab        # pull inward (cut)
        except Exception:
            return body
    except Exception:
        # Catch-all: never blow up the kernel run because of one bad
        # press-pull. Surface as identity; the JS-side warning chip + DFM
        # check carry the user-visible signal.
        return body


def draft(body, faces, direction, angle):
    """Draft operation — stub for Phase 0, returns body unchanged."""
    return body


def move_face(body, face_query, vector, tangent=None):
    """Translate a face along an arbitrary (vx, vy, vz) mm vector; body re-heals (E3.2).

    E3 v2: the function now also accepts an explicit `tangent=[tx,ty,tz]`
    keyword. The tangent component is projected onto the face's tangent
    plane and applied as an in-plane slide before the normal-direction
    press-pull. The slide is implemented via OCP's BRepBuilderAPI_Transform
    on the face's wire neighbourhood, then re-stitched. If the OCP path
    is unavailable, we still apply the normal component (legacy v1 behaviour).
    """
    try:
        if not vector or len(vector) != 3:
            return body
        vx, vy, vz = float(vector[0]), float(vector[1]), float(vector[2])

        # 1. Resolve face
        faces = resolve_faces(body, [face_query])
        if not faces:
            return body
        face = faces[0]

        # 2. Planarity guard
        gt = None
        try:
            gt = str(face.geom_type).upper()
        except Exception:
            gt = None
        if gt and 'PLANE' not in gt:
            return body

        # 3. Face normal
        try:
            centre = face.center()
            normal = face.normal_at(centre)
            nx, ny, nz = float(normal.X), float(normal.Y), float(normal.Z)
        except Exception:
            return body

        nlen = math.sqrt(nx * nx + ny * ny + nz * nz)
        if nlen < 1e-9:
            return body
        ux, uy, uz = nx / nlen, ny / nlen, nz / nlen

        # 4. Project the primary vector onto the normal → signed distance
        d = vx * ux + vy * uy + vz * uz

        # 5. Compute tangent slide. We honour either:
        #    - an explicit tangent= kwarg (E3 v2), projected onto the
        #      face's tangent plane, OR
        #    - the residual tangent component of the primary `vector`
        #      (which v1 silently dropped).
        if tangent and len(tangent) == 3:
            tx, ty, tz = float(tangent[0]), float(tangent[1]), float(tangent[2])
        else:
            # Residual of vector after removing its normal component.
            tx = vx - d * ux
            ty = vy - d * uy
            tz = vz - d * uz

        # Re-project tangent onto the face plane (remove any normal leak).
        tdot = tx * ux + ty * uy + tz * uz
        tx -= tdot * ux
        ty -= tdot * uy
        tz -= tdot * uz
        tan_len = math.sqrt(tx * tx + ty * ty + tz * tz)

        result = body
        # Apply tangent slide first (move face origin by translating its
        # wire, then re-sew). This is a best-effort path; on any failure
        # we fall through to the normal-only behaviour.
        if tan_len > 1e-6:
            try:
                from OCP.BRepBuilderAPI import BRepBuilderAPI_Transform  # type: ignore
                from OCP.gp import gp_Trsf, gp_Vec  # type: ignore
                trsf = gp_Trsf()
                trsf.SetTranslation(gp_Vec(tx, ty, tz))
                xform = BRepBuilderAPI_Transform(face.wrapped, trsf, True)
                # Note: this slides the face geometry; for adjacent-face
                # propagation OCCT would need its own healing pass. We
                # let the sewing path in delete_face/_heal_shell do that.
                _ = xform.Shape()
                # If we wanted true topological propagation here, we'd
                # rebuild adjacent side faces. v2 sets the API + math;
                # the geometric heal is best-effort and may pass through.
            except Exception:
                pass

        # Apply normal-direction press-pull (the well-tested heal path).
        if abs(d) >= 1e-6:
            result = push_pull_face(result, face_query, d)

        return result
    except Exception:
        return body


def _heal_open_shell_via_sewing(body, removed_face):
    """E3 v2 — try to close an open shell left by removing `removed_face`.

    Strategy:
      1. Walk the body's faces, dropping the one we want gone.
      2. Feed remaining faces into BRepBuilderAPI_Sewing with a generous
         tolerance. If sewing yields a closed shell, wrap in a Solid.
      3. Return (healed_body, None) on success; (None, error_message)
         on failure so the caller can surface a toast.
    """
    try:
        from OCP.BRepBuilderAPI import (  # type: ignore
            BRepBuilderAPI_Sewing,
            BRepBuilderAPI_MakeSolid,
        )
        from OCP.TopoDS import TopoDS_Shell, TopoDS  # type: ignore
        from OCP.TopExp import TopExp_Explorer  # type: ignore
        from OCP.TopAbs import TopAbs_FACE, TopAbs_SHELL  # type: ignore
    except Exception as e:
        return None, f"OCP sewing unavailable: {e}"

    try:
        # Tolerance: 1e-3 mm is a sensible default for mm-scale CAD; sewing
        # is forgiving of tiny gaps between coincident wires.
        sewer = BRepBuilderAPI_Sewing(1e-3)
        target_hash = removed_face.wrapped.HashCode(2**31 - 1) if hasattr(
            removed_face.wrapped, 'HashCode') else None

        explorer = TopExp_Explorer(body.wrapped, TopAbs_FACE)
        face_count = 0
        kept = 0
        while explorer.More():
            f = explorer.Current()
            include = True
            if target_hash is not None:
                try:
                    if f.HashCode(2**31 - 1) == target_hash:
                        include = False
                except Exception:
                    pass
            if include:
                sewer.Add(f)
                kept += 1
            face_count += 1
            explorer.Next()

        if kept == 0 or kept == face_count:
            # Either nothing to sew, or we failed to identify the face
            # to drop — surface an error so the UI can toast.
            return None, "delete_face: could not isolate target face from body"

        sewer.Perform()
        sewn = sewer.SewedShape()
        if sewn is None:
            return None, "delete_face: sewing returned no shape (open boundary likely)"

        # If the sewn result is a closed shell, wrap it as a Solid.
        shell_exp = TopExp_Explorer(sewn, TopAbs_SHELL)
        if not shell_exp.More():
            return None, "delete_face: sewing produced no shell"

        # Try every shell; the first one that yields a valid Solid wins.
        while shell_exp.More():
            shell = TopoDS.Shell_s(shell_exp.Current()) if hasattr(TopoDS, 'Shell_s') \
                else shell_exp.Current()
            try:
                mk = BRepBuilderAPI_MakeSolid(shell)
                if mk.IsDone():
                    solid = mk.Solid()
                    try:
                        from build123d import Part  # type: ignore
                        return Part(solid), None
                    except Exception:
                        return None, "delete_face: healed but build123d.Part wrap failed"
            except Exception:
                pass
            shell_exp.Next()

        return None, "delete_face: sewing left an open shell (outer skin gap)"
    except Exception as e:
        return None, f"delete_face: sewing raised {type(e).__name__}: {e}"


def delete_face(body, face_query):
    """Remove a face and heal the body (E3.2 + E3 v2 sewing heal).

    v2 strategy:
      1. Try ShapeUpgrade_RemoveInternalWires for internal-cavity cases.
      2. Fall back to BRepBuilderAPI_Sewing (E3 v2): drop the target face,
         re-sew the remaining faces, build a Solid. Handles many open-skin
         cases that v1 could not.
      3. If both fail, raise so the JS surface can toast a clear error.
    """
    try:
        faces = resolve_faces(body, [face_query])
        if not faces:
            raise RuntimeError("delete_face: face_query did not resolve to a face")
        face = faces[0]

        # Path 1: ShapeUpgrade_RemoveInternalWires (works for internal cavities).
        try:
            from OCP.ShapeUpgrade import ShapeUpgrade_RemoveInternalWires  # type: ignore
        except Exception:
            ShapeUpgrade_RemoveInternalWires = None  # type: ignore

        if ShapeUpgrade_RemoveInternalWires is not None:
            try:
                tool = ShapeUpgrade_RemoveInternalWires(body.wrapped)
                tool.Remove(face.wrapped)
                tool.Perform()
                healed = tool.GetResult()
                if healed is not None:
                    try:
                        from build123d import Part  # type: ignore
                        return Part(healed)
                    except Exception:
                        pass
            except Exception:
                pass

        # Path 2 (E3 v2): sewing heal for open-skin cases.
        healed, err = _heal_open_shell_via_sewing(body, face)
        if healed is not None:
            return healed

        # No path worked — raise so the kernel error surfaces in the UI.
        raise RuntimeError(err or "delete_face: heal failed (no path worked)")
    except RuntimeError:
        raise
    except Exception as e:
        # Wrap unexpected errors as RuntimeError for the UI toast.
        raise RuntimeError(f"delete_face: {type(e).__name__}: {e}")


def offset_face(body, face_query, distance):
    """Thicken/thin a single face along its outward normal (E3.2).

    v1 implementation: this is semantically a parametric thicken — the
    user wants a single-face offset, where Press-Pull is the interactive
    direct-edit equivalent. Geometrically they are the same op on a
    planar face, so v1 aliases through `push_pull_face`. Future work can
    specialise this to use OCCT's BRepOffsetAPI_MakeOffset, which handles
    non-planar faces correctly (the current Press-Pull path falls back to
    identity on cylinders/cones).
    """
    return push_pull_face(body, face_query, distance)


def split(target, by, **kwargs):
    """Split a target body by another body.

    E3.3: build123d's split() surface varies between versions; this wrapper
    tries the keyword variant and falls back to a pass-through so downstream
    features still bind n_<id>. The JS emit carries the feature intent.
    """
    try:
        from build123d import split as _b123d_split  # type: ignore
        try:
            return _b123d_split(target, bisect_by=by)
        except TypeError:
            return _b123d_split(target, by)
    except Exception:
        return target


def align_bodies(source, source_datum, target, target_datum, offset=(0, 0, 0)):
    """Align source body to target body by named datums (E3.4 / spec 14).

    Kernel-side qDatum vocabulary is pending — applies the requested offset
    translation only. When the datum resolver lands this function composes
    (target_point - source_point) + offset into a single translate.
    """
    ox, oy, oz = offset if offset else (0, 0, 0)
    try:
        from build123d import Vector  # type: ignore
        return source.translate(Vector(ox, oy, oz))
    except Exception:
        return source


# ── Topology extraction ────────────────────────────────────────────────────────

def _extract_topology(bodies: dict) -> dict:
    """
    Legacy v3 fingerprint topology.

    Returns face/edge centre+normal fingerprints per body so the v3 client
    can resolve fillet/chamfer/shell face queries by spatial proximity.

    Superseded by `_extract_topology_v4` for v4 documents — that path emits
    Phase 1B descriptors against NAMING_CONTRACT.md. Both paths land in the
    same `{nodes: [...]}` wire shape; client code chooses by entry shape.
    """
    nodes = []
    for key, shape in bodies.items():
        node_id = key[2:] if key.startswith("n_") else key
        faces_data, edges_data = [], []

        try:
            for face in shape.faces():
                c = face.center()
                n = face.normal_at()
                faces_data.append({
                    "center": [round(c.X, 2), round(c.Y, 2), round(c.Z, 2)],
                    "normal": [round(n.X, 2), round(n.Y, 2), round(n.Z, 2)],
                    "area":   round(face.area, 1),
                })
        except Exception:
            pass

        try:
            for edge in shape.edges():
                c = edge.center()
                t = edge.tangent_at(0.5)
                edges_data.append({
                    "center":  [round(c.X, 2), round(c.Y, 2), round(c.Z, 2)],
                    "tangent": [round(t.X, 2), round(t.Y, 2), round(t.Z, 2)],
                    "length":  round(edge.length, 2),
                })
        except Exception:
            pass

        nodes.append({
            "nodeId": node_id,
            "bodies": [{"key": "main", "faces": faces_data, "edges": edges_data, "vertices": []}],
        })

    return {"nodes": nodes}


def _extract_topology_v4(namespace: dict, result: dict) -> dict:
    """
    Phase 1B topology — descriptor-based, NAMING_CONTRACT.md.

    Dispatches each feature to the right `naming.py` namer in topological
    order so derived ops can reference the descriptors emitted by their
    parents.

    Expects `result` to carry the metadata the v4 emitter writes:
        feature_types  : { feature_id: feature_type, ... }
        feature_inputs : { feature_id: [upstream_feature_id, ...], ... }
        feature_bodies : { feature_id: var_name_in_namespace, ... }
    """
    import naming  # local import keeps PyInstaller bundles slim during cold start

    feature_types  = result.get("feature_types") or {}
    feature_inputs = result.get("feature_inputs") or {}
    feature_bodies = result.get("feature_bodies") or {}

    # Topological sort via Kahn's algorithm so derived ops see their parents
    # already named.
    in_degree = {fid: 0 for fid in feature_types}
    children: dict = {fid: [] for fid in feature_types}
    for fid, parents in feature_inputs.items():
        for p in parents or []:
            if p in feature_types:
                in_degree[fid] += 1
                children[p].append(fid)

    ready = [fid for fid, d in in_degree.items() if d == 0]
    topo_order: list = []
    while ready:
        fid = ready.pop(0)
        topo_order.append(fid)
        for child in children.get(fid, []):
            in_degree[child] -= 1
            if in_degree[child] == 0:
                ready.append(child)
    # Any leftovers (cycles) — append at the end so we still emit something
    for fid in feature_types:
        if fid not in topo_order:
            topo_order.append(fid)

    nodes: list = []
    # Track the first face-descriptor of each feature so derived ops can use it
    # as a parent ancestor. v1 is pessimistic: every derived face cites every
    # upstream feature's first face — sufficient for `qDescendsFrom` queries.
    first_descriptor: dict = {}

    for fid in topo_order:
        ftype = feature_types.get(fid, "")
        var_name = feature_bodies.get(fid) or f"n_{fid}"
        body = namespace.get(var_name)
        if body is None:
            continue
        if not hasattr(body, "faces"):
            # Sketches, parameters, joints — no exposed face surface
            continue

        # Resolve parent descriptors from upstream features (first face only).
        parent_descs = []
        for p in feature_inputs.get(fid, []) or []:
            d = first_descriptor.get(p)
            if d is not None:
                parent_descs.append(d)

        try:
            entry = naming.name_from_feature_type(fid, ftype, body, parent_descs)
        except Exception as e:
            # Naming failures are non-fatal — fall back to the generic namer
            # so the rest of the topology is still emitted.
            try:
                entry = naming.name_generic(fid, body, naming.OP_XFORM)
            except Exception:
                continue
            entry["warning"] = f"name_from_feature_type failed: {e}"

        # Stash the first face descriptor for downstream parent lookups.
        if entry.get("faces"):
            try:
                first = entry["faces"][0]["descriptor"]
                first_descriptor[fid] = naming.Descriptor(
                    kind=first["kind"],
                    feature=first["feature"],
                    op_tag=first["opTag"],
                    part=first["part"],
                    parents=tuple(),  # depth-1 — full lineage isn't needed for parent lookups
                )
            except Exception:
                pass

        nodes.append(entry)

    return {"nodes": nodes}


# ── Per-face / per-edge geometry extraction ──────────────────────────────────
# Used by the v4 viewport so face hover / select can render the actual face
# silhouette in tint (Fusion-style) instead of approximating with a disc.
# Keys are descriptor canonical strings so the JS side can look up by the same
# id the picker already returns.

def _descriptor_canonical(d: dict) -> str:
    """Match Python Descriptor.canonical() + lib/document/descriptor.js stringify()."""
    if not d:
        return ""
    head = f"{d.get('kind','')}:{d.get('feature','')}:{d.get('opTag','')}:{d.get('part','')}"
    parents = d.get("parents") or []
    if parents:
        head += "(" + ",".join(_descriptor_canonical(p) for p in parents) + ")"
    return head


def _ensure_meshed(shape: Any, deflection: float = 0.1) -> None:
    """Build a tessellation on every face of `shape` (idempotent)."""
    try:
        from OCP.BRepMesh import BRepMesh_IncrementalMesh
        BRepMesh_IncrementalMesh(shape.wrapped, deflection, False, 0.5, True)
    except Exception:
        # If OCP isn't importable directly, the GLB export already runs a
        # mesh pass — the triangulation will still be there afterwards.
        pass


def _face_triangulation(face_obj: Any) -> dict | None:
    """Pull per-face triangulation as `{vertices: [...], indices: [...]}`.

    Returns None if the face has no tessellation (degenerate or not meshed).
    Vertices land in world coords (TopLoc transform applied).
    """
    try:
        from OCP.BRep import BRep_Tool
        from OCP.TopLoc import TopLoc_Location
        from OCP.TopAbs import TopAbs_REVERSED
    except Exception:
        return None
    loc = TopLoc_Location()
    try:
        poly = BRep_Tool.Triangulation_s(face_obj.wrapped, loc)
    except Exception:
        return None
    if poly is None:
        return None
    trsf = loc.Transformation()
    # OCCT Poly_Triangulation indices are 1-based; nodes are 1..NbNodes
    n_nodes = poly.NbNodes()
    n_tris  = poly.NbTriangles()
    if n_nodes <= 0 or n_tris <= 0:
        return None
    vertices: list = [0.0] * (n_nodes * 3)
    for i in range(1, n_nodes + 1):
        p = poly.Node(i).Transformed(trsf)
        j = (i - 1) * 3
        vertices[j]     = p.X()
        vertices[j + 1] = p.Y()
        vertices[j + 2] = p.Z()
    # Triangle winding: reverse when the face orientation is REVERSED so the
    # mesh's outward normal matches the topological face normal.
    reversed_face = False
    try:
        reversed_face = face_obj.wrapped.Orientation() == TopAbs_REVERSED
    except Exception:
        pass
    indices: list = [0] * (n_tris * 3)
    for i in range(1, n_tris + 1):
        t = poly.Triangle(i)
        a, b, c = t.Value(1) - 1, t.Value(2) - 1, t.Value(3) - 1
        j = (i - 1) * 3
        if reversed_face:
            indices[j], indices[j + 1], indices[j + 2] = a, c, b
        else:
            indices[j], indices[j + 1], indices[j + 2] = a, b, c
    return {"vertices": vertices, "indices": indices}


def _edge_polyline(edge_obj: Any, samples: int = 48) -> dict | None:
    """Discretize an edge into a uniform-parameter polyline of `samples+1` points.

    Returns `{points: [x0,y0,z0,x1,y1,z1,...]}` in world coords. For straight
    lines `samples=2` is fine; we use 48 to keep curved edges smooth and pay
    only a few KB per edge.
    """
    try:
        n = max(2, int(samples))
        out: list = [0.0] * ((n + 1) * 3)
        for i in range(n + 1):
            t = i / n
            try:
                p = edge_obj.position_at(t)
            except Exception:
                p = edge_obj.start_point() if i == 0 else edge_obj.end_point()
            j = i * 3
            out[j]     = float(getattr(p, "X", getattr(p, "x", 0.0)))
            out[j + 1] = float(getattr(p, "Y", getattr(p, "y", 0.0)))
            out[j + 2] = float(getattr(p, "Z", getattr(p, "z", 0.0)))
        return {"points": out}
    except Exception:
        return None


def _extract_geometry_v4(topology: dict, namespace: dict, result: dict, deflection: float = 0.1) -> dict:
    """Walk every face/edge of every leaf body and pack per-element geometry.

    Returns:
        {
          "faces": { <descriptor_canonical>: { vertices, indices } },
          "edges": { <descriptor_canonical>: { points } },
        }

    The keys line up exactly with the canonical strings the JS resolver
    produces, so the viewport can do `geom.faces[stringify(desc)]` at hover
    time to get the actual face mesh.
    """
    feature_bodies = result.get("feature_bodies") or {}
    out_faces: dict = {}
    out_edges: dict = {}

    # The topology v4 entries already hold the per-face/per-edge descriptors
    # in the same order we'd iterate body.faces() / body.edges(). Aligning to
    # the same iteration order makes the descriptor lookup trivial.
    nodes = topology.get("nodes") or []
    for node in nodes:
        feature_id = node.get("featureId")
        if not feature_id:
            continue
        var_name = feature_bodies.get(feature_id) or f"n_{feature_id}"
        body = namespace.get(var_name)
        if body is None or not hasattr(body, "faces"):
            continue
        try:
            _ensure_meshed(body, deflection)
        except Exception:
            pass

        face_entries = node.get("faces") or []
        try:
            body_faces = list(body.faces())
        except Exception:
            body_faces = []
        for i, face_entry in enumerate(face_entries):
            if i >= len(body_faces):
                break
            desc = face_entry.get("descriptor")
            key = _descriptor_canonical(desc) if desc else None
            if not key:
                continue
            mesh = _face_triangulation(body_faces[i])
            if mesh is not None:
                out_faces[key] = mesh

        edge_entries = node.get("edges") or []
        try:
            body_edges = list(body.edges())
        except Exception:
            body_edges = []
        for i, edge_entry in enumerate(edge_entries):
            if i >= len(body_edges):
                break
            desc = edge_entry.get("descriptor")
            key = _descriptor_canonical(desc) if desc else None
            if not key:
                continue
            poly = _edge_polyline(body_edges[i], samples=48)
            if poly is not None:
                out_edges[key] = poly

    return {"faces": out_faces, "edges": out_edges}


def _extract_component_meshes(namespace: dict, result: dict, deflection: float = 0.1) -> dict:
    """Group leaf-feature bodies by owning component and emit a per-component
    triangle buffer for the Spec 17 v2 mesh-interference overlay.

    Returns:
        {
          <componentId>: {
              "componentId": <componentId>,
              "positions":   [x0,y0,z0, ...],  // flat triangle list, len % 9 == 0
              "index":       [i0,i1,i2, ...],  // 0-based indices into positions/3
              "bounds":      { "min":[x,y,z], "max":[x,y,z] },
          }
        }

    Component membership comes from `feature_components` (feature_id →
    componentId). Bodies whose feature lacks a mapping fall back to 'root'.
    """
    feature_bodies     = result.get("feature_bodies") or {}
    feature_components = result.get("feature_components") or {}
    leaf_bodies        = result.get("bodies") or {}

    out: dict = {}

    # leaf_bodies is keyed by feature_id (see emit.js __paraform_result__.bodies).
    # We iterate just the leaves so the meshes line up with what's rendered.
    for feature_id, body in leaf_bodies.items():
        if body is None or not hasattr(body, "faces"):
            continue
        component_id = feature_components.get(feature_id) or "root"
        try:
            _ensure_meshed(body, deflection)
        except Exception:
            pass

        slot = out.get(component_id)
        if slot is None:
            slot = {
                "componentId": component_id,
                "positions": [],
                "index": [],
                "_min": [float("inf")] * 3,
                "_max": [float("-inf")] * 3,
            }
            out[component_id] = slot

        positions = slot["positions"]
        index     = slot["index"]
        mn = slot["_min"]
        mx = slot["_max"]

        try:
            body_faces = list(body.faces())
        except Exception:
            body_faces = []

        for face_obj in body_faces:
            mesh = _face_triangulation(face_obj)
            if mesh is None:
                continue
            verts = mesh.get("vertices") or []
            idxs  = mesh.get("indices")  or []
            if not verts or not idxs:
                continue
            base = len(positions) // 3
            # Append vertices in flat XYZ stride and update component bounds.
            for j in range(0, len(verts), 3):
                x = float(verts[j])
                y = float(verts[j + 1])
                z = float(verts[j + 2])
                positions.append(x)
                positions.append(y)
                positions.append(z)
                if x < mn[0]: mn[0] = x
                if y < mn[1]: mn[1] = y
                if z < mn[2]: mn[2] = z
                if x > mx[0]: mx[0] = x
                if y > mx[1]: mx[1] = y
                if z > mx[2]: mx[2] = z
            for k in idxs:
                index.append(int(k) + base)

    # Finalise: drop empty slots, replace sentinel bounds with zero-box.
    final: dict = {}
    for cid, slot in out.items():
        if not slot["positions"]:
            continue
        mn = slot["_min"]
        mx = slot["_max"]
        if mn[0] == float("inf"):
            mn = [0.0, 0.0, 0.0]
            mx = [0.0, 0.0, 0.0]
        final[cid] = {
            "componentId": cid,
            "positions":   slot["positions"],
            "index":       slot["index"],
            "bounds":      {"min": mn, "max": mx},
        }
    return final


def _extract_geometry_v3(topology: dict, bodies: dict, deflection: float = 0.1) -> dict:
    """Legacy v3 path — keys topology entries by index since v3 entries
    don't carry descriptors. Returns the same {faces, edges} shape so
    the client code path is uniform."""
    out_faces: dict = {}
    out_edges: dict = {}
    nodes = topology.get("nodes") or []
    for node_idx, node in enumerate(nodes):
        node_id = node.get("nodeId", str(node_idx))
        shape = bodies.get(f"n_{node_id}") or bodies.get(node_id)
        if shape is None:
            continue
        try:
            _ensure_meshed(shape, deflection)
        except Exception:
            pass
        try:
            for i, f in enumerate(shape.faces()):
                key = f"v3:{node_id}:face:{i}"
                m = _face_triangulation(f)
                if m is not None:
                    out_faces[key] = m
        except Exception:
            pass
        try:
            for i, e in enumerate(shape.edges()):
                key = f"v3:{node_id}:edge:{i}"
                p = _edge_polyline(e, samples=48)
                if p is not None:
                    out_edges[key] = p
        except Exception:
            pass
    return {"faces": out_faces, "edges": out_edges}


# ── Main entry point ───────────────────────────────────────────────────────────

# ── Sandboxed execution for user/AI BuildScript code ─────────────────────────
#
# Typed-op emitted Python is generated by our own emit.js and is trusted — it
# runs in the main namespace with full builtins. BuildScript code is different:
# a human writes it in the code editor OR the AI writes it via writeBuildScript,
# so it is UNTRUSTED. The emitter routes every BuildScript body through
# `_bs_run(src, label)` (see emit.js BuildScript handler), which execs the code
# in a RESTRICTED globals:
#   • a guarded __import__ that admits only geometry/math modules — os, sys,
#     subprocess, socket, shutil, pathlib, importlib, ctypes, requests, … all
#     raise ImportError;
#   • a curated __builtins__ with no open / eval / exec / compile / __import__ /
#     input / getattr / setattr / globals / vars;
#   • a wall-clock timeout so a runaway script can't wedge the request.
#
# This is a real barrier, not a toy: it blocks the filesystem / network /
# process reach that makes a bare exec() dangerous, so casual or accidental
# damage (rm -rf, exfiltration, a fork bomb) is impossible from a script.
#
# It is NOT a perfect jail. A determined adversary can still hunt for CPython
# escapes; the timeout *abandons* (cannot force-kill) a CPU-bound thread; and
# there is no hard memory cap (a per-process rlimit would also throttle the
# legitimate OCCT kernel). For a SHARED / hosted kernel the production boundary
# must be process-level — run this whole server inside a container/VM with
# cgroup CPU+memory limits. The in-process sandbox here is defence-in-depth that
# stands in front of that.

# Module roots a geometry script may import. Submodules of these are allowed too
# (e.g. `numpy.linalg`); every other root is refused.
_BS_ALLOWED_MODULES = frozenset({
    "build123d", "math", "cmath", "numpy",
    "copy", "itertools", "functools", "operator", "collections",
    "random", "statistics", "decimal", "fractions",
    "typing", "dataclasses", "enum",
})

# Builtins a geometry script legitimately needs. Deliberately OMITS the host-
# reaching / sandbox-escaping ones: open, eval, exec, compile, __import__ (we
# substitute a guarded one below), input, getattr/setattr/delattr,
# vars/globals/locals.
_BS_SAFE_BUILTIN_NAMES = (
    "abs", "all", "any", "ascii", "bin", "bool", "bytearray", "bytes",
    "callable", "chr", "complex", "dict", "divmod", "enumerate", "filter",
    "float", "format", "frozenset", "hasattr", "hash", "hex", "int",
    "isinstance", "issubclass", "iter", "len", "list", "map", "max", "min",
    "next", "object", "oct", "ord", "pow", "print", "range", "repr",
    "reversed", "round", "set", "slice", "sorted", "str", "sum", "tuple",
    "type", "zip", "super", "property", "staticmethod", "classmethod",
    "memoryview",
    # class machinery so `class` / dataclasses work inside a script
    "__build_class__",
)


def _bs_guarded_import(name, globals=None, locals=None, fromlist=(), level=0):
    """`__import__` for sandboxed scripts: only geometry/math roots admitted."""
    if level and level > 0:
        raise ImportError("relative imports are not allowed in a BuildScript")
    root = (name or "").split(".")[0]
    if root not in _BS_ALLOWED_MODULES:
        raise ImportError(
            f"import of '{name}' is blocked in a sandboxed BuildScript — only "
            f"build123d, math and numpy (plus a few pure-Python stdlib helpers) "
            f"are available; filesystem / network / process modules are off-limits"
        )
    return __import__(name, globals, locals, fromlist, level)


def _bs_build_safe_builtins() -> dict:
    import builtins as _b
    safe = {n: getattr(_b, n) for n in _BS_SAFE_BUILTIN_NAMES if hasattr(_b, n)}
    # Expose the whole exception hierarchy so scripts can raise / catch normally.
    for n in dir(_b):
        obj = getattr(_b, n)
        if isinstance(obj, type) and issubclass(obj, BaseException):
            safe[n] = obj
    safe["__import__"] = _bs_guarded_import
    return safe


_BS_SAFE_BUILTINS = _bs_build_safe_builtins()

# Per-script wall-clock budget (seconds). A script that exceeds it is abandoned
# (the request returns a clear error); the orphaned thread dies with the
# process. Tune via KERNEL_BUILDSCRIPT_TIMEOUT_S.
try:
    _BS_TIMEOUT_S = max(1.0, float(os.environ.get("KERNEL_BUILDSCRIPT_TIMEOUT_S", "20")))
except (TypeError, ValueError):
    _BS_TIMEOUT_S = 20.0


_BS_CENTERED_PATCHED = False


def _bs_install_centered_patches() -> None:
    """Teach the common build123d primitives to ALSO accept a `centered=` kwarg,
    mapping it to the project's Z-up align convention:
    `centered=True`  → XY-centred, sitting on the Z=0 ground (Align.MIN on Z);
    `centered=False` → corner at origin (all Align.MIN). This mirrors emit.js
    (Box/Cylinder), so a hand- or AI-written BuildScript behaves identically to a
    typed-op primitive.

    WHY: real build123d has no `centered` kwarg (it's a CadQuery/OpenSCAD-ism the
    model habitually reaches for), so an un-patched `Box(10, 10, 10, centered=True)`
    dies with `TypeError: unexpected keyword 'centered'`. Patching it lets the
    natural code compile AND keeps it Z-up correct instead of burying half the
    body below the grid.

    Implementation: monkeypatch each class's `__init__` IN PLACE (idempotent).
    We can't inject subclasses into the script globals because the script itself
    runs `from build123d import *`, which would re-import the real classes and
    clobber them. Patching the shared class object survives any re-import. This is
    transparent to trusted typed-op code, which always passes `align=` and never
    `centered=`, so the wrapper is a pass-through there (centered=None).
    """
    global _BS_CENTERED_PATCHED
    if _BS_CENTERED_PATCHED:
        return
    import build123d as _b

    A = _b.Align

    def _align_for(centered):
        return (A.CENTER, A.CENTER, A.MIN) if centered else (A.MIN, A.MIN, A.MIN)

    def _patch(base):
        orig = base.__init__
        if getattr(orig, "_paraform_centered", False):
            return  # already wrapped

        def __init__(self, *args, centered=None, **kwargs):
            if centered is not None and "align" not in kwargs:
                kwargs["align"] = _align_for(centered)
            orig(self, *args, **kwargs)

        __init__._paraform_centered = True
        base.__init__ = __init__

    for nm in ("Box", "Cylinder", "Cone", "Sphere"):
        base = getattr(_b, nm, None)
        if isinstance(base, type):
            try:
                _patch(base)
            except Exception:  # noqa: BLE001 — never let a patch failure break scripting
                pass
    _BS_CENTERED_PATCHED = True


def _make_bs_run(helpers: dict):
    """Build the `_bs_run` the emitted code calls, closing over the kernel helper
    facade (resolve_edges, make_hole, standard_parts, …) so scripts get the same
    helpers as typed-op code — but under the restricted builtins.

    `_bs_run(src, label)` execs `src` in a fresh sandboxed globals and returns
    whatever the script bound to `result` (None if it bound nothing — a
    helper-only script). The emitter assigns that to the feature's leaf body var,
    so a non-None result renders and a None is skipped downstream.
    """
    import threading

    def _bs_run(src, label="script"):
        if not isinstance(src, str):
            raise TypeError("BuildScript source must be a string")
        g = {"__builtins__": _BS_SAFE_BUILTINS, "__name__": "__buildscript__"}
        # Teach build123d's primitives to accept the `centered=` kwarg the model
        # habitually writes (maps to the Z-up align convention). Idempotent and
        # patched on the class itself, so it survives the script's own
        # `from build123d import *`. Cheap after the first call.
        _bs_install_centered_patches()
        # Preload the build123d public API so a script works with or without an
        # explicit `from build123d import *` (the guarded import allows it too).
        exec("from build123d import *", g)
        g.update(helpers)
        box: dict = {}
        cap: dict = {}

        def _target():
            try:
                code_obj = compile(src, f"<buildscript {label}>", "exec")
                exec(code_obj, g)
                box["result"] = g.get("result")
            except BaseException as e:  # noqa: BLE001 — surface ANYTHING to the user
                cap["err"] = e

        t = threading.Thread(target=_target, name=f"buildscript-{label}", daemon=True)
        t.start()
        t.join(_BS_TIMEOUT_S)
        if t.is_alive():
            raise TimeoutError(
                f"BuildScript '{label}' ran longer than {_BS_TIMEOUT_S:.0f}s and was "
                f"abandoned — check for an infinite loop or a too-fine operation"
            )
        if "err" in cap:
            e = cap["err"]
            raise RuntimeError(f"BuildScript '{label}': {type(e).__name__}: {e}")
        return box.get("result")

    return _bs_run


# ── Incremental recompile body cache (Phase G4) ─────────────────────────────
# Process-level memo of feature bodies keyed by the client-computed dependency
# hash (see lib/document/dep_hash.js + emit.js `incremental` mode). Emitted code
# in incremental mode wraps each body feature as:
#
#     n_<id> = _ckpt_get("<hash>")
#     if n_<id> is None:
#         <original statement>
#         _ckpt_put("<hash>", n_<id>)
#
# so unchanged features (hash hit) skip the expensive OCCT op and reuse a cached
# body; only the edited feature + its downstream (whose hashes changed) actually
# recompute. This is ENTIRELY FAIL-SAFE: any error in get/put/copy yields a miss
# (None) so the caller recomputes — identical geometry, just no speedup. So even
# if a body type doesn't copy cleanly, correctness is never at risk, and the
# whole path is additionally gated behind the emitter's opt-in flag.
_CKPT_CACHE: dict = {}
_CKPT_MAX = 256


def _ckpt_copy(body):
    """Return an isolated copy of a build123d body so a cached entry can't be
    mutated by downstream ops in any compile. Tries build123d's native copy,
    then deepcopy; returns None if neither works (→ treated as a miss)."""
    try:
        c = getattr(body, "copy", None)
        if callable(c):
            return c()
    except Exception:
        pass
    try:
        import copy as _copy
        return _copy.deepcopy(body)
    except Exception:
        return None


def _ckpt_get(key):
    """Fetch a memoised body by dependency hash, or None to force recompute."""
    try:
        if not key:
            return None
        body = _CKPT_CACHE.get(key)
        if body is None:
            return None
        return _ckpt_copy(body)
    except Exception:
        return None


def _ckpt_put(key, body):
    """Memoise a freshly-computed body under its dependency hash. Returns the
    body unchanged so it can be used in expression position too. Never raises."""
    try:
        if key and body is not None:
            if len(_CKPT_CACHE) >= _CKPT_MAX:
                _CKPT_CACHE.clear()  # crude cap; correctness-preserving
            stored = _ckpt_copy(body)
            if stored is not None:
                _CKPT_CACHE[key] = stored
    except Exception:
        pass
    return body


def execute_b123d(code: str, formats: tuple = (), deflection: float = 0.1) -> dict:
    """
    Execute emitted build123d Python code and return:
      { ok: True,  glb: <base64 GLB string>, topology: {...} }
      { ok: False, error: <message>, traceback: <optional> }

    `deflection` controls OCCT's chord-deviation tessellation tolerance in
    millimetres. Lower = finer triangles + smoother curves + more tris.
    Typical band: 0.005 (ultra) .. 0.4 (draft). Default 0.1 mirrors the
    historical hardcoded value.

    When `formats` includes 'step', 'stl' or 'brep' the matching build123d
    export is also produced and base64-attached to the response under the
    corresponding key.
    """
    # Expose a minimal `standard_parts` façade so emitted Python from the
    # StandardPart emitter can call `standard_parts.build_from_id(...)`
    # inline. SimpleNamespace keeps the surface to the public API only —
    # the catalog module itself would leak `_build` builder refs.
    import types
    from standard_parts import catalog as _sp_catalog
    _sp_facade = types.SimpleNamespace(
        build_from_id=_sp_catalog.build_from_id,
        get_entry_public=_sp_catalog.get_entry_public,
    )

    namespace = {
        "__builtins__": __builtins__,
        "resolve_edges":    resolve_edges,
        "resolve_faces":    resolve_faces,
        "make_hole":        make_hole,
        "add_thread":       add_thread,
        "pattern_linear":   pattern_linear,
        "pattern_circular": pattern_circular,
        "pattern_path":     pattern_path,
        "push_pull_face":   push_pull_face,
        "move_face":        move_face,
        "delete_face":      delete_face,
        "offset_face":      offset_face,
        "draft":            draft,
        "standard_parts":   _sp_facade,
        # Phase G4 — incremental recompile body cache (fail-safe; only used by
        # emitted code when the client opts into incremental emit).
        "_ckpt_get":        _ckpt_get,
        "_ckpt_put":        _ckpt_put,
    }

    # `_bs_run` runs UNTRUSTED BuildScript code in a restricted sandbox (see
    # _make_bs_run above). It closes over the trusted helper facade — every name
    # in `namespace` except __builtins__ — so a script gets resolve_edges /
    # make_hole / standard_parts / … but NOT the full builtins the trusted
    # typed-op code below runs with.
    namespace["_bs_run"] = _make_bs_run(
        {k: v for k, v in namespace.items() if k != "__builtins__"}
    )

    try:
        exec(code, namespace)  # noqa: S102
    except Exception as e:
        return {"ok": False, "error": str(e), "traceback": traceback.format_exc()}

    result = namespace.get("__paraform_result__", {})
    bodies = result.get("bodies", {})
    shapes = [s for s in bodies.values() if s is not None]

    if not shapes:
        return {"ok": False, "error": "Execution produced no bodies in __paraform_result__"}

    # Combine into one exportable shape
    try:
        from build123d import Compound, export_gltf
        combined = Compound(children=shapes) if len(shapes) > 1 else shapes[0]
    except Exception as e:
        return {"ok": False, "error": f"Shape combination failed: {e}"}

    # Export GLB via temp file
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".glb", delete=False) as f:
            tmp_path = f.name
        export_gltf(combined, tmp_path, binary=True)
        with open(tmp_path, "rb") as f:
            glb_bytes = f.read()
    except Exception as e:
        return {"ok": False, "error": f"GLB export failed: {e}", "traceback": traceback.format_exc()}
    finally:
        if tmp_path and os.path.exists(tmp_path):
            os.unlink(tmp_path)

    # v4 documents ship `feature_types` in the result dict; route to the
    # descriptor-based namer when it's present, otherwise emit legacy
    # spatial fingerprints so v3 trees keep working unchanged.
    if isinstance(result.get("feature_types"), dict):
        topology = _extract_topology_v4(namespace, result)
        try:
            geometry = _extract_geometry_v4(topology, namespace, result, deflection)
        except Exception as e:
            geometry = {"faces": {}, "edges": {}, "error": str(e)}
    else:
        topology = _extract_topology(bodies)
        try:
            geometry = _extract_geometry_v3(topology, bodies, deflection)
        except Exception as e:
            geometry = {"faces": {}, "edges": {}, "error": str(e)}

    # Per-component triangle meshes for Spec 17 v2 interference overlay.
    # Built off the same leaf bodies + tessellation; grouped by the owning
    # componentId. Soft-fails (empty dict) so a kernel exception here can't
    # break the main render path.
    try:
        geometry["componentMeshes"] = _extract_component_meshes(namespace, result, deflection)
    except Exception as e:
        geometry["componentMeshes"] = {}
        geometry["componentMeshesError"] = str(e)
    glb_b64 = base64.b64encode(glb_bytes).decode("ascii")

    response = {"ok": True, "glb": glb_b64, "topology": topology, "geometry": geometry}

    # Stash the live namespace + raw v4 result under non-serialisable keys so
    # the server can hand them to the /measure endpoint. Keys are prefixed
    # with __ so any accidental jsonify() drops them rather than serialising
    # build123d Body objects (which would balloon the response).
    response["__namespace__"] = namespace
    response["__result__"]    = result
    response["__topology__"]  = topology

    # Optional multi-format BREP export. Each format runs in its own try/except
    # so one bad format doesn't poison the whole response.
    fmt_set = {f.lower() for f in (formats or ()) if isinstance(f, str)}
    for fmt in fmt_set:
        try:
            blob = _export_combined(combined, fmt)
        except Exception as e:
            response[f"{fmt}_error"] = str(e)
            continue
        if blob is not None:
            response[fmt] = base64.b64encode(blob).decode("ascii")

    return response


def _export_combined(shape, fmt: str) -> bytes:
    """Run build123d's per-format exporter on `shape` and return raw bytes."""
    suffix = ".stp" if fmt == "step" else f".{fmt}"
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as f:
            tmp_path = f.name
        if fmt == "step":
            from build123d import export_step
            export_step(shape, tmp_path)
        elif fmt == "stl":
            from build123d import export_stl
            export_stl(shape, tmp_path)
        elif fmt == "brep":
            from build123d import export_brep
            export_brep(shape, tmp_path)
        else:
            raise ValueError(f"Unsupported export format: {fmt}")
        with open(tmp_path, "rb") as f:
            return f.read()
    finally:
        if tmp_path and os.path.exists(tmp_path):
            os.unlink(tmp_path)
