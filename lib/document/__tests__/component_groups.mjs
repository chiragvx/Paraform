/**
 * Component grouping semantics — group kind, first-child promotion on
 * delete, ungroup, auto-group wrap, and part-delete cascade.
 *
 * Run with:  node lib/document/__tests__/component_groups.mjs
 */

import assert from 'node:assert/strict';
import {
    resetDocumentStore, getDocumentStore,
    addComponent, removeComponent, removeComponentPromote,
    ungroupComponent, groupComponents,
    addStandardPart, addBox,
    deleteFeature, deleteFeatureCascade,
} from '../index.js';

const _tests = [];
let _currentSuite = '';
function suite(name, fn) { _currentSuite = name; fn(); _currentSuite = ''; }
function test(name, fn)  { _tests.push({ suite: _currentSuite, name, fn }); }
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

function fresh() {
    resetDocumentStore();
    return getDocumentStore();
}

suite('component kind', () => {
    test('addComponent defaults to kind component; group sticks', () => {
        const store = fresh();
        const a = addComponent({ name: 'A' });
        const g = addComponent({ name: 'G', kind: 'group' });
        assert.equal(store.doc.components[a.id].kind, 'component');
        assert.equal(store.doc.components[g.id].kind, 'group');
    });
});

suite('groupComponents', () => {
    test('wraps target + child in a new group at the target\'s level', () => {
        const store = fresh();
        const a = addComponent({ name: 'Rail' });
        const b = addComponent({ name: 'Nut' });
        const g = groupComponents(a.id, b.id);
        assert.ok(g, 'group created');
        const doc = store.doc;
        assert.equal(doc.components[g.id].kind, 'group');
        assert.equal(doc.components[g.id].parentId, 'root');
        assert.equal(doc.components[a.id].parentId, g.id);
        assert.equal(doc.components[b.id].parentId, g.id);
        assert.equal(doc.components[g.id].name, 'Rail group');
    });

    test('refuses root / self / missing ids', () => {
        fresh();
        const a = addComponent({ name: 'A' });
        assert.equal(groupComponents('root', a.id), null);
        assert.equal(groupComponents(a.id, a.id), null);
        assert.equal(groupComponents(a.id, 'nope'), null);
    });
});

suite('removeComponentPromote', () => {
    test('first child takes the deleted parent\'s place; siblings move under it', () => {
        const store = fresh();
        const p = addComponent({ name: 'Parent' });
        const c1 = addComponent({ name: 'C1', parentId: p.id });
        const c2 = addComponent({ name: 'C2', parentId: p.id });
        const c3 = addComponent({ name: 'C3', parentId: p.id });
        removeComponentPromote(p.id);
        const doc = store.doc;
        assert.equal(doc.components[p.id], undefined, 'parent gone');
        assert.equal(doc.components[c1.id].parentId, 'root', 'heir promoted');
        assert.equal(doc.components[c2.id].parentId, c1.id, 'sibling under heir');
        assert.equal(doc.components[c3.id].parentId, c1.id, 'sibling under heir');
    });

    test('childless node deletes like removeComponent (StandardPart cascades)', () => {
        const store = fresh();
        const p = addComponent({ name: 'Part' });
        const f = addStandardPart('iso4032-m4', { componentId: p.id });
        removeComponentPromote(p.id);
        assert.equal(store.doc.components[p.id], undefined);
        assert.equal(store.doc.features[f.id], undefined, 'body deleted with its part');
    });

    test('grandchildren are untouched (no cascade past the heir)', () => {
        const store = fresh();
        const p = addComponent({ name: 'P' });
        const c = addComponent({ name: 'C', parentId: p.id });
        const gc = addComponent({ name: 'GC', parentId: c.id });
        const f = addStandardPart('iso4032-m4', { componentId: gc.id });
        removeComponentPromote(p.id);
        const doc = store.doc;
        assert.equal(doc.components[c.id].parentId, 'root');
        assert.equal(doc.components[gc.id].parentId, c.id);
        assert.ok(doc.features[f.id], 'grandchild body survives');
    });
});

suite('ungroupComponent', () => {
    test('members move up a level flat; group is removed', () => {
        const store = fresh();
        const a = addComponent({ name: 'A' });
        const b = addComponent({ name: 'B' });
        const g = groupComponents(a.id, b.id);
        ungroupComponent(g.id);
        const doc = store.doc;
        assert.equal(doc.components[g.id], undefined);
        assert.equal(doc.components[a.id].parentId, 'root');
        assert.equal(doc.components[b.id].parentId, 'root');
    });

    test('non-StandardPart features in the group fall back to its parent', () => {
        const store = fresh();
        const g = addComponent({ name: 'G', kind: 'group' });
        const f = addBox({ length: 1, width: 1, height: 1, componentId: g.id });
        ungroupComponent(g.id);
        assert.equal(store.doc.features[f.id].componentId, 'root');
    });
});

suite('deleteFeatureCascade', () => {
    test('lone StandardPart body removes the wrapping component too', () => {
        const store = fresh();
        const p = addComponent({ name: 'Nut' });
        const f = addStandardPart('iso4032-m4', { componentId: p.id });
        deleteFeatureCascade(f.id);
        assert.equal(store.doc.features[f.id], undefined);
        assert.equal(store.doc.components[p.id], undefined, 'component husk removed');
    });

    test('children of the part survive via promotion', () => {
        const store = fresh();
        const p = addComponent({ name: 'Rail' });
        const f = addStandardPart('extr-2020', { componentId: p.id });
        const c = addComponent({ name: 'Nut', parentId: p.id });
        const cf = addStandardPart('iso4032-m4', { componentId: c.id });
        deleteFeatureCascade(f.id);
        const doc = store.doc;
        assert.equal(doc.components[p.id], undefined);
        assert.equal(doc.components[c.id].parentId, 'root', 'child promoted');
        assert.ok(doc.features[cf.id], 'child body kept');
    });

    test('component with other features only loses the one feature', () => {
        const store = fresh();
        const p = addComponent({ name: 'P' });
        const f = addStandardPart('iso4032-m4', { componentId: p.id });
        const b = addBox({ length: 1, width: 1, height: 1, componentId: p.id });
        deleteFeatureCascade(f.id);
        const doc = store.doc;
        assert.ok(doc.components[p.id], 'component kept');
        assert.equal(doc.features[f.id], undefined);
        assert.ok(doc.features[b.id], 'sibling feature kept');
    });

    test('plain feature in root deletes normally', () => {
        const store = fresh();
        const b = addBox({ length: 1, width: 1, height: 1 });
        deleteFeatureCascade(b.id);
        assert.equal(store.doc.features[b.id], undefined);
    });

    test('group payload is never cascaded by feature delete', () => {
        const store = fresh();
        const g = addComponent({ name: 'G', kind: 'group' });
        const f = addStandardPart('iso4032-m4', { componentId: g.id });
        deleteFeatureCascade(f.id);
        assert.ok(store.doc.components[g.id], 'group kept');
        assert.equal(store.doc.features[f.id], undefined);
    });
});

console.log('\n── lib/document component grouping (group / promote / ungroup / cascade) ──');
await runAll();
