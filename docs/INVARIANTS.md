# Authoring engineering invariants

An **invariant** is a constraint that **always applies** to a CAD document,
regardless of the user's spec, manufacturing process, or downstream tool.
Examples: every body must be manifold; every fastener must have thread
engagement; every body must reference a known material.

## Invariants vs DFM

| | Invariant | DFM check ([spec 11](../tracker/11-cheap-dfm.md)) |
|---|---|---|
| Scope | Always-on engineering convention | Process-specific (3D-print / CNC / IM) |
| Origin | Engineering tradition + standards | Profile thresholds |
| Audience | Every document | Profile-tagged geometry |
| Source of truth | `src/lib/invariants/library.js` | `src/lib/dfm/profiles.js` |

If a check changes by process (min wall thickness, draft angle), it's DFM.
If it must always hold (manifoldness, bearing fit class, material reference),
it's an invariant.

## Adding a new invariant

1. **Pick an id** — `i-<category>-<terse-name>`. Examples:
   `i-geometric-manifold`, `i-fastener-thread-engagement`,
   `i-material-assigned`. Stable across versions; never rename.

2. **Pick a category** — one of:
   `geometric` · `material` · `standard-parts` · `mechanical` ·
   `assembly` · `parametric`.

3. **Pick a scope** — one of:
   `per-feature` · `per-component` · `per-document`. The runner
   iterates targets of that scope.

4. **Pick a severity** — `error` (blocks downstream emit) or
   `warning` (informational). Geometric/manifoldness → error.
   Standard-parts/material defaults → warning unless the user
   has opted into strict mode.

5. **Cite the rationale** — the `rationale` field is human-readable
   and renders under each violation's "why" disclosure. The
   `citation` field is the engineering source (ASM Handbook §,
   Shigley §, machinist's handbook page, ISO/DIN number). Both
   are required; an uncited invariant is a hallucination floor.

6. **Write the check function** — see contract below.

7. **Add a corpus test** — a `.mjs` file under
   `src/lib/invariants/__tests__/` constructing a document that
   should fail and a document that should pass.

8. **Bump the library version** — `library.js` exposes a top-level
   `LIBRARY_VERSION`; bump it. Each invariant also has its own
   `version` field — bump it when you tighten a threshold so the
   eval corpus ([spec 12](../tracker/12-eval-corpus.md)) can gate
   the regression.

## Check function contract

```js
check: async (target, ctx) => InvariantResult
```

- **Never throws.** Wrap any measure-API call or kernel call in
  try/catch; on failure return `{ ok: true, severity: 'pass',
  message: 'measure unavailable' }` so a kernel hiccup doesn't
  cascade into a wall of false errors. The UI shows
  "Invariants unavailable" if the runner itself throws.
- **Defensive on missing data.** A feature with no `params.material`
  is a violation, not a TypeError. Always null-check.
- **Returns:**
  ```js
  {
    ok: boolean,
    severity: 'pass' | 'warning' | 'error',
    message: string,             // user-facing one-liner
    suggestedFix?: string,       // optional, rendered as "Fix: …"
    measured?: { ... },          // optional structured numbers for the repair loop
  }
  ```

## Versioning

Each invariant carries a semver string in its `version` field.
Bumping thresholds (e.g., raising the thread-engagement multiplier
from 1.0 D to 1.5 D) bumps the patch version. Adding a new
sub-rule bumps the minor. Removing an invariant or changing its id
bumps the library's `LIBRARY_VERSION` major and ships a migration.

## Worked example: `i-fastener-minimum-edge-distance`

**Rationale (the why):** A bolt hole too close to a part edge
tears out under preload — the residual material can't support the
clamping force. Standard machinist guidance is 1.5× nominal
fastener diameter from any edge, with 2× preferred for steel.

**Citation:** Machinery's Handbook 31e, p. 1633 ("Edge Distance
for Bolted Joints").

**Library entry:**

```js
{
  id: 'i-fastener-minimum-edge-distance',
  name: 'Fastener edge distance',
  category: 'mechanical',
  scope: 'per-feature',
  severity: 'warning',
  rationale: 'A bolt hole closer than 1.5D to a part edge risks tear-out under preload.',
  citation: "Machinery's Handbook 31e, p. 1633",
  version: '1.0.0',
  check: async (feature, ctx) => {
    if (feature?.type !== 'Hole') return PASS;
    const dia = Number(feature.params?.diameter);
    if (!Number.isFinite(dia)) return PASS;
    let dist;
    try {
      dist = await ctx.measure({
        type: 'edge-distance',
        featureId: feature.id,
      });
    } catch {
      return { ok: true, severity: 'pass', message: 'measure unavailable' };
    }
    if (dist == null) return PASS;
    const minDist = 1.5 * dia;
    if (dist >= minDist) {
      return { ok: true, severity: 'pass', message: `${dist.toFixed(2)} mm clear` };
    }
    return {
      ok: false,
      severity: 'warning',
      message: `Hole is ${dist.toFixed(2)} mm from edge (min ${minDist.toFixed(2)} mm).`,
      suggestedFix: `Move hole inboard by ≥ ${(minDist - dist).toFixed(2)} mm or reduce diameter.`,
      measured: { dist, minDist, dia },
    };
  },
}
```

**Test (`src/lib/invariants/__tests__/i-fastener-minimum-edge-distance.test.mjs`):**

```js
import { runInvariants } from '../runner.js';

// fail case: 4 mm hole 3 mm from edge → 1.5*4 = 6 mm required
const failDoc = makeDocWithHole({ dia: 4, edgeDist: 3 });
const failRes = await runInvariants('per-feature', 'hole_x', ctxFor(failDoc));
assert(!failRes.results['i-fastener-minimum-edge-distance'].ok);

// pass case: 4 mm hole 8 mm from edge
const passDoc = makeDocWithHole({ dia: 4, edgeDist: 8 });
const passRes = await runInvariants('per-feature', 'hole_x', ctxFor(passDoc));
assert(passRes.results['i-fastener-minimum-edge-distance'].ok);
```

**Docs entry:** append a row to the invariant table in this file.
That's it — the runner picks it up automatically from `library.js`
on next reload.
