"""
Harness helpers injected into the user code's globals.

The browser-side emitter (lib/tree/emit.js) generates Python that assumes
these helper functions exist:
    resolve_edges, resolve_faces, make_hole, add_thread,
    pattern_linear, pattern_circular, pattern_path,
    push_pull_face, draft, split, scale, import_step

Phase 0 implementations are deliberately simple — they prove the
round-trip, but Phase 2 will replace them with topology-aware
implementations that use fingerprint queries to resolve faces/edges.
"""

from build123d import (
    Axis, Box, Cylinder, Align, Plane, Vector,
)


# ── Topology query stubs ───────────────────────────────────────────────────
def resolve_edges(body, queries):
    """
    Phase 0: ignore the fingerprint queries, return all edges.
    Phase 2 will match fingerprints against actual face/edge geometry.
    """
    return body.edges()


def resolve_faces(body, queries):
    """Phase 0 — return all faces (or empty if queries empty)."""
    if not queries:
        return []
    return body.faces()


# ── Hole / thread ──────────────────────────────────────────────────────────
def make_hole(body, location=None, diameter=3.2, depth=None,
              counter_bore_diameter=None, counter_bore_depth=None,
              counter_sink_diameter=None, counter_sink_angle=None):
    """
    Simplified hole — drills through the body's bounding-box center.
    Real face-located holes land in Phase 2 with the topology query system.
    """
    bb = body.bounding_box()
    if depth is None:
        depth = bb.size.Z + 2  # through-hole

    drill = Cylinder(
        diameter / 2.0, depth + 0.2,
        align=(Align.CENTER, Align.CENTER, Align.CENTER),
    )
    # Position drill at the top of the bounding box, drill downward
    z_top = bb.max.Z + 0.1
    drill = drill.translate(Vector(0, 0, z_top - depth / 2.0))

    result = body - drill

    if counter_bore_diameter and counter_bore_depth:
        cbore = Cylinder(
            counter_bore_diameter / 2.0, counter_bore_depth + 0.2,
            align=(Align.CENTER, Align.CENTER, Align.CENTER),
        ).translate(Vector(0, 0, z_top - counter_bore_depth / 2.0 + 0.1))
        result = result - cbore

    return result


def add_thread(body, location=None, spec="M3", length=10):
    """Phase 0 stub — Phase 2 wraps build123d's IsoThread."""
    return body


# ── Pattern operations ─────────────────────────────────────────────────────
def pattern_linear(body, axis=Axis.X, count=2, spacing=10):
    """Linear pattern along an Axis."""
    if count <= 1:
        return body
    direction = axis.direction if hasattr(axis, "direction") else Vector(1, 0, 0)
    result = body
    for i in range(1, count):
        offset = Vector(direction.X * i * spacing,
                        direction.Y * i * spacing,
                        direction.Z * i * spacing)
        result = result + body.translate(offset)
    return result


def pattern_circular(body, axis=Axis.Z, count=4, angle=360):
    """Circular pattern around an Axis."""
    if count <= 1:
        return body
    step = float(angle) / count
    result = body
    for i in range(1, count):
        result = result + body.rotate(axis, i * step)
    return result


def pattern_path(body, path=None, count=5):
    """Phase 0 — Phase 3 implements true path patterning."""
    return body


# ── Direct edit stubs ──────────────────────────────────────────────────────
def push_pull_face(body, face_query, distance=1):
    """Phase 0 stub — direct edits land in Phase 5."""
    return body


def draft(body, faces, direction, angle):
    """Phase 0 stub."""
    return body


def split(target, by=None):
    """Phase 0 stub — return target unchanged."""
    return target


def scale(body, by=1):
    """Uniform scale around origin."""
    if hasattr(body, "scale"):
        return body.scale(by)
    return body


# ── STEP import ────────────────────────────────────────────────────────────
def import_step(path):
    """
    Phase 0 placeholder — returns a 10mm box.
    Phase 4 wires this to a real STEP library (vendor parts under app/library/).
    """
    return Box(10, 10, 10)


HARNESS_GLOBALS = {
    "resolve_edges":   resolve_edges,
    "resolve_faces":   resolve_faces,
    "make_hole":       make_hole,
    "add_thread":      add_thread,
    "pattern_linear":  pattern_linear,
    "pattern_circular":pattern_circular,
    "pattern_path":    pattern_path,
    "push_pull_face":  push_pull_face,
    "draft":           draft,
    "split":           split,
    "scale":           scale,
    "import_step":     import_step,
}
