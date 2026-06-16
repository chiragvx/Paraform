# PLAN — 100% On-Device Native App (Windows + macOS)

**Status:** proposed · **Owner:** Chirag · **Created:** 2026-06-17
**Goal:** Make the native desktop app the *product*, not a second surface.
Ship a signed, notarized, auto-updating Windows + macOS app where the CAD
kernel runs locally, compiles are unlimited and free, and the cloud is
optional (sync/accounts), not load-bearing.

> **Why this is mostly a packaging job, not a rewrite.** The Tauri shell
> (`src-tauri/`), the Rust sidecar lifecycle (`src-tauri/src/lib.rs` — spawns
> the kernel on `127.0.0.1:7823`, kills it on exit), the PyInstaller freeze of
> the whole kernel (`b123d_server/build_sidecar.py`), and the self-bootstrap
> (`scripts/ensure-sidecar.js`) already exist and have compiled on Windows. The
> AI proxy, auth gate, and billing are registered on the *same* Flask app
> (`b123d_server/server.py:42-57`) that gets frozen, so desktop already has a
> self-contained backend. The remaining work is the *shipping last mile* +
> deciding what "100% on-device" means for accounts and revenue.

---

## 1. North star

A creator downloads one installer, double-clicks, and is designing functional
machines offline within seconds — no tunnel, no hosted kernel, no sign-in wall,
no per-day compile caps. Their own CPU does the OCCT work; their own API key
(or a local model) does the AI. Cloud sign-in exists only to sync projects
across their machines.

This is the right long-term bet because it removes the two costs that cap
scalability today:

- **Server-side OCCT compute** — every compile currently can hit a hosted
  kernel (`VITE_ENGINE_URL` / HF Space). On-device, compute scales with users'
  own hardware → marginal cost ≈ $0.
- **Metered SaaS friction** — daily caps (`b123d_server/auth_gate.py`) exist to
  bound that compute cost. Remove the hosted compute and the caps lose their
  reason to exist; the product gets faster *and* cheaper to run.

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
| Windows dev build compiled | ✅ verified | `src-tauri/target/debug/` fingerprints present |
| **macOS sidecar build** | ❌ not done | needs a Mac — PyInstaller can't cross-compile |
| **Code signing (Win + Mac)** | ❌ not done | no certs, no notarization step |
| **Auto-update** | ❌ not done | no updater plugin / release feed |
| **Local-first auth/licensing** | ⚠️ partial | login is *mandatory* when Supabase configured (`VITE_REQUIRE_AUTH`), caps are server-enforced |
| **Release CI (3 OS matrix)** | ❌ not done | `ci.yml` is tests-only, ubuntu-only |

---

## 3. Strategic decisions to lock before building

These change *what* we build, so they gate Phase 2+. Recommendations in **bold**.

### D1 — What happens to the web app?
- **(Recommended) Web → marketing + trial only.** Keep `#/`, `#/pricing`, a
  read-only or watermarked browser demo. The studio product is native. Lowest
  risk, preserves SEO/funnel.
- Full sunset: delete the web studio path entirely. Cleaner but throws away the
  zero-install top-of-funnel.

### D2 — Accounts & monetization once compute is free/local
The current model (Stripe Pro unlocks higher *server* caps) is meaningless when
the kernel is local. Options:
- **(Recommended) Local-first, optional account.** App runs fully without
  sign-in (BYO AI key or local model). Sign-in unlocks **cloud project sync**
  across devices. Monetize Pro as a one-time/subscription unlock for
  *sync + hosted AI fallback keys + premium part libraries* — validated by a
  thin license check, not by gating the kernel.
- Keep hosted AI as the paid hook: app is free + local, Pro = "use our managed
  AI keys without bringing your own."
- Pure offline, no accounts at all (simplest; drops sync + recurring revenue).

### D3 — PyInstaller packaging mode
- **(Recommended) Switch `--onefile` → `--onedir`.** `--onefile` re-unpacks the
  whole OCCT payload to a temp dir on *every* launch → slow, heavy first
  compile. `--onedir` ships a folder Tauri bundles as resources; far faster cold
  start. Trade-off: bundle is a directory, not one file (fine inside an
  installer).

> I'll surface D1/D2 as a question after this plan so Phase 2 is unblocked.

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

### Phase 2 — Decouple from mandatory cloud (local-first) · ~1-2 weeks
*(gated on D1/D2)*
- [ ] Make sign-in genuinely optional in desktop: default `VITE_REQUIRE_AUTH=0` for native builds; the studio gate (`App.svelte`) must allow a full offline session. (`session.svelte.js` already boots non-blocking.)
- [ ] Remove/neutralize server caps for the local kernel: `auth_gate.py` should no-op when the kernel is the bundled sidecar (e.g. `REQUIRE_AUTH=0` baked into the frozen build / detect loopback caller). Compiles + AI become uncapped locally.
- [ ] Default AI to **bring-your-own-key / local model** (Ollama base URL already documented in `.env.example`). Hosted-key fallback becomes a signed-in Pro convenience, not the default.
- [ ] Re-target Supabase auth for desktop: OAuth via deep-link scheme (`com.paraform.app://`) or localhost loopback instead of web-origin redirect (`.env.example` redirect notes). Email/magic-link works as-is.
- [ ] Recast billing: Stripe Checkout opens in the system browser, returns via deep-link; `profiles.plan` gates *sync/AI-fallback*, not the kernel.
- [ ] Storage stays local-first (already: `.paraform.json` changelog-fold + library local mirror). Cloud sync becomes opt-in on sign-in.

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

### Phase 6 — Web repositioning (gated on D1) · ~2-4 days
- [ ] Landing/pricing point to native downloads.
- [ ] Web studio becomes trial/demo or is retired; remove the hosted-kernel/tunnel default from `index.html` if web studio is dropped.

---

## 5. Risks & unknowns (where estimates blow up)

1. **Mac OCP/OCCT dylib bundling (HIGH).** Could be 2 days or 2 weeks. Phase 0 exists to find out *first*.
2. **Notarizing a bundle embedding a heavyweight Python binary (MED-HIGH).** Apple's hardened-runtime requirement vs. PyInstaller + OCP dylibs is a known snag.
3. **App size + cold start (MED).** Mitigated by `--onedir` (D3).
4. **Auth/licensing redesign (MED).** Mostly product/business work, not technical; gated on D2.
5. **No more server-side usage telemetry/caps (LOW, by design).** Abuse vector shifts to "they use their own compute," which is fine.

---

## 6. Cost summary

- **Engineering:** ~4-8 focused weeks, dominated by Mac sidecar bring-up + signing, **not** application porting.
- **Recurring $:** Apple Developer $99/yr + Windows signing ~$120-400/yr + CI minutes (incl. a Mac runner).
- **Savings unlocked:** hosted-kernel compute → ~$0; removes the scalability ceiling that justified daily caps.

---

## 7. Definition of done

- [ ] Signed + notarized installers for Windows (.msi/.exe) and macOS (.dmg, arm64 + x86_64) download and launch clean on machines that never had the toolchain.
- [ ] Kernel runs locally; compiles + AI work fully **offline** with no caps.
- [ ] Optional sign-in syncs projects; the app is fully usable without it.
- [ ] Auto-update delivers a new signed release end-to-end.
- [ ] Web is repositioned per D1.

---

## 8. Immediate next steps (executable now, no Mac required)

1. Resolve **D1/D2** (auth + web fate) — gates Phase 2.
2. Phase 2 groundwork that's platform-independent: make native auth optional +
   bake `REQUIRE_AUTH=0` into the bundled sidecar so local compiles/AI are
   uncapped (`auth_gate.py`, `tauri.conf.json` env, `session.svelte.js`).
3. Draft the Phase 4 GitHub Actions `release` matrix (can be written now, runs
   once Phase 0/1/3 land).
4. Schedule the **Phase 0 Mac spike** — the one thing that needs hardware and
   de-risks the whole effort.
