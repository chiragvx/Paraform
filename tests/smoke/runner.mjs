#!/usr/bin/env node
/**
 * Smoke harness entry. `npm run test:smoke` invokes this.
 *
 * Spins the vite dev server (port 1420), opens a Playwright Chromium per
 * case, runs each, reports, exits non-zero on any failure.
 */
import { startDevServer, stopDevServer, runCases } from './harness.mjs';
import { cases } from './cases/index.mjs';

const t0 = Date.now();
console.log(`smoke: launching vite dev server…`);
let server;
let code = 0;
try {
  server = await startDevServer({ silent: !process.env.SMOKE_VERBOSE });
  console.log(`smoke: dev server up, running ${cases.length} case${cases.length === 1 ? '' : 's'}`);
  const { passed, failed, results } = await runCases(cases);
  const total = Date.now() - t0;
  console.log(`\nsmoke: ${passed} passed, ${failed} failed (${total}ms total)`);
  code = failed > 0 ? 1 : 0;
  if (failed > 0) {
    console.log('\nfailures:');
    for (const r of results.filter((x) => !x.ok)) {
      console.log(`  - ${r.name}: ${r.error}`);
    }
  }
} catch (err) {
  console.error(`smoke: harness error: ${err.message}`);
  code = 2;
} finally {
  await stopDevServer(server);
}
process.exit(code);
