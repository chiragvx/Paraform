/**
 * Tests for the extend helper (lib/sketch/sketch_edits.js:extendEntity) and
 * the matching tool (extendTool3D).
 *
 * Run via:  node app/__tests__/sketch_3d_extend.mjs
 */

import assert from 'node:assert/strict';
import { extendEntity } from '../../lib/sketch/sketch_edits.js';
import { extendTool3D } from '../sketch_3d/tools_3d.js';
import { SNAP_KINDS } from '../sketch_3d/snap_3d.js';
import {
    makeSketchData, stockPlane, addEntity,
} from '../../lib/sketch/sketch_data.js';
import {
    ENTITY_KIND, makePoint, makeLine, makeCircle, makeArc,
} from '../../lib/sketch/entities.js';

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

// ── extendEntity › Line ─────────────────────────────────────────────────────
suite('extendEntity › line', () => {
    test('extends a line endpoint to a perpendicular crossing line', () => {
        // L1: horizontal (0,0)→(5,0)
        // L2: vertical at x=10 from (10,-3)→(10,3)
        // Clicking near the right end of L1 should extend it to (10, 0).
        const s = makeSketchData(stockPlane('XY'));
        const a = addEntity(s, makePoint(0, 0));
        const b = addEntity(s, makePoint(5, 0));
        const L1 = addEntity(s, makeLine(a.id, b.id));
        const c = addEntity(s, makePoint(10, -3));
        const d = addEntity(s, makePoint(10,  3));
        addEntity(s, makeLine(c.id, d.id));
        const ok = extendEntity(s, L1.id, { x: 5, y: 0 });
        assert.equal(ok, true);
        assert.ok(near(s.entities[b.id].params.x, 10));
        assert.ok(near(s.entities[b.id].params.y,  0));
    });

    test('extends the LEFT endpoint when the click is near the start', () => {
        // L1: (4, 0)→(10, 0)
        // L2: vertical at x = -2 from (-2,-3)→(-2,3) (well left)
        // Click near (4, 0) → extend the start endpoint LEFT to (-2, 0)
        const s = makeSketchData(stockPlane('XY'));
        const a = addEntity(s, makePoint(4, 0));
        const b = addEntity(s, makePoint(10, 0));
        const L1 = addEntity(s, makeLine(a.id, b.id));
        const c = addEntity(s, makePoint(-2, -3));
        const d = addEntity(s, makePoint(-2,  3));
        addEntity(s, makeLine(c.id, d.id));
        const ok = extendEntity(s, L1.id, { x: 4, y: 0 });
        assert.equal(ok, true);
        // Start endpoint moved to (-2, 0)
        assert.ok(near(s.entities[a.id].params.x, -2));
        assert.ok(near(s.entities[a.id].params.y,  0));
        // End endpoint is unchanged
        assert.ok(near(s.entities[b.id].params.x, 10));
        assert.ok(near(s.entities[b.id].params.y,  0));
    });

    test('extends to the NEAREST candidate when several are valid', () => {
        // L1: (0,0)→(2,0).  Two vertical lines at x=4 and x=10 cross the
        // forward extension. Extending the right end should stop at x=4.
        const s = makeSketchData(stockPlane('XY'));
        const a = addEntity(s, makePoint(0, 0));
        const b = addEntity(s, makePoint(2, 0));
        const L1 = addEntity(s, makeLine(a.id, b.id));
        const c1 = addEntity(s, makePoint(4, -3));
        const d1 = addEntity(s, makePoint(4,  3));
        addEntity(s, makeLine(c1.id, d1.id));
        const c2 = addEntity(s, makePoint(10, -3));
        const d2 = addEntity(s, makePoint(10,  3));
        addEntity(s, makeLine(c2.id, d2.id));
        extendEntity(s, L1.id, { x: 2, y: 0 });
        assert.ok(near(s.entities[b.id].params.x, 4));   // not 10
    });

    test('extends to a Circle (line-circle intersection)', () => {
        // L1: (0,0)→(2,0).  Circle at (10, 0) radius 3 → near edge at x=7.
        const s = makeSketchData(stockPlane('XY'));
        const a = addEntity(s, makePoint(0, 0));
        const b = addEntity(s, makePoint(2, 0));
        const L1 = addEntity(s, makeLine(a.id, b.id));
        const cc = addEntity(s, makePoint(10, 0));
        addEntity(s, makeCircle(cc.id, 3));
        const ok = extendEntity(s, L1.id, { x: 2, y: 0 });
        assert.equal(ok, true);
        assert.ok(near(s.entities[b.id].params.x, 7));
        assert.ok(near(s.entities[b.id].params.y, 0));
    });

    test('returns false when there is nothing to extend to', () => {
        const s = makeSketchData(stockPlane('XY'));
        const a = addEntity(s, makePoint(0, 0));
        const b = addEntity(s, makePoint(5, 0));
        const L1 = addEntity(s, makeLine(a.id, b.id));
        // No other entity in the sketch — nothing to hit
        const ok = extendEntity(s, L1.id, { x: 5, y: 0 });
        assert.equal(ok, false);
    });

    test('returns false for a degenerate (zero-length) line', () => {
        const s = makeSketchData(stockPlane('XY'));
        const a = addEntity(s, makePoint(5, 5));
        const b = addEntity(s, makePoint(5, 5));
        const L1 = addEntity(s, makeLine(a.id, b.id));
        const c = addEntity(s, makePoint(10, -3));
        const d = addEntity(s, makePoint(10,  3));
        addEntity(s, makeLine(c.id, d.id));
        assert.equal(extendEntity(s, L1.id, { x: 5, y: 5 }), false);
    });
});

// ── extendEntity › Arc ──────────────────────────────────────────────────────
suite('extendEntity › arc', () => {
    test('grows the sweep of a CCW arc until it hits a crossing line', () => {
        // Arc centred at origin, radius 5, starting at angle 0, sweeping 30°.
        // End is at angle 30° → point (5·cos30, 5·sin30) ≈ (4.33, 2.5).
        // A vertical line at x=0 from y=-10..10 crosses the +Y axis at 90°.
        // Extending the end should grow the sweep to 90°.
        const s = makeSketchData(stockPlane('XY'));
        const c = addEntity(s, makePoint(0, 0));
        const A = addEntity(s, makeArc(c.id, 5, 0, Math.PI / 6));
        const la = addEntity(s, makePoint(0, -10));
        const lb = addEntity(s, makePoint(0,  10));
        addEntity(s, makeLine(la.id, lb.id));
        const clickPoint = { x: 5 * Math.cos(Math.PI / 6), y: 5 * Math.sin(Math.PI / 6) };
        const ok = extendEntity(s, A.id, clickPoint);
        assert.equal(ok, true);
        // New sweep should be π/2 (the line crosses the circle's +Y axis at 90°)
        assert.ok(near(s.entities[A.id].params.sweepAngle, Math.PI / 2));
        assert.ok(near(s.entities[A.id].params.startAngle, 0));
    });

    test('extending the START endpoint moves startAngle, not sweep alone', () => {
        // Same setup but click the START (angle 0 → point (5, 0)).
        // Vertical line at x=0 from y=-10..10. Extending the start CCW means
        // going backward (CW) from 0, which on the unit circle hits at angle -π/2
        // (the line crosses the circle's -Y axis).
        const s = makeSketchData(stockPlane('XY'));
        const c = addEntity(s, makePoint(0, 0));
        const A = addEntity(s, makeArc(c.id, 5, 0, Math.PI / 6));
        const la = addEntity(s, makePoint(0, -10));
        const lb = addEntity(s, makePoint(0,  10));
        addEntity(s, makeLine(la.id, lb.id));
        const ok = extendEntity(s, A.id, { x: 5, y: 0 });
        assert.equal(ok, true);
        // New start at -π/2; old end was at π/6; new sweep = π/6 - (-π/2) = 2π/3
        assert.ok(near(s.entities[A.id].params.startAngle, -Math.PI / 2));
        assert.ok(near(s.entities[A.id].params.sweepAngle,  2 * Math.PI / 3));
    });

    test('a full circle (sweep ≈ 2π) cannot be extended', () => {
        const s = makeSketchData(stockPlane('XY'));
        const c = addEntity(s, makePoint(0, 0));
        const A = addEntity(s, makeArc(c.id, 5, 0, 2 * Math.PI - 1e-9));
        const la = addEntity(s, makePoint(0, -10));
        const lb = addEntity(s, makePoint(0,  10));
        addEntity(s, makeLine(la.id, lb.id));
        assert.equal(extendEntity(s, A.id, { x: 5, y: 0 }), false);
    });
});

// ── extendEntity › kind ─────────────────────────────────────────────────────
suite('extendEntity › kind', () => {
    test('returns null for an unsupported kind', () => {
        const s = makeSketchData(stockPlane('XY'));
        const c = addEntity(s, makePoint(0, 0));
        const C = addEntity(s, makeCircle(c.id, 5));   // Circle isn't extendable
        assert.equal(extendEntity(s, C.id, { x: 5, y: 0 }), null);
    });

    test('returns null for a missing entity', () => {
        const s = makeSketchData(stockPlane('XY'));
        assert.equal(extendEntity(s, 'nope', { x: 0, y: 0 }), null);
    });
});

// ── Tool stub ───────────────────────────────────────────────────────────────
function stubEd() {
    const sketch = makeSketchData(stockPlane('XY'));
    const state = { dirty: 0, lastToast: null, hover: null };
    const renderer = {
        getSelection() { return []; },
        setSelection() {}, setHover(id) { state.hover = id; }, setSnap() {},
        setPreview() {}, previewLine() { return {}; },
        previewCircle() { return {}; }, previewRect() { return {}; },
        previewPolygon() { return {}; }, render() {},
    };
    return {
        sketchData: sketch,
        commitDirty() { state.dirty++; },
        setDimReadout() {},
        toast(msg, kind) { state.lastToast = { msg, kind }; },
        renderer,
        _screenToWorldDist(px) { return px / 12; },
        _state: state,
    };
}
function ev() { return { button: 0, shiftKey: false }; }
function ctx(ed, local, snap = null) {
    return {
        local, world: [0, 0, 0],
        snap: snap || { kind: SNAP_KINDS.GRID, point: local },
        event: ev(),
        sketch: ed.sketchData, renderer: ed.renderer,
    };
}

// ── extendTool3D ────────────────────────────────────────────────────────────
suite('extendTool3D', () => {
    test('clicking near a line endpoint extends to the next entity + marks dirty', () => {
        const ed = stubEd();
        const a = addEntity(ed.sketchData, makePoint(0, 0));
        const b = addEntity(ed.sketchData, makePoint(5, 0));
        addEntity(ed.sketchData, makeLine(a.id, b.id));
        const c = addEntity(ed.sketchData, makePoint(10, -3));
        const d = addEntity(ed.sketchData, makePoint(10,  3));
        addEntity(ed.sketchData, makeLine(c.id, d.id));

        const tool = extendTool3D(); tool._editor = ed; tool.activate();
        tool.onPointerDown(ctx(ed, { x: 5, y: 0 }));
        assert.equal(ed._state.dirty, 1);
        assert.ok(near(ed.sketchData.entities[b.id].params.x, 10));
    });

    test('clicking far from any entity emits an error toast', () => {
        const ed = stubEd();
        const a = addEntity(ed.sketchData, makePoint(0, 0));
        const b = addEntity(ed.sketchData, makePoint(5, 0));
        addEntity(ed.sketchData, makeLine(a.id, b.id));
        const tool = extendTool3D(); tool._editor = ed; tool.activate();
        tool.onPointerDown(ctx(ed, { x: 50, y: 50 }));
        assert.equal(ed._state.lastToast.kind, 'error');
        assert.equal(ed._state.dirty, 0);
    });

    test('clicking a line with no candidate extensions emits an info toast', () => {
        const ed = stubEd();
        const a = addEntity(ed.sketchData, makePoint(0, 0));
        const b = addEntity(ed.sketchData, makePoint(5, 0));
        addEntity(ed.sketchData, makeLine(a.id, b.id));
        const tool = extendTool3D(); tool._editor = ed; tool.activate();
        tool.onPointerDown(ctx(ed, { x: 5, y: 0 }));
        assert.equal(ed._state.lastToast.kind, 'info');
        assert.equal(ed._state.dirty, 0);
    });

    test('hover only highlights extendable kinds (Line / Arc)', () => {
        const ed = stubEd();
        const c = addEntity(ed.sketchData, makePoint(0, 0));
        const C = addEntity(ed.sketchData, makeCircle(c.id, 5));
        const tool = extendTool3D(); tool._editor = ed; tool.activate();
        // Cursor on the circle's rim — but Circle isn't extendable, so no hover
        tool.onPointerMove(ctx(ed, { x: 5, y: 0 }));
        assert.equal(ed._state.hover, null);
    });
});

await runAll();
