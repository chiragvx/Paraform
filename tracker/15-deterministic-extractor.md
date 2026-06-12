# Phase 2b — Deterministic spec extractor

> **Status (2026-06-07):** ✅ landed. 63 corpus entries across 6
> categories (primitives 11 / fasteners 11 / fits 10 / materials 11 /
> spatial 10 / kinematic 10). 7 subparsers all at 100% accuracy on
> the corpus. The worked-example spec ("60×40×3 mm aluminum plate
> with four M3 clearance holes at the corners, 5 mm from each edge")
> extracts 7 constraints + 1 ambiguity (material grade) with **empty
> residualText** — fully structurally parseable, no LLM needed.
>
> What's now grammar-shaped: dimensions in any tuple/Ø form; ISO
> catalog references; fit classes (named + ISO 286 codes); material
> lexicon with grade-ambiguity flagging; process lexicon; bounded
> spatial relations with offsets + counts; kinematic mechanisms with
> DOF + payload. Lexicons live as JSON under
> `src/lib/extractor/lexicons/` so they grow without code changes.
>
> What Layer 3 (LLM residual) will still own: free-form intent,
> cross-feature refs ("the bearing from above"), conditional
> language, aesthetic constraints, units not yet tabulated (torque,
> Ra/Rz, GD&T, BCD callouts), tolerance constraints (recognised by
> tokenizer but not yet emitted — flagged as the next grammar gap).



> Phase 2b of [TRACKER.md](../TRACKER.md). **Layer 1 of the tiered
> spec→acceptance compiler.** Replaces the previous "independent
> LLM compiler" framing — that approach kept the self-grading
> problem inside the fix, since two LLM prompts against the same
> model share systematic blind spots.

## TL;DR

A grammar/parser that turns the structured, parseable portion of a
user spec into typed atomic constraints — *without an LLM*.
Dimensions, ISO part codes, fit classes, fastener callouts,
tolerances, named materials. These are tokens, not interpretations.
A hand-written extractor handles them and the spec compiler's
correlated-error problem doesn't apply. Layer 2 ([invariant library](16-invariant-library.md))
and Layer 3 (LLM residual in [spec 08](08-repair-loop.md)) sit on
top of this.

## Why non-LLM

The original Phase 2 plan had a separate LLM pass compiling
acceptance checks from the spec. Critique that landed: two prompts
against the same model class share training distribution, so they
share blind spots — co-generation bias is reduced but not
eliminated. The structural answer is to extract what *can be
parsed deterministically* before any model is involved, then layer
an explicit invariant library on top, then use the LLM only for the
residual that genuinely needs interpretation. The residual is the
"accepted-risk" surface; the rest is grammar.

Structured engineering language is grammar-shaped:
- `"60×40×3 mm aluminum plate"` → dimensions tuple + material name
- `"M3 clearance holes"` → fastener spec + role
- `"5 mm from each edge"` → relational placement + count quantifier
- `"H7/g6 fit"` → fit class
- `"4-DOF SCARA"` → mechanism kind + DOF count
- `"NEMA17 stepper"` → motor frame size

None of those need an LLM. They need a parser. Once parsed they
become typed constraints feeding both the op generator (as input
constraints) and the acceptance compiler (as gates).

## Current state

- No spec parsing at all. Spec text is opaque to the architecture;
  the (proposed) LLM consumes it raw.

## Scope

**In:**

1. **Tokenizer** — splits spec text into typed tokens:
   - Dimensions: `60×40×3`, `Ø22`, `5 mm`, `200 mm/s`
   - ISO part codes: `ISO 4762`, `M3×16`, `608 bearing`,
     `iso4032-m4`
   - Fit classes: `H7/g6`, `H7/h6`, `H7/k6`, `slip fit`, `press fit`
   - Materials: `aluminum 6061`, `7075`, `PLA`, `ABS`, `1.4301`,
     `steel`
   - Process hints: `3D printed`, `CNC machined`, `injection
     molded`, `cast`
   - Quantifiers: `four`, `4`, `each`, `every`, `all`
   - Spatial relations: `from each edge`, `centered`, `on the top
     face`, `inset`
   - Tolerances: `±0.05`, `+0.1/-0`, `IT7`

2. **Grammar / parser** — composes tokens into typed
   constraint records:

   ```ts
   Constraint =
     | DimensionConstraint(axis, value, unit)
     | PartSelection(catalogId, qty, role)
     | FitClass(class, mating: PartRef)
     | MaterialSpec(material, process?)
     | SpatialConstraint(target, datum, offset, count?)
     | ToleranceBand(target, ±value)
     | ProcessHint(process, profile?)
     | KinematicSpec(mechanism, dof)
     | LoadSpec(payload, mode)

   ExtractResult = {
     constraints: Constraint[],
     residualText: string,           // what didn't parse
     ambiguities: AmbiguityNote[],   // flagged for layer 3
   }
   ```

3. **Domain-specific subparsers** — separable modules:
   - `parseDimension`, `parseISOPart`, `parseFitClass`,
     `parseMaterial`, `parseProcess`, `parseSpatialRelation`,
     `parseKinematic`.
   - Each one's hit-rate is independently measurable.

4. **Corpus of test specs** — under `tests/extractor/corpus/`. A
   few hundred real spec snippets from drawings / ECNs / RFQs /
   product datasheets:
   - "1/4-20 UNC clearance holes" (imperial — for v1 future scope)
   - "M3 × 12 SHCS, 4 places, 90° apart on Ø50 BCD" (bolt circle)
   - "Press fit for 608 bearing" (mating intent)
   - "All edges chamfered 0.5×45°" (default chamfer)
   - "Surface finish Ra 1.6 except as noted" (finish spec)

   Each corpus entry has expected `ExtractResult`; extractor
   accuracy measured against it. Test corpus is the design substrate
   — write it before writing the parser, against real engineering
   text. The extractor's quality bar is what this corpus says it is.

5. **Output binding** — each extracted constraint flows into:
   - Op generator (spec 08) as an *input constraint* the model
     must satisfy
   - Acceptance compiler (spec 08) as a *check* the repair loop
     enforces
   - Assumptions manifest (spec 09) as *not-an-assumption* — these
     came from the user, not the model

**Out:**

- Free-form sentence understanding (the residual goes to layer 3).
- Cross-sentence reference resolution ("the bearing from above").
- Inferring missing constraints from context (layer 2 handles
  invariants).
- Imperial fasteners (v2).
- Language other than English (v3).

## Dependencies

- None for the parser itself. It's pure JS, no model, no kernel.
- Output consumers in [spec 08](08-repair-loop.md) wait for the
  parser to ship.
- Eval corpus (spec 12) reuses the test corpus as its substrate
  for the "what fraction of constraints are extractable
  deterministically" metric.

## Critical files

- New: `src/lib/extractor/tokenize.js`
- New: `src/lib/extractor/grammar.js`
- New: `src/lib/extractor/subparsers/{dimension, iso_part, fit_class, material, process, spatial, kinematic}.js`
- New: `src/lib/extractor/index.js` — `extract(specText): ExtractResult`
- New: `tests/extractor/corpus/*.json` — design corpus with
  ground-truth `ExtractResult` per entry.
- New: `src/lib/extractor/__tests__/extractor.mjs` — runs the
  extractor against the corpus; reports per-subparser accuracy.

## Acceptance

- `extract("60×40×3 mm aluminum plate with four M3 clearance holes
  at the corners, 5 mm from each edge")` returns:
  ```js
  {
    constraints: [
      DimensionConstraint('length', 60, 'mm'),
      DimensionConstraint('width', 40, 'mm'),
      DimensionConstraint('thickness', 3, 'mm'),
      MaterialSpec('aluminum', null),
      PartSelection('iso-273-clearance', 4, 'clearance'),
      FastenerSpec('M3', null, null),
      SpatialConstraint(target='clearance-holes', datum='each corner',
                        offset=5, count=4),
    ],
    residualText: '',
    ambiguities: [
      {kind:'material', detail:'aluminum grade unspecified (6061 default)'},
      {kind:'fastener-length', detail:'M3 length unspecified'},
    ],
  }
  ```
- Per-subparser accuracy ≥ 95% on the test corpus.
- Extracted constraints round-trip into the op generator's input
  prompt + into the acceptance compiler's check set.
- Residual text is what gets handed to layer 3 (LLM); ambiguities
  are surfaced to the user via the assumptions manifest (spec 09).
- Corpus size ≥ 200 spec snippets at first ship; growing target.

## Open questions

- **Where the test corpus comes from**: a curated dump from
  open-source engineering repos (FreeCAD examples,
  OpenSCAD-Library, GitHub mechanical design projects' README +
  drawings) + a small synthetic set. Annotation cost is the slow
  part.
- **Whose grammar wins on ambiguous tokens** (`5` is dimensionless
  here vs `5 mm`): require unit-bearing where physical;
  flag ambiguities rather than guess.
- **Versioning the extractor**: when the grammar grows, regressions
  on the test corpus gate releases. CI gate identical to the eval
  corpus pattern (spec 12).

## Effort

~2 weeks. Tokenizer + base grammar (~3 days); 7 subparsers (~5
days); corpus authoring (~3 days, sourced from real engineering
text); accuracy measurement + tuning (~3 days). All pure JS; no
kernel, no model, no deps beyond a regex engine.
