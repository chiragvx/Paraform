# Foundation 5 — Document Parameters dialog + expression evaluator

> **Status (2026-06-07):** ✅ landed. Expression parser (72 unit tests
> passing), reactive parameters store using existing
> `doc.parameters` slot + `addDocumentParameter`/`set`/`remove` helpers
> (undo/redo + persistence ride along free), ParametersDialog UI,
> FeatureFormDialog number fields accept expressions with live
> evaluated-value display + Submit gating on errors, app.parameters
> palette command + Sigma/Variable icon in TopBar. Cycle detection via
> Kahn's algorithm; circular dependencies flagged per-row and excluded
> from the scope so dependents fail cleanly. Reverse index (parameter
> → consuming features) deferred to feature-level expression usage.
> Not yet browser-smoke-tested — depends on a live kernel.



> Phase 1 of [TRACKER.md](../TRACKER.md). Strategy rationale in
> [STRATEGY.md](../STRATEGY.md) §A5.

## TL;DR

A document-level **named parameter table** with **unit-aware
expressions** (`width = 2 * height + 5mm`). The AI populates it; the
user edits it; the kernel rebuilds. Required for steerable AI output
— without it, AI output is frozen at the constants the model
guessed.

## Why foundation

A5 in STRATEGY.md. If the AI emits `addBox({ length: 40, width: 40,
height: 40 })`, the user can edit those values via the Inspector
Parameters panel — but those are *feature parameters*, not
*document parameters*. There's no way to say "every bracket on this
plate uses the same hole spacing."

For accurate mechanical parts, named parameters with relationships
are how intent gets encoded. They also make the AI's output legible:
"the wall is 4 mm because `wallThickness` was set to 4."

## Current state

**Catalog types exist, no UX:**
- [lib/document/types.js](../lib/document/types.js) defines
  `Parameter(name, value, unit, equation)` and `Equation(name,
  expression)` as feature types.
- [lib/document/emit.js](../lib/document/emit.js) emits
  `p_<name> = <value>` raw Python for Parameters; emits
  `p_<name> = <expression>` raw Python for Equations.
- [lib/document/operations.js](../lib/document/operations.js)
  exposes `addDocumentParameter(name, value, unit)` (verify exact
  name).
- No UI surface — the document Parameters panel doesn't exist
  anywhere in `src/lib/components/`.
- No expression parser — equations are emitted as raw Python strings
  with no validation, no unit awareness, no reference to other
  parameters.

**Feature forms — frozen constants only:**
- Feature form fields in
  [src/lib/commands/registry.js](../src/lib/commands/registry.js)
  accept literal numbers (`{ key: 'length', type: 'number', default:
  20 }`). No way to type `width / 2` and have it evaluate against
  the document's parameter table.

**Units — done:**
- [src/lib/units/units.svelte.js](../src/lib/units/units.svelte.js)
  has the global units state (`unit`, `decimals`), `formatLength`,
  `formatNumber`. Used by HUD + Inspector + ExportDialog.

## Scope

**In:**
- A document Parameters table model living on the document store —
  serialized as part of `store.doc` alongside features. Each entry:
  `{ name, value, unit, expression?, dependsOn[] }`.
- A Parameters dialog (new `src/lib/components/studio/ParametersDialog.svelte`)
  with: a table of (name, expression-or-value, evaluated value, unit,
  delete), an "Add parameter" row, and a small expression preview.
  Open from the App command (`app.parameters`) and from the Inspector
  Parameters panel (link "Edit doc parameters →").
- An expression evaluator — minimal: literals, four ops, parens,
  parameter-name lookup, unit-aware (`5mm + 1in` resolves to mm).
  Implementation: a small precedence-climbing parser + an evaluator
  closure that takes the parameters table as scope.
- Feature form fields accept expressions. The `type: 'number'` field
  becomes "literal-or-expression": if input starts with a digit and
  parses cleanly as a number, treat as literal; otherwise parse as
  expression and evaluate against the document parameters.
- A reverse index on the document store: `parameter → features that
  reference it`, so editing a parameter triggers re-emit of just
  those features (or — simpler v1 — re-emit the whole document, then
  optimize later).
- Optional v1.5: the AI emit path produces parameter declarations
  ("the bracket has a parameter `wallThickness` defaulting to 4 mm")
  alongside feature ops. (Soft scope.)

**Out:**
- A full CAS / symbolic-math library. We need expressions like
  `width * 2 + 5mm`, not `sin(pi/4) * sqrt(2)`. Start with arithmetic
  + parameter references; add `min`, `max`, `abs`, `sin`, `cos`,
  `sqrt` if needed; stop there.
- Driving parameters from external data (CSV / API). Out of scope.
- Equations that reference other equations recursively beyond depth
  ~3. Trap circular dependencies; error loudly.

## Dependencies

- Foundation 2 (determinism): the same expression should evaluate
  the same way across kernel versions. Pin the evaluator's
  arithmetic (use JS Number throughout; document precision limits).
- Foundation 4 (constraint graph): queries and parameters together
  *are* the constraint graph for the document. The Parameters dialog
  is where the user sees the parameters; the relationships panel
  (planned in Foundation 4) is where the user sees the queries.
  Build them as adjacent UI.

## Critical files

- New: `src/lib/parameters/store.svelte.js` — reactive parameter
  table, `addParameter`, `setParameter`, `removeParameter`, `evaluate(expr)`.
- New: `src/lib/parameters/expression.js` — tokenizer + parser +
  evaluator. Stateless; takes a scope object.
- New: `src/lib/components/studio/ParametersDialog.svelte` —
  the table UI.
- New: `src/lib/components/studio/inspector/RelationshipsPanel.svelte`
  (?) — Inspector section showing per-feature param refs +
  document-level relationships from Foundation 4.
- Modify: [lib/document/types.js](../lib/document/types.js) — the
  Parameter / Equation types may already be close; ensure they
  carry the `dependsOn[]` reverse-index lookup.
- Modify: [lib/document/store.js](../lib/document/store.js) — serialize
  the parameters table in `toJSON` / `fromJSON`.
- Modify: [src/lib/components/studio/FeatureFormDialog.svelte](../src/lib/components/studio/FeatureFormDialog.svelte) — number fields
  accept expressions; show evaluated value beside the input.
- Modify: [src/lib/commands/registry.js](../src/lib/commands/registry.js)
  — new commands `app.parameters` (open dialog), `parameters.add`.

## Acceptance

- A user can: open Parameters dialog, add `wallThickness = 4mm`, add
  `outerSize = 40mm`, add `innerSize = outerSize - 2 * wallThickness`.
- A box's `length` field accepts `outerSize` and rebuilds at 40 mm.
- Changing `outerSize` to `50mm` rebuilds the box at 50 mm — without
  re-creating the feature.
- A circular dependency (`A = B + 1mm`, `B = A - 1mm`) shows a
  loud, clear error and doesn't crash.
- A `5mm + 1in` expression evaluates to `30.4 mm` (or whatever
  units.svelte.js says — verify).
- The Foundation 1 smoke harness has a parameter-driven case that
  rebuilds after a parameter edit.
- AI output (when it lands) can emit a `Parameter(...)` op
  alongside `Box(...)` and the resulting document is steerable.

## Open questions

- Where does parameter scope live — per-document only (v1), or also
  per-component (when Foundation 6 lands)? Per-component is more
  Fusion-like but complicates resolution. Recommendation: v1
  per-document; revisit when components ship.
- How aggressive is unit awareness? Always require explicit units on
  literals (`5mm`, not `5`)? Or default to the document units? Fusion
  defaults to document units. Recommendation: default to document
  units, allow explicit suffix to override.
- Where does the expression parser live — JS or Python? JS for
  immediate feedback in the form; the kernel just receives the
  *evaluated* numbers and never sees the expressions. Recommendation:
  JS only.
- Does the AI get to *see* the parameter table in its context window
  when proposing new features? Yes, obviously — but call this out
  explicitly so the prompt scaffolding wires it through.

## Effort

1.5–2 weeks. Parser + evaluator is ~3 days; store + serialization
~2 days; dialog UI ~3 days; feature-form integration ~2-3 days;
edge cases (circular deps, unit conversion, error UX) ~3 days.
