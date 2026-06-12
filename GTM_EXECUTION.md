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
- [ ] ⚠ Manual remainder (user): apply the appended `supabase_schema.sql`
      block to the live project — either authorize the Supabase MCP
      (Claude can then run it) or paste it into the SQL editor — then one
      real sign-in → compile round-trip with `REQUIRE_AUTH=1` +
      `VITE_REQUIRE_AUTH=1`. This is the first item of Phase 4 (deploy)
      anyway; not a code blocker.

**Merge:**
- [x] Full battery green: build, document suites, measure api 17/17,
      pytest auth gate 13/13, eval baseline Δ 0.0%, browser trim check.
      Live kernel probe: gate ON → 401 on execute/measure/ai-chat (health
      open); gate OFF → identical to before
- [x] Merge `ai-assembly-phases` → `main` (local 55e2a6d, clean; battery
      re-run green on main)
- [x] **Pushed to GitHub as a squashed delivery commit** (`c79cf50` on
      origin/main). Direct push was impossible: local commit `c22a3ab`
      (v0.22) had committed 550 MB PyInstaller sidecar artifacts, over
      GitHub's 100 MB hard limit (artifacts now untracked + gitignored;
      kept on disk). Rather than rewrite history, the exact final tree was
      committed fresh on top of origin/main and pushed normally. Granular
      146-commit history is preserved locally on `backup-main-full` and
      `ai-assembly-phases` (local-only — do NOT push those branches; they
      still contain the fat blobs in history). Local `main` now tracks
      origin/main at the delivery commit.

## Phase 3 — studio cleanup: broken features + UI shortcomings — ✅ DONE 2026-06-13

*(Inserted 2026-06-13 at user request — fix what's broken/unpolished in the
v1 surface before charging money for it. Billing pushed to Phase 4.)*

- [x] Audit done — full findings in
      [docs/AUDIT_2026-06-13.md](docs/AUDIT_2026-06-13.md).
- [x] Fixes executed by 4 parallel agents (strict file-ownership lanes) +
      a manual cleanup pass. Build, full JS battery, pytest 13/13, eval
      Δ 0.0%, trim check both modes, and a runtime smoke all green.

**Theme was:** the app works but hid every win (camera booted inside a
seeded box). Fixed — the studio now boots empty and frames the scene.

### 3A — Broken features (P0) — all fixed
- [x] Measure tool: new `MeasureToolMount.svelte` wires the `MeasureTool`
      class into `studio.startMeasure`/`measureToolActive`.
- [x] Settings → AI panel crash: new `settings/AIPanel.svelte` registered
      in `PANELS` (provider/model/maxTokens). **Verified rendering live.**
- [x] Marking menu: `form:` wedges route to `dialogs.openForm`; failure
      toast is now a real top-center card.

### 3B — First-run / demo killers (P0) — all fixed
- [x] Frame scene on first content + on new top-level body (no camera
      fight on edits).
- [x] AI chat open by default first-run (`panels.chat ?? false`).
- [x] Stopped seeding the demo Box; empty-state hint retargeted to the AI
      chat + platform-correct glyph. **Verified empty boot.**
- [x] AI fallback closing bubble (`summarizeTurn` in agent.js) + system
      prompt now says a build request is a request to ACT. Root cause of
      the silent turn: model ended after an observe-only call (not a tool
      gap — creation tools exist); transient Gemini 400s were flaky, not a
      schema bug.
- [x] AppLoader gated to the studio route (kills the landing splash).
- [x] Landing hero copy → AI-assembly pitch. **Verified live.**
- [x] FPS/Unit/Sel debug HUD off by default.

### 3C — Misleading / degraded controls (P1) — fixed
- [x] V1-gate plane-row sketcher entry + Extrude/Revolve buttons.
- [x] Export: dropped "STL (ASCII)" card + dead "Include hidden" checkbox.
- [x] Sidebar delete (trash + context menu) → `deleteFeatureCascade`.
- [x] Tree "Edit…" shown only for BuildScript (real edit surface).
- [x] ScenePanel: removed no-op Build Plate + Lighting Preset selectors.
- [x] Removed duplicate "New Document" (`edit.reset`); `debug.activeComponent`
      → v1Hidden.
- [x] Manage page → "Coming soon" under V1.
- [x] Explore cards render real thumbnails (`/thumbnails/*.png`) w/ fallback.
- [x] Theme "System" → matchMedia + live listener.
- [x] Model ids: fixed `gemini-3.5-flash`→`gemini-2.5-flash`,
      `claude-haiku-4-5`→`…-20251001`. (`claude-opus-4-8`/`claude-sonnet-4-6`
      were valid — audit was wrong; left alone.)
- [x] Kinematics slider debounced ~50 ms + commit-on-release.
- [x] Compile-busy chip in StatusBar.
- [x] Kernel-offline → friendly "3D engine offline — npm run kernel" banner.
- [x] Mac ⌘K glyphs platform-aware (TopBar + viewport hint).
- [x] Toolbar dead "Alt+C" badge removed.
- [x] Sidebar "Origin" row → plain label (no dead click).
- [x] AuthView unconfigured branch → friendly copy.
- [x] Feature auto-numbering ("Box 2", "Box 3") in operations.js `_mkFeature`.
- [x] Library palette: drag-into-scene hint + humanized metadata.
- [x] `launchView` landing/library now navigate/open on boot.
- [x] `damping` wired into camera coast; hid the 3 truly-dead settings
      (`performance` panel = autoRecompileMs+workerThreads, and `stlBinary`).
      `gridSize` (infinite shader grid) and `edgeThickness`/`antiAliasing`
      (need renderer reload) left documented-inert.

### 3D — P2 — trivial ones done, rest deferred
- [x] ViewCube bookmark tween arg fix (`toPosition`/`toTarget`/`toUp`).
- [x] Deleted orphans: `RepairLoopPanel.svelte`, inner
      `inspector/KinematicsPanel.svelte`, `app/picking/context_menu.js`;
      fixed stale JSDoc in `reparent.js`.
- [~] Deferred to post-launch backlog: collapse the 4× "Document" labels
      (cosmetic), ViewCube edge/corner click nav, Inspector dev-flavor
      polish, FPS/ReadPixels perf, tool-call raw-JSON chips, ShortcutsPanel
      (FULL_UI only) rebind gaps, and the rest of AUDIT §P2.

### Verify — done
- [x] `npm run build` (both modes) + full battery + `check_v1_trim.mjs` green.
- [x] Runtime smoke: empty boot, chat open, **AI settings panel renders**,
      box create 0→1 via kernel, landing copy correct, **zero console
      errors**. (Live human AI demo turn deferred to Phase 7 dogfood.)

## Phase 4 — billing (GTM Day 2)

- [ ] Pick merchant-of-record (Lemon Squeezy vs Polar; lean Polar)
- [ ] Checkout + webhook (Supabase Edge Function) → `plan` flag → caps lift
- [ ] Pricing wired: Free / Maker $19/mo / Lifetime $129 (100 seats)

## Phase 5 — deploy + kernel sandbox (GTM Day 3)

- [ ] Kernel hardening: server-side-only emit path to `/execute`, no secrets,
      no network egress, 30 s timeout, disposable container
- [ ] Frontend → Vercel; kernel → Fly.io/Railway (one always-on worker)
- [ ] Smoke test the deployed stack end-to-end

## Phase 6 — landing page + hero video (GTM Day 4)

- [ ] Record 75-second hero video (assemble → swap → casing → STL)
- [ ] Cut 3 GIFs
- [ ] Landing page: video + pricing + signup, nothing more

## Phase 7 — dogfood (GTM Day 5)

- [ ] 5 full builds through the chat UI as a stranger would
- [ ] STL prints clean in a slicer (screenshot proof)
- [ ] Fix only what breaks

## Phase 8 — launch (GTM Days 6–7)

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
- 2026-06-13 — **Phase 2 complete.** Working set committed (4 logical
  commits), trim browser-verified both ways (1 leak found+fixed), auth
  gate + caps built and live-probed (401/429 correct, auth-off identical),
  merged to main, **delivered to GitHub** (`c79cf50`) as a squash commit
  after 550 MB sidecar artifacts in old local history blocked a direct
  push. Artifacts untracked+gitignored; granular history kept on local
  backup branches. Open: user applies Supabase schema + live sign-in test
  (folded into Phase 4 deploy). Next: Phase 3 — billing.
- 2026-06-13 — Phase 3 redefined as **studio cleanup** (billing → 4, rest
  shifted). Audited the v1 surface: static wiring trace (code-verified) +
  live UX review; dynamic crawl stopped early to save resources. Findings
  archived in docs/AUDIT_2026-06-13.md; actionable checklist above.
  Headline: 3 dead features (measure, AI settings panel, marking-menu
  wedges), and a first-run experience that hides every win (camera inside
  seeded box, chat collapsed, mute AI turns, fake splash on landing).
  Core engine verified solid end-to-end. Corrections: Sweep/Loft are real
  (not stubs); GLB export remains fake.
- 2026-06-13 — **Phase 3 complete.** 4 parallel agents (file-ownership
  lanes) + manual cleanup fixed all 3 P0 broken features, all 7 first-run
  demo-killers, ~22 P1 degraded controls, and trivial P2s; orphans deleted.
  Build (both modes) + full battery + pytest + eval + trim check + runtime
  smoke all green with zero console errors. Verified live: empty boot,
  chat-open default, AI settings panel renders (was crashing), box create
  through kernel, landing copy. Deferred to post-launch: cosmetic P2 tail
  (§3D). Next: Phase 4 — billing.
