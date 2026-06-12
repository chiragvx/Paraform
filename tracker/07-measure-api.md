# Phase 2.1 — Measure as programmatic query API

> **Status (2026-06-07):** ✅ landed. Kernel `POST /measure` endpoint
> with process-local last-execution cache (single-worker assumed; will
> shard under gunicorn). 11 query types implemented: bbox / volume /
> mass / surfaceArea / distance / holes / manifold / selfIntersection
> / interference / centroid / normal. OCCT `BRepExtrema_DistShapeShape`
> for distance; OCCT `BRepCheck_Analyzer` for manifold (Euler χ
> fallback). Sample-based selfIntersection flagged as v1 (false
> negatives possible). 23 Python corpus cases written; 11/11 JS
> client tests passing including cache hit/miss, LRU eviction, batched
> partial-failure paths. PropertiesPanel rewritten to use batched
> kernel measure with per-row loading + density-preset Mass row +
> graceful fallback to in-browser bbox traversal when kernel
> unreachable.



> Phase 2 of [TRACKER.md](../TRACKER.md). Strategy: [STRATEGY.md](../STRATEGY.md) §A3.
> Foundation work that unblocks the repair loop (08) and eval corpus (12).

## TL;DR

Promote Measure from a tier-A UX nicety to the **AI's verification
sensor**. A small typed query API the kernel exposes — bbox / point
distances / hole positions / mass / manifoldness / interference. The
generate → measure → repair loop in spec 08 builds on top.

## Why foundation

Per STRATEGY.md A3 / A1: "kernel is the arbiter, not the model." The
AI proposes geometry; the kernel produces ground truth; accuracy is
*measured*, never asserted. Without a programmatic measure surface,
"the part has a 4 mm wall" is hope, not fact.

This is also the API every Phase 2 deliverable consumes:
- 08 repair loop: feeds measurements + classified errors back to the model.
- 09 assumptions manifest: assertions are measure calls.
- 11 cheap DFM: thin wrappers over measure primitives.
- 12 eval corpus: every test is a measure-and-assert.

## Current state

**JS side (read-only inspect):**
- [PropertiesPanel.svelte](../src/lib/components/studio/inspector/PropertiesPanel.svelte) — computes triangle/vertex count, bbox min/max/size by traversing `studio.bridge.bodyTransform` and calling `THREE.Box3().setFromObject`. Run in the browser; bbox uses world-space corners.
- [ViewportHud.svelte](../src/lib/components/studio/ViewportHud.svelte) — same traversal pattern; selection count, hover XYZ, FPS RAF loop.
- No mass / volume / surface area / hole-pattern / interference queries today.

**Python kernel side:**
- [bridge.js](../lib/document/bridge.js) has `lastCompileMs` / `lastRenderMs` from F2.
- [b123d_server/harness.py](../b123d_server/harness.py) returns `glb` + `topology` on every `/execute`. No measure endpoint.
- build123d exposes `body.volume`, `body.bounding_box`, face area via OCCT — not currently surfaced.

## Scope

**In:**
- New `POST /measure` endpoint on the kernel — accepts a list of queries against the last-built doc; returns a list of typed results.
- Query types (v1):
  - `bbox(featureId | descriptor)` → `{min: [x,y,z], max: [x,y,z], size: [w,d,h]}`
  - `volume(featureId)` → `number` (mm³)
  - `mass(featureId, density?)` → `number` (g; default density 1g/cm³ if unspecified)
  - `surfaceArea(featureId | descriptor)` → `number` (mm²)
  - `distance(descriptorA, descriptorB)` → `number` (mm, min point distance)
  - `holes(featureId, axis?)` → `[{center: [x,y,z], diameter, depth}]` (cylindrical bore enumeration)
  - `manifold(featureId)` → `{closed: boolean, watertight: boolean, eulerNumber: number}`
  - `selfIntersection(featureId)` → `{ok: boolean, locations?: [x,y,z][]}` (sample-based v1)
  - `interference(featureIdA, featureIdB)` → `{intersects: boolean, volume?: number}`
  - `centroid(featureId | descriptor)` → `[x,y,z]`
  - `normal(faceDescriptor)` → `[nx,ny,nz]`
- New [src/lib/measure/api.js](../src/lib/measure/api.js) — typed JS client wrapping `/measure` calls. Batches a list, single round-trip per call.
- Cache results client-side keyed on `(query, bridge.lastCompileMs)` so the same query during one document state doesn't re-roundtrip.
- Expose `studio.measure(query | query[])` shorthand on the runtime so commands and the future eval harness can call cleanly.

**Out:**
- Real-time / streaming measurements (e.g. dynamic dragging).
- Curvature analysis / draft analysis (Phase 3).
- Anything that requires solving the topological-naming "find this face after edit" problem beyond what F3 already covers.

## Dependencies

- F1 smoke harness — to assert measure results in cases.
- F2 determinism — measurements should be deterministic across reruns.
- F3 topological naming — measure-by-descriptor only works when descriptors resolve reliably; for v1 the kernel-side resolver can accept either a featureId or a descriptor canonical string.

## Critical files

- New: `b123d_server/measure.py` — implementation of every query against build123d primitives.
- Modify: `b123d_server/server.py` — wire `POST /measure` route.
- New: `src/lib/measure/api.js` — JS client + types.
- Modify: `src/lib/studio/runtime.svelte.js` — add `measure()` shorthand.
- Modify: [PropertiesPanel.svelte](../src/lib/components/studio/inspector/PropertiesPanel.svelte) — switch the bbox/volume/mass rows to use the kernel API instead of the in-browser traversal so the numbers are authoritative.
- New: `src/lib/measure/__tests__/api.mjs` — mocked-kernel client tests + cache semantics.
- New: `b123d_server/__tests__/measure/test_*.py` — corpus for each measure type (bbox/volume/manifold/holes/etc.).

## Acceptance

- `curl -X POST :7823/measure -d '{"queries":[{"type":"bbox","featureId":"box_x"}]}'` returns a result list with one entry.
- `studio.measure({type: 'volume', featureId: 'X'})` resolves to a number in the browser.
- PropertiesPanel shows authoritative volume + mass from the kernel.
- Cache hit rate ≥ 90% on a session where the doc hasn't changed.
- New corpus passes ≥ 12 cases covering every query type.

## Open questions

- Wire format: per-query inline params, or a structured DSL like `queries.js`? Recommendation: inline params for v1; structured DSL when queries compose (Phase 3).
- Density default: 1 g/cm³ is water; better default is "ask the user" + per-material lookup once standard parts (10) is in.
- Holes enumeration: only cylindrical bores in v1; counterbore + countersink classification waits for F3 hole-namer xfails closing.

## Effort

~1.5 weeks — kernel-side measure implementations (~5 days), JS client + cache + tests (~3 days), PropertiesPanel rewire + corpus (~2 days).
