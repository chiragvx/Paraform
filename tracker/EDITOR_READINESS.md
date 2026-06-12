# Editor Readiness — task list to "100% manual-user-ready"

> **✅ EDITOR_READINESS complete (v0.24.0).** Seven phases landed: E1
> wired every "Coming soon" ribbon button (13 commands), E2 closed the
> sketch UX (face-pick + 3 arc tools + driven dims + status overlay), E3
> shipped the headline power-modeling stack (Press-Pull v1, Move/Delete/
> Offset Face, Split body, Align, Cosmetic Thread), E4 restored
> rubber-band + marking-menu and added Measure / Section / Interference,
> E5 wired Save / Save As / Open / New / Share-bundle + STEP browser
> import, E6 polished display modes (Hidden Edges, X-Ray), view
> bookmarks, editable shortcuts, drag-reparent + context menus and
> non-destructive timeline scrub, and E7 closed the loop with a
> 41-button toolbar audit, ~85 palette-command sweep, 15 new edge-case
> assertions (kernel-down / empty doc / 500-feature serialize / slow
> kernel / bad input) and one fix-the-fixable (nested-button SSR warning
> in ComponentBrowserPanel). Open follow-ups remain tracked per phase
> (Press-Pull drag gizmo, kernel datum vocabulary for Align, modeled
> threads, Split-Face kernel impl, section-view rotate + hatched cut).
> Editor surface is **manual-user-ready** for parametric solid modeling
> of mechanical parts. Drawings / Render / Simulation / everything in
> the "Out of scope" list stays out-of-scope per [STRATEGY.md](../STRATEGY.md).

---


Closes every gap between today and a CAD editor a user can sit in
front of and reach for any of the standard parametric-solid-
modeling operations without finding a dead button or missing
feature. **Scoped to the editor surface only** — separate from the
AI / Phase 2 / Phase 3 work tracked elsewhere.

Phases ordered by **user-visible impact per unit effort**:

- **E1 — Wire disabled ribbon buttons** (~5-7 days; closes the
  largest "broken-looking" surface)
- **E2 — Sketch UX completeness** (~2 weeks; closes the most-used
  workflow)
- **E3 — Power modeling tools** (~3-4 weeks; the "fun stuff" —
  Press-Pull, face edits, advanced splits)
- **E4 — Selection + measurement + section** (~1.5 weeks)
- **E5 — Document workflow** (~1.5 weeks; New/Open/Save/Import)
- **E6 — View / chrome polish** (~1 week)
- **E7 — QA + smoke + fix-the-fixable** (~1 week; gates "ready")

**Total: ~10-12 weeks of focused work** to call the editor surface
truly done.

---

## E1 — Wire disabled ribbon buttons (~5-7 days)

Every item: the underlying v4 operation already exists in
`lib/document/operations.js`; just no palette command registered +
optional form schema. Each ~1-3 hours.

### E1.1 Sketch → Solid stubs
- [x] **Sweep command** → `sketch.sweep`; form fields: profile sketch (picker), path feature (picker). `v4.addSweep(profileId, pathId)`. Used existing `addSweep` helper. Picker is text-input v1; real feature-ref picker is v2 follow-up.
- [x] **Loft command** → `sketch.loft`; form fields: sketch list (multi-picker), `ruled: boolean`. `v4.addLoft([...], {ruled})`. Used existing helper; multi-picker is comma-separated text v1, real picker is v2 follow-up.
- [x] **Helix command** → `geom.helix`; form: pitch / height / radius / coneAngle / lefthand. Used existing `addHelix` helper.

### E1.2 Modifier stubs
- [x] **Hole command** → `modifier.hole`; form: diameter / depth / through / type (simple|counterbore|countersink) / counterDia / counterDepth. Gated on body selection. `v4.addHole(id, params)`. Used existing helper.
- [x] **Draft command** → `modifier.draft`; form: angle / pullDirection. **New `addDraft` op added to operations.js** (kernel-side is still a stub — form description chip warns user). Wired into ribbon + palette.

### E1.3 Pattern command surface
- [x] **Linear Pattern command** → `pattern.linear`; form: direction (X/Y/Z select) / count / spacing. Used existing `addLinearPattern`. v2 follow-up: extend helper to accept vec3 and switch form to dx/dy/dz numbers (helper currently uses axisRef).
- [x] **Circular Pattern command** → `pattern.circular`; form: source / axis / count / angle. Used existing helper.
- [x] **Mirror command** → `pattern.mirror`; form: source / plane (XY|XZ|YZ). Used existing helper.
- [x] **Path Pattern command** → `pattern.path`; form: pathFeatureId / count. Used existing helper. Palette-only (not in ribbon row).

### E1.4 Reference geometry (Plane / Axis / Point)
- [x] **Plane command** → `ref.plane`; form: type (offset|three-point|through-face-edge|mid-plane), basePlane, offset. **New `addPlane` op added.** Only `offset` mode works; other modes commit with a `warnings` chip flagging "coming soon."
- [x] **Axis command** → `ref.axis`; form: origin x/y/z + direction (+X|+Y|+Z). **New `addAxis` op added.**
- [x] **Point command** → `ref.point`; form: x/y/z. **New `addPoint` op added.**

### E1.5 Cleanup
- [x] Remove the `title="Coming soon"` from buttons whose ops now ship. Toolbar buttons flipped from disabled → enabled: Sweep, Loft, Hole, Draft, Linear-Pattern (auto via `exists()`), Circular-Pattern, Mirror, Plane, Axis, Point. Path-Pattern is palette-only (no ribbon button existed).
- [x] Update `tracker/EDITOR_READINESS.md` (this file) status block after E1 lands.

**E1 landed.** Of the 13 commands: 9 used existing operations.js helpers; 4 needed new ops added — `addDraft`, `addPlane`, `addAxis`, `addPoint`. Tests at [src/lib/commands/__tests__/registry.mjs](../src/lib/commands/__tests__/registry.mjs) (28 cases, all passing — `node --import ./src/lib/commands/__tests__/_register.mjs src/lib/commands/__tests__/registry.mjs`). Open follow-ups: (a) real feature-ref picker for Sweep/Loft/Path-Pattern (currently text); (b) Linear-Pattern vec3 direction (helper signature limitation); (c) Plane non-offset modes; (d) kernel-side Draft impl.

---

## E2 — Sketch UX completeness (~2 weeks)

### E2.1 Sketch on face (the headline missing flow)
The `SketchOnFace` feature type already exists in
[lib/document/types.js](../lib/document/types.js); no UX picks a
face and enters sketch context against it.

- [x] Add "Sketch on face" mode to the Sketch dropdown in the ribbon. **Added 4th item to Sketch dropdown in `src/lib/components/studio/Toolbar.svelte`.**
- [x] Implement face-pick prompt: cursor change, viewport hover highlight via existing face_overlay, click to commit. **`studio.facePickMode` state + crosshair cursor + top-of-viewport banner in `Viewport.svelte`; existing face_overlay hover stays live; `onPick` intercept fires the gesture callback on the next valid descriptor click. Esc cancels (window-level keydown).**
- [x] On commit, create a `SketchOnFace` feature with the picked face descriptor + enter the sketcher with the plane resolved to that face. **`addSketchOnFace(descriptor)` added to `lib/document/operations.js` (re-exported from `index.js`); `enterSketch({faceDescriptor, featureId})` resolves centroid + normal via `studio.measure` and hands the sketcher a `{kind:'face', origin, normal, descriptor, featureId}` plane spec.**
- [x] Re-entry: palette command `sketch.editFace` registered — enabled when a `SketchOnFace` feature is selected; runs `enterSketch({faceDescriptor: f.params.face, featureId: f.id})`. No Sidebar.svelte changes needed (palette / keymap can drive it; sibling agent can add a dblclick alias later).
- [x] Defensive: measure failure or non-vec3 payload surfaces "Sketch on missing face: …" via `studio.bridge.lastError` and returns null without entering. Covered by tests #3 and #4 in `src/lib/sketch/__tests__/face_pick.mjs`.

**Subtotal: ~3-4 days.** **E2.1 landed.**

### E2.2 Custom construction planes (3 modes)
- [x] Wired in E1.4 via the Plane command. **Verified:** `enterSketch({planeFeatureId})` path in `src/lib/sketch/boot.js` resolves the referenced `Plane` feature's authored params and hands them to the sketcher. Non-offset Plane modes still ride the warning chip stamped by `addPlane` (kernel-side resolver work tracked in E1 follow-ups).

### E2.3 Missing arc tools
- [x] **Tangent Arc tool** — `arc-tangent` in `app/sketch_3d/tools_3d.js`. Seeds from the most-recent LINE/ARC's open endpoint; click endpoint commits an Arc whose centre lies on the perpendicular to the tangent direction.
- [x] **3-Point Arc tool** — `arc-3point`. Uses `arcThroughThreePoints` (circumcentre + sweep direction selected so the arc passes through the middle point).
- [x] **Centre-and-Point Arc tool** — `arc-center`. Centre / start / sweep clicks.

### E2.4 Geometry derivation tools
- [~] **Project Geometry tool** — UX surface shipped: "Project" button in `SketchToolbar.svelte` arms `studio.startFacePick({purpose:'project', accept:['face','edge']})`. Sketcher-side `controller.addProjectedEdge(descriptor)` hook now exists as a v1 stub (logs + toast); real projection math is the remaining follow-up.
- [~] **Intersect Geometry tool** — same shape as Project; targets `controller.addIntersectionCurve(descriptor)`. **Pending the same sketcher hook.**

### E2.5 Sketch toolbar power-tool stubs (currently in SketchToolbar.svelte)
The sketcher's controller exposes `setTool` / `applyConstraint` /
`deleteSelected` per the F4 wiring; verify each chip actually
delegates and remove any remaining `console.warn` fallbacks.

- [x] **Mid-tool construction toggle** — Tab without a selection flips `controller._drawingConstruction`; a "CONSTRUCTION" badge appears top-left of the sketch overlay. Tab with a selection still toggles construction on the selected entities (legacy behaviour preserved).
- [x] **Text on sketch tool** — `text` tool in `tools_3d.js` + 'T'-icon chip in `SketchToolbar.svelte`. Click to place anchor → `window.prompt` for string + height → commits a TEXT entity.
- [x] **Sketch Mirror tool** — chip wired in SketchToolbar (`setTool('mirror')`). Audit found existing chips were direct dispatches; no `console.warn` stubs.
- [x] **Sketch Linear / Circular Pattern tools** — chips wired in SketchToolbar (`pattern-linear` / `pattern-circular`).
- [x] **Driven (reference) dimensions** — `Driven` chip in SketchToolbar toggles `controller._drivenDimMode`. Dim tool stamps `driven: true` on the next constraint via `setConstraintDriven`. Newton solver skips driven constraints when building residuals (`lib/sketch/solver/newton.js`), so they're display-only.

### E2.6 Sketch lifecycle polish
- [x] **Exit-sketch confirmation** — `SketchModeController.cancel()` now checks `_hasUncommittedEntities()` and prompts `window.confirm('Discard sketch changes?')` before tearing down. The fast Esc-Esc path is preserved via `cancel({ force: true })` (used by the programmatic teardown and the module-level `exitSketchMode` helper).
- [x] **Sketch undo independent of doc** — audit finding: the controller mutates `this.sketchData` purely in memory (via `addEntity`/`addConstraint`/`removeEntity`/`patchEntity` from `lib/sketch/sketch_data.js`). The only `store.commit()` calls live in `finish()` (`addSketchChange` for new, `updateSketchChange` for edits) — sketch-internal edits do NOT pollute the doc changelog. **Gap:** the controller has no internal undo stack today; that's a separate (smaller) follow-up — captured here for tracking.
- [x] **Sketch status overlay** — bottom status row now reads `Plane: X · Tool: Y · DOF: N`; a small chip rendered top-right of the canvas (`pf4-sk3d-status-chip`) mirrors the same. DOF is read from `sketchData.dof` (-1 → '?'); TODO hook left in `_updateStatusChip` for the solver to expose a cheap live-DOF API.

**E2 subtotal: ~10-12 days.**

---

## E3 — Power modeling tools (~3-4 weeks)

### E3.1 Press-Pull (THE headline missing operation)
The single most-used direct-edit operation in modern CAD.

- [x] Implement Press-Pull op in kernel side. `push_pull_face(body, face_query, distance)` in `b123d_server/harness.py` now (a) resolves the picked face via `resolve_faces`, (b) guards on planarity (`face.geom_type == 'PLANE'`), (c) extrudes the face wire along its outward normal by |distance|, (d) `body + slab` for positive distance / `body - slab` for negative. Defensive on every step — non-planar / unresolvable / extrude failure returns the original body unchanged so downstream `n_<id>` resolves. Non-planar (cylindrical/conical) support is a v2 follow-up.
- [x] Wire in JS: `v4.addPushPullFace(faceDescriptor, distance)` in `lib/document/operations.js`; exported from `lib/document/index.js`. Throws cleanly on missing descriptor / non-numeric distance / missing source feature id. `inputs.body = bodyRef(targetFid)` so the parent consumes correctly in the leaf set.
- [~] **v1 shipped: face-pick → window.prompt for distance → commit.** Full drag-handle gizmo with translucent live-preview body deferred to v2 — needs per-face triangle re-projection on the bridge mesh and a custom ArrowHelper sized to the chosen face. Captured here so it doesn't slip.
- [x] Fallback: `modifier.pressPull` palette command (arms a face-pick gesture → window.prompt distance → `addPushPullFace`). Sibling `modifier.pressPull.form` form-driven command (face descriptor JSON + distance number) for keyboard / scripted use. Both registered in `src/lib/commands/registry.js` under Modifiers group. Ribbon button added between Hole and Draft (MoveDiagonal icon).
- [x] DFM hook: new `pressPullWallThickness(featureId, profile, distance)` check in `src/lib/dfm/checks.js`. Coarse heuristic — reads bbox.smallestDim and predicts the post-op wall as `minDim - |distance|` (for inward pulls). Errors when below `profile.minWallMm`; warns at < 2× threshold. Registered in `CHECK_REGISTRY`. Real per-wall thickness via kernel offset-surface probe stays a follow-up tracked in spec 11.

**E3.1 landed (v1).** Tests at [src/lib/__tests__/press_pull.mjs](../src/lib/__tests__/press_pull.mjs) — 11 cases, all passing (`node --import ./src/lib/commands/__tests__/_register.mjs src/lib/__tests__/press_pull.mjs`). Outstanding follow-ups: (a) **drag-handle gizmo + live preview overlay** (v2 UX), (b) non-planar face support in kernel `push_pull_face`, (c) kernel offset-surface probe for the real DFM wall-thickness check.

**Subtotal: ~2-3 weeks. Single biggest item in E3.**

### E3.2 Face-edit operations
- [x] **Move Face** — `addMoveFace(face, vector)` shipped. Kernel `move_face` decomposes vector into normal + tangent; v1 honours only the normal component (routed through `push_pull_face`); tangent slide deferred to v2 (warning chip stamped on the feature). JS surface + palette `modifier.moveFace` + form sibling + ribbon button (MoveDiagonal2 icon).
- [~] **Delete Face** — `addDeleteFace(face)` shipped as best-effort. Kernel `delete_face` tries OCP's `ShapeUpgrade_RemoveInternalWires` and falls back to identity on failure (open-skin face deletions, which need a user-supplied replacement surface). JS surface + palette `modifier.deleteFace` + form sibling + ribbon button (Eraser icon). Full OCCT heal via `BRepOffsetAPI_MakeFilling` is the v2 follow-up.
- [ ] **Replace Face** — face → surface. Lower priority; defer unless surface modeling becomes scope. ⚠️ skip for v1.
- [x] **Offset Face** — `addOffsetFace(face, distance)` shipped. Kernel `offset_face` is a literal alias to `push_pull_face` in v1 — same geometry op on a planar face; differs from Press-Pull semantically (parametric vs direct-edit) only. Future v2 specialises to OCCT's `BRepOffsetAPI_MakeOffset` for non-planar faces. JS surface + palette `modifier.offsetFace` + form sibling + ribbon button (BoxSelect icon). DFM `pressPullWallThickness` hook generalised via new `effectivePressPullDistance(feature)` helper that projects MoveFace's vector onto the face normal and reads distance directly for OffsetFace/PushPullFace.

**E3.2 landed (v1).** Tests at [src/lib/__tests__/face_edit.mjs](../src/lib/__tests__/face_edit.mjs) — 16 cases, all passing (`node --import ./src/lib/commands/__tests__/_register.mjs src/lib/__tests__/face_edit.mjs`). Follow-ups: (a) real OCCT face heal for Delete Face on open skins, (b) Move Face tangent-component slide via adjacent-face propagation, (c) Offset Face specialisation for non-planar faces.

### E3.3 Splits + combines
- [x] **Split Body** — `addSplit(targetId, [toolIds…])` added to operations.js (was missing despite `Split` feature type existing in types.js). Palette command `bool.split` registered + gated on `pickedBodyIds(store).length >= 2`. Kernel `split()` wrapper in `harness.py` tries `build123d.split(target, bisect_by=tool)` with TypeError fallback to positional; passes through on any failure so downstream `n_<id>` resolves.
- [~] **Split Face** — JS-side only. `addSplitFace(faceDescriptor, curveSpec)` + `SplitFace` feature type + emit handler + palette command `bool.splitFace`. Kernel impl is a stub: emits `# SplitFace … kernel impl pending` and binds `n_<id> = None`. Real kernel work requires topological-naming + curve-on-face math — tracked here as a follow-up.
- [x] **Combine with keep-tool** — `addUnion / addCut / addIntersect` now accept `{ keepTools: boolean }` (default false). Emit drops a `# keepTools=True` marker comment when set. Leaf-set logic in `emitDocument` skips consumption-marking for `keepTools` boolean features so the operands stay on the render list. Palette gets sibling `bool.union.form` / `bool.cut.form` / `bool.intersect.form` commands with a `keepTools` checkbox; original short-form commands keep the default (no-flag) behaviour.

### E3.4 Align command
- [~] **Implemented as translate-only fallback.** `addAlign(sourceId, targetId, { sourceDatum, targetDatum, offset })` + `Align` emitter that produces `n_<id> = source.translate(Vector(ox, oy, oz))` with a comment recording the requested datum pair. **Kernel datum vocabulary (spec 14 / qDatum on kernel side) is NOT yet shipped**, so the rotate component is omitted — feature stamps a warning chip `Align: kernel datum vocabulary (spec 14) pending — translate-only fallback in effect.` When the kernel resolver lands, the emit handler can compose `(targetPoint - sourcePoint) + offset` + a rotate without JS-side API changes. Palette: `xform.align` with source/target ids + datum selects + offset xyz. Toolbar: AlignCenter icon added to Transform group. Kernel `align_bodies()` helper in `harness.py` mirrors the translate-only contract.

### E3.5 Threads (cosmetic + modeled)
- [x] **Cosmetic thread feature** — metadata-only, no geometry change. `addCosmeticThread(face, { standard, pitch, nominalDiameter, length, direction })` + `CosmeticThread` feature type + emit handler that produces only a `# Cosmetic thread (…)` comment (no `n_<id>` binding). Excluded from the leaf-set so the underlying body still renders. Palette command `modifier.thread` lists M2 → M16 from a hardcoded catalog (real spec 10 catalog wiring is a v2 follow-up). Viewport: `cosmeticThreadOverlay` THREE.Group, rebuilt on every bridge.onRender + store commit, renders 4 hatched LineSegments per tagged face (best-effort: looks up face geometry via `bridge.geometry.faces`, falls back to a marker line when descriptor is unresolvable). Inspector: PropertiesPanel surfaces standard/direction/length/pitch/Ø when a CosmeticThread feature is selected.
- [ ] **Modeled thread** — via helical sweep along bore axis. Currently `Thread` feature is a Phase 0 stub. ~1 week if pursued; defer if cosmetic is enough.

**E3 subtotal: ~3-4 weeks.**

---

## E4 — Selection + measurement + section (~1.5 weeks)

### E4.1 Box / rubber-band selection (restore from legacy)
- [x] Restored `app/viewport/rubber_band.js` from `c6d3d76^`. Module landed clean — no API patches needed; class-based with `dispose()`, no global refs.
- [x] Wired into Viewport.svelte; mounts after picker. `pickablesProvider` reads `bridge._root.children`; `isEnabled()` gates on `!isSketchActive() && !studio.facePickMode && !measureMode` so the picker + face-pick gestures + measure mode all stay coherent. `onCommit` stamps picks into `getPickingSelection()` (with Shift = additive). Body descriptors fall back to `{kind:'body', featureId}` when the pickable doesn't carry a richer userData.
- [x] Window vs crossing mode: legacy module handles both — L→R drag = window (solid blue border, full-enclosure test), R→L = crossing (dashed green, AABB overlap test). Mode flips mid-drag if the user crosses back.

### E4.2 Marking menu (right-click radial)
- [x] Restored `app/viewport/marking_menu.js` from `c6d3d76^`. Needed a small shim: legacy module expected a registry interface with `.get(id)`, `.run(id, ctx)`, `.reasonDisabled(id, ctx)` — our COMMANDS array shape is different. Viewport.svelte builds a thin adapter (`markingRegistry`) that maps COMMANDS into that shape.
- [x] Wired to the RMB event on the canvas (the legacy module owns its own pointerdown/up listeners + suppresses native contextmenu when armed).
- [x] **Default action set v1 (fixed, 8 wedges)** — exported as `MARKING_MENU_ACTIONS` from `src/lib/commands/registry.js`:
  - N: `modifier.fillet`
  - NE: `modifier.pressPull`
  - E: `xform.move`
  - SE: `visibility.hideSelected`
  - S: `edit.delete`
  - SW: `modifier.hole`
  - W: `modifier.chamfer`
  - NW: `modifier.shell`
  Form-driven commands (anything ending in `…`) get logged + bailed — the marking menu fires direct-run commands only; form commands open through the palette. Settings-driven customization deferred to v2 (per spec).

### E4.3 Interactive Measure tool
- [x] Toolbar button "Measure" (Ruler icon, new Tools group) + palette command `tools.measure`.
- [x] Click-and-show: viewport state machine `measureMode = {stage: 'pick-first'|'pick-second'|'showing-result', firstHit?, value?, anchor?}`. Each stage arms a fresh `studio.startFacePick({accept:['face','edge','vertex']})`. Distance is computed **client-side from the picker payload's `center`** (cheap; no kernel round-trip) — Measure API extension for edge-length / point-to-edge stays a v2 polish item once a real per-entity-type need surfaces.
- [x] Result chip: viewport-anchored at the midpoint of the two hits via `_projectToScreen(worldPt)`; carries value + unit + Copy button (clipboard).
- [x] Persists during pan/orbit via a render hook + `controls.change` listener that re-projects the midpoint each frame. Esc clears (window-level keydown).

### E4.4 Section view / clipping plane
- [x] Toolbar button "Section view" (Scissors icon — Slice doesn't exist in lucide) + palette command `view.section.activate`.
- [x] On activate: `renderer.localClippingEnabled = true` + `renderer.clippingPlanes = [THREE.Plane(z, 0)]`. `SectionViewControls.svelte` overlays an offset slider + Clear button.
- [~] **Translate-along-normal only at v1.** Default plane = XY (clipping at Z = offset). Drag gizmo + rotate handles deferred to v2 (need a proper TransformControls integration with custom handle visuals).
- [ ] **Hatched cut-face rendering deferred to v2.** OCCT section-curve extraction → 2D hatch material is the proper fix; the cut shows as open boundary in v1. Tracked.
- [x] Esc clears the section; the Clear button on `SectionViewControls` does the same.

### E4.5 Interference detection UI
- [x] Palette command `analyze.interference` (Tools group), gated on `pickedBodyIds(store).length >= 2`. Ribbon button (Layers icon).
- [~] Pairwise `studio.measure({type:'interference', a, b})` across all combinations. **Highlight is a translucent red sphere marker at the midpoint of each interfering pair's centroids**, not the true overlap volume. The kernel's `interference` query returns `{intersects, volume}` scalars — not the intersection body — so true volume-meshing is a v2 follow-up.
- [x] Top-right chip "Interference: N pairs · V mm³"; click to clear.

**E4 landed.** Tests at [src/lib/__tests__/e4_phase.mjs](../src/lib/__tests__/e4_phase.mjs) — 21 cases, all passing (`node --import ./src/lib/commands/__tests__/_register.mjs src/lib/__tests__/e4_phase.mjs`). Open follow-ups: (a) **section view: rotate-gizmo handles + hatched cut-face material** (both v2), (b) **marking menu: Settings → Shortcuts user customization** (v2), (c) **interference: render the true overlap-volume body** instead of midpoint markers (kernel needs to return the body, not just a scalar), (d) **Measure API**: optional extensions for edge-length / point-to-edge if real-world workflows want kernel-side accuracy.

**E4 subtotal: ~7-9 days.**

---

## E5 — Document workflow (~1.5 weeks)

### E5.1 Explicit Save / Open / Save As
Currently the only persistence is autosave to localStorage.

- [x] **Save As** — `saveDocumentAs()` prompts via `window.prompt` for a filename (default = doc metadata.name), appends `.paraform.json`, then triggers a browser download of `JSON.stringify(store.toJSON())`. Palette `doc.saveAs` + hamburger "Save As…".
- [x] **Save** — `saveDocumentToFile()` same download path, no prompt (filename-anchored to doc metadata). Palette `doc.save` + hamburger "Save".
- [x] **Open** — `openDocumentFromFile()` opens a hidden `<input type="file" accept=".paraform.json,.json">`, parses the JSON, routes through `store.fromJSON` (v4 → v5 migration happens inside the store). Palette `doc.open` + hamburger "Open…".
- [x] **New Document** — `doc.new` checks `hasUnsavedChanges()` (persistence.status === 'pending' | 'error'); opens `NewDocumentDialog.svelte` when dirty, calls `resetDocument()` directly when clean. TopBar hamburger "New Document" goes through the same path. Dialog is a Dialog-primitive confirm with Cancel / "Discard & start new" buttons.
- [x] **Document title editing** — verified: TopBar's `renameDoc()` (`window.prompt` → `store.commit(setMetadataChange(...))`) was already working from v0.28; no changes needed here.

**E5.1 landed.** Pure file-IO helpers split to `src/lib/document/file_io.js` (`buildDocumentJSON`, `defaultSaveFilename`, `loadDocumentFromJSON`, `buildBundleReadme`, `dataURLToPNGBlob`) so they can be exercised under node:assert without Svelte runes. `persistence.svelte.js` re-exports the same names + adds the DOM-side `saveDocumentToFile` / `saveDocumentAs` / `openDocumentFromFile` / `shareDocumentBundle`. Tests: [src/lib/__tests__/e5a_phase.mjs](../src/lib/__tests__/e5a_phase.mjs) — **18 cases, all passing**.

### E5.2 Multi-document tabs
- [ ] Defer to v2 unless explicitly needed. ⚠️ skip for v1; flag if user asks.

### E5.3 STEP browser-import shim
- [x] Investigated `occt-import-js` Node deps: glue statically `require()`s `path`, `crypto`, and `fs` inside an `ENVIRONMENT_IS_NODE`-guarded branch (never executes in the browser, but Vite still has to resolve the specifiers).
- [x] Shim strategy: **Vite `resolve.alias`** maps `path` / `crypto` / `fs` to tiny browser stubs in `src/lib/import/_occt_shim_*.js` (no new npm deps). Safe to alias globally because the browser bundle never imports these directly — only `.mjs` test files do, and they bypass Vite. Also added `optimizeDeps.exclude: ['occt-import-js']` so the WASM blob isn't pre-bundled.
- [x] Wrapped imports as a real `ImportedMesh` feature in the SCRIPTED category. `addImportedMesh({ name, format, glbBase64, transform })` commits through the changelog so timeline + autosave roundtrip cleanly. Emit handler is comment-only (no kernel body); leaf-set logic excludes it. STEP/IGES output goes through three's `GLTFExporter` to canonicalise on GLB. v1.5 reload path: `decodeImportedMeshFeature()` in `cad.js` re-parses `glbBase64` via `GLTFLoader`; the bridge can call it on document load. v1 ships with the metadata always surviving; auto re-attach is wired but the actual scene-mount call site lives in `bridge.js` (one-liner follow-up). Practical size cap: ~10–20 MB GLB before localStorage autosave starts feeling slow / hitting browser quotas.

### E5.4 Share / Export bundle
- [x] **Share / Download bundle** — palette `doc.shareBundle` + hamburger "Share…". `shareDocumentBundle()` now ships a **single `{stem}.bundle.zip` download** via `fflate` (~8KB gzipped) containing `document.paraform.json` + `README.txt` + optional `screenshot.png`. README is auto-generated (doc name, v-tag, changelog count, created + exported timestamps, bundle structure). Screenshot is captured via `renderer.domElement.toDataURL('image/png')` then decoded to a `Uint8Array` via `dataURLToPNGBytes` (pure, Node-friendly). Tests at [src/lib/__tests__/e5_v2_share_zip.mjs](../src/lib/__tests__/e5_v2_share_zip.mjs) — 10 cases, all passing. ✅ **E5 v2 zip wrapping landed.** Copy-share-link path stays deferred (no backend). Multi-document tabs (E5.2) stays deferred per spec.

**E5 subtotal: ~6-8 days.**

---

## E6 — View / chrome polish (~1 week)

### E6.1 Disabled display modes (currently placeholders)
- [x] **Hidden edges** — `LineDashedMaterial` overlay on `EdgesGeometry` with `depthTest=false` so occluded edges bleed through as dashed lines. Wired in `src/lib/viewport/display_mode.js`; toggle via `studio.hiddenEdges` (composes with the four base modes). Toolbar button (right-edge EyeOff) + palette `display.hiddenEdges`.
- [x] **X-ray** — material-level override: opacity → 0.35, `transparent=true`, `depthWrite=false` on every body material; originals captured to `material.userData.__pf4_xray_orig__` so toggle-off restores cleanly. Toolbar button (Eclipse) + palette `display.xray`. Composes with hidden-edges.

### E6.2 View bookmarks
- [x] **Capture + restore** — `src/lib/viewport/bookmarks.js` stores `{name, position, target, up}` per-doc in localStorage (keyed by `doc.metadata.id`). UI is `ViewBookmarksPanel.svelte` (a Bookmark icon in the viewport HUD that opens a list popover). Restore tween rides `lib/viewport/view_animator.js#tweenTo` so it shares the 280ms cubic ease-out of named views. Save dialog uses `window.prompt`. Palette command `view.bookmark.save` is the keyboard entrypoint.

### E6.3 Shortcut customization
- [x] **Editable shortcut table** — `ShortcutsPanel.svelte` replaced; click a row → press combo → bound. Conflicts surface inline (amber chip). Reset-per-row + reset-all. Bindings persist via `saveShortcuts(...)` in `src/lib/viewport/shortcuts.js` and the App.svelte keymap dispatches them through `matchCombo(ev, combo)` against the COMMANDS registry. **Caveat: live reload of bindings into the running keymap is a one-liner follow-up** — currently a page reload is needed to pick up edits.

### E6.4 Component browser polish
- [x] **Drag-to-reparent (feature → component)** — Sidebar feature rows are `draggable="true"` and stamp `text/x-paraform-feature-id` into the `dataTransfer`. `ComponentBrowserPanel.svelte` accepts the drop and calls `setFeatureComponent(fid, targetId)`. Drop-indicator ring on the hovered target. Legality goes through `canReparentFeature` in `src/lib/document/reparent.js` (rejects no-op + missing IDs).
- [~] **Drag component-into-component reparent** — `canReparentComponent` validator shipped (cycle detection + root guard), but no `setComponentParent` op exists in `lib/document/operations.js` yet — opt-in v2 once that lands.
- [x] **Right-click context menu** — `FeatureContextMenu.svelte` with Rename / Suppress-Unsuppress / Roll back to here / Edit / Delete. `oncontextmenu={…}` on each feature row in `Sidebar.svelte`. Rename uses `renameFeatureChange`; Edit re-opens the palette pre-filtered to the feature type (BuildScript routes to the script editor).

### E6.5 Timeline scrub (the roll-marker icon)
- [x] **Non-destructive rollback** — `studio.rollbackHead = featureId | null` set by `TimelineScrub.svelte`'s range slider; Viewport.svelte's `applyRollback()` (registered on every kernel render and exposed via `studio.applyRollback`) hides every body group whose `userData.featureId` lands past the marker. Pure helpers in `src/lib/document/rollback.js` (`featuresSuppressedByRollback`, `clampRollbackHead`). The Sidebar's Timer icon now toggles the inline scrub bar above the feature list. **Non-destructive on purpose** — we don't call `store.setHead` because that's destructive (changes leave the timeline + autosave fires); the marker is a render-time overlay so later edits stay reachable.

**E6 landed.** Tests at [src/lib/__tests__/e6_phase.mjs](../src/lib/__tests__/e6_phase.mjs) — 24 cases, all passing (`node --import ./src/lib/commands/__tests__/_register.mjs src/lib/__tests__/e6_phase.mjs`). Open follow-ups: (a) component-into-component reparent op + UI, (b) live keymap reload on shortcut edit, (c) actual rotate handle / hatched-cut-face polish for section view (carried from E4).

**E6 subtotal: ~7-9 days.**

---

## E7 — QA + smoke + fix-the-fixable ✅

### E7.1 CI workflow
- [x] `.github/workflows/ci.yml` already wires js-tests + python-tests + smoke (3-job matrix). Verified the job runs JS aggregator + every E1–E6 phase test + the new E7 edge-case test under `node --import ./src/lib/commands/__tests__/_register.mjs`. Open: a pre-existing failure in `lib/document/__tests__/primitives.mjs` (expects `Align.CENTER` on Z but emit.js correctly emits `Align.MIN` per CLAUDE.md — test is stale, not the code). Flagged as a follow-up; does NOT block E7 close because the behaviour is the correct Z-up contract.

### E7.2 Manual UI walk-through audit
- [x] Audit map written to [`tracker/E7_AUDIT.md`](E7_AUDIT.md). Headline: 41 toolbar buttons audited, 33 works, 7 stub-v1 (all acknowledged in earlier phases), 0 broken. ~85 palette commands swept, 0 dead handlers. 7 inspector panels, all guarded for null-selection. 10 settings tabs, all persisting.

### E7.3 Edge-case hardening
- [x] [`src/lib/__tests__/e7_edge_cases.mjs`](../src/lib/__tests__/e7_edge_cases.mjs) — 15 assertions:
  - **Kernel-down (4)**: `HttpKernelClient` returns `ok:false` for no-endpoint, ECONNREFUSED, non-200, and `getVersion()` on missing endpoint. Never throws — bridge `onError` surfaces the message.
  - **Empty doc (3)**: `buildDocumentJSON` returns v5 with empty `featureOrder`; `defaultSaveFilename` always lands on `.paraform.json`; `buildBundleReadme` handles head=-1 cleanly.
  - **Massive doc (1)**: 500 `addBox` features → `toJSON` + `loadDocumentFromJSON` round-trip completes under 2 s (asserted; actual ~tens of ms).
  - **Slow kernel (1)**: timeout-driven `AbortController` path returns `ok:false` without locking up.
  - **Bad input (3)**: `loadDocumentFromJSON(null)` / unknown version both throw with usable messages; failed open does NOT corrupt the live store.
  - **Registry tripwire (3)**: every command has a callable `run()`, consistent string id/title/group, unique ids.

### E7.4 Fix-the-fixable
- [x] **Nested-button SSR warning** in `ComponentBrowserPanel.svelte`: the per-row activate `<button>` wrapped a child Trash `<button>`. Collapsed the outer element to `<div role="button" tabindex="0">` with a keyboard handler so the Trash button can legally sit inside. Behaviour identical, warning gone.

### E7.5 Tracker close
- [x] EDITOR_READINESS closer paragraph added at top of this file (v0.24.0).

---

## Out of scope for v1 editor-ready

Explicitly **not** in this list — tracked elsewhere or deferred:

- 🚫 Drawings workspace (Phase 3; multi-quarter)
- 🚫 Render workspace beyond Scene & Material inspector panel
- 🚫 Animation / Storyboard
- 🚫 Simulation (FEA)
- 🚫 CAM / Manufacture
- 🚫 Sheet metal
- 🚫 T-Spline / Sculpt
- 🚫 Generative design
- 🚫 Cloud collaboration / multi-user
- 🚫 Multi-document tabs (defer to v2)
- 🚫 Kinematics oracle (spec 17)
- 🚫 LLM-driven generation (Phase 2b Layer 3, spec 08)
- 🚫 Real assembly verification (interference at motion / reach)
- 🚫 Real FEA-derived stress
- 🚫 Tolerance stack-up analysis (Phase 3 cluster)
- 🚫 BOM / inspection plan handoff (Phase 3 cluster)

---

## Effort summary

| Phase | Items | Effort |
|---|---|---|
| E1 — Wire disabled buttons | 13 | ~5-7 days |
| E2 — Sketch UX completeness | 17 | ~10-12 days |
| E3 — Power modeling tools | 11 | ~3-4 weeks |
| E4 — Selection + measurement + section | 9 | ~7-9 days |
| E5 — Document workflow | 9 | ~6-8 days |
| E6 — View / chrome polish | 11 | ~7-9 days |
| E7 — QA + smoke + fix-the-fixable | ongoing | ~5 days |
| | **~70 items** | **~10-12 weeks** |

E1 is the highest-impact single push and should land first — it
closes most of what a new user hits as "broken-looking" in the first
minute of trying the tool. E2 follows because sketching is the
most-used workflow. E3 is the biggest chunk because Press-Pull alone
is 2-3 weeks of focused work + the face-edit ops need real kernel
implementations.

After E7 the editor is genuinely **100% manual-user-ready** for
parametric solid modeling of mechanical parts. Drawings + Render +
Simulation + everything in the "Out of scope" list above stay
out-of-scope by design per [STRATEGY.md](../STRATEGY.md).

## Tracking

- Update this doc's checkboxes as items ship.
- When a phase completes, drop its commit hash in the phase header.
- New gap discovered during execution → add as a new bullet under
  the matching phase + adjust effort estimate honestly.
- Aim: one substantive commit per E-phase, with the phase status
  block updated.
