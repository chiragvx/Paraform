/**
 * Tests for edit-reentry + modifier-selection plumbing:
 *   - lib/document/preview.js          — withSpeculativeParams / withSpeculativeInputs
 *   - lib/viewport/default_actions.js  — targetBodyIdFromSelection + entriesOfKind
 *                                        (exercised via openModifierCommand path)
 *
 * Run via:  node app/__tests__/viewport_edit_modifier.mjs
 */

import assert from 'node:assert/strict';
import {
    withSpeculativeFeature, withSpeculativeParams, withSpeculativeInputs,
} from '../../lib/document/preview.js';
import {
    emptyDocument, makeFeature, bodyRef,
} from '../../lib/document/types.js';
import {
    buildDefaultActions, getCommandSchema, getInitialValues,
} from '../../lib/viewport/default_actions.js';
import { ActionRegistry } from '../../lib/viewport/actions.js';
import { PickingSelection } from '../../lib/picking/selection.js';

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

function memStorage() {
    const data = {};
    return {
        data,
        getItem:    (k) => (k in data ? data[k] : null),
        setItem:    (k, v) => { data[k] = String(v); },
        removeItem: (k) => { delete data[k]; },
    };
}

// ── withSpeculativeParams ───────────────────────────────────────────────────
suite('withSpeculativeParams', () => {
    test('patches an existing feature\'s params without mutating the base doc', () => {
        const doc = emptyDocument();
        const box = makeFeature('Box', { length: 10, width: 10, height: 10, centered: false });
        const after = withSpeculativeFeature(doc, box);
        // Now patch the box's height.
        const patched = withSpeculativeParams(after, box.id, { height: 25 });
        assert.equal(after.features[box.id].params.height, 10);   // base untouched
        assert.equal(patched.features[box.id].params.height, 25); // patched mutated
        // Other params untouched (shallow merge).
        assert.equal(patched.features[box.id].params.length, 10);
        assert.equal(patched.features[box.id].params.width,  10);
    });

    test('no-op when featureId is missing — returns clone, doesn\'t throw', () => {
        const doc = emptyDocument();
        const out = withSpeculativeParams(doc, 'does-not-exist', { foo: 1 });
        assert.deepEqual(out.features, doc.features);
    });
});

// ── withSpeculativeInputs ───────────────────────────────────────────────────
suite('withSpeculativeInputs', () => {
    test('patches an existing feature\'s inputs', () => {
        const doc = emptyDocument();
        const box = makeFeature('Box', { length: 10, width: 10, height: 10 });
        const after = withSpeculativeFeature(doc, box);
        // Add a fillet feature targeting the box.
        const fil = makeFeature('Fillet', { radius: 1 }, { body: bodyRef(box.id) });
        const docFil = withSpeculativeFeature(after, fil);
        // Now reassign Fillet's body to a different (fake) target.
        const patched = withSpeculativeInputs(docFil, fil.id, { body: bodyRef('other') });
        assert.equal(docFil.features[fil.id].inputs.body.featureId, box.id);
        assert.equal(patched.features[fil.id].inputs.body.featureId, 'other');
    });
});

// ── Action catalogue surface ────────────────────────────────────────────────
suite('modifier actions', () => {
    const reg = new ActionRegistry({ storage: memStorage() });
    reg.registerAll(buildDefaultActions());

    test('Fillet / Chamfer / Shell remain enabled only when something is selected', () => {
        const fillet  = reg.get('feat.fillet');
        const chamfer = reg.get('feat.chamfer');
        const shell   = reg.get('feat.shell');
        const emptyCtx = { selection: { size: 0 }, sketchActive: false };
        const filledCtx = { selection: { size: 3 }, sketchActive: false };
        assert.equal(fillet.isEnabled(emptyCtx),  false);
        assert.equal(chamfer.isEnabled(emptyCtx), false);
        assert.equal(shell.isEnabled(emptyCtx),   false);
        assert.equal(fillet.isEnabled(filledCtx),  true);
        assert.equal(chamfer.isEnabled(filledCtx), true);
        assert.equal(shell.isEnabled(filledCtx),   true);
    });

    test('Modifier actions toast when selection spans multiple bodies', () => {
        // Build a stub ctx where the selection has two distinct feature ids.
        // Without openCommand wired, the action's fallback path should toast
        // and abort cleanly (no throw).
        const sel = new PickingSelection();
        sel.add({ kind: 'edge', feature: 'A', opTag: 'Box', part: 'A' }, { center: [0,0,0], featureId: 'A' });
        sel.add({ kind: 'edge', feature: 'B', opTag: 'Box', part: 'B' }, { center: [0,0,0], featureId: 'B' });
        let toasted = null;
        const ctx = {
            selection: sel,
            ops: {},
            bridge: { runNow() {} },
            sketchActive: false,
            toast: (msg, kind) => { toasted = { msg, kind }; },
        };
        reg.run('feat.fillet', ctx);
        assert.ok(toasted, 'expected a toast');
        assert.match(toasted.msg, /single body/);
    });

    test('Modifier actions toast when picks are the wrong kind (face vs edge)', () => {
        const sel = new PickingSelection();
        // Fillet wants edges; we feed it a face — no edges → message.
        sel.add({ kind: 'face', feature: 'A', opTag: 'Box', part: 'A' }, { center: [0,0,0], featureId: 'A' });
        let toasted = null;
        const ctx = {
            selection: sel,
            ops: {},
            bridge: { runNow() {} },
            sketchActive: false,
            toast: (msg) => { toasted = msg; },
        };
        reg.run('feat.fillet', ctx);
        assert.ok(toasted, 'expected a toast');
        assert.match(toasted, /edge/);
    });

    test('Fallback path (no openCommand) calls the v4 op with body id + refs', () => {
        const sel = new PickingSelection();
        sel.add({ kind: 'edge', feature: 'box-1', opTag: 'Box', part: 'box-1' },
                { center: [5, 0, 0], normal: [0, 0, 1], featureId: 'box-1' });
        const calls = [];
        const ctx = {
            selection: sel,
            ops: {
                addFillet: (bodyId, params) => { calls.push({ bodyId, params }); return null; },
            },
            bridge: { runNow() {} },
            sketchActive: false,
            toast: () => {},
        };
        reg.run('feat.fillet', ctx);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].bodyId, 'box-1');
        assert.equal(calls[0].params.radius, 1);    // initial default
        assert.equal(calls[0].params.edges.length, 1);
        assert.deepEqual(calls[0].params.edges[0].fingerprint.centerRounded, [5, 0, 0]);
    });

    test('Shell takes "openFaces" instead of "edges"', () => {
        const sel = new PickingSelection();
        sel.add({ kind: 'face', feature: 'box-1', opTag: 'Box', part: 'box-1' },
                { center: [0, 0, 10], normal: [0, 0, 1], featureId: 'box-1' });
        const calls = [];
        const ctx = {
            selection: sel,
            ops: { addShell: (bodyId, params) => { calls.push({ bodyId, params }); } },
            bridge: { runNow() {} }, sketchActive: false, toast: () => {},
        };
        reg.run('feat.shell', ctx);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].params.thickness, 1);
        assert.ok(Array.isArray(calls[0].params.openFaces));
        assert.equal(calls[0].params.openFaces.length, 1);
    });
});

// ── Schema lookup for edit-reentry ──────────────────────────────────────────
suite('edit reentry surface', () => {
    test('getCommandSchema returns valid schemas for every primitive + modifier', () => {
        for (const t of ['Box', 'Cylinder', 'Sphere', 'Torus',
                         'Extrude', 'Fillet', 'Chamfer', 'Shell', 'Hole']) {
            const s = getCommandSchema(t);
            assert.ok(Array.isArray(s), `${t} schema not array`);
            assert.ok(s.length > 0,     `${t} schema is empty`);
        }
    });

    test('getInitialValues yields keys present in the schema', () => {
        for (const t of ['Box', 'Cylinder', 'Fillet']) {
            const init = getInitialValues(t);
            const sKeys = getCommandSchema(t).map(s => s.key);
            for (const k of Object.keys(init)) {
                assert.ok(sKeys.includes(k), `${t}: initial key ${k} not in schema`);
            }
        }
    });
});

await runAll();
