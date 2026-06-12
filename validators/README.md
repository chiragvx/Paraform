# ParaForm v4 — Per-Feature Validation Fixtures

This directory holds the live-kernel validation suite. Each `.mjs` file
exports a list of test cases for one feature; `npm run validate` runs them
all against a real `b123d_server` and prints a green/red checklist.

```
$ npm run validate
$ npm run validate -- --only=box,fillet
$ npm run validate -- --grep=Helix
$ npm run validate -- --markdown      # writes validators/last-run.md
$ npm run validate -- --json          # for CI diffs
```

The kernel endpoint defaults to the tunnel URL in `index.html`. Override
with `VALIDATE_KERNEL=http://127.0.0.1:7823` for the local sidecar.

---

## Adding a new fixture

Drop a file named after the feature (e.g. `extrude.mjs`). Default-export an
array of cases:

```js
import { addExtrude, addBox } from '../lib/document/operations.js';
import { circleSketch } from '../lib/document/operations.js'; // or sketch_ops

export default [
    {
        name: 'Extrude · circle r=5 h=10',
        build: () => {
            const sk = circleSketch('XY', 5);
            addExtrude(sk.id, { amount: 10 });
        },
        expect: {
            featureType: 'Extrude',
            python: /extrude\(n_\w+, amount=10/,
            topology: { minFaces: 3, minEdges: 2 },
        },
    },
];
```

`build()` runs against a freshly-reset `DocumentStore`. Add whatever
features you need. The validator handles emit → kernel → assertions.

---

## Assertion vocabulary

Each case's `expect` object can carry any combination of:

| Key            | What it checks                                                                 |
|----------------|--------------------------------------------------------------------------------|
| `featureType`  | At least one feature in the store has this `type` string.                      |
| `python`       | Regex or `(code) => boolean`. Pre-emit check before the kernel round-trip.     |
| `topology.faces` / `edges` | Exact count on the leaf body (last node in topology).              |
| `topology.minFaces` / `minEdges` | Lower-bound count — use when OCCT seam choices are flaky.    |
| `topology.face` | Predicate against ≥1 face. Sub-keys: `normal` (`'+Z'` / `'-X'` / …), `surfaceType` (`'planar'` / `'cylindrical'` / …), `minArea`, `maxArea`. |
| `stub`         | `true` → the kernel function is a known no-op (Thread / Draft / push-pull-face). Reports as ⏸ stub-skipped instead of ✗ fail. |

Topology shape normalisation handles both the v3 fingerprint payload
(`node.bodies[0].faces`) and the v4 descriptor payload (`node.faces`).
`surfaceType` is silently skipped when the kernel doesn't expose it.

---

## What good coverage looks like

For each feature, target **2-5 cases** that exercise:

1. **Defaults** — `addBox()` with no params, etc.
2. **Edge-case dimensions** — thin slab, long shaft, tiny radius.
3. **Variant params** — `centered: false`, `lefthand: true`, etc.
4. **Multi-feature composition** (where applicable) — `Box → Hole → Fillet` chain. Put these in `composition.mjs` rather than the per-feature file.

For modifier features (Fillet / Chamfer / Hole / Shell):
5. **All-edges fallback** — `addFillet(box.id)` with no edge selection.
6. **Picked-edge** — supply a synthetic `edges: [...]` ref via `lib/picking/refs.js` and assert that only those edges round.

---

## Known stubs

The kernel's `add_thread`, `draft`, and `push_pull_face` are Phase-0 stubs
that return the body unchanged. Mark those cases with `expect.stub: true`:

```js
{
    name: 'Thread · M6 length=10',
    build: () => { ... },
    expect: { stub: true, featureType: 'Thread' },
}
```

The validator prints them with ⏸ and never fails the run on them.

---

## Output reporters

- **Terminal** (default): coloured per-line + per-category subtotal + final pass/fail/stub summary.
- **`--json`**: single JSON object with `{ endpoint, runs: [{ category, name, status, durationMs, stage?, reason?, topology? }] }`. CI-diffable.
- **`--markdown`**: writes `validators/last-run.md` with a checklist groupable by category. Paste into a doc.

---

## What this catches that unit tests don't

The unit suite (688 tests, `npm test`) is pure JS with mock kernels. It catches type / param / emit-string regressions in microseconds.

The validator catches what the unit suite can't:

- **Kernel API drift** (e.g. `build123d` 0.10.0 → 0.11.0 renames an arg).
- **Topology contract drift** (e.g. v3 → v4 payload shape changes).
- **Coordinate-frame bugs** (the face picker's `bodyTransform` regression from this session).
- **Stub regressions** (a feature that used to work now silently returns the body unchanged).
- **Cross-feature interactions** (Box → Hole produces unexpected face counts).

Run it at milestones, after big refactors, and before tagging a release.
