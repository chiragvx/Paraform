# Topological-naming regression corpus

This directory holds the 50-edit regression suite that gates Phase 1B of
the topological-naming work. Each test exercises **one parametric edit**
of a known starting document and asserts that the descriptor strings the
kernel emits for entities that *should* survive actually do — verbatim.

The contract these tests check against is
[`lib/document/NAMING_CONTRACT.md`](../../../lib/document/NAMING_CONTRACT.md).
The kernel-side implementation lives in
[`b123d_server/naming.py`](../../naming.py) and is driven via
[`harness._extract_topology_v4`](../../harness.py).

## What "survive" means

A *descriptor* is a structured `(kind, feature, opTag, part, parents)`
record produced by the kernel for every face/edge it emits. Stringified
canonically (see `naming.Descriptor.canonical()`), descriptors are the
keys downstream features use to refer to specific topology — `"the +Z
face of box_x"`, `"every face derived from sketch_a"`, etc.

A descriptor *survives* an edit iff the exact same canonical string is
emitted on both sides of the edit, for an entity that is semantically the
same (same direction, same role).

When dimensions change but the topology of the producing op doesn't —
e.g. `Box(10,10,10) → Box(20,10,10)` — every face descriptor must
survive. When topology *does* change — e.g. a fillet appears — only the
surfaces that weren't consumed by the new op should survive.

## How to run

```bash
pytest b123d_server/__tests__/naming/
```

The tests require `build123d` (and transitively OCP). When the kernel
deps aren't installed, the fixtures call `pytest.skip()` so the suite
fails loudly only when there's a real regression, not when the runner is
missing OCCT.

To see what's xfailed today (the known-fragile cases the v1 namer
doesn't handle yet):

```bash
pytest b123d_server/__tests__/naming/ -rx
```

To force xfails to "must pass" — useful when you've just landed a v2
boolean namer and want to see what flipped green:

```bash
pytest b123d_server/__tests__/naming/ --runxfail
```

## The 80% gate

Per [`NAMING_CONTRACT.md` § "Test corpus (Phase 1B exit gate)"](../../../lib/document/NAMING_CONTRACT.md#test-corpus-phase-1b-exit-gate),
Phase 1B exits when this corpus passes at **≥ 80%**. The remaining 20%
is documented in the contract as known limitations of the v1 descriptor
emitter (mostly boolean-related — `name_boolean` uses surface-type
ordinals, which shift under parametric edits).

Reaching 80% is the FreeCAD-1.0/RealThunder benchmark; we expect to ship
at that rate and improve over time. Each `xfail`-tagged test is a
*specific* known limitation, not a generic skip.

## Adding a case

A test in this directory follows the canonical shape:

```python
def test_<feature>_<change>_preserves_<set>(
    build_doc, extract_topology, descriptor_set, semantic_match, doc
):
    # 1. Build state A
    ns_a, res_a = build_doc(doc.build_box("box_x", 10, 10, 10))
    faces_a = descriptor_set(extract_topology(ns_a, res_a), kind="face")

    # 2. Build state B (one parameter changed)
    ns_b, res_b = build_doc(doc.build_box("box_x", 20, 10, 10))
    faces_b = descriptor_set(extract_topology(ns_b, res_b), kind="face")

    # 3. Assert the expected persistence
    expected = {f"face:box_x:box:{p}" for p in ("+X", "-X", "+Y", "-Y", "+Z", "-Z")}
    semantic_match(faces_a, faces_b, expected)
```

Helpers:

- **`build_doc(*specs)`** — assembles a `(namespace, result)` pair the
  harness accepts. Each spec is `(feature_id, body, feature_type,
  [parent_feature_ids])`. Convenience wrappers like
  `doc.build_box("fid", l, w, h)` return ready-made specs.
- **`extract_topology(namespace, result)`** — runs
  `harness._extract_topology_v4` and returns the topology dict.
- **`descriptor_set(topology, kind="face")`** — collects the canonical
  descriptor strings of every entity of the requested kind into a set.
- **`semantic_match(before, after, expected)`** — asserts every
  descriptor in `expected` appears in both `before` and `after`; raises
  with a readable diff when it doesn't.

For tests that probe a known-failing case, wrap with
`@pytest.mark.xfail(reason="...")` — **do not skip**. We want the failure
counted so the 80%-gate metric stays honest.

## Directory layout

| File                    | Owns                                                     |
|-------------------------|----------------------------------------------------------|
| `conftest.py`           | Pytest fixtures: `extract_topology`, `descriptor_set`, `semantic_match`, `build_doc`, `doc` |
| `doc_builder.py`        | DSL for assembling v4 `(namespace, result)` pairs        |
| `test_primitives.py`    | Box / Cylinder / Sphere / Torus parameter-edit cases     |
| `test_booleans.py`      | Union / Cut / Intersect cases                            |

Future modules to add as the corpus grows toward 50:

- `test_modify.py` — Fillet, Chamfer, Shell, Hole edits
- `test_patterns.py` — LinearPattern, CircularPattern instance-count changes
- `test_transforms.py` — Move/Rotate/Scale (descriptors should pass through unchanged)
- `test_sketches.py` — Sketch-driven Extrude / Revolve edits
