/**
 * Tests for the JS measure API (src/lib/measure/api.js).
 *
 * Run with: `node src/lib/measure/__tests__/api.mjs`
 *
 * Strategy: mock `globalThis.fetch` with a recording stub, and stamp a fake
 * kernel client onto the singleton executor so endpoint resolution succeeds.
 * `globalThis.__paraformBridge` stands in for the real DocumentViewportBridge
 * so we can control `bridge.lastCompileMs` (the cache invalidation key)
 * directly from the tests.
 */

import assert from 'node:assert/strict';

// ── Bootstrap mocks BEFORE importing api.js ──────────────────────────────────
// (api.js reads `globalThis.fetch` lazily on each call, and looks the bridge
// up at call time too, so module-load order isn't strict — but we set them
// here to be explicit.)

globalThis.__paraformBridge = { lastCompileMs: 100 };

let _fetchCalls = [];
let _fetchHandler = null; // (url, init) → Response-like

globalThis.fetch = async (url, init) => {
    _fetchCalls.push({ url, init });
    if (!_fetchHandler) throw new Error('no _fetchHandler installed');
    return _fetchHandler(url, init);
};

function setFetch(handler) {
    _fetchCalls = [];
    _fetchHandler = handler;
}

function makeJsonResponse(body, { ok = true, status = 200 } = {}) {
    return {
        ok,
        status,
        headers: { get: (h) => h.toLowerCase() === 'content-type' ? 'application/json' : null },
        json: async () => body,
        text: async () => JSON.stringify(body),
        arrayBuffer: async () => new ArrayBuffer(0),
    };
}

// Stamp a fake kernel client onto the executor so api.js's `getKernelClient()`
// resolves an endpoint.
const { getDocumentExecutor } = await import('../../../../lib/document/index.js');
getDocumentExecutor().setClient({
    endpoint: 'http://kernel.test',
    async executeCode() { return { ok: true }; },
});

// Now import the module under test.
const { measure, invalidateCache, getCacheStats, _resetForTests,
        createMeasureSession,
        asBbox, asVolume, asMass, asHoles } = await import('../api.js');

// ── Tiny test runner ─────────────────────────────────────────────────────────

const _tests = [];
function test(name, fn) { _tests.push({ name, fn }); }
function beforeEach() {
    _resetForTests();
    globalThis.__paraformBridge.lastCompileMs = 100;
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

// ── Tests ────────────────────────────────────────────────────────────────────

test('single-query call posts correct body shape and URL', async () => {
    setFetch(async (url, init) => {
        assert.match(url, /\/measure$/);
        assert.equal(init.method, 'POST');
        assert.equal(init.headers['Content-Type'], 'application/json');
        const body = JSON.parse(init.body);
        assert.deepEqual(body, { queries: [{ type: 'bbox', featureId: 'a' }] });
        return makeJsonResponse({
            ok: true,
            results: [{ ok: true, min: [0,0,0], max: [10,10,10], size: [10,10,10] }],
            kernelVersion: { build123d: '0.x' },
        });
    });
    const r = await measure({ type: 'bbox', featureId: 'a' });
    assert.equal(r.ok, true);
    assert.deepEqual(r.size, [10,10,10]);
    assert.equal(_fetchCalls.length, 1);

    const bbox = asBbox(r);
    assert.deepEqual(bbox.min, [0,0,0]);
});

test('batched queries POST a list and return a list', async () => {
    setFetch(async (_url, init) => {
        const body = JSON.parse(init.body);
        assert.equal(body.queries.length, 2);
        return makeJsonResponse({
            ok: true,
            results: [
                { ok: true, volume: 1000 },
                { ok: true, mass: 1.0 },
            ],
        });
    });
    const out = await measure([
        { type: 'volume', featureId: 'a' },
        { type: 'mass',   featureId: 'a' },
    ]);
    assert.equal(Array.isArray(out), true);
    assert.equal(out.length, 2);
    assert.equal(asVolume(out[0]), 1000);
    assert.equal(asMass(out[1]), 1.0);
});

test('per-query failure surfaces as {ok:false} result, does not throw', async () => {
    setFetch(async () => makeJsonResponse({
        ok: true,
        results: [
            { ok: true,  volume: 1000 },
            { ok: false, error: 'feature not found' },
        ],
    }));
    const out = await measure([
        { type: 'volume', featureId: 'a' },
        { type: 'volume', featureId: 'missing' },
    ]);
    assert.equal(out[0].ok, true);
    assert.equal(out[1].ok, false);
    assert.equal(out[1].error, 'feature not found');
    // Helpers return null on failed results.
    assert.equal(asVolume(out[1]), null);
});

test('cache hit on repeated identical query within same lastCompileMs', async () => {
    let calls = 0;
    setFetch(async () => {
        calls++;
        return makeJsonResponse({
            ok: true,
            results: [{ ok: true, volume: 500 }],
        });
    });
    const q = { type: 'volume', featureId: 'a' };
    await measure(q);
    await measure(q);
    await measure(q);
    assert.equal(calls, 1, 'only first call should hit the network');
    const stats = getCacheStats();
    assert.equal(stats.hits, 2);
    assert.equal(stats.misses, 1);
});

test('cache miss after bridge.lastCompileMs changes', async () => {
    let calls = 0;
    setFetch(async () => {
        calls++;
        return makeJsonResponse({
            ok: true,
            results: [{ ok: true, volume: 500 + calls }],
        });
    });
    const q = { type: 'volume', featureId: 'a' };
    const a = await measure(q);
    assert.equal(asVolume(a), 501);

    // Simulate a new render — lastCompileMs changes → new cache key.
    globalThis.__paraformBridge.lastCompileMs = 200;
    const b = await measure(q);
    assert.equal(asVolume(b), 502);
    assert.equal(calls, 2);
});

test('LRU eviction at 200-entry cap', async () => {
    setFetch(async (_url, init) => {
        const body = JSON.parse(init.body);
        return makeJsonResponse({
            ok: true,
            results: body.queries.map((q) => ({ ok: true, volume: q.featureId })),
        });
    });
    // Fill the cache to exactly cap.
    for (let i = 0; i < 200; i++) {
        await measure({ type: 'volume', featureId: i });
    }
    assert.equal(getCacheStats().entries, 200);

    // One more — evicts the oldest (featureId 0).
    await measure({ type: 'volume', featureId: 200 });
    assert.equal(getCacheStats().entries, 200);

    // Re-querying featureId 0 should be a miss now (evicted).
    const before = getCacheStats().misses;
    await measure({ type: 'volume', featureId: 0 });
    const after = getCacheStats().misses;
    assert.equal(after, before + 1, 'evicted entry should re-miss');

    // featureId 200 should still be cached (most recently used).
    const beforeHits = getCacheStats().hits;
    await measure({ type: 'volume', featureId: 200 });
    assert.equal(getCacheStats().hits, beforeHits + 1);
});

test('invalidateCache() clears everything', async () => {
    setFetch(async () => makeJsonResponse({
        ok: true,
        results: [{ ok: true, volume: 1 }],
    }));
    const q = { type: 'volume', featureId: 'z' };
    await measure(q);
    assert.equal(getCacheStats().entries, 1);
    invalidateCache();
    assert.equal(getCacheStats().entries, 0);
    // Next call re-hits the network.
    await measure(q);
    assert.equal(getCacheStats().misses, 2);
});

test('stats tracking: mixed batch with hits + misses', async () => {
    let calls = 0;
    setFetch(async (_url, init) => {
        calls++;
        const body = JSON.parse(init.body);
        // Server only receives the *misses* on the second batched call.
        return makeJsonResponse({
            ok: true,
            results: body.queries.map((q) => ({ ok: true, volume: 10 + q.featureId })),
        });
    });
    // Prime the cache with two queries.
    await measure([
        { type: 'volume', featureId: 1 },
        { type: 'volume', featureId: 2 },
    ]);
    assert.equal(calls, 1);
    let stats = getCacheStats();
    assert.equal(stats.misses, 2);
    assert.equal(stats.hits, 0);

    // Mixed batch: two cached + two fresh. Network should only see the fresh
    // two, and the cached two should slot back into the right positions.
    const out = await measure([
        { type: 'volume', featureId: 3 }, // miss
        { type: 'volume', featureId: 1 }, // hit
        { type: 'volume', featureId: 4 }, // miss
        { type: 'volume', featureId: 2 }, // hit
    ]);
    assert.equal(calls, 2);
    assert.equal(asVolume(out[0]), 13);
    assert.equal(asVolume(out[1]), 11);
    assert.equal(asVolume(out[2]), 14);
    assert.equal(asVolume(out[3]), 12);
    stats = getCacheStats();
    assert.equal(stats.hits, 2);
    assert.equal(stats.misses, 4);
});

test('HTTP failure throws with status', async () => {
    setFetch(async () => ({
        ok: false,
        status: 500,
        headers: { get: () => 'text/plain' },
        json: async () => { throw new Error('not json'); },
        text: async () => 'kernel boom',
        arrayBuffer: async () => new ArrayBuffer(0),
    }));
    await assert.rejects(
        () => measure({ type: 'bbox', featureId: 'x' }),
        /measure HTTP 500/,
    );
});

test('batch-level {ok:false} throws', async () => {
    setFetch(async () => makeJsonResponse({
        ok: false,
        error: 'no current document',
    }));
    await assert.rejects(
        () => measure({ type: 'bbox', featureId: 'x' }),
        /measure: no current document/,
    );
});

// ── createMeasureSession ─────────────────────────────────────────────────────

test('session coalesces 3 same-tick calls into 1 POST with batched body', async () => {
    setFetch(async (url, init) => {
        const body = JSON.parse(init.body);
        assert.equal(body.queries.length, 3);
        return makeJsonResponse({
            ok: true,
            results: [
                { ok: true, volume: 1 },
                { ok: true, volume: 2 },
                { ok: true, volume: 3 },
            ],
        });
    });
    const session = createMeasureSession();
    const [r1, r2, r3] = await Promise.all([
        session.measure({ type: 'volume', featureId: 'a' }),
        session.measure({ type: 'volume', featureId: 'b' }),
        session.measure({ type: 'volume', featureId: 'c' }),
    ]);
    assert.equal(_fetchCalls.length, 1);
    assert.equal(r1.volume, 1);
    assert.equal(r2.volume, 2);
    assert.equal(r3.volume, 3);
});

test('session hits cache without POSTing when entry already cached', async () => {
    // Prime the cache with one direct call.
    setFetch(async () => makeJsonResponse({
        ok: true,
        results: [{ ok: true, volume: 42 }],
    }));
    await measure({ type: 'volume', featureId: 'a' });
    assert.equal(_fetchCalls.length, 1);

    // Now a session call for the same query (same compileMs) must NOT POST.
    setFetch(async () => { throw new Error('should not be called'); });
    const session = createMeasureSession();
    const r = await session.measure({ type: 'volume', featureId: 'a' });
    assert.equal(r.volume, 42);
    assert.equal(_fetchCalls.length, 0);
});

test('session mixes cache hits + misses in same wave; only misses go to POST', async () => {
    // Prime cache for 'a' only.
    setFetch(async () => makeJsonResponse({
        ok: true,
        results: [{ ok: true, volume: 100 }],
    }));
    await measure({ type: 'volume', featureId: 'a' });

    // Now session asks for 'a' (cached) + 'b' (miss). Expect 1 POST with
    // just the miss in the body.
    setFetch(async (url, init) => {
        const body = JSON.parse(init.body);
        assert.equal(body.queries.length, 1);
        assert.equal(body.queries[0].featureId, 'b');
        return makeJsonResponse({
            ok: true,
            results: [{ ok: true, volume: 200 }],
        });
    });
    const session = createMeasureSession();
    const [ra, rb] = await Promise.all([
        session.measure({ type: 'volume', featureId: 'a' }),
        session.measure({ type: 'volume', featureId: 'b' }),
    ]);
    assert.equal(ra.volume, 100);
    assert.equal(rb.volume, 200);
    assert.equal(_fetchCalls.length, 1);
});

test('session: transport failure rejects every pending entry', async () => {
    setFetch(async () => ({
        ok: false,
        status: 500,
        headers: { get: () => null },
        text: async () => 'kernel down',
        json: async () => ({}),
        arrayBuffer: async () => new ArrayBuffer(0),
    }));
    const session = createMeasureSession();
    const promises = [
        session.measure({ type: 'volume', featureId: 'a' }),
        session.measure({ type: 'volume', featureId: 'b' }),
    ];
    for (const p of promises) {
        await assert.rejects(() => p, /measure HTTP 500/);
    }
});

test('session: results map back to the correct query by position', async () => {
    setFetch(async () => makeJsonResponse({
        ok: true,
        results: [
            { ok: true, volume: 10 },
            { ok: true, volume: 20 },
            { ok: true, volume: 30 },
        ],
    }));
    const session = createMeasureSession();
    // Resolve in interleaved order to verify each promise gets its own slot.
    const p2 = session.measure({ type: 'volume', featureId: 'second' });
    const p1 = session.measure({ type: 'volume', featureId: 'first' });
    const p3 = session.measure({ type: 'volume', featureId: 'third' });
    const [r2, r1, r3] = await Promise.all([p2, p1, p3]);
    assert.equal(r2.volume, 10);
    assert.equal(r1.volume, 20);
    assert.equal(r3.volume, 30);
});

test('session: queries enqueued after a flush start a new wave', async () => {
    let waveNum = 0;
    setFetch(async (url, init) => {
        waveNum++;
        const body = JSON.parse(init.body);
        const results = body.queries.map((q) => ({ ok: true, volume: waveNum * 100 }));
        return makeJsonResponse({ ok: true, results });
    });
    const session = createMeasureSession();
    const r1 = await session.measure({ type: 'volume', featureId: 'a' });
    // First wave done — second call must trigger a fresh POST.
    const r2 = await session.measure({ type: 'volume', featureId: 'b' });
    assert.equal(_fetchCalls.length, 2);
    assert.equal(r1.volume, 100);
    assert.equal(r2.volume, 200);
});

test('asHoles + typed helpers return null on failed result', async () => {
    setFetch(async () => makeJsonResponse({
        ok: true,
        results: [{ ok: false, error: 'no holes' }],
    }));
    const r = await measure({ type: 'holes', featureId: 'a' });
    assert.equal(asHoles(r), null);
    assert.equal(asBbox(r), null);
    assert.equal(asMass(r), null);
});

await run();
