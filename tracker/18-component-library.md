# Spec 18 — Atomic component library + KSP-style snap-mate system

> **Status (2026-06-08): 🟡 v1 landed.**
>
> Atomic component library with typed connectors, library palette, AI
> fetch surface, and snap-mate drag/drop UX. See [TRACKER.md](TRACKER.md)
> for the project-wide spec index.

## Goal

A library of atomic parts (fasteners, brackets, standoffs, bearings,
clamps, …) with typed *connectors*. A user can drag a part from the
palette into the viewport and the ghost snaps to the nearest compatible
connector with auto-rotation (KSP-style mate). The AI can fetch parts
via `findPart(query)` and emit `placeLibraryPart` ops. Bearing-in-bore
+ shaft connectors *induce* a revolute joint automatically. Composite
parts (stand, clamp assembly) are stored as multi-part components and
fetched the same way.

## Critical files (v1)

| Area | File |
|---|---|
| Connector primitive + makeConnector / newConnectorId | [lib/document/types.js](../lib/document/types.js) |
| Connector changelog kinds + builders | [lib/document/changelog.js](../lib/document/changelog.js) |
| Connector fold handlers | [lib/document/fold.js](../lib/document/fold.js) |
| Connector ops (addConnector / updateConnector / removeConnector) | [lib/document/operations.js](../lib/document/operations.js) |
| Library schema | [src/lib/library/schema.js](../src/lib/library/schema.js) |
| Atomic part records | [src/lib/library/parts/](../src/lib/library/parts/) |
| Composite part records | [src/lib/library/parts/composite/](../src/lib/library/parts/composite/) |
| Loader + findPart + getPartById + listByCategory | [src/lib/library/index.js](../src/lib/library/index.js) |
| Snap-mate solver | [src/lib/library/mate_solver.js](../src/lib/library/mate_solver.js) |
| placeLibraryPart op | [src/lib/library/place.js](../src/lib/library/place.js) |
| AI fetch hook | [src/lib/repair/llm_client.js](../src/lib/repair/llm_client.js) + [src/lib/repair/constraint_to_ops.js](../src/lib/repair/constraint_to_ops.js) |
| Connector overlays | [src/lib/picking/connector_overlays.js](../src/lib/picking/connector_overlays.js) |
| Palette UI | [src/lib/components/studio/LibraryPalette.svelte](../src/lib/components/studio/LibraryPalette.svelte) |
| Connector inspector panel | [src/lib/components/studio/inspector/ConnectorsPanel.svelte](../src/lib/components/studio/inspector/ConnectorsPanel.svelte) |
| Snap-drag wiring | [src/lib/components/studio/Viewport.svelte](../src/lib/components/studio/Viewport.svelte) |
| Tests | [src/lib/__tests__/spec18_component_library.mjs](../src/lib/__tests__/spec18_component_library.mjs) |

## Connector primitive

```js
{ id, parent: partId|componentId,
  kind: 'thread'|'bore'|'planar'|'shaft'|'tab'|'slot'|'rail',
  gender: 'male'|'female'|'neutral',
  size: { nominal, unit },
  axis: [x,y,z], origin: [x,y,z],
  mates_with: [kind],
  inducedJoint: 'fixed'|'revolute'|'prismatic'|null,
  metadata: { description } }
```

Connectors live on parts/components, *not* features. They're folded
through three changelog kinds (`add-connector`, `update-connector`,
`remove-connector`) into `doc.connectors` (a Map keyed by id).

## Library record

```js
PartRecord = {
  id, name,
  category: 'fastener'|'nut'|'washer'|'standoff'|'bracket'|'bearing'|'pulley'|'rail'|'misc',
  source: 'parametric'|'glb'|'standard-part'|'composite',
  build?: { type: 'standard-part', catalogId, params } | { type: 'parametric', snippet },
  glbBase64?: string,
  connectors: Connector[],
  tags: [string], keywords: [string],
  boundingBox: { min:[x,y,z], max:[x,y,z] },
  weight?: number, manufacturer?: string, datasheet?: string,
  members?: [{ partRecordId, transform, mates: [...] }] // composite
}
```

## v1 acceptance

- [x] `loadLibrary()` reads all JSON under `src/lib/library/parts/`
  (and `composite/`) at build time via `import.meta.glob`.
- [x] `findPart(query, { context? })` returns ranked hits, filtered to
  mate-compatible parts when a host connector is supplied.
- [x] `getPartById(id)`, `listByCategory(category)`, `listCategories()`.
- [x] `connectorsCompatible(a,b)` covers all kind × gender × size pairs.
- [x] `solveMateTransform(...)` aligns thread/bore connectors axes
  anti-parallel with origins coincident; planar mate yields coplanar.
- [x] `inducedJointFromMate(a,b)` returns `'revolute'` for
  bore-bearing + shaft-male; `'fixed'` for thread+thread.
- [x] `placeLibraryPart({ partId, mate })` creates a `Component` for
  the part and (if induced) a `Joint`. Recurses for composites.
- [x] AI hook: `PartSelection` constraint with no `catalogPrefix`/`-`
  match in the v2 catalog falls back to `placeLibraryPart` when
  `findPart` returns a hit.
- [x] Connector overlays + ConnectorsPanel + LibraryPalette UI wired.
- [x] Test suite — ~30 assertions, run via the `_register.mjs` ESM
  hook.

## Scope in / out

**In v1:**
- 50 atomic parts (fasteners, nuts, washers, standoffs, brackets,
  bearings, pulleys, rails, misc).
- 5 composite parts (belt-tensioner, NEMA17 mount, camera mount,
  T-slot end-bracket, ball-caster wheel).
- Hand-curated connector lists on every record.
- Keyword + tag substring search.
- KSP-style snap drag: cursor radius → nearest compatible connector
  → ghost preview → Tab cycles top-3 → Esc cancels → Drop confirms.

**Deferred to v2:**
- Embedding-based retrieval. v1 is pure keyword/tag.
- Auto-connector inference from STEP geometry. v1 is hand-tagged.
- Mate-driven dimension constraints (screw length follows stack
  thickness). v1 leaves length picking to the user / AI.
- Imperial fasteners (UN/UNF/UNC). v1 is metric-only.
- Real thumbnail renders. v1 uses category icons + size badges.
- Per-mate offset / clocking parameters (KSP "rotate around axis").
  v1 picks deterministic orientation.

## Open questions

- Do we want the kernel-side catalog (148 ISO entries) to be the
  *source of truth* and library JSON files purely overlay
  connectors+tags? v1 ships standalone JSON because the kernel
  catalog has no connector data — adding it would touch a Python
  schema. Revisit when v2 wants imperial fasteners.

## Dependencies

- Component / instance layer (spec 06) — placeLibraryPart commits an
  empty Component then re-parents members of a composite under it.
- Joint type (spec 17 v1) — induced revolute / fixed joints created
  via `addJoint`.
- Topological naming (spec 03) — host connector references resolve to
  a face descriptor for snap.

## Reference back

- [TRACKER.md](TRACKER.md)
