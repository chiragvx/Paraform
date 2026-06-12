/**
 * Tests for the sketch-editing helpers (lib/sketch/sketch_edits.js) and the
 * matching 3D tools (Fillet, Offset, construction toggle).
 *
 * Run via:  node app/__tests__/sketch_3d_edits.mjs
 */

import assert from 'node:assert/strict';
import {
    filletTwoLines, offsetLine, offsetCircle, offsetEntity,
    offsetSideFromCursor, setEntityConstruction, toggleEntityConstruction,
    lineLineIntersect,
} from '../../lib/sketch/sketch_edits.js';
import {
    filletTool3D, offsetTool3D, toggleConstructionOnSelection,
} from '../sketch_3d/tools_3d.js';
import { SNAP_KINDS } from '../sketch_3d/snap_3d.js';
import {
    makeSketchData, stockPlane, addEntity, entityCount, constraintCount,
} from '../../lib/sketch/sketch_data.js';
import { ENTITY_KIND, makePoint, makeLine, makeCircle } from '../../lib/sketch/entities.js';

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

// ── lineLineIntersect ───────────────────────────────────────────────────────
suite('lineLineIntersect', () => {
    test('returns the intersection of two crossing lines', () => {
        const p = lineLineIntersect({ x: 0, y: 0 }, { x: 10, y: 0 },
                                    { x: 5, y: -5 }, { x: 5, y: 5 });
        assert.ok(near(p.x, 5));
        assert.ok(near(p.y, 0));
    });

    test('returns null for parallel lines', () => {
        const p = lineLineIntersect({ x: 0, y: 0 }, { x: 10, y: 0 },
                                    { x: 0, y: 5 }, { x: 10, y: 5 });
        assert.equal(p, null);
    });
});

// ── Construction toggle helpers ────────────────────────────────────────────
suite('construction toggle', () => {
    test('setEntityConstruction flips the flag', () => {
        const s = makeSketchData(stockPlane('XY'));
        const p = addEntity(s, makePoint(0, 0));
        assert.equal(s.entities[p.id].construction, false);
        setEntityConstruction(s, p.id, true);
        assert.equal(s.entities[p.id].construction, true);
    });

    test('toggleEntityConstruction toggles', () => {
        const s = makeSketchData(stockPlane('XY'));
        const p = addEntity(s, makePoint(0, 0));
        toggleEntityConstruction(s, p.id);
        assert.equal(s.entities[p.id].construction, true);
        toggleEntityConstruction(s, p.id);
        assert.equal(s.entities[p.id].construction, false);
    });

    test('toggleConstructionOnSelection flips every selected entity', () => {
        const s = makeSketchData(stockPlane('XY'));
        const a = addEntity(s, makePoint(0, 0));
        const b = addEntity(s, makePoint(10, 0));
        const c = addEntity(s, makePoint(20, 0));
        const count = toggleConstructionOnSelection(s, [a.id, c.id]);
        assert.equal(count, 2);
        assert.equal(s.entities[a.id].construction, true);
        assert.equal(s.entities[b.id].construction, false);   // unchanged
        assert.equal(s.entities[c.id].construction, true);
    });
});

// ── offsetLine ─────────────────────────────────────────────────────────────
suite('offsetLine', () => {
    function horizSketch() {
        const s = makeSketchData(stockPlane('XY'));
        const a = addEntity(s, makePoint(0, 0));
        const b = addEntity(s, makePoint(10, 0));
        const L = addEntity(s, makeLine(a.id, b.id));
        return { s, a, b, L };
    }

    test('offsetting a horizontal line +1 pushes it +Y by `distance`', () => {
        const { s, L } = horizSketch();
        const newId = offsetLine(s, L.id, 5, +1);
        const newLine = s.entities[newId];
        const na = s.entities[newLine.params.startId];
        const nb = s.entities[newLine.params.endId];
        assert.ok(near(na.params.x, 0));
        assert.ok(near(na.params.y, 5));
        assert.ok(near(nb.params.x, 10));
        assert.ok(near(nb.params.y, 5));
    });

    test('offsetting a horizontal line -1 pushes it -Y', () => {
        const { s, L } = horizSketch();
        const newId = offsetLine(s, L.id, 5, -1);
        const newLine = s.entities[newId];
        const na = s.entities[newLine.params.startId];
        assert.ok(near(na.params.y, -5));
    });

    test('zero / negative distance is rejected', () => {
        const { s, L } = horizSketch();
        assert.equal(offsetLine(s, L.id, 0, 1),  null);
        assert.equal(offsetLine(s, L.id, -1, 1), null);
    });

    test('a zero-length line is rejected', () => {
        const s = makeSketchData(stockPlane('XY'));
        const a = addEntity(s, makePoint(5, 5));
        const b = addEntity(s, makePoint(5, 5));
        const L = addEntity(s, makeLine(a.id, b.id));
        assert.equal(offsetLine(s, L.id, 2, 1), null);
    });
});

// ── offsetCircle ───────────────────────────────────────────────────────────
suite('offsetCircle', () => {
    function circleSketch(r = 5) {
        const s = makeSketchData(stockPlane('XY'));
        const c = addEntity(s, makePoint(0, 0));
        const C = addEntity(s, makeCircle(c.id, r));
        return { s, c, C };
    }

    test('positive distance grows the radius', () => {
        const { s, C } = circleSketch(5);
        const newId = offsetCircle(s, C.id, 2, +1);
        assert.equal(s.entities[newId].params.radius, 7);
    });

    test('negative distance shrinks the radius', () => {
        const { s, C } = circleSketch(5);
        const newId = offsetCircle(s, C.id, 2, -1);
        assert.equal(s.entities[newId].params.radius, 3);
    });

    test('result radius ≤ 0 is rejected (returns null)', () => {
        const { s, C } = circleSketch(5);
        assert.equal(offsetCircle(s, C.id, 10, -1), null);
    });

    test('the new circle reuses the original centre point', () => {
        const { s, c, C } = circleSketch();
        const newId = offsetCircle(s, C.id, 2, +1);
        assert.equal(s.entities[newId].params.centerId, c.id);
    });
});

// ── offsetEntity dispatcher ────────────────────────────────────────────────
suite('offsetEntity', () => {
    test('routes lines to offsetLine', () => {
        const s = makeSketchData(stockPlane('XY'));
        const a = addEntity(s, makePoint(0, 0));
        const b = addEntity(s, makePoint(10, 0));
        const L = addEntity(s, makeLine(a.id, b.id));
        const id = offsetEntity(s, L.id, 3, 1);
        assert.equal(s.entities[id].kind, 'line');
    });

    test('routes circles to offsetCircle', () => {
        const s = makeSketchData(stockPlane('XY'));
        const c = addEntity(s, makePoint(0, 0));
        const C = addEntity(s, makeCircle(c.id, 5));
        const id = offsetEntity(s, C.id, 1, 1);
        assert.equal(s.entities[id].kind, 'circle');
    });

    test('returns null for unsupported entity kinds (point)', () => {
        const s = makeSketchData(stockPlane('XY'));
        const p = addEntity(s, makePoint(0, 0));
        assert.equal(offsetEntity(s, p.id, 1, 1), null);
    });
});

// ── offsetSideFromCursor ───────────────────────────────────────────────────
suite('offsetSideFromCursor', () => {
    test('line: cursor above a +X line returns +1', () => {
        const s = makeSketchData(stockPlane('XY'));
        const a = addEntity(s, makePoint(0, 0));
        const b = addEntity(s, makePoint(10, 0));
        const L = addEntity(s, makeLine(a.id, b.id));
        assert.equal(offsetSideFromCursor(s, L.id, { x: 5, y: 5 }), +1);
        assert.equal(offsetSideFromCursor(s, L.id, { x: 5, y: -5 }), -1);
    });

    test('circle: cursor outside returns +1, inside -1', () => {
        const s = makeSketchData(stockPlane('XY'));
        const c = addEntity(s, makePoint(0, 0));
        const C = addEntity(s, makeCircle(c.id, 5));
        assert.equal(offsetSideFromCursor(s, C.id, { x: 10, y: 0 }), +1);
        assert.equal(offsetSideFromCursor(s, C.id, { x: 2, y: 0 }),  -1);
    });
});

// ── filletTwoLines ─────────────────────────────────────────────────────────
suite('filletTwoLines', () => {
    function rightAngleCorner() {
        // Right angle at (10, 0): L1 from (0,0)→(10,0), L2 from (10,0)→(10,10)
        const s = makeSketchData(stockPlane('XY'));
        const A1 = addEntity(s, makePoint(0,  0));
        const B1 = addEntity(s, makePoint(10, 0));
        const A2 = addEntity(s, makePoint(10, 0));
        const B2 = addEntity(s, makePoint(10, 10));
        const L1 = addEntity(s, makeLine(A1.id, B1.id));
        const L2 = addEntity(s, makeLine(A2.id, B2.id));
        return { s, A1, B1, A2, B2, L1, L2 };
    }

    test('right-angle fillet at the corner produces a 90° arc', () => {
        const { s, B1, A2, L1, L2 } = rightAngleCorner();
        const arcId = filletTwoLines(s, L1.id, L2.id, 1);
        assert.ok(arcId);
        const arc = s.entities[arcId];
        assert.equal(arc.kind, ENTITY_KIND.ARC);
        assert.ok(near(arc.params.radius, 1));
        // Sweep should be 90° in radians
        assert.ok(near(Math.abs(arc.params.sweepAngle), Math.PI / 2, 1e-2));
    });

    test('source lines are trimmed back to the tangent points', () => {
        const { s, B1, A2, L1, L2 } = rightAngleCorner();
        filletTwoLines(s, L1.id, L2.id, 2);
        // B1 (was at corner) should now be at (8, 0) — 2 mm before the corner
        assert.ok(near(s.entities[B1.id].params.x, 8, 1e-2));
        assert.ok(near(s.entities[B1.id].params.y, 0, 1e-2));
        // A2 (was at corner) should now be at (10, 2)
        assert.ok(near(s.entities[A2.id].params.x, 10, 1e-2));
        assert.ok(near(s.entities[A2.id].params.y, 2,  1e-2));
    });

    test('returns null when lines are parallel', () => {
        const s = makeSketchData(stockPlane('XY'));
        const a = addEntity(s, makePoint(0, 0));
        const b = addEntity(s, makePoint(10, 0));
        const c = addEntity(s, makePoint(0, 5));
        const d = addEntity(s, makePoint(10, 5));
        const L1 = addEntity(s, makeLine(a.id, b.id));
        const L2 = addEntity(s, makeLine(c.id, d.id));
        assert.equal(filletTwoLines(s, L1.id, L2.id, 1), null);
    });

    test('returns null when radius is too big to fit on the lines', () => {
        const { s, L1, L2 } = rightAngleCorner();
        // Each line is 10 mm long; radius 50 mm needs > 50 mm runway → reject
        assert.equal(filletTwoLines(s, L1.id, L2.id, 50), null);
    });

    test('returns null for non-positive radius', () => {
        const { s, L1, L2 } = rightAngleCorner();
        assert.equal(filletTwoLines(s, L1.id, L2.id, 0),  null);
        assert.equal(filletTwoLines(s, L1.id, L2.id, -1), null);
    });
});

// ── Tool stubs ──────────────────────────────────────────────────────────────
function stubEd() {
    const sketch = makeSketchData(stockPlane('XY'));
    const state = { selected: [], hover: null, dirty: 0, dimRequested: false, dimCommit: null };
    const renderer = {
        getSelection() { return state.selected.slice(); },
        setSelection(ids) { state.selected = ids.slice(); },
        setHover(id) { state.hover = id; },
        setSnap() {}, setPreview(o) { state.preview = o; },
        previewLine(a, b) { return { kind: 'preview-line', a, b }; },
        previewCircle(c, r) { return { kind: 'preview-circle', c, r }; },
        previewRect() { return {}; }, previewPolygon() { return {}; },
        render() {},
    };
    return {
        sketchData: sketch,
        polygonSides: 6,
        commitDirty() { state.dirty++; },
        setDimReadout() {},
        toast(msg, kind) { state.lastToast = { msg, kind }; },
        renderer,
        _screenToWorldDist(px) { return px / 12; },
        _worldToScreenDist(world) { return world * 12; },
        openDimInput({ onCommit }) { state.dimRequested = true; state.dimCommit = onCommit; },
        closeDimInput() {},
        _state: state,
    };
}

function ev(button = 0, shift = false) { return { button, shiftKey: shift }; }
function ctx(ed, local, snap = null) {
    return {
        local, world: [0, 0, 0],
        snap: snap || { kind: SNAP_KINDS.GRID, point: local },
        event: ev(),
        sketch: ed.sketchData, renderer: ed.renderer,
    };
}

// ── filletTool3D ────────────────────────────────────────────────────────────
suite('filletTool3D', () => {
    test('clicking two lines opens a dim input; Enter applies the fillet', () => {
        const ed = stubEd();
        const A1 = addEntity(ed.sketchData, makePoint(0,  0));
        const B1 = addEntity(ed.sketchData, makePoint(10, 0));
        const A2 = addEntity(ed.sketchData, makePoint(10, 0));
        const B2 = addEntity(ed.sketchData, makePoint(10, 10));
        const L1 = addEntity(ed.sketchData, makeLine(A1.id, B1.id));
        const L2 = addEntity(ed.sketchData, makeLine(A2.id, B2.id));
        const tool = filletTool3D(); tool._editor = ed; tool.activate();
        // Click somewhere on L1 (its midpoint)
        tool.onPointerDown(ctx(ed, { x: 5, y: 0 }));
        // Click somewhere on L2 (its midpoint)
        tool.onPointerDown(ctx(ed, { x: 10, y: 5 }));
        assert.equal(ed._state.dimRequested, true);
        ed._state.dimCommit(1.5);
        // An arc was added
        const arcs = Object.values(ed.sketchData.entities).filter(e => e.kind === ENTITY_KIND.ARC);
        assert.equal(arcs.length, 1);
        assert.ok(near(arcs[0].params.radius, 1.5));
        // The editor remembers the last radius for the next fillet
        assert.equal(ed._lastFilletRadius, 1.5);
    });

    test('clicking the same line twice does not advance', () => {
        const ed = stubEd();
        const A = addEntity(ed.sketchData, makePoint(0, 0));
        const B = addEntity(ed.sketchData, makePoint(10, 0));
        addEntity(ed.sketchData, makeLine(A.id, B.id));
        const tool = filletTool3D(); tool._editor = ed; tool.activate();
        tool.onPointerDown(ctx(ed, { x: 5, y: 0 }));   // L1
        tool.onPointerDown(ctx(ed, { x: 6, y: 0 }));   // same L1
        assert.equal(ed._state.dimRequested, false);
    });

    test('Escape clears the pending first pick', () => {
        const ed = stubEd();
        const A = addEntity(ed.sketchData, makePoint(0, 0));
        const B = addEntity(ed.sketchData, makePoint(10, 0));
        addEntity(ed.sketchData, makeLine(A.id, B.id));
        const tool = filletTool3D(); tool._editor = ed; tool.activate();
        tool.onPointerDown(ctx(ed, { x: 5, y: 0 }));
        assert.equal(ed.renderer.getSelection().length, 1);
        const handled = tool.onKeyDown({ key: 'Escape' });
        assert.equal(handled, true);
        assert.equal(ed.renderer.getSelection().length, 0);
    });
});

// ── offsetTool3D ────────────────────────────────────────────────────────────
suite('offsetTool3D', () => {
    test('click a line → click second time → dim input opens with cursor distance', () => {
        const ed = stubEd();
        const A = addEntity(ed.sketchData, makePoint(0, 0));
        const B = addEntity(ed.sketchData, makePoint(10, 0));
        const L = addEntity(ed.sketchData, makeLine(A.id, B.id));
        const tool = offsetTool3D(); tool._editor = ed; tool.activate();
        tool.onPointerDown(ctx(ed, { x: 5, y: 0 }));
        // Hover at +Y 3 mm — preview should render
        tool.onPointerMove(ctx(ed, { x: 5, y: 3 }));
        assert.ok(ed._state.preview);
        // Second click at +Y 3 → opens input
        tool.onPointerDown(ctx(ed, { x: 5, y: 3 }));
        assert.equal(ed._state.dimRequested, true);
        // Commit 4 mm → a new line lands 4 mm above the original
        ed._state.dimCommit(4);
        const lines = Object.values(ed.sketchData.entities).filter(e => e.kind === ENTITY_KIND.LINE);
        assert.equal(lines.length, 2);
        const newLine = lines[1];
        const na = ed.sketchData.entities[newLine.params.startId];
        assert.ok(near(na.params.y, 4));
    });

    test('cursor below the line offsets in the opposite direction', () => {
        const ed = stubEd();
        const A = addEntity(ed.sketchData, makePoint(0, 0));
        const B = addEntity(ed.sketchData, makePoint(10, 0));
        const L = addEntity(ed.sketchData, makeLine(A.id, B.id));
        const tool = offsetTool3D(); tool._editor = ed; tool.activate();
        tool.onPointerDown(ctx(ed, { x: 5, y: 0 }));
        tool.onPointerDown(ctx(ed, { x: 5, y: -3 }));   // negative side
        ed._state.dimCommit(2);
        const lines = Object.values(ed.sketchData.entities).filter(e => e.kind === ENTITY_KIND.LINE);
        const newLine = lines[1];
        const na = ed.sketchData.entities[newLine.params.startId];
        assert.ok(near(na.params.y, -2));
    });

    test('Escape during selection clears state', () => {
        const ed = stubEd();
        const A = addEntity(ed.sketchData, makePoint(0, 0));
        const B = addEntity(ed.sketchData, makePoint(10, 0));
        addEntity(ed.sketchData, makeLine(A.id, B.id));
        const tool = offsetTool3D(); tool._editor = ed; tool.activate();
        tool.onPointerDown(ctx(ed, { x: 5, y: 0 }));
        const handled = tool.onKeyDown({ key: 'Escape' });
        assert.equal(handled, true);
        assert.equal(ed.renderer.getSelection().length, 0);
    });
});

runAll();
