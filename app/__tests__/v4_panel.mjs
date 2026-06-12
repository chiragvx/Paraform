/**
 * Tests for app/v4_panel — schemas + persistence.
 * The DOM-aware modules (feature_tree.js, inspector.js, styles.js,
 * index.js) are smoke-checked at the integration layer; here we cover
 * the deterministic pure layer.
 *
 * Run via:  node app/__tests__/v4_panel.mjs
 */

import assert from 'node:assert/strict';
import {
    SCHEMAS, schemaFor, coerceField, defaultParamsFor, typeLabel,
} from '../v4_panel/schemas.js';
import {
    saveToStorage, loadFromStorage, clearStorage, storageSize,
    attachAutoSave,
} from '../v4_panel/persistence.js';
import { DocumentStore } from '../../lib/document/store.js';
import { addBox, addFillet } from '../../lib/document/operations.js';
import { resetDocumentStore, getDocumentStore } from '../../lib/document/store.js';

// ── In-memory storage shim (parity with the settings test) ──────────────────
function memStorage(initial = {}) {
    const data = { ...initial };
    return {
        data,
        getItem:    (k)    => (k in data ? data[k] : null),
        setItem:    (k, v) => { data[k] = String(v); },
        removeItem: (k)    => { delete data[k]; },
    };
}

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
    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail > 0) process.exit(1);
}

// ── Schemas ──────────────────────────────────────────────────────────────────
suite('schemas', () => {
    test('schemaFor returns the registered schema or []', () => {
        assert.equal(schemaFor('Box').length, 4);
        assert.equal(schemaFor('Cylinder').length, 3);
        assert.equal(schemaFor('Sketch').length, 0);
        assert.equal(schemaFor('NotAFeature').length, 0);
    });

    test('Helix exposes pitch/height/radius/coneAngle/lefthand', () => {
        const keys = SCHEMAS.Helix.map(f => f.key);
        for (const k of ['pitch','height','radius','coneAngle','lefthand']) {
            assert.ok(keys.includes(k), `Helix missing "${k}"`);
        }
        const lh = SCHEMAS.Helix.find(f => f.key === 'lefthand');
        assert.equal(lh.kind, 'bool');
    });

    test('Loft exposes `ruled` as a boolean', () => {
        const ruled = SCHEMAS.Loft.find(f => f.key === 'ruled');
        assert.ok(ruled);
        assert.equal(ruled.kind, 'bool');
    });

    test('Thread exposes a spec enum + length', () => {
        const spec = SCHEMAS.Thread.find(f => f.key === 'spec');
        assert.equal(spec.kind, 'enum');
        const sizes = spec.options.map(o => o.value);
        for (const m of ['M3', 'M4', 'M5', 'M6', 'M8', 'M10']) {
            assert.ok(sizes.includes(m), `Thread spec missing "${m}"`);
        }
        const len = SCHEMAS.Thread.find(f => f.key === 'length');
        assert.equal(len.kind, 'number');
    });

    test('ImportSTEP exposes a text path field', () => {
        const path = SCHEMAS.ImportSTEP.find(f => f.key === 'path');
        assert.ok(path);
        assert.equal(path.kind, 'text');
    });

    test('Hole counterDia/counterDepth are hidden for "simple" type', () => {
        const cd  = SCHEMAS.Hole.find(f => f.key === 'counterDia');
        const cdp = SCHEMAS.Hole.find(f => f.key === 'counterDepth');
        assert.ok(cd && typeof cd.hidden === 'function');
        assert.ok(cdp && typeof cdp.hidden === 'function');
        // Simple → both hidden
        assert.equal(cd.hidden({  type: 'simple' }), true);
        assert.equal(cdp.hidden({ type: 'simple' }), true);
        // Counterbore → both visible
        assert.equal(cd.hidden({  type: 'counterbore' }), false);
        assert.equal(cdp.hidden({ type: 'counterbore' }), false);
        // Countersink → diameter visible, depth hidden (derived from angle)
        assert.equal(cd.hidden({  type: 'countersink' }), false);
        assert.equal(cdp.hidden({ type: 'countersink' }), true);
        // Missing type behaves like simple
        assert.equal(cd.hidden({}), true);
    });

    test('typeLabel falls back to the raw type when unknown', () => {
        assert.equal(typeLabel('Box'), 'Box');
        assert.equal(typeLabel('LinearPattern'), 'Linear Pattern');
        assert.equal(typeLabel('NotAFeature'), 'NotAFeature');
    });

    test('every schema entry has key+label+kind', () => {
        for (const [type, schema] of Object.entries(SCHEMAS)) {
            for (const spec of schema) {
                assert.ok(spec.key,   `${type}: missing key`);
                assert.ok(spec.label, `${type}.${spec.key}: missing label`);
                assert.ok(spec.kind,  `${type}.${spec.key}: missing kind`);
            }
        }
    });

    test('defaultParamsFor produces a complete params object', () => {
        const p = defaultParamsFor('Box');
        for (const k of ['length','width','height','centered']) {
            assert.ok(k in p, `missing default for ${k}`);
        }
    });
});

// ── coerceField ──────────────────────────────────────────────────────────────
suite('coerceField', () => {
    const numField = { key: 'r', label: 'R', kind: 'number', min: 0.001, max: 100 };

    test('number string coerces to a number', () => {
        assert.equal(coerceField(numField, '12.5'), 12.5);
        assert.equal(coerceField(numField, '0.001'), 0.001);
    });

    test('expressions (= prefix) pass through trimmed', () => {
        assert.equal(coerceField(numField, '=wall * 2'), '=wall * 2');
        assert.equal(coerceField(numField, '  =wall*2  '), '=wall*2');
    });

    test('out-of-range numbers throw', () => {
        assert.throws(() => coerceField(numField, '0'),     /must be ≥/);
        assert.throws(() => coerceField(numField, '999'),   /must be ≤/);
    });

    test('non-numeric strings throw', () => {
        assert.throws(() => coerceField(numField, 'abc'), /expects a number/);
    });

    test('int field rounds to integer', () => {
        const f = { key: 'n', label: 'N', kind: 'int', min: 1 };
        assert.equal(coerceField(f, '3.7'), 4);
        assert.equal(coerceField(f, '1.2'), 1);
        assert.throws(() => coerceField(f, '0'), /must be ≥/);
    });

    test('bool field accepts booleans, "true"/"false", 0/1', () => {
        const f = { key: 'b', label: 'B', kind: 'bool' };
        assert.equal(coerceField(f, true), true);
        assert.equal(coerceField(f, 'true'), true);
        assert.equal(coerceField(f, '1'), true);
        assert.equal(coerceField(f, false), false);
        assert.equal(coerceField(f, 'false'), false);
        assert.equal(coerceField(f, '0'), false);
        assert.throws(() => coerceField(f, 'maybe'), /expects a boolean/);
    });

    test('enum field requires a registered value', () => {
        const f = { key: 'k', label: 'K', kind: 'enum', options: [{value:'a',label:'A'},{value:'b',label:'B'}] };
        assert.equal(coerceField(f, 'a'), 'a');
        assert.throws(() => coerceField(f, 'c'), /must be one of/);
    });

    test('vec3 field validates length and numeric components', () => {
        const f = { key: 'v', label: 'V', kind: 'vec3' };
        assert.deepEqual(coerceField(f, ['1', '2', '3']), [1, 2, 3]);
        assert.throws(() => coerceField(f, [1, 2]),       /expects a \[x, y, z\]/);
        assert.throws(() => coerceField(f, ['a','b','c']),/components must be numbers/);
    });

    test('read-only field rejects edits', () => {
        const f = { key: 'name', label: 'Name', kind: 'text', readOnly: true };
        assert.throws(() => coerceField(f, 'hi'), /read-only/);
    });
});

// ── localStorage I/O ────────────────────────────────────────────────────────
suite('persistence', () => {
    test('saveToStorage + loadFromStorage round-trip', () => {
        const store = memStorage();
        const data = { version: 4, id: 'doc_1', changelog: [], head: -1 };
        assert.equal(saveToStorage(data, store), true);
        assert.deepEqual(loadFromStorage(store), data);
    });

    test('loadFromStorage returns null for missing or corrupted entries', () => {
        const store = memStorage();
        assert.equal(loadFromStorage(store), null);
        store.setItem('paraform_v4_document', '{ not json');
        assert.equal(loadFromStorage(store), null);
    });

    test('clearStorage removes the entry', () => {
        const store = memStorage();
        saveToStorage({ a: 1 }, store);
        clearStorage(store);
        assert.equal(loadFromStorage(store), null);
    });

    test('storageSize reflects the serialised length', () => {
        const store = memStorage();
        assert.equal(storageSize(store), 0);
        saveToStorage({ a: 1 }, store);
        assert.equal(storageSize(store), JSON.stringify({a:1}).length);
    });

    test('functions degrade gracefully with no storage', () => {
        assert.equal(saveToStorage({}, null), false);
        assert.equal(loadFromStorage(null), null);
        assert.equal(storageSize(null), 0);
    });
});

// ── attachAutoSave ──────────────────────────────────────────────────────────
suite('autosave', () => {
    test('every commit triggers a debounced save', async () => {
        const storage = memStorage();
        const store = resetDocumentStore();
        let saves = 0;
        const detach = attachAutoSave(store, { delayMs: 5, storage, onSave: () => { saves++; } });
        addBox();
        addBox();
        await new Promise(r => setTimeout(r, 50));
        assert.equal(saves, 1);    // two commits coalesced into one save
        const loaded = loadFromStorage(storage);
        assert.ok(loaded);
        assert.equal(loaded.version, 5);
        assert.equal(loaded.changelog.length, 2);
        detach();
    });

    test('after detach no further saves fire', async () => {
        const storage = memStorage();
        const store = resetDocumentStore();
        let saves = 0;
        const detach = attachAutoSave(store, { delayMs: 5, storage, onSave: () => { saves++; } });
        addBox();
        await new Promise(r => setTimeout(r, 30));
        assert.equal(saves, 1);
        detach();
        addBox();
        await new Promise(r => setTimeout(r, 30));
        assert.equal(saves, 1);   // unchanged
    });

    test('selection events do not trigger saves', async () => {
        const storage = memStorage();
        const store = resetDocumentStore();
        let saves = 0;
        const detach = attachAutoSave(store, { delayMs: 5, storage, onSave: () => { saves++; } });
        const f = addBox();
        await new Promise(r => setTimeout(r, 30));
        assert.equal(saves, 1);
        store.selectFeature(f.id);
        await new Promise(r => setTimeout(r, 30));
        assert.equal(saves, 1);   // unchanged
        detach();
    });
});

// ── Full round-trip through DocumentStore ────────────────────────────────────
suite('round-trip', () => {
    test('save → mutate → load restores the original document', async () => {
        const storage = memStorage();
        const store = resetDocumentStore();
        const a = addBox({ length: 12 });
        const b = addFillet(a.id, { radius: 2 });
        const json = store.toJSON();
        assert.equal(saveToStorage(json, storage), true);

        // Mutate the live store
        addBox({ length: 99 });
        assert.equal(Object.keys(store.doc.features).length, 3);

        // Load and verify the previous shape returns
        const reloaded = loadFromStorage(storage);
        store.fromJSON(reloaded);
        assert.equal(Object.keys(store.doc.features).length, 2);
        assert.equal(store.doc.features[a.id].params.length, 12);
        assert.equal(store.doc.features[b.id].params.radius, 2);
    });
});

runAll();
