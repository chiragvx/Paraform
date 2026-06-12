# Topological Naming Contract — Kernel Side

This document specifies the contract between the JS document layer
([lib/document/](.)) and the Python kernel
(`b123d_server/`) for topological naming.

The JS side is implemented and tested
(`npm test`). The Python implementation lands in Phase 1B as
`b123d_server/naming.py`. This document is the spec that implementation
must satisfy.

## Background

Parametric CAD edits succeed only when downstream features can resolve their
references *after* upstream geometry changes. The current approach in
[`b123d_server/harness.py`](../../b123d_server/harness.py) uses 2 mm spatial
fingerprint matching — fragile under any meaningful parameter change.

The replacement is symbolic descriptors emitted *during* each operation,
mirroring FreeCAD 1.0's RealThunder pattern.

## The descriptor

Every topological entity (face / edge / vertex) produced by a feature is
tagged with a `Descriptor`. The JS shape:

```js
{
    kind:    'face' | 'edge' | 'vertex',
    feature: FeatureId,         // owning feature (the producer)
    opTag:   string,            // see OP_TAGS in descriptor.js
    part:    string,            // ordinal tag ('+Z', 'side[0]', 'blend', ...)
    parents: Descriptor[],      // upstream descriptors this entity derives from
}
```

The Python equivalent **must serialise to JSON with these exact field names
and types**. No `_camel_case`, no `snake_case` rewrites. The client parses
descriptors literally.

### Canonical string form

The JS resolver builds map keys, set membership tests, and hashes by
canonical-stringifying descriptors. Format:

```
<kind>:<feature>:<opTag>:<part>[(<parent1>,<parent2>,...)]
```

Examples:

```
face:box_x:box:+Z
edge:box_x:box:+X+Z
face:fill_a:fillet:blend(edge:box_x:box:+X+Z)
face:hole_b:hole:counterbore-side(face:box_x:box:+Z)
```

The Python kernel **does not have to compute the canonical string** — it
just emits the structured form and the JS layer stringifies. But if the
kernel logs strings for debugging, they should match exactly.

## OP_TAGS (the controlled vocabulary)

The single source of truth is
[descriptor.js](descriptor.js)'s `OP_TAGS`
export. **Adding a new op tag to the kernel without adding it to JS breaks
queries silently** — they will return empty sets without error.

Current tags:

```
box, cyl, sphere, torus,
extrude, revolve, sweep, loft,
fillet, chamfer, shell, draft, hole, thread, offset,
union, cut, intersect, split,
linpat, cirpat, pathpat, mirror,
xform,
sketch, project,
```

Any new feature type added to Python harness MUST also be added here.

## `part` tag convention

`part` is an ordinal — a short, deterministic label that distinguishes
entities produced by the same op within the same feature. The kernel
chooses these tags; the JS layer treats them as opaque strings.

Conventions (followed by the harness implementation):

| Feature type | face `part` tags          | edge `part` tags         |
|--------------|---------------------------|--------------------------|
| Box          | `+X`, `-X`, `+Y`, `-Y`, `+Z`, `-Z` | `+X+Z`, `+X-Z`, etc. (axis pairs) |
| Cylinder     | `top`, `bottom`, `lateral` | `top-ring`, `bottom-ring`, `seam` |
| Sphere       | `surface`                  | (none)                   |
| Torus        | `tube`                     | (none)                   |
| Extrude      | `start`, `end`, `side[i]`  | `start-loop[i]`, `end-loop[i]`, `side-spine[i]` |
| Revolve      | `start`, `end`, `lateral`  | rings                    |
| Loft         | `start`, `end`, `side[i]`  | rings                    |
| Fillet       | `blend`                    | `blend-spine`, `blend-cross[i]` |
| Chamfer      | `bevel`                    | `bevel-edges[i]`         |
| Shell        | `inner-<parentTag>`        | `inner-ring[i]`          |
| Hole         | `counterbore-side`, `bore-side`, `bottom`, `countersink-cone` | rings |
| Cut/Union/Intersect | `from-target-<parentTag>`, `from-tool-<parentTag>` | … |
| Pattern      | `inst[i]-<originalPart>`   | `inst[i]-<originalPart>` |
| Mirror       | `mir-<originalPart>`       | `mir-<originalPart>`     |
| Transform    | `<originalPart>` (unchanged) | `<originalPart>` (unchanged) |

The `[i]` index is the operation-local ordinal (e.g. `inst[3]` is the
fourth instance of a pattern). Indexes must be deterministic across
rebuilds for unchanged parameters — re-emitting `inst[3]` for the same
geometry across rebuilds is what makes downstream references survive.

## Parents

`parents` carries the lineage. Every derived entity must list the
upstream descriptor(s) it was created from. The rules:

- **Boolean Cut**: each surviving face from the target keeps its descriptor;
  faces created by the cut carry the tool face as parent.
- **Boolean Union**: surviving target/tool faces keep their descriptors;
  blend faces (if any) carry both as parents.
- **Fillet / Chamfer**: the new blend/bevel face carries the eliminated
  edge as parent. The eliminated edge is itself a parent of any new edges
  the operation produces along the blend's seams.
- **Pattern**: instance face `inst[3]/+Z` carries the original face as
  parent (`face:source/op/+Z`).
- **Mirror**: mirrored face carries the original face as parent.
- **Shell**: inner offset face carries the original face as parent.
- **Transform**: parents are passed through unchanged (the descriptor's
  `feature` does change to the Transform feature's id; `parents[0]` carries
  the original).

Parents enable `qDescendsFrom(query, ancestor)` — a critical query for
"every face derived from this sketch loop" workflows.

## Wire format

The kernel attaches a `topology` field to the `/execute` response (or
whatever stdio protocol Phase 1D adopts). Shape:

```json
{
    "ok": true,
    "glb": "<base64>",
    "topology": {
        "nodes": [
            {
                "featureId": "box_x",
                "faces": [
                    {
                        "descriptor": {
                            "kind": "face",
                            "feature": "box_x",
                            "opTag": "box",
                            "part": "+Z",
                            "parents": []
                        },
                        "centerRounded":  [0.0, 0.0, 5.0],
                        "normalRounded":  [0.0, 0.0, 1.0],
                        "area": 100.0,
                        "surfaceType": "planar"
                    }
                ],
                "edges": [...],
                "vertices": [...]
            }
        ]
    }
}
```

Required fields per entry:
- `descriptor` — full structured form, parents inline (not by reference).

Optional fields (the resolver uses them when present):
- `centerRounded` — `[x, y, z]` rounded to 2 decimals.
- `normalRounded` — face surface normal at centroid; unit vector rounded
  to 4 decimals.
- `tangentRounded` — edge tangent at midpoint; unit vector rounded to 4
  decimals.
- `area` / `length` — face area, edge length.
- `surfaceType` — one of `planar`, `cylindrical`, `spherical`, `conical`,
  `toroidal`, `other`.
- `closed` — edges only; whether the edge is a closed loop.

## Determinism guarantees the kernel must hold

The naming system depends on the kernel being deterministic in three
specific ways. These are non-negotiable; violating them turns descriptors
back into spatial fingerprints.

1. **Iteration order.** When the kernel walks an OCCT shape's faces or
   edges to attach descriptors, it must iterate in a stable order that does
   not depend on memory addresses or build flags. OCCT's `TopExp_Explorer`
   is order-stable across runs *on the same shape*; the kernel must wrap
   any container that isn't (Python `dict` is, since 3.7; `set` is not —
   never iterate a `set` to assign `part` indexes).

2. **`part` index stability.** When the kernel uses `[i]` indexes
   (`inst[i]`, `side[i]`, ...), the index must be derived from a stable
   per-op coordinate (instance number, sketch-loop ordinal, etc.) — not
   from iteration order over a `set` or memory layout.

3. **Parent emission.** Every operation must emit its parents fully and
   correctly. Missing a parent doesn't crash; it silently breaks
   `qDescendsFrom` queries. The kernel test suite (Phase 1B's 50-edit
   corpus) is what catches these.

## Migration from the current fingerprint system

The 2 mm fingerprint system in
[`b123d_server/harness.py:23-60`](../../b123d_server/harness.py) keeps working during
the migration window. The transition plan:

1. **Add descriptors alongside fingerprints.** The new `naming.py` emits
   both — descriptors on every face/edge plus the existing `face_fp`
   record. Client code can ignore descriptors initially; the resolver
   silently no-ops on missing descriptor entries.

2. **Update emitters.** [`lib/tree/emit.js`](../tree/emit.js) builds
   `face_fp` / `edge_fp` dicts in Python source. After the migration, it
   emits descriptor queries instead — strings the kernel knows how to
   re-resolve.

3. **Deprecate fingerprints.** Once all features route through
   descriptors and the regression corpus passes at ≥80%, remove the
   `resolve_faces` / `resolve_edges` helpers entirely.

This is staged work — descriptors and fingerprints coexist for at least a
few months.

## Test corpus (Phase 1B exit gate)

The 50-edit regression corpus that gates Phase 1B sits at
`b123d_server/__tests__/naming/` (to be created). Each test:

1. Builds a known starting document.
2. Snapshots the descriptor strings of every feature output.
3. Applies a parameter change.
4. Asserts that *the same descriptor strings* resolve to the
   semantically-correct new entities.

The 80% pass-rate target is described in the foundation plan and matches
FreeCAD 1.0's RealThunder rate. The 20% that fails is documented as
"known limitations" in this file.

## References

- FreeCAD 1.0 `TopoShape::makESHAPE()` — closest open reference.
  https://github.com/realthunder/FreeCAD_assembly3/wiki
- Onshape FeatureScript `qFilter` / `qNthElement` / `qContainsPoint`.
  https://cad.onshape.com/FsDoc/library.html
- Ait-Aoudia & Mahiou 2018 — "Mechanisms of Persistent Identification of
  Topological Entities in CAD Systems: A Review",
  ScienceDirect S1110016818300814.
- Kripac 1997 — "A mechanism for persistently naming topological entities
  in history-based parametric solid models." *Computer-Aided Design*
  29(2).
