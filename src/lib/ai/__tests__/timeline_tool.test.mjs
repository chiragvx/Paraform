/**
 * Phase C3 — AI timeline step-editing.
 *
 * Verifies:
 *   (a) get_timeline is registered and returns the features in build order
 *       with index + id + params;
 *   (b) editing an EARLIER step in place (setFeatureParams on step 0) takes
 *       effect and does NOT add a new feature — the agent's "edit the
 *       responsible step, don't append a duplicate" contract.
 *
 * Plain node asserts, relative imports, no loader.
 *   node src/lib/ai/__tests__/timeline_tool.test.mjs
 */
import assert from 'node:assert/strict';
import { dispatchTool, AGENT_TOOLS } from '../tools.js';
import { getDocumentStore, resetDocumentStore } from '../../../../lib/document/index.js';

let _pass = 0, _fail = 0;
async function t(name, fn) {
  try { await fn(); console.log(`  ok  ${name}`); _pass++; }
  catch (e) { console.error(`  FAIL ${name}\n    ${e?.stack || e?.message || e}`); _fail++; }
}

console.log('── Phase C3 — AI timeline step-editing (get_timeline + edit-in-place) ──');

await t('get_timeline is registered with a valid tool shape', () => {
  const tool = AGENT_TOOLS.find((x) => x.name === 'get_timeline');
  assert.ok(tool, 'get_timeline tool missing');
  assert.equal(typeof tool.description, 'string');
  assert.ok(tool.description.length > 0);
  assert.equal(tool.input_schema.type, 'object');
});

await t('get_timeline returns features in build order with index + id', async () => {
  resetDocumentStore();
  const a = await dispatchTool('addBox', { length: 10, width: 10, height: 5 });
  const b = await dispatchTool('addBox', { length: 4, width: 4, height: 8 });
  const res = await dispatchTool('get_timeline', {});
  assert.equal(res.ok, true);
  assert.equal(res.count, 2);
  assert.equal(res.steps[0].index, 0);
  assert.equal(res.steps[0].id, a.featureId);
  assert.equal(res.steps[1].id, b.featureId);
  assert.equal(res.steps[0].isBody, true);
});

await t('editing an EARLIER step in place mutates it without adding a feature', async () => {
  resetDocumentStore();
  const base = await dispatchTool('addBox', { length: 50, width: 50, height: 3 });
  await dispatchTool('addBox', { length: 10, width: 10, height: 20 });
  const countBefore = Object.keys(getDocumentStore().doc.features).length;

  // "make the base plate thicker" → patch step 0, do NOT append.
  const patch = await dispatchTool('setFeatureParams', { featureId: base.featureId, paramsPatch: { height: 6 } });
  assert.equal(patch.ok, true, `setFeatureParams failed: ${JSON.stringify(patch)}`);

  const countAfter = Object.keys(getDocumentStore().doc.features).length;
  assert.equal(countAfter, countBefore, 'editing an earlier step must NOT add a feature');
  assert.equal(getDocumentStore().doc.features[base.featureId].params.height, 6,
    'the earlier step was updated in place');
});

console.log(`\n${_pass} passed, ${_fail} failed`);
if (_fail > 0) process.exit(1);
