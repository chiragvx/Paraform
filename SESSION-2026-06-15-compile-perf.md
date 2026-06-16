# Session — Compile / edit-loop performance pass (2026-06-15)

Branch: `step-timeline-upgrade`
Commits: `0d84c7d` (Tiers 1a/1b/2), `28232b2` (Tier 3 safe slice)
Status: **build clean, full document suite passes (0 failed)**

---

## The complaint

> "When I click to hide a layer, it takes 3–5 seconds, then hides it, then the
> same time to unhide." — reported repeatedly for ~a week.

## The misdiagnosis (recorded so we don't repeat it)

The first instinct was to treat this as a *kernel* limitation — the build123d /
OCCT server runs every compile serialized behind a single `_kernel_lock`, so we
explored process pools, parallel DAG compile, WASM/OCP.wasm, stateful sessions.
**All irrelevant to the reported symptom.** Hiding a layer should never touch the
kernel at all.

Lesson (also saved as a memory): when a user names a concrete slow interaction,
**trace that exact click handler to the bottom before theorizing about
architecture.** The reported symptom is the spec.

## Root cause

The eye/"hide" button was wired to feature **suppression**, not visibility:

```
Sidebar eye click
  → toggleVisible()
  → setFeatureEnabled(id, …)           // operations.js
  → commit(setEnabledChange)            // mutates the DOCUMENT MODEL
  → emit.js skips !enabled features      // EMITTED PYTHON CHANGES
  → full kernel recompile (POST /execute) ≈ 3–5 s
  → new GLB → full client scene rebuild
```

So "hide" meant "delete this feature from the build and recompile the whole
model," each way. It was the most visible symptom of three compounding problems.

## The three compounding problems

1. **Recompile trigger keyed on the wrong thing.** `bridge.js` decided whether to
   recompile from a human-readable label string, filtering only `'select'` /
   `'refs'`. Every other change recompiled — including ones that emit
   *byte-identical* Python (rename, recolor, reorder, metadata).
2. **Incremental compiler built but switched off.** Phase G4 (`dep_hash.js`,
   `_wrapCheckpoint`, server `_ckpt_get/_ckpt_put`) was fully implemented but the
   live path called `emitDocument` with `incremental` defaulting `false`, so every
   edit re-emitted the whole document and the result cache (keyed on the full code
   string) missed on any single-feature change → full OCCT recompile.
3. **Client rebuilds the whole scene every compile.** `_clearRoot()` disposes
   everything and `EdgesGeometry` (the bridge's own "dominant cost on the render
   hot path") walks every triangle of every body — ~250–800 ms on low-end, even on
   a cache hit.

The key insight: for a small edit the OCCT math is *milliseconds*; the 3–5 s is
overhead (full re-emit + remote round-trip + GLB/base64 + full scene rebuild).
Overhead is deletable.

---

## What shipped

### Tier 1a — Hide = render flag, not suppression  (`0d84c7d`)
- `runtime.svelte.js`: `hiddenBodies` ($state Set) + `toggleBodyVisible` /
  `isBodyHidden` / `setBodyHidden`.
- `bridge.js`: `applyHiddenBodies(set)` + `_reapplyHiddenBodies()` — toggles
  `mesh.visible` by `userData.featureId`, re-applied at the tail of every rebuild
  so visibility survives recompiles. **No kernel call, no re-emit — instant.**
- `Sidebar.svelte`: eye button now reflects/toggles hidden state; **Suppress stays
  on the right-click context menu** (the legitimate model-edit path).
- `Viewport.svelte`: `$effect` pushes `studio.hiddenBodies` into the bridge.
- `app/v4_panel/feature_tree.js`: same split (eye → visibility, suppress → menu).

### Tier 1b — Skip the whole apply when emitted code is unchanged  (`0d84c7d`)
- `bridge.js`: fingerprints emitted code (`deflection|len|cyrb53`, matching the
  executor's cache key) and, when it equals the last *successfully applied* hash,
  skips the executor call **and** the scene rebuild. Hash set only on success,
  invalidated on error; a deflection/tessellation change still forces a rebuild.
- Effect: rename / recolor / reorder / metadata now cost ≈ 0.

### Tier 2 — Activate the dormant G4 incremental compile  (`0d84c7d`)
- `executor.js`: live path now emits with `incremental: true`. Each body is wrapped
  in `_ckpt_get/_ckpt_put` guards keyed by a dep-hash; the **server reuses unchanged
  BREP bodies** and recomputes only the edited feature + its downstream.
- Verified safe: an upstream change folds into every downstream dep-hash, so we can
  never serve stale geometry. `incremental.mjs` + `dep_hash` tests pass.
- Known latent gap (not currently reachable): a few emitters read axis/plane via
  `f.inputs.* || f.params.*`; the dep-hash folds `params` but not a raw `inputs`
  literal. No typed op writes literal geometry to `inputs` today, so it's safe — but
  if one ever does, fold `f.inputs` into the hash.

### Tier 3 (safe slice) — Memoize EdgesGeometry  (`28232b2`)
- `bridge.js`: cache the edge `BufferGeometry` by a content hash (cyrb53 over the
  full position + index byte buffers + counts). On a hit, a fresh `LineSegments`
  shares the cached geometry; on a miss/empty geometry, build fresh as before.
- Disposal lifecycle (the trap): cached geoms tagged `userData.__edgeCached`;
  `_clearRoot` skips disposing them; LRU (cap 64) only frees entries **not**
  referenced in the current build; `dispose()` frees the cache on teardown.

### Tier 3 (risky half) — deliberately NOT done
Grafting whole unchanged *meshes* across rebuilds. The kernel ships one monolithic
GLB and per-body descriptor tagging leans on the fragile depth heuristic that has
caused mis-tagging before — a partial graft risks ghost/stale meshes. A correct
full mesh rebuild beats a fast wrong one. The edge memoization captures most of the
win without the risk.

---

## Files touched
- `lib/document/bridge.js` — applyHiddenBodies, code-fingerprint skip, edge memo
- `lib/document/executor.js` — `incremental: true`
- `src/lib/studio/runtime.svelte.js` — hiddenBodies + toggles
- `src/lib/components/studio/Sidebar.svelte` — eye → visibility
- `src/lib/components/studio/Viewport.svelte` — visibility effect
- `app/v4_panel/feature_tree.js` — eye → visibility, suppress → menu

## Net effect
- **Hide / show**: 3–5 s → instant.
- **Cosmetic edits** (rename/color/reorder/metadata): full recompile → ≈ 0.
- **Real geometry edits**: kernel recomputes only the changed subtree; client
  reuses unchanged edges. Markedly snappier, especially on low-end.

---

## Deferred — the bigger "truly interactive" bets
For sub-100 ms, drag-the-slider-and-it-moves interactivity (none started; each is a
real architecture commitment, pick by where users actually are):
1. **In-browser WASM kernel** (OCP.wasm) — zero network round-trip, offline; 30–60 MB
   cold start, two kernels must stay geometry-identical.
2. **Warm stateful kernel session** — server holds the live model in memory, applies
   only the dirty subtree, streams back changed bodies; native speed, RTT remains.
3. **Instant-drag draft preview** — recompute only the dragged feature at draft
   tessellation and patch just that body; full compile on release.

See memories `project_compile_interactivity_perf` and
`feedback_diagnose_reported_symptom`.
