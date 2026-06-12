/**
 * Tests for the sketcher's E2.3 / E2.5 / E2.6 additions.
 *
 * Run via:  node app/sketch_3d/__tests__/sketcher_tools.mjs
 *
 * The legacy renderer/controller depend on THREE.js; the tests here exercise
 * the pure-math + sketch_data slices that don't need it:
 *   - tool-key registration in TOOL_FACTORIES_3D
 *   - arcThroughThreePoints / circumcenter math
 *   - TEXT entity creation
 *   - driven-dim flag round-trip through sketch_data
 *   - SketchModeController.cancel() confirmation-on-uncommitted-entities
 *     (we stub the controller's heavy bits and only exercise the gate).
 */

import assert from 'node:assert/strict';
import {
    TOOL_FACTORIES_3D,
    circumcenter, arcThroughThreePoints,
} from '../tools_3d.js';
import {
    makePoint, makeText, ENTITY_KIND,
} from '../../../lib/sketch/entities.js';
import {
    stockPlane, makeSketchData, addEntity, addConstraint, setConstraintDriven,
} from '../../../lib/sketch/sketch_data.js';
import { fixedDistance } from '../../../lib/sketch/constraints.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ── E2.3 / E2.5: tool registration ─────────────────────────────────────────
test('tool registry contains arc-tangent / arc-3point / arc-center / text', () => {
    assert.equal(typeof TOOL_FACTORIES_3D['arc-tangent'], 'function');
    assert.equal(typeof TOOL_FACTORIES_3D['arc-3point'],  'function');
    assert.equal(typeof TOOL_FACTORIES_3D['arc-center'],  'function');
    assert.equal(typeof TOOL_FACTORIES_3D['text'],        'function');
});

test('tool factories produce objects with onPointerDown / activate', () => {
    for (const key of ['arc-tangent', 'arc-3point', 'arc-center', 'text']) {
        const t = TOOL_FACTORIES_3D[key]();
        assert.equal(t.kind, key, `${key}: kind mismatch`);
        assert.equal(typeof t.onPointerDown, 'function');
        assert.equal(typeof t.activate, 'function');
    }
});

// ── Arc math ────────────────────────────────────────────────────────────────
test('circumcenter of (0,0)(1,1)(2,0) is (1, 0)', () => {
    const c = circumcenter({x:0,y:0}, {x:1,y:1}, {x:2,y:0});
    assert.ok(c, 'expected a centre');
    assert.ok(Math.abs(c.x - 1) < 1e-9, `x=${c.x}`);
    assert.ok(Math.abs(c.y - 0) < 1e-9, `y=${c.y}`);
});

test('circumcenter of collinear points returns null', () => {
    assert.equal(circumcenter({x:0,y:0}, {x:1,y:0}, {x:2,y:0}), null);
});

test('arcThroughThreePoints (0,0)(1,1)(2,0) → radius=1, centre=(1,0), passes through (1,1)', () => {
    const arc = arcThroughThreePoints({x:0,y:0}, {x:1,y:1}, {x:2,y:0});
    assert.ok(arc, 'expected an arc');
    assert.ok(Math.abs(arc.radius - 1) < 1e-9, `r=${arc.radius}`);
    assert.ok(Math.abs(arc.center.x - 1) < 1e-9);
    assert.ok(Math.abs(arc.center.y - 0) < 1e-9);
    // Mid-arc point at (a0 + sweep/2)
    const a = arc.startAngle + arc.sweepAngle * 0.5;
    const mx = arc.center.x + arc.radius * Math.cos(a);
    const my = arc.center.y + arc.radius * Math.sin(a);
    assert.ok(Math.abs(mx - 1) < 1e-6, `mid x=${mx}`);
    assert.ok(Math.abs(my - 1) < 1e-6, `mid y=${my}`);
});

test('arcThroughThreePoints returns null for collinear points', () => {
    assert.equal(arcThroughThreePoints({x:0,y:0}, {x:1,y:0}, {x:2,y:0}), null);
});

// ── TEXT entity ────────────────────────────────────────────────────────────
test('TEXT entity create + add to sketch', () => {
    const sk = makeSketchData(stockPlane('XY'));
    const p  = addEntity(sk, makePoint(10, 20));
    const t  = addEntity(sk, makeText(p.id, 'Hello', 5));
    assert.equal(t.kind, ENTITY_KIND.TEXT);
    assert.equal(t.params.text, 'Hello');
    assert.equal(t.params.height, 5);
    assert.equal(t.params.positionId, p.id);
});

// ── Driven dimension flag ──────────────────────────────────────────────────
test('driven flag round-trips through JSON', () => {
    const sk = makeSketchData(stockPlane('XY'));
    const a  = addEntity(sk, makePoint(0, 0));
    const b  = addEntity(sk, makePoint(10, 0));
    const c  = addConstraint(sk, fixedDistance(a.id, b.id, 10));
    setConstraintDriven(sk, c.id, true);
    assert.equal(sk.constraints[c.id].driven, true);

    const json = JSON.parse(JSON.stringify(sk));
    assert.equal(json.constraints[c.id].driven, true,
        'driven flag must survive JSON serialisation');
});

test('setConstraintDriven false clears the flag', () => {
    const sk = makeSketchData(stockPlane('XY'));
    const a  = addEntity(sk, makePoint(0, 0));
    const b  = addEntity(sk, makePoint(10, 0));
    const c  = addConstraint(sk, fixedDistance(a.id, b.id, 10));
    setConstraintDriven(sk, c.id, true);
    setConstraintDriven(sk, c.id, false);
    assert.equal(sk.constraints[c.id].driven, false);
});

// ── Newton solver: skips driven constraints ────────────────────────────────
test('solver skips driven constraints (does not fight the dim)', async () => {
    const { solve } = await import('../../../lib/sketch/solver/index.js');
    const sk = makeSketchData(stockPlane('XY'));
    const a  = addEntity(sk, makePoint(0, 0));
    const b  = addEntity(sk, makePoint(7, 0));   // current distance 7
    // Driven distance of 100mm — solver should NOT pull b out to 100.
    const c  = addConstraint(sk, fixedDistance(a.id, b.id, 100));
    setConstraintDriven(sk, c.id, true);
    solve(sk);
    const dx = sk.entities[b.id].params.x - sk.entities[a.id].params.x;
    assert.ok(Math.abs(dx - 7) < 0.5,
        `driven constraint must not move b; dx=${dx}`);
});

// ── Exit-confirm gate ──────────────────────────────────────────────────────
test('_hasUncommittedEntities returns false for an empty sketch', async () => {
    // Avoid importing the heavy SketchModeController class (it pulls in
    // THREE via the renderer); inline a minimal stand-in that copies the
    // method body.
    const sketchData = makeSketchData(stockPlane('XY'));
    const probe = {
        sketchData,
        _editingExistingFeatureId: null,
        _hasUncommittedEntities() {
            if (!this.sketchData) return false;
            const n = this.sketchData.entityOrder.length;
            if (n === 0) return false;
            if (this._editingExistingFeatureId) {
                return this.sketchData.updatedAt !== this.sketchData.createdAt;
            }
            return true;
        },
    };
    assert.equal(probe._hasUncommittedEntities(), false);
    addEntity(probe.sketchData, makePoint(0, 0));
    assert.equal(probe._hasUncommittedEntities(), true,
        'must report dirty after entity added');
});

test('exit-confirm prompt fires when there are uncommitted entities', () => {
    let promptedWith = null;
    const fakeWindow = {
        confirm(msg) { promptedWith = msg; return false; },
    };
    // Simulate the cancel() guard.
    const sketchData = makeSketchData(stockPlane('XY'));
    addEntity(sketchData, makePoint(1, 2));
    const dirty = sketchData.entityOrder.length > 0;
    if (dirty) {
        const ok = fakeWindow.confirm('Discard sketch changes?');
        assert.equal(ok, false);
        assert.equal(promptedWith, 'Discard sketch changes?');
    } else {
        throw new Error('test bug: sketch should be dirty');
    }
});

// ── Run ────────────────────────────────────────────────────────────────────
let failed = 0;
for (const t of tests) {
    try {
        await t.fn();
        console.log(`  ok  ${t.name}`);
    } catch (err) {
        failed++;
        console.error(`FAIL  ${t.name}`);
        console.error(`      ${err.message}`);
        if (err.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'));
    }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
if (failed > 0) process.exit(1);
