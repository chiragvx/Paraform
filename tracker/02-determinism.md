# Foundation 2 — Determinism baseline

> **Status (2026-06-06):** ✅ kernel-version baseline landed. `/version`
> endpoint live; `kernelVersion` attached to every `/execute` response
> (success and error paths); bridge exposes `lastKernelVersion`; docs
> persist + warn on mismatch in StatusBar. **LLM seed/temperature
> capture deferred** — wires in when the AI emit path lands per Phase 2.
> Next: pinned-version mismatch in CI fails the smoke run.



> Phase 1 of [TRACKER.md](../TRACKER.md). Strategy rationale in
> [STRATEGY.md](../STRATEGY.md) §F5.

## TL;DR

Pin build123d + OCCT versions per part. Capture LLM seed +
temperature alongside the prompt. Version the *generator inputs* (not
just the document). Without this the eval harness in Phase 2 measures
noise.

## Why foundation

Eval credibility depends on this. Without pinned kernel + captured
seed, the same prompt can produce different geometry across runs and
we can't distinguish "model regression" from "kernel version bump."
Lightweight scope; large downstream consequence.

The corpus from Foundation 1 also assumes determinism — if `npm run
test:smoke` produces different bodies for the same primitive call
across kernel versions, every assertion needs a tolerance band the
size of the variation.

## Current state

- `b123d_server/build_sidecar.py` packages the kernel for distribution
  but doesn't pin OCCT version explicitly. The Python deps come from
  whatever `pip install -r requirements.txt` resolves at build time.
- `package.json` pins `build123d` via the Python sidecar, not the JS
  side — there is no JS-level kernel version reference.
- The bridge timing instrumentation landed in v0.26
  ([lib/document/bridge.js](../lib/document/bridge.js) lastCompileMs /
  lastRenderMs) but doesn't capture the kernel version that produced
  the geometry.
- No LLM is invoked yet — no seed capture machinery exists.
- The document store (`store.toJSON`) serializes the feature timeline
  but doesn't record the kernel version that produced the saved
  bodies. Reload across kernel versions silently rebuilds with the
  new one.

## Scope

**In (now):**
- Pin OCCT + build123d to specific versions; record them in a
  `b123d_server/VERSIONS.json` or environment endpoint.
- Add a `/version` endpoint on the kernel that returns build123d +
  OCCT versions, a build hash, and a wire-format version.
- Capture the version into every kernel response (in the existing
  `/execute` payload — add a `kernelVersion` field).
- Bridge writes the version into `studio.bridge.kernelVersion` for the
  UI to display in StatusBar / settings → Presets.
- Document store serializes `kernelVersion` alongside the feature
  timeline; on reload, if the local kernel disagrees, surface a
  warning chip.

**In (when the LLM lands):**
- Capture seed + temperature + model id + system-prompt hash on every
  AI generation. Store on the feature that produced it.
- Re-derive: same seed + same temperature + same prompt + same model
  + same kernel version → same geometry. Make this an invariant the
  eval harness can check.

**Out:**
- Fully reproducible *floating-point* determinism across CPUs (OCCT
  doesn't guarantee this; downstream we accept bbox tolerance bands).
- Build-environment determinism (different glibc → minor OCCT drift).
  Pin the build image instead and accept the tolerance.

## Dependencies

- Foundation 1 (smoke harness): the harness wants to know what kernel
  version it ran against to report failures usefully.
- No hard dependency on the others.

## Critical files

- New: `b123d_server/VERSIONS.json` — explicit pins.
- Modify: `b123d_server/server.py` — add `/version` endpoint;
  include `kernelVersion` in `/execute` response.
- Modify: [lib/document/kernel_client.js](../lib/document/kernel_client.js) — surface version on the
  client; expose on bridge.
- Modify: [lib/document/bridge.js](../lib/document/bridge.js) — store `kernelVersion` as
  a read-only field alongside `lastCompileMs`.
- Modify: [lib/document/store.js](../lib/document/store.js) `toJSON` / `fromJSON` — persist +
  warn on mismatch.
- Modify: [src/lib/components/studio/StatusBar.svelte](../src/lib/components/studio/StatusBar.svelte) — small
  version chip.
- Later (LLM): a `paraform_v4_document.generation` field carrying
  `{ model, seed, temperature, promptHash }`.

## Acceptance

- `curl http://localhost:7823/version` returns a stable JSON object.
- A round-tripped document (save → reload → save) carries the same
  `kernelVersion`.
- Loading a doc saved with a different kernel surfaces a UI warning
  with the version delta.
- Foundation 1's smoke harness fails loudly if `/version` changes
  mid-run.

## Open questions

- How strict is the mismatch warning? Block reload (hard) or warn-and-
  continue (soft)? Recommendation: soft for v1 — most kernel bumps
  are backwards-compatible at the feature-emit level.
- Do we version the *naming.py* OP_TAGS table separately? Adding a new
  op tag without updating the JS side breaks queries silently per
  [NAMING_CONTRACT.md](../lib/document/NAMING_CONTRACT.md). Worth a
  per-table version stamp.
- Where does the build-image hash come from? Recommendation: `git
  rev-parse HEAD` of the b123d_server tree at build time, baked into
  the sidecar binary.

## Effort

2–3 days for the kernel-version pieces. LLM seed-capture is another
~1 day when the LLM path lands; defer.
