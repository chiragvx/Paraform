/**
 * Tests for the slot helpers (lib/sketch/sketch_shapes.js:slotLinearPath +
 * the hit-tester's slot-outline distance) and the matching slotTool3D.
 *
 * Run via:  node app/__tests__/sketch_3d_slot.mjs
 */

import assert from 'node:assert/strict';
import { slotLinearPath } from '../../lib/sketch/sketch_shapes.js';
import { slotTool3D } from '../sketch_3d/tools_3d.js';
import { pickEntity } from '../sketch_3d/hit_test_entities.js';
import { SNAP_KINDS } from '../sketch_3d/snap_3d.js';
import {
    makeSketchData, stockPlane, addEntity,
} from '../../lib/sketch/sketch_data.js';
import {
    ENTITY_KIND, makePoint, makeSlotLinear,
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
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

// ── slotLinearPath ──────────────────────────────────────────────────────────
suite('slotLinearPath', () => {
    test('horizontal slot of length 10 width 4 has the expected bounding extents', () => {
        const pts = slotLinearPath({ x: 0, y: 0 }, { x: 10, y: 0 }, 2);
        let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
        for (const p of pts) {
            xMin = Math.min(xMin, p.x); xMax = Math.max(xMax, p.x);
            yMin = Math.min(yMin, p.y); yMax = Math.max(yMax, p.y);
        }
        // Caps extend the +X / -X bounds by `r`; sides bound +Y / -Y at ±r.
        assert.ok(near(xMin, -2, 1e-6));
        assert.ok(near(xMax, 12, 1e-6));
        assert.ok(near(yMin, -2, 1e-6));
        assert.ok(near(yMax,  2, 1e-6));
    });

    test('degenerate slot (A == B) renders a single circle of radius r', () => {
        const pts = slotLinearPath({ x: 0, y: 0 }, { x: 0, y: 0 }, 1.5);
        // Every point should be exactly `r` from the centre.
        for (const p of pts) {
            assert.ok(near(Math.hypot(p.x, p.y), 1.5, 1e-6));
        }
    });

    test('vertical slot (rotated 90°) has correct extents after axis swap', () => {
        const pts = slotLinearPath({ x: 0, y: 0 }, { x: 0, y: 10 }, 2);
        let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
        for (const p of pts) {
            xMin = Math.min(xMin, p.x); xMax = Math.max(xMax, p.x);
            yMin = Math.min(yMin, p.y); yMax = Math.max(yMax, p.y);
        }
        assert.ok(near(xMin, -2, 1e-6));
        assert.ok(near(xMax,  2, 1e-6));
        assert.ok(near(yMin, -2, 1e-6));
        assert.ok(near(yMax, 12, 1e-6));
    });

    test('every cap point lies on its centre circle', () => {
        const A = { x: 1, y: 2 }, B = { x: 9, y: 2 }, r = 3;
        const pts = slotLinearPath(A, B, r, 8);
        // Path layout: idx 0 = top-start (A+rN), 1 = top-end (B+rN),
        // 2..2+segments = cap at B, then bottom-start (B-rN), then cap at A.
        // Cap-at-B points (idx 2..9) must satisfy |p - B| == r.
        for (let i = 2; i <= 9; i++) {
            const d = Math.hypot(pts[i].x - B.x, pts[i].y - B.y);
            assert.ok(near(d, r, 1e-6));
        }
    });

    test('every straight-side point is exactly r away from the centreline', () => {
        const A = { x: 0, y: 0 }, B = { x: 10, y: 0 }, r = 1.5;
        const pts = slotLinearPath(A, B, r);
        // idx 0 + 1 are the top side (y = +r). The bottom-side point lives at
        // position `2 + segments` (after the cap at B).
        assert.ok(near(pts[0].y,  r, 1e-6));
        assert.ok(near(pts[1].y,  r, 1e-6));
        // After 16 cap segments at B, we land on the bottom side.
        assert.ok(near(pts[18].y, -r, 1e-6));
    });
});

// ── hit-test (proper slot outline) ──────────────────────────────────────────
suite('SLOT_LINEAR hit-test', () => {
    function slotSketch() {
        const s = makeSketchData(stockPlane('XY'));
        const a = addEntity(s, makePoint(0,  0));
        const b = addEntity(s, makePoint(10, 0));
        const Sl = addEntity(s, makeSlotLinear(a.id, b.id, 2));
        return { s, Sl };
    }

    test('cursor on the top side is picked (within tolerance)', () => {
        const { s, Sl } = slotSketch();
        const hit = pickEntity({ x: 5, y: 2 }, s, { tolerance: 0.5 });
        assert.ok(hit);
        assert.equal(hit.id, Sl.id);
    });

    test('cursor on the forward cap is picked', () => {
        const { s, Sl } = slotSketch();
        // (12, 0) is on the +X cap (B + r * u)
        const hit = pickEntity({ x: 12, y: 0 }, s, { tolerance: 0.5 });
        assert.ok(hit);
        assert.equal(hit.id, Sl.id);
    });

    test('cursor at the centre is NOT picked (interior is not the stroke)', () => {
        const { s } = slotSketch();
        // (5, 0) is dead centre of the slot — strokes are 2 mm away. Tol 0.5.
        const hit = pickEntity({ x: 5, y: 0 }, s, { tolerance: 0.5 });
        assert.equal(hit, null);
    });

    test('cursor well outside the slot is not picked', () => {
        const { s } = slotSketch();
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
        previewLine(a, b) { return { kind: 'preview-line', a, b }; },
        previewCircle(c, r) { return { kind: 'preview-circle', c, r }; },
        previewRect() { return {}; }, previewPolygon() { return {}; },
        previewSlotLinear(a, b, r) { return { kind: 'preview-slot', a, b, r }; },
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
function ev() { return { button: 0, shiftKey: false }; }
function ctx(ed, local, snap = null) {
    return {
        local, world: [0, 0, 0],
        snap: snap || { kind: SNAP_KINDS.GRID, point: local },
        event: ev(),
        sketch: ed.sketchData, renderer: ed.renderer,
    };
}

// ── slotTool3D ──────────────────────────────────────────────────────────────
suite('slotTool3D', () => {
    test('three clicks commit a SlotLinear at the cursor-perpendicular width', () => {
        const ed = stubEd();
        const tool = slotTool3D(); tool._editor = ed; tool.activate();

        // Click 1 — first centre
        tool.onPointerDown(ctx(ed, { x: 0, y: 0 }));
        // Click 2 — second centre
        tool.onPointerDown(ctx(ed, { x: 10, y: 0 }));
        // Move → preview should be a slot at perpendicular distance from cursor
        tool.onPointerMove(ctx(ed, { x: 5, y: 2 }));
        assert.equal(ed._state.preview.kind, 'preview-slot');
        assert.ok(near(ed._state.preview.r, 2, 1e-6));
        // Click 3 — commit width
        tool.onPointerDown(ctx(ed, { x: 5, y: 2 }));

        const slots = Object.values(ed.sketchData.entities).filter(e => e.kind === ENTITY_KIND.SLOT_LINEAR);
        assert.equal(slots.length, 1);
        assert.ok(near(slots[0].params.radius, 2, 1e-6));
        assert.equal(ed._state.dirty, 1);
    });

    test('after step 1, preview is a centreline (not a slot yet)', () => {
        const ed = stubEd();
        const tool = slotTool3D(); tool._editor = ed; tool.activate();
        tool.onPointerDown(ctx(ed, { x: 0, y: 0 }));
        tool.onPointerMove(ctx(ed, { x: 5, y: 0 }));
        assert.equal(ed._state.preview.kind, 'preview-line');
    });

    test('width too small fails the commit with an error toast', () => {
        const ed = stubEd();
        const tool = slotTool3D(); tool._editor = ed; tool.activate();
        tool.onPointerDown(ctx(ed, { x: 0, y: 0 }));
        tool.onPointerDown(ctx(ed, { x: 10, y: 0 }));
        // Click ON the centreline → zero perpendicular distance
        tool.onPointerDown(ctx(ed, { x: 5, y: 0 }));
        const slots = Object.values(ed.sketchData.entities).filter(e => e.kind === ENTITY_KIND.SLOT_LINEAR);
        assert.equal(slots.length, 0);
        assert.equal(ed._state.lastToast.kind, 'error');
        assert.equal(ed._state.dirty, 0);
    });

    test('Escape mid-flow clears state cleanly', () => {
        const ed = stubEd();
        const tool = slotTool3D(); tool._editor = ed; tool.activate();
        tool.onPointerDown(ctx(ed, { x: 0, y: 0 }));
        tool.onPointerDown(ctx(ed, { x: 10, y: 0 }));
        const handled = tool.onKeyDown({ key: 'Escape' });
        assert.equal(handled, true);
        assert.equal(ed._state.preview, null);
        // Subsequent click acts as a fresh start (creates point #1)
        tool.onPointerDown(ctx(ed, { x: 1, y: 1 }));
        // No slot yet — we're back in step 1
        const slots = Object.values(ed.sketchData.entities).filter(e => e.kind === ENTITY_KIND.SLOT_LINEAR);
        assert.equal(slots.length, 0);
    });
});

await runAll();
