/**
 * Smoke harness — boots the vite dev server, opens a Playwright Chromium
 * page against it, and runs registered cases. Designed to be called from
 * `tests/smoke/runner.mjs`; case files live under `tests/smoke/cases/`.
 *
 * The page exposes `window.__paraform__` (set in `src/main.js`) — the
 * assertion library at `tests/smoke/asserts.mjs` reaches through that
 * global to read document state.
 *
 * Kernel URL
 * ──────────
 * Cases that exercise kernel ops (every primitive / sketch / boolean /
 * modifier / pattern case) need a live kernel. By default the page uses
 * the cloudflare URL hardcoded in [index.html](../../index.html) — those
 * tunnels are ephemeral and frequently dead. To run against a local
 * kernel:
 *
 *   python b123d_server/server.py            # in one shell
 *   VITE_ENGINE_URL=http://localhost:7823 npm run test:smoke   # in another
 *
 * Vite passes VITE_ENGINE_URL through to import.meta.env, which
 * kernel_client.js reads first (see lib/document/kernel_client.js:31).
 *
 * Without a reachable kernel: every render-dependent case times out at
 * ~10s. One case (sketch enter/cancel) passes because it doesn't need
 * the kernel. That signal is the smoke harness's own self-check —
 * "harness boots, hook works, kernel is the bottleneck."
 */

import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const PORT = 1420;
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
  // Give it a moment to drop the port — strictPort fails subsequent runs otherwise.
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
 * Runs the given cases against a fresh page each. Returns { passed, failed,
 * results: [{ name, ok, error?, durationMs }] }.
 */
export async function runCases(cases) {
  const results = [];
  for (const c of cases) {
    const handle = await openPage();
    const t0 = Date.now();
    try {
      await c.run(handle.page);
      results.push({ name: c.name, ok: true, durationMs: Date.now() - t0 });
      console.log(`  \x1b[32m✓\x1b[0m ${c.name} (${Date.now() - t0}ms)`);
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
