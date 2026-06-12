/**
 * Regression: delete-desync between the document, the pick proxies, and the
 * viewport (the "deleted box still hovers / still in the panel" bug).
 *
 * Run:
 *   node --import ./src/lib/commands/__tests__/_register.mjs \
 *        src/lib/__tests__/delete_desync.mjs
 *
 * Covers the two bridge/proxy root causes (the Sidebar `$derived` half is a
 * Svelte-runtime reactivity fix, verified in-browser, not unit-testable here):
 *   1. PickProxyLayer.pruneOrphans() drops proxies whose featureId left the doc.
 *   2. The bridge's empty-doc runNow() path clears `geometry` and fires
 *      onRender so the proxy/overlay layers tear down (previously it
 *      early-returned and the proxies for the last-deleted body lingered).
 */
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { PickProxyLayer } from '../../../lib/picking/pick_proxies.js';
import { DocumentExecutor } from '../../../lib/document/executor.js';
import { DocumentViewportBridge } from '../../../lib/document/bridge.js';
import * as v4 from '../../../lib/document/index.js';
import { addBox, deleteFeature } from '../../../lib/document/index.js';

let _pass = 0, _fail = 0;
async function t(name, fn) {
    try { await fn(); console.log(`  ok  ${name}`); _pass++; }
    catch (e) { console.error(`  FAIL ${name}\n    ${e?.stack || e?.message || e}`); _fail++; }
}

// A minimal one-triangle face geometry blob the proxy layer accepts.
function faceBlob(featureId) {
    return {
        vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0],
        indices: [0, 1, 2],
        featureId,
        descriptor: { kind: 'face', feature: featureId, opTag: 'box', part: '+Z' },
    };
}

console.log('── delete-desync regression ──');

await t('PickProxyLayer.pruneOrphans drops proxies for deleted features', () => {
    const scene = new THREE.Scene();
    const layer = new PickProxyLayer({ scene });
    layer.setGeometry({
        faces: { 'face:a:box:+Z': faceBlob('a'), 'face:b:box:+Z': faceBlob('b') },
        edges: {},
    });
    assert.equal(layer._faceProxies.size, 2, 'two proxies built');
    // Feature 'a' deleted from the doc → its proxy must go; 'b' stays.
    const removed = layer.pruneOrphans(new Set(['b']));
    assert.equal(removed, 1);
    assert.equal(layer._faceProxies.size, 1);
    assert.ok(layer._faceProxies.has('face:b:box:+Z'));
    assert.ok(!layer._faceProxies.has('face:a:box:+Z'));
    layer.dispose();
});

await t('pruneOrphans leaves untagged proxies alone', () => {
    const scene = new THREE.Scene();
    const layer = new PickProxyLayer({ scene });
    const untagged = faceBlob(null); untagged.descriptor = null; // no way to attribute
    layer.setGeometry({ faces: { 'face:x': untagged }, edges: {} });
    const removed = layer.pruneOrphans(new Set(['something-else']));
    assert.equal(removed, 0, 'untagged proxy is not guessed-at');
    layer.dispose();
});

await t('bridge empty-doc runNow clears geometry and fires onRender', async () => {
    const NULL_CLIENT = { async executeCode() { return { ok: true, glb: null, topology: null }; } };
    v4.resetDocument?.();
    const store = v4.getDocumentStore();
    const executor = new DocumentExecutor({ client: NULL_CLIENT });
    const bridge = new DocumentViewportBridge({ store, executor, kernelClient: NULL_CLIENT });
    // Pretend a prior kernel render left geometry cached.
    bridge._lastResult = { glb: new ArrayBuffer(8), geometry: { faces: { 'face:a': {} }, edges: {} } };
    assert.ok(bridge.geometry, 'precondition: geometry cached');

    const f = addBox({ length: 10, width: 10, height: 10 });
    deleteFeature(f.id); // doc now empty

    let rendered = null;
    bridge.onRender((evt) => { rendered = evt; });
    await bridge.runNow();

    assert.ok(rendered, 'onRender fired on the empty-doc path');
    assert.equal(bridge.geometry, null, 'cached geometry cleared so proxies rebuild empty');
    bridge.dispose();
});

console.log(`\n${_pass} pass, ${_fail} fail`);
if (_fail > 0) process.exit(1);
