# Foundation 1 — Browser smoke harness

> **Status (2026-06-06):** ✅ harness MVP landed in commit
> ([83aaa31](https://github.com/.../commit/83aaa31)'s successor). Boots
> vite + Chromium, test hook on `window.__paraform__` works, 32 cases
> across 6 families written. Runs via `npm run test:smoke`. **Kernel
> required** — see [tests/smoke/harness.mjs](../tests/smoke/harness.mjs)
> header for the `VITE_ENGINE_URL=http://localhost:7823` invocation.
> Without a kernel the harness self-detects: render-dependent cases time
> out, sketch enter/cancel passes.
>
> **CI gate (2026-06-07):** GitHub Actions workflow at
> [.github/workflows/ci.yml](../.github/workflows/ci.yml) runs three jobs
> on every push + PR:
> - `js-tests` — `npm test` aggregator + 9 explicit zero-dep suites
>   (migration / components / component_ops / picker / expression /
>   measure / standard-parts / DFM checks + runner) + `vite build`.
> - `python-tests` — `pytest b123d_server/__tests__` (covers naming
>   corpus, measure, standard_parts).
> - `smoke` — spawns Python kernel, waits on `/health`, runs `npm run
>   test:smoke` against it with `VITE_ENGINE_URL=http://localhost:7823`.
>   Playwright Chromium installed with `--with-deps`.
>
> Once green, ✅ markers across TRACKER can be honest "passes smoke" not
> just "compiles + agent-wired."



> Phase 1 of [TRACKER.md](../TRACKER.md). Strategy rationale in
> [STRATEGY.md](../STRATEGY.md) §F1.

## TL;DR

Playwright-based scripted run that exercises every shipped ✅ feature
end-to-end and asserts on real geometry output (bbox / body count /
mass / manifoldness). Today every ✅ in TRACKER.md is really 🧪 — this
flips the meaning of ✅ to "passes smoke." Same infra becomes the AI
eval substrate when the repair loop arrives (Phase 2).

## Why foundation

Without this, the tracker lies to us. v0.23 through v0.27 shipped ~50
new UI surfaces and ~30 new kernel ops, and nothing has been clicked
end-to-end against the live kernel. Any prioritization off the tracker
is risky until ✅ means "works."

It's also a precondition for the eval harness in Phase 2: the AI
generate→measure→repair loop measures the same kinds of properties
(bbox, mass, manifoldness, hole positions) that smoke tests assert on.
Building the assertion library once pays off twice.

## Current state

- `playwright ^1.60.0` is already in [package.json](../package.json)
  devDependencies — no new install needed.
- `lib/document/__tests__/*.mjs` has a Node-only unit suite (run via
  `npm test`); none of it touches a browser.
- `scripts/ui_validate.mjs` exists and is invoked via `npm run
  ui:validate` — verify what it does before writing parallel scaffolding.
- No browser smoke harness exists.

## Scope

**In:**
- Playwright runner that spins up the vite dev server (or the prebuilt
  `dist/`) and a headless Chromium.
- A small DSL for "open studio, run command palette command X, assert
  on document state Y" so each test is ~10 lines.
- Assertions hook: read `studio.bridge.geometry` (the kernel-emitted
  topology + body group) and assert on bbox / body count / manifold /
  named feature presence.
- Coverage of every Phase-0 ✅ in TRACKER.md: primitives, sketch entry,
  extrude, revolve, booleans, modifiers, patterns, transforms,
  import/export round-trip on .glb.
- CI step (GitHub Actions or whatever the project uses) that gates
  commits on green smoke.

**Out:**
- Image-diff / visual regression. Pure structural assertions only —
  geometric assertions survive cosmetic UI changes, image diffs don't.
- Kernel-side tests (those live under `lib/document/__tests__/` and
  `b123d_server/__tests__/`).
- AI evals — those build *on* this infra in Phase 2.

## Dependencies

- None. This is the first item — everything else gains credibility
  from it.

## Critical files

- New: `tests/smoke/harness.mjs` — Playwright bootstrap, dev-server
  lifecycle, the DSL.
- New: `tests/smoke/cases/*.mjs` — one file per shipped feature
  family. Start with `primitives.mjs`, `sketch.mjs`, `booleans.mjs`,
  `patterns.mjs`, `modifiers.mjs`, `import-export.mjs`.
- New: `tests/smoke/asserts.mjs` — shared assertion library:
  `assertManifold`, `assertBodyCount`, `assertBBoxMm`,
  `assertFeaturePresent`, `assertNoKernelError`.
- Modify: [package.json](../package.json) — `"test:smoke": "node
  tests/smoke/runner.mjs"`.
- Maybe: [.github/workflows/*.yml] — CI step.

## Acceptance

- `npm run test:smoke` boots the dev server, runs the suite, exits 0.
- Every ✅ in TRACKER.md is exercised by at least one assertion.
- One deliberately-broken commit causes the suite to exit non-zero
  with a useful error.
- Each case runs in <15s on the dev server; full suite in <5min.
- After landing, flip every ✅ in TRACKER.md to either
  ✅ (verified) or downgrade to 🟡 (failed smoke) with a note.

## Open questions

- Live kernel URL or mock? The cloudflare kernel URL in
  [index.html:19](../index.html#L19) is the simplest path but
  introduces network flake. A local `python b123d_server/server.py`
  + `VITE_ENGINE_URL=http://localhost:7823` is more hermetic.
  Recommendation: local kernel in CI, cloudflare allowed for dev runs.
- Where does the asserted topology come from? Either (a) inject a JS
  hook that exposes `studio.bridge` to the test runner via
  `window.__paraform_test__`, or (b) read the kernel's response JSON
  directly via a Playwright network intercept. (a) is simpler and
  doesn't depend on the wire format being stable.

## Effort

3–5 days for a 12-case suite + CI wiring. Most of the cost is the
local-kernel-in-CI setup and reading the existing UI commands to
script their flows.
