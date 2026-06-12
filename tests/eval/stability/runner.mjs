#!/usr/bin/env node
/**
 * Stability eval entry. `npm run test:stability` invokes this.
 *
 * Spins the vite dev server (port 1421 — distinct from smoke's 1420),
 * opens a Playwright Chromium per case, runs each, reports pass/fail and
 * the persistence-rate metric, exits non-zero on any failure.
 *
 * The stability metric (median + min persistence rate across all
 * cases) is the headline figure for spec 14 — it's how we know the
 * resolver hardening is working end-to-end.
 */
import { startDevServer, stopDevServer, runCases } from './harness.mjs';
import { cases } from './cases/index.mjs';

const t0 = Date.now();
console.log(`stability: launching vite dev server…`);
let server;
let code = 0;
try {
  server = await startDevServer({ silent: !process.env.STABILITY_VERBOSE });
  console.log(`stability: dev server up, running ${cases.length} case${cases.length === 1 ? '' : 's'}`);
  const { passed, failed, results } = await runCases(cases);
  const total = Date.now() - t0;

  // Aggregate the stability metric across passing cases.
  const rates = results.filter((r) => r.ok && typeof r.rate === 'number').map((r) => r.rate);
  rates.sort((a, b) => a - b);
  const median = rates.length ? rates[Math.floor(rates.length / 2)] : null;
  const min = rates.length ? rates[0] : null;

  console.log(`\nstability: ${passed} passed, ${failed} failed (${total}ms total)`);
  if (median != null) {
    console.log(`stability metric: median persistence ${(median * 100).toFixed(1)}%, min ${(min * 100).toFixed(1)}% (n=${rates.length})`);
  }
  code = failed > 0 ? 1 : 0;
  if (failed > 0) {
    console.log('\nfailures:');
    for (const r of results.filter((x) => !x.ok)) {
      console.log(`  - ${r.name}: ${r.error}`);
    }
  }
} catch (err) {
  console.error(`stability: harness error: ${err.message}`);
  code = 2;
} finally {
  await stopDevServer(server);
}
process.exit(code);
