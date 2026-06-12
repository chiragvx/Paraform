/**
 * Assertion + command-runner library for smoke cases.
 *
 * Each helper takes the Playwright `page` and reaches through
 * `window.__paraform__` to interact with the studio runtime. Assertions
 * throw `Error` with a useful message on failure; the harness catches.
 *
 * Convention: all assertions are *page.evaluate-driven* — no waits inside
 * the helper; callers compose with `waitForRender` / `waitForFeature` /
 * sleep helpers where async settling matters.
 */

const RENDER_WAIT_MS = 10_000;

// ── Document / command primitives ────────────────────────────────────────────

/** Reset the document — clears all features and seeds an empty doc. */
export async function resetDocument(page) {
  await page.evaluate(() => {
    window.__paraform__.v4.resetDocument();
  });
  await waitForRender(page);
}

/** Run a registry command by id. Params object passed through to cmd.run. */
export async function runCommand(page, id, params = undefined) {
  await page.evaluate(([cmdId, p]) => {
    window.__paraform__.runCommand(cmdId, p);
  }, [id, params]);
}

/** Call a v4.* helper directly (e.g. v4.addBox, v4.addExtrude). */
export async function v4Call(page, fn, ...args) {
  await page.evaluate(([f, a]) => {
    const v4 = window.__paraform__.v4;
    if (typeof v4[f] !== 'function') throw new Error(`v4.${f} is not a function`);
    return v4[f](...a);
  }, [fn, args]);
}

/** Wait until the kernel produces at least N renders since this call. */
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

/** Wait until a specific featureId exists in the document. */
export async function waitForFeature(page, fid, timeoutMs = 5_000) {
  await page.waitForFunction(
    (id) => !!window.__paraform__.getStore().doc.features?.[id],
    fid,
    { timeout: timeoutMs },
  );
}

// ── Assertions ───────────────────────────────────────────────────────────────

/** Count of features whose type matches `type` and that are enabled. */
export async function assertFeaturePresent(page, type, atLeast = 1) {
  const found = await page.evaluate((t) => {
    const features = window.__paraform__.getStore().doc.features || {};
    return Object.values(features).filter((f) => f.type === t && f.enabled !== false).length;
  }, type);
  if (found < atLeast) {
    throw new Error(`assertFeaturePresent(${type}, ${atLeast}): found ${found}`);
  }
}

/** Number of features in the document timeline. */
export async function assertFeatureCount(page, expected) {
  const n = await page.evaluate(() => Object.keys(window.__paraform__.getStore().doc.features || {}).length);
  if (n !== expected) throw new Error(`assertFeatureCount: expected ${expected}, got ${n}`);
}

/** Count of features that emit at least one body and aren't disabled. */
export async function assertBodyEmittingCount(page, expected) {
  const n = await page.evaluate(() => {
    const features = Object.values(window.__paraform__.getStore().doc.features || {});
    return features.filter((f) =>
      f.enabled !== false &&
      Array.isArray(f.outputs?.bodies) &&
      f.outputs.bodies.length > 0
    ).length;
  });
  if (n !== expected) throw new Error(`assertBodyEmittingCount: expected ${expected}, got ${n}`);
}

/** The kernel emitted no error chip on the last render. */
export async function assertNoKernelError(page) {
  const err = await page.evaluate(() => {
    // Bridge surface — see lib/document/bridge.js for the actual error path.
    const bridge = window.__paraform__.getBridge();
    return bridge?.lastError ?? null;
  });
  if (err && !/no bodies in __paraform_result__/i.test(String(err))) {
    throw new Error(`assertNoKernelError: ${err}`);
  }
}

/** Bridge's lastCompileMs > 0 — proves a kernel call happened at least once. */
export async function assertKernelRan(page) {
  const ms = await page.evaluate(() => window.__paraform__.getBridge()?.lastCompileMs ?? 0);
  if (!ms || ms <= 0) throw new Error(`assertKernelRan: no successful kernel call (lastCompileMs=${ms})`);
}

/** Bounding box of the live body group falls within [minTol, maxTol] mm per axis. */
export async function assertBodyBBoxApprox(page, expectedMin, expectedMax, tolerance = 1.0) {
  const got = await page.evaluate(() => {
    const bridge = window.__paraform__.getBridge();
    const root = bridge?.bodyTransform;
    if (!root) return null;
    // Build a Box3 by traversing children (avoid pulling THREE into the
    // smoke runner explicitly — we read the userData min/max if the
    // bridge exposes it, else compute via attributes).
    let min = [Infinity, Infinity, Infinity];
    let max = [-Infinity, -Infinity, -Infinity];
    root.traverse?.((node) => {
      if (!node.isMesh || !node.geometry) return;
      const g = node.geometry;
      g.computeBoundingBox?.();
      if (!g.boundingBox) return;
      const wm = node.matrixWorld;
      // Transform each of the 8 bbox corners by world matrix to get a
      // world-space AABB.
      const { min: bmin, max: bmax } = g.boundingBox;
      const corners = [
        [bmin.x, bmin.y, bmin.z], [bmax.x, bmin.y, bmin.z],
        [bmin.x, bmax.y, bmin.z], [bmax.x, bmax.y, bmin.z],
        [bmin.x, bmin.y, bmax.z], [bmax.x, bmin.y, bmax.z],
        [bmin.x, bmax.y, bmax.z], [bmax.x, bmax.y, bmax.z],
      ];
      const e = wm.elements;
      for (const c of corners) {
        const x = e[0]*c[0] + e[4]*c[1] + e[ 8]*c[2] + e[12];
        const y = e[1]*c[0] + e[5]*c[1] + e[ 9]*c[2] + e[13];
        const z = e[2]*c[0] + e[6]*c[1] + e[10]*c[2] + e[14];
        if (x < min[0]) min[0] = x; if (y < min[1]) min[1] = y; if (z < min[2]) min[2] = z;
        if (x > max[0]) max[0] = x; if (y > max[1]) max[1] = y; if (z > max[2]) max[2] = z;
      }
    });
    if (!isFinite(min[0])) return null;
    return { min, max };
  });
  if (!got) throw new Error('assertBodyBBoxApprox: no body in scene');
  for (let i = 0; i < 3; i++) {
    if (Math.abs(got.min[i] - expectedMin[i]) > tolerance) {
      throw new Error(`assertBodyBBoxApprox: min[${i}] off — expected ~${expectedMin[i]}, got ${got.min[i].toFixed(2)}`);
    }
    if (Math.abs(got.max[i] - expectedMax[i]) > tolerance) {
      throw new Error(`assertBodyBBoxApprox: max[${i}] off — expected ~${expectedMax[i]}, got ${got.max[i].toFixed(2)}`);
    }
  }
}

/** A selected feature exists and its id matches an optional predicate. */
export async function assertSelectedFeature(page, predicate = () => true) {
  const ok = await page.evaluate((src) => {
    const store = window.__paraform__.getStore();
    const id = store.selectedFeatureId();
    if (!id) return null;
    const f = store.doc.features[id];
    if (!f) return null;
    // eslint-disable-next-line no-new-func
    const fn = new Function('f', `return (${src})(f);`);
    return fn(f);
  }, predicate.toString());
  if (!ok) throw new Error('assertSelectedFeature: no selection or predicate failed');
}
