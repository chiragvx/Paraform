/**
 * Tests for the v4 emitter + DocumentExecutor.
 * Run via:  node lib/document/__tests__/emit.mjs
 */

import assert from 'node:assert/strict';
import {
    emptyDocument, makeFeature, makeParameter,
    bodyRef, sketchRef, planeRef, axisRef,
    foldChangelog,
    addFeatureChange, addParameterChange, setEnabledChange,
    DocumentStore,
} from '../index.js';
import { emitDocument } from '../emit.js';
import { DocumentExecutor } from '../executor.js';
import {
    makeSketchData, addEntity, stockPlane,
} from '../../sketch/sketch_data.js';
import { makePoint, makeLine, makeRectangle, makeCircle } from '../../sketch/entities.js';
import { makeSketchFeature } from '../../sketch/feature.js';

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

// ── Helper: build a document by committing changes through a store ────────────
function buildDoc(...changes) {
    const store = new DocumentStore();
    for (const ch of changes) store.commit(ch);
    return store.doc;
}

// ── Primitive emit ───────────────────────────────────────────────────────────
suite('primitives', () => {
    test('Box defaults to XY-centred / Z-MIN so the body sits on the ground plane', () => {
        // Per CLAUDE.md: `centered=true` means centered in XY with Align.MIN on Z
        // (bottom face on the world Z=0 plane). Align.CENTER on Z would bury
        // half the box below the grid in this Z-up scene.
        const f = makeFeature('Box', { length: 12, width: 8, height: 4 });
        const doc = buildDoc(addFeatureChange(f));
        const { code, leafIds } = emitDocument(doc);
        assert.match(code, new RegExp(`n_${f.id} = Box\\(12, 8, 4, align=\\(Align.CENTER, Align.CENTER, Align.MIN\\)\\)`));
        assert.deepEqual(leafIds, [f.id]);
    });

    test('Box with centered:false emits MIN alignment', () => {
        const f = makeFeature('Box', { length: 1, width: 2, height: 3, centered: false });
        const doc = buildDoc(addFeatureChange(f));
        const { code } = emitDocument(doc);
        assert.match(code, /align=\(Align.MIN, Align.MIN, Align.MIN\)/);
    });

    test('Cylinder, Sphere, Torus emit their primitives', () => {
        const cyl = makeFeature('Cylinder', { radius: 3, height: 7 });
        const sph = makeFeature('Sphere',   { radius: 4 });
        const tor = makeFeature('Torus',    { majorRadius: 10, minorRadius: 2 });
        const doc = buildDoc(
            addFeatureChange(cyl),
            addFeatureChange(sph),
            addFeatureChange(tor),
        );
        const { code, leafIds } = emitDocument(doc);
        assert.match(code, /Cylinder\(3, 7, align=/);
        assert.match(code, /Sphere\(4\)/);
        assert.match(code, /Torus\(10, 2\)/);
        assert.equal(leafIds.length, 3);
    });

    test('disabled feature is omitted from the emit', () => {
        const f = makeFeature('Box');
        const doc = buildDoc(addFeatureChange(f), setEnabledChange(f.id, false));
        const { code, leafIds } = emitDocument(doc);
        assert.equal(code.includes(`n_${f.id} = Box`), false);
        assert.equal(leafIds.length, 0);
    });
});

// ── Reference resolution ─────────────────────────────────────────────────────
suite('refs', () => {
    test('Fillet emits resolve_edges with body ref var', () => {
        const box = makeFeature('Box', { length: 10, width: 10, height: 10 });
        const fil = makeFeature('Fillet', { radius: 1 }, { body: bodyRef(box.id) });
        const doc = buildDoc(addFeatureChange(box), addFeatureChange(fil));
        const { code, leafIds } = emitDocument(doc);
        assert.match(code, new RegExp(`n_${fil.id} = fillet\\(n_${box.id}\\.edges\\(\\), radius=1\\)`));
        // Box is consumed by the fillet → fillet is the leaf, box is not
        assert.deepEqual(leafIds, [fil.id]);
    });

    test('Cut emits target − tools sequence', () => {
        const a = makeFeature('Box',     { length: 20, width: 20, height: 20 });
        const b = makeFeature('Cylinder', { radius: 5, height: 25 });
        const cut = makeFeature('Cut', {}, { target: bodyRef(a.id), tools: [bodyRef(b.id)] });
        const doc = buildDoc(addFeatureChange(a), addFeatureChange(b), addFeatureChange(cut));
        const { code, leafIds } = emitDocument(doc);
        assert.match(code, new RegExp(`n_${cut.id} = n_${a.id} - n_${b.id}`));
        assert.deepEqual(leafIds, [cut.id]);
    });

    test('Union emits + chain', () => {
        const a = makeFeature('Box');
        const b = makeFeature('Sphere');
        const u = makeFeature('Union', {}, { bodies: [bodyRef(a.id), bodyRef(b.id)] });
        const doc = buildDoc(addFeatureChange(a), addFeatureChange(b), addFeatureChange(u));
        const { code, leafIds } = emitDocument(doc);
        assert.match(code, new RegExp(`n_${u.id} = n_${a.id} \\+ n_${b.id}`));
        assert.deepEqual(leafIds, [u.id]);
    });

    test('topological ordering respects DAG dependencies', () => {
        const a = makeFeature('Box');
        const b = makeFeature('Fillet', { radius: 1 }, { body: bodyRef(a.id) });
        // Commit b BEFORE a in featureOrder — but DAG forces emit order
        const doc = buildDoc(
            addFeatureChange(a, 0),
            addFeatureChange(b, 0),    // inserted before a in featureOrder
        );
        const { code } = emitDocument(doc);
        const idxA = code.indexOf(`n_${a.id} = Box`);
        const idxB = code.indexOf(`n_${b.id} = fillet`);
        assert.ok(idxA >= 0 && idxB >= 0);
        assert.ok(idxA < idxB, 'Box must be emitted before its dependent Fillet');
    });

    test('cycle in DAG throws on emit', () => {
        const a = makeFeature('Fillet');
        a.inputs = { body: bodyRef(a.id) };
        const doc = buildDoc(addFeatureChange(a));
        assert.throws(() => emitDocument(doc), /cycle/);
    });
});

// ── Parameters ────────────────────────────────────────────────────────────────
suite('parameters', () => {
    test('parameter emits as p_<name> assignment', () => {
        const p = makeParameter('wall', 3);
        const doc = buildDoc(addParameterChange(p));
        const { code } = emitDocument(doc);
        assert.match(code, /p_wall = 3/);
    });

    test('parameter equation passes through verbatim', () => {
        const p = makeParameter('outer', 0, 'mm', 'p_wall * 2 + 1');
        const doc = buildDoc(addParameterChange(p));
        const { code } = emitDocument(doc);
        assert.match(code, /p_outer = p_wall \* 2 \+ 1/);
    });

    test('feature params can reference parameters via "=p_<name>" expressions', () => {
        const p = makeParameter('side', 25);
        const box = makeFeature('Box', { length: '=p_side', width: '=p_side', height: 10 });
        const doc = buildDoc(addParameterChange(p), addFeatureChange(box));
        const { code } = emitDocument(doc);
        assert.match(code, new RegExp(`n_${box.id} = Box\\(p_side, p_side, 10,`));
    });

    test('parameters emit before features (so features can reference them)', () => {
        const p = makeParameter('r', 5);
        const cyl = makeFeature('Cylinder', { radius: '=p_r', height: 10 });
        const doc = buildDoc(addParameterChange(p), addFeatureChange(cyl));
        const { code } = emitDocument(doc);
        const pIdx = code.indexOf('p_r = 5');
        const cIdx = code.indexOf('n_' + cyl.id);
        assert.ok(pIdx < cIdx);
    });
});

// ── Sketches ──────────────────────────────────────────────────────────────────
suite('sketches', () => {
    test('Sketch feature emits BuildSketch then aliases n_<id> = sk_<id>.sketch', () => {
        const sk = makeSketchData(stockPlane('XY'));
        const a = makePoint(0, 0); addEntity(sk, a);
        const b = makePoint(10, 0); addEntity(sk, b);
        const c = makePoint(10, 5); addEntity(sk, c);
        const d = makePoint(0, 5); addEntity(sk, d);
        addEntity(sk, makeRectangle(a.id, c.id));
        const feature = makeSketchFeature(sk);
        const doc = buildDoc(addFeatureChange(feature));
        const { code } = emitDocument(doc);
        assert.match(code, new RegExp(`with BuildSketch\\(Plane\\.XY\\) as sk_${feature.id}:`));
        assert.match(code, new RegExp(`n_${feature.id} = sk_${feature.id}\\.sketch`));
        // Rectangle inlined
        assert.match(code, /Rectangle\(10, 5,/);
    });

    test('Extrude consumes a sketch feature via inputs.sketch', () => {
        const sk = makeSketchData(stockPlane('XY'));
        const c = makePoint(0, 0); addEntity(sk, c);
        addEntity(sk, makeCircle(c.id, 5));
        const sketchFeat = makeSketchFeature(sk);
        const ex = makeFeature('Extrude', { amount: 12 }, { sketch: sketchRef(sketchFeat.id) });
        const doc = buildDoc(addFeatureChange(sketchFeat), addFeatureChange(ex));
        const { code, leafIds } = emitDocument(doc);
        assert.match(code, new RegExp(`n_${ex.id} = extrude\\(n_${sketchFeat.id}, amount=12\\)`));
        // The sketch isn't a leaf (extrude consumes it) and Sketch type isn't
        // a leaf-eligible body producer anyway.
        assert.deepEqual(leafIds, [ex.id]);
    });
});

// ── Leaf detection ───────────────────────────────────────────────────────────
suite('leaves', () => {
    test('leaves are features whose body isn\'t consumed', () => {
        const a = makeFeature('Box');
        const b = makeFeature('Sphere');
        const c = makeFeature('Cut', {}, { target: bodyRef(a.id), tools: [bodyRef(b.id)] });
        const d = makeFeature('Cylinder');     // independent — also a leaf
        const doc = buildDoc(
            addFeatureChange(a),
            addFeatureChange(b),
            addFeatureChange(c),
            addFeatureChange(d),
        );
        const { leafIds } = emitDocument(doc);
        assert.deepEqual([...leafIds].sort(), [c.id, d.id].sort());
    });

    test('result dict references leaf vars', () => {
        const a = makeFeature('Box');
        const doc = buildDoc(addFeatureChange(a));
        const { code } = emitDocument(doc);
        assert.match(code, /__paraform_result__ = \{"bodies": \{/);
        assert.match(code, new RegExp(`"${a.id}": n_${a.id}`));
    });

    test('disabled features are dropped from result dict', () => {
        const a = makeFeature('Box');
        const doc = buildDoc(addFeatureChange(a), setEnabledChange(a.id, false));
        const { code } = emitDocument(doc);
        assert.equal(code.includes(`n_${a.id}`), false);
        assert.match(code, /__paraform_result__ = \{"bodies": \{\}/);
    });
});

// ── Executor ──────────────────────────────────────────────────────────────────
suite('executor', () => {
    /** A test-only kernel client that records calls and returns canned responses. */
    function makeMockClient(responses) {
        const calls = [];
        let i = 0;
        return {
            calls,
            executeCode: async (code) => {
                calls.push(code);
                const next = responses[i++] ?? responses[responses.length - 1] ?? { ok: true };
                return typeof next === 'function' ? next() : next;
            },
        };
    }

    test('executeDocument calls the client with the emitted code', async () => {
        const client = makeMockClient([{ ok: true, glb: 'GLB1', topology: { nodes: [] } }]);
        const exec = new DocumentExecutor({ client });
        const a = makeFeature('Box');
        const doc = buildDoc(addFeatureChange(a));
        const result = await exec.executeDocument(doc);
        assert.equal(result.ok, true);
        assert.equal(result.glb, 'GLB1');
        assert.equal(client.calls.length, 1);
        assert.match(client.calls[0], new RegExp(`n_${a.id} = Box`));
    });

    test('dispatches start → emit → executed events on success', async () => {
        const client = makeMockClient([{ ok: true, glb: 'GLB' }]);
        const exec = new DocumentExecutor({ client });
        const events = [];
        exec.subscribe(e => events.push(e.type));
        const doc = buildDoc(addFeatureChange(makeFeature('Sphere')));
        await exec.executeDocument(doc);
        assert.deepEqual(events, ['start', 'emit', 'executed']);
    });

    test('dispatches start → emit → failed on kernel error', async () => {
        const client = makeMockClient([{ ok: false, error: 'OCCT exception' }]);
        const exec = new DocumentExecutor({ client });
        const events = [];
        exec.subscribe(e => events.push({ type: e.type, error: e.error }));
        const doc = buildDoc(addFeatureChange(makeFeature('Box')));
        await exec.executeDocument(doc);
        assert.equal(events[events.length - 1].type, 'failed');
        assert.equal(events[events.length - 1].error, 'OCCT exception');
        assert.equal(exec.lastError(), 'OCCT exception');
    });

    test('stale generation is signalled rather than failed when newer call supersedes', async () => {
        let resolveFirst;
        const firstResp = new Promise(r => { resolveFirst = r; });
        const client = {
            executeCode: async (code) => {
                if (code.includes('Box')) return firstResp;     // first call hangs
                return { ok: true, glb: 'second' };
            },
        };
        const exec = new DocumentExecutor({ client });
        const events = [];
        exec.subscribe(e => events.push(e.type));

        const docA = buildDoc(addFeatureChange(makeFeature('Box')));
        const docB = buildDoc(addFeatureChange(makeFeature('Sphere')));

        const p1 = exec.executeDocument(docA);
        const p2 = exec.executeDocument(docB);
        // Resolve the first AFTER the second so generation has advanced
        await p2;
        resolveFirst({ ok: true, glb: 'first' });
        const r1 = await p1;
        assert.equal(r1.stale, true);
        assert.ok(events.includes('stale'));
    });

    test('cancel() bumps generation; subsequent executions are not stale', async () => {
        const client = { executeCode: async () => ({ ok: true, glb: 'x' }) };
        const exec = new DocumentExecutor({ client });
        const events = [];
        exec.subscribe(e => events.push(e.type));
        exec.cancel();
        assert.equal(events[0], 'cancelled');
        const result = await exec.executeDocument(buildDoc(addFeatureChange(makeFeature('Box'))));
        assert.equal(result.ok, true);
        assert.equal(result.stale, false);
    });

    test('emit failure surfaces as failed without calling the client', async () => {
        // Build a doc with a self-referencing cycle so emit throws
        const a = makeFeature('Fillet');
        a.inputs = { body: bodyRef(a.id) };
        const doc = buildDoc(addFeatureChange(a));
        let called = 0;
        const client = { executeCode: async () => { called++; return { ok: true }; } };
        const exec = new DocumentExecutor({ client });
        const events = [];
        exec.subscribe(e => events.push(e.type));
        const result = await exec.executeDocument(doc);
        assert.equal(result.ok, false);
        assert.match(result.error, /cycle/);
        assert.equal(called, 0);
        assert.deepEqual(events, ['start', 'failed']);
    });

    test('lastResult() / lastError() reflect the most recent outcome', async () => {
        const client = makeMockClient([
            { ok: true, glb: 'GLB1' },
            { ok: false, error: 'kerror' },
        ]);
        const exec = new DocumentExecutor({ client });
        const doc = buildDoc(addFeatureChange(makeFeature('Box')));
        await exec.executeDocument(doc);
        assert.equal(exec.lastResult().glb, 'GLB1');
        await exec.executeDocument(doc);
        assert.equal(exec.lastError(), 'kerror');
    });

    test('subscribe() returns an unsubscribe function', async () => {
        const client = { executeCode: async () => ({ ok: true }) };
        const exec = new DocumentExecutor({ client });
        let count = 0;
        const off = exec.subscribe(() => { count++; });
        await exec.executeDocument(buildDoc(addFeatureChange(makeFeature('Box'))));
        off();
        await exec.executeDocument(buildDoc(addFeatureChange(makeFeature('Box'))));
        assert.equal(count, 3);  // start, emit, executed — only from first run
    });
});

runAll();
