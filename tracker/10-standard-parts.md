# Phase 2.4 — Standard parts library v1

> **Status (2026-06-07):** ✅ landed. 148 catalog entries across 6 ISO
> tables: 73 SHCS (ISO 4762, M2-M16) + 10 hex nuts (ISO 4032) + 10
> threads (ISO 261) + 24 clearance holes (ISO 273) + 21 fits (ISO
> 286-2, H7/g6 + H7/h6 + H7/k6) + 10 bearings (608/6000/6200/625
> series). Builders: real geometric for screws + nuts (head/shank/
> socket + hex + bore); simplified for bearings (toroidal ball race,
> ball count out of scope). `GET /library` returns lightweight entries
> (privates stripped); `GET /library/<id>` returns the GLB. In-process
> cache, no eviction (148 × ~50KB ≈ 10MB ceiling). 11/11 JS client
> tests pass. LibraryDialog rewritten with Quickstart (12 originals)
> + kernel-sourced categories alphabetical. v1 limitation: insertion
> stub creates a BuildScript marker feature alongside the scene-only
> THREE.Group; a proper `StandardPart` feature type would round-trip
> through emit→kernel→cached GLB but is deferred.
>
> **Update (2026-06-07, commit c3c6c83):** v1 limitation **CLOSED**.
> `StandardPart` feature type ships; round-trips emit
> (`standard_parts.build_from_id` call site) → harness namespace
> façade (SimpleNamespace exposing `build_from_id` +
> `get_entry_public`) → cached GLB on the wire → bridge mounts like
> any other feature. Inserted parts survive reload, export, and
> compose with downstream features (Fillet on bolt heads, etc.).
> 27/27 standard-parts tests pass. Translation + per-axis rotation
> via `params.transform`. GLTFLoader/scene-attach retired.



> Phase 2 of [TRACKER.md](../TRACKER.md). Strategy: [STRATEGY.md](../STRATEGY.md) §A6.
> Dimensional backbone. **Necessary, not sufficient** — see strategy.

## TL;DR

Replace the 12 hand-built [library catalog](../src/lib/library/catalog.js)
entries with a real **standard-parts library** backed by exact spec
tables (ISO/UTS thread profiles, fastener dimensions, fit allowances,
bearing standards). The AI **selects** from it and never synthesizes
thread geometry. Pre-meshed server-side as GLB+JSON to sidestep the
browser-STEP-import problem.

## Why foundation

A6 from STRATEGY.md. Two facts the model must defer to lookup, not
imagination:
1. Standard fasteners have **exact** specifications: ISO 4762 M3 = 3 mm
   nominal, 0.5 mm pitch, 5 mm head diameter, etc. Off by 0.1 mm and
   it doesn't thread.
2. Engineering fits (H7/g6, etc.) follow ISO 286-2 tables. "Snug" is
   not a number; +0/-0.025 mm is.

The catalog provides *dimensional* accuracy. Application correctness
(right bolt for the joint, preload, edge distance) is a separate
problem — surfaced via assumptions manifest (09) and DFM checks (11).

## Current state

- [src/lib/library/catalog.js](../src/lib/library/catalog.js) — 12
  hand-built entries (Cube, L-Bracket, Box Enclosure, M3 Standoff,
  90° Corner Joiner, etc.). Each has a `build(v4)` function that
  calls `v4.addBox` / `v4.addCylinder` to compose geometry.
- [LibraryDialog.svelte](../src/lib/components/studio/LibraryDialog.svelte)
  renders cards with categories + search + "Insert" buttons.
- No spec data, no real standard parts, no thread geometry.

## Scope

**In:**
- Spec data (`b123d_server/standard_parts/`):
  - `iso_metric_screws.json` — M2 through M16 socket head cap screws
    (ISO 4762). Per size: nominal Ø, head Ø, head height, drive
    socket Ø, pitch, standard length list.
  - `iso_metric_nuts.json` — M2 through M16 hex nuts (ISO 4032).
  - `iso_metric_threads.json` — pitch, root Ø, profile depth.
  - `iso_metric_clearance.json` — close / medium / loose clearance
    holes per nominal size.
  - `iso_fits.json` — H7/g6 / H7/h6 / etc. tolerance bands.
  - `bearings_608.json` — 608/6000-series ball bearings (Ø, ID, OD,
    width).
- Server-side mesh generation (`b123d_server/standard_parts/build.py`):
  - Given a spec entry, produces a parametric build123d body via
    deterministic emit. Output: GLB + JSON metadata.
  - Pre-compile on kernel startup; cache in `b123d_server/cache/`.
- New `GET /library/<id>` endpoint serves the GLB + metadata.
- New `src/lib/library/standard.js` — JS client. Lists entries,
  fetches GLB on insert, parses via three's `GLTFLoader` into an
  imported feature (the same path as user CAD imports from v0.26).
- The inserted feature carries: `kind: 'standard-part'`,
  `spec: { standard: 'ISO 4762', size: 'M3x16', source: 'library' }`
  on its userData / metadata so DFM checks (11) and the AI (08) can
  reason about it later.
- LibraryDialog rewrite: real categories (Fasteners / Bearings /
  Inserts / Bushings), search across spec strings, per-entry preview
  thumbnail (generated alongside the GLB).

**Out:**
- Threaded modeled geometry (the GLB is the geometric truth; the
  thread is approximated as a smooth swept profile or a cosmetic
  helix depending on the entry).
- McMaster-Carr / Misumi catalog integration (requires their data
  feeds; future feature).
- Imperial fasteners (just ISO metric for v1).
- Application engineering — "is this the right M4 for this joint" is
  a separate problem.

## Dependencies

- F2 determinism — pre-compiled GLBs are pinned to the kernel
  version; library bust whenever VERSIONS.json bumps.
- 09 assumptions manifest — when the AI picks an M3, it records the
  source spec entry in the manifest.

## Critical files

- New: `b123d_server/standard_parts/{iso_metric_*.json, build.py,
  cache.py}`.
- Modify: `b123d_server/server.py` — `GET /library/<id>` + cache prep
  on startup.
- New: `src/lib/library/standard.js`.
- Modify: [src/lib/library/catalog.js](../src/lib/library/catalog.js) —
  collapse the hand-built entries; loader populates from the new
  endpoint.
- Modify: [LibraryDialog.svelte](../src/lib/components/studio/LibraryDialog.svelte)
  — real categories, real previews, real spec metadata in the card.

## Acceptance

- "Insert M3×16 ISO 4762 SHCS" lands as a `standard-part` feature
  with the right nominal Ø + head Ø + length.
- Library has ≥ 40 standard-fastener entries + ≥ 10 bearing entries.
- Inserted geometry survives reload (lives as a feature in
  `doc.features`, not as a raw THREE.Group like v0.26 imports).
- AI generation (08) inserts M-class fasteners via the standard
  catalog, never via `addCylinder({radius: 1.5})`.
- Search works on ISO standard codes ("4762" matches every SHCS).

## Open questions

- Pre-generate on every kernel boot vs lazy on first request? Lazy
  is faster boot; eager is faster first insert. Recommendation:
  lazy + permanent cache.
- How do we handle the AI selecting a thread engagement length vs
  total length? Application correctness (necessary, not sufficient
  per STRATEGY.md A6).
- Imperial fasteners: defer, but flag the path in the entry schema
  for future expansion.

## Effort

~2-2.5 weeks. Spec tables + JSON sourcing (~3 days). Build pipeline
+ caching (~4 days). Endpoint + client + dialog rewrite (~5 days).
Verifying real-world fasteners against datasheets (~2 days).
