/**
 * Bridge "live delete" — optimistic mesh prune on document change.
 *
 * Run via:
 *   node --import ./src/lib/commands/__tests__/_register.mjs \
 *        src/lib/__tests__/bridge_optimistic_delete.mjs
 *
 * The bridge subscribes to the store and, on every non-selection change,
 * walks `_bodyTransform` removing any mesh whose `userData.featureId` is
 * no longer in `doc.features` (or whose `userData.componentId` is no
 * longer in `doc.components`). This makes feature deletes feel instant
 * even though the kernel re-render is still debounced.
 */

import assert from 'node:assert/strict';
import * as THREE from 'three';

import { DocumentStore } from '../../../lib/document/store.js';
import { DocumentExecutor } from '../../../lib/document/executor.js';
import { DocumentViewportBridge } from '../../../lib/document/bridge.js';
import { addBox, deleteFeature, addComponent, removeComponent } from '../../../lib/document/index.js';
import * as v4 from '../../../lib/document/index.js';

const NULL_CLIENT = { async executeCode() { return { ok: true, glb: null, topology: null }; } };

function newBridge() {
    const store = new DocumentStore();
    const executor = new DocumentExecutor({ client: NULL_CLIENT });
    // The op layer reads getDocumentStore() — make sure it sees this store.
    v4.resetDocument?.();
    const bridge = new DocumentViewportBridge({ store: v4.getDocumentStore(), executor, kernelClient: NULL_CLIENT });
    // Plant a fake bodyTransform with tagged meshes so the prune has
    // something to walk. The bridge normally creates this from the GLB,
    // but for unit tests we synthesize the same shape.
    bridge._bodyTransform = new THREE.Group();
    bridge._root.add(bridge._bodyTransform);
    return { store: v4.getDocumentStore(), bridge };
}

function plantMesh(bridge, featureId, componentId = 'root') {
    const subgroup = bridge.componentSubgroup(componentId);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
    mesh.userData.featureId = featureId;
    mesh.userData.componentId = componentId;
    subgroup.add(mesh);
    return mesh;
}

let _pass = 0, _fail = 0;
function t(name, fn) {
    try { fn(); console.log(`  ok  ${name}`); _pass++; }
    catch (e) { console.error(`  FAIL ${name}\n    ${e?.stack || e?.message || e}`); _fail++; }
}

function countMeshes(bridge) {
    let n = 0;
    bridge._bodyTransform?.traverse((o) => { if (o.isMesh) n++; });
    return n;
}

console.log('── bridge live-delete (optimistic prune) ──');

t('feature delete drops its mesh synchronously (before kernel runs)', () => {
    const { bridge } = newBridge();
    const f = addBox({ length: 10, width: 10, height: 10 });
    plantMesh(bridge, f.id);
    assert.equal(countMeshes(bridge), 1);
    // Delete via the document op → store commit → bridge subscribe → prune.
    deleteFeature(f.id);
    // No await, no debounce, no kernel call — the prune is synchronous.
    assert.equal(countMeshes(bridge), 0, 'mesh should be removed immediately');
    bridge.dispose();
});

t('deleting one of N features keeps the others', () => {
    const { bridge } = newBridge();
    const a = addBox({ length: 5, width: 5, height: 5 });
    const b = addBox({ length: 6, width: 6, height: 6 });
    const c = addBox({ length: 7, width: 7, height: 7 });
    plantMesh(bridge, a.id);
    plantMesh(bridge, b.id);
    plantMesh(bridge, c.id);
    assert.equal(countMeshes(bridge), 3);
    deleteFeature(b.id);
    // Only b's mesh should be gone.
    const remaining = [];
    bridge._bodyTransform.traverse((o) => {
        if (o.isMesh && o.userData.featureId) remaining.push(o.userData.featureId);
    });
    remaining.sort();
    assert.deepEqual(remaining, [a.id, c.id].sort());
    bridge.dispose();
});

t('deleting a component drops its subgroup', () => {
    const { bridge } = newBridge();
    const comp = addComponent({ name: 'Sub', parentId: 'root' });
    const f = addBox({ length: 5, width: 5, height: 5, componentId: comp.id });
    plantMesh(bridge, f.id, comp.id);
    // Sanity: the subgroup tagged with this componentId exists in the tree.
    let foundBefore = false;
    bridge._bodyTransform.traverse((o) => {
        if (o.userData && o.userData.componentId === comp.id) foundBefore = true;
    });
    assert.ok(foundBefore, 'component subgroup should exist before remove');
    removeComponent(comp.id);
    // The component subgroup AND its mesh should be gone.
    let foundAfter = false;
    bridge._bodyTransform.traverse((o) => {
        if (o.userData && o.userData.componentId === comp.id) foundAfter = true;
    });
    assert.equal(foundAfter, false);
    bridge.dispose();
});

t('non-delete change (param update) leaves meshes intact', () => {
    const { bridge } = newBridge();
    const f = addBox({ length: 10, width: 10, height: 10 });
    plantMesh(bridge, f.id);
    assert.equal(countMeshes(bridge), 1);
    // A param tweak shouldn't drop the mesh — the kernel will replace it
    // once it returns, but until then the current mesh stays visible.
    v4.setFeatureParams(f.id, { length: 20 });
    assert.equal(countMeshes(bridge), 1);
    bridge.dispose();
});

t('deleting the LAST feature drops its mesh (bodyTransform stays, empty)', () => {
    const { bridge } = newBridge();
    const f = addBox({ length: 10, width: 10, height: 10 });
    plantMesh(bridge, f.id);
    deleteFeature(f.id);
    // After delete: prune removes the orphan mesh; bodyTransform stays
    // around (zero meshes) so the bridge's scene setup (axes, grid, contact
    // shadow) doesn't get torn down. The kernel run will follow.
    assert.equal(countMeshes(bridge), 0);
    bridge.dispose();
});

// ── Report ─────────────────────────────────────────────────────────────────
console.log(`\n${_pass} pass, ${_fail} fail`);
if (_fail > 0) process.exit(1);
