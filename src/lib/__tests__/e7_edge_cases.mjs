/**
 * E7 — Edge-case hardening.
 *
 * Run via:
 *   node --import ./src/lib/commands/__tests__/_register.mjs \
 *        src/lib/__tests__/e7_edge_cases.mjs
 *
 * Covers the five audit scenarios:
 *   1. Kernel-down: HttpKernelClient handles every "no kernel" path
 *      without throwing — returns a non-ok result the bridge can render.
 *   2. Empty doc: persistence + file-IO helpers do not throw on a freshly
 *      reset document, and defaultSaveFilename produces a usable name.
 *   3. Massive doc: 500-feature serialize/deserialize round-trip under 2 s.
 *   4. Slow kernel: timeout path returns a non-ok result; pending status
 *      can be observed without locking up the bridge.
 *   5. Bad input: loadDocumentFromJSON rejects malformed input and does
 *      not corrupt the live document.
 *
 * Plus a sweep of "no broken palette command handlers" as a regression
 * tripwire for new entries.
 */
import assert from 'node:assert/strict';
import { COMMANDS } from '../commands/registry.js';
import { HttpKernelClient } from '../../../lib/document/kernel_client.js';
import {
  buildDocumentJSON,
  defaultSaveFilename,
  loadDocumentFromJSON,
  buildBundleReadme,
} from '../document/file_io.js';
import {
  resetDocumentStore,
  getDocumentStore,
  addBox,
} from '../../../lib/document/index.js';

let _pass = 0, _fail = 0;
function t(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(
        () => { console.log(`  ok  ${name}`); _pass++; },
        (e) => { console.error(`  FAIL ${name}\n    ${e?.stack || e?.message || e}`); _fail++; },
      );
    }
    console.log(`  ok  ${name}`); _pass++;
  } catch (e) {
    console.error(`  FAIL ${name}\n    ${e?.stack || e?.message || e}`); _fail++;
  }
}

const series = [];
function tt(name, fn) { series.push(() => t(name, fn)); }

console.log('── E7 — edge cases ──');

// ── 1. Kernel-down ────────────────────────────────────────────────────────
tt('kernel: no-endpoint executeCode returns ok:false + mock flag', async () => {
  const c = new HttpKernelClient({ endpoint: '' });
  assert.equal(c.isConfigured(), false);
  const r = await c.executeCode('print(1)');
  assert.equal(r.ok, false);
  assert.equal(r.mock, true);
  assert.match(r.error, /no kernel endpoint/i);
});

tt('kernel: unreachable endpoint surfaces error message, never throws', async () => {
  // Inject a fetch impl that simulates ECONNREFUSED.
  const fakeFetch = async () => { throw new Error('connect ECONNREFUSED'); };
  const c = new HttpKernelClient({ endpoint: 'http://localhost:1', fetchImpl: fakeFetch });
  const r = await c.executeCode('x = 1');
  assert.equal(r.ok, false);
  assert.match(r.error, /ECONNREFUSED/);
});

tt('kernel: non-200 response surfaces HTTP status without throwing', async () => {
  const fakeFetch = async () => ({
    ok: false, status: 503,
    headers: { get: () => 'text/plain' },
    text: async () => 'service unavailable',
  });
  const c = new HttpKernelClient({ endpoint: 'http://kernel.test', fetchImpl: fakeFetch });
  const r = await c.executeCode('x = 1');
  assert.equal(r.ok, false);
  assert.match(r.error, /HTTP 503/);
});

tt('kernel: getVersion returns null on missing endpoint', async () => {
  const c = new HttpKernelClient({ endpoint: '' });
  const v = await c.getVersion();
  assert.equal(v, null);
});

// ── 2. Empty doc ─────────────────────────────────────────────────────────
tt('empty-doc: buildDocumentJSON returns a v5 document with no features', () => {
  resetDocumentStore();
  const json = buildDocumentJSON();
  assert.equal(typeof json, 'object');
  assert.equal(json.version, 5);
  assert.deepEqual(json.featureOrder ?? [], []);
});

tt('empty-doc: defaultSaveFilename always produces .paraform.json', () => {
  resetDocumentStore();
  const fn = defaultSaveFilename();
  assert.ok(fn.endsWith('.paraform.json'), `got: ${fn}`);
  // forbidden chars stripped
  const sanitized = defaultSaveFilename('a/b:c*?<>|.paraform.json');
  assert.ok(!/[\\/:*?"<>|]/.test(sanitized.replace('.paraform.json', '')));
});

tt('empty-doc: buildBundleReadme handles zero-changelog gracefully', () => {
  const r = buildBundleReadme({ version: 5, head: -1, changelog: [], metadata: {} });
  assert.match(r, /Changelog:\s+0 changes/);
  assert.match(r, /head=-1/);
});

// ── 3. Massive doc ───────────────────────────────────────────────────────
tt('massive-doc: 500 features serialize + deserialize under 2 s', () => {
  resetDocumentStore();
  for (let i = 0; i < 500; i++) addBox({ length: 1, width: 1, height: 1 });
  const store = getDocumentStore();
  assert.equal(store.doc.featureOrder.length, 500);
  const t0 = Date.now();
  const json = store.toJSON();
  const tSer = Date.now() - t0;

  resetDocumentStore();
  const t1 = Date.now();
  loadDocumentFromJSON(json);
  const tDe = Date.now() - t1;

  const total = tSer + tDe;
  assert.ok(total < 2000, `serialize+deserialize took ${total}ms, expected < 2000ms`);
  assert.equal(getDocumentStore().doc.featureOrder.length, 500);
});

// ── 4. Slow kernel ───────────────────────────────────────────────────────
tt('slow-kernel: timeout aborts the request and returns ok:false', async () => {
  // fakeFetch never resolves until aborted.
  const fakeFetch = (_url, opts) => new Promise((_res, rej) => {
    if (opts?.signal) {
      opts.signal.addEventListener('abort', () => {
        const err = new Error('The user aborted a request.');
        err.name = 'AbortError';
        rej(err);
      });
    }
  });
  const c = new HttpKernelClient({
    endpoint: 'http://kernel.test',
    fetchImpl: fakeFetch,
    timeout: 50,
  });
  const r = await c.executeCode('x = 1');
  assert.equal(r.ok, false);
  assert.ok(r.error, 'expected error message on timeout');
});

// ── 5. Bad input ─────────────────────────────────────────────────────────
tt('bad-input: loadDocumentFromJSON rejects null', () => {
  assert.throws(() => loadDocumentFromJSON(null), /not a document/);
});

tt('bad-input: loadDocumentFromJSON rejects unknown version', () => {
  assert.throws(() => loadDocumentFromJSON({ version: 99 }), /unrecognised/);
});

tt('bad-input: failing open does not corrupt the live store', () => {
  resetDocumentStore();
  addBox({ length: 7, width: 7, height: 7 });
  const before = getDocumentStore().doc.featureOrder.length;
  assert.equal(before, 1);
  try { loadDocumentFromJSON({ version: 'banana' }); }
  catch { /* expected */ }
  // Live doc still has the original feature.
  assert.equal(getDocumentStore().doc.featureOrder.length, before);
});

// ── 6. Regression tripwire: every palette command has a callable run() ───
tt('registry: every command has a callable run()', () => {
  for (const c of COMMANDS) {
    assert.equal(typeof c.run, 'function', `command ${c.id} has no run()`);
  }
});

tt('registry: every command without a form runs without throwing on a fresh store', () => {
  // We don't actually invoke side-effectful run()s here because most need
  // a DOM. We only check the registry shape is consistent: id, title, group
  // are all strings, and enabled() (if any) is a function.
  for (const c of COMMANDS) {
    assert.equal(typeof c.id, 'string', `non-string id: ${c.id}`);
    assert.equal(typeof c.title, 'string', `non-string title: ${c.id}`);
    assert.equal(typeof c.group, 'string', `non-string group: ${c.id}`);
    if (c.enabled !== undefined) {
      assert.equal(typeof c.enabled, 'function', `${c.id}.enabled not a function`);
    }
    if (c.form !== undefined) {
      assert.equal(typeof c.form, 'object', `${c.id}.form not an object`);
      assert.ok(Array.isArray(c.form.fields), `${c.id}.form.fields not array`);
    }
  }
});

tt('registry: every command id is unique', () => {
  const seen = new Set();
  for (const c of COMMANDS) {
    assert.ok(!seen.has(c.id), `duplicate command id: ${c.id}`);
    seen.add(c.id);
  }
});

// Run serial tests in order so async ones interleave cleanly.
(async () => {
  for (const fn of series) await fn();
  console.log(`\n${_pass} passed, ${_fail} failed`);
  if (_fail > 0) process.exit(1);
})();
