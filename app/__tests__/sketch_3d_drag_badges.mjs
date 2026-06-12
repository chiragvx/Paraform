/**
 * Tests for the editable-sketch follow-up: drag-to-move + constraint badges.
 *
 * Drag logic is exercised against a stubbed canvas / camera. Badges are
 * tested for anchor math and removal — the DOM placement is integration-
 * verified.
 *
 * Run via:  node app/__tests__/sketch_3d_drag_badges.mjs
 */

import assert from 'node:assert/strict';
import { selectTool3D } from '../sketch_3d/tools_3d.js';
import {
    constraintAnchor,
} from '../sketch_3d/constraint_badges.js';
import { SNAP_KINDS } from '../sketch_3d/snap_3d.js';
import {
    makeSketchData, stockPlane, addEntity, addConstraint, entityCount, constraintCount,
} from '../../lib/sketch/sketch_data.js';
import {
    makePoint, makeLine, makeCircle, makeRectangle,
} from '../../lib/sketch/entities.js';
import {
    horizontal, vertical, fixedRadius, fixedDistance, coincident, midpoint,
    parallel, perpendicular,
} from '../../lib/sketch/constraints.js';
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

// ── Stub editor used by tool tests ──────────────────────────────────────────
function stubEditor() {
    const sketch = makeSketchData(stockPlane('XY'));
    const state = { selected: [], hover: null, dirty: 0, lastSnap: null };
    const renderer = {
        getSelection() { return state.selected.slice(); },
        setSelection(ids) { state.selected = ids.slice(); },
        setHover(id) { state.hover = id; },
        setSnap(s) { state.lastSnap = s; },
        setPreview() {},
        render() { state.rendered = (state.rendered || 0) + 1; },
    };
    return {
        sketchData: sketch,
        polygonSides: 6,
        commitDirty() { state.dirty++; },
        setDimReadout() {},
        renderer,
        // scale ≈ 12 px/mm — pretend we're at the default zoom
        _screenToWorldDist(px) { return px / 12; },
        _worldToScreenDist(world) { return world * 12; },
        _snapCursor(cursor, excludeId) {
            return { kind: SNAP_KINDS.GRID, point: cursor };
        },
        _refreshBadges() { state.badgesRefreshed = (state.badgesRefreshed || 0) + 1; },
        _state: state,
    };
}

function evt(button = 0, shiftKey = false) { return { button, shiftKey }; }
function ctxFor(ed, local, snap = null, button = 0, shiftKey = false) {
    return {
        local, world: [0, 0, 0],
        snap: snap || { kind: SNAP_KINDS.GRID, point: local },
        event: evt(button, shiftKey),
        sketch: ed.sketchData, renderer: ed.renderer,
    };
}

// ── Drag — Point ────────────────────────────────────────────────────────────
suite('drag › point', () => {
    test('pointer move after threshold updates the point coords', () => {
        const ed = stubEditor();
        const p  = addEntity(ed.sketchData, makePoint(0, 0));
        const tool = selectTool3D(); tool._editor = ed; tool.activate();
        tool.onPointerDown(ctxFor(ed, { x: 0, y: 0 }));
        // Stay inside dead-zone first — no movement
        tool.onPointerMove(ctxFor(ed, { x: 0.2, y: 0 }));
        assert.equal(ed.sketchData.entities[p.id].params.x, 0);
        // Cross the threshold (4 px @ 12 px/mm = 0.333 mm)
        tool.onPointerMove(ctxFor(ed, { x: 5, y: 0 }));
        assert.ok(near(ed.sketchData.entities[p.id].params.x, 5));
        tool.onPointerUp({ renderer: ed.renderer });
        assert.equal(ed._state.dirty, 1);
    });

    test('a single click (under threshold) does NOT mark dirty', () => {
        const ed = stubEditor();
        addEntity(ed.sketchData, makePoint(0, 0));
        const tool = selectTool3D(); tool._editor = ed; tool.activate();
        tool.onPointerDown(ctxFor(ed, { x: 0, y: 0 }));
        tool.onPointerUp({ renderer: ed.renderer });
        assert.equal(ed._state.dirty, 0);
    });
});

// ── Drag — Line moves both endpoints ───────────────────────────────────────
suite('drag › line', () => {
    test('dragging a Line translates both endpoints by the same delta', () => {
        const ed = stubEditor();
        const a  = addEntity(ed.sketchData, makePoint(0, 0));
        const b  = addEntity(ed.sketchData, makePoint(10, 0));
        addEntity(ed.sketchData, makeLine(a.id, b.id));
        const tool = selectTool3D(); tool._editor = ed; tool.activate();
        // Click the line at its midpoint
        tool.onPointerDown(ctxFor(ed, { x: 5, y: 0 }));
        tool.onPointerMove(ctxFor(ed, { x: 8, y: 4 }));
        const pa = ed.sketchData.entities[a.id].params;
        const pb = ed.sketchData.entities[b.id].params;
        assert.ok(near(pa.x, 3));
        assert.ok(near(pa.y, 4));
        assert.ok(near(pb.x, 13));
        assert.ok(near(pb.y, 4));
        tool.onPointerUp({ renderer: ed.renderer });
    });
});

// ── Drag — Circle moves the centre point ───────────────────────────────────
suite('drag › circle', () => {
    test('dragging a Circle moves its centre but not its radius', () => {
        const ed = stubEditor();
        const c  = addEntity(ed.sketchData, makePoint(0, 0));
        const C  = addEntity(ed.sketchData, makeCircle(c.id, 5));
        const tool = selectTool3D(); tool._editor = ed; tool.activate();
        // Click on the rim
        tool.onPointerDown(ctxFor(ed, { x: 5, y: 0 }));
        tool.onPointerMove(ctxFor(ed, { x: 7, y: 3 }));
        // Centre moved by (2, 3)
        assert.ok(near(ed.sketchData.entities[c.id].params.x, 2));
        assert.ok(near(ed.sketchData.entities[c.id].params.y, 3));
        // Radius unchanged
        assert.equal(ed.sketchData.entities[C.id].params.radius, 5);
        tool.onPointerUp({ renderer: ed.renderer });
    });
});

// ── Drag — locked constraints still hold ───────────────────────────────────
suite('drag › constraint-aware', () => {
    test('horizontal-locked Line stays horizontal under a vertical drag', () => {
        const ed = stubEditor();
        const a  = addEntity(ed.sketchData, makePoint(0, 0));
        const b  = addEntity(ed.sketchData, makePoint(10, 0));
        const L  = addEntity(ed.sketchData, makeLine(a.id, b.id));
        addConstraint(ed.sketchData, horizontal(L.id));
        const tool = selectTool3D(); tool._editor = ed; tool.activate();
        tool.onPointerDown(ctxFor(ed, { x: 10, y: 0 }));
        // Vertical drag pulls one endpoint up; the solver should drag the other
        // along so the line stays horizontal.
        tool.onPointerMove(ctxFor(ed, { x: 10, y: 5 }));
        const pa = ed.sketchData.entities[a.id].params;
        const pb = ed.sketchData.entities[b.id].params;
        assert.ok(near(pa.y, pb.y, 1e-3),
            `expected horizontal line; got a.y=${pa.y} b.y=${pb.y}`);
        tool.onPointerUp({ renderer: ed.renderer });
    });

    test('fixed-distance constraint is preserved during drag', () => {
        const ed = stubEditor();
        const a  = addEntity(ed.sketchData, makePoint(0, 0));
        const b  = addEntity(ed.sketchData, makePoint(10, 0));
        addConstraint(ed.sketchData, fixedDistance(a.id, b.id, 10));
        const tool = selectTool3D(); tool._editor = ed; tool.activate();
        tool.onPointerDown(ctxFor(ed, { x: 0, y: 0 }));
        tool.onPointerMove(ctxFor(ed, { x: 5, y: 5 }));
        const pa = ed.sketchData.entities[a.id].params;
        const pb = ed.sketchData.entities[b.id].params;
        const d  = Math.hypot(pb.x - pa.x, pb.y - pa.y);
        assert.ok(Math.abs(d - 10) < 0.05,
            `expected distance ~10; got ${d.toFixed(4)}`);
        tool.onPointerUp({ renderer: ed.renderer });
    });

    test('Escape during drag cancels (no dirty flag)', () => {
        const ed = stubEditor();
        const p  = addEntity(ed.sketchData, makePoint(0, 0));
        const tool = selectTool3D(); tool._editor = ed; tool.activate();
        tool.onPointerDown(ctxFor(ed, { x: 0, y: 0 }));
        tool.onPointerMove(ctxFor(ed, { x: 5, y: 0 }));
        // Esc → drag should be discarded
        const handled = tool.onKeyDown({ key: 'Escape' });
        assert.equal(handled, true);
        // PointerUp afterwards should not mark dirty (drag state cleared)
        tool.onPointerUp({ renderer: ed.renderer });
        assert.equal(ed._state.dirty, 0);
    });
});

// ── Constraint badges › anchor math ─────────────────────────────────────────
suite('badges › anchor', () => {
    function lineSketch(p1 = [0, 0], p2 = [10, 0]) {
        const s = makeSketchData(stockPlane('XY'));
        const a = addEntity(s, makePoint(p1[0], p1[1]));
        const b = addEntity(s, makePoint(p2[0], p2[1]));
        const L = addEntity(s, makeLine(a.id, b.id));
        return { s, a, b, L };
    }

    test('HORIZONTAL anchor is at the line midpoint', () => {
        const { s, L } = lineSketch([0, 0], [10, 0]);
        const c = horizontal(L.id);
        addConstraint(s, c);
        const anchor = constraintAnchor(s, c);
        assert.deepEqual(anchor, { x: 5, y: 0 });
    });

    test('VERTICAL anchor is at the line midpoint', () => {
        const { s, L } = lineSketch([0, 0], [0, 10]);
        const c = vertical(L.id);
        addConstraint(s, c);
        const anchor = constraintAnchor(s, c);
        assert.deepEqual(anchor, { x: 0, y: 5 });
    });

    test('FIXED_RADIUS anchor is offset from the circle centre', () => {
        const s = makeSketchData(stockPlane('XY'));
        const c = addEntity(s, makePoint(0, 0));
        const C = addEntity(s, makeCircle(c.id, 10));
        const cst = fixedRadius(C.id, 10);
        addConstraint(s, cst);
        const anchor = constraintAnchor(s, cst);
        // r * 0.707 ≈ 7.07
        assert.ok(near(anchor.x, 7.07, 0.05));
        assert.ok(near(anchor.y, 7.07, 0.05));
    });

    test('FIXED_DISTANCE anchor is the midpoint between the two endpoints', () => {
        const s = makeSketchData(stockPlane('XY'));
        const a = addEntity(s, makePoint(0, 0));
        const b = addEntity(s, makePoint(20, 0));
        const cst = fixedDistance(a.id, b.id, 20);
        addConstraint(s, cst);
        const anchor = constraintAnchor(s, cst);
        assert.deepEqual(anchor, { x: 10, y: 0 });
    });

    test('COINCIDENT anchor sits on the first point', () => {
        const s = makeSketchData(stockPlane('XY'));
        const a = addEntity(s, makePoint(3, 4));
        const b = addEntity(s, makePoint(8, 4));
        const cst = coincident(a.id, b.id);
        addConstraint(s, cst);
        const anchor = constraintAnchor(s, cst);
        assert.deepEqual(anchor, { x: 3, y: 4 });
    });

    test('PARALLEL anchor uses the first line\'s midpoint', () => {
        const { s, L } = lineSketch([0, 0], [10, 0]);
        const a2 = addEntity(s, makePoint(0, 5));
        const b2 = addEntity(s, makePoint(10, 5));
        const L2 = addEntity(s, makeLine(a2.id, b2.id));
        const cst = parallel(L.id, L2.id);
        addConstraint(s, cst);
        const anchor = constraintAnchor(s, cst);
        assert.deepEqual(anchor, { x: 5, y: 0 });
    });

    test('PERPENDICULAR anchor uses the first line\'s midpoint', () => {
        const { s, L } = lineSketch([0, 0], [10, 0]);
        const a2 = addEntity(s, makePoint(0, 0));
        const b2 = addEntity(s, makePoint(0, 10));
        const L2 = addEntity(s, makeLine(a2.id, b2.id));
        const cst = perpendicular(L.id, L2.id);
        addConstraint(s, cst);
        const anchor = constraintAnchor(s, cst);
        assert.deepEqual(anchor, { x: 5, y: 0 });
    });

    test('MIDPOINT anchor sits on the constrained point', () => {
        const { s, L } = lineSketch([0, 0], [20, 0]);
        const p = addEntity(s, makePoint(7, 0));
        const cst = midpoint(p.id, L.id);
        addConstraint(s, cst);
        const anchor = constraintAnchor(s, cst);
        assert.deepEqual(anchor, { x: 7, y: 0 });
    });

    test('Anchor returns null when an entity it references is missing', () => {
        const s = makeSketchData(stockPlane('XY'));
        const a = addEntity(s, makePoint(0, 0));
        const b = addEntity(s, makePoint(10, 0));
        const L = addEntity(s, makeLine(a.id, b.id));
        const cst = horizontal(L.id);
        addConstraint(s, cst);
        // Corrupt the sketch by deleting the line entity (bypassing cascades)
        delete s.entities[L.id];
        const anchor = constraintAnchor(s, cst);
        assert.equal(anchor, null);
    });
});

// ── ConstraintBadgeLayer.refresh — without a DOM ────────────────────────────
// The DOM layer (browser-only) is integration-checked. Here we verify the
// public refresh() and removal contract by stubbing minimal DOM nodes.

import { ConstraintBadgeLayer } from '../sketch_3d/constraint_badges.js';

function stubHostNode() {
    const node = {
        children: [],
        appendChild(c)  { this.children.push(c); c.parentNode = this; return c; },
        removeChild(c)  { this.children = this.children.filter(x => x !== c); c.parentNode = null; },
    };
    return node;
}
function stubBadgeNode() {
    const n = {
        children: [],
        parentNode: null,
        style: {},
        className: '',
        title: '',
        textContent: '',
        _listeners: {},
        addEventListener(type, fn) { (this._listeners[type] ??= []).push(fn); },
        appendChild(c)  { this.children.push(c); c.parentNode = this; return c; },
        removeChild(c)  { this.children = this.children.filter(x => x !== c); c.parentNode = null; },
    };
    return n;
}
// Patch global document with a tiny element factory so ConstraintBadgeLayer
// can run in Node without jsdom.
globalThis.document = globalThis.document || {
    createElement() { return stubBadgeNode(); },
};

suite('badges › layer', () => {
    test('refresh() creates one badge per constraint', () => {
        const s = makeSketchData(stockPlane('XY'));
        const a = addEntity(s, makePoint(0, 0));
        const b = addEntity(s, makePoint(10, 0));
        const L = addEntity(s, makeLine(a.id, b.id));
        addConstraint(s, horizontal(L.id));
        addConstraint(s, fixedDistance(a.id, b.id, 10));
        const host = stubHostNode();
        const layer = new ConstraintBadgeLayer({
            host, sketchData: s,
            localToScreen: (pt) => ({ x: pt.x, y: pt.y }),
        });
        // Two constraints → two badges
        assert.equal(layer.layerEl.children.length, 2);
    });

    test('refresh() removes badges whose constraint disappears', () => {
        const s = makeSketchData(stockPlane('XY'));
        const a = addEntity(s, makePoint(0, 0));
        const b = addEntity(s, makePoint(10, 0));
        const L = addEntity(s, makeLine(a.id, b.id));
        const c1 = horizontal(L.id);
        const c2 = fixedDistance(a.id, b.id, 10);
        addConstraint(s, c1);
        addConstraint(s, c2);
        const host = stubHostNode();
        const layer = new ConstraintBadgeLayer({
            host, sketchData: s,
            localToScreen: (pt) => ({ x: pt.x, y: pt.y }),
        });
        assert.equal(layer.layerEl.children.length, 2);
        // Drop one constraint and refresh — only one badge should remain
        delete s.constraints[c1.id];
        s.constraintOrder = s.constraintOrder.filter(id => id !== c1.id);
        layer.refresh();
        assert.equal(layer.layerEl.children.length, 1);
    });

    test('_remove() drops the constraint from the sketch and re-lays out', () => {
        const s = makeSketchData(stockPlane('XY'));
        const a = addEntity(s, makePoint(0, 0));
        const b = addEntity(s, makePoint(10, 0));
        const L = addEntity(s, makeLine(a.id, b.id));
        const c = horizontal(L.id);
        addConstraint(s, c);
        const host = stubHostNode();
        let removed = null;
        const layer = new ConstraintBadgeLayer({
            host, sketchData: s,
            localToScreen: (pt) => ({ x: pt.x, y: pt.y }),
            onAfterRemove: (id) => { removed = id; },
        });
        layer._remove(c.id);
        assert.equal(constraintCount(s), 0);
        assert.equal(removed, c.id);
        assert.equal(layer.layerEl.children.length, 0);
    });
});

runAll();
