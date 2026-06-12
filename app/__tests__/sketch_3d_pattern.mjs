/**
 * Tests for the sketch pattern module (lib/sketch/sketch_pattern.js) and
 * the matching tools (linearPatternTool3D, circularPatternTool3D).
 *
 * Run via:  node app/__tests__/sketch_3d_pattern.mjs
 */

import assert from 'node:assert/strict';
import { linearPattern, circularPattern } from '../../lib/sketch/sketch_pattern.js';
import { linearPatternTool3D, circularPatternTool3D } from '../sketch_3d/tools_3d.js';
import { SNAP_KINDS } from '../sketch_3d/snap_3d.js';
import {
    makeSketchData, stockPlane, addEntity,
} from '../../lib/sketch/sketch_data.js';
import {
    ENTITY_KIND, makePoint, makeLine, makeCircle, makeArc, makeRectangle, makePolygon,
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

// ── linearPattern › math ─────────────────────────────────────────────────────
suite('linearPattern › math', () => {
    test('replicates a single Point along +X', () => {
        const s = makeSketchData(stockPlane('XY'));
        const p = addEntity(s, makePoint(0, 0));
        const r = linearPattern(s, [p.id], { direction: { x: 1, y: 0 }, count: 3, spacing: 5 });
        assert.ok(r);
        assert.equal(r.copies, 2);
        assert.equal(r.newIds.length, 2);
        // Copy 1 at (5, 0); copy 2 at (10, 0)
        const c1 = s.entities[r.newIds[0]];
        const c2 = s.entities[r.newIds[1]];
        assert.ok(near(c1.params.x, 5));
        assert.ok(near(c2.params.x, 10));
    });

    test('non-unit direction vectors are normalised', () => {
        const s = makeSketchData(stockPlane('XY'));
        const p = addEntity(s, makePoint(0, 0));
        // Direction (3, 4) has length 5 — copies should still be 5 mm apart
        const r = linearPattern(s, [p.id], { direction: { x: 3, y: 4 }, count: 2, spacing: 5 });
        const c1 = s.entities[r.newIds[0]];
        // Copy 1: (0,0) + 1 * 5 * (3/5, 4/5) = (3, 4)
        assert.ok(near(c1.params.x, 3));
        assert.ok(near(c1.params.y, 4));
    });

    test('replicates a Line by translating each endpoint independently', () => {
        const s = makeSketchData(stockPlane('XY'));
        const a = addEntity(s, makePoint(0, 0));
        const b = addEntity(s, makePoint(2, 0));
        const L = addEntity(s, makeLine(a.id, b.id));
        const r = linearPattern(s, [L.id], { direction: { x: 0, y: 1 }, count: 3, spacing: 4 });
        assert.equal(r.newIds.length, 2);
        const l1 = s.entities[r.newIds[0]];
        assert.equal(l1.kind, ENTITY_KIND.LINE);
        const l1a = s.entities[l1.params.startId];
        const l1b = s.entities[l1.params.endId];
        assert.ok(near(l1a.params.x, 0)); assert.ok(near(l1a.params.y, 4));
        assert.ok(near(l1b.params.x, 2)); assert.ok(near(l1b.params.y, 4));
    });

    test('two lines sharing a vertex stay joined within each copy', () => {
        // L1: (0,0)→(2,0)   L2: (2,0)→(2,2)   share the (2,0) point
        const s = makeSketchData(stockPlane('XY'));
        const a = addEntity(s, makePoint(0, 0));
        const b = addEntity(s, makePoint(2, 0));
        const c = addEntity(s, makePoint(2, 2));
        const L1 = addEntity(s, makeLine(a.id, b.id));
        const L2 = addEntity(s, makeLine(b.id, c.id));
        const r = linearPattern(s, [L1.id, L2.id], {
            direction: { x: 1, y: 0 }, count: 2, spacing: 5,
        });
        // Two new lines for one extra copy
        assert.equal(r.newIds.length, 2);
        const c_L1 = s.entities[r.newIds[0]];
        const c_L2 = s.entities[r.newIds[1]];
        // Copy of L1's end must equal copy of L2's start — same id
        assert.equal(c_L1.params.endId, c_L2.params.startId);
    });

    test('originals are NOT moved — pattern is additive', () => {
        const s = makeSketchData(stockPlane('XY'));
        const p = addEntity(s, makePoint(0, 0));
        linearPattern(s, [p.id], { direction: { x: 1, y: 0 }, count: 3, spacing: 10 });
        // Original p still at (0, 0)
        assert.ok(near(s.entities[p.id].params.x, 0));
        assert.ok(near(s.entities[p.id].params.y, 0));
    });

    test('Circle: centre translates, radius unchanged', () => {
        const s = makeSketchData(stockPlane('XY'));
        const c = addEntity(s, makePoint(0, 0));
        const C = addEntity(s, makeCircle(c.id, 2));
        const r = linearPattern(s, [C.id], { direction: { x: 1, y: 0 }, count: 2, spacing: 8 });
        const nc = s.entities[r.newIds[0]];
        assert.equal(nc.kind, ENTITY_KIND.CIRCLE);
        assert.ok(near(nc.params.radius, 2));
        const nc_p = s.entities[nc.params.centerId];
        assert.ok(near(nc_p.params.x, 8));
        assert.ok(near(nc_p.params.y, 0));
    });

    test('Arc: centre translates; angles/sweep unchanged', () => {
        const s = makeSketchData(stockPlane('XY'));
        const c = addEntity(s, makePoint(0, 0));
        const A = addEntity(s, makeArc(c.id, 1, Math.PI / 4, Math.PI / 2));
        const r = linearPattern(s, [A.id], { direction: { x: 1, y: 0 }, count: 2, spacing: 5 });
        const na = s.entities[r.newIds[0]];
        assert.equal(na.kind, ENTITY_KIND.ARC);
        assert.ok(near(na.params.radius, 1));
        assert.ok(near(na.params.startAngle, Math.PI / 4));
        assert.ok(near(na.params.sweepAngle, Math.PI / 2));
    });

    test('Rectangle: corners translate — both supported in linear pattern', () => {
        const s = makeSketchData(stockPlane('XY'));
        const a = addEntity(s, makePoint(0, 0));
        const b = addEntity(s, makePoint(2, 2));
        const R = addEntity(s, makeRectangle(a.id, b.id));
        const r = linearPattern(s, [R.id], { direction: { x: 1, y: 0 }, count: 2, spacing: 5 });
        const nr = s.entities[r.newIds[0]];
        assert.equal(nr.kind, ENTITY_KIND.RECTANGLE);
        const corn1 = s.entities[nr.params.cornerStartId];
        const corn2 = s.entities[nr.params.cornerEndId];
        assert.ok(near(corn1.params.x, 5));
        assert.ok(near(corn2.params.x, 7));
    });

    test('Polygon: centre translates; rotation unchanged', () => {
        const s = makeSketchData(stockPlane('XY'));
        const c = addEntity(s, makePoint(0, 0));
        const P = addEntity(s, makePolygon(c.id, 1, 6, { rotation: 0.3 }));
        const r = linearPattern(s, [P.id], { direction: { x: 1, y: 0 }, count: 2, spacing: 5 });
        const np = s.entities[r.newIds[0]];
        assert.equal(np.kind, ENTITY_KIND.POLYGON);
        assert.ok(near(np.params.rotation, 0.3));
        const nc = s.entities[np.params.centerId];
        assert.ok(near(nc.params.x, 5));
    });
});

// ── linearPattern › validation ──────────────────────────────────────────────
suite('linearPattern › validation', () => {
    test('zero-length direction returns null', () => {
        const s = makeSketchData(stockPlane('XY'));
        const p = addEntity(s, makePoint(0, 0));
        assert.equal(linearPattern(s, [p.id], { direction: { x: 0, y: 0 }, count: 2, spacing: 1 }), null);
    });

    test('count < 2 returns null', () => {
        const s = makeSketchData(stockPlane('XY'));
        const p = addEntity(s, makePoint(0, 0));
        assert.equal(linearPattern(s, [p.id], { direction: { x: 1, y: 0 }, count: 1, spacing: 1 }), null);
    });

    test('non-positive spacing returns null', () => {
        const s = makeSketchData(stockPlane('XY'));
        const p = addEntity(s, makePoint(0, 0));
        assert.equal(linearPattern(s, [p.id], { direction: { x: 1, y: 0 }, count: 2, spacing: 0 }), null);
        assert.equal(linearPattern(s, [p.id], { direction: { x: 1, y: 0 }, count: 2, spacing: -3 }), null);
    });

    test('non-integer count returns null', () => {
        const s = makeSketchData(stockPlane('XY'));
        const p = addEntity(s, makePoint(0, 0));
        assert.equal(linearPattern(s, [p.id], { direction: { x: 1, y: 0 }, count: 2.5, spacing: 5 }), null);
    });

    test('missing entity ids show up in `skipped`', () => {
        const s = makeSketchData(stockPlane('XY'));
        const r = linearPattern(s, ['nope'], { direction: { x: 1, y: 0 }, count: 2, spacing: 5 });
        assert.deepEqual(r.skipped, ['nope']);
        assert.equal(r.newIds.length, 0);
    });
});

// ── circularPattern › math ──────────────────────────────────────────────────
suite('circularPattern › math', () => {
    test('three points at 120° around the origin form an equilateral triangle', () => {
        const s = makeSketchData(stockPlane('XY'));
        const p = addEntity(s, makePoint(1, 0));  // on +X axis at radius 1
        const r = circularPattern(s, [p.id], {
            centre: { x: 0, y: 0 },
            count: 3,
            stepAngle: 2 * Math.PI / 3,   // 120°
        });
        assert.equal(r.newIds.length, 2);
        const c1 = s.entities[r.newIds[0]];
        const c2 = s.entities[r.newIds[1]];
        // Copy 1: rotated 120° → (cos120, sin120) = (-0.5,  √3/2)
        assert.ok(near(c1.params.x, -0.5,           1e-6));
        assert.ok(near(c1.params.y,  Math.sqrt(3)/2, 1e-6));
        // Copy 2: rotated 240° → (-0.5, -√3/2)
        assert.ok(near(c2.params.x, -0.5,            1e-6));
        assert.ok(near(c2.params.y, -Math.sqrt(3)/2, 1e-6));
    });

    test('a non-origin centre still gives correct rotated copies', () => {
        const s = makeSketchData(stockPlane('XY'));
        const p = addEntity(s, makePoint(7, 5));   // relative to centre (5, 5): (2, 0)
        const r = circularPattern(s, [p.id], {
            centre: { x: 5, y: 5 },
            count: 2,
            stepAngle: Math.PI / 2,                // 90°
        });
        const c = s.entities[r.newIds[0]];
        // After 90° CCW around (5,5): the point (5+2, 5) → (5, 5+2) = (5, 7)
        assert.ok(near(c.params.x, 5, 1e-6));
        assert.ok(near(c.params.y, 7, 1e-6));
    });

    test('Arc rotates: centre rotates, startAngle += stepAngle, sweep unchanged', () => {
        const s = makeSketchData(stockPlane('XY'));
        const c = addEntity(s, makePoint(2, 0));
        const A = addEntity(s, makeArc(c.id, 1, 0, Math.PI / 2));
        const r = circularPattern(s, [A.id], {
            centre: { x: 0, y: 0 },
            count: 2,
            stepAngle: Math.PI / 2,
        });
        const na = s.entities[r.newIds[0]];
        const ncP = s.entities[na.params.centerId];
        // Original arc centre at (2, 0) → rotated 90° → (0, 2)
        assert.ok(near(ncP.params.x, 0, 1e-6));
        assert.ok(near(ncP.params.y, 2, 1e-6));
        // startAngle bumped by 90°; sweep unchanged
        assert.ok(near(na.params.startAngle, Math.PI / 2));
        assert.ok(near(na.params.sweepAngle, Math.PI / 2));
        // radius preserved
        assert.ok(near(na.params.radius, 1));
    });

    test('Polygon: centre rotates and rotation field += stepAngle', () => {
        const s = makeSketchData(stockPlane('XY'));
        const c = addEntity(s, makePoint(1, 0));
        const P = addEntity(s, makePolygon(c.id, 1, 6, { rotation: 0.2 }));
        const r = circularPattern(s, [P.id], {
            centre: { x: 0, y: 0 },
            count: 2,
            stepAngle: Math.PI / 2,
        });
        const np = s.entities[r.newIds[0]];
        const ncP = s.entities[np.params.centerId];
        assert.ok(near(ncP.params.x, 0, 1e-6));
        assert.ok(near(ncP.params.y, 1, 1e-6));
        assert.ok(near(np.params.rotation, 0.2 + Math.PI / 2));
    });

    test('Rectangle is skipped (axis-aligned constraint breaks under rotation)', () => {
        const s = makeSketchData(stockPlane('XY'));
        const a = addEntity(s, makePoint(0, 0));
        const b = addEntity(s, makePoint(2, 2));
        const R = addEntity(s, makeRectangle(a.id, b.id));
        const r = circularPattern(s, [R.id], {
            centre: { x: 0, y: 0 }, count: 2, stepAngle: Math.PI / 2,
        });
        assert.deepEqual(r.skipped, [R.id]);
        assert.equal(r.newIds.length, 0);
    });

    test('copies = count - 1 (original is preserved, copies are new)', () => {
        const s = makeSketchData(stockPlane('XY'));
        const p = addEntity(s, makePoint(1, 0));
        const r = circularPattern(s, [p.id], {
            centre: { x: 0, y: 0 }, count: 8, stepAngle: Math.PI / 4,
        });
        assert.equal(r.copies, 7);
        assert.equal(r.newIds.length, 7);
    });
});

// ── circularPattern › validation ────────────────────────────────────────────
suite('circularPattern › validation', () => {
    test('bad centre returns null', () => {
        const s = makeSketchData(stockPlane('XY'));
        const p = addEntity(s, makePoint(1, 0));
        assert.equal(circularPattern(s, [p.id], { centre: null,                   count: 2, stepAngle: 1 }), null);
        assert.equal(circularPattern(s, [p.id], { centre: { x: 0, y: NaN },        count: 2, stepAngle: 1 }), null);
    });

    test('count < 2 returns null', () => {
        const s = makeSketchData(stockPlane('XY'));
        const p = addEntity(s, makePoint(1, 0));
        assert.equal(circularPattern(s, [p.id], { centre: { x: 0, y: 0 }, count: 1, stepAngle: 1 }), null);
    });

    test('zero stepAngle returns null', () => {
        const s = makeSketchData(stockPlane('XY'));
        const p = addEntity(s, makePoint(1, 0));
        assert.equal(circularPattern(s, [p.id], { centre: { x: 0, y: 0 }, count: 2, stepAngle: 0 }), null);
    });
});

// ── Tool stubs ──────────────────────────────────────────────────────────────
function stubEd() {
    const sketch = makeSketchData(stockPlane('XY'));
    const state = {
        selected: [], hover: null, dirty: 0,
        lastToast: null,
        dimQueue: [],            // stack of pending dim inputs
        dimOpenCount: 0,
    };
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
        openDimInput({ current, unit, onCommit }) {
            state.dimOpenCount++;
            state.dimQueue.push({ current, unit, onCommit });
        },
        closeDimInput() {},
        _state: state,
        /** Helper: synthesize the user typing `value` into the most-recent dim input. */
        commitNextDim(value) {
            const next = state.dimQueue.shift();
            if (!next) throw new Error('No pending dim input');
            next.onCommit(value);
        },
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

// ── linearPatternTool3D ─────────────────────────────────────────────────────
suite('linearPatternTool3D', () => {
    test('pre-select + click direction line + commit count + commit spacing', () => {
        const ed = stubEd();
        // The thing to pattern: a Circle
        const cp = addEntity(ed.sketchData, makePoint(0, 0));
        const C  = addEntity(ed.sketchData, makeCircle(cp.id, 1));
        // The direction line: from (0,0) → (1,0)
        const da = addEntity(ed.sketchData, makePoint(0, 0));
        const db = addEntity(ed.sketchData, makePoint(1, 0));
        const Ld = addEntity(ed.sketchData, makeLine(da.id, db.id));
        ed.renderer.setSelection([C.id]);

        const tool = linearPatternTool3D(); tool._editor = ed; tool.activate();
        tool.onPointerDown(ctx(ed, { x: 0.5, y: 0 }));   // hit Ld
        // Count input first
        assert.equal(ed._state.dimOpenCount, 1);
        ed.commitNextDim(4);
        // Spacing input second
        assert.equal(ed._state.dimOpenCount, 2);
        ed.commitNextDim(10);

        // Expect 3 new circles (count - 1)
        const circles = Object.values(ed.sketchData.entities).filter(e => e.kind === ENTITY_KIND.CIRCLE);
        assert.equal(circles.length, 4);   // original + 3 copies
        assert.equal(ed._state.dirty, 1);
        assert.equal(ed._state.lastToast.kind, 'success');
    });

    test('clicking off any line shows an error and does not advance', () => {
        const ed = stubEd();
        const cp = addEntity(ed.sketchData, makePoint(0, 0));
        const C  = addEntity(ed.sketchData, makeCircle(cp.id, 1));
        ed.renderer.setSelection([C.id]);
        const tool = linearPatternTool3D(); tool._editor = ed; tool.activate();
        tool.onPointerDown(ctx(ed, { x: 50, y: 50 }));
        assert.equal(ed._state.lastToast.kind, 'error');
        assert.equal(ed._state.dimOpenCount, 0);
    });

    test('count of 2.7 is rounded; non-integer input is clamped to integer count', () => {
        const ed = stubEd();
        const cp = addEntity(ed.sketchData, makePoint(0, 0));
        const C  = addEntity(ed.sketchData, makeCircle(cp.id, 1));
        const da = addEntity(ed.sketchData, makePoint(0, 0));
        const db = addEntity(ed.sketchData, makePoint(1, 0));
        addEntity(ed.sketchData, makeLine(da.id, db.id));
        ed.renderer.setSelection([C.id]);
        const tool = linearPatternTool3D(); tool._editor = ed; tool.activate();
        tool.onPointerDown(ctx(ed, { x: 0.5, y: 0 }));
        ed.commitNextDim(2.7);            // → rounds to 3
        ed.commitNextDim(5);
        // 3 instances: original + 2 copies
        const circles = Object.values(ed.sketchData.entities).filter(e => e.kind === ENTITY_KIND.CIRCLE);
        assert.equal(circles.length, 3);
    });

    test('count below 2 is clamped to 2 (one copy at minimum)', () => {
        const ed = stubEd();
        const cp = addEntity(ed.sketchData, makePoint(0, 0));
        const C  = addEntity(ed.sketchData, makeCircle(cp.id, 1));
        const da = addEntity(ed.sketchData, makePoint(0, 0));
        const db = addEntity(ed.sketchData, makePoint(1, 0));
        addEntity(ed.sketchData, makeLine(da.id, db.id));
        ed.renderer.setSelection([C.id]);
        const tool = linearPatternTool3D(); tool._editor = ed; tool.activate();
        tool.onPointerDown(ctx(ed, { x: 0.5, y: 0 }));
        ed.commitNextDim(0);            // clamps to 2
        ed.commitNextDim(5);
        const circles = Object.values(ed.sketchData.entities).filter(e => e.kind === ENTITY_KIND.CIRCLE);
        assert.equal(circles.length, 2);   // original + 1 copy
    });

    test('empty selection blocks the commit with an error toast', () => {
        const ed = stubEd();
        const da = addEntity(ed.sketchData, makePoint(0, 0));
        const db = addEntity(ed.sketchData, makePoint(1, 0));
        addEntity(ed.sketchData, makeLine(da.id, db.id));
        ed.renderer.setSelection([]);
        const tool = linearPatternTool3D(); tool._editor = ed; tool.activate();
        tool.onPointerDown(ctx(ed, { x: 0.5, y: 0 }));
        assert.equal(ed._state.lastToast.kind, 'error');
        assert.equal(ed._state.dimOpenCount, 0);
    });
});

// ── circularPatternTool3D ───────────────────────────────────────────────────
suite('circularPatternTool3D', () => {
    test('pre-select + click point centre + count + step angle commits', () => {
        const ed = stubEd();
        const cp = addEntity(ed.sketchData, makePoint(2, 0));
        const C  = addEntity(ed.sketchData, makeCircle(cp.id, 0.5));
        const centre = addEntity(ed.sketchData, makePoint(0, 0));   // rotation centre
        ed.renderer.setSelection([C.id]);

        const tool = circularPatternTool3D(); tool._editor = ed; tool.activate();
        tool.onPointerDown(ctx(ed, { x: 0, y: 0 }));   // hit `centre`
        ed.commitNextDim(6);                              // count
        ed.commitNextDim(60);                             // 60° step

        // 6 instances → 5 copies + original = 6 circles total
        const circles = Object.values(ed.sketchData.entities).filter(e => e.kind === ENTITY_KIND.CIRCLE);
        assert.equal(circles.length, 6);
        assert.equal(ed._state.dirty, 1);
        assert.equal(ed._state.lastToast.kind, 'success');
    });

    test('clicking a Circle uses its centre as the rotation centre', () => {
        const ed = stubEd();
        // The selection: a small circle off to the side
        const sp = addEntity(ed.sketchData, makePoint(5, 0));
        const sC = addEntity(ed.sketchData, makeCircle(sp.id, 0.5));
        // The centre-providing Circle: at origin
        const cc = addEntity(ed.sketchData, makePoint(0, 0));
        const centreCircle = addEntity(ed.sketchData, makeCircle(cc.id, 1));
        ed.renderer.setSelection([sC.id]);

        const tool = circularPatternTool3D(); tool._editor = ed; tool.activate();
        tool.onPointerDown(ctx(ed, { x: 0, y: 0 }));   // hits the origin Circle
        ed.commitNextDim(4);
        ed.commitNextDim(90);   // 90°

        // Copy 1 of sp: rotated 90° around (0, 0) → (0, 5)
        // Find the new point at (0, 5)
        const pts = Object.values(ed.sketchData.entities)
            .filter(e => e.kind === ENTITY_KIND.POINT && near(e.params.x, 0, 1e-6) && near(e.params.y, 5, 1e-6));
        assert.ok(pts.length >= 1);
    });

    test('clicking off any valid centre shows error', () => {
        const ed = stubEd();
        const sp = addEntity(ed.sketchData, makePoint(5, 0));
        const sC = addEntity(ed.sketchData, makeCircle(sp.id, 0.5));
        ed.renderer.setSelection([sC.id]);
        const tool = circularPatternTool3D(); tool._editor = ed; tool.activate();
        tool.onPointerDown(ctx(ed, { x: 50, y: 50 }));
        assert.equal(ed._state.lastToast.kind, 'error');
        assert.equal(ed._state.dimOpenCount, 0);
    });

    test('Escape during step-angle input clears state cleanly', () => {
        const ed = stubEd();
        const sp = addEntity(ed.sketchData, makePoint(5, 0));
        const sC = addEntity(ed.sketchData, makeCircle(sp.id, 0.5));
        addEntity(ed.sketchData, makePoint(0, 0));
        ed.renderer.setSelection([sC.id]);
        const tool = circularPatternTool3D(); tool._editor = ed; tool.activate();
        tool.onPointerDown(ctx(ed, { x: 0, y: 0 }));
        ed.commitNextDim(4);
        // Now press Escape (would normally close the angle input)
        const handled = tool.onKeyDown({ key: 'Escape' });
        assert.equal(handled, true);
    });
});

await runAll();
