# Project notes for Claude

## Coordinate system: Z-up

This project is **Z-up**. The CAD kernel (build123d / OCCT), the named-views
table ([lib/viewport/view_animator.js:105](lib/viewport/view_animator.js#L105)),
and the ViewCube widget ([app/viewport/view_cube.js](app/viewport/view_cube.js))
all assume world **+Z is up**.

three.js' own defaults are Y-up biased:

- `THREE.GridHelper` is built in the **XZ** plane (so it appears as a vertical wall in a Z-up scene).
- A `PlaneGeometry` "floor" needs no rotation in Z-up (its default normal is +Z) but in Y-up tutorials it's almost always rotated `-PI/2` about X — copying that rotation into this project produces a vertical wall.
- `HemisphereLight` / `DirectionalLight` positions in three.js examples put the "up" component in `.y`; here it belongs in `.z`.

**Rule:** any new scene infrastructure (camera, lights, ground grid, ground
plane, contact shadow, axes) goes through
[lib/viewport/conventions.js](lib/viewport/conventions.js). If you reach for
`new THREE.GridHelper(...)`, `new THREE.HemisphereLight(...)`,
`new THREE.PerspectiveCamera(...)`, or a PlaneGeometry-on-the-floor anywhere
else, you're about to write a Y-up bug. Add a helper to `conventions.js`
instead.

The companion file [lib/viewport/env.js](lib/viewport/env.js) owns the
IBL/contact-shadow "fancy rendering pack" and is Z-up correct;
`conventions.js` re-exports `addContactShadow` from it.

## Euler convention: THREE 'XYZ' everywhere

Every rotation triple in the document (`Component.origin.rotation`,
`StandardPart.transform.rotation`, mate-solver `euler` output) is **Euler
XYZ intrinsic, radians — THREE.Euler order 'XYZ', i.e. R = Rx·Ry·Rz**.
Three places compose/recover it and MUST stay in lock-step:

- [lib/document/emit.js](lib/document/emit.js) `_mat4FromPosEuler` — bakes
  placements into build123d `Location` (kernel side),
- [app/viewport/snap_frames.js](app/viewport/snap_frames.js)
  `composeMatrix` — live drag preview,
- [src/lib/library/mate_solver.js](src/lib/library/mate_solver.js)
  `_eulerXYZToR` / `_eulerXYZFromR` — mate solves + connector world frames.

The trap: a Rz·Ry·Rx ("ZYX") composition agrees with XYZ for any
**single-axis** rotation, so axis-aligned demos pass while compound
orientations (e.g. a t-slot mate: slide +X→+Z *and* thread +Z→+X) land
mis-rotated. The regression test is in
[src/lib/library/__tests__/slot_mate.mjs](src/lib/library/__tests__/slot_mate.mjs)
("solved euler reproduces the matrix under THREE-XYZ composition") — if you
add a new euler composer, test it against a compound rotation, not a 90°
spin about one axis.

## GLB import: Y-up → Z-up

build123d / OCCT export glTF per spec — **Y-up**. The bridge
([lib/document/bridge.js:243](lib/document/bridge.js#L243)) and the preview
([lib/document/preview.js:147](lib/document/preview.js#L147)) wrap the
loaded scene with `rotation.x = +Math.PI / 2` to convert. The sign matters:

- `+π/2` about X maps data `+Y → world +Z` (up stays up). **Correct.**
- `−π/2` about X maps data `+Y → world −Z` (up becomes down). A box with
  `Align.MIN` on Z ends up entirely below the ground plane.

A symmetric-on-Z body (old `Align.CENTER`) hides this bug because
`world_z = ±h/2` looks centered either way. Test new import paths with
an `Align.MIN` primitive — if it sinks below the grid, the rotation sign
is wrong.

## Primitive alignment

CAD primitives emitted by [lib/document/emit.js](lib/document/emit.js) use
`Align.MIN` on Z (bottom face on the world XY plane). The `centered`
parameter on `Box` / `Cylinder` means "centered in XY, sitting on Z=0" —
**not** "centered in XYZ." Using `Align.CENTER` on Z would bury half the
body below the grid.

## Face / edge picking: prefer exact, not heuristic

The kernel ships per-face triangulation and per-edge polylines in
`bridge.geometry` (used by [app/picking/face_overlay.js](app/picking/face_overlay.js)
to render the hover tint). The same data also powers
[lib/picking/pick_proxies.js](lib/picking/pick_proxies.js), which builds
invisible per-face and fat-tube per-edge meshes that the raycaster targets
directly. A single raycast hit returns the **exact** face/edge descriptor —
no center-distance heuristic, no normal-misalignment weighting, no
"small adjacent face wins by 2 mm" ambiguity.

The legacy heuristic in [lib/picking/face_picker.js](lib/picking/face_picker.js)
(`pickFaceFromCursor` / `pickEdgeFromCursor`) is retained only as a fallback
for callers that haven't wired a proxy layer (tests, early init). When
adding a new picking surface, hand `attachPicking` a `pickProxies` instance
— don't fall back to the heuristic.

The proxy group is parented at scene identity (NOT under the GLB wrap)
because the kernel's per-element geometry is already in world-frame mm
Z-up. Inheriting the wrap's 1000× scale would put proxies 1 km off the
body.

## Tessellation quality

Mesh smoothness is OCCT's *chord-deviation tolerance* — the max distance
between a curved B-Rep surface and its triangulated approximation, in mm.
Lower = finer triangles = smoother curves = more polygons.

End-to-end wire:

1. User picks a preset in settings → `graphics.tessellationQuality` ∈
   `{draft, medium, high, ultra}`.
2. `applySettings` in [main.js](main.js) reads the preset, looks up its mm
   value from `TESSELLATION_DEFLECTION_MM` in
   [app/settings/index.js](app/settings/index.js), and calls
   `executor.setTessellationDeflection(mm)`.
3. The executor stores it and passes `{ deflection: mm }` on every
   `client.executeCode(...)` call.
4. `HttpKernelClient.executeCode` puts it in the POST body as `deflection`.
5. The Flask server clamps it to `[0.001, 1.0]` mm and forwards to
   `execute_b123d(code, formats, deflection=…)`.
6. `_extract_geometry_v4` / `_extract_geometry_v3` call
   `_ensure_meshed(body, deflection)` so every face is re-triangulated at
   the requested tolerance before the per-face mesh is shipped.

Preset → mm:

| Preset | Deflection (mm) | Use case |
|---|---|---|
| draft  | 0.20  | Faceted, sub-second compile |
| medium | 0.05  | Default — noticeable smoothing |
| high   | 0.015 | Near-CAD-grade curves |
| ultra  | 0.005 | Reference quality, large meshes |

Changing the preset doesn't auto-recompile — the new tessellation lands
on the next kernel call (Ctrl+S, any v4 op, or a document mutation).

## Viewport stack

| Layer | File | Owns |
|---|---|---|
| Z-up scene primitives | [lib/viewport/conventions.js](lib/viewport/conventions.js) | camera, grid, ground plane, lights, axes, contact-shadow re-export |
| IBL / shadow pack | [lib/viewport/env.js](lib/viewport/env.js) | RoomEnvironment IBL, gradient background, contact shadow |
| Camera controls | [lib/viewport/camera_controls.js](lib/viewport/camera_controls.js) | CAD-grade orbit/pan/zoom (ray-pivot, cursor-glued) |
| View animator | [lib/viewport/view_animator.js](lib/viewport/view_animator.js) | named-view tweens, NAMED_VIEWS table |
| ViewCube widget | [app/viewport/view_cube.js](app/viewport/view_cube.js) | top-right HUD cube |
| Wiring | [main.js](main.js) `createRenderer` | composes the above into one viewport |

When something looks wrong in the scene, check **conventions.js** first.

## Billing & plans (Phase 4)

Two plans, stored in `profiles.plan` ∈ `('free','paid')`: **Free** and
**Pro = $9.99/month** ('paid'). Billing is driven by **Stripe** (Checkout +
billing portal + signature-verified webhook) in
[b123d_server/billing.py](b123d_server/billing.py), registered in
`server.py`:

| Endpoint | Purpose |
|---|---|
| `GET /billing/me` | current plan + usage for the signed-in user |
| `POST /billing/checkout` | start a Stripe Checkout session → Pro |
| `POST /billing/portal` | open the Stripe billing portal (manage/cancel) |
| `POST /billing/webhook` | Stripe → flips `profiles.plan` via service role |

The webhook is the only writer of `profiles.plan` — it verifies the Stripe
signature (`STRIPE_WEBHOOK_SECRET`) and updates Supabase with the
**service-role key** (so it can write rows RLS would otherwise block).
Daily caps live in [b123d_server/auth_gate.py](b123d_server/auth_gate.py)
(`_PRO_PLANS` / `_cap_for`): Free = 15 AI / 60 compiles per day, Pro = 200 /
1000. The client reads plan + usage from `GET /billing/me` into the session
store ([src/lib/auth/session.svelte.js](src/lib/auth/session.svelte.js)),
which feeds the nav plan badge + Upgrade/Manage and the Pricing page
(`#/pricing`).

**Login is mandatory whenever Supabase is configured** — the studio gate
(`App.svelte`) auto-requires sign-in in any real deployment; set
`VITE_REQUIRE_AUTH=0` as an explicit escape hatch, and unconfigured
dev/tests stay open. Stripe env vars (`STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID`, `APP_URL`) are documented in
`.env.example`; leave them unset to run free-only.
