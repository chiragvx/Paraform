/**
 * Tests for the kernel-client + operations layer — the bits that bridge the
 * v4 document model to the live app. Excludes the bridge.js itself (which
 * depends on three.js) — those would need a browser-like DOM stub.
 *
 * Run via:  node lib/document/__tests__/integration.mjs
 */

import assert from 'node:assert/strict';
import { HttpKernelClient, makeMockKernelClient } from '../kernel_client.js';
import {
    addBox, addCylinder, addSphere, addTorus,
    addFillet, addChamfer, addShell,
    addExtrude, addUnion, addCut, addIntersect,
    addMove, addRotate, addScale,
    addLinearPattern, addCircularPattern, addMirror,
    addDocumentParameter, setDocumentParameter,
    deleteFeature, setFeatureEnabled, setFeatureParams,
} from '../operations.js';
import { resetDocumentStore, getDocumentStore } from '../store.js';
import { emitDocument } from '../emit.js';
import { DocumentExecutor } from '../executor.js';
import { topoOrder } from '../dag.js';

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

// Reset the module singleton before each test so they don't bleed state.
function freshStore() { return resetDocumentStore(); }

// ── HttpKernelClient ─────────────────────────────────────────────────────────
suite('http-kernel-client', () => {
    test('isConfigured() reflects the endpoint', () => {
        const a = new HttpKernelClient({ endpoint: '' });
        const b = new HttpKernelClient({ endpoint: 'http://localhost:7823' });
        assert.equal(a.isConfigured(), false);
        assert.equal(b.isConfigured(), true);
    });

    test('returns mock error when unconfigured', async () => {
        const client = new HttpKernelClient({ endpoint: '' });
        const r = await client.executeCode('# anything');
        assert.equal(r.ok, false);
        assert.match(r.error, /no kernel endpoint/);
        assert.equal(r.mock, true);
    });

    test('POSTs to {endpoint}/execute and parses JSON', async () => {
        const fakeFetch = async (url, init) => {
            assert.match(url, /\/execute$/);
            const body = JSON.parse(init.body);
            assert.equal(body.code.includes('Box(10'), true);
            return {
                ok: true,
                headers: { get: (h) => h.toLowerCase() === 'content-type' ? 'application/json' : null },
                json: async () => ({ ok: true, glb: '', topology: { nodes: [] } }),
                arrayBuffer: async () => new ArrayBuffer(0),
                text: async () => '',
            };
        };
        const client = new HttpKernelClient({ endpoint: 'http://localhost:7823', fetchImpl: fakeFetch });
        const r = await client.executeCode('n_a = Box(10, 10, 10)');
        assert.equal(r.ok, true);
        assert.deepEqual(r.topology, { nodes: [] });
    });

    test('decodes base64 glb into ArrayBuffer', async () => {
        const fakeFetch = async () => ({
            ok: true,
            headers: { get: () => 'application/json' },
            json: async () => ({ ok: true, glb: btoa('hello'), topology: null }),
            arrayBuffer: async () => new ArrayBuffer(0),
            text: async () => '',
        });
        const client = new HttpKernelClient({ endpoint: 'http://test', fetchImpl: fakeFetch });
        const r = await client.executeCode('');
        assert.ok(r.glb instanceof ArrayBuffer);
        assert.equal(r.glb.byteLength, 5);
        const view = new Uint8Array(r.glb);
        assert.equal(String.fromCharCode(...view), 'hello');
    });

    test('HTTP non-2xx surfaces as ok:false with error text', async () => {
        const fakeFetch = async () => ({
            ok: false,
            status: 500,
            headers: { get: () => 'text/plain' },
            json: async () => ({}),
            arrayBuffer: async () => new ArrayBuffer(0),
            text: async () => 'OCCT crash',
        });
        const client = new HttpKernelClient({ endpoint: 'http://test', fetchImpl: fakeFetch });
        const r = await client.executeCode('');
        assert.equal(r.ok, false);
        assert.match(r.error, /HTTP 500/);
        assert.match(r.error, /OCCT crash/);
    });

    test('network errors surface as ok:false with the error message', async () => {
        const fakeFetch = async () => { throw new Error('ECONNREFUSED'); };
        const client = new HttpKernelClient({ endpoint: 'http://test', fetchImpl: fakeFetch });
        const r = await client.executeCode('');
        assert.equal(r.ok, false);
        assert.match(r.error, /ECONNREFUSED/);
    });

    test('setEndpoint changes the destination', async () => {
        let observed;
        const fakeFetch = async (url) => {
            observed = url;
            return {
                ok: true,
                headers: { get: () => 'application/json' },
                json: async () => ({ ok: true }),
                arrayBuffer: async () => new ArrayBuffer(0),
                text: async () => '',
            };
        };
        const client = new HttpKernelClient({ endpoint: 'http://a', fetchImpl: fakeFetch });
        await client.executeCode('');
        assert.match(observed, /^http:\/\/a\/execute$/);
        client.setEndpoint('http://b/');
        await client.executeCode('');
        assert.match(observed, /^http:\/\/b\/execute$/);
    });
});

// ── makeMockKernelClient ─────────────────────────────────────────────────────
suite('mock-kernel-client', () => {
    test('records every call', async () => {
        const client = makeMockKernelClient([{ ok: true }, { ok: false, error: 'x' }]);
        await client.executeCode('CODE1');
        await client.executeCode('CODE2');
        assert.deepEqual(client.calls, ['CODE1', 'CODE2']);
    });

    test('cycles past array end by returning the last entry', async () => {
        const client = makeMockKernelClient([{ ok: true, glb: 'a' }]);
        const r1 = await client.executeCode('');
        const r2 = await client.executeCode('');
        assert.equal(r1.glb, 'a');
        assert.equal(r2.glb, 'a');
    });

    test('function responses get called with the code argument', async () => {
        const client = makeMockKernelClient((code) => ({ ok: true, echoed: code }));
        const r = await client.executeCode('hello');
        assert.equal(r.echoed, 'hello');
    });
});

// ── Operations (primitive creation) ──────────────────────────────────────────
suite('operations/primitives', () => {
    test('addBox commits a Box feature', () => {
        const store = freshStore();
        const f = addBox({ length: 12, width: 8, height: 4 });
        assert.equal(f.type, 'Box');
        assert.equal(f.params.length, 12);
        assert.ok(store.doc.features[f.id]);
        assert.equal(store.doc.head, 0);
    });

    test('addCylinder/Sphere/Torus all land on the store', () => {
        const store = freshStore();
        addCylinder({ radius: 3, height: 5 });
        addSphere({ radius: 7 });
        addTorus({ majorRadius: 20, minorRadius: 1 });
        assert.equal(Object.keys(store.doc.features).length, 3);
        assert.equal(store.doc.changelog.length, 3);
    });

    test('each commit is undoable', () => {
        const store = freshStore();
        const b = addBox();
        assert.ok(store.canUndo());
        store.undo();
        assert.equal(store.doc.features[b.id], undefined);
    });

    test('default params propagate to the emitted Python', () => {
        freshStore();
        addBox();
        const { code } = emitDocument(getDocumentStore().doc);
        // Per CLAUDE.md Align.MIN-on-Z rule: default Box sits on the Z=0 ground plane.
        assert.match(code, /Box\(10, 10, 10, align=\(Align.CENTER, Align.CENTER, Align.MIN\)\)/);
    });
});

// ── Operations (modify / boolean / transform / pattern) ──────────────────────
suite('operations/derived', () => {
    test('addFillet wires inputs.body to the upstream feature', () => {
        const store = freshStore();
        const box = addBox();
        const fil = addFillet(box.id, { radius: 2 });
        assert.equal(fil.inputs.body.featureId, box.id);
        assert.equal(fil.params.radius, 2);
        // DAG must see this dependency
        assert.deepEqual(topoOrder(store.doc), [box.id, fil.id]);
    });

    test('addChamfer, addShell accept the same shape', () => {
        const store = freshStore();
        const box = addBox();
        const ch  = addChamfer(box.id, { length: 1 });
        const sh  = addShell(box.id, { thickness: 0.5 });
        assert.equal(ch.inputs.body.featureId, box.id);
        assert.equal(sh.inputs.body.featureId, box.id);
        assert.equal(Object.keys(store.doc.features).length, 3);
    });

    test('addUnion rejects fewer than 2 inputs', () => {
        freshStore();
        const a = addBox();
        assert.throws(() => addUnion([a.id]), /at least 2/);
    });

    test('addUnion wires inputs.bodies to every operand', () => {
        const store = freshStore();
        const a = addBox(), b = addSphere();
        const u = addUnion([a.id, b.id]);
        assert.equal(u.inputs.bodies.length, 2);
        assert.equal(u.inputs.bodies[0].featureId, a.id);
        assert.equal(u.inputs.bodies[1].featureId, b.id);
    });

    test('addCut wires target + tools', () => {
        const store = freshStore();
        const target = addBox();
        const tool   = addCylinder();
        const cut    = addCut(target.id, [tool.id]);
        assert.equal(cut.inputs.target.featureId, target.id);
        assert.equal(cut.inputs.tools[0].featureId, tool.id);
    });

    test('addMove / addRotate / addScale all chain on a body input', () => {
        const store = freshStore();
        const a = addBox();
        const m = addMove(a.id, [10, 0, 0]);
        const r = addRotate(a.id, 'Z', 45);
        const s = addScale(a.id, 2);
        for (const f of [m, r, s]) {
            assert.equal(f.inputs.body.featureId, a.id);
        }
    });

    test('pattern + mirror ops produce the right feature types', () => {
        const store = freshStore();
        const a  = addBox();
        const lp = addLinearPattern(a.id);
        const cp = addCircularPattern(a.id);
        const mr = addMirror(a.id, 'XY');
        assert.equal(lp.type, 'LinearPattern');
        assert.equal(cp.type, 'CircularPattern');
        assert.equal(mr.type, 'Mirror');
    });
});

// ── Operations (parameters + lifecycle) ──────────────────────────────────────
suite('operations/lifecycle', () => {
    test('addDocumentParameter adds a parameter and shows in emit', () => {
        freshStore();
        addDocumentParameter('wall', 3);
        const { code } = emitDocument(getDocumentStore().doc);
        assert.match(code, /p_wall = 3/);
    });

    test('setDocumentParameter by name updates the value', () => {
        const store = freshStore();
        addDocumentParameter('wall', 3);
        setDocumentParameter('wall', { value: 5 });
        const p = Object.values(store.doc.parameters).find(p => p.name === 'wall');
        assert.equal(p.value, 5);
    });

    test('deleteFeature removes from the store', () => {
        const store = freshStore();
        const b = addBox();
        deleteFeature(b.id);
        assert.equal(store.doc.features[b.id], undefined);
    });

    test('setFeatureEnabled flips suppression', () => {
        const store = freshStore();
        const b = addBox();
        setFeatureEnabled(b.id, false);
        assert.equal(store.doc.features[b.id].enabled, false);
        setFeatureEnabled(b.id, true);
        assert.equal(store.doc.features[b.id].enabled, true);
    });

    test('setFeatureParams patches the params and triggers regen', () => {
        const store = freshStore();
        const b = addBox({ length: 5 });
        setFeatureParams(b.id, { length: 25 });
        assert.equal(store.doc.features[b.id].params.length, 25);
    });
});

// ── End-to-end against a mock kernel ─────────────────────────────────────────
suite('integration/mock-kernel', () => {
    test('full path: addBox → executor → mock client → fake GLB', async () => {
        freshStore();
        const f = addBox({ length: 11 });
        const client = makeMockKernelClient([{ ok: true, glb: btoa('GLB!'), topology: { nodes: [{ featureId: f.id }] } }]);
        const exec = new DocumentExecutor({ client });
        const events = [];
        exec.subscribe((e) => events.push(e.type));
        const result = await exec.executeDocument(getDocumentStore().doc);
        assert.equal(result.ok, true);
        assert.equal(client.calls.length, 1);
        assert.match(client.calls[0], /Box\(11/);
        assert.deepEqual(events, ['start', 'emit', 'executed']);
    });

    test('three ops + parameter regenerate correctly via mock', async () => {
        freshStore();
        addDocumentParameter('side', 20);
        const box = addBox();
        setFeatureParams(box.id, { length: '=p_side' });
        const client = makeMockKernelClient([{ ok: true, glb: '' }]);
        const exec = new DocumentExecutor({ client });
        await exec.executeDocument(getDocumentStore().doc);
        assert.match(client.calls[0], /p_side = 20/);
        assert.match(client.calls[0], /Box\(p_side,/);
    });
});

runAll();
