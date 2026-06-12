/**
 * Tests for the editable-sketch additions:
 *   - hit_test_entities.js (pickEntity / pickPoint)
 *   - select tool          (hover, multi-select, Delete cascade)
 *   - dim tool              (state machine; HTML side is integration-tested)
 *   - controller re-edit    (loadFromFeature path)
 *
 * Run via:  node app/__tests__/sketch_3d_interact.mjs
 */

import assert from 'node:assert/strict';
import {
    pickEntity, pickEntities, pickPoint,
} from '../sketch_3d/hit_test_entities.js';
import {
    selectTool3D, dimTool3D,
} from '../sketch_3d/tools_3d.js';
import { SNAP_KINDS } from '../sketch_3d/snap_3d.js';
import {
    makeSketchData, stockPlane, addEntity, entityCount, constraintCount,
} from '../../lib/sketch/sketch_data.js';
import {
    makePoint, makeLine, makeCircle, makeRectangle, makePolygon,
} from '../../lib/sketch/entities.js';
import { CONSTRAINT_KIND } from '../../lib/sketch/constraints.js';
import {
    resetDocumentStore, getDocumentStore,
} from '../../lib/document/store.js';
import { addFeatureChange } from '../../lib/document/changelog.js';
import { makeSketchFeature } from '../../lib/sketch/feature.js';

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
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

// ── pickEntity ──────────────────────────────────────────────────────────────
suite('pickEntity', () => {
    test('picks a Point at the exact location', () => {
        const s = makeSketchData(stockPlane('XY'));
        const p = addEntity(s, makePoint(5, 5));
        const hit = pickEntity({ x: 5, y: 5 }, s, { tolerance: 1 });
        assert.equal(hit.id, p.id);
        assert.equal(hit.kind, 'point');
    });

    test('returns null when nothing is within tolerance', () => {
        const s = makeSketchData(stockPlane('XY'));
        addEntity(s, makePoint(0, 0));
        const hit = pickEntity({ x: 50, y: 50 }, s, { tolerance: 1 });
        assert.equal(hit, null);
    });

    test('picks a Line by perpendicular distance', () => {
        const s = makeSketchData(stockPlane('XY'));
        const a = addEntity(s, makePoint(0, 0));
        const b = addEntity(s, makePoint(10, 0));
        const L = addEntity(s, makeLine(a.id, b.id));
        // Cursor 0.3 mm above the line midpoint — should hit the Line, not the Points
        const hit = pickEntity({ x: 5, y: 0.3 }, s, { tolerance: 1 });
        assert.equal(hit.id, L.id);
    });

    test('picks a Circle by stroke distance', () => {
        const s = makeSketchData(stockPlane('XY'));
        const c = addEntity(s, makePoint(0, 0));
        const C = addEntity(s, makeCircle(c.id, 5));
        // 0.3 mm outside the rim
        const hit = pickEntity({ x: 5.3, y: 0 }, s, { tolerance: 1 });
        assert.equal(hit.id, C.id);
    });

    test('picks the closest entity when multiple are in range', () => {
        const s = makeSketchData(stockPlane('XY'));
        const a = addEntity(s, makePoint(0, 0));
        const b = addEntity(s, makePoint(10, 5));   // off the segment
        // A line on the X-axis so the cursor near (10, 5) is far from the line
        // but very close to point b — proves point picking beats line picking.
        const onAxis = addEntity(s, makePoint(20, 0));
        addEntity(s, makeLine(a.id, onAxis.id));
        const hit = pickEntity({ x: 10.05, y: 5.02 }, s, { tolerance: 1 });
        assert.equal(hit.id, b.id);
    });

    test('respects excludeId', () => {
        const s = makeSketchData(stockPlane('XY'));
        const p = addEntity(s, makePoint(0, 0));
        const hit = pickEntity({ x: 0, y: 0 }, s, { tolerance: 1, excludeId: p.id });
        assert.equal(hit, null);
    });

    test('respects filter predicate', () => {
        const s = makeSketchData(stockPlane('XY'));
        const p = addEntity(s, makePoint(0, 0));
        const c = addEntity(s, makePoint(10, 10));
        addEntity(s, makeCircle(c.id, 5));
        // With a points-only filter, never returns the circle
        const hit = pickEntity({ x: 5, y: 0 }, s, { tolerance: 10, filter: (e) => e.kind === 'point' });
        assert.equal(hit.id, p.id);
    });

    test('picks a Rectangle on its border', () => {
        const s = makeSketchData(stockPlane('XY'));
        const a = addEntity(s, makePoint(0, 0));
        const b = addEntity(s, makePoint(10, 5));
        const R = addEntity(s, makeRectangle(a.id, b.id));
        // Click on the top edge mid-span
        const hit = pickEntity({ x: 5, y: 5 }, s, { tolerance: 0.5 });
        assert.equal(hit.id, R.id);
    });

    test('picks a Polygon on its border', () => {
        const s = makeSketchData(stockPlane('XY'));
        const c = addEntity(s, makePoint(0, 0));
        const P = addEntity(s, makePolygon(c.id, 10, 6));
        // Vertex 0 at angle 0 lives at (10, 0)
        const hit = pickEntity({ x: 10, y: 0 }, s, { tolerance: 0.5 });
        assert.equal(hit.id, P.id);
    });
});

// ── pickPoint ───────────────────────────────────────────────────────────────
suite('pickPoint', () => {
    test('only matches Point entities', () => {
        const s = makeSketchData(stockPlane('XY'));
        const c = addEntity(s, makePoint(0, 0));
        addEntity(s, makeCircle(c.id, 5));
        // Cursor on the circle — pickEntity hits the Circle, pickPoint should miss
        const hitP = pickPoint({ x: 5, y: 0 }, s, { tolerance: 0.5 });
        assert.equal(hitP, null);
        const hitE = pickEntity({ x: 5, y: 0 }, s, { tolerance: 0.5 });
        assert.ok(hitE);
    });
});

// ── pickEntities ────────────────────────────────────────────────────────────
suite('pickEntities', () => {
    test('returns every entity within tolerance, sorted by distance', () => {
        const s = makeSketchData(stockPlane('XY'));
        const a = addEntity(s, makePoint(0, 0));
        const b = addEntity(s, makePoint(0.4, 0));
        const c = addEntity(s, makePoint(0.8, 0));
        const hits = pickEntities({ x: 0.1, y: 0 }, s, { tolerance: 1 });
        // Sorted: a (0.1), b (0.3), c (0.7)
        assert.equal(hits.length, 3);
        assert.equal(hits[0].id, a.id);
        assert.equal(hits[1].id, b.id);
        assert.equal(hits[2].id, c.id);
    });
});

// ── Select tool ─────────────────────────────────────────────────────────────
function makeStubEditor() {
    const sketch = makeSketchData(stockPlane('XY'));
    const state = { selected: [], hover: null, dirty: 0, dimReadout: null };
    const renderer = {
        getSelection() { return state.selected.slice(); },
        setSelection(ids) { state.selected = ids.slice(); },
        setHover(id)      { state.hover = id; },
        setPreview() {},
        setSnap() {},
        render() {},
        previewLine() { return {}; }, previewRect() { return {}; },
        previewCircle() { return {}; }, previewPolygon() { return {}; },
    };
    return {
        sketchData: sketch,
        polygonSides: 6,
        commitDirty() { state.dirty++; },
        setDimReadout(info) { state.dimReadout = info; },
        renderer,
        _screenToWorldDist: (px) => px / 12,    // pretend scale=12 px/mm
        _state: state,
        openDimInput({ onCommit }) { state.dimRequested = true; state.dimCommit = onCommit; },
        closeDimInput() {},
        toast(msg, kind) { state.lastToast = { msg, kind }; },
    };
}

function clickCtx(local, snap = null, button = 0, shiftKey = false) {
    return {
        local, world: [0, 0, 0],
        snap: snap || { kind: SNAP_KINDS.GRID, point: local },
        event: { button, shiftKey },
        sketch: null, renderer: null,
    };
}

suite('selectTool3D', () => {
    test('clicking an entity selects it', () => {
        const ed = makeStubEditor();
        const a = addEntity(ed.sketchData, makePoint(0, 0));
        const tool = selectTool3D(); tool._editor = ed; tool.activate();
        const c = clickCtx({ x: 0, y: 0 });
        c.sketch = ed.sketchData; c.renderer = ed.renderer;
        tool.onPointerDown(c);
        assert.deepEqual(ed.renderer.getSelection(), [a.id]);
    });

    test('clicking another entity replaces selection', () => {
        const ed = makeStubEditor();
        const a = addEntity(ed.sketchData, makePoint(0, 0));
        const b = addEntity(ed.sketchData, makePoint(10, 0));
        const tool = selectTool3D(); tool._editor = ed; tool.activate();
        const c1 = clickCtx({ x: 0, y: 0 });
        c1.sketch = ed.sketchData; c1.renderer = ed.renderer;
        tool.onPointerDown(c1);
        const c2 = clickCtx({ x: 10, y: 0 });
        c2.sketch = ed.sketchData; c2.renderer = ed.renderer;
        tool.onPointerDown(c2);
        assert.deepEqual(ed.renderer.getSelection(), [b.id]);
    });

    test('Shift-click adds without clearing', () => {
        const ed = makeStubEditor();
        const a = addEntity(ed.sketchData, makePoint(0, 0));
        const b = addEntity(ed.sketchData, makePoint(10, 0));
        const tool = selectTool3D(); tool._editor = ed; tool.activate();
        const c1 = clickCtx({ x: 0,  y: 0 });
        c1.sketch = ed.sketchData; c1.renderer = ed.renderer;
        tool.onPointerDown(c1);
        const c2 = clickCtx({ x: 10, y: 0 }, null, 0, true);
        c2.sketch = ed.sketchData; c2.renderer = ed.renderer;
        tool.onPointerDown(c2);
        assert.deepEqual(ed.renderer.getSelection().sort(), [a.id, b.id].sort());
    });

    test('Shift-clicking a selected entity removes it', () => {
        const ed = makeStubEditor();
        const a = addEntity(ed.sketchData, makePoint(0, 0));
        const b = addEntity(ed.sketchData, makePoint(10, 0));
        const tool = selectTool3D(); tool._editor = ed; tool.activate();
        // Select both then shift-click `a` again to deselect it
        const c1 = clickCtx({ x: 0,  y: 0 });
        c1.sketch = ed.sketchData; c1.renderer = ed.renderer;
        tool.onPointerDown(c1);
        const c2 = clickCtx({ x: 10, y: 0 }, null, 0, true);
        c2.sketch = ed.sketchData; c2.renderer = ed.renderer;
        tool.onPointerDown(c2);
        const c3 = clickCtx({ x: 0,  y: 0 }, null, 0, true);
        c3.sketch = ed.sketchData; c3.renderer = ed.renderer;
        tool.onPointerDown(c3);
        assert.deepEqual(ed.renderer.getSelection(), [b.id]);
    });

    test('clicking empty space clears selection (no Shift)', () => {
        const ed = makeStubEditor();
        const a = addEntity(ed.sketchData, makePoint(0, 0));
        const tool = selectTool3D(); tool._editor = ed; tool.activate();
        const c = clickCtx({ x: 0, y: 0 });
        c.sketch = ed.sketchData; c.renderer = ed.renderer;
        tool.onPointerDown(c);
        assert.deepEqual(ed.renderer.getSelection(), [a.id]);
        const empty = clickCtx({ x: 99, y: 99 });
        empty.sketch = ed.sketchData; empty.renderer = ed.renderer;
        tool.onPointerDown(empty);
        assert.deepEqual(ed.renderer.getSelection(), []);
    });

    test('hover updates as the cursor moves', () => {
        const ed = makeStubEditor();
        const a = addEntity(ed.sketchData, makePoint(0, 0));
        const tool = selectTool3D(); tool._editor = ed; tool.activate();
        tool.onPointerMove({ local: { x: 0, y: 0 }, sketch: ed.sketchData, renderer: ed.renderer });
        assert.equal(ed._state.hover, a.id);
        tool.onPointerMove({ local: { x: 99, y: 99 }, sketch: ed.sketchData, renderer: ed.renderer });
        assert.equal(ed._state.hover, null);
    });

    test('Delete key removes every selected entity (cascade)', () => {
        const ed = makeStubEditor();
        // Two points + a line that uses both. Selecting the line and deleting
        // should remove the line; selecting one of the endpoints should
        // cascade-remove the line (lib/sketch handles that).
        const a = addEntity(ed.sketchData, makePoint(0, 0));
        const b = addEntity(ed.sketchData, makePoint(10, 0));
        const L = addEntity(ed.sketchData, makeLine(a.id, b.id));
        const tool = selectTool3D(); tool._editor = ed; tool.activate();
        ed.renderer.setSelection([a.id]);
        const handled = tool.onKeyDown({ key: 'Delete' });
        assert.equal(handled, true);
        // After cascade: a is gone (deleted), L is gone (depended on a), b is still here.
        assert.equal(!!ed.sketchData.entities[a.id], false);
        assert.equal(!!ed.sketchData.entities[L.id], false);
        assert.equal(!!ed.sketchData.entities[b.id], true);
        // Selection is cleared and the editor was marked dirty
        assert.deepEqual(ed.renderer.getSelection(), []);
        assert.equal(ed._state.dirty, 1);
    });

    test('Escape clears hover + selection', () => {
        const ed = makeStubEditor();
        const a = addEntity(ed.sketchData, makePoint(0, 0));
        ed.renderer.setSelection([a.id]);
        ed.renderer.setHover(a.id);
        const tool = selectTool3D(); tool._editor = ed; tool.activate();
        const handled = tool.onKeyDown({ key: 'Escape' });
        assert.equal(handled, true);
        assert.deepEqual(ed.renderer.getSelection(), []);
        assert.equal(ed._state.hover, null);
    });

    test('right-click is ignored', () => {
        const ed = makeStubEditor();
        const a = addEntity(ed.sketchData, makePoint(0, 0));
        const tool = selectTool3D(); tool._editor = ed; tool.activate();
        const c = clickCtx({ x: 0, y: 0 }, null, 2);
        c.sketch = ed.sketchData; c.renderer = ed.renderer;
        tool.onPointerDown(c);
        assert.deepEqual(ed.renderer.getSelection(), []);
    });
});

// ── Dim tool ────────────────────────────────────────────────────────────────
suite('dimTool3D', () => {
    test('clicking a Circle opens the dim input with its current radius', () => {
        const ed = makeStubEditor();
        const c = addEntity(ed.sketchData, makePoint(0, 0));
        const C = addEntity(ed.sketchData, makeCircle(c.id, 5));
        const tool = dimTool3D(); tool._editor = ed; tool.activate();
        // Click on the rim
        const ctx = clickCtx({ x: 5, y: 0 }, { kind: SNAP_KINDS.GRID, point: { x: 5, y: 0 } });
        ctx.sketch = ed.sketchData; ctx.renderer = ed.renderer;
        tool.onPointerDown(ctx);
        assert.equal(ed._state.dimRequested, true);
        // Commit a new radius → constraint lands and dirty fires
        ed._state.dimCommit(12.5);
        const radii = Object.values(ed.sketchData.constraints).filter(k => k.kind === CONSTRAINT_KIND.FIXED_RADIUS);
        assert.equal(radii.length, 1);
        assert.equal(radii[0].value, 12.5);
        assert.equal(ed._state.dirty, 1);
    });

    test('clicking two Points commits a fixedDistance constraint', () => {
        const ed = makeStubEditor();
        const a = addEntity(ed.sketchData, makePoint(0, 0));
        const b = addEntity(ed.sketchData, makePoint(10, 0));
        const tool = dimTool3D(); tool._editor = ed; tool.activate();
        // First click — vertex snap on point a
        const c1 = clickCtx({ x: 0, y: 0 },
            { kind: SNAP_KINDS.VERTEX, point: { x: 0, y: 0 }, extra: { entityId: a.id } });
        c1.sketch = ed.sketchData; c1.renderer = ed.renderer;
        tool.onPointerDown(c1);
        assert.notEqual(ed._state.dimRequested, true);   // no input until 2 picks
        // Second click — vertex snap on point b
        const c2 = clickCtx({ x: 10, y: 0 },
            { kind: SNAP_KINDS.VERTEX, point: { x: 10, y: 0 }, extra: { entityId: b.id } });
        c2.sketch = ed.sketchData; c2.renderer = ed.renderer;
        tool.onPointerDown(c2);
        assert.equal(ed._state.dimRequested, true);
        ed._state.dimCommit(25);
        const dists = Object.values(ed.sketchData.constraints).filter(k => k.kind === CONSTRAINT_KIND.FIXED_DISTANCE);
        assert.equal(dists.length, 1);
        assert.equal(dists[0].value, 25);
    });

    test('clicking a Line opens dim input immediately (line length)', () => {
        const ed = makeStubEditor();
        const a = addEntity(ed.sketchData, makePoint(0, 0));
        const b = addEntity(ed.sketchData, makePoint(10, 0));
        const L = addEntity(ed.sketchData, makeLine(a.id, b.id));
        const tool = dimTool3D(); tool._editor = ed; tool.activate();
        const c = clickCtx({ x: 5, y: 0.1 }, { kind: SNAP_KINDS.GRID, point: { x: 5, y: 0.1 } });
        c.sketch = ed.sketchData; c.renderer = ed.renderer;
        tool.onPointerDown(c);
        assert.equal(ed._state.dimRequested, true);
        ed._state.dimCommit(40);
        const dists = Object.values(ed.sketchData.constraints).filter(k => k.kind === CONSTRAINT_KIND.FIXED_DISTANCE);
        assert.equal(dists.length, 1);
        assert.equal(dists[0].value, 40);
    });

    test('Escape clears the pending pick stack', () => {
        const ed = makeStubEditor();
        const a = addEntity(ed.sketchData, makePoint(0, 0));
        const b = addEntity(ed.sketchData, makePoint(10, 0));
        const tool = dimTool3D(); tool._editor = ed; tool.activate();
        const c1 = clickCtx({ x: 0, y: 0 },
            { kind: SNAP_KINDS.VERTEX, point: { x: 0, y: 0 }, extra: { entityId: a.id } });
        c1.sketch = ed.sketchData; c1.renderer = ed.renderer;
        tool.onPointerDown(c1);
        const handled = tool.onKeyDown({ key: 'Escape' });
        assert.equal(handled, true);
        // Next click drops a *fresh* first pick — i.e. no constraint emitted
        const c2 = clickCtx({ x: 10, y: 0 },
            { kind: SNAP_KINDS.VERTEX, point: { x: 10, y: 0 }, extra: { entityId: b.id } });
        c2.sketch = ed.sketchData; c2.renderer = ed.renderer;
        tool.onPointerDown(c2);
        assert.equal(constraintCount(ed.sketchData), 0);
    });
});

// ── Controller re-edit (loadFromFeature) ────────────────────────────────────
suite('controller.loadFromFeature', () => {
    test('seeds the editor from a stored Sketch feature', async () => {
        const store = resetDocumentStore();
        // Build a sketch with one rectangle and commit it as a feature
        const sk = makeSketchData(stockPlane('XZ'), { name: 'Bracket' });
        const a = addEntity(sk, makePoint(0, 0));
        const b = addEntity(sk, makePoint(20, 10));
        addEntity(sk, makeRectangle(a.id, b.id));
        store.commit(addFeatureChange(makeSketchFeature(sk)));

        // Import the controller — but pass a minimal stub viewport so its
        // constructor doesn't try to touch real Three.js objects.
        const { SketchModeController } = await import('../sketch_3d/controller.js');
        const stubViewport = {
            scene:    { add() {}, remove() {} },
            camera:   { position: { toArray() { return [0,0,0]; }, copy() {}, set() {} },
                        quaternion: { toArray() { return [0,0,0,1]; } },
                        up: { toArray() { return [0,1,0]; } } },
            renderer: { domElement: { addEventListener() {}, removeEventListener() {}, getBoundingClientRect() { return { left:0, top:0, width:1, height:1 }; }, style: {}, parentElement: null } },
            controls: null,
        };
        const ctrl = new SketchModeController({
            viewport: stubViewport,
            store,
            plane: 'XY',
        });
        ctrl.loadFromFeature(sk.id);
        assert.equal(ctrl.planeName, 'XZ');
        assert.equal(entityCount(ctrl.sketchData), 3);
        assert.equal(ctrl._editingExistingFeatureId, sk.id);
    });

    test('rejects non-sketch features', async () => {
        const store = resetDocumentStore();
        // Create something other than a sketch
        const { addBox } = await import('../../lib/document/operations.js');
        const box = addBox();
        const { SketchModeController } = await import('../sketch_3d/controller.js');
        const stubViewport = {
            scene: { add() {}, remove() {} },
            camera: { position: { toArray() { return [0,0,0]; } }, quaternion: { toArray() { return [0,0,0,1]; } }, up: { toArray() { return [0,1,0]; } } },
            renderer: { domElement: { addEventListener() {}, removeEventListener() {}, getBoundingClientRect() { return { left:0, top:0, width:1, height:1 }; }, style: {}, parentElement: null } },
            controls: null,
        };
        const ctrl = new SketchModeController({ viewport: stubViewport, store, plane: 'XY' });
        assert.throws(() => ctrl.loadFromFeature(box.id), /not a Sketch/);
    });
});

runAll();
