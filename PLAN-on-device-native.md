# PLAN — 100% On-Device Native App (Windows + macOS)

**Status:** proposed · **Owner:** Chirag · **Created:** 2026-06-17
**Goal:** Make the native desktop app the *product*, not a second surface.
Ship a signed, notarized, auto-updating Windows + macOS app where the **CAD
kernel (compute) runs on-device** — while accounts and project storage stay in
the cloud.

> **Shape of the bet:** *thick client for compute, thin cloud for identity +
> data.* The heavy OCCT/build123d work moves to the user's own CPU (kills the
> hosted-kernel compute cost — the real scalability ceiling). Sign-in stays
> **mandatory**, projects **save to the cloud** (with local save as a fallback),
> and the app is **never meant to run fully offline**.

> **Why this is mostly a packaging job, not a rewrite.** The Tauri shell
> (`src-tauri/`), the Rust sidecar lifecycle (`src-tauri/src/lib.rs` — spawns
> the kernel on `127.0.0.1:7823`, kills it on exit), the PyInstaller freeze of
> the whole kernel (`b123d_server/build_sidecar.py`), and the self-bootstrap
> (`scripts/ensure-sidecar.js`) already exist and have compiled on Windows. The
> remaining work is the *shipping last mile* + adapting the **mandatory** cloud
> auth/sync to run inside the native shell.

---

## 1. North star

A creator downloads one installer, signs in, and is designing functional
machines within seconds — no tunnel, no hosted kernel, no per-day compile caps.
Their own CPU does the OCCT work; their projects live in the cloud (synced
across their machines) with a local save as a safety net. The account is always
present; the *compute* is what we move on-device.

Why this is the long-term scalable architecture:

- **On-device compute removes the cost ceiling.** Every compile currently can
  hit a hosted kernel (`VITE_ENGINE_URL` / HF Space). On-device, OCCT compute
  scales with users' own hardware → our marginal compute cost ≈ $0, and the app
  gets faster (localhost, no network round-trip).
- **The cloud keeps doing what it's good at** — identity, durable project
  storage, cross-device sync, billing. It stays the source of truth for *data*,
  not for *geometry compute*.
- **Compile caps lose their cost rationale.** Daily compile caps
  (`b123d_server/auth_gate.py`) exist to bound hosted compute. With the kernel
  local, local compiles can be uncapped — the account stays mandatory for
  identity/storage, not to meter free local CPU.

---

## 2. Current state (what's already done — ~80%)

| Capability | State | Evidence |
|---|---|---|
| Tauri 2.x shell + window config | ✅ done | `src-tauri/tauri.conf.json`, `Cargo.toml` |
| Sidecar spawn/kill lifecycle | ✅ done | `src-tauri/src/lib.rs` |
| Kernel frozen to single binary | ✅ done (Windows) | `b123d_server/build_sidecar.py` (PyInstaller `--onefile`, `--collect-all OCP/build123d/ocpsvg`) |
| Self-bootstrapping build | ✅ done | `scripts/ensure-sidecar.js`, npm `tauri:build` |
| Desktop vs web detection + URL routing | ✅ done | `lib/platform/runtime.js`, `lib/document/kernel_client.js:24` |
| AI runs through local sidecar | ✅ done | `/ai/chat` registered in `server.py:42` |
| Mandatory sign-in gate | ✅ exists (web-shaped) | `VITE_REQUIRE_AUTH`, `session.svelte.js`, `App.svelte` |
| Cloud project sync | ✅ exists | Supabase `cad_documents`/`cad_folders`, local-first mirror |
| Windows dev build compiled | ✅ verified | `src-tauri/target/debug/` fingerprints present |
| **macOS sidecar build** | ❌ not done | needs a Mac — PyInstaller can't cross-compile |
| **Code signing (Win + Mac)** | ❌ not done | no certs, no notarization step |
| **Auto-update** | ❌ not done | no updater plugin / release feed |
| **Desktop-shaped auth (deep-link OAuth)** | ❌ not done | redirect today assumes web origin |
| **Release CI (3 OS matrix)** | ❌ not done | `ci.yml` is tests-only, ubuntu-only |

---

## 3. Strategic decisions — RESOLVED

### D1 — Web app's fate → **PAUSE (abandon, do not delete)** ✅
Keep the web studio code dormant in the repo. No active changes, no deletion.
Stop treating it as a shipping surface; downloads point to native. Revisit later
if a zero-install trial is wanted.

### D2 — Accounts & data model → **Mandatory sign-in, cloud-primary storage** ✅
- Sign-in is **required**; the app is **not** designed to run fully offline.
- Projects **save to the cloud** as the source of truth; **local save is a
  supported fallback** (safety net / quick scratch).
- The **kernel/compute is the only thing that moves on-device.** Auth, storage,
  and sync remain cloud services.
- Local compiles can be **uncapped** (free local CPU); the mandatory account is
  for identity + storage, not compute metering.
- *Open sub-decision (not blocking):* pricing tiers (what Pro unlocks once
  compute is free — likely storage limits, hosted-AI fallback keys, premium
  libraries). Decide before Phase 3 billing wiring.

### D3 — PyInstaller packaging mode → **switch `--onefile` → `--onedir`** (recommended)
`--onefile` re-unpacks the whole OCCT payload to a temp dir on *every* launch →
slow, heavy first compile. `--onedir` ships a folder Tauri bundles as resources;
far faster cold start. Confirm during Phase 5.

---

## 4. Phased plan

### Phase 0 — De-risk the Mac sidecar (SPIKE, blocks everything Mac) · ~2-4 days
The single biggest unknown. PyInstaller can't cross-compile and OCP/OCCT ships
native dylibs that `--collect-all OCP` can miss.
- [ ] On an Apple-Silicon Mac: `pip install -r b123d_server/requirements.txt pyinstaller`, run `python b123d_server/build_sidecar.py`.
- [ ] Boot the frozen binary standalone (`./b123d_server-aarch64-apple-darwin 7823`), hit `/health`, run one real `/execute`. Confirm OCP dylibs resolve (no `dlopen` failures).
- [ ] Repeat on x86_64 (Intel Mac or `--target` via Rosetta) — decide universal binary vs. two arch builds.
- **Exit criteria:** frozen kernel produces a GLB on both arches. If dylib hell appears, fall back to `--onedir` + manual `--add-binary` of the OCP `.dylib`s.

### Phase 1 — Mac build wired into Tauri · ~2-3 days
- [ ] Verify `ensure-sidecar.js` + `lib.rs` sidecar discovery work for the Mac target triple (`aarch64-apple-darwin` / `x86_64-apple-darwin`). Code is already triple-aware (`dev_sidecar_path`).
- [ ] `npm run tauri:build` on macOS → produces a `.app` / `.dmg`.
- [ ] Smoke: launch `.app`, confirm sidecar boots, design a part end-to-end.

### Phase 2 — Make mandatory cloud auth + sync work in the native shell · ~1-2 weeks
*(NOT decoupling from the cloud — adapting it to the desktop shell.)*
- [ ] **Desktop OAuth:** Supabase magic-link/OAuth redirect today targets a web
  origin (`.env.example` redirect notes). Add a deep-link scheme
  (`com.paraform.app://auth`) or localhost-loopback callback so sign-in
  completes inside the app. Email/password works as-is.
- [ ] **Keep the gate mandatory** in native: `VITE_REQUIRE_AUTH=1` for desktop
  builds; the studio gate (`App.svelte`) must require a signed-in session before
  the studio loads. Handle "session expired / no network" with a clear re-auth
  prompt rather than a silent offline mode.
- [ ] **Cloud-primary save:** confirm the Supabase document sync
  (`cad_documents`) is the source of truth on desktop; surface explicit **local
  save** (export/import of `.paraform.json`) as the fallback path.
- [ ] **Uncap local compiles:** `auth_gate.py` should not meter the bundled
  local kernel (bake `REQUIRE_AUTH=0`/loopback-trust into the frozen build) —
  the account is still mandatory at the app level, but local OCCT isn't capped.
- [ ] **AI key path:** decide BYO-key (default) vs. hosted fallback (signed-in
  Pro). Ollama/local-model base URL already documented in `.env.example`.
- [ ] **Billing in-app:** Stripe Checkout opens in the system browser, returns
  via deep-link; `profiles.plan` gates storage/AI tier (per D2 sub-decision).

### Phase 3 — Code signing + notarization · ~3-5 days + accounts
- [ ] **Apple:** enroll Apple Developer Program ($99/yr). Sign `.app` **and the embedded sidecar Mach-O + every OCP dylib** with hardened runtime; notarize + staple. This is the fiddly part — every binary inside the bundle must be signed. Configure in `tauri.conf.json` `bundle.macOS` + env (`APPLE_*`).
- [ ] **Windows:** acquire a signing cert (Azure Trusted Signing ~$10/mo, or OV cert ~$200-400/yr). Sign the `.exe`/installer so SmartScreen stops warning. Configure `bundle.windows.signCommand`.
- [ ] Verify a *downloaded* (not locally-built) artifact passes Gatekeeper + SmartScreen on a clean machine.

### Phase 4 — Auto-update + release CI · ~4-6 days
- [ ] Add `tauri-plugin-updater`; generate + secure the update signing key.
- [ ] Release feed: GitHub Releases (or S3) hosting signed `latest.json` + artifacts.
- [ ] Extend `.github/workflows/ci.yml` with a `release` job: matrix `windows-latest`, `macos-14` (arm), `macos-13` (intel); each builds its own sidecar (Phase 0/1), signs (Phase 3), uploads. Tag-triggered.
- [ ] In-app "update available" prompt.

### Phase 5 — Packaging polish + first-run perf · ~1 week
- [ ] Apply D3 (`--onedir`) and measure cold-start + first-compile on a clean machine.
- [ ] App-size audit (OCCT makes the payload hundreds of MB) — trim PyInstaller includes, confirm DMG/MSI/NSIS sizes are acceptable.
- [ ] Installer cosmetics: real icons (already referenced in `tauri.conf.json`), DMG background, license screen, file associations for `.paraform.json` (open-with).
- [ ] Crash/log surface: ship logs to a user-visible location for support.

### Phase 6 — Web: pause (no code change) · ~0.5 day
- [ ] Stop treating web as a shipping surface; landing/pricing point to native downloads.
- [ ] Leave the web studio code dormant — **do not delete.** No refactor.

---

## 5. Risks & unknowns (where estimates blow up)

1. **Mac OCP/OCCT dylib bundling (HIGH).** Could be 2 days or 2 weeks. Phase 0 exists to find out *first*.
2. **Notarizing a bundle embedding a heavyweight Python binary (MED-HIGH).** Apple's hardened-runtime requirement vs. PyInstaller + OCP dylibs is a known snag.
3. **Desktop OAuth round-trip (MED).** Deep-link/loopback callback + token refresh in a non-browser shell; "session expired, no network" UX since we're not offline-tolerant.
4. **App size + cold start (MED).** Mitigated by `--onedir` (D3).
5. **Pricing redesign once compute is free (LOW, product).** Gated D2 sub-decision; not technical.

---

## 6. Cost summary

- **Engineering:** ~4-8 focused weeks, dominated by Mac sidecar bring-up + signing + desktop-OAuth, **not** application porting.
- **Recurring $:** Apple Developer $99/yr + Windows signing ~$120-400/yr + CI minutes (incl. a Mac runner). Cloud (Supabase/Stripe) stays as-is.
- **Savings unlocked:** hosted-kernel compute → ~$0; removes the scalability ceiling that justified compile caps.

---

## 7. Definition of done

- [ ] Signed + notarized installers for Windows (.msi/.exe) and macOS (.dmg, arm64 + x86_64) download and launch clean on machines that never had the toolchain.
- [ ] Kernel runs **locally**; local compiles are uncapped and fast.
- [ ] **Mandatory sign-in** works in the native shell; projects save to the cloud with a local-save fallback.
- [ ] Auto-update delivers a new signed release end-to-end.
- [ ] Web left dormant (paused, not deleted).

---

## 8. Immediate next steps

> Decision: **plan only for now** — no code changes yet. When green-lit, start with:

1. Schedule the **Phase 0 Mac spike** — the one thing that needs hardware and
   de-risks the whole effort.
2. Phase 2 groundwork that's platform-independent and safe to start early:
   desktop deep-link OAuth callback, and baking loopback-trust into the bundled
   sidecar so local compiles are uncapped while auth stays mandatory.
3. Settle the D2 pricing sub-decision (what Pro unlocks) before Phase 3 billing.
4. Draft the Phase 4 GitHub Actions `release` matrix (writable now, runs once
   Phase 0/1/3 land).
