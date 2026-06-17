# Desktop (Windows) build & release guide

How to build, sign, and ship the ParaForm Windows app. The app bundles the
build123d kernel as a local sidecar and is **cloud-primary** (mandatory
sign-in, projects sync to Supabase). See [PLAN-windows-app.md](../PLAN-windows-app.md).

---

## 1. Prerequisites (one-time)

- **Rust** (stable, MSVC host) — https://rustup.rs
- **Node 20+** and **Python 3.11**
- Python kernel deps: `pip install -r b123d_server/requirements.txt`
  (includes `pyinstaller`, used to freeze the sidecar)
- `npm ci`

## 2. Build a local installer

```bash
npm run sidecar:build     # freeze the kernel → src-tauri/binaries/ (~159 MB, ~5 min)
npm run tauri:build       # vite build + Rust release + NSIS → setup.exe
```

Output: `src-tauri/target/release/bundle/nsis/ParaForm_<ver>_x64-setup.exe`.

> **The post-build geometry probe is the validation gate.** After rebuilding the
> sidecar, boot it and POST a `Box` to `/execute`; it must return GLB bytes.
> Freezing OCCT/build123d is fragile (missing native DLLs only fail at runtime).
> The known excludes/includes are encoded in `b123d_server/build_sidecar.py`.

## 3. Production frontend env (baked at build time)

The shipping desktop build is **cloud-primary**, so it must bake real Supabase
credentials. Provide these as env vars (e.g. a `.env`, or CI secrets) before
`npm run tauri:build`:

| Var | Value |
|---|---|
| `VITE_SUPABASE_URL` | your Supabase project URL |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | the anon/publishable key |
| `VITE_REQUIRE_AUTH` | `1` (desktop ignores `0` anyway — auth is mandatory) |
| `VITE_ENGINE_URL` | **leave UNSET** — desktop resolves to its bundled sidecar at `127.0.0.1:7823` |

If Supabase is unset, the build runs but with auth **open** (dev/testing only —
do not ship that).

## 4. Desktop sign-in (deep-link OAuth) — Supabase + provider setup

The native app can't use a web redirect, so it uses the custom scheme
`paraform://auth-callback` (`src/lib/auth/desktop_oauth.js`). For sign-in to
complete, configure:

1. **Supabase → Authentication → URL Configuration → Redirect URLs:** add
   `paraform://auth-callback` (keep the web origins for the browser build).
2. **GitHub OAuth** (if used): the GitHub OAuth App callback stays
   `https://<project-ref>.supabase.co/auth/v1/callback` (unchanged — Supabase
   brokers it, then redirects to the scheme).
3. Magic-link email also redirects to `paraform://auth-callback`.

The scheme is registered by the NSIS installer (declared in
`tauri.conf.json → plugins.deep-link`) and at runtime for the dev path.

## 5. Auto-update (updater plugin)

- Endpoint + public key live in `tauri.conf.json → plugins.updater`. Releases
  publish a `latest.json` the app polls on startup
  (`src/lib/updater/check.js`).
- **Signing key:** generated once with
  `npm run tauri signer generate -w src-tauri/.tauri-updater.key` (gitignored).
  - The **public** key is committed in `tauri.conf.json`.
  - The **private** key + password go in CI secrets `TAURI_SIGNING_PRIVATE_KEY`
    / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. For a local release build, export
    the same env vars.
  - ⚠️ For a real public release, **regenerate** the keypair securely (the local
    dev key has an empty password) and update the committed pubkey.
- `bundle.createUpdaterArtifacts: true` makes the build emit the signed
  `.sig` + `latest.json`. **A build without the private key in env will fail** —
  export it, or unset this flag for an unsigned local smoke build.

## 6. Code signing (Windows) — removes the SmartScreen warning

Without a cert, downloaded installers trigger SmartScreen. Two options:

- **Azure Trusted Signing (recommended, ~$10/mo):** add a
  `bundle.windows.signCommand` that invokes the Azure signing tool, or use the
  `azure/trusted-signing-action` step in the release workflow.
- **OV/EV cert (.pfx):** set `WINDOWS_CERTIFICATE` (base64) +
  `WINDOWS_CERTIFICATE_PASSWORD` secrets and wire `bundle.windows.certificateThumbprint`
  / a sign command.

EV certs build SmartScreen reputation immediately; OV certs warn until reputation
accrues. **Acceptance:** a *downloaded* (not locally built) installer installs
clean on a machine that never had the toolchain.

## 7. Release (CI)

`.github/workflows/release.yml` builds + publishes a **draft** GitHub Release on a
`v*` tag. Required repo secrets:

- `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (updater)
- `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`
- (W3) Windows code-signing secrets once a cert exists

To cut a release: `git tag v0.1.0 && git push origin v0.1.0`, then publish the
drafted release. The job always rebuilds the sidecar from source.

## 8. Known notes

- Sidecar is `--onefile` (re-extracts to temp on each launch). If cold start is
  too slow, switch `build_sidecar.py` to `--onedir` and bundle the folder as
  `resources` (changes the `externalBin` spawn path in `src-tauri/src/lib.rs`).
- File association for project files is intentionally **not** wired: projects are
  cloud-primary and local save uses `<name>.paraform.json` (a `.json` tail that
  would hijack all JSON files if associated).
- macOS is deferred (see PLAN-on-device-native.md). The bundle id is
  `com.paraform.studio` (the old `.app` suffix conflicted with the macOS bundle
  extension).
