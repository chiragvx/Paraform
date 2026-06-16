# PLAN — Windows Native App (.exe), first shippable target

**Status:** proposed · **Owner:** Chirag · **Created:** 2026-06-17
**Scope:** Windows-first slice of [PLAN-on-device-native.md](PLAN-on-device-native.md).
macOS is **deferred** to a later phase. Deliverable: a **signed, auto-updating
Windows installer (`.exe`)** that runs the CAD kernel on-device with mandatory
cloud sign-in.

---

## 0. Where Windows stands today (inventory)

Stronger than expected — most scaffolding exists and has compiled here.

| Item | State | Notes |
|---|---|---|
| Tauri shell + window config | ✅ | `src-tauri/tauri.conf.json` (productName **ParaForm**) |
| Sidecar spawn/kill lifecycle | ✅ | `src-tauri/src/lib.rs`, target triple via `build.rs` |
| Capabilities (sidecar spawn/kill, dialog, fs) | ✅ | `src-tauri/capabilities/default.json` |
| Windows sidecar binary | ⚠️ **stale** | `binaries/b123d_server-x86_64-pc-windows-msvc.exe`, **577 MB, built May 29** — predates the AI-editor/plan kernel changes. Gitignored (`.gitignore:45`) ✅ |
| Full Windows icon set | ✅ | `src-tauri/icons/` (`.ico` + all Square logos) |
| Self-bootstrap build | ✅ | `scripts/ensure-sidecar.js`, npm `tauri:build` |
| Dev build compiled | ✅ | `src-tauri/target/debug/` |
| **Release bundle / installer** | ❌ | none yet — only the dev build exists |
| **Code signing** | ❌ | no cert, no sign step |
| **Auto-update** | ❌ | no updater plugin / feed |
| **Desktop-shaped mandatory auth** | ❌ | Supabase redirect is web-origin today |
| **Production build env** | ❌ | see W1 — `index.html` dead-tunnel bug below |
| **Windows release CI** | ❌ | `ci.yml` is ubuntu-only tests |

---

## 1. Definition of done (Windows)

- [ ] A **signed NSIS `setup.exe`** installs on a clean Windows 10/11 (no toolchain) with **no SmartScreen block**.
- [ ] Launch → local sidecar boots on `127.0.0.1:7823` → **mandatory sign-in** completes → design a part (compute is local, uncapped) → **project saves to cloud** (local save as fallback).
- [ ] WebView2 present or auto-installed on a clean machine.
- [ ] **Auto-update** delivers the next version end-to-end.
- [ ] Whole thing reproducible via `npm run tauri:build` and a tagged CI run.

---

## 2. Phases (ordered to reach a working .exe fast, then harden)

### Phase W0 — Produce a working release `.exe` NOW (prove the chain) · ~1 day
The fastest way to surface real problems is to build the thing.
- [ ] **Rebuild the sidecar from current kernel:** `npm run sidecar:build`. The
  on-disk 577 MB binary is from May 29 and predates the current `b123d_server`
  (AI editor, plan tools) — shipping it would ship a stale kernel.
- [ ] `npm run tauri:build` → NSIS `setup.exe` + `.msi` in
  `src-tauri/target/release/bundle/`.
- [ ] Install on this machine; launch; confirm `lib.rs` spawns the sidecar
  (`GET 127.0.0.1:7823/health`), then run one full design→compile end-to-end.
- [ ] Record: install size, cold-start time, first-compile time, any mock-mode
  fallthrough.
- **Exit:** a locally-built installer that designs a part. Everything else hardens this.

### Phase W1 — Production build config + the dead-tunnel fix · ~1-2 days
- [ ] **FIX (blocker): `index.html:33` hardcodes a dead cloudflare tunnel** as
  `window.__PARAFORM_ENGINE_URL__`. In `lib/document/kernel_client.js:24` the
  window global is checked **before** the desktop sidecar default, so the
  packaged app (non-localhost origin) would call the dead tunnel instead of its
  own kernel. Gate that injection to web-only (skip when `isDesktop()`), or
  strip it from the desktop build.
- [ ] Bake desktop production env: `VITE_REQUIRE_AUTH=1`, `VITE_SUPABASE_URL` +
  publishable key. Ensure `VITE_ENGINE_URL` is **unset** for the desktop build
  so resolution falls through to `defaultEngineUrl()` → `127.0.0.1:7823`.
- [ ] Confirm the **frozen sidecar needs no `../.env`**: local kernel runs with
  `REQUIRE_AUTH` defaulting to 0 (uncapped local compiles) and AI via
  bring-your-own-key headers (`X-Provider-*`), so no server-side keys required.
- [ ] Narrow `bundle.targets` from `"all"` to `["nsis"]` (the `setup.exe`; keep
  `msi` only if needed). Set NSIS metadata: publisher, license page, install
  mode (perUser avoids admin prompt), `productName`/version from `tauri.conf.json`.
- [ ] Decide + set the WebView2 install strategy in `bundle.windows.webviewInstallMode`
  (`downloadBootstrapper` is the small default; `embedBootstrapper`/`offlineInstaller`
  for air-gapped installs).

### Phase W2 — Mandatory sign-in in the native shell · ~3-5 days
*(Per decision: sign-in mandatory, never fully offline, cloud-primary save.)*
- [ ] **Desktop OAuth:** Supabase magic-link/OAuth redirect targets a web origin
  today (`.env.example` redirect notes). Add a deep-link scheme
  (`com.paraform.app://auth`) or localhost-loopback callback so sign-in completes
  inside the app. Register the scheme in `tauri.conf.json` + handle the callback
  in `lib.rs` / `session.svelte.js`.
- [ ] Keep the gate mandatory: studio (`App.svelte`) requires a signed-in session
  before loading; show a clear **re-auth / "no network"** state (we are *not*
  offline-tolerant).
- [ ] Confirm **cloud-primary save** (Supabase `cad_documents`) is source of
  truth; expose **local save** (`.paraform.json` export/import) as the fallback.
- [ ] Identity token still flows to local sidecar via `getAuthToken()` — but the
  local kernel is uncapped, so the token is for identity/telemetry, not metering.

### Phase W3 — Code signing (Windows) · ~2-3 days + cost
- [ ] Acquire a cert: **Azure Trusted Signing (~$10/mo, recommended)** or an
  OV/EV cert. EV builds SmartScreen reputation instantly; OV warns until
  reputation accrues.
- [ ] Wire signing into `tauri.conf.json` `bundle.windows` (signCommand /
  certificateThumbprint) or a CI sign step.
- [ ] **Acceptance:** a *downloaded* (not locally-built) `setup.exe` installs on
  a clean machine with no SmartScreen block.

### Phase W4 — Auto-update · ~2-3 days
- [ ] Add `tauri-plugin-updater`; generate the update keypair
  (`TAURI_SIGNING_PRIVATE_KEY`), keep the private key in CI secrets.
- [ ] Release feed: GitHub Releases hosting signed `latest.json` + the NSIS
  artifact.
- [ ] In-app "update available" prompt; verify a `0.1.0 → 0.1.1` upgrade.

### Phase W5 — Windows release CI · ~2-3 days
- [ ] GH Actions job `runs-on: windows-latest`: setup Python 3.11 + Rust + Node,
  `npm run sidecar:build` (**cache it** — ~577 MB / ~5 min), `npm run tauri:build`,
  sign (W3), upload artifact + update feed.
- [ ] Tag-triggered (`v*`). **CI must rebuild the sidecar every release** — never
  ship the gitignored local copy (drift risk).

### Phase W6 — Packaging polish + clean-machine QA · ~3-5 days
- [ ] Switch sidecar `--onefile` → `--onedir` (`build_sidecar.py`) for faster
  cold start (onefile re-extracts ~577 MB to temp on every launch); measure
  before/after.
- [ ] App-size trim: prune PyInstaller includes; confirm installer size.
- [ ] App data + logs under `%APPDATA%/ParaForm`; surface a crash/log path for
  support. File association for `.paraform.json` (open-with).
- [ ] **QA matrix:** clean Windows 10 + Windows 11 VMs, no toolchain, no prior
  install → install → sign-in → design → cloud save → auto-update. Watch for
  **antivirus false positives** (common with PyInstaller onefile; signing +
  onedir reduce them).

---

## 3. Windows-specific risks

1. **Stale frozen-kernel drift (HIGH, easy to miss).** The committed workflow
   must always rebuild the sidecar; the local 577 MB May-29 copy is stale. CI
   gate in W5.
2. **`index.html` dead-tunnel mis-route (HIGH, found).** Fixed in W1 — without
   it the packaged app talks to a dead URL, not its own kernel.
3. **Sidecar size / cold start (MED).** 577 MB onefile re-extracts each launch →
   slow first compile; `--onedir` mitigates (W6).
4. **SmartScreen reputation (MED).** New OV cert still warns until reputation
   builds; EV avoids it. Budget decision in W3.
5. **WebView2 dependency (MED).** Tauri needs Edge WebView2; choose bootstrapper
   mode (W1) so clean machines aren't broken.
6. **AV false positives on PyInstaller onefile (LOW-MED).** Signing + onedir
   reduce; may need vendor whitelisting.

---

## 4. Cost

- **Engineering:** ~2-3 focused weeks to a signed, auto-updating Windows
  installer (W0-W1 get a runnable `.exe` in ~2-3 days; the rest is hardening).
- **Recurring $:** Windows signing ~$120 (Azure Trusted Signing) to ~$400/yr
  (OV cert) + CI Windows-runner minutes. Cloud (Supabase/Stripe) unchanged.

---

## 5. Immediate next step

**Phase W0** — rebuild the current-kernel sidecar and run `npm run tauri:build`
to get a real `setup.exe`, then launch it and design one part. That single pass
validates the whole chain and turns the rest of this plan from estimate into
checklist. (Needs your go-ahead — building/installing is a local action with
real output, and W0 also flushes out the W1 dead-tunnel fix in practice.)
