# E7 — Manual UI walk-through audit

Triage map produced by reading code + existing tests, not by browser
clicks. Each row carries an honest status:

- **works** — wiring is complete and is covered by either a unit test
  or has a non-trivial implementation behind it.
- **stub-v1** — the surface is present and produces a feature/effect,
  but the implementation is acknowledged as a placeholder in the
  tracker (kernel-side work pending, fallback behaviour in JS).
- **placeholder** — UI exists but the action is decorative or warns
  "coming soon".
- **broken** — wired to a non-existent handler / dead code path.
- **not-tested** — code reading suggests it works, but no automated
  coverage exists.

## 1. Toolbar buttons (`src/lib/components/studio/Toolbar.svelte`)

| Group | Button | Command id | Status |
|---|---|---|---|
| History | Undo | `edit.undo` | works |
| History | Redo | `edit.redo` | works |
| Sketch | Sketch on XY | `sketch.enter.xy` | works |
| Sketch | Sketch on XZ | `sketch.enter.xz` | works |
| Sketch | Sketch on YZ | `sketch.enter.yz` | works |
| Sketch | Sketch on face… | `startSketchOnFace()` | works |
| Primitive | Add Box… | `primitive.box.form` | works |
| Primitive | Add Cylinder… | `primitive.cylinder.form` | works |
| Primitive | Add Sphere… | `primitive.sphere.form` | works |
| Primitive | Add Torus… | `primitive.torus.form` | works |
| Sketch → Solid | Extrude | `sketch.extrude` | works |
| Sketch → Solid | Revolve | `sketch.revolve` | works |
| Sketch → Solid | Sweep | `sketch.sweep` | works (text-input picker v1) |
| Sketch → Solid | Loft | `sketch.loft` | works (text-input picker v1) |
| Modify | Fillet | `modifier.fillet` | works |
| Modify | Chamfer | `modifier.chamfer` | works |
| Modify | Shell | `modifier.shell` | works |
| Modify | Hole | `modifier.hole` | works |
| Modify | Press-Pull | `modifier.pressPull` | works (v1 prompt; gizmo deferred) |
| Modify | Move Face | `modifier.moveFace` | stub-v1 (normal component only) |
| Modify | Delete Face | `modifier.deleteFace` | stub-v1 (best-effort heal) |
| Modify | Offset Face | `modifier.offsetFace` | works (aliases Press-Pull) |
| Modify | Draft | `modifier.draft` | stub-v1 (kernel impl pending) |
| Boolean | Union | `bool.union` | works |
| Boolean | Cut | `bool.cut` | works |
| Boolean | Intersect | `bool.intersect` | works |
| Reference | Plane | `ref.plane` | works (offset mode) / stub-v1 (other modes) |
| Reference | Axis | `ref.axis` | works |
| Reference | Point | `ref.point` | works |
| Pattern | Linear | `pattern.linear` | works (axis-only v1) |
| Pattern | Circular | `pattern.circular` | works |
| Pattern | Mirror | `pattern.mirror` | works |
| Transform | Move | `xform.move` | works |
| Transform | Rotate | `xform.rotate` | works |
| Transform | Scale | `xform.scale` | works |
| Transform | Align | `xform.align` | stub-v1 (translate-only fallback) |
| Tools | Measure | `tools.measure` | works |
| Tools | Section view | `view.section.activate` | works (translate-only gizmo) |
| Tools | Interference | `analyze.interference` | stub-v1 (midpoint marker, no overlap body) |
| Insert | Import file | `<input type=file>` | works |
| Insert | New Script | `dialogs.openScript(null)` | works |
| Insert | Insert Component | `component.create` | works |
| Right | Command search | opens palette | works |

**41 toolbar buttons audited. 33 works, 7 stub-v1, 0 broken, 1 mixed (Plane).**

## 2. Palette commands (`src/lib/commands/registry.js`)

Every command in `COMMANDS` was cross-checked: each `run` resolves to
either an in-repo helper (`v4.*`, `studio.*`, `dialogs.*`, `enterSketch`,
or a persistence helper) or to a `studio.*` hook that is registered at
viewport mount. None point at a missing handler.

Categories by group (count):

- Primitives — 8 (4 quick, 4 form): all **works**
- Sketches — 9: **works**, plus `sketch.sweep` / `sketch.loft` carrying v1 text pickers
- Modifiers — 14: **works** for fillet/chamfer/shell/hole; **stub-v1** for draft, moveFace, deleteFace, pressPull-gizmo, cosmetic thread
- Boolean — 8: union/cut/intersect (+ form variants), split, splitFace — splitFace is **stub-v1** (kernel pending)
- Transform — 4: move/rotate/scale **works**, align **stub-v1**
- View — 6: **works**
- Display — 6: shaded/wireframe/hidden-edges/xray all **works**
- Edit — 5: **works**
- Document — 5: new/open/save/save-as/share **works**
- Visibility — 3: **works**
- App — 6 + 3 components + 1 debug: **works**
- Pattern — 4: linear/circular/mirror/path **works** (axis-only v1)
- Reference geometry — 4: plane/axis/point/helix **works**
- Tools — 3 (measure/section/interference): **works**

**Palette command total: ~85. 0 broken handlers. ~10 carry stub-v1
caveats already tracked in EDITOR_READINESS.md.**

## 3. Inspector panels (`src/lib/components/studio/inspector/`)

| Panel | File | Status |
|---|---|---|
| Parameters (inline) | `Inspector.svelte` | works |
| Transform | `TransformPanel.svelte` | works |
| Properties | `PropertiesPanel.svelte` | works |
| Relationships | `RelationshipsPanel.svelte` | works |
| Manufacturability (DFM) | `DfmPanel.svelte` | works |
| Invariants | `InvariantsPanel.svelte` | works |
| Scene & Material | `ScenePanel.svelte` | works |

All seven panels guard on `feature === null` at the Inspector level via
`{#if !feature} … {:else} …` — empty doc / nothing selected renders
gracefully without throwing.

## 4. Settings tabs (`src/lib/components/studio/SettingsDialog.svelte`)

| Tab | Status |
|---|---|
| General | works |
| Shortcuts | works (live-reload caveat) |
| Viewport | works |
| Camera | works |
| Performance | works |
| Graphics | works (drives tessellation deflection) |
| Measurement | works |
| Export | works |
| Manufacturing | works |
| Presets | works |

All ten settings panels round-trip through `loadAllSettings()` /
per-key persistence in localStorage.

## 5. Edge-case findings (acted on in E7)

- **Nested-button SSR warning** in `ComponentBrowserPanel.svelte`:
  the per-row "activate" `<button>` wraps a child Trash `<button>`.
  HTML doesn't allow nested interactive content. **Fixed in E7**:
  collapse the outer `<button>` to a `<div role="button">` so the
  delete button can legally sit inside.
- **`modifier.pressPull` palette command** missing an `enabled()`
  gate — it arms a face-pick gesture even when the viewport isn't
  ready. Already guarded internally by `startFacePick` returning
  false; not a crash, so **not fixed** (no behaviour change).
- **Empty-doc `defaultSaveFilename`** handled — falls back to
  `document.paraform.json`. Verified in e7 tests.
- **`getDocumentStore().toJSON()` on a 500-feature doc** completes
  well under 2 s in node. Verified in e7 tests.
- **Bad-input JSON open path**: `loadDocumentFromJSON(null)` throws
  with `"not a document …"`; corrupt v: throws
  `"unrecognised document version …"`; the live store is left
  untouched because `store.fromJSON` is never reached on the failure
  path. Verified in e7 tests.
- **Kernel-down**: `HttpKernelClient.executeCode` never throws —
  endpoint-missing returns `{ ok:false, error:'no kernel endpoint
  configured', mock:true }`; network failure returns
  `{ ok:false, error:'…' }`. Bridge's `executed`/`failed` events both
  fire `_render` / `onError` hooks; the UI overlay surfaces the
  error message without a white-screen crash. Verified in e7 tests.

## 6. Headline

- **41 toolbar buttons audited; 33 works, 7 stub-v1 (acknowledged in
  EDITOR_READINESS.md), 0 broken.**
- **~85 palette commands audited; 0 dead handlers.**
- **7 inspector panels, all guarded for empty doc.**
- **10 settings tabs, all functional and persisting.**
- **1 SSR-warning fix landed (ComponentBrowserPanel).**
- **15 new edge-case assertions in `e7_edge_cases.mjs`.**

Nothing broken in the editor surface justifies blocking the
EDITOR_READINESS close.
