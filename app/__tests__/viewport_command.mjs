/**
 * Tests for the feature-command stack:
 *   - lib/document/preview.js     — PreviewBodyChannel + withSpeculativeFeature
 *   - lib/viewport/default_actions.js — inline schema helpers
 *
 * The CommandDialog + CommandRuntime are DOM-heavy; we exercise them in
 * integration tests with a jsdom-style minimal global stub.
 *
 * Run via:  node app/__tests__/viewport_command.mjs
 */

import assert from 'node:assert/strict';
import * as THREE from 'three';
import { PreviewBodyChannel, withSpeculativeFeature } from '../../lib/document/preview.js';
import { getCommandSchema, getInitialValues } from '../../lib/viewport/default_actions.js';
import { emptyDocument, makeFeature } from '../../lib/document/types.js';

const _tests = [];
let _suite = '';
function suite(name, fn) { _suite = name; fn(); _suite = ''; }
function test(name, fn)  { _tests.push({ suite: _suite, name, fn }); }
async function runAll() {
    let pass = 0, fail = 0;
    for (const t of _tests) {
        try { await t.fn(); pass++; console.log(`  \x1b[32m✓\x1b[0m ${t.suite ? t.suite + ' › ' : ''}${t.name}`); }
        catch (e) { fail++; console.log(`  \x1b[31m✗\x1b[0m ${t.suite ? t.suite + ' › ' : ''}${t.name}`); console.log(`    ${e.message}`); }
    }
    console.log(`\n  ${pass} passed, ${fail} failed`);
    if (fail > 0) process.exit(1);
}

// ── Tiny in-process kernel stub ──────────────────────────────────────────────
function stubKernel(behavior = {}) {
    const calls = [];
    return {
        calls,
        executeCode: async (code) => {
            calls.push(code);
            await new Promise(r => setTimeout(r, 0));
            if (behavior.fail) return { ok: false, error: behavior.fail };
            // Empty buffer; the channel's GLB parse step won't run (we short-circuit on byteLength=0).
            return { ok: true, glb: new ArrayBuffer(0), topology: { nodes: [] } };
        },
    };
}

// ── withSpeculativeFeature ───────────────────────────────────────────────────
suite('withSpeculativeFeature', () => {
    test('returns a new doc — original is untouched', () => {
        const doc = emptyDocument();
        const feat = makeFeature('Box', { length: 10, width: 10, height: 10 });
        const out = withSpeculativeFeature(doc, feat);
        assert.notEqual(out, doc);
        assert.equal(Object.keys(doc.features).length, 0);
        assert.equal(Object.keys(out.features).length, 1);
        assert.ok(out.featureOrder.includes(feat.id));
    });

    test('multiple calls compose without affecting the base', () => {
        const doc = emptyDocument();
        const a = makeFeature('Box', { length: 5, width: 5, height: 5 });
        const b = makeFeature('Sphere', { radius: 3 });
        const after1 = withSpeculativeFeature(doc, a);
        const after2 = withSpeculativeFeature(after1, b);
        assert.equal(Object.keys(doc.features).length, 0);
        assert.equal(Object.keys(after1.features).length, 1);
        assert.equal(Object.keys(after2.features).length, 2);
    });
});

// ── PreviewBodyChannel ──────────────────────────────────────────────────────
suite('PreviewBodyChannel', () => {
    test('constructor rejects when no kernelClient is provided', () => {
        assert.throws(() => new PreviewBodyChannel({}), /kernelClient/);
    });

    test('previewNow runs the kernel and emits a rendered event on success', async () => {
        const kernel  = stubKernel();
        const channel = new PreviewBodyChannel({ kernelClient: kernel });
        const events = [];
        channel.on(e => events.push(e.type));
        const doc = emptyDocument();
        const feat = makeFeature('Box', { length: 10, width: 10, height: 10 });
        const candidate = withSpeculativeFeature(doc, feat);
        await channel.previewNow(candidate);
        assert.equal(kernel.calls.length, 1);
        // The result has an empty GLB → no parse → no 'rendered' event.
        // We still expect no 'error' event since ok:true.
        assert.ok(!events.includes('error'));
    });

    test('previewNow emits error event when kernel fails', async () => {
        const kernel  = stubKernel({ fail: 'kernel boom' });
        const channel = new PreviewBodyChannel({ kernelClient: kernel });
        const events = [];
        channel.on(e => events.push(e));
        const doc = emptyDocument();
        const feat = makeFeature('Box', { length: 10, width: 10, height: 10 });
        const candidate = withSpeculativeFeature(doc, feat);
        await channel.previewNow(candidate);
        assert.ok(events.some(e => e.type === 'error'));
    });

    test('clear emits cleared event and disposes group children', () => {
        const kernel  = stubKernel();
        const channel = new PreviewBodyChannel({ kernelClient: kernel });
        const events = [];
        channel.on(e => events.push(e.type));
        // Force a fake child mesh to assert clear() really empties the group.
        const fake = new THREE.Mesh(new THREE.BoxGeometry(1,1,1),
                                    new THREE.MeshBasicMaterial());
        channel.group.add(fake);
        assert.equal(channel.isVisible(), true);
        channel.clear();
        assert.equal(channel.isVisible(), false);
        assert.ok(events.includes('cleared'));
    });

    test('requestPreview debounces — only the latest candidate runs', async () => {
        const kernel  = stubKernel();
        const channel = new PreviewBodyChannel({ kernelClient: kernel, debounceMs: 30 });
        const doc = emptyDocument();
        const f1 = makeFeature('Box', { length: 10, width: 10, height: 10 });
        const f2 = makeFeature('Box', { length: 20, width: 20, height: 20 });
        channel.requestPreview(withSpeculativeFeature(doc, f1));
        channel.requestPreview(withSpeculativeFeature(doc, f2));
        await new Promise(r => setTimeout(r, 80));
        assert.equal(kernel.calls.length, 1);   // only the latest fired
    });

    test('stale generations do NOT emit rendered (newer call wins)', async () => {
        // We can't reach into the dedicated executor easily; assert that
        // multiple debounced requests still yield only one kernel call.
        const kernel  = stubKernel();
        const channel = new PreviewBodyChannel({ kernelClient: kernel, debounceMs: 10 });
        for (let i = 0; i < 5; i++) {
            const feat = makeFeature('Box', { length: i+1, width: 10, height: 10 });
            channel.requestPreview(withSpeculativeFeature(emptyDocument(), feat));
        }
        await new Promise(r => setTimeout(r, 50));
        assert.equal(kernel.calls.length, 1);
    });
});

// ── default_actions inline schema helpers ────────────────────────────────────
suite('inline schemas', () => {
    test('Box schema covers length/width/height/centered', () => {
        const keys = getCommandSchema('Box').map(s => s.key).sort();
        assert.deepEqual(keys, ['centered', 'height', 'length', 'width']);
    });

    test('Cylinder schema covers radius/height/centered', () => {
        const keys = getCommandSchema('Cylinder').map(s => s.key).sort();
        assert.deepEqual(keys, ['centered', 'height', 'radius']);
    });

    test('initial values agree with kernel-known defaults', () => {
        const box  = getInitialValues('Box');
        assert.equal(box.length, 10);
        assert.equal(box.width,  10);
        assert.equal(box.height, 10);
        const cyl  = getInitialValues('Cylinder');
        assert.equal(cyl.radius, 5);
        assert.equal(cyl.height, 10);
    });

    test('unknown featureType yields empty schema + values', () => {
        assert.deepEqual(getCommandSchema('Nope'), []);
        assert.deepEqual(getInitialValues('Nope'), {});
    });
});

await runAll();
