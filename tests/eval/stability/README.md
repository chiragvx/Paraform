# Stability eval

Per-feature parametric sweep, asserting that every topological descriptor
(face / edge / vertex) the kernel emitted **before** a parameter change
is still emitted **after** it.

This is the eval framework behind [tracker/14-query-resolver-hardening.md](../../../tracker/14-query-resolver-hardening.md).

## What is "stability"?

A descriptor is the canonical string form (`lib/document/descriptor.js`
`stringify`) of a `{ kind, feature, opTag, part, parents[] }` record. It
is symbolic — no coordinates — so it should survive dimensional
changes. The kernel re-emits the same string on every rebuild as long as
the parent feature's topology is unchanged.

**Persistence rate** is the fraction of descriptors in the *before*
snapshot that still appear in the *after* snapshot:

```
persistenceRate = |before ∩ after| / |before|
```

A new descriptor appearing on the *after* side (e.g. extra `inst[i]`
when a pattern count grows) is *not* counted against the rate — that's
a structural addition, not a migration. A descriptor *disappearing* is.

## How to run

```bash
# Terminal 1 — local kernel
python b123d_server/server.py

# Terminal 2 — stability eval
VITE_ENGINE_URL=http://localhost:7823 npm run test:stability
```

Every case needs a live kernel — there is no kernel-free case in the
stability corpus (each one compiles a parametric document and
re-compiles it after a parameter mutation). Without a kernel every case
times out at render-wait.

`STABILITY_VERBOSE=1` to surface vite stdout/stderr.

## Threshold per case

Each case calls `assertDescriptorsPersist(before, after, { threshold })`
with a documented threshold:

| Case shape | Default threshold | Why |
|---|---|---|
| Primitive parameter sweep (Box, Cylinder, Sphere, Torus) | 1.0 | Descriptors are symbolic — no dim change can re-tag a face. |
| Primitive + Fillet (radius OR parent dim) | 1.0 | Fillet's filleted-edge parents are descriptor-keyed. |
| Primitive + Shell (thickness) | 1.0 | Shell's outer/inner faces are symbolic. |
| Primitive + Hole (diameter) | 0.95 | Bore-cap vertex/edge may migrate at extreme diameter ratios. |
| Primitive + Chamfer (length) | 0.90 | Chamfer chains are spec-14 xfail-on-strict — edge-converging corners can re-tag. |
| LinearPattern (spacing OR source dim) | 1.0 | Spacing is a placement dim; topology is invariant. |
| LinearPattern (count grows) | 0.95 | Boundary instances may re-tag when array length crosses a divisor boundary. |

When a residual closes (e.g. chamfer-chain naming hardens), tighten the
threshold here in the same PR.

## Adding a case

1. Pick the right file under `cases/` (or add a new one and append to
   `cases/index.mjs`):
   - `primitives.mjs` — single-feature sweeps
   - `modifiers.mjs` — primitive + Fillet/Chamfer/Shell/Hole
   - `patterns.mjs` — primitive + LinearPattern/CircularPattern
2. Write the case using the standard shape:

```js
{
  name: '<feature kind>: <param> <from> → <to>',
  async run(page) {
    const { featureIds } = await buildDoc(page, [
      { type: 'Box', id: 'box_x', params: { length: 10, width: 10, height: 10 } },
      // optional modifier:
      // { type: 'Fillet', id: 'fill_a', target: 'box_x', params: { radius: 2 } },
    ]);
    const before = await snapshotDescriptors(page);
    await sweepParameter(page, featureIds.box_x, 'length', 20);
    const after = await snapshotDescriptors(page);
    return assertDescriptorsPersist(before, after, { threshold: 1.0 });
  },
}
```

3. `return` the rate from `assertDescriptorsPersist` so the runner can
   surface it in the stability-metric summary.

4. If your threshold is < 1.0, add a sentence to the case comment
   explaining *why* — what topological migration is expected and what
   needs to land in the resolver / namer to tighten it.

## What the metric means

The runner prints, at the end:

```
stability: <pass> passed, <fail> failed (<total>ms)
stability metric: median persistence <X%>, min <Y%> (n=<rates>)
```

- **median persistence** ≥ 95% means the resolver is doing its job on a
  representative cross-section of operations.
- **min persistence** flags the worst case — if it drops below 90%
  there's a regression in a specific namer that the corpus is detecting.

Both numbers regress monotonically with `lib/document/queries.js` /
`resolver.js` / `b123d_server/naming.py`. A change to any of those
should be tested here before merge.

## Files

- `harness.mjs` — Playwright + vite-spawn boot (mirrors smoke).
- `asserts.mjs` — `buildDoc`, `snapshotDescriptors`, `sweepParameter`,
  `compareSnapshots`, `assertDescriptorsPersist`.
- `runner.mjs` — entry point (`npm run test:stability`).
- `cases/{primitives,modifiers,patterns}.mjs` — the corpus.
- `cases/index.mjs` — aggregates the corpus into one list.
