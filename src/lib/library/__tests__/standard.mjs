/**
 * Tests for the standard-parts client (src/lib/library/standard.js).
 *
 * Run with: `node src/lib/library/__tests__/standard.mjs`
 *
 * Strategy: mock globalThis.fetch with a recording stub, and stamp a fake
 * kernel client onto the singleton DocumentExecutor so the lazy endpoint
 * lookup inside standard.js returns a usable URL. insertEntry() is *not*
 * covered here — it touches three.js + the Svelte studio runtime, which
 * require browser / Vite runtime. The UI integration test is implicit in
 * the LibraryDialog rewrite.
 */

import assert from 'node:assert/strict';

// ── Bootstrap mocks BEFORE importing the module under test ─────────────────

let _fetchCalls = [];
let _fetchHandler = null;

globalThis.fetch = async (url, init) => {
    _fetchCalls.push({ url, init });
    if (!_fetchHandler) throw new Error('no _fetchHandler installed');
    return _fetchHandler(url, init);
};

function setFetch(handler) {
    _fetchCalls = [];
    _fetchHandler = handler;
}

// atob is available in Node 16+, but be explicit just in case the run host
// is older.
if (typeof globalThis.atob !== 'function') {
    globalThis.atob = (b64) => Buffer.from(b64, 'base64').toString('binary');
}

function makeJsonResponse(body, { ok = true, status = 200 } = {}) {
    return {
        ok,
        status,
        headers: {
            get: (h) => h.toLowerCase() === 'content-type' ? 'application/json' : null,
        },
        json: async () => body,
        text: async () => JSON.stringify(body),
        arrayBuffer: async () => new ArrayBuffer(0),
    };
}

// Stamp a fake kernel client onto the DocumentExecutor singleton so the
// lazy `getEndpoint()` inside standard.js resolves to a real URL.
const { getDocumentExecutor } = await import('../../../../lib/document/index.js');
getDocumentExecutor().setClient({
    endpoint: 'http://kernel.test',
    async executeCode() { return { ok: true }; },
});

// Now import the module under test.
const {
    fetchCatalog,
    fetchEntryGlb,
    clearCatalogCache,
    categoriesOf,
    filterEntries,
} = await import('../standard.js');

// ── Tiny test runner ────────────────────────────────────────────────────────

const _tests = [];
function test(name, fn) { _tests.push({ name, fn }); }
function beforeEach() {
    clearCatalogCache();
    _fetchCalls = [];
    _fetchHandler = null;
}
async function run() {
    let pass = 0, fail = 0;
    for (const t of _tests) {
        beforeEach();
        try {
            await t.fn();
            console.log(`  \x1b[32m✓\x1b[0m ${t.name}`);
            pass++;
        } catch (e) {
            console.log(`  \x1b[31m✗\x1b[0m ${t.name}`);
            console.log(`    ${e.stack || e.message}`);
            fail++;
        }
    }
    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail > 0) process.exit(1);
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const FIXTURE_ENTRIES = [
    {
        id: 'iso4762-m3-16',
        standard: 'ISO 4762',
        category: 'Fastener',
        nominalSize: 'M3',
        name: 'M3×16 SHCS',
        dims: { thread: 'M3', length: 16, headDiameter: 5.5 },
        metadata: { material: 'steel' },
    },
    {
        id: 'iso4032-m4',
        standard: 'ISO 4032',
        category: 'Fastener',
        nominalSize: 'M4',
        name: 'M4 Hex Nut',
        dims: { thread: 'M4', height: 3.2, width: 7 },
        metadata: { material: 'steel' },
    },
    {
        id: 'bearing-608',
        standard: '608',
        category: 'Bearing',
        nominalSize: '608',
        name: '608 Deep-Groove Ball Bearing',
        dims: { bore: 8, outerDiameter: 22, width: 7 },
        metadata: {},
    },
];

// ── Tests ───────────────────────────────────────────────────────────────────

test('fetchCatalog hits /library and parses the entries array', async () => {
    setFetch(async (url, init) => {
        assert.match(url, /\/library$/);
        assert.equal(init.method, 'GET');
        return makeJsonResponse({ ok: true, entries: FIXTURE_ENTRIES });
    });
    const entries = await fetchCatalog();
    assert.equal(entries.length, 3);
    assert.equal(entries[0].id, 'iso4762-m3-16');
    assert.equal(entries[2].category, 'Bearing');
    assert.equal(_fetchCalls.length, 1);
});

test('fetchCatalog caches: second call returns the same Promise reference', async () => {
    setFetch(async () => makeJsonResponse({ ok: true, entries: FIXTURE_ENTRIES }));
    const p1 = fetchCatalog();
    const p2 = fetchCatalog();
    assert.equal(p1, p2, 'cache should return the same Promise instance');
    await p1;
    // Even after resolution, only one network call should have happened.
    assert.equal(_fetchCalls.length, 1);
    // And a *third* call (post-resolution) still uses the same cached promise.
    const p3 = fetchCatalog();
    assert.equal(p3, p1);
    assert.equal(_fetchCalls.length, 1);
});

test('fetchCatalog clears its cache on error so retries can succeed', async () => {
    setFetch(async () => makeJsonResponse({ ok: false, error: 'boom' }, { ok: false, status: 500 }));
    await assert.rejects(() => fetchCatalog());
    // Next call: succeed.
    setFetch(async () => makeJsonResponse({ ok: true, entries: FIXTURE_ENTRIES }));
    const entries = await fetchCatalog();
    assert.equal(entries.length, 3);
});

test('fetchEntryGlb base64-decodes the payload into an ArrayBuffer', async () => {
    // "hello" → base64 'aGVsbG8='
    const b64 = 'aGVsbG8=';
    setFetch(async (url) => {
        assert.match(url, /\/library\/bearing-608$/);
        return makeJsonResponse({
            ok: true,
            entry: FIXTURE_ENTRIES[2],
            glbBase64: b64,
        });
    });
    const buf = await fetchEntryGlb('bearing-608');
    assert.ok(buf instanceof ArrayBuffer);
    assert.equal(buf.byteLength, 5);
    const bytes = new Uint8Array(buf);
    assert.deepEqual(Array.from(bytes), [0x68, 0x65, 0x6c, 0x6c, 0x6f]);
});

test('fetchEntryGlb caches by entryId: second call skips the network', async () => {
    let n = 0;
    setFetch(async () => {
        n++;
        return makeJsonResponse({ ok: true, entry: {}, glbBase64: 'AAAA' });
    });
    const b1 = await fetchEntryGlb('foo');
    const b2 = await fetchEntryGlb('foo');
    assert.equal(b1, b2, 'cached ArrayBuffer should be the same instance');
    assert.equal(n, 1);
});

test('categoriesOf returns sorted, unique categories', () => {
    const cats = categoriesOf(FIXTURE_ENTRIES);
    assert.deepEqual(cats, ['Bearing', 'Fastener']);
});

test('categoriesOf ignores entries with missing/blank category', () => {
    const cats = categoriesOf([
        { category: 'Fastener' },
        { category: '' },
        { category: null },
        { /* no category */ },
        { category: 'Bearing' },
    ]);
    assert.deepEqual(cats, ['Bearing', 'Fastener']);
});

test('filterEntries by category restricts to that category', () => {
    const out = filterEntries(FIXTURE_ENTRIES, { category: 'Fastener' });
    assert.equal(out.length, 2);
    assert.ok(out.every(e => e.category === 'Fastener'));
});

test('filterEntries query matches name, standard, and nominal size (case-insensitive)', () => {
    assert.equal(filterEntries(FIXTURE_ENTRIES, { query: '4762' }).length, 1);
    assert.equal(filterEntries(FIXTURE_ENTRIES, { query: 'm3' }).length, 1);
    assert.equal(filterEntries(FIXTURE_ENTRIES, { query: 'hex' }).length, 1);
    assert.equal(filterEntries(FIXTURE_ENTRIES, { query: '608' }).length, 1);
    assert.equal(filterEntries(FIXTURE_ENTRIES, { query: 'NUT' }).length, 1);
});

test('filterEntries category + query compose', () => {
    const out = filterEntries(FIXTURE_ENTRIES, { category: 'Fastener', query: 'M4' });
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 'iso4032-m4');
});

test('filterEntries handles empty / null input safely', () => {
    assert.deepEqual(filterEntries([], { query: 'x' }), []);
    assert.deepEqual(filterEntries(null, { query: 'x' }), []);
    assert.deepEqual(filterEntries(FIXTURE_ENTRIES, {}).length, FIXTURE_ENTRIES.length);
});

// ── Go ──────────────────────────────────────────────────────────────────────

await run();
