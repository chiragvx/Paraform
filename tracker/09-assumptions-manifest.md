# Phase 2.3 — Spec capture + assumptions manifest

> **Status (2026-06-07):** ✅ landed.
> Shipped: `AssumptionRecord` factory + 4 changelog kinds (add/ack/remove/clear)
> on `doc.assumptions`; survives serialize/reload via the changelog. Extractor
> bridge (`ingestExtractorAmbiguities`) turns each `AmbiguityNote` from spec 15
> into a `source='extractor'` record. Standard-parts catalog default-grade
> emitter (`recordStandardPartGradeDefaults` + auto-hook in `addStandardPart`)
> records `source='standard-parts'` assumptions when a family is requested
> without a grade (`aluminum → 6061`, `steel → 1018`, …). New
> `AssumptionsManifestPanel.svelte` (Inspector + always-on when no feature
> selected) lists every assumption with source chip, jump-to-feature button,
> per-source filter, "Acknowledge all", "Export manifest". StatusBar chip
> mirrors the unacknowledged count with severity colour. Manifest export
> (`exportAssumptionsManifest`) yields a grouped markdown report. 21 new
> assertions in `src/lib/__tests__/spec09_assumptions.mjs`, all green; every
> other suite still passing; `npm run build` clean. **Out of scope for this
> commit:** the AI generation path (spec 08) that *writes* the manifest from
> the model side; the override-driven regenerate flow; the question-card UI.
> Those wait on spec 08 to land — the data substrate is now in place.

> Phase 2 of [TRACKER.md](../TRACKER.md). Strategy: [STRATEGY.md](../STRATEGY.md) §A8.
> Underrated trust UX. Small file count, large UX delta.

## TL;DR

Every AI generation captures **structured intent**: the user's prompt
+ explicit constraints + an **assumptions manifest** the model is
required to emit (e.g. "assumed 4 mm wall, 8 mm edge distance, M4
clearance holes"). The manifest renders alongside the part as
**individually overridable** chips. When ambiguity is high the model
asks rather than guesses.

## Why foundation

A silently guessed dimension is the worst failure mode for "accurate
mechanical part" — confidently wrong. The assumptions manifest:

- Surfaces hidden choices so the user can audit them.
- Makes the part editable along the right axes (override an
  assumption → AI regenerates with the new value).
- Provides the substrate for the auditable-dimension layer (Phase 3:
  provenance chain, tolerance metadata, critical-dim extraction —
  all annotations on the same data model).
- Forces the model to *think about* what it doesn't know, instead of
  defaulting silently.

## Current state

- F5 parameters dialog gives us the editable-numeric substrate. The
  manifest fields are essentially parameters with extra metadata
  (rationale, source = AI, confidence).
- No spec-capture UI today. AI generation (08) will plug in here.

## Scope

**In:**
- Spec capture data model (`src/lib/intent/spec.js`):
  ```ts
  Spec {
    prompt: string;
    explicitConstraints: Constraint[];  // typed: "max wall ≤ 2mm", "fits M4 bolt"
    assumptions: Assumption[];          // AI-emitted, overridable
    referenceGeometry: FeatureId[];     // optional
    acceptance: AcceptanceCheck[];      // measure calls (07) the loop must pass
    metadata: { createdAt, model, seed, kernelVersion };
  }
  Assumption {
    id: string;
    key: string;        // 'wallThickness' / 'edgeDistance' / 'holeDiameter'
    value: number;      // mm
    unit: 'mm';
    rationale: string;  // "M3 clearance hole standard"
    confidence: 'low' | 'medium' | 'high';
    overridden: boolean;
    overrideValue?: number;
    source: 'ai' | 'user';
  }
  ```
- New `src/lib/intent/store.svelte.js` — reactive store of
  per-document specs. One spec per AI generation. Persisted in
  `doc.intent[]` (changelog kind ADD_SPEC).
- New `src/lib/components/studio/SpecCapturePanel.svelte` — render
  in the Inspector OR as a sidebar drawer:
  - Prompt textarea
  - Explicit constraint chips ("add constraint…" + presets)
  - Generate button → hooks into the repair loop (08)
  - After generation: assumptions list. Each row: rationale tooltip,
    current value, "override" inline edit, confidence indicator.
- Override flow: editing an assumption sets `overridden: true` and
  triggers a regeneration (or just a parameter update if the model
  used F5 parameters cleanly).
- Question flow: when the model emits a "I don't know X" entry
  alongside the manifest, render a destructive-bordered question
  card the user must answer before generation completes. Default
  retry budget pauses on questions.

**Out:**
- Free-text annotations / comments on the spec.
- Multi-spec composition (chain "first this, then that").
- Cloud-stored intent libraries.

## Dependencies

- 08 repair loop — the AI emit path is what populates the manifest.
- 07 Measure API — `acceptance` checks ARE measure queries.
- F5 parameters — overrides cascade through parameters when the
  model used them properly.

## Critical files

- New: `src/lib/intent/{spec.js, store.svelte.js}`.
- New: `src/lib/components/studio/SpecCapturePanel.svelte`.
- Modify: [lib/document/changelog.js](../lib/document/changelog.js) — add
  `ADD_SPEC`, `OVERRIDE_ASSUMPTION` kinds.
- Modify: [lib/document/fold.js](../lib/document/fold.js) — apply.
- Modify: [Inspector.svelte](../src/lib/components/studio/Inspector.svelte) —
  slot the panel between Relationships and Scene & Material.
- Modify: [src/lib/commands/registry.js](../src/lib/commands/registry.js) —
  add `intent.captureSpec`, `intent.regenerate`.

## Acceptance

- The AI generates a 60×40×20 mm enclosure with 4 mounting holes;
  the manifest exposes `{wallThickness: 1.5, mountingHoleDiameter: 3.2,
  edgeDistance: 5.0}` with rationales.
- Overriding `wallThickness` to 3 mm triggers a regenerate; the new
  part has the new wall thickness.
- A high-ambiguity prompt ("make a thing") prompts the user with at
  least one structured question before generation proceeds.
- Spec persists across reload (changelog ADD_SPEC).

## Open questions

- Where Inspector shows it vs a dedicated drawer: depends on density
  — recommendation start in Inspector and migrate to drawer if it
  outgrows the column.
- Should overrides be parametric (update an F5 parameter) or
  generative (re-run the loop)? Both valid; the model should choose
  based on whether the dimension flows through a parameter or was
  baked in.

## Effort

~1-1.5 weeks. Data model + persistence (~3 days). UI panel + override
flow (~4 days). Question flow + acceptance checks (~3 days).
