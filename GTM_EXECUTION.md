# GTM Execution — phased plan + progress log

> Companion to [GTM.md](GTM.md) (the 7-day launch plan). This file tracks
> execution: phases, checklists, and a running status log. Updated by Claude
> as work lands.

**Hero workflow (the only thing v1 sells):** AI chat → assembly from verified
library → one-click part swap → kinematics sliders → auto-fitted casing →
download STL.

---

## Phase 1 — v1 feature trim (hide non-hero UI) — ✅ DONE 2026-06-13

One switch, `V1` in `src/lib/flags.js` (override with `VITE_FULL_UI=1` for dev),
gates every non-hero surface. Nothing is deleted — full UI returns by flipping
the flag.

### Keep (hero surface)
AI chat panel · library palette + drag-to-place · part swap · mates/snap ·
kinematics sliders · casing · viewport + ViewCube + camera + display modes ·
document tree + visibility · undo/redo · primitives (Box/Cyl/Sphere/Torus) ·
Fillet/Chamfer/Shell/Hole · booleans (Union/Cut/Intersect) · Move/Rotate/Scale ·
Press-Pull · Measure · Section view · Export (STL/STEP/GLB) · Settings
(General/Viewport/Camera/Graphics/Measurement/Export/AI).

### Hide behind the flag
- [x] `src/lib/flags.js` — single `V1` flag, env-overridable (`VITE_FULL_UI=1`)
- [x] **Command registry** (`src/lib/commands/registry.js`): 37 commands
      tagged `v1Hidden`, filtered at the single choke point `filterCommands`
      (covers Ctrl+K palette AND toolbar search, which routes through the
      palette). Tagged: all 9 sketch commands, sweep/loft/helix,
      move/delete/offset-face (+form variants), draft, split body/face,
      align, 4 patterns, ref plane/axis/point, script create/edit, diff
      viewer, custom import, parameters dialog, interference, cosmetic
      thread. Implementations untouched — still invocable by id (AI tools,
      Esc binding, marking menu).
- [x] **Toolbar**: Sketch dropdown, Sweep/Loft, Move/Delete/Offset Face +
      Draft, ref-geometry + pattern clusters, Align, Interference, CAD-import
      + script-editor buttons gated. Insert-Component kept.
- [x] **TopBar**: Parameters button gated. **Share kept** — verified
      functional (`shareDocumentBundle` builds a JSON+screenshot zip).
- [x] **Inspector**: DFM, Invariants, Assumptions (both occurrences),
      Connectors gated. Parameters/Properties/Relationships/Transform/
      Kinematics/Scene kept.
- [x] **Sidebar**: "CAD Imports" tab + New-script tree-header button gated.
      (RepairLoopPanel turned out to be an unmounted orphan — nothing to
      gate. PanelRail/panels registry only lists kept panels — no change.)
- [x] **Settings schema**: `SETTINGS_SCHEMA` = filtered view of internal
      `FULL_SETTINGS_SCHEMA`; hides `manufacturing`, `markingMenu`,
      `shortcuts`. Persistence iterates the full schema so stored values
      for hidden panels survive.
- [x] **Export dialog**: v1 set is **STL (binary/ASCII) + STEP only** — GLB
      export turned out to be fake (exporter supports step/stl/brep; glTF
      fell back to STL with a warning). 3MF/OBJ/glTF/BREP gated; persisted
      `defaultFormat` pointing at a hidden format clamps back to `stl`.
- [x] **Verify**: `npm run build` green; document suite green (all
      sub-suites pass, e.g. component-groups 13/13, autosave/round-trip
      27/27); `npm run eval` baseline OK (Δ 0.0%). Flag-off path
      (`VITE_FULL_UI=1`) restores full UI — not yet browser-verified.

### Out of scope for this phase
Auth, caps, billing, deploy — Phases 3–5. Library `_unverified` gate already
shipped (GTM.md).

---

## Phase 2 — ship to main + auth gate + usage caps (GTM Day 1)

*(Former Phases 2 and 3, merged — the auth work lands on the same branch and
merges to main in one motion.)*

**Ship to main:**
- [x] Commit the working set on `ai-assembly-phases`, grouped into logical
      commits (core flow work / v1 trim / GTM docs)
- [x] Browser eyeball: `scripts/check_v1_trim.mjs` (headless Chromium)
      verifies 15 gated + 12 hero surfaces in BOTH modes; caught + fixed one
      leak (Sidebar "Parameters (N)" dialog link)

**Auth + caps:**
- [x] Supabase email magic-link + Google OAuth: real AuthView, session store
      (`src/lib/auth/session.svelte.js`), GlobalNav user chip + sign-out.
      Studio gate behind `VITE_REQUIRE_AUTH=1` (default off for dev/tests)
- [x] Bearer token attached to `/execute`, `/measure`, `/ai/chat`
      (kernel_client, measure api, AI provider via `lib/auth_token.js`)
- [x] Server gate (`b123d_server/auth_gate.py`): Supabase JWT verification
      (cached), daily caps free 15 AI / 60 compiles, pro 200/1000 (env-
      tunable), in-memory floor + durable `increment_usage` RPC when service
      key present. Enabled by `REQUIRE_AUTH=1` (default off). 401/429 JSON
      mapped to friendly client messages. 13 unit tests green.
- [x] `plan` column scaffolding: `profiles` (auto-created on signup, plan
      free/maker/lifetime) + `usage_daily` + RPC appended to
      `supabase_schema.sql` (RLS owner-read; writes service-role only)
- [ ] ⚠ Manual remainder: run the appended schema block in the Supabase SQL
      editor, then one real sign-in → compile round-trip with
      `REQUIRE_AUTH=1` + `VITE_REQUIRE_AUTH=1`

**Merge:**
- [x] Full battery green: build, document suites, measure api 17/17,
      pytest auth gate 13/13, eval baseline Δ 0.0%, browser trim check.
      Live kernel probe: gate ON → 401 on execute/measure/ai-chat (health
      open); gate OFF → identical to before
- [x] Merge `ai-assembly-phases` → `main` (55e2a6d, clean; battery re-run
      green on main)
- [ ] ⚠ **Push blocked — needs user decision.** GitHub rejects the push:
      unpushed commit `c22a3ab` (v0.22) committed PyInstaller sidecar
      artifacts (`b123d_server/build/…pkg` 550 MB, `src-tauri/binaries/…exe`
      550 MB) over the 100 MB hard limit. Fix requires rewriting the 127
      never-pushed local commits to drop those paths (pushed history stays
      byte-identical; no force-push). Claude's sandbox denied git
      history-rewrite tools — run the rewrite manually or grant permission.

## Phase 3 — billing (GTM Day 2)

- [ ] Pick merchant-of-record (Lemon Squeezy vs Polar)
- [ ] Checkout + webhook → `plan` flag in Supabase → caps lift
- [ ] Pricing wired: Free / Maker $19/mo / Lifetime $129 (100 seats)

## Phase 4 — deploy + kernel sandbox (GTM Day 3)

- [ ] Kernel hardening: server-side-only emit path to `/execute`, no secrets,
      no network egress, 30 s timeout, disposable container
- [ ] Frontend → Vercel; kernel → Fly.io/Railway (one always-on worker)
- [ ] Smoke test the deployed stack end-to-end

## Phase 5 — landing page + hero video (GTM Day 4)

- [ ] Record 75-second hero video (assemble → swap → casing → STL)
- [ ] Cut 3 GIFs
- [ ] Landing page: video + pricing + signup, nothing more

## Phase 6 — dogfood (GTM Day 5)

- [ ] 5 full builds through the chat UI as a stranger would
- [ ] STL prints clean in a slicer (screenshot proof)
- [ ] Fix only what breaks

## Phase 7 — launch (GTM Days 6–7)

- [ ] Soft launch: X thread, r/3Dprinting, r/robotics, r/functionalprint,
      maker Discords, 20 YouTuber/educator DMs with free Pro
- [ ] Show HN + Product Hunt

---

## Status log

- 2026-06-13 — Plan drafted. UI surface inventoried (toolbar, 65+ command
  registry, 12 settings panels, inspector panels, dialogs). Existing gate
  mechanisms identified for reuse: command `enabled()` predicates, settings
  schema array, conditional panel rendering, `_unverified` library gate.
  Phase 1 started.
- 2026-06-13 — **Phase 1 complete.** 3 parallel agents gated registry (37
  commands), Toolbar/TopBar/Inspector/Sidebar, settings schema, export
  dialog behind `V1` in `src/lib/flags.js`. Build + document suite +
  eval baseline all green. Discoveries: GLB export was never real (STL
  fallback) → v1 export is STL+STEP; RepairLoopPanel was already an
  unmounted orphan; Share is functional and kept. Remaining manual check:
  eyeball the trimmed UI in the browser once, and once with
  `VITE_FULL_UI=1`. Next: Phase 2 (commit + merge to main).
- 2026-06-13 — Merged former Phases 2+3 into one **Phase 2 — ship to main +
  auth gate + caps**: auth lands on the branch and merges to main in one
  motion (no point merging an open `/execute` to main first). Later phases
  renumbered: billing→3, deploy→4, landing→5, dogfood→6, launch→7.
