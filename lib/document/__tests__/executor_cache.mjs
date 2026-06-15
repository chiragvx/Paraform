/**
 * Tests for the DocumentExecutor content-addressed result cache — the path
 * that makes redundant compiles (undo/redo, parameter toggles, metadata-only
 * edits) skip the kernel round-trip entirely and land in <10 ms.
 *
 * Run via:  node lib/document/__tests__/executor_cache.mjs
 *
 * These tests use LOCAL DocumentStore instances (never the module singleton)
 * because they await `executeDocument` between store mutations — the aggregate
 * runner (all.mjs) interleaves files' async `runAll()`s, and a singleton store
 * would let a sibling file's reset corrupt a doc mid-await.
 */

import assert from 'node:assert/strict';
import { DocumentExecutor } from '../executor.js';
import {
    DocumentStore, makeFeature,
    addFeatureChange, setParamsChange,
} from '../index.js';

const _tests = [];
let _suite = '';
function suite(name, fn) { _suite = name; fn(); _suite = ''; }
function test(name, fn)  { _tests.push({ suite: _suite, name, fn }); }
async function runAll() {
    let pass = 0, fail = 0;
    for (const t of _tests) {
        try {
            await t.fn();
            pass++;
            console.log(`  \x1b[32m✓\x1b[0m ${t.suite ? t.suite + ' › ' : ''}${t.name}`);
        } catch (e) {
            fail++;
            console.log(`  \x1b[31m✗\x1b[0m ${t.suite ? t.suite + ' › ' : ''}${t.name}`);
            console.log(`    ${e.message}`);
        }
    }
    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail > 0) process.exit(1);
}

/** A local store holding a single Box of the given length. */
function boxStore(length = 10) {
    const box = makeFeature('Box', { length, width: 10, height: 10 });
    const store = new DocumentStore();
    store.commit(addFeatureChange(box));
    return { store, boxId: box.id };
}

/**
 * Kernel client that counts every real call and stamps each response with a
 * monotonic marker. A cache hit must replay the marker from the ORIGINAL call
 * (proving the network was skipped), so the marker is how we tell a hit from a
 * fresh round-trip.
 */
function countingClient() {
    const client = {
        calls: [],
        name: 'counting',
        async executeCode(code, opts) {
            client.calls.push({ code, opts });
            return {
                ok: true,
                glb: 'glb-bytes-' + client.calls.length,
                topology: { nodes: [{ featureId: 'n' + client.calls.length }] },
                marker: client.calls.length,
            };
        },
    };
    return client;
}

// ── cache hits ────────────────────────────────────────────────────────────────
suite('executor-cache/hit', () => {
    test('identical doc compiled twice hits the kernel once', async () => {
        const { store } = boxStore(10);
        const client = countingClient();
        const exec = new DocumentExecutor({ client });

        const r1 = await exec.executeDocument(store.doc);
        const r2 = await exec.executeDocument(store.doc);

        assert.equal(client.calls.length, 1, 'second compile must not touch the kernel');
        assert.equal(r1.marker, 1);
        assert.equal(r2.marker, 1, 'cache hit replays the original payload');
        assert.equal(r1.cached, undefined, 'first compile is a real call');
        assert.equal(r2.cached, true, 'second compile is flagged cached');
    });

    test('cache hit still dispatches a full executed event', async () => {
        const { store } = boxStore(7);
        const client = countingClient();
        const exec = new DocumentExecutor({ client });
        const events = [];
        exec.subscribe((e) => events.push(e.type));

        await exec.executeDocument(store.doc);   // start, emit, executed
        await exec.executeDocument(store.doc);   // start, emit, executed (cached)

        assert.deepEqual(events, ['start', 'emit', 'executed', 'start', 'emit', 'executed']);
    });

    test('cache hit preserves glb + topology identity', async () => {
        const { store } = boxStore(3);
        const client = countingClient();
        const exec = new DocumentExecutor({ client });
        const r1 = await exec.executeDocument(store.doc);
        const r2 = await exec.executeDocument(store.doc);
        assert.equal(r2.glb, r1.glb);
        assert.deepEqual(r2.topology, r1.topology);
    });

    test('cacheStats reports hits and misses', async () => {
        const { store } = boxStore(5);
        const client = countingClient();
        const exec = new DocumentExecutor({ client });
        await exec.executeDocument(store.doc);   // miss
        await exec.executeDocument(store.doc);   // hit
        await exec.executeDocument(store.doc);   // hit
        const s = exec.cacheStats();
        assert.equal(s.misses, 1);
        assert.equal(s.hits, 2);
        assert.equal(s.size, 1);
    });
});

// ── cache misses (correctness — never serve the wrong geometry) ────────────────
suite('executor-cache/miss', () => {
    test('changing a parameter re-runs the kernel', async () => {
        const { store, boxId } = boxStore(10);
        const client = countingClient();
        const exec = new DocumentExecutor({ client });
        await exec.executeDocument(store.doc);            // len 10 → call 1
        store.commit(setParamsChange(boxId, { length: 20 }));
        await exec.executeDocument(store.doc);            // len 20 → call 2
        assert.equal(client.calls.length, 2);
    });

    test('toggling a parameter BACK is served from cache', async () => {
        const { store, boxId } = boxStore(10);
        const client = countingClient();
        const exec = new DocumentExecutor({ client });
        await exec.executeDocument(store.doc);            // len 10 → call 1
        store.commit(setParamsChange(boxId, { length: 20 }));
        await exec.executeDocument(store.doc);            // len 20 → call 2
        store.commit(setParamsChange(boxId, { length: 10 }));
        const r = await exec.executeDocument(store.doc);  // back to len 10 → cache hit
        assert.equal(client.calls.length, 2, 'returning to a seen state must not recompile');
        assert.equal(r.cached, true);
        assert.equal(r.marker, 1, 'serves the original len-10 payload');
    });

    test('same code at a different deflection re-runs the kernel', async () => {
        const { store } = boxStore(10);
        const client = countingClient();
        const exec = new DocumentExecutor({ client });
        await exec.executeDocument(store.doc);            // deflection 0.1 → call 1
        exec.setTessellationDeflection(0.005);
        await exec.executeDocument(store.doc);            // deflection 0.005 → call 2 (finer mesh)
        assert.equal(client.calls.length, 2);
    });

    test('failed results are never cached', async () => {
        const { store } = boxStore(10);
        const failClient = {
            calls: [],
            async executeCode(code) { this.calls.push(code); return { ok: false, error: 'boom' }; },
        };
        const exec = new DocumentExecutor({ client: failClient });
        await exec.executeDocument(store.doc);
        await exec.executeDocument(store.doc);
        assert.equal(failClient.calls.length, 2, 'a transient failure must not become sticky');
    });
});

// ── LRU eviction ───────────────────────────────────────────────────────────────
suite('executor-cache/lru', () => {
    test('evicts the least-recently-used entry past the cap', async () => {
        const { store, boxId } = boxStore(10);
        const client = countingClient();
        const exec = new DocumentExecutor({ client });
        exec._resultCacheMax = 1;  // hold a single entry

        await exec.executeDocument(store.doc);            // A(len10) → call 1, cache {A}
        await exec.executeDocument(store.doc);            // A → hit, calls still 1
        store.commit(setParamsChange(boxId, { length: 20 }));
        await exec.executeDocument(store.doc);            // B(len20) → call 2, cache {B}, A evicted
        store.commit(setParamsChange(boxId, { length: 10 }));
        await exec.executeDocument(store.doc);            // A again → MISS (was evicted) → call 3

        assert.equal(client.calls.length, 3);
        const s = exec.cacheStats();
        assert.equal(s.hits, 1);
        assert.equal(s.misses, 3);
        assert.equal(s.size, 1);
    });

    test('clearResultCache forces the next compile to miss', async () => {
        const { store } = boxStore(10);
        const client = countingClient();
        const exec = new DocumentExecutor({ client });
        await exec.executeDocument(store.doc);            // call 1
        exec.clearResultCache();
        await exec.executeDocument(store.doc);            // call 2 (cache was wiped)
        assert.equal(client.calls.length, 2);
    });

    test('setClient clears the cache', async () => {
        const { store } = boxStore(10);
        const a = countingClient();
        const exec = new DocumentExecutor({ client: a });
        await exec.executeDocument(store.doc);            // a: call 1
        await exec.executeDocument(store.doc);            // a: hit
        assert.equal(a.calls.length, 1);
        const b = countingClient();
        exec.setClient(b);                                // swapping kernels drops cache
        await exec.executeDocument(store.doc);            // b: call 1 (no stale hit from a)
        assert.equal(b.calls.length, 1);
    });
});

runAll();
