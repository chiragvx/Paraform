/**
 * Tests for the selection-driven constraint helpers + the constraint panel
 * state machine + the tangent snap detection.
 *
 * Run via:  node app/__tests__/sketch_3d_constraints.mjs
 */

import assert from 'node:assert/strict';
import {
    tryHorizontal, tryVertical, tryParallel, tryPerpendicular, tryTangent,
    tryCoincident, tryEqualLength, tryEqualRadius, tryMidpoint,
    tryPointOnLine, tryPointOnCircle, trySymmetric,
    CONSTRAINT_TOOLS, evaluateAll,
} from '../../lib/sketch/constraint_apply.js';
import { ConstraintPanel } from '../sketch_3d/constraint_panel.js';
import { snap, SNAP_KINDS, inferConstraints } from '../sketch_3d/snap_3d.js';
import { lineTool3D } from '../sketch_3d/tools_3d.js';
import {
    makeSketchData, stockPlane, addEntity, addConstraint, constraintCount,
} from '../../lib/sketch/sketch_data.js';
import {
    makePoint, makeLine, makeCircle,
} from '../../lib/sketch/entities.js';
import { CONSTRAINT_KIND } from '../../lib/sketch/constraints.js';

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
const near = (a, b, tol = 1e-3) => Math.abs(a - b) <= tol;

// ── Helper to build sketches for the constraint-apply tests ─────────────────

function lineSketch(p1 = [0, 0], p2 = [10, 0]) {
    const s = makeSketchData(stockPlane('XY'));
    const a = addEntity(s, makePoint(p1[0], p1[1]));
    const b = addEntity(s, makePoint(p2[0], p2[1]));
    const L = addEntity(s, makeLine(a.id, b.id));
    return { s, a, b, L };
}
function circleSketch(center = [0, 0], r = 5) {
    const s = makeSketchData(stockPlane('XY'));
    const c = addEntity(s, makePoint(center[0], center[1]));
    const C = addEntity(s, makeCircle(c.id, r));
    return { s, c, C };
}

// ── constraint_apply — try* helpers ─────────────────────────────────────────
suite('try* helpers › positive cases', () => {
    test('tryHorizontal accepts exactly one line', () => {
        const { s, L } = lineSketch();
        const r = tryHorizontal([L.id], s);
        assert.equal(r.ok, true);
        assert.equal(r.constraint.kind, CONSTRAINT_KIND.HORIZONTAL);
    });

    test('tryVertical accepts exactly one line', () => {
        const { s, L } = lineSketch();
        const r = tryVertical([L.id], s);
        assert.equal(r.ok, true);
        assert.equal(r.constraint.kind, CONSTRAINT_KIND.VERTICAL);
    });

    test('tryParallel accepts two lines', () => {
        const s = makeSketchData(stockPlane('XY'));
        const a = addEntity(s, makePoint(0, 0));
        const b = addEntity(s, makePoint(10, 0));
        const c = addEntity(s, makePoint(0, 5));
        const d = addEntity(s, makePoint(10, 5));
        const L1 = addEntity(s, makeLine(a.id, b.id));
        const L2 = addEntity(s, makeLine(c.id, d.id));
        const r = tryParallel([L1.id, L2.id], s);
        assert.equal(r.ok, true);
        assert.equal(r.constraint.kind, CONSTRAINT_KIND.PARALLEL);
    });

    test('tryPerpendicular accepts two lines', () => {
        const { s, L } = lineSketch();
        const c = addEntity(s, makePoint(0, 0));
        const d = addEntity(s, makePoint(0, 10));
        const L2 = addEntity(s, makeLine(c.id, d.id));
        const r = tryPerpendicular([L.id, L2.id], s);
        assert.equal(r.ok, true);
        assert.equal(r.constraint.kind, CONSTRAINT_KIND.PERPENDICULAR);
    });

    test('tryTangent accepts line + circle in either order', () => {
        const { s, L } = lineSketch();
        const c = addEntity(s, makePoint(20, 0));
        const C = addEntity(s, makeCircle(c.id, 5));
        const r1 = tryTangent([L.id, C.id], s);
        const r2 = tryTangent([C.id, L.id], s);
        assert.equal(r1.ok, true);
        assert.equal(r2.ok, true);
        assert.equal(r1.constraint.kind, CONSTRAINT_KIND.TANGENT);
    });

    test('tryTangent accepts two circles', () => {
        const s = makeSketchData(stockPlane('XY'));
        const c1 = addEntity(s, makePoint(0, 0));
        const C1 = addEntity(s, makeCircle(c1.id, 5));
        const c2 = addEntity(s, makePoint(20, 0));
        const C2 = addEntity(s, makeCircle(c2.id, 3));
        const r = tryTangent([C1.id, C2.id], s);
        assert.equal(r.ok, true);
    });

    test('tryCoincident accepts two points', () => {
        const s = makeSketchData(stockPlane('XY'));
        const a = addEntity(s, makePoint(0, 0));
        const b = addEntity(s, makePoint(10, 0));
        const r = tryCoincident([a.id, b.id], s);
        assert.equal(r.ok, true);
    });

    test('tryEqualLength accepts two lines', () => {
        const s = makeSketchData(stockPlane('XY'));
        const a = addEntity(s, makePoint(0, 0));
        const b = addEntity(s, makePoint(10, 0));
        const c = addEntity(s, makePoint(0, 5));
        const d = addEntity(s, makePoint(15, 5));
        const L1 = addEntity(s, makeLine(a.id, b.id));
        const L2 = addEntity(s, makeLine(c.id, d.id));
        const r = tryEqualLength([L1.id, L2.id], s);
        assert.equal(r.ok, true);
    });

    test('tryEqualRadius accepts two circles', () => {
        const s = makeSketchData(stockPlane('XY'));
        const c1 = addEntity(s, makePoint(0, 0));
        const C1 = addEntity(s, makeCircle(c1.id, 5));
        const c2 = addEntity(s, makePoint(20, 0));
        const C2 = addEntity(s, makeCircle(c2.id, 3));
        const r = tryEqualRadius([C1.id, C2.id], s);
        assert.equal(r.ok, true);
    });

    test('tryMidpoint accepts a point + a line', () => {
        const { s, L } = lineSketch();
        const p = addEntity(s, makePoint(5, 0));
        const r = tryMidpoint([p.id, L.id], s);
        assert.equal(r.ok, true);
    });

    test('tryPointOnLine accepts a point + a line', () => {
        const { s, L } = lineSketch();
        const p = addEntity(s, makePoint(2, 0));
        const r = tryPointOnLine([p.id, L.id], s);
        assert.equal(r.ok, true);
    });

    test('tryPointOnCircle accepts a point + a circle', () => {
        const { s, C } = circleSketch();
        const p = addEntity(s, makePoint(5, 0));
        const r = tryPointOnCircle([p.id, C.id], s);
        assert.equal(r.ok, true);
    });

    test('trySymmetric accepts two points + a mirror line', () => {
        const { s, L } = lineSketch();
        const p1 = addEntity(s, makePoint(0, 5));
        const p2 = addEntity(s, makePoint(0, -5));
        const r = trySymmetric([p1.id, p2.id, L.id], s);
        assert.equal(r.ok, true);
    });
});

suite('try* helpers › negative cases', () => {
    test('tryHorizontal rejects multi-line selection', () => {
        const { s, L } = lineSketch();
        const c = addEntity(s, makePoint(0, 0));
        const d = addEntity(s, makePoint(0, 10));
        const L2 = addEntity(s, makeLine(c.id, d.id));
        const r = tryHorizontal([L.id, L2.id], s);
        assert.equal(r.ok, false);
        assert.match(r.reason, /one line/);
    });

    test('tryParallel rejects a single line', () => {
        const { s, L } = lineSketch();
        const r = tryParallel([L.id], s);
        assert.equal(r.ok, false);
    });

    test('tryTangent rejects two lines', () => {
        const { s, L } = lineSketch();
        const c = addEntity(s, makePoint(0, 0));
        const d = addEntity(s, makePoint(0, 10));
        const L2 = addEntity(s, makeLine(c.id, d.id));
        const r = tryTangent([L.id, L2.id], s);
        assert.equal(r.ok, false);
    });

    test('tryCoincident rejects mixed kinds', () => {
        const { s, L } = lineSketch();
        const p = addEntity(s, makePoint(5, 0));
        const r = tryCoincident([p.id, L.id], s);
        assert.equal(r.ok, false);
    });

    test('empty selection always fails', () => {
        const s = makeSketchData(stockPlane('XY'));
        for (const tool of CONSTRAINT_TOOLS) {
            const r = tool.try([], s);
            assert.equal(r.ok, false, `${tool.key} should reject empty`);
        }
    });

    test('partition treats Arc as circle for tangent/equal-radius', () => {
        const s = makeSketchData(stockPlane('XY'));
        // Two circles via two centres
        const c1 = addEntity(s, makePoint(0, 0));
        const C1 = addEntity(s, makeCircle(c1.id, 5));
        // An Arc — by kind, partitioned with circles
        const c2 = addEntity(s, makePoint(10, 0));
        const A = addEntity(s, { id: 'arc1', kind: 'arc', construction: false,
            params: { centerId: c2.id, radius: 3, startAngle: 0, sweepAngle: Math.PI } });
        const r = tryEqualRadius([C1.id, A.id], s);
        assert.equal(r.ok, true);
    });
});

// ── evaluateAll ─────────────────────────────────────────────────────────────
suite('evaluateAll', () => {
    test('returns one entry per tool', () => {
        const s = makeSketchData(stockPlane('XY'));
        const result = evaluateAll([], s);
        for (const tool of CONSTRAINT_TOOLS) {
            assert.ok(tool.key in result, `missing ${tool.key}`);
            assert.equal(result[tool.key].ok, false);
        }
    });

    test('reflects single-line selection (only H + V enabled)', () => {
        const { s, L } = lineSketch();
        const result = evaluateAll([L.id], s);
        assert.equal(result.horizontal.ok, true);
        assert.equal(result.vertical.ok, true);
        assert.equal(result.parallel.ok, false);
        assert.equal(result.tangent.ok,  false);
    });
});

// ── ConstraintPanel state machine (DOM-stubbed) ─────────────────────────────
// The Node test harness installs a minimal `document` stub in sketch_3d_drag_badges.mjs;
// here we stub if necessary and verify panel button state mirrors selection.

function stubNode() {
    return {
        children: [],
        style: {}, className: '', textContent: '', title: '',
        disabled: false,
        classList: {
            _set: new Set(),
            add(c)    { this._set.add(c); },
            remove(c) { this._set.delete(c); },
            toggle(c, on) { if (on) this._set.add(c); else this._set.delete(c); },
            contains(c) { return this._set.has(c); },
        },
        _listeners: {},
        addEventListener(type, fn) { (this._listeners[type] ??= []).push(fn); },
        appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
        removeChild(c) { this.children = this.children.filter(x => x !== c); c.parentNode = null; },
    };
}
// Replace any pre-existing stub from sibling test files — the panel uses
// `classList`, which a barebones createElement-only stub doesn't provide.
globalThis.document = { createElement() { return stubNode(); } };

suite('ConstraintPanel', () => {
    test('renders one button per CONSTRAINT_TOOLS entry', () => {
        const s = makeSketchData(stockPlane('XY'));
        const host = stubNode();
        const panel = new ConstraintPanel({
            host, sketchData: s,
            getSelection: () => [],
        });
        assert.equal(panel.el.children.length, CONSTRAINT_TOOLS.length);
    });

    test('all buttons disabled when selection is empty', () => {
        const s = makeSketchData(stockPlane('XY'));
        const host = stubNode();
        const panel = new ConstraintPanel({
            host, sketchData: s,
            getSelection: () => [],
        });
        for (const tool of CONSTRAINT_TOOLS) {
            assert.equal(panel._buttons.get(tool.key).disabled, true);
        }
    });

    test('refresh reflects selection — H/V enabled for one line', () => {
        const { s, L } = lineSketch();
        let sel = [];
        const host = stubNode();
        const panel = new ConstraintPanel({
            host, sketchData: s,
            getSelection: () => sel,
        });
        sel = [L.id];
        panel.refresh();
        assert.equal(panel._buttons.get('horizontal').disabled, false);
        assert.equal(panel._buttons.get('vertical').disabled,   false);
        assert.equal(panel._buttons.get('parallel').disabled,    true);
    });

    test('clicking an enabled button applies the constraint to the sketch', () => {
        const { s, L } = lineSketch();
        let sel = [L.id];
        const host = stubNode();
        const events = [];
        const panel = new ConstraintPanel({
            host, sketchData: s,
            getSelection: () => sel,
            toast: (msg, kind) => events.push({ msg, kind }),
            onApply: (c) => events.push({ applied: c }),
        });
        // Simulate a click on the horizontal button
        const btn = panel._buttons.get('horizontal');
        const handler = btn._listeners.click && btn._listeners.click[0];
        assert.ok(handler, 'horizontal button should have a click listener');
        handler({ stopPropagation() {} });
        assert.equal(constraintCount(s), 1);
        assert.ok(events.some(e => e.applied),         'onApply should fire');
        assert.ok(events.some(e => e.kind === 'success'), 'success toast should fire');
    });

    test('clicking a disabled button shows a reason toast and does not add', () => {
        const { s, L } = lineSketch();
        let sel = [L.id];   // only one line — parallel is disabled
        const host = stubNode();
        const events = [];
        const panel = new ConstraintPanel({
            host, sketchData: s,
            getSelection: () => sel,
            toast: (msg, kind) => events.push({ msg, kind }),
        });
        const btn = panel._buttons.get('parallel');
        const handler = btn._listeners.click && btn._listeners.click[0];
        handler({ stopPropagation() {} });
        assert.equal(constraintCount(s), 0);
        assert.ok(events.some(e => e.kind === 'error'));
    });
});

// ── Tangent snap detection ──────────────────────────────────────────────────
suite('snap › tangent detection', () => {
    test('cursor near a circle rim returns TANGENT when an anchor exists', () => {
        const s = makeSketchData(stockPlane('XY'));
        const c = addEntity(s, makePoint(0, 0));
        addEntity(s, makeCircle(c.id, 5));
        // Cursor 0.2mm outside the +X rim
        const r = snap({ x: 5.2, y: 0 }, s, { anchor: { x: 20, y: 0 }, snapRadius: 0.5 });
        assert.equal(r.kind, SNAP_KINDS.TANGENT);
        // Snap point lands on the rim
        assert.ok(near(r.point.x, 5, 1e-6));
        assert.ok(near(r.point.y, 0, 1e-6));
    });

    test('cursor far from the rim falls through to ortho or grid', () => {
        const s = makeSketchData(stockPlane('XY'));
        const c = addEntity(s, makePoint(0, 0));
        addEntity(s, makeCircle(c.id, 5));
        // Cursor 2mm outside the +X rim
        const r = snap({ x: 7, y: 0 }, s, { anchor: { x: 20, y: 0 }, snapRadius: 0.5 });
        assert.notEqual(r.kind, SNAP_KINDS.TANGENT);
    });

    test('TANGENT does not fire without an anchor', () => {
        const s = makeSketchData(stockPlane('XY'));
        const c = addEntity(s, makePoint(0, 0));
        addEntity(s, makeCircle(c.id, 5));
        const r = snap({ x: 5.1, y: 0 }, s, { snapRadius: 0.5 });
        assert.notEqual(r.kind, SNAP_KINDS.TANGENT);
    });

    test('inferConstraints maps TANGENT to a tangent record', () => {
        const out = inferConstraints(SNAP_KINDS.TANGENT, { circleId: 'C1' });
        assert.equal(out[0].kind, 'tangent');
        assert.deepEqual(out[0].args, ['C1']);
    });
});

// ── Tangent applied automatically by the line tool ──────────────────────────
suite('lineTool3D › tangent auto-constraint', () => {
    function stubEd() {
        const sketch = makeSketchData(stockPlane('XY'));
        const renderer = {
            getSelection() { return []; }, setSelection() {},
            setHover() {}, setSnap() {}, setPreview() {},
            previewLine() { return {}; },
        };
        return {
            sketchData: sketch, polygonSides: 6,
            commitDirty() {}, setDimReadout() {},
            renderer, _screenToWorldDist(px) { return px / 12; },
        };
    }
    function ctx(local, snap) {
        return { local, world: [0, 0, 0], snap, event: { button: 0 }, sketch: null, renderer: null };
    }

    test('line ending on a TANGENT snap commits a tangent constraint', () => {
        const ed = stubEd();
        // Add a circle at origin so the tangent snap has something to bind to
        const c = addEntity(ed.sketchData, makePoint(0, 0));
        const C = addEntity(ed.sketchData, makeCircle(c.id, 5));
        const tool = lineTool3D(); tool._editor = ed; tool.activate();
        // First click somewhere on +X axis
        const c1 = ctx({ x: 20, y: 0 }, { kind: SNAP_KINDS.GRID, point: { x: 20, y: 0 } });
        c1.sketch = ed.sketchData; c1.renderer = ed.renderer;
        tool.onPointerDown(c1);
        // Second click — tangent snap onto the circle rim
        const c2 = ctx({ x: 5, y: 0 }, {
            kind: SNAP_KINDS.TANGENT, point: { x: 5, y: 0 },
            extra: { circleId: C.id, kind: 'tangent' },
        });
        c2.sketch = ed.sketchData; c2.renderer = ed.renderer;
        tool.onPointerDown(c2);
        const tan = Object.values(ed.sketchData.constraints).filter(k => k.kind === CONSTRAINT_KIND.TANGENT);
        assert.equal(tan.length, 1);
    });
});

runAll();
