/**
 * Tests for the sketch mirror helpers (lib/sketch/sketch_mirror.js) and the
 * matching 3D tool (mirrorTool3D).
 *
 * Run via:  node app/__tests__/sketch_3d_mirror.mjs
 */

import assert from 'node:assert/strict';
import { reflectPoint, mirrorEntity, mirrorEntities } from '../../lib/sketch/sketch_mirror.js';
import { mirrorTool3D } from '../sketch_3d/tools_3d.js';
import { SNAP_KINDS } from '../sketch_3d/snap_3d.js';
import {
    makeSketchData, stockPlane, addEntity,
} from '../../lib/sketch/sketch_data.js';
import {
    ENTITY_KIND, makePoint, makeLine, makeCircle, makeArc, makeRectangle,
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

// Build a "vertical axis at x = 5" line for most tests.
function vertAxisAt(s, x = 5) {
    const a = addEntity(s, makePoint(x, -10));
    const b = addEntity(s, makePoint(x,  10));
    return addEntity(s, makeLine(a.id, b.id)).id;
}
function horAxisAt(s, y = 0) {
    const a = addEntity(s, makePoint(-10, y));
    const b = addEntity(s, makePoint( 10, y));
    return addEntity(s, makeLine(a.id, b.id)).id;
}

// ── reflectPoint ─────────────────────────────────────────────────────────────
suite('reflectPoint', () => {
    test('reflects across a vertical axis at x = 0 (negates x)', () => {
        const r = reflectPoint({ x: 3, y: 4 }, { x: 0, y: -1 }, { x: 0, y: 1 });
        assert.ok(near(r.x, -3));
        assert.ok(near(r.y,  4));
    });

    test('reflects across a horizontal axis at y = 0 (negates y)', () => {
        const r = reflectPoint({ x: 3, y: 4 }, { x: -1, y: 0 }, { x: 1, y: 0 });
        assert.ok(near(r.x, 3));
        assert.ok(near(r.y, -4));
    });

    test('reflects across the line y = x (swaps x and y)', () => {
        const r = reflectPoint({ x: 3, y: 7 }, { x: 0, y: 0 }, { x: 1, y: 1 });
        assert.ok(near(r.x, 7));
        assert.ok(near(r.y, 3));
    });

    test('a point on the axis maps to itself', () => {
        const r = reflectPoint({ x: 4, y: 4 }, { x: 0, y: 0 }, { x: 1, y: 1 });
        assert.ok(near(r.x, 4));
        assert.ok(near(r.y, 4));
    });

    test('degenerate axis (a == b) returns identity', () => {
        const r = reflectPoint({ x: 3, y: 4 }, { x: 1, y: 1 }, { x: 1, y: 1 });
        assert.equal(r.x, 3);
        assert.equal(r.y, 4);
    });
});

// ── mirrorEntities — single Point ────────────────────────────────────────────
suite('mirrorEntities › point', () => {
    test('reflects a point across a vertical axis', () => {
        const s = makeSketchData(stockPlane('XY'));
        const p = addEntity(s, makePoint(8, 3));
        const axis = vertAxisAt(s, 5);
        const r = mirrorEntities(s, [p.id], axis);
        assert.ok(r);
        assert.equal(r.newIds.length, 1);
        const np = s.entities[r.newIds[0]];
        assert.equal(np.kind, ENTITY_KIND.POINT);
        // Original at x=8, axis at x=5 → mirror at x=2
        assert.ok(near(np.params.x, 2));
        assert.ok(near(np.params.y, 3));
    });

    test('records the originalId → newId pair in pointMap', () => {
        const s = makeSketchData(stockPlane('XY'));
        const p = addEntity(s, makePoint(8, 3));
        const axis = vertAxisAt(s, 5);
        const r = mirrorEntities(s, [p.id], axis);
        assert.ok(r.pointMap[p.id]);
        assert.equal(r.pointMap[p.id], r.newIds[0]);
    });
});

// ── mirrorEntities — Line ────────────────────────────────────────────────────
suite('mirrorEntities › line', () => {
    test('mirrors a line by reflecting both endpoints', () => {
        const s = makeSketchData(stockPlane('XY'));
        const a = addEntity(s, makePoint(6, 0));
        const b = addEntity(s, makePoint(8, 4));
        const L = addEntity(s, makeLine(a.id, b.id));
        const axis = vertAxisAt(s, 5);
        const r = mirrorEntities(s, [L.id], axis);
        assert.equal(r.newIds.length, 1);
        const nl = s.entities[r.newIds[0]];
        assert.equal(nl.kind, ENTITY_KIND.LINE);
        const na = s.entities[nl.params.startId];
        const nb = s.entities[nl.params.endId];
        assert.ok(near(na.params.x, 4));   // 6 reflected over x=5 → 4
        assert.ok(near(na.params.y, 0));
        assert.ok(near(nb.params.x, 2));   // 8 → 2
        assert.ok(near(nb.params.y, 4));
    });

    test('two adjacent lines sharing a point produce mirrors that also share', () => {
        // L1: (6,0)→(8,4)   L2: (8,4)→(10,0)   they share the (8,4) point
        const s = makeSketchData(stockPlane('XY'));
        const a = addEntity(s, makePoint(6,  0));
        const b = addEntity(s, makePoint(8,  4));
        const c = addEntity(s, makePoint(10, 0));
        const L1 = addEntity(s, makeLine(a.id, b.id));
        const L2 = addEntity(s, makeLine(b.id, c.id));
        const axis = vertAxisAt(s, 5);
        const r = mirrorEntities(s, [L1.id, L2.id], axis);
        assert.equal(r.newIds.length, 2);
        const m1 = s.entities[r.newIds[0]];
        const m2 = s.entities[r.newIds[1]];
        // L1's end and L2's start should be the SAME mirrored point id
        assert.equal(m1.params.endId, m2.params.startId);
    });

    test('the mirrored Line preserves its construction flag', () => {
        const s = makeSketchData(stockPlane('XY'));
        const a = addEntity(s, makePoint(6, 0));
        const b = addEntity(s, makePoint(8, 4));
        const L = addEntity(s, makeLine(a.id, b.id, { construction: true }));
        const axis = vertAxisAt(s, 5);
        const r = mirrorEntities(s, [L.id], axis);
        const nl = s.entities[r.newIds[0]];
        assert.equal(nl.construction, true);
    });
});

// ── mirrorEntities — Circle ──────────────────────────────────────────────────
suite('mirrorEntities › circle', () => {
    test('mirrors a circle by reflecting its centre, same radius', () => {
        const s = makeSketchData(stockPlane('XY'));
        const c = addEntity(s, makePoint(8, 3));
        const C = addEntity(s, makeCircle(c.id, 2));
        const axis = vertAxisAt(s, 5);
        const r = mirrorEntities(s, [C.id], axis);
        const nc = s.entities[r.newIds[0]];
        assert.equal(nc.kind, ENTITY_KIND.CIRCLE);
        assert.ok(near(nc.params.radius, 2));
        const ncP = s.entities[nc.params.centerId];
        assert.ok(near(ncP.params.x, 2));
        assert.ok(near(ncP.params.y, 3));
    });
});

// ── mirrorEntities — Arc ─────────────────────────────────────────────────────
suite('mirrorEntities › arc', () => {
    test('reflecting an arc flips the sweep sign (winding reverses)', () => {
        // Arc centred at (8, 0), radius 2, sweeping CCW from 0° to 90°
        // (i.e. from (10, 0) up to (8, 2)).
        const s = makeSketchData(stockPlane('XY'));
        const c = addEntity(s, makePoint(8, 0));
        const A = addEntity(s, makeArc(c.id, 2, 0, Math.PI / 2));
        const axis = vertAxisAt(s, 5);   // vertical axis at x=5
        const r = mirrorEntities(s, [A.id], axis);
        const na = s.entities[r.newIds[0]];
        assert.equal(na.kind, ENTITY_KIND.ARC);
        assert.ok(near(na.params.radius, 2));
        // newSweep = -sweep (orientation flipped)
        assert.ok(near(na.params.sweepAngle, -Math.PI / 2));
        // newStart = 2φ - startAngle. φ (axis angle) for the vertical axis
        // built by vertAxisAt is +90° (pointing +Y), so 2φ = π. start was 0,
        // so newStart should be π.
        assert.ok(near(na.params.startAngle, Math.PI));
        const ncP = s.entities[na.params.centerId];
        assert.ok(near(ncP.params.x, 2));   // 8 → 2 across x=5
        assert.ok(near(ncP.params.y, 0));
    });

    test('the reflected arc traverses the reflected endpoints', () => {
        // Arc start point in world coords:
        //   start angle θ₀ = 0, centre (8,0), radius 2 → start = (10, 0)
        //   end   angle θ₁ = π/2 → end = (8, 2)
        // Reflected across x=5: start → (0, 0), end → (2, 2)
        const s = makeSketchData(stockPlane('XY'));
        const c = addEntity(s, makePoint(8, 0));
        const A = addEntity(s, makeArc(c.id, 2, 0, Math.PI / 2));
        const axis = vertAxisAt(s, 5);
        const r = mirrorEntities(s, [A.id], axis);
        const na = s.entities[r.newIds[0]];
        const ncP = s.entities[na.params.centerId];

        // Compute the new start point: centre + r * (cos start, sin start)
        const ns = na.params.startAngle;
        const sx = ncP.params.x + na.params.radius * Math.cos(ns);
        const sy = ncP.params.y + na.params.radius * Math.sin(ns);
        assert.ok(near(sx, 0, 1e-6));
        assert.ok(near(sy, 0, 1e-6));

        // New end at start + sweep
        const ne = na.params.startAngle + na.params.sweepAngle;
        const ex = ncP.params.x + na.params.radius * Math.cos(ne);
        const ey = ncP.params.y + na.params.radius * Math.sin(ne);
        assert.ok(near(ex, 2, 1e-6));
        assert.ok(near(ey, 2, 1e-6));
    });
});

// ── mirrorEntities — bulk + skipped kinds ───────────────────────────────────
suite('mirrorEntities › bulk + skips', () => {
    test('mixes Line + Circle + Arc into one mirror call', () => {
        const s = makeSketchData(stockPlane('XY'));
        const a = addEntity(s, makePoint(6, 0));
        const b = addEntity(s, makePoint(8, 4));
        const c = addEntity(s, makePoint(8, 3));
        const L = addEntity(s, makeLine(a.id, b.id));
        const C = addEntity(s, makeCircle(c.id, 1));
        const Ac = addEntity(s, makePoint(10, 0));
        const Arc = addEntity(s, makeArc(Ac.id, 2, 0, Math.PI));
        const axis = vertAxisAt(s, 5);
        const r = mirrorEntities(s, [L.id, C.id, Arc.id], axis);
        assert.equal(r.newIds.length, 3);
        assert.equal(r.skipped.length, 0);
        // Verify the kinds came back in the same order
        assert.equal(s.entities[r.newIds[0]].kind, ENTITY_KIND.LINE);
        assert.equal(s.entities[r.newIds[1]].kind, ENTITY_KIND.CIRCLE);
        assert.equal(s.entities[r.newIds[2]].kind, ENTITY_KIND.ARC);
    });

    test('the axis line itself is silently skipped if it appears in the selection', () => {
        const s = makeSketchData(stockPlane('XY'));
        const a = addEntity(s, makePoint(6, 0));
        const b = addEntity(s, makePoint(8, 4));
        const L = addEntity(s, makeLine(a.id, b.id));
        const axis = vertAxisAt(s, 5);
        const r = mirrorEntities(s, [L.id, axis], axis);
        assert.equal(r.newIds.length, 1);
        assert.equal(r.skipped.length, 1);
        assert.equal(r.skipped[0], axis);
    });

    test('Rectangle is skipped in v1 (not yet supported)', () => {
        const s = makeSketchData(stockPlane('XY'));
        const a = addEntity(s, makePoint(6, 0));
        const b = addEntity(s, makePoint(9, 3));
        const R = addEntity(s, makeRectangle(a.id, b.id));
        const axis = vertAxisAt(s, 5);
        const r = mirrorEntities(s, [R.id], axis);
        assert.equal(r.newIds.length, 0);
        assert.deepEqual(r.skipped, [R.id]);
    });

    test('missing entity ids show up in `skipped`', () => {
        const s = makeSketchData(stockPlane('XY'));
        const axis = vertAxisAt(s, 5);
        const r = mirrorEntities(s, ['does-not-exist'], axis);
        assert.equal(r.newIds.length, 0);
        assert.deepEqual(r.skipped, ['does-not-exist']);
    });
});

// ── mirrorEntities — bad axis ───────────────────────────────────────────────
suite('mirrorEntities › bad axis', () => {
    test('returns null when the axis id is not a Line', () => {
        const s = makeSketchData(stockPlane('XY'));
        const p = addEntity(s, makePoint(8, 3));
        const r = mirrorEntities(s, [p.id], p.id);   // point isn't a line
        assert.equal(r, null);
    });

    test('returns null when the axis is a zero-length line', () => {
        const s = makeSketchData(stockPlane('XY'));
        const a = addEntity(s, makePoint(0, 0));
        const b = addEntity(s, makePoint(0, 0));     // same point
        const Ax = addEntity(s, makeLine(a.id, b.id));
        const p = addEntity(s, makePoint(3, 4));
        const r = mirrorEntities(s, [p.id], Ax.id);
        assert.equal(r, null);
    });

    test('mirrorEntity convenience returns null when entityIds yield no mirror', () => {
        const s = makeSketchData(stockPlane('XY'));
        const a = addEntity(s, makePoint(6, 0));
        const b = addEntity(s, makePoint(9, 3));
        const R = addEntity(s, makeRectangle(a.id, b.id));
        const axis = vertAxisAt(s, 5);
        assert.equal(mirrorEntity(s, R.id, axis), null);  // skipped → null
    });
});

// ── mirrorEntity (single-entity convenience) ────────────────────────────────
suite('mirrorEntity', () => {
    test('returns the new entity id for a single supported entity', () => {
        const s = makeSketchData(stockPlane('XY'));
        const a = addEntity(s, makePoint(6, 0));
        const b = addEntity(s, makePoint(8, 4));
        const L = addEntity(s, makeLine(a.id, b.id));
        const axis = vertAxisAt(s, 5);
        const newId = mirrorEntity(s, L.id, axis);
        assert.ok(newId);
        assert.equal(s.entities[newId].kind, ENTITY_KIND.LINE);
    });
});

// ── Tool stub harness ───────────────────────────────────────────────────────
function stubEd() {
    const sketch = makeSketchData(stockPlane('XY'));
    const state = { selected: [], hover: null, dirty: 0, lastToast: null };
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

// ── mirrorTool3D ────────────────────────────────────────────────────────────
suite('mirrorTool3D', () => {
    test('pre-selecting a line + clicking an axis line commits a mirror', () => {
        const ed = stubEd();
        // The thing we want to mirror: a Line from (6, 0) to (8, 4)
        const a = addEntity(ed.sketchData, makePoint(6, 0));
        const b = addEntity(ed.sketchData, makePoint(8, 4));
        const L = addEntity(ed.sketchData, makeLine(a.id, b.id));
        // The axis: a vertical line at x=5
        const axisStart = addEntity(ed.sketchData, makePoint(5, -10));
        const axisEnd   = addEntity(ed.sketchData, makePoint(5,  10));
        const axisLine  = addEntity(ed.sketchData, makeLine(axisStart.id, axisEnd.id));
        ed.renderer.setSelection([L.id]);

        const tool = mirrorTool3D(); tool._editor = ed; tool.activate();
        // Click anywhere along the axis line
        tool.onPointerDown(ctx(ed, { x: 5, y: 0 }));

        // A new mirrored line should exist (Lines + axisLine = 2 originals + 1 mirror)
        const lines = Object.values(ed.sketchData.entities).filter(e => e.kind === ENTITY_KIND.LINE);
        assert.equal(lines.length, 3);
        // Selection should be the new mirrored entity
        assert.equal(ed.renderer.getSelection().length, 1);
        assert.notEqual(ed.renderer.getSelection()[0], L.id);
        assert.notEqual(ed.renderer.getSelection()[0], axisLine.id);
        // Toast and dirty bump
        assert.ok(ed._state.lastToast);
        assert.equal(ed._state.lastToast.kind, 'success');
        assert.equal(ed._state.dirty, 1);
    });

    test('clicking off any line shows an error toast and does nothing', () => {
        const ed = stubEd();
        const a = addEntity(ed.sketchData, makePoint(6, 0));
        const b = addEntity(ed.sketchData, makePoint(8, 4));
        const L = addEntity(ed.sketchData, makeLine(a.id, b.id));
        ed.renderer.setSelection([L.id]);

        const tool = mirrorTool3D(); tool._editor = ed; tool.activate();
        tool.onPointerDown(ctx(ed, { x: 100, y: 100 }));   // far from any line
        // Last toast should be the error
        assert.equal(ed._state.lastToast.kind, 'error');
        assert.equal(ed._state.dirty, 0);
    });

    test('clicking the axis with no selection shows an error', () => {
        const ed = stubEd();
        const axisStart = addEntity(ed.sketchData, makePoint(5, -10));
        const axisEnd   = addEntity(ed.sketchData, makePoint(5,  10));
        addEntity(ed.sketchData, makeLine(axisStart.id, axisEnd.id));
        ed.renderer.setSelection([]);   // nothing to mirror

        const tool = mirrorTool3D(); tool._editor = ed; tool.activate();
        tool.onPointerDown(ctx(ed, { x: 5, y: 0 }));
        assert.equal(ed._state.lastToast.kind, 'error');
        assert.equal(ed._state.dirty, 0);
    });

    test('activate with empty selection emits an info toast (not error)', () => {
        const ed = stubEd();
        const tool = mirrorTool3D(); tool._editor = ed; tool.activate();
        assert.ok(ed._state.lastToast);
        assert.equal(ed._state.lastToast.kind, 'info');
    });
});

await runAll();
