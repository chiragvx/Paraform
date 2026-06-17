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
| Windows sidecar binary | ✅ **fresh, lean, compile-verified** | rebuilt 2026-06-17 from current kernel, **159 MB** (was 577 MB); produces a GLB. Gitignored (`.gitignore:45`) ✅ |
| Full Windows icon set | ✅ | `src-tauri/icons/` (`.ico` + all Square logos) |
| Self-bootstrap build | ✅ | `scripts/ensure-sidecar.js`, npm `tauri:build` |
| Dev build compiled | ✅ | `src-tauri/target/debug/` |
| **Release installer** | ✅ **built 2026-06-17** | `ParaForm_0.1.0_x64-setup.exe` (161 MB), NSIS; packaged app auto-spawns sidecar + compiles |
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

### Phase W0 — Produce a working release `.exe` NOW (prove the chain) · ✅ DONE 2026-06-17
The fastest way to surface real problems is to build the thing. It surfaced several.
- [x] **Rebuilt the sidecar from current kernel** (`npm run sidecar:build`).
- [x] `npm run tauri:build` → **`ParaForm_0.1.0_x64-setup.exe` (161 MB)** at
  `src-tauri/target/release/bundle/nsis/`.
- [x] Launched the built `app.exe`; confirmed `lib.rs` auto-spawns the bundled
  sidecar (`GET 127.0.0.1:7823/health` → `build123d 0.10.0`) and a real
  `Box → GLB` compile returns `ok=True` (4600 bytes). End-to-end chain works.

**W0 findings (the May-29 freeze would have failed on first compile):**
- Dual Qt bindings (PyQt5 + PySide6) aborted PyInstaller → exclude all Qt/VTK.
- torch + ML stacks bundled but unused → excluded. **Sidecar 577 MB → 159 MB.**
- `lib3mf.dll` (separate package, loaded by build123d's mesher) wasn't bundled →
  added `--collect-all lib3mf`. Was a latent crash-on-first-compile bug.
- `build123d.__version__` came back "unknown" → `--copy-metadata build123d`
  restored the version-drift handshake (now reports 0.10.0).
- Fixed `index.html` dead-tunnel desktop mis-route (gated to web-only).
- Narrowed bundle to NSIS.
- All committed in `444d69a`. A post-build geometry probe is now the validation
  gate before any installer build (kernel must produce a GLB).
- **Cold-start / install-size measurement still TODO** (rolls into W6).

### Phase W1 — Production build config + the dead-tunnel fix · ✅ DONE 2026-06-17
Done: dead-tunnel gated web-only; per-user NSIS install (no admin), WebView2
downloadBootstrapper, LZMA compression, publisher metadata; bundle id fixed to
`com.paraform.studio`; desktop ignores the `VITE_REQUIRE_AUTH=0` escape hatch
(auth mandatory). Remaining: bake real Supabase env at release time (documented
in `docs/DESKTOP-BUILD.md`). Original checklist:
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

### Phase W2 — Mandatory sign-in in the native shell · ✅ CODE-COMPLETE 2026-06-17
Done: `paraform://` deep-link OAuth — deep-link + opener + single-instance
plugins (Rust), `src/lib/auth/desktop_oauth.js` opens the authorize URL in the
system browser and completes the session from the callback (PKCE + implicit);
`session.svelte.js` branches both sign-in methods + starts the listener; gate is
mandatory on desktop. Verified compiles (cargo check + vite build). **Full
round-trip needs your Supabase dashboard config** (add `paraform://auth-callback`
to Redirect URLs) + GitHub OAuth app — see `docs/DESKTOP-BUILD.md §4`. Original
checklist:
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

### Phase W3 — Code signing (Windows) · ⏳ WIRED, NEEDS CERT (your purchase)
Release CI + docs reference the signing secrets; `tauri.conf.json` is ready for
`bundle.windows` sign config. **Blocked only on buying a cert** (Azure Trusted
Signing ~$10/mo recommended). Steps in `docs/DESKTOP-BUILD.md §6`. Original
checklist:
- [ ] Acquire a cert: **Azure Trusted Signing (~$10/mo, recommended)** or an
  OV/EV cert. EV builds SmartScreen reputation instantly; OV warns until
  reputation accrues.
- [ ] Wire signing into `tauri.conf.json` `bundle.windows` (signCommand /
  certificateThumbprint) or a CI sign step.
- [ ] **Acceptance:** a *downloaded* (not locally-built) `setup.exe` installs on
  a clean machine with no SmartScreen block.

### Phase W4 — Auto-update · ✅ DONE 2026-06-17
Done: updater + process plugins wired; signing keypair generated (pubkey in
`tauri.conf.json`, private key gitignored → CI secret); GitHub `latest.json`
endpoint; `src/lib/updater/check.js` checks on startup → installs signed update →
relaunch; `createUpdaterArtifacts` on. Live update delivery happens once the
first release is published (W5). Original checklist:
- [ ] Add `tauri-plugin-updater`; generate the update keypair
  (`TAURI_SIGNING_PRIVATE_KEY`), keep the private key in CI secrets.
- [ ] Release feed: GitHub Releases hosting signed `latest.json` + the NSIS
  artifact.
- [ ] In-app "update available" prompt; verify a `0.1.0 → 0.1.1` upgrade.

### Phase W5 — Windows release CI · ✅ DONE 2026-06-17
Done: `.github/workflows/release.yml` (windows-latest, tag-triggered) rebuilds
the sidecar from source, `tauri-action` builds + signs + drafts a GitHub Release
with the NSIS installer + updater artifacts. **Needs repo secrets set** (updater
key, Supabase env, later the cert) — `docs/DESKTOP-BUILD.md §7`. Original
checklist:
- [ ] GH Actions job `runs-on: windows-latest`: setup Python 3.11 + Rust + Node,
  `npm run sidecar:build` (**cache it** — ~577 MB / ~5 min), `npm run tauri:build`,
  sign (W3), upload artifact + update feed.
- [ ] Tag-triggered (`v*`). **CI must rebuild the sidecar every release** — never
  ship the gitignored local copy (drift risk).

### Phase W6 — Packaging polish + clean-machine QA · ◐ PARTIAL
Done: **bundled the standard_parts catalog (204 parts) + VERSIONS.json** that
the freeze was silently dropping (parts library was empty — real functional bug
caught from the cold-start boot log); size handled (159 MB sidecar); file
association intentionally skipped (cloud-primary + `.json` tail would hijack all
JSON — documented); `--onedir` evaluated and deferred (onefile works; switch
documented if cold start is bad). **Cold-start measured ≈ 15 s** (onefile
extract + OCP import) — acceptable but the main candidate for `--onedir` later.
Remaining (needs hardware, not code): clean-VM QA matrix (Win10/11), AV
false-positive check. Original checklist:
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
   must always rebuild the sidecar. ✅ Mitigated for now (rebuilt 2026-06-17);
   CI must enforce per-release rebuild in W5.
2. **`index.html` dead-tunnel mis-route (HIGH, found).** ✅ FIXED in `444d69a`
   (gated to web-only) — packaged app routes to its own sidecar.
3. **Sidecar size / cold start (MED).** ✅ Size largely handled: 577 → 159 MB by
   excluding Qt/VTK/torch. Onefile still re-extracts on launch → cold-start
   measurement + optional `--onedir` remains in W6.
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

**W0 is done** — `ParaForm_0.1.0_x64-setup.exe` exists and the packaged app
compiles geometry. Next, in order:
- **W2 — mandatory sign-in in the native shell** (desktop deep-link OAuth +
  prod Supabase env). This is the biggest remaining functional gap before the
  app is shippable per the cloud-primary decision.
- **W3 — Windows code signing** (so the downloaded `setup.exe` doesn't trip
  SmartScreen) — needs a cert decision (Azure Trusted Signing recommended).
- W1 leftovers (prod env bake, WebView2 install mode), then W4 auto-update,
  W5 release CI, W6 cold-start/onedir + clean-VM QA.
