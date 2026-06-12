/**
 * Tests for the sketch intersection module and the Trim tool.
 *
 * Run via:  node app/__tests__/sketch_3d_trim.mjs
 */

import assert from 'node:assert/strict';
import {
    intersectLineLine, intersectLineCircle, intersectCircleCircle,
    lineParam, circleParam, arcParam, findIntersections,
} from '../../lib/sketch/sketch_intersect.js';
import {
    trimSegments, trimEntity,
} from '../../lib/sketch/sketch_edits.js';
import { trimTool3D } from '../sketch_3d/tools_3d.js';
import { SNAP_KINDS } from '../sketch_3d/snap_3d.js';
import {
    makeSketchData, stockPlane, addEntity, entityCount,
} from '../../lib/sketch/sketch_data.js';
import { ENTITY_KIND, makePoint, makeLine, makeCircle, makeArc } from '../../lib/sketch/entities.js';

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

// ── Intersection math ──────────────────────────────────────────────────────
suite('intersectLineLine', () => {
    test('two crossing lines hit at the algebraic intersection', () => {
        const p = intersectLineLine({x:0,y:0}, {x:10,y:0}, {x:5,y:-5}, {x:5,y:5});
        assert.ok(near(p.x, 5));
        assert.ok(near(p.y, 0));
    });
    test('parallel lines return null', () => {
        const p = intersectLineLine({x:0,y:0}, {x:10,y:0}, {x:0,y:5}, {x:10,y:5});
        assert.equal(p, null);
    });
});

suite('intersectLineCircle', () => {
    test('a chord through the centre returns the two diameter endpoints', () => {
        const hits = intersectLineCircle({x:-10,y:0}, {x:10,y:0}, {x:0,y:0}, 5);
        assert.equal(hits.length, 2);
        const xs = hits.map(p => p.x).sort();
        assert.ok(near(xs[0], -5));
        assert.ok(near(xs[1],  5));
    });
    test('a tangent line returns exactly one point', () => {
        const hits = intersectLineCircle({x:-10,y:5}, {x:10,y:5}, {x:0,y:0}, 5);
        assert.equal(hits.length, 1);
        assert.ok(near(hits[0].x, 0));
        assert.ok(near(hits[0].y, 5));
    });
    test('a line that misses returns empty', () => {
        const hits = intersectLineCircle({x:-10,y:10}, {x:10,y:10}, {x:0,y:0}, 5);
        assert.equal(hits.length, 0);
    });
});

suite('intersectCircleCircle', () => {
    test('two circles partially overlapping return two points', () => {
        const hits = intersectCircleCircle({x:0,y:0}, 5, {x:6,y:0}, 5);
        assert.equal(hits.length, 2);
    });
    test('externally tangent circles return one point', () => {
        const hits = intersectCircleCircle({x:0,y:0}, 5, {x:10,y:0}, 5);
        assert.equal(hits.length, 1);
        assert.ok(near(hits[0].x, 5));
        assert.ok(near(hits[0].y, 0));
    });
    test('far apart circles return empty', () => {
        const hits = intersectCircleCircle({x:0,y:0}, 5, {x:20,y:0}, 5);
        assert.equal(hits.length, 0);
    });
    test('concentric circles return empty', () => {
        const hits = intersectCircleCircle({x:0,y:0}, 5, {x:0,y:0}, 3);
        assert.equal(hits.length, 0);
    });
});

// ── Parameter helpers ──────────────────────────────────────────────────────
suite('lineParam / circleParam / arcParam', () => {
    test('lineParam returns 0.5 for the midpoint', () => {
        assert.ok(near(lineParam({x:5,y:0}, {x:0,y:0}, {x:10,y:0}), 0.5));
    });
    test('circleParam wraps to [0, 2π)', () => {
        assert.ok(near(circleParam({x:5,y:0}, {x:0,y:0}), 0));
        assert.ok(near(circleParam({x:0,y:5}, {x:0,y:0}), Math.PI / 2));
    });
    test('arcParam returns null when the point is outside the sweep', () => {
        // Arc from 0 to π (positive sweep). A point at 1.5π is outside.
        const c = {x:0,y:0};
        const r = arcParam({x:0,y:-1}, c, 0, Math.PI);
        assert.equal(r, null);
    });
    test('arcParam returns the linear progress along the arc', () => {
        const c = {x:0,y:0};
        const r = arcParam({x:0,y:1}, c, 0, Math.PI);
        assert.ok(near(r, Math.PI / 2));
    });
});

// ── findIntersections ──────────────────────────────────────────────────────
suite('findIntersections', () => {
    test('returns every hit along a line with parameters in [0, 1]', () => {
        const s = makeSketchData(stockPlane('XY'));
        const a = addEntity(s, makePoint(0, 0));
        const b = addEntity(s, makePoint(10, 0));
        const L = addEntity(s, makeLine(a.id, b.id));
        // Vertical line cutting at x=3
        const c = addEntity(s, makePoint(3, -5));
        const d = addEntity(s, makePoint(3, 5));
        addEntity(s, makeLine(c.id, d.id));
        // Vertical line cutting at x=7
        const e = addEntity(s, makePoint(7, -5));
        const f = addEntity(s, makePoint(7, 5));
        addEntity(s, makeLine(e.id, f.id));
        const hits = findIntersections(s, L.id);
        const params = hits.map(h => h.param).sort((x, y) => x - y);
        assert.equal(params.length, 2);
        assert.ok(near(params[0], 0.3));
        assert.ok(near(params[1], 0.7));
    });

    test('circle vs two crossing chords returns four points', () => {
        const s = makeSketchData(stockPlane('XY'));
        const cc = addEntity(s, makePoint(0, 0));
        const C  = addEntity(s, makeCircle(cc.id, 5));
        // Two diameter lines: +X axis and +Y axis
        const a = addEntity(s, makePoint(-10, 0));
        const b = addEntity(s, makePoint( 10, 0));
        addEntity(s, makeLine(a.id, b.id));
        const e = addEntity(s, makePoint(0, -10));
        const f = addEntity(s, makePoint(0,  10));
        addEntity(s, makeLine(e.id, f.id));
        const hits = findIntersections(s, C.id);
        assert.equal(hits.length, 4);
    });
});

// ── trimSegments ───────────────────────────────────────────────────────────
suite('trimSegments', () => {
    test('line with two cross lines: clicking middle segment leaves two end segments', () => {
        const s = makeSketchData(stockPlane('XY'));
        const a = addEntity(s, makePoint(0, 0));
        const b = addEntity(s, makePoint(10, 0));
        const L = addEntity(s, makeLine(a.id, b.id));
        // Cross at x=3 and x=7
        const c1 = addEntity(s, makePoint(3, -5));
        const c2 = addEntity(s, makePoint(3,  5));
        addEntity(s, makeLine(c1.id, c2.id));
        const d1 = addEntity(s, makePoint(7, -5));
        const d2 = addEntity(s, makePoint(7,  5));
        addEntity(s, makeLine(d1.id, d2.id));
        // Click at x=5 (middle segment)
        const segs = trimSegments(s, L.id, { x: 5, y: 0 });
        assert.equal(segs.length, 2);
        // [0, 0.3] and [0.7, 1] should remain
        assert.ok(near(segs[0].from, 0));
        assert.ok(near(segs[0].to,   0.3));
        assert.ok(near(segs[1].from, 0.7));
        assert.ok(near(segs[1].to,   1));
    });

    test('line with no intersections returns empty (delete whole entity)', () => {
        const s = makeSketchData(stockPlane('XY'));
        const a = addEntity(s, makePoint(0, 0));
        const b = addEntity(s, makePoint(10, 0));
        const L = addEntity(s, makeLine(a.id, b.id));
        const segs = trimSegments(s, L.id, { x: 5, y: 0 });
        assert.deepEqual(segs, []);
    });

    test('click off the line returns null', () => {
        const s = makeSketchData(stockPlane('XY'));
        const a = addEntity(s, makePoint(0, 0));
        const b = addEntity(s, makePoint(10, 0));
        const L = addEntity(s, makeLine(a.id, b.id));
        // Click at parameter 2 — past the end
        const segs = trimSegments(s, L.id, { x: 30, y: 0 });
        assert.equal(segs, null);
    });

    test('circle with two chord intersections — clicking the +X arc keeps the -X arc', () => {
        const s = makeSketchData(stockPlane('XY'));
        const cc = addEntity(s, makePoint(0, 0));
        const C  = addEntity(s, makeCircle(cc.id, 5));
        // Vertical chord at x = 0 cuts the circle at (0, ±5)
        const a = addEntity(s, makePoint(0, -10));
        const b = addEntity(s, makePoint(0,  10));
        addEntity(s, makeLine(a.id, b.id));
        // Click on the +X rim at (5, 0)
        const segs = trimSegments(s, C.id, { x: 5, y: 0 }, { tol: 0.5 });
        assert.ok(segs);
        assert.equal(segs.length, 1);   // one surviving arc
    });

    test('arc with no intersections returns empty', () => {
        const s = makeSketchData(stockPlane('XY'));
        const c = addEntity(s, makePoint(0, 0));
        const A = addEntity(s, makeArc(c.id, 5, 0, Math.PI));
        const segs = trimSegments(s, A.id, { x: 0, y: 5 });
        assert.deepEqual(segs, []);
    });
});

// ── trimEntity ─────────────────────────────────────────────────────────────
suite('trimEntity', () => {
    test('trimming a line at the middle replaces it with two shorter lines', () => {
        const s = makeSketchData(stockPlane('XY'));
        const a = addEntity(s, makePoint(0, 0));
        const b = addEntity(s, makePoint(10, 0));
        const L = addEntity(s, makeLine(a.id, b.id));
        const c1 = addEntity(s, makePoint(3, -5));
        const c2 = addEntity(s, makePoint(3,  5));
        addEntity(s, makeLine(c1.id, c2.id));
        const d1 = addEntity(s, makePoint(7, -5));
        const d2 = addEntity(s, makePoint(7,  5));
        addEntity(s, makeLine(d1.id, d2.id));
        const newIds = trimEntity(s, L.id, { x: 5, y: 0 });
        assert.equal(newIds.length, 2);
        // Original line removed
        assert.equal(!!s.entities[L.id], false);
        // The two replacement lines exist
        for (const id of newIds) assert.ok(s.entities[id]);
    });

    test('clicking a line with no intersections deletes the entire line', () => {
        const s = makeSketchData(stockPlane('XY'));
        const a = addEntity(s, makePoint(0, 0));
        const b = addEntity(s, makePoint(10, 0));
        const L = addEntity(s, makeLine(a.id, b.id));
        const ids = trimEntity(s, L.id, { x: 5, y: 0 });
        assert.deepEqual(ids, []);
        assert.equal(!!s.entities[L.id], false);
    });

    test('trimming a circle at one rim replaces it with an arc', () => {
        const s = makeSketchData(stockPlane('XY'));
        const cc = addEntity(s, makePoint(0, 0));
        const C  = addEntity(s, makeCircle(cc.id, 5));
        const a = addEntity(s, makePoint(0, -10));
        const b = addEntity(s, makePoint(0,  10));
        addEntity(s, makeLine(a.id, b.id));
        const newIds = trimEntity(s, C.id, { x: 5, y: 0 }, { tol: 0.5 });
        assert.equal(newIds.length, 1);
        const arc = s.entities[newIds[0]];
        assert.equal(arc.kind, ENTITY_KIND.ARC);
        assert.ok(near(arc.params.radius, 5));
    });

    test('clicking off the entity returns null', () => {
        const s = makeSketchData(stockPlane('XY'));
        const a = addEntity(s, makePoint(0, 0));
        const b = addEntity(s, makePoint(10, 0));
        const L = addEntity(s, makeLine(a.id, b.id));
        const r = trimEntity(s, L.id, { x: 30, y: 0 });
        assert.equal(r, null);
        // Line untouched
        assert.ok(s.entities[L.id]);
    });
});

// ── trimTool3D ─────────────────────────────────────────────────────────────
function stubEd() {
    const sketch = makeSketchData(stockPlane('XY'));
    const state = { selected: [], hover: null, dirty: 0, lastToast: null, preview: null };
    const renderer = {
        getSelection() { return state.selected.slice(); },
        setSelection(ids) { state.selected = ids.slice(); },
        setHover(id) { state.hover = id; },
        setSnap() {}, setPreview(o) { state.preview = o; },
        previewLine() { return {}; }, previewRect() { return {}; }, previewCircle() { return {}; }, previewPolygon() { return {}; },
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
        _state: state,
    };
}

function ev(button = 0) { return { button, shiftKey: false }; }
function ctx(ed, local) {
    return {
        local, world: [0, 0, 0],
        snap: { kind: SNAP_KINDS.GRID, point: local },
        event: ev(), sketch: ed.sketchData, renderer: ed.renderer,
    };
}

suite('trimTool3D', () => {
    test('clicking on a line with intersections splits + deletes the clicked segment', () => {
        const ed = stubEd();
        const a = addEntity(ed.sketchData, makePoint(0, 0));
        const b = addEntity(ed.sketchData, makePoint(10, 0));
        const L = addEntity(ed.sketchData, makeLine(a.id, b.id));
        // Cross at x = 3 and x = 7
        const c1 = addEntity(ed.sketchData, makePoint(3, -5));
        const c2 = addEntity(ed.sketchData, makePoint(3,  5));
        addEntity(ed.sketchData, makeLine(c1.id, c2.id));
        const d1 = addEntity(ed.sketchData, makePoint(7, -5));
        const d2 = addEntity(ed.sketchData, makePoint(7,  5));
        addEntity(ed.sketchData, makeLine(d1.id, d2.id));
        const tool = trimTool3D(); tool._editor = ed; tool.activate();
        tool.onPointerDown(ctx(ed, { x: 5, y: 0 }));
        // Original line gone; two replacement lines should exist
        assert.equal(!!ed.sketchData.entities[L.id], false);
        const lines = Object.values(ed.sketchData.entities).filter(e => e.kind === ENTITY_KIND.LINE);
        // Lines: 2 cross lines + 2 trimmed pieces = 4
        assert.equal(lines.length, 4);
        assert.equal(ed._state.dirty, 1);
    });

    test('clicking on a lone line deletes the whole line', () => {
        const ed = stubEd();
        const a = addEntity(ed.sketchData, makePoint(0, 0));
        const b = addEntity(ed.sketchData, makePoint(10, 0));
        const L = addEntity(ed.sketchData, makeLine(a.id, b.id));
        const tool = trimTool3D(); tool._editor = ed; tool.activate();
        tool.onPointerDown(ctx(ed, { x: 5, y: 0 }));
        assert.equal(!!ed.sketchData.entities[L.id], false);
        assert.equal(ed._state.dirty, 1);
    });

    test('clicking nothing is a no-op (no toast spam, no dirty)', () => {
        const ed = stubEd();
        addEntity(ed.sketchData, makePoint(0, 0));   // far from cursor
        const tool = trimTool3D(); tool._editor = ed; tool.activate();
        tool.onPointerDown(ctx(ed, { x: 50, y: 50 }));
        assert.equal(ed._state.dirty, 0);
    });
});

runAll();
