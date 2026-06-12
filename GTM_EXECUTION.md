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

## Phase 3 — studio cleanup: broken features + UI shortcomings

*(Inserted 2026-06-13 at user request — fix what's broken/unpolished in the
v1 surface before charging money for it. Billing pushed to Phase 4.)*

- [x] Audit done — full findings with file:line detail in
      [docs/AUDIT_2026-06-13.md](docs/AUDIT_2026-06-13.md) (static wiring
      trace, code-verified + live Playwright UX review; dynamic crawl
      stopped early by user — covered by the other two).

**Theme:** the app works but hides every win — the studio boots with the
camera inside a seeded 40 mm box, so AI placements and compiles produce
zero visible change. Fix visibility first.

### 3A — Broken features (P0, fix all)
- [ ] Measure tool: create `MeasureToolMount` wiring the existing
      `MeasureTool` class into `studio.startMeasure`/`measureToolActive`
      (Viewport already reads them) (M)
- [ ] Settings → AI Assistant panel: missing `ai` key in `PANELS` crashes
      the dialog; add the panel (it's the only provider/model UI) (S–M)
- [ ] Marking menu: route `form:` commands to `dialogs.openForm`, make the
      failure toast real, N wedge works once measure lands (S)

### 3B — First-run / demo killers (P0, fix all)
- [ ] Frame the scene on first bridge render + after AI placements and
      feature adds (`frameBox` exists in view_animator) (S)
- [ ] AI chat panel open by default on first run + short welcome line (S)
- [ ] Stop seeding the demo Box; retarget the empty-state hint to the AI
      chat (and platform-correct shortcut) (S)
- [ ] AI fallback closing bubble when a turn ends text-less; root-cause the
      silent "add a cube → get_document_summary → nothing" turn (S–M)
- [ ] AppLoader only on the studio route (kills the 3.3 s fake splash on
      landing) (S)
- [ ] Landing hero copy → AI-assembly pitch ("Describe a robot, get a
      printable assembly with a fitted case") (S)
- [ ] Hide the FPS/Unit/Sel debug HUD behind a settings toggle (S)

### 3C — Misleading / degraded controls (P1)
- [ ] V1-gate the sidebar plane-row sketcher entry + Extrude/Revolve
      toolbar buttons (consistent with hidden sketch commands) (S)
- [ ] Export dialog: drop the "STL (ASCII)" card (exports binary) + the
      dead "Include hidden" checkbox (S)
- [ ] Sidebar trash/context-menu delete → `deleteFeatureCascade` (kills
      zombie component husks; matches Del-key behavior) (S)
- [ ] Tree "Edit…": open the feature's form, or drop the item for types
      without an edit surface (M)
- [ ] ScenePanel: remove (or implement) no-op Build Plate + Lighting
      Preset selectors (S remove / M implement)
- [ ] Dedupe "New Document": remove `edit.reset` or route through the
      same unsaved-changes confirm as `doc.new` (S)
- [ ] `debug.activeComponent` → v1Hidden (S)
- [ ] Manage page is fake (hardcoded uploads, stub drop zone) → gate the
      nav link behind `!V1` for launch (S)
- [ ] Explore template cards: render the existing thumbnails; label cards
      as templates-coming or wire the template id through to studio (M)
- [ ] Settings with no consumer: wire or hide `gridSize`, `autoFit`,
      `damping`, `autoRecompileMs`, `workerThreads`, `stlBinary`,
      `edgeThickness`; "reload required" hint on AA (S each)
- [ ] Theme "System" → `prefers-color-scheme` matchMedia + listener (S)
- [ ] AI model ids: verify `claude-*` + `gemini-3.5-flash` ids against
      live APIs; fix agent.js / ai_proxy.py / settings schema (S)
- [ ] Kinematics slider: debounce ~50 ms or commit-on-release (S)
- [ ] Compile-busy chip in StatusBar while a kernel call is in flight (S)
- [ ] Kernel-offline: map `Failed to fetch` to a friendly "Engine
      offline" banner + status dot (S–M)
- [ ] Mac ⌘K glyphs → platform-aware (TopBar + viewport hint) (S)
- [ ] Toolbar search: bind Alt+C or drop the badge; remove dead Enter
      handler (S)
- [ ] Sidebar "Origin" row: make it select/flash the triad or render as
      plain label (S)
- [ ] AuthView unconfigured branch: friendly copy instead of env-var
      instructions (S)
- [ ] Feature auto-numbering ("Box 2") + collapse the 4× "Document"
      labels in the left panel (S–M)
- [ ] Library palette: drag-into-scene hint + human metadata line (S)
- [ ] `launchView` landing/library options: navigate/open accordingly (S)

### 3D — P2 (do only the trivial ones now, defer the rest)
- [ ] ViewCube bookmark tween arg fix (`targetPos`→`toPosition` — restores
      animation, kills per-use warning) (S)
- [ ] Delete orphans: `RepairLoopPanel.svelte`, inner
      `inspector/KinematicsPanel.svelte`, `app/picking/context_menu.js`,
      stale JSDoc in `reparent.js:4` (S)
- [ ] Everything else in AUDIT_2026-06-13.md §P2 → post-launch backlog

### Verify
- [ ] `npm run build` + full battery + `check_v1_trim.mjs` both modes
- [ ] Re-run the first-run script by hand: landing → studio → AI "build a
      servo arm" → visible result without touching the camera

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
