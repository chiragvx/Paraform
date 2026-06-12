/**
 * Stability eval helpers.
 *
 * The stability eval asks one question per case: when a parameter changes,
 * do the descriptors produced by the kernel stay the same?
 *
 * "The same" means: the canonical-string form (descriptor.js `stringify`)
 * of every face / edge / vertex descriptor that existed before the
 * mutation still exists after. Geometry payloads may shift; identity must
 * not.
 *
 * The helpers reach through `window.__paraform__` (set by src/main.js)
 * — the same test hook the smoke harness uses. The topology index is
 * exposed via `__paraform__.getBridge().topologyIndex` (set on every
 * successful render by lib/document/bridge.js).
 *
 * API surface
 * ───────────
 *   buildDoc(page, spec)                       → { featureIds }
 *   snapshotDescriptors(page)                  → Map<featureId, Set<string>>
 *   sweepParameter(page, fid, name, value)     → void
 *   compareSnapshots(before, after)            → { persistenceRate, missing, added }
 *   assertDescriptorsPersist(before, after, o) → void (throws on failure)
 *
 * Defensive posture: every helper throws loud, descriptive errors if the
 * bridge / topology index / target feature is missing. Stability failures
 * must be obvious — silent zero-rate "passes" are exactly the failure
 * mode we are guarding against.
 */

const RENDER_WAIT_MS = 15_000;

// ── Shared low-level helpers (mirrors of smoke/asserts.mjs ones we need) ─────

export async function resetDocument(page) {
  await page.evaluate(() => {
    window.__paraform__.v4.resetDocument();
  });
  await waitForRender(page);
}

export async function waitForRender(page, expectedCount = 1, timeoutMs = RENDER_WAIT_MS) {
  await page.evaluate(([n, t]) => {
    return new Promise((resolve, reject) => {
      const bridge = window.__paraform__.getBridge();
      if (!bridge) return reject(new Error('bridge not booted'));
      let count = 0;
      const off = bridge.onRender(() => {
        count++;
        if (count >= n) { off(); resolve(); }
      });
      setTimeout(() => { off(); reject(new Error(`render timeout after ${t}ms (got ${count}/${n})`)); }, t);
    });
  }, [expectedCount, timeoutMs]);
}

// ── Doc builders ─────────────────────────────────────────────────────────────

/**
 * Build a parametric document from a small spec language and return a map
 * from each spec entry's `id` (caller-chosen, e.g. `'box_x'`) to the
 * actual feature id minted by the v4 layer.
 *
 * spec entry shape:
 *   { type: 'Box' | 'Cylinder' | 'Sphere' | 'Torus' | 'Fillet' | 'Chamfer'
 *           | 'Shell' | 'Hole' | 'LinearPattern',
 *     id: 'box_x',                  // caller-chosen handle, NOT the kernel fid
 *     params: { length: 10, ... },  // primitive params (forwarded as-is)
 *     target: 'box_x',              // for modifiers/patterns — refers to a prior id
 *   }
 *
 * The helper:
 *   1. resets the document
 *   2. dispatches each spec entry to the matching v4 helper
 *   3. waits for a render after every step (so the next step can reference
 *      the freshly-emitted topology)
 *
 * Returns: { featureIds: { box_x: 'feat-<uuid>', ... } }
 *
 * Hard-fails (does NOT swallow) if:
 *   - an unknown type is supplied
 *   - a modifier references a target id that isn't in the running map
 *   - a render times out (kernel down / op rejected)
 */
export async function buildDoc(page, spec) {
  if (!Array.isArray(spec) || spec.length === 0) {
    throw new Error('buildDoc: spec must be a non-empty array');
  }

  await resetDocument(page);

  const featureIds = {};

  for (const step of spec) {
    if (!step || typeof step !== 'object') {
      throw new Error(`buildDoc: bad step ${JSON.stringify(step)}`);
    }
    const { type, id, params = {}, target } = step;
    if (!id) throw new Error(`buildDoc: step missing id (${type})`);

    let targetFid = null;
    if (target) {
      targetFid = featureIds[target];
      if (!targetFid) throw new Error(`buildDoc: step ${id} references unknown target "${target}"`);
    }

    const minted = await page.evaluate(([t, p, tFid]) => {
      const v4 = window.__paraform__.v4;
      let feature;
      switch (t) {
        case 'Box':      feature = v4.addBox(p); break;
        case 'Cylinder': feature = v4.addCylinder(p); break;
        case 'Sphere':   feature = v4.addSphere(p); break;
        case 'Torus':    feature = v4.addTorus(p); break;
        case 'Fillet':   feature = v4.addFillet(tFid, p); break;
        case 'Chamfer':  feature = v4.addChamfer(tFid, p); break;
        case 'Shell':    feature = v4.addShell(tFid, p); break;
        case 'Hole':     feature = v4.addHole(tFid, p); break;
        case 'LinearPattern':   feature = v4.addLinearPattern(tFid, p); break;
        case 'CircularPattern': feature = v4.addCircularPattern(tFid, p); break;
        default: throw new Error(`buildDoc: unsupported type "${t}"`);
      }
      if (!feature || !feature.id) throw new Error(`buildDoc: v4.add${t} returned no feature.id`);
      return feature.id;
    }, [type, params, targetFid]);

    featureIds[id] = minted;
    await waitForRender(page);
  }

  return { featureIds };
}

// ── Snapshot ─────────────────────────────────────────────────────────────────

/**
 * Snapshot every descriptor the topology index knows about, keyed by
 * feature id.
 *
 * Returns: Map<featureId, Set<canonicalString>>
 *
 * Reads `bridge.topologyIndex` (set on each successful render by
 * lib/document/bridge.js). Internally that's a Map<FeatureId,
 * { face: TopologyEntry[], edge: ..., vertex: ... }>. We collapse all
 * three kinds into a single Set per feature — the canonical string
 * already encodes `kind` so we don't lose information.
 *
 * Hard-fails if the topology index is missing or empty — that means the
 * last render did not produce topology, and an empty snapshot would
 * trivially "persist" on the next call, hiding the bug.
 */
export async function snapshotDescriptors(page) {
  const dump = await page.evaluate(() => {
    const bridge = window.__paraform__.getBridge();
    if (!bridge) return { error: 'no bridge' };
    const idx = bridge.topologyIndex;
    if (!idx) return { error: 'no topologyIndex (kernel did not return topology)' };

    const out = [];
    // idx is a Map; iterate.
    for (const [fid, buckets] of idx.entries()) {
      const set = [];
      for (const kind of ['face', 'edge', 'vertex']) {
        const entries = buckets?.[kind] || [];
        for (const e of entries) {
          // Use the same canonical form descriptor.js#stringify produces.
          // Inlined here to avoid pulling a module import into page eval —
          // the format is stable and load-bearing.
          const d = e?.descriptor;
          if (!d) continue;
          const stringify = (x) => {
            let head = `${x.kind}:${x.feature}:${x.opTag}:${x.part}`;
            if (x.parents && x.parents.length) {
              head += '(' + x.parents.map(stringify).join(',') + ')';
            }
            return head;
          };
          set.push(stringify(d));
        }
      }
      out.push([fid, set]);
    }
    return { error: null, entries: out };
  });

  if (dump.error) {
    throw new Error(`snapshotDescriptors: ${dump.error}`);
  }
  const map = new Map();
  let total = 0;
  for (const [fid, list] of dump.entries) {
    map.set(fid, new Set(list));
    total += list.length;
  }
  if (total === 0) {
    throw new Error('snapshotDescriptors: index has 0 descriptors — kernel returned empty topology');
  }
  return map;
}

// ── Sweep ────────────────────────────────────────────────────────────────────

/**
 * Mutate one parameter on a feature and wait for the re-render.
 *
 * Goes through `v4.setFeatureParams(featureId, patch)` — the same path
 * the properties panel uses, so undo/redo + change-log invariants stay
 * coherent.
 *
 * Hard-fails if the feature doesn't exist or the param doesn't exist on it.
 */
export async function sweepParameter(page, featureId, paramName, newValue) {
  await page.evaluate(([fid, name, value]) => {
    const v4 = window.__paraform__.v4;
    const store = window.__paraform__.getStore();
    const feature = store.doc.features?.[fid];
    if (!feature) throw new Error(`sweepParameter: no feature "${fid}"`);
    if (!(name in (feature.params || {}))) {
      throw new Error(`sweepParameter: feature ${fid} (${feature.type}) has no param "${name}"; known: ${Object.keys(feature.params || {}).join(',')}`);
    }
    v4.setFeatureParams(fid, { [name]: value });
  }, [featureId, paramName, newValue]);
  await waitForRender(page);
}

// ── Comparison + assertion ───────────────────────────────────────────────────

/**
 * Compare two snapshots and compute persistence stats.
 *
 * persistenceRate = (descriptors present in both before and after) /
 *                   (descriptors present in before)
 *
 * Edge cases:
 *   - if before is empty, persistenceRate = 1.0 (nothing to lose)
 *   - if a feature id disappears from `after`, every descriptor it
 *     contributed counts as missing (the feature itself was removed
 *     or replaced — that's a structural break)
 *
 * Returns:
 *   { persistenceRate, missing: Set<string>, added: Set<string>,
 *     beforeCount, afterCount }
 */
export function compareSnapshots(before, after) {
  const flattened = (snap) => {
    const out = new Set();
    for (const set of snap.values()) for (const s of set) out.add(s);
    return out;
  };
  const beforeAll = flattened(before);
  const afterAll = flattened(after);

  const missing = new Set();
  const added = new Set();
  for (const s of beforeAll) if (!afterAll.has(s)) missing.add(s);
  for (const s of afterAll) if (!beforeAll.has(s)) added.add(s);

  const persistenceRate = beforeAll.size === 0
    ? 1.0
    : (beforeAll.size - missing.size) / beforeAll.size;

  return {
    persistenceRate,
    missing,
    added,
    beforeCount: beforeAll.size,
    afterCount: afterAll.size,
  };
}

/**
 * Assert that the persistence rate clears `threshold` (default 0.95).
 *
 * Throws with a diagnostic message listing up to 5 missing descriptors —
 * enough to identify the regression without dumping a huge list.
 *
 * Returns the rate so the caller can attach it to telemetry.
 */
export function assertDescriptorsPersist(before, after, { threshold = 0.95 } = {}) {
  const cmp = compareSnapshots(before, after);
  if (cmp.persistenceRate + 1e-9 < threshold) {
    const sample = [...cmp.missing].slice(0, 5).map((s) => `    - ${s}`).join('\n');
    throw new Error(
      `descriptor persistence ${(cmp.persistenceRate * 100).toFixed(1)}% < threshold ${(threshold * 100).toFixed(1)}%\n` +
      `  before: ${cmp.beforeCount} descriptors, after: ${cmp.afterCount}\n` +
      `  ${cmp.missing.size} missing (${cmp.added.size} new appeared)\n` +
      (sample ? `  sample missing:\n${sample}` : '')
    );
  }
  return cmp.persistenceRate;
}
