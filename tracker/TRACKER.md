# ParaForm — Tracker Index

## Status snapshot

- **Version:** `0.26.0` (see [package.json](../package.json))
- **Sprint velocity:** 65 commits in the trailing 14 days
- **Where we are:** Phase 1 foundations are closed; Phase 2 accuracy
  backbone is closed end-to-end with a stubbed LLM in spec 08; Phase 2a
  / 2b are closed; Phase 2c (kinematics oracle) is the only spec still
  green-shoots-in-progress. Editor surface declared **manual-user-ready
  at v0.24.0** (all seven E-phases landed).

---

## Phase 1 — Foundations

| Spec | Title | Status | One-liner |
|---|---|---|---|
| [01](01-smoke-harness.md) | Browser smoke harness | ✅ | Vite + Chromium harness, 32 cases / 6 families, `window.__paraform__` hook, CI gate on PRs. |
| [02](02-determinism.md) | Determinism baseline | ✅ | `/version` endpoint live; `kernelVersion` on every `/execute`; StatusBar mismatch warning. LLM seed/temp capture deferred to Phase 2. |
| [03](03-topological-naming.md) | Topological naming (Phase 1B) | ✅ | 51-case corpus / 7 files; Pattern + Mirror + modifier + xform + offset3d namers shipped; 4 xfails removed. |
| [04](04-constraint-graph.md) | Constraint-graph queries through emit | ✅ | Emit accepts Queries via `bridge.topologyIndex`; picker emits `qDescriptor(d)`; Inspector renders upstream refs + parameter chips. |
| [05](05-parameters.md) | Document Parameters + expression evaluator | ✅ | 72-test parser, reactive store, ParametersDialog UI, Submit-gating on errors, Kahn cycle detection. |
| [06](06-components.md) | Component / instance layer + v4→v5 migration | ✅ | 43/43 tests across migration / data / ops / picker; path-qualified runtime contexts; auto-migration on load. |

---

## Phase 2 — Accuracy backbone

| Spec | Title | Status | One-liner |
|---|---|---|---|
| [07](07-measure-api.md) | Measure as programmatic query API | ✅ | `POST /measure` with 11 query types; OCCT `BRepExtrema_DistShapeShape` + `BRepCheck_Analyzer`; 23 Python + 11 JS client tests. |
| [08](08-repair-loop.md) | Generate → measure → repair loop | 🟡 | Tiered pipeline (extractor → mapper → invariants/DFM → LLM residual) shipped; LLM client is a **stubbed mock** with a TODO for real provider wiring. |
| [09](09-assumptions-manifest.md) | Spec capture + assumptions manifest | ✅ | `AssumptionRecord` + 4 changelog kinds; extractor + standard-parts feeders; AssumptionsManifestPanel + StatusBar chip + markdown export. |
| [10](10-standard-parts.md) | Standard parts library v1 | ✅ | 148 catalog entries across 6 ISO tables; `GET /library` + GLB cache; LibraryDialog rewritten. v1 limitation: insertion is a marker feature (no round-trip `StandardPart` feature type yet). |
| [11](11-cheap-dfm.md) | Cheap DFM guardrails | ✅ | 5 checks × 3 profiles (3d-print / cnc-mill / injection-mold); Inspector + StatusBar chip + Settings tab; 21/21 tests. Real wall-thickness / tool-access deferred. |
| [12](12-eval-corpus.md) | Eval harness + corpus | ✅ | 32-entry corpus (7 families); per-invariant >5% regression gate; baseline.json; wired into CI. |

---

## Phase 2a / 2b / 2c — Tiered compiler + kinematics

| Spec | Title | Status | One-liner |
|---|---|---|---|
| [13](13-standard-parts-fit-check.md) | Standard-parts relational fit check | ✅ | ISO 286 (28 bands) + ISO 273 (24 entries) JS literals; 4 new DFM checks; auto-suggest on diameter match; 37 new tests. |
| [14](14-query-resolver-hardening.md) | Query-resolver hardening + datum-relative placement | ✅ | DSL `expect` clauses; `qDatum` with canonicalized corners; `QueryResolutionError` with candidates; legacy back-compat preserved. 47/47 strict + 35/35 legacy. |
| [15](15-deterministic-extractor.md) | Deterministic spec extractor | ✅ | 63-entry corpus / 6 categories; 7 subparsers at 100% accuracy; worked-example fully structurally parseable with empty residualText. |
| [16](16-invariant-library.md) | Invariant constraint library | ✅ | 25 invariants / 7 categories; 23-entry materials DB with ASTM/DIN aliases; lazy DFM cross-import keeps graph acyclic; 77 tests. |
| [17](17-kinematics-oracle.md) | Kinematics oracle | 🟡 | v1 + v2 triangle-mesh interference landed (BVH, overlay, contact triangles, KinematicsPanel highlight). OBB / dynamics / motor catalog / trajectory opt / reach envelope **deferred**. |
| [18](18-component-library.md) | Atomic component library + KSP-style snap-mate | 🟡 | v1: 50 atomic parts + 5 composites + typed Connector primitive (7 kinds, 3 genders), library palette + drag-snap UX, mate solver, induced revolute/prismatic/fixed joints, AI fetch via `PartSelection` fallback. Embedding retrieval / auto-connector inference / imperial fasteners **deferred**. |

---

## Editor readiness

See [EDITOR_READINESS.md](EDITOR_READINESS.md) for the full E-phase
checklist; [E7_AUDIT.md](E7_AUDIT.md) for the toolbar / palette /
inspector triage map.

| Phase | Scope | Status |
|---|---|---|
| E1 | Wire disabled ribbon buttons (13 commands: Sweep, Loft, Helix, Hole, Draft, Patterns, Mirror, Plane, Axis, Point) | ✅ |
| E2 | Sketch UX (face-pick, 3 arc tools, driven dims, status overlay, lifecycle polish) | ✅ |
| E3 | Power modeling (Press-Pull v1, Move/Delete/Offset Face, Split body, Align translate-fallback, Cosmetic Thread) | ✅ |
| E4 | Selection + measurement + section (rubber-band, marking menu, Measure, Section view v1, Interference) | ✅ |
| E5 | Document workflow (Save / Save As / Open / New, Share bundle zip, STEP import) | ✅ |
| E6 | View / chrome polish (Hidden Edges, X-Ray, view bookmarks, editable shortcuts, drag-reparent, context menus, timeline scrub) | ✅ |
| E7 | QA + smoke + fix-the-fixable (41-button audit, ~85 palette sweep, 15 edge-case assertions, SSR-nested-button fix) | ✅ |

**Editor surface declared manual-user-ready at v0.24.0** for parametric
solid modeling of mechanical parts.

---

## Open follow-ups

Items left explicitly open across the tracker:

- **Spec 08** — Real LLM provider wiring (current client is a deterministic
  mock; needs a user pick of provider + key handling).
- **Spec 10** — Round-trip `StandardPart` feature type (v1 inserts a
  BuildScript marker alongside a scene-only `THREE.Group`).
- **Spec 11** — Real wall-thickness via kernel offset-surface probe;
  tool-access reachability for CNC; draft analysis. cnc-mill /
  injection-mold profile thresholds defined but not yet consumed.
- **Spec 17** — Deferred-heavy: OBB collision, rigid-body dynamics,
  motor catalog, trajectory optimization, reach envelope.
- **Editor E3.1** — Press-Pull drag-handle gizmo + live preview overlay
  (v1 is face-pick → `window.prompt` for distance).
- **Editor E3.1** — Non-planar face support in kernel `push_pull_face`.
- **Editor E3.2** — Delete Face full OCCT heal via
  `BRepOffsetAPI_MakeFilling` for open skins; Move Face tangent slide.
- **Editor E3.3** — Split Face kernel impl (topological-naming +
  curve-on-face math).
- **Editor E3.4** — Align rotate component (waiting on spec-14 kernel
  datum vocabulary); currently translate-only fallback.
- **Editor E3.5** — Modeled thread via helical sweep (cosmetic ships).
- **Editor E4.4** — Section view rotate-gizmo + hatched cut-face material.
- **Editor E4.5** — True interference overlap-volume body (kernel
  returns scalar `{intersects, volume}`, not the intersection body).
- **Editor E5.2** — Multi-document tabs (deferred to v2).
- **Editor E6.4** — Component-into-component reparent op + UI.
- **Editor E6.3** — Live keymap reload on shortcut edit (page reload
  required today).
- **CI tripwire** — Pre-existing stale test in
  `lib/document/__tests__/primitives.mjs` expects `Align.CENTER` on Z
  but emit correctly emits `Align.MIN` per the Z-up rule
  ([CLAUDE.md](../CLAUDE.md)). Test is stale, not the code.

---

## Quick links

- [STRATEGY.md](../STRATEGY.md) — rationale and phase framing
  referenced from spec headers (§F2-§F5, §A9)
- [CLAUDE.md](../CLAUDE.md) — coordinate conventions, GLB import,
  primitive alignment, picking, tessellation, viewport stack
- [EDITOR_READINESS.md](EDITOR_READINESS.md) — full E1-E7 checklist
- [E7_AUDIT.md](E7_AUDIT.md) — UI triage map (works / stub-v1 /
  placeholder / broken / not-tested)
