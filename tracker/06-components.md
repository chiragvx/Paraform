# Foundation 6 — Component / instance layer with stored-doc migration

> **Status (2026-06-07):** ✅ commits 1+2+3 of 3 landed. Tests:
> 10/10 migration + 11/11 data-layer + 13/13 ops + 9/9 picker refs =
> 43/43 component-suite tests passing. Carry-over fix: stale
> `Align.CENTER`-on-Z expectation in `lib/document/__tests__/emit.mjs`
> (primitives suite) and `integration.mjs` updated to assert
> `Align.MIN` on Z per CLAUDE.md Z-up rule; Cylinder's emit default
> updated to match (XY-centred, sitting on Z=0).
>
> **Commit 1** — data model + v4→v5 migrator. Every doc has
> `doc.components.root`. v4 auto-migrates; persistence/DiffViewer
> accept v4+v5.
>
> **Commit 2** — path-qualified runtime contexts. Features now carry
> `componentId` (default `'root'`); `componentPathFor(doc, id)` walks
> the parent chain; `featuresInComponent(id)` + `featureOrderInComponent`
> on the store. Operations.js' active-component provider closure pulls
> the runtime's `studio.activeComponentId` ($state, defaults `'root'`)
> without a circular import — runtime installs `setActiveComponentProvider`
> at boot. Bridge mounts per-component THREE.Group subgroups under
> `bodyTransform` with origin transforms applied; `componentSubgroup(id)`
> getter creates on demand. Picker layer (pick_proxies + refs +
> wiring.js) stamps `componentPath: string[]` on every pick payload
> (three-layer fallback for robustness). Descriptors and canonical
> strings untouched.
>
> **Commit 3** — landed. Four new changelog kinds
> (`ADD_COMPONENT`/`REMOVE_COMPONENT`/`RENAME_COMPONENT`/
> `SET_FEATURE_COMPONENT`) with fold handlers covering idempotency,
> root-removal protection, cascade-delete reassignment to parent,
> fallback to root on missing target. Operations:
> `addComponent`/`removeComponent`/`renameComponent`/
> `setFeatureComponent` all undo-able via the standard commit
> pipeline. Store helpers `componentChildren`/`componentDescendants`
> exposed both as methods and free `(doc, ...)` functions.
> `ComponentBrowserPanel.svelte` mounts above the Sidebar feature
> list: flat-array tree render with depth-based indent, single-click
> activation, double-click rename via `window.prompt`, "+ Add"
> header, root-gated delete. Four registry commands:
> `component.create`, `component.activate`, `component.delete`,
> `feature.moveToActiveComponent`. 13 new ops tests pass + the
> existing 11+10+6 from commits 1-2 = 40/40 component-suite tests
> passing.
>
> **F6 = ✅.** Remaining backlog (out of this foundation's scope):
> external STEP-as-component import (depends on browser STEP shim),
> per-component activation in the Viewport HUD, drag-to-reparent in
> the browser tree.



> Phase 1 of [TRACKER.md](../TRACKER.md). Strategy rationale in
> [STRATEGY.md](../STRATEGY.md) §F4.

## TL;DR

Introduce a thin component / instance layer in the document model
*before* joints, assemblies, drawings, or BOM exist. Every node
owns its own feature timeline + origin frame; a single-part document
is just the root component. **Not thin to implement** — every
`featureId` reference becomes path-qualified, picker descriptors
change, serialization changes, and there's a real migration story
for v0.27 documents already in users' localStorage.

## Why foundation

F4 in STRATEGY.md. Multi-body designs, AI-generated multi-part
output, joints, drawings, motion, BOM all sit on a component
hierarchy that doesn't exist yet. Retrofitting after the flat
timeline grows is far more painful than introducing the layer now
when documents are small.

This is the foundation item with the highest *implementation* cost
relative to its conceptual size — the rest of the system has
hardcoded "the document has one timeline" assumptions everywhere.

## Current state

**Flat timeline:**
- [lib/document/store.js](../lib/document/store.js) — `doc.features`
  is a flat map of `featureId → Feature`; `doc.featureOrder` is a
  flat ordered list. Verified by grepping ~23 files for `featureId`.
- [lib/document/bridge.js](../lib/document/bridge.js) — the body
  group sits flat under `bridge.bodyTransform`. Per-feature meshes
  are tagged via `userData.featureId`. No nested-component frame.
- [lib/picking/pick_proxies.js](../lib/picking/pick_proxies.js) +
  [app/picking/wiring.js](../app/picking/wiring.js) — every pick
  descriptor carries a flat `featureId` reference.
- [lib/document/descriptor.js](../lib/document/descriptor.js) —
  descriptor's `feature` field is a `FeatureId`, not a path.

**v0.27 documents in the wild:**
- `localStorage['paraform_v4_document']` shape is `{ version: 4,
  changelog, head }`. Already deployed; users have docs there. A
  schema change needs a migrator.

## Scope

**In:**
- New `Component` data type in
  [lib/document/types.js](../lib/document/types.js):
  `{ id, name, origin: Transform, features: { [fid]: Feature },
  featureOrder: FeatureId[], children: ComponentId[] }`. Root
  component has no parent; nested components reference parent via
  reverse lookup.
- `componentPath` — array of component ids from root to feature:
  `['root', 'leftPlate', 'bracket']`. Every command operating on
  "selected feature" gains a `componentPath` context.
- Path-qualified featureId: keep `featureId` as a string (no
  breaking change) but add `componentPath` alongside on every
  descriptor / pick / command. A feature's id stays globally
  unique; the path tells you which subtree it lives in.
- Serialization migration: `paraform_v4_document` v4 → v5. v4 has
  flat `features` / `featureOrder`; v5 has a `components` tree with
  root. Migrator: read v4, wrap everything in `root` component,
  write v5. Versioning per Foundation 2.
- Per-component origin frame. The bridge mounts each component's
  body group under a parent transform; sketches in that component
  resolve in its local frame.
- "Active component" context — at any time exactly one component is
  "active" (like Fusion's component activation). Sketches +
  feature-creation commands target the active component's timeline.
- `InsertComponent` op (stub today in catalog) becomes the basic
  insertion mechanism: copy or reference another component as a
  child of the active one with a given transform.

**Out:**
- Joints. Foundation, not joints. The five joint stubs in
  [lib/document/types.js](../lib/document/types.js) (`JointRigid`,
  `JointRevolute`, `JointSlider`, `JointCylindrical`, `JointPlanar`)
  stay stubs. Joints get their own future foundation; this layer
  just gives them a place to live.
- External component references (link a `.f3d` / `.step` URL as a
  component). Defer — requires the working STEP browser-import
  path.
- Component-level parameters (parameters scoped to one component
  rather than the document). Per Foundation 5 open question, keep
  parameters document-scoped in v1.
- Drawings, motion, BOM. All gated on this layer being real but
  none ship in this foundation.

## Dependencies

- Foundation 2 (determinism): the v4→v5 migrator needs to be
  deterministic so the same input always produces the same v5 doc.
- Foundation 3 (topological naming) carries forward — descriptors
  pick up an implicit `componentPath` via the `feature` field's
  context, but the descriptor canonical string format may need to
  encode the path. Coordinate with NAMING_CONTRACT.md authors
  before changing the string format.
- Foundation 5 (parameters) carries forward — parameter scope
  question gets revisited here.

## Critical files

- Modify: [lib/document/types.js](../lib/document/types.js) — add
  `Component` type + `componentPath` field on every entity ref.
- Modify: [lib/document/store.js](../lib/document/store.js) — the
  store reorganizes around components; commands take a
  `componentPath` arg.
- Modify: [lib/document/migrate.js](../lib/document/migrate.js) —
  add v4 → v5 migrator. (Note: `migrate.js` already exists per the
  earlier grep — verify what it does and extend.)
- Modify: [lib/document/bridge.js](../lib/document/bridge.js) —
  body group per component; each parent transform from the
  component's origin.
- Modify: [lib/document/emit.js](../lib/document/emit.js) — emit
  one Python `Compound` per component? Or flatten at emit time?
  Decide per the build123d capability survey.
- Modify: [app/picking/wiring.js](../app/picking/wiring.js) +
  [lib/picking/pick_proxies.js](../lib/picking/pick_proxies.js) —
  picks carry componentPath.
- New: `src/lib/components/studio/ComponentTreePanel.svelte` — the
  "browser" UI in Fusion's left rail.
- Modify: [src/App.svelte](../src/App.svelte) — wire the new
  panel into the Sidebar.
- Modify: [lib/document/persistence.svelte.js](../src/lib/document/persistence.svelte.js)
  — call the migrator on load.

## Acceptance

- A v4 document round-trips through the migrator: load → migrate to
  v5 → save → load → identical bodies in the scene.
- A new document creates a single root component with the existing
  flat-timeline semantics — nothing visible changes for a user not
  using components.
- A user can: insert a child component, activate it, sketch in its
  frame, extrude — the resulting body sits at the child's transform.
- The component browser panel shows the tree; clicking a component
  activates it.
- The picker tags every selection with the correct `componentPath`.
- Foundation 1 smoke harness includes at least one nested-component
  case.

## Open questions

- Migrator strategy: silent (wrap in `root`, never tell the user) or
  loud (one-time prompt "your document was upgraded")? Silent is
  less friction; loud is more transparent. Recommendation: silent,
  log to console + StatusBar chip.
- Component identity across migrator runs: stable hash of v4 doc
  contents, or fresh UUID? Stable hash means re-migrating produces
  the same component id, which matters for any external references.
- Does emit produce one Python module per component or a flat
  module with frame transforms? Build123d's `Compound` makes the
  per-component option natural; depends on whether OCCT cleanly
  handles boolean ops across nested transforms. Recommendation:
  start flat, transform at body level, migrate to nested compounds
  if performance / clarity demands.
- How does the Component path affect the descriptor canonical
  string? Probably needs to become
  `<componentPath>:<kind>:<feature>:<opTag>:<part>(<parents>)`. Has
  to be coordinated with the JS + Python sides simultaneously —
  this is the kind of change that breaks NAMING_CONTRACT.md if not
  done atomically.

## Effort

**4–8 weeks.** Highest effort of all Phase 1 items. Most of the cost
is the in-place refactor: every command, every picker callsite,
every descriptor consumer needs the componentPath context threaded
through. The migrator + UI is ~1 week; the data-model surgery is
the rest.

Critical risk: the descriptor canonical-string change has to land
atomically across JS + Python + serialization or it breaks every
stored document. Plan a migration window with both formats accepted
for ~1 release before flipping the default.
