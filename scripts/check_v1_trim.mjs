// Verifies the v1 feature trim (GTM_EXECUTION.md Phase 1) in a real browser.
//
// Usage:
//   node scripts/check_v1_trim.mjs v1   http://localhost:4173
//   node scripts/check_v1_trim.mjs full http://localhost:4173
//
// `v1`  — expects hidden surfaces ABSENT (default build).
// `full` — expects them PRESENT (build with VITE_FULL_UI=1).

import { chromium } from 'playwright';

const mode = process.argv[2];
const base = process.argv[3] || 'http://localhost:4173';
if (mode !== 'v1' && mode !== 'full') {
  console.error('usage: check_v1_trim.mjs <v1|full> [baseUrl]');
  process.exit(2);
}

// Toolbar/TopBar titles gated behind the V1 flag.
const GATED = [
  'Sweep', 'Loft', 'Move Face', 'Delete Face', 'Offset Face', 'Draft',
  'Linear Pattern', 'Circular Pattern', 'Mirror', 'Align', 'interference between picked bodies',
  'Sketch', 'Import CAD', 'Script', 'Parameters',
];
// Hero surfaces that must exist in BOTH modes.
const KEPT = ['Box', 'Cylinder', 'Fillet', 'Chamfer', 'Shell', 'Hole',
  'Press', 'Union', 'Cut', 'Measure', 'Section', 'Export'];

const browser = await chromium.launch();
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));

await page.goto(`${base}/#/studio`, { waitUntil: 'networkidle' });
await page.waitForTimeout(2500); // settle: studio mounts panels async

const surface = await page.evaluate(() => {
  const titles = [...document.querySelectorAll('[title]')].map((e) => e.getAttribute('title'));
  const buttons = [...document.querySelectorAll('button')].map((b) => b.textContent.trim());
  return (titles.join('\n') + '\n' + buttons.join('\n'));
});

const found = (label) => surface.split('\n').some((s) => s.includes(label));

let failures = [];
for (const label of KEPT) {
  if (!found(label)) failures.push(`hero surface missing: "${label}"`);
}
for (const label of GATED) {
  const present = found(label);
  if (mode === 'v1' && present) failures.push(`gated surface leaked into v1: "${label}"`);
  if (mode === 'full' && !present) failures.push(`full UI missing: "${label}"`);
}
if (pageErrors.length) failures.push(`page errors: ${pageErrors.join(' | ')}`);

await browser.close();

if (failures.length) {
  console.error(`[${mode}] FAIL\n  ` + failures.join('\n  '));
  process.exit(1);
}
console.log(`[${mode}] OK — ${GATED.length} gated + ${KEPT.length} hero surfaces verified`);
