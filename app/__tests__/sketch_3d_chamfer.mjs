/**
 * Tests for the chamfer helpers (lib/sketch/sketch_edits.js:chamferTwoLines)
 * and the matching 3D tool (chamferTool3D).
 *
 * Run via:  node app/__tests__/sketch_3d_chamfer.mjs
 */

import assert from 'node:assert/strict';
import { chamferTwoLines } from '../../lib/sketch/sketch_edits.js';
import { chamferTool3D } from '../sketch_3d/tools_3d.js';
import { SNAP_KINDS } from '../sketch_3d/snap_3d.js';
import {
    makeSketchData, stockPlane, addEntity,
} from '../../lib/sketch/sketch_data.js';
import {
    ENTITY_KIND, makePoint, makeLine,
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

// ── chamferTwoLines ─────────────────────────────────────────────────────────
suite('chamferTwoLines', () => {
    /**
     * Right angle at (10, 0):
     *   L1: (0, 0) → (10, 0)   (horizontal)
     *   L2: (10, 0) → (10, 10) (vertical)
     */
    function rightAngleCorner() {
        const s = makeSketchData(stockPlane('XY'));
        const A1 = addEntity(s, makePoint(0,  0));
        const B1 = addEntity(s, makePoint(10, 0));
        const A2 = addEntity(s, makePoint(10, 0));
        const B2 = addEntity(s, makePoint(10, 10));
        const L1 = addEntity(s, makeLine(A1.id, B1.id));
        const L2 = addEntity(s, makeLine(A2.id, B2.id));
        return { s, A1, B1, A2, B2, L1, L2 };
    }

    test('inserts a Line entity between the trimmed tangent points', () => {
        const { s, L1, L2 } = rightAngleCorner();
        const bevelId = chamferTwoLines(s, L1.id, L2.id, 2);
        assert.ok(bevelId);
        const bevel = s.entities[bevelId];
        assert.equal(bevel.kind, ENTITY_KIND.LINE);
    });

    test('trims the source lines back to the tangent points', () => {
        const { s, B1, A2, L1, L2 } = rightAngleCorner();
        chamferTwoLines(s, L1.id, L2.id, 2);
        // B1 was at (10, 0); should now sit 2 mm before the corner along L1
        assert.ok(near(s.entities[B1.id].params.x, 8, 1e-3));
        assert.ok(near(s.entities[B1.id].params.y, 0, 1e-3));
        // A2 was at (10, 0); should now sit 2 mm into L2 toward its far endpoint
        assert.ok(near(s.entities[A2.id].params.x, 10, 1e-3));
        assert.ok(near(s.entities[A2.id].params.y, 2,  1e-3));
    });

    test('the bevel reuses the trimmed endpoints so the chain stays connected', () => {
        const { s, B1, A2, L1, L2 } = rightAngleCorner();
        const bevelId = chamferTwoLines(s, L1.id, L2.id, 2);
        const bevel = s.entities[bevelId];
        // The bevel's start/end ids should equal the moved near endpoints
        // of L1 and L2 (so dragging either propagates to the chamfer).
        const ends = new Set([bevel.params.startId, bevel.params.endId]);
        assert.ok(ends.has(B1.id));
        assert.ok(ends.has(A2.id));
    });

    test('the bevel length on a right angle equals d√2', () => {
        const { s, L1, L2 } = rightAngleCorner();
        const bevelId = chamferTwoLines(s, L1.id, L2.id, 2);
        const bevel = s.entities[bevelId];
        const a = s.entities[bevel.params.startId];
        const b = s.entities[bevel.params.endId];
        const len = Math.hypot(b.params.x - a.params.x, b.params.y - a.params.y);
        assert.ok(near(len, 2 * Math.sqrt(2), 1e-3));
    });

    test('returns null when the lines are parallel', () => {
        const s = makeSketchData(stockPlane('XY'));
        const a = addEntity(s, makePoint(0, 0));
        const b = addEntity(s, makePoint(10, 0));
        const c = addEntity(s, makePoint(0, 5));
        const d = addEntity(s, makePoint(10, 5));
        const L1 = addEntity(s, makeLine(a.id, b.id));
        const L2 = addEntity(s, makeLine(c.id, d.id));
        assert.equal(chamferTwoLines(s, L1.id, L2.id, 1), null);
    });

    test('returns null when distance exceeds the available run-up on either line', () => {
        const { s, L1, L2 } = rightAngleCorner();
        // Each leg is 10 mm long; a 50 mm chamfer doesn't fit.
        assert.equal(chamferTwoLines(s, L1.id, L2.id, 50), null);
    });

    test('returns null for non-positive distance', () => {
        const { s, L1, L2 } = rightAngleCorner();
        assert.equal(chamferTwoLines(s, L1.id, L2.id, 0),  null);
        assert.equal(chamferTwoLines(s, L1.id, L2.id, -1), null);
    });

    test('returns null when one of the ids is not a Line', () => {
        const s = makeSketchData(stockPlane('XY'));
        const p = addEntity(s, makePoint(0, 0));
        const a = addEntity(s, makePoint(10, 0));
        const b = addEntity(s, makePoint(10, 10));
        const L = addEntity(s, makeLine(a.id, b.id));
        assert.equal(chamferTwoLines(s, p.id, L.id, 1), null);
    });

    test('works for an obtuse-angle corner (60° between lines)', () => {
        // L1 horizontal from (0, 0) → (10, 0)
        // L2 going from (10, 0) up-and-left at 120° (i.e. 60° from L1's continuation)
        const s = makeSketchData(stockPlane('XY'));
        const a1 = addEntity(s, makePoint(0,  0));
        const b1 = addEntity(s, makePoint(10, 0));
        const a2 = addEntity(s, makePoint(10, 0));
        // 120° direction from corner: ( cos 120°, sin 120° ) = (-0.5, √3/2)
        // Place far endpoint 10 mm along that direction
        const b2 = addEntity(s, makePoint(10 + 10 * Math.cos(2 * Math.PI / 3),
                                                10 * Math.sin(2 * Math.PI / 3)));
        const L1 = addEntity(s, makeLine(a1.id, b1.id));
        const L2 = addEntity(s, makeLine(a2.id, b2.id));
        const bevelId = chamferTwoLines(s, L1.id, L2.id, 2);
        assert.ok(bevelId);
        // For an obtuse angle θ between the two lines (as measured from
        // corner-outward directions), the bevel length is 2d sin(θ/2).
        // θ = 60° → bevel = 2 * 2 * sin(30°) = 2.
        const bevel = s.entities[bevelId];
        const a = s.entities[bevel.params.startId];
        const b = s.entities[bevel.params.endId];
        const len = Math.hypot(b.params.x - a.params.x, b.params.y - a.params.y);
        assert.ok(near(len, 2, 1e-3));
    });
});

// ── Tool stub harness ───────────────────────────────────────────────────────
function stubEd() {
    const sketch = makeSketchData(stockPlane('XY'));
    const state = { selected: [], hover: null, dirty: 0, dimRequested: false, dimCommit: null, lastToast: null };
    const renderer = {
        getSelection() { return state.selected.slice(); },
        setSelection(ids) { state.selected = ids.slice(); },
        setHover(id) { state.hover = id; },
        setSnap() {}, setPreview() {},
        previewLine() { return {}; }, previewCircle() { return {}; },
        previewRect() { return {}; }, previewPolygon() { return {}; },
        render() {},
    };
    return {
        sketchData: sketch,
        commitDirty() { state.dirty++; },
        setDimReadout() {},
        toast(msg, kind) { state.lastToast = { msg, kind }; },
        renderer,
        _screenToWorldDist(px) { return px / 12; },
        _worldToScreenDist(world) { return world * 12; },
        openDimInput({ current, onCommit }) {
            state.dimRequested = true;
            state.dimCurrent = current;
            state.dimCommit = onCommit;
        },
        closeDimInput() { state.dimRequested = false; },
        _state: state,
    };
}
function ev(button = 0) { return { button, shiftKey: false }; }
function ctx(ed, local, snap = null) {
    return {
        local, world: [0, 0, 0],
        snap: snap || { kind: SNAP_KINDS.GRID, point: local },
        event: ev(),
        sketch: ed.sketchData, renderer: ed.renderer,
    };
}

// ── chamferTool3D ───────────────────────────────────────────────────────────
suite('chamferTool3D', () => {
    /** Build a right-angle corner inside `ed.sketchData`. */
    function buildCorner(ed) {
        const A1 = addEntity(ed.sketchData, makePoint(0,  0));
        const B1 = addEntity(ed.sketchData, makePoint(10, 0));
        const A2 = addEntity(ed.sketchData, makePoint(10, 0));
        const B2 = addEntity(ed.sketchData, makePoint(10, 10));
        const L1 = addEntity(ed.sketchData, makeLine(A1.id, B1.id));
        const L2 = addEntity(ed.sketchData, makeLine(A2.id, B2.id));
        return { A1, B1, A2, B2, L1, L2 };
    }

    test('clicking two lines opens a dim input; Enter applies the chamfer', () => {
        const ed = stubEd();
        const { L1, L2, B1, A2 } = buildCorner(ed);

        const tool = chamferTool3D(); tool._editor = ed; tool.activate();
        // First click → first line
        tool.onPointerDown(ctx(ed, { x: 5, y: 0 }));
        assert.equal(ed._state.selected[0], L1.id);
        assert.equal(ed._state.dimRequested, false);
        // Second click → second line
        tool.onPointerDown(ctx(ed, { x: 10, y: 5 }));
        assert.equal(ed._state.dimRequested, true);

        // User types 2 and presses Enter
        ed._state.dimCommit(2);
        assert.equal(ed._state.dirty, 1);
        // Bevel exists between (8, 0) and (10, 2)
        const bevel = Object.values(ed.sketchData.entities).find(e =>
            e.kind === ENTITY_KIND.LINE && e.id !== L1.id && e.id !== L2.id);
        assert.ok(bevel);
        // Last-used distance cached on the editor
        assert.equal(ed._lastChamferDist, 2);
    });

    test('clicking the same line twice does not advance the tool', () => {
        const ed = stubEd();
        const { L1 } = buildCorner(ed);
        const tool = chamferTool3D(); tool._editor = ed; tool.activate();
        tool.onPointerDown(ctx(ed, { x: 5, y: 0 }));   // L1
        tool.onPointerDown(ctx(ed, { x: 5, y: 0 }));   // same line — ignored
        assert.equal(ed._state.dimRequested, false);
        assert.equal(ed._state.dirty, 0);
    });

    test('Escape clears the pending first pick', () => {
        const ed = stubEd();
        const { L1 } = buildCorner(ed);
        const tool = chamferTool3D(); tool._editor = ed; tool.activate();
        tool.onPointerDown(ctx(ed, { x: 5, y: 0 }));
        assert.equal(ed._state.selected[0], L1.id);
        const handled = tool.onKeyDown({ key: 'Escape' });
        assert.equal(handled, true);
        assert.equal(ed._state.selected.length, 0);
    });

    test('clicking off any line shows an error toast and does not select', () => {
        const ed = stubEd();
        buildCorner(ed);
        const tool = chamferTool3D(); tool._editor = ed; tool.activate();
        tool.onPointerDown(ctx(ed, { x: 100, y: 100 }));   // far from any line
        assert.equal(ed._state.lastToast.kind, 'error');
        assert.equal(ed._state.selected.length, 0);
    });

    test('over-large distance falls through to a failure toast on commit', () => {
        const ed = stubEd();
        const { L1, L2 } = buildCorner(ed);
        const tool = chamferTool3D(); tool._editor = ed; tool.activate();
        tool.onPointerDown(ctx(ed, { x: 5, y: 0 }));
        tool.onPointerDown(ctx(ed, { x: 10, y: 5 }));
        // 50 mm distance won't fit on a 10 mm line
        ed._state.dimCommit(50);
        // Bevel should NOT exist; toast should be the error
        const lines = Object.values(ed.sketchData.entities).filter(e => e.kind === ENTITY_KIND.LINE);
        assert.equal(lines.length, 2);   // still only L1 and L2
        assert.equal(ed._state.lastToast.kind, 'error');
        assert.equal(ed._state.dirty, 0);
    });
});

await runAll();
