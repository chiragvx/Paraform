/**
 * Stability eval harness — boots the vite dev server, opens a Playwright
 * Chromium page, and runs registered cases. Mirrors tests/smoke/harness.mjs
 * deliberately: the boot/teardown shape, the test hook contract
 * (`window.__paraform__`), and the per-case fresh-page convention are the
 * same. The only difference is *what* the cases assert — stability cases
 * build a doc, snapshot every descriptor, sweep a parameter, and verify
 * the descriptor set persists.
 *
 * Kernel URL
 * ──────────
 * Stability cases ALL need a live kernel (no exceptions — every case
 * compiles a parametric document and re-compiles it after a parameter
 * mutation). Default:
 *
 *   python b123d_server/server.py            # in one shell
 *   VITE_ENGINE_URL=http://localhost:7823 npm run test:stability
 *
 * Without a reachable kernel every case times out at render-wait —
 * unlike smoke there is no kernel-free case to act as a self-check.
 *
 * This module re-uses the smoke harness pattern rather than importing
 * from it so the two harnesses can evolve independently — smoke is about
 * "does the kernel still work" and stability is about "does naming
 * survive a parameter sweep". Different failure modes, different
 * timeouts, different verbosity defaults.
 */

import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const PORT = 1421; // distinct from smoke (1420) so both can coexist locally
const ORIGIN = `http://127.0.0.1:${PORT}`;
const STUDIO_URL = `${ORIGIN}/#/studio`;
const SERVER_READY_TIMEOUT_MS = 30_000;
const PAGE_READY_TIMEOUT_MS = 20_000;

export async function startDevServer({ silent = true } = {}) {
  const proc = spawn(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['vite', '--port', String(PORT), '--strictPort'],
    { stdio: silent ? ['ignore', 'pipe', 'pipe'] : 'inherit', shell: process.platform === 'win32' },
  );

  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(ORIGIN);
      if (res.ok || res.status === 304) return proc;
    } catch { /* not up yet */ }
    await delay(250);
  }
  proc.kill();
  throw new Error(`vite dev server did not come up on ${ORIGIN} within ${SERVER_READY_TIMEOUT_MS}ms`);
}

export async function stopDevServer(proc) {
  if (!proc) return;
  proc.kill();
  await delay(300);
}

export async function openPage() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('pageerror', (err) => console.error('  [page error]', err.message));
  page.on('console', (msg) => {
    const t = msg.type();
    if (t === 'error' || t === 'warning') console.error(`  [page ${t}]`, msg.text());
  });
  await page.goto(STUDIO_URL, { waitUntil: 'load' });
  await page.waitForFunction(
    () => window.__paraform__ && window.__paraform__.ready === true,
    null,
    { timeout: PAGE_READY_TIMEOUT_MS },
  );
  return { browser, page };
}

export async function closePage(handle) {
  if (!handle) return;
  await handle.browser.close();
}

/**
 * Runs the given cases against a fresh page each. Returns:
 *   { passed, failed, results: [{ name, ok, error?, durationMs, rate? }] }
 *
 * Each case may attach a `rate` (persistence rate ∈ [0,1]) to its result
 * via `case.run` returning a number — the runner surfaces it for the
 * stability metric summary.
 */
export async function runCases(cases) {
  const results = [];
  for (const c of cases) {
    const handle = await openPage();
    const t0 = Date.now();
    try {
      const ret = await c.run(handle.page);
      const rate = typeof ret === 'number' && Number.isFinite(ret) ? ret : undefined;
      results.push({ name: c.name, ok: true, durationMs: Date.now() - t0, rate });
      const rateStr = rate != null ? ` rate=${(rate * 100).toFixed(1)}%` : '';
      console.log(`  \x1b[32m✓\x1b[0m ${c.name} (${Date.now() - t0}ms)${rateStr}`);
    } catch (err) {
      results.push({ name: c.name, ok: false, error: err.message, durationMs: Date.now() - t0 });
      console.log(`  \x1b[31m✗\x1b[0m ${c.name} (${Date.now() - t0}ms)`);
      console.log(`    ${err.message}`);
    } finally {
      await closePage(handle);
    }
  }
  return {
    passed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  };
}
