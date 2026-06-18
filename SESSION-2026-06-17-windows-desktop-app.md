# SESSION 2026-06-17 — Windows desktop app (W0–W6)

**Goal:** ship ParaForm as a native Windows app (`.exe`) — on-device kernel,
cloud-primary mandatory auth, auto-updating. Mac deferred.
**Outcome:** all implementable phases done + build-verified. Final artifact
`ParaForm_0.1.0_x64-setup.exe` (162 MB) + signed updater `.sig`. Packaged app
launches, auto-spawns its kernel, serves 204 standard parts, and compiles a
`Box → GLB` end-to-end. Remaining work is **external only** (cert purchase,
Supabase dashboard config, CI secrets, clean-VM QA).

Plans: [PLAN-windows-app.md](PLAN-windows-app.md) (Windows slice) and
[PLAN-on-device-native.md](PLAN-on-device-native.md) (overall). Build/release
handoff: [docs/DESKTOP-BUILD.md](docs/DESKTOP-BUILD.md).

---

## Strategic decisions (locked this session)

- **Native desktop = the product.** Web is **paused** (kept dormant, not deleted).
- **Thick client for compute, thin cloud for identity+data:** only the CAD
  kernel moves on-device (kills hosted-OCCT compute cost). Accounts + project
  storage stay cloud.
- **Sign-in is mandatory; never fully offline.** Projects cloud-primary; local
  save is a fallback.
- **Windows first, macOS deferred.**

---

## What was built, by phase

### W0 — first installer + freeze correctness
Rebuilding the PyInstaller sidecar from the current kernel exposed defects that
would have made the existing May-29 binary **fail on first compile** (it was
never compile-tested). Fixes in `b123d_server/build_sidecar.py`:
- Exclude Qt/VTK (dual PyQt5+PySide6 aborts PyInstaller) + torch/ML → **sidecar
  577 MB → 159 MB**.
- `--collect-all lib3mf` (build123d's mesher loads `lib3mf.dll` from a separate
  package; was missing → crash on compile).
- `--copy-metadata build123d` (restored `build123d 0.10.0` version handshake;
  was "unknown").
- Keep IPython/matplotlib (build123d imports IPython at runtime).
- Fixed `index.html` dead cloudflared-tunnel `__PARAFORM_ENGINE_URL__` →
  gated web-only so the packaged app uses its own sidecar.
- Narrowed bundle to NSIS.
- **Validation gate:** a post-build geometry probe (POST a `Box` to `/execute`,
  expect GLB bytes) — caught each freeze defect in ~3-min loops.

### W1 — production build config
- `tauri.conf.json`: per-user NSIS install (no admin prompt), WebView2
  `downloadBootstrapper`, LZMA compression, publisher/copyright.
- Bundle id `com.paraform.app` → `com.paraform.studio` (the `.app` suffix
  conflicts with the macOS bundle extension).
- `App.svelte`: desktop ignores the `VITE_REQUIRE_AUTH=0` escape hatch — auth is
  mandatory in the native build.

### W2 — desktop deep-link OAuth (sign-in in the native shell)
Browser redirect (`window.location.origin`) is `tauri://localhost` in Tauri —
useless for OAuth. Added a custom-scheme flow:
- Rust: `tauri-plugin-deep-link` + `-opener` + `-single-instance` (Win/Linux, so
  a callback while running routes to the live instance). `paraform://` scheme
  registered in `tauri.conf.json` + runtime `register_all`.
- JS: `src/lib/auth/desktop_oauth.js` opens the authorize URL in the system
  browser and completes the session from `paraform://auth-callback` (handles
  both PKCE `?code` and implicit `#access_token`, + cold-start launch URL).
  `session.svelte.js` branches `signInWithGithub`/`signInWithOtp` + starts the
  listener on init.
- Verified compiles (cargo check + vite build). **Live round-trip needs Supabase
  dashboard config** (see handoff).

### W3 — code signing (wired, needs a cert)
Release CI + `docs/DESKTOP-BUILD.md §6` reference the signing secrets and the
`bundle.windows` sign config. Blocked only on buying a cert (Azure Trusted
Signing ~$10/mo recommended; EV avoids SmartScreen warnings immediately).

### W4 — auto-update
- `tauri-plugin-updater` + `-process`; `src/lib/updater/check.js` checks the
  release feed on startup → downloads+installs the signed update → relaunch
  (wired non-blocking from `main.js`, desktop-only).
- Signing keypair generated at `src-tauri/.tauri-updater.key` (**gitignored,
  empty password — regenerate for prod**); pubkey committed in `tauri.conf.json`;
  endpoint = `github.com/chiragvx/Paraform` releases `latest.json`.
- `bundle.createUpdaterArtifacts: true`; build verified to emit the signed
  `.sig`.

### W5 — Windows release CI
`.github/workflows/release.yml` (windows-latest, `v*` tag or manual): setup
node/python/rust, npm ci, install kernel deps, **always rebuild the sidecar from
source**, `tauri-action` builds + signs + drafts a GitHub Release with the NSIS
installer + updater artifacts. Bakes prod frontend env from secrets.

### W6 — packaging polish + QA (partial)
- **Bundled the standard_parts catalog (204 parts) + VERSIONS.json** the freeze
  was silently dropping (parts library was empty — real functional bug caught
  from the cold-start boot log). `--collect-data standard_parts` +
  `--add-data VERSIONS.json`.
- Cold-start measured **≈15 s** (onefile extract + OCP import) — acceptable;
  `--onedir` is the main lever if it needs to be faster (deferred; would change
  the `externalBin` spawn path in `lib.rs`).
- File association intentionally skipped (cloud-primary; `.json` tail would
  hijack all JSON).
- Remaining (needs hardware, not code): clean-VM QA matrix (Win10/11), AV
  false-positive check.

---

## Bugs caught (all would have shipped broken)

1. Dual-Qt PyInstaller abort.
2. Missing `lib3mf.dll` → crash on first compile.
3. `build123d.__version__` = "unknown" (broke version-drift handshake).
4. `index.html` dead-tunnel mis-route → packaged app calling a dead URL.
5. **Empty parts library** (standard_parts + VERSIONS.json not bundled).

---

## Final verification (packaged `app.exe`)

```
[OK] packaged app spawned its bundled sidecar
[OK] parts library serves 204 parts
[OK] compile ok=True glb_bytes=4600
artifacts: ParaForm_0.1.0_x64-setup.exe (162 MB) + .sig
```

---

## Key files touched

- `b123d_server/build_sidecar.py` — freeze excludes/includes + data bundling
- `src-tauri/tauri.conf.json` · `Cargo.toml` · `src/lib.rs` · `capabilities/default.json`
- `index.html` — dead-tunnel guard
- `src/App.svelte` — mandatory desktop auth
- `src/lib/auth/desktop_oauth.js` (new) · `src/lib/auth/session.svelte.js`
- `src/lib/updater/check.js` (new) · `src/main.js`
- `.github/workflows/release.yml` (new) · `docs/DESKTOP-BUILD.md` (new)

Commits: `f5d3a89`..`bbbafc1` (W1→W6) on top of W0 `444d69a`.

---

## Handoff — external inputs to actually ship (not code)

1. **Code-signing cert** (W3) — Azure Trusted Signing (~$10/mo) so downloads
   don't trip SmartScreen.
2. **Supabase dashboard** (W2) — add `paraform://auth-callback` to Redirect URLs
   + a GitHub OAuth app, to make sign-in round-trip live.
3. **CI secrets** (W5) — `TAURI_SIGNING_PRIVATE_KEY` (+ password),
   `VITE_SUPABASE_URL`/`_PUBLISHABLE_KEY`; then `git tag v0.1.0 && git push`.
   ⚠️ Regenerate the updater keypair securely for production.
4. **Clean-VM QA** (W6) — install on fresh Win10/11.

## How to build locally

```bash
npm run sidecar:build     # freeze kernel → src-tauri/binaries (~159 MB, ~5 min)
npm run tauri:build       # → src-tauri/target/release/bundle/nsis/*-setup.exe
```
For updater artifacts, export `TAURI_SIGNING_PRIVATE_KEY` (from the gitignored
key) before `tauri:build`. Full guide: `docs/DESKTOP-BUILD.md`.
