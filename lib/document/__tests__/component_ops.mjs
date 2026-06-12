/**
 * Foundation 6 / commit 3 — component CRUD + feature-move operations.
 *
 * Zero-dep: runs with `node lib/document/__tests__/component_ops.mjs`.
 *
 * Covers (target ≥10):
 *   1.  addComponent creates a component with the given name + parentId.
 *   2.  addComponent is undoable via store.undo().
 *   3.  addComponent with no parentId defaults to 'root'.
 *   4.  removeComponent('root') is a no-op.
 *   5.  removeComponent(child) reassigns its features to the parent.
 *   6.  removeComponent(parent) cascades child components to the grandparent.
 *   7.  setFeatureComponent updates the feature's componentId.
 *   8.  setFeatureComponent with a missing target falls back to 'root'.
 *   9.  renameComponent('root', ...) is a no-op.
 *   10. renameComponent(child, name) updates the name.
 *   11. componentChildren returns direct children only.
 *   12. componentDescendants returns the full transitive subtree (excl. root).
 *   13. ADD_COMPONENT id-collision is idempotent (warns + skips).
 */

import assert from 'node:assert/strict';
import {
    resetDocumentStore,
    addBox,
    addComponent, removeComponent, renameComponent, setFeatureComponent,
    setActiveComponentProvider,
    addConnector, addMate, addJoint,
} from '../index.js';

const _tests = [];
function test(name, fn) { _tests.push({ name, fn }); }

async function runAll() {
    let pass = 0, fail = 0;
    for (const t of _tests) {
        try {
            await t.fn();
            console.log(`  ok  ${t.name}`);
            pass++;
        } catch (err) {
            console.error(`  FAIL ${t.name}`);
            console.error('     ', err && err.message || err);
            fail++;
        }
    }
    console.log(`\n  ${pass} passed, ${fail} failed (${_tests.length} total)`);
    if (fail) process.exitCode = 1;
}

// Silence the expected console.warn output from idempotent / no-op paths so
// the test log stays readable. We *do* want to catch unexpected warnings, so
// each test that needs a quiet console wraps its call site.
function quietWarn(fn) {
    const orig = console.warn;
    console.warn = () => {};
    try { return fn(); } finally { console.warn = orig; }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('addComponent creates a component with given name + parentId', () => {
    const store = resetDocumentStore();
    setActiveComponentProvider(null);
    const c = addComponent({ name: 'Wing', parentId: 'root' });
    assert.ok(c.id);
    assert.equal(c.name, 'Wing');
    assert.equal(c.parentId, 'root');
    assert.ok(store.doc.components[c.id]);
    assert.equal(store.doc.components[c.id].name, 'Wing');
});

test('addComponent is undoable via store.undo()', () => {
    const store = resetDocumentStore();
    setActiveComponentProvider(null);
    const c = addComponent({ name: 'Wing', parentId: 'root' });
    assert.ok(store.doc.components[c.id]);
    assert.equal(store.undo(), true);
    assert.equal(store.doc.components[c.id], undefined);
});

test('addComponent with no parentId defaults to root', () => {
    const store = resetDocumentStore();
    setActiveComponentProvider(null);
    const c = addComponent({ name: 'Floating' });
    assert.equal(c.parentId, 'root');
    assert.equal(store.doc.components[c.id].parentId, 'root');
});

test("removeComponent('root') is a no-op", () => {
    const store = resetDocumentStore();
    setActiveComponentProvider(null);
    const headBefore = store.doc.head;
    removeComponent('root');
    assert.ok(store.doc.components.root, 'root still present');
    assert.equal(store.doc.head, headBefore, 'no change committed');
});

test('removeComponent(child) reassigns its features to the parent', () => {
    const store = resetDocumentStore();
    setActiveComponentProvider(null);
    const wing = addComponent({ name: 'Wing', parentId: 'root' });
    const box = addBox({ length: 1, width: 1, height: 1, componentId: wing.id });
    assert.equal(store.doc.features[box.id].componentId, wing.id);

    removeComponent(wing.id);
    assert.equal(store.doc.components[wing.id], undefined);
    assert.equal(store.doc.features[box.id].componentId, 'root');
});

test('removeComponent(parent) cascades child components to the grandparent', () => {
    const store = resetDocumentStore();
    setActiveComponentProvider(null);
    const assembly  = addComponent({ name: 'Assembly',  parentId: 'root' });
    const wing      = addComponent({ name: 'Wing',      parentId: assembly.id });
    const subWing   = addComponent({ name: 'SubWing',   parentId: wing.id });
    const boxOnWing    = addBox({ length: 1, width: 1, height: 1, componentId: wing.id });
    const boxOnSubWing = addBox({ length: 2, width: 2, height: 2, componentId: subWing.id });

    removeComponent(assembly.id);

    // All three components in the subtree are gone.
    assert.equal(store.doc.components[assembly.id], undefined);
    assert.equal(store.doc.components[wing.id],     undefined);
    assert.equal(store.doc.components[subWing.id],  undefined);
    // Features cascaded to the grandparent (root, since assembly's parent is root).
    assert.equal(store.doc.features[boxOnWing.id].componentId,    'root');
    assert.equal(store.doc.features[boxOnSubWing.id].componentId, 'root');
});

test('setFeatureComponent updates the feature componentId', () => {
    const store = resetDocumentStore();
    setActiveComponentProvider(null);
    const wing = addComponent({ name: 'Wing', parentId: 'root' });
    const box = addBox({ length: 1, width: 1, height: 1, componentId: 'root' });
    assert.equal(store.doc.features[box.id].componentId, 'root');
    setFeatureComponent(box.id, wing.id);
    assert.equal(store.doc.features[box.id].componentId, wing.id);
});

test('setFeatureComponent with missing target falls back to root', () => {
    const store = resetDocumentStore();
    setActiveComponentProvider(null);
    const wing = addComponent({ name: 'Wing', parentId: 'root' });
    const box  = addBox({ length: 1, width: 1, height: 1, componentId: wing.id });
    quietWarn(() => setFeatureComponent(box.id, 'doesNotExist'));
    assert.equal(store.doc.features[box.id].componentId, 'root');
});

test("renameComponent('root', ...) is a no-op", () => {
    const store = resetDocumentStore();
    setActiveComponentProvider(null);
    const originalName = store.doc.components.root.name;
    const headBefore = store.doc.head;
    renameComponent('root', 'SomethingElse');
    assert.equal(store.doc.components.root.name, originalName);
    assert.equal(store.doc.head, headBefore);
});

test('renameComponent(child, name) updates the name', () => {
    const store = resetDocumentStore();
    setActiveComponentProvider(null);
    const wing = addComponent({ name: 'Wing', parentId: 'root' });
    renameComponent(wing.id, 'LeftWing');
    assert.equal(store.doc.components[wing.id].name, 'LeftWing');
});

test('componentChildren returns direct children only', () => {
    const store = resetDocumentStore();
    setActiveComponentProvider(null);
    const assembly = addComponent({ name: 'Assembly', parentId: 'root' });
    const wing     = addComponent({ name: 'Wing',     parentId: assembly.id });
    const subWing  = addComponent({ name: 'SubWing',  parentId: wing.id });

    const rootKids = store.componentChildren('root').map(c => c.id);
    assert.deepEqual(rootKids, [assembly.id]);

    const asmKids = store.componentChildren(assembly.id).map(c => c.id);
    assert.deepEqual(asmKids, [wing.id]);

    const wingKids = store.componentChildren(wing.id).map(c => c.id);
    assert.deepEqual(wingKids, [subWing.id]);

    const leafKids = store.componentChildren(subWing.id);
    assert.deepEqual(leafKids, []);
});

test('componentDescendants returns full transitive subtree (excluding root arg)', () => {
    const store = resetDocumentStore();
    setActiveComponentProvider(null);
    const assembly = addComponent({ name: 'Assembly', parentId: 'root' });
    const wing     = addComponent({ name: 'Wing',     parentId: assembly.id });
    const subWing  = addComponent({ name: 'SubWing',  parentId: wing.id });
    const tail     = addComponent({ name: 'Tail',     parentId: 'root' });

    const fromRoot = store.componentDescendants('root').map(c => c.id).sort();
    assert.deepEqual(fromRoot.sort(), [assembly.id, wing.id, subWing.id, tail.id].sort());

    const fromAssembly = store.componentDescendants(assembly.id).map(c => c.id).sort();
    assert.deepEqual(fromAssembly.sort(), [wing.id, subWing.id].sort());

    const fromLeaf = store.componentDescendants(subWing.id);
    assert.deepEqual(fromLeaf, []);
});

test('ADD_COMPONENT with an already-existing id is idempotent', () => {
    const store = resetDocumentStore();
    setActiveComponentProvider(null);
    const c1 = addComponent({ name: 'Wing', parentId: 'root', componentId: 'wing1' });
    assert.equal(store.doc.components.wing1.name, 'Wing');
    // Second commit with the same id should not overwrite the name.
    quietWarn(() => addComponent({ name: 'Other', parentId: 'root', componentId: 'wing1' }));
    assert.equal(store.doc.components.wing1.name, 'Wing');
});

test('removeComponent cascades its connectors, mates, and joints', () => {
    const store = resetDocumentStore();
    setActiveComponentProvider(null);
    // A host component carrying a connector, and a placed component mated +
    // jointed to it.
    const host = addComponent({ name: 'Host', parentId: 'root' });
    const placed = addComponent({ name: 'Placed', parentId: 'root' });
    const hostConn = addConnector({ parent: host.id, kind: 'bore', gender: 'female', axis: [0, 0, 1], origin: [0, 0, 0] });
    const partConn = addConnector({ parent: placed.id, kind: 'shaft', gender: 'male', axis: [0, 0, 1], origin: [0, 0, 0] });
    const mate = addMate({
        hostConnectorRef: { connectorId: hostConn.id, world: null },
        partConnectorRef: { connectorId: partConn.id, sourceConnectorId: 'src' },
        componentId: placed.id,
    });
    const joint = addJoint({ kind: 'revolute', parent: host.id, child: placed.id, origin: [0, 0, 0], axis: [0, 0, 1] });

    // Delete the placed component → its connector, the mate, and the joint
    // must all disappear (no stale snap targets / dangling kinematics).
    removeComponent(placed.id);
    assert.equal(store.doc.components[placed.id], undefined, 'component gone');
    assert.equal(store.doc.connectors[partConn.id], undefined, 'part connector gone');
    assert.equal(store.doc.mates[mate.id], undefined, 'mate gone');
    assert.equal(store.doc.joints[joint.id], undefined, 'joint gone');
    // The host connector survives (its component remains).
    assert.ok(store.doc.connectors[hostConn.id], 'host connector survives');

    // Undo restores everything (cascade is implicit in the fold, not separate
    // changes), so a replay without the remove brings them back.
    store.undo();
    assert.ok(store.doc.components[placed.id], 'component restored on undo');
    assert.ok(store.doc.connectors[partConn.id], 'connector restored on undo');
    assert.ok(store.doc.mates[mate.id], 'mate restored on undo');
    assert.ok(store.doc.joints[joint.id], 'joint restored on undo');
});

test('removeComponent of a host also drops mates anchored to its connector', () => {
    const store = resetDocumentStore();
    setActiveComponentProvider(null);
    const host = addComponent({ name: 'Host', parentId: 'root' });
    const placed = addComponent({ name: 'Placed', parentId: 'root' });
    const hostConn = addConnector({ parent: host.id, kind: 'bore', gender: 'female', axis: [0, 0, 1], origin: [0, 0, 0] });
    const partConn = addConnector({ parent: placed.id, kind: 'shaft', gender: 'male', axis: [0, 0, 1], origin: [0, 0, 0] });
    const mate = addMate({
        hostConnectorRef: { connectorId: hostConn.id, world: null },
        partConnectorRef: { connectorId: partConn.id, sourceConnectorId: 'src' },
        componentId: placed.id,
    });
    // Remove the HOST — the mate referenced its connector, so it must go too.
    removeComponent(host.id);
    assert.equal(store.doc.connectors[hostConn.id], undefined, 'host connector gone');
    assert.equal(store.doc.mates[mate.id], undefined, 'mate anchored to host gone');
});

runAll();
