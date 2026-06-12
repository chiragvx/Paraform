/**
 * Tests for the spline helpers (lib/sketch/sketch_shapes.js:splinePath) and
 * the matching tool (splineTool3D).
 *
 * Run via:  node app/__tests__/sketch_3d_spline.mjs
 */

import assert from 'node:assert/strict';
import { splinePath } from '../../lib/sketch/sketch_shapes.js';
import { splineTool3D } from '../sketch_3d/tools_3d.js';
import { pickEntity } from '../sketch_3d/hit_test_entities.js';
import { SNAP_KINDS } from '../sketch_3d/snap_3d.js';
import {
    makeSketchData, stockPlane, addEntity,
} from '../../lib/sketch/sketch_data.js';
import {
    ENTITY_KIND, makePoint, makeSpline,
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

// ── splinePath ──────────────────────────────────────────────────────────────
suite('splinePath', () => {
    test('< 2 control points returns an empty polyline', () => {
        assert.deepEqual(splinePath([]), []);
        assert.deepEqual(splinePath([{ x: 0, y: 0 }]), []);
    });

    test('2 control points returns a straight line', () => {
        const pts = splinePath([{ x: 0, y: 0 }, { x: 10, y: 0 }]);
        assert.equal(pts.length, 2);
        assert.deepEqual(pts[0], { x: 0, y: 0 });
        assert.deepEqual(pts[1], { x: 10, y: 0 });
    });

    test('the spline interpolates every control point (open)', () => {
        const ctrl = [
            { x: 0,  y: 0 },
            { x: 5,  y: 3 },
            { x: 10, y: 0 },
            { x: 15, y: 2 },
        ];
        const pts = splinePath(ctrl, { segments: 16 });
        // First and last sample should equal first and last control point.
        assert.ok(near(pts[0].x, 0));   assert.ok(near(pts[0].y, 0));
        assert.ok(near(pts[pts.length - 1].x, 15)); assert.ok(near(pts[pts.length - 1].y, 2));
        // The interior control points should appear somewhere in `pts`.
        // For uniform Catmull-Rom with segments=16, every section's last
        // sample equals the next control point.
        // After section 0 (j = 0..16), pts[16] should ≈ ctrl[1].
        assert.ok(near(pts[16].x, 5));  assert.ok(near(pts[16].y, 3));
        assert.ok(near(pts[32].x, 10)); assert.ok(near(pts[32].y, 0));
    });

    test('a straight line of 4 collinear control points stays straight', () => {
        const ctrl = [
            { x: 0,  y: 0 },
            { x: 3,  y: 0 },
            { x: 6,  y: 0 },
            { x: 10, y: 0 },
        ];
        const pts = splinePath(ctrl, { segments: 8 });
        // Every interpolated y should be very close to 0.
        for (const p of pts) {
            assert.ok(near(p.y, 0, 1e-6));
        }
    });

    test('a closed loop wraps so the curve returns to the first point', () => {
        const ctrl = [
            { x:  1, y:  0 },
            { x:  0, y:  1 },
            { x: -1, y:  0 },
            { x:  0, y: -1 },
        ];
        const pts = splinePath(ctrl, { segments: 16, closed: true });
        // Number of *unique* samples == segments * n  (first sample of next
        // section is omitted to avoid duplicates).
        // splinePath returns segments + 1 for first section, then segments per
        // following section. So:  (segments + 1) + (n - 1) * segments
        const n = ctrl.length;
        const expected = (16 + 1) + (n - 1) * 16;
        assert.equal(pts.length, expected);
        // First sample = first control point
        assert.ok(near(pts[0].x, 1)); assert.ok(near(pts[0].y, 0));
        // For closed curves the last section should bring us back near the
        // first control point (within Catmull-Rom's interpolation tolerance).
        assert.ok(near(pts[pts.length - 1].x, ctrl[0].x, 1e-3));
        assert.ok(near(pts[pts.length - 1].y, ctrl[0].y, 1e-3));
    });

    test('output count for an open spline through N points has the expected length', () => {
        const ctrl = [
            { x: 0, y: 0 },
            { x: 1, y: 1 },
            { x: 2, y: 0 },
            { x: 3, y: 1 },
            { x: 4, y: 0 },
        ];
        const pts = splinePath(ctrl, { segments: 8 });
        const sections = ctrl.length - 1;
        // First section contributes segments + 1; each later section contributes segments.
        assert.equal(pts.length, (8 + 1) + (sections - 1) * 8);
    });
});

// ── hit-test (proper spline outline) ────────────────────────────────────────
suite('SPLINE hit-test', () => {
    function splineSketch() {
        const s = makeSketchData(stockPlane('XY'));
        const a = addEntity(s, makePoint(0,  0));
        const b = addEntity(s, makePoint(5,  3));
        const c = addEntity(s, makePoint(10, 0));
        const d = addEntity(s, makePoint(15, 2));
        const Sp = addEntity(s, makeSpline([a.id, b.id, c.id, d.id]));
        return { s, Sp };
    }

    test('cursor on an interpolated control point is picked', () => {
        const { s, Sp } = splineSketch();
        // (5, 3) is an interior control point — the curve interpolates it.
        const hit = pickEntity({ x: 5, y: 3 }, s, { tolerance: 0.5 });
        assert.ok(hit);
        // Whichever is closer (the Point or the Spline through it). The
        // Point sits exactly at distance 0; the spline is also 0. Tie is
        // resolved by encounter order in `entityOrder` — let's verify that
        // *some* entity at that exact location was picked.
        assert.ok(hit.id === Sp.id || s.entities[hit.id]?.kind === ENTITY_KIND.POINT);
    });

    test('cursor near the spline mid-section is picked as the spline', () => {
        const { s, Sp } = splineSketch();
        // Pick a point that lies between control points and is therefore
        // never a Point entity — only the spline can match.
        const hit = pickEntity({ x: 2.5, y: 1.6 }, s, { tolerance: 0.6 });
        assert.ok(hit);
        assert.equal(hit.id, Sp.id);
    });

    test('cursor far from the spline is not picked', () => {
        const { s } = splineSketch();
        const hit = pickEntity({ x: 50, y: 50 }, s, { tolerance: 0.5 });
        assert.equal(hit, null);
    });
});

// ── Tool stub ───────────────────────────────────────────────────────────────
function stubEd() {
    const sketch = makeSketchData(stockPlane('XY'));
    const state = { dirty: 0, lastToast: null, preview: null, dim: null };
    const renderer = {
        getSelection() { return []; },
        setSelection() {}, setHover() {}, setSnap() {},
        setPreview(o) { state.preview = o; },
        previewLine() { return {}; }, previewCircle() { return {}; },
        previewRect() { return {}; }, previewPolygon() { return {}; },
        previewSlotLinear() { return {}; },
        previewSpline(ctrl, closed) { return { kind: 'preview-spline', ctrl, closed: !!closed }; },
        render() {},
    };
    return {
        sketchData: sketch,
        commitDirty() { state.dirty++; },
        setDimReadout(info) { state.dim = info; },
        toast(msg, kind) { state.lastToast = { msg, kind }; },
        renderer,
        _screenToWorldDist(px) { return px / 12; },
        _state: state,
    };
}
function ev(timeStamp = 0) { return { button: 0, shiftKey: false, timeStamp }; }
function ctx(ed, local, snap = null, timeStamp = 0) {
    return {
        local, world: [0, 0, 0],
        snap: snap || { kind: SNAP_KINDS.GRID, point: local },
        event: ev(timeStamp),
        sketch: ed.sketchData, renderer: ed.renderer,
    };
}

// ── splineTool3D ────────────────────────────────────────────────────────────
suite('splineTool3D', () => {
    test('clicks drop control Points; Enter commits a Spline entity', () => {
        const ed = stubEd();
        const tool = splineTool3D(); tool._editor = ed; tool.activate();

        tool.onPointerDown(ctx(ed, { x: 0,  y: 0 }, null, 100));
        tool.onPointerDown(ctx(ed, { x: 5,  y: 3 }, null, 200));
        tool.onPointerDown(ctx(ed, { x: 10, y: 0 }, null, 300));
        tool.onPointerDown(ctx(ed, { x: 15, y: 2 }, null, 400));
        // 4 Points dropped, no spline yet
        const ptsBefore = Object.values(ed.sketchData.entities).filter(e => e.kind === ENTITY_KIND.POINT);
        assert.equal(ptsBefore.length, 4);
        const splinesBefore = Object.values(ed.sketchData.entities).filter(e => e.kind === ENTITY_KIND.SPLINE);
        assert.equal(splinesBefore.length, 0);

        // Press Enter → commits the spline
        const handled = tool.onKeyDown({ key: 'Enter' });
        assert.equal(handled, true);

        const splines = Object.values(ed.sketchData.entities).filter(e => e.kind === ENTITY_KIND.SPLINE);
        assert.equal(splines.length, 1);
        assert.equal(splines[0].params.controlPointIds.length, 4);
        assert.equal(ed._state.dirty, 1);
    });

    test('Enter with < 2 control points emits an error toast', () => {
        const ed = stubEd();
        const tool = splineTool3D(); tool._editor = ed; tool.activate();
        tool.onPointerDown(ctx(ed, { x: 0, y: 0 }));
        const handled = tool.onKeyDown({ key: 'Enter' });
        assert.equal(handled, true);
        const splines = Object.values(ed.sketchData.entities).filter(e => e.kind === ENTITY_KIND.SPLINE);
        assert.equal(splines.length, 0);
        assert.equal(ed._state.lastToast.kind, 'error');
    });

    test('Escape rolls back the dropped control points', () => {
        const ed = stubEd();
        const tool = splineTool3D(); tool._editor = ed; tool.activate();
        tool.onPointerDown(ctx(ed, { x: 0, y: 0 }));
        tool.onPointerDown(ctx(ed, { x: 5, y: 3 }));
        tool.onPointerDown(ctx(ed, { x: 10, y: 0 }));
        const ptsMid = Object.values(ed.sketchData.entities).filter(e => e.kind === ENTITY_KIND.POINT);
        assert.equal(ptsMid.length, 3);
        tool.onKeyDown({ key: 'Escape' });
        const ptsAfter = Object.values(ed.sketchData.entities).filter(e => e.kind === ENTITY_KIND.POINT);
        assert.equal(ptsAfter.length, 0);
        // Pressing Enter now should not commit anything
        tool.onKeyDown({ key: 'Enter' });
        const splines = Object.values(ed.sketchData.entities).filter(e => e.kind === ENTITY_KIND.SPLINE);
        assert.equal(splines.length, 0);
    });

    test('double-click on the same position commits the spline (>= 2 points)', () => {
        const ed = stubEd();
        const tool = splineTool3D(); tool._editor = ed; tool.activate();
        tool.onPointerDown(ctx(ed, { x: 0, y: 0 }, null, 100));
        tool.onPointerDown(ctx(ed, { x: 5, y: 3 }, null, 1000));   // far in time + space — adds p2
        // Repeat click at the same position within 300 ms → commit gesture
        tool.onPointerDown(ctx(ed, { x: 5, y: 3 }, null, 1200));
        const splines = Object.values(ed.sketchData.entities).filter(e => e.kind === ENTITY_KIND.SPLINE);
        assert.equal(splines.length, 1);
        // The committed spline has exactly 2 control points (the repeat click was consumed)
        assert.equal(splines[0].params.controlPointIds.length, 2);
    });

    test('rapid clicks at distinct positions stay as separate control points', () => {
        const ed = stubEd();
        const tool = splineTool3D(); tool._editor = ed; tool.activate();
        // 100 ms apart but every click is at a distinct position → never double-click
        tool.onPointerDown(ctx(ed, { x: 0,  y: 0 }, null, 100));
        tool.onPointerDown(ctx(ed, { x: 5,  y: 3 }, null, 200));
        tool.onPointerDown(ctx(ed, { x: 10, y: 0 }, null, 300));
        tool.onPointerDown(ctx(ed, { x: 15, y: 2 }, null, 400));
        // All four clicks should land as separate Points; no premature commit
        const pts = Object.values(ed.sketchData.entities).filter(e => e.kind === ENTITY_KIND.POINT);
        assert.equal(pts.length, 4);
        const splines = Object.values(ed.sketchData.entities).filter(e => e.kind === ENTITY_KIND.SPLINE);
        assert.equal(splines.length, 0);
    });

    test('preview updates as the cursor moves', () => {
        const ed = stubEd();
        const tool = splineTool3D(); tool._editor = ed; tool.activate();
        tool.onPointerDown(ctx(ed, { x: 0, y: 0 }));
        tool.onPointerDown(ctx(ed, { x: 5, y: 3 }));
        tool.onPointerMove(ctx(ed, { x: 10, y: 0 }));
        // Preview should be a spline through 3 (2 committed + cursor) points
        assert.equal(ed._state.preview.kind, 'preview-spline');
        assert.equal(ed._state.preview.ctrl.length, 3);
    });
});

await runAll();
