/**
 * Tests for the in-viewport sketcher's pure layers.
 *
 *   - plane.js     — basis math + 2D↔3D round-trips
 *   - snap_3d.js   — vertex / midpoint / intersection / ortho / angle / grid
 *   - tools_3d.js  — state machines (entity counts + auto-constraints)
 *
 * The DOM/Three.js-aware modules (renderer.js, camera_anim.js, controller.js)
 * are integration-verified.
 *
 * Run via:  node app/__tests__/sketch_3d.mjs
 */

import assert from 'node:assert/strict';
import {
    resolvePlane, localToWorld, worldToLocal, projectOnPlane, signedDistance,
    topDownCameraTarget, VEC,
} from '../sketch_3d/plane.js';
import {
    snap, inferConstraints, SNAP_KINDS,
} from '../sketch_3d/snap_3d.js';
import {
    lineTool3D, rectTool3D, circleTool3D, polygonTool3D,
} from '../sketch_3d/tools_3d.js';
import {
    makeSketchData, stockPlane, addEntity, entityCount, constraintCount,
} from '../../lib/sketch/sketch_data.js';
import { makePoint, makeLine } from '../../lib/sketch/entities.js';
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

const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;
function nearVec(a, b, tol = 1e-9) { for (let i = 0; i < 3; i++) if (!near(a[i], b[i], tol)) return false; return true; }

// ── plane.js ────────────────────────────────────────────────────────────────
suite('plane', () => {
    test('resolvePlane defaults to XY when planeRef is missing', () => {
        const p = resolvePlane(null);
        assert.deepEqual(p.normal, [0, 0, 1]);
    });

    test('XY / XZ / YZ stock planes carry the right normals', () => {
        assert.deepEqual(resolvePlane({ kind: 'stock', name: 'XY' }).normal, [0, 0, 1]);
        assert.deepEqual(resolvePlane({ kind: 'stock', name: 'XZ' }).normal, [0, -1, 0]);
        assert.deepEqual(resolvePlane({ kind: 'stock', name: 'YZ' }).normal, [1, 0, 0]);
    });

    test('localToWorld on XY: (3, 4) → (3, 4, 0)', () => {
        const p = resolvePlane({ kind: 'stock', name: 'XY' });
        assert.ok(nearVec(localToWorld({ x: 3, y: 4 }, p), [3, 4, 0]));
    });

    test('localToWorld on XZ: (3, 4) → (3, 0, 4)', () => {
        const p = resolvePlane({ kind: 'stock', name: 'XZ' });
        assert.ok(nearVec(localToWorld({ x: 3, y: 4 }, p), [3, 0, 4]));
    });

    test('worldToLocal is the inverse of localToWorld', () => {
        for (const name of ['XY', 'XZ', 'YZ']) {
            const p = resolvePlane({ kind: 'stock', name });
            const original = { x: 5, y: -2 };
            const world = localToWorld(original, p);
            const back  = worldToLocal(world, p);
            assert.ok(near(back.x, original.x, 1e-9));
            assert.ok(near(back.y, original.y, 1e-9));
        }
    });

    test('projectOnPlane drops off-plane points onto the plane', () => {
        const p = resolvePlane({ kind: 'stock', name: 'XY' });
        const out = projectOnPlane([5, 7, 99], p);
        assert.ok(nearVec(out, [5, 7, 0]));
    });

    test('signedDistance is positive on normal side', () => {
        const p = resolvePlane({ kind: 'stock', name: 'XY' });
        assert.equal(signedDistance([0, 0, 10], p),  10);
        assert.equal(signedDistance([0, 0, -3], p), -3);
    });

    test('topDownCameraTarget builds a position at distance × normal', () => {
        const p = resolvePlane({ kind: 'stock', name: 'XY' });
        const view = topDownCameraTarget(p, 100);
        assert.ok(nearVec(view.position, [0, 0, 100]));
        assert.ok(nearVec(view.target,   [0, 0, 0]));
        assert.ok(nearVec(view.up,       p.yAxis));
    });

    test('VEC helpers compose correctly', () => {
        assert.deepEqual(VEC.add([1, 2, 3], [4, 5, 6]), [5, 7, 9]);
        assert.deepEqual(VEC.sub([4, 5, 6], [1, 2, 3]), [3, 3, 3]);
        assert.deepEqual(VEC.scale([1, 2, 3], 2), [2, 4, 6]);
        assert.equal(VEC.dot([1, 2, 3], [4, -5, 6]), 4 - 10 + 18);
        assert.deepEqual(VEC.cross([1, 0, 0], [0, 1, 0]), [0, 0, 1]);
        assert.equal(VEC.length([3, 4, 0]), 5);
    });
});

// ── snap_3d.js ──────────────────────────────────────────────────────────────
suite('snap-3d', () => {
    function sketchWithPoints(coords) {
        const s = makeSketchData(stockPlane('XY'));
        const ids = coords.map(([x, y]) => addEntity(s, makePoint(x, y)).id);
        return { s, ids };
    }

    test('vertex snap wins when a point is in range', () => {
        const { s, ids } = sketchWithPoints([[5, 0]]);
        const r = snap({ x: 5.2, y: 0.1 }, s, { gridSize: 1, snapRadius: 1 });
        assert.equal(r.kind, SNAP_KINDS.VERTEX);
        assert.equal(r.extra.entityId, ids[0]);
        assert.deepEqual(r.point, { x: 5, y: 0 });
    });

    test('midpoint snap picks the midpoint of an existing Line', () => {
        const s = makeSketchData(stockPlane('XY'));
        const a = addEntity(s, makePoint(0, 0));
        const b = addEntity(s, makePoint(10, 0));
        addEntity(s, makeLine(a.id, b.id));
        const r = snap({ x: 5.2, y: 0.1 }, s, { gridSize: 1, snapRadius: 1 });
        assert.equal(r.kind, SNAP_KINDS.MIDPOINT);
        assert.ok(near(r.point.x, 5));
        assert.ok(near(r.point.y, 0));
    });

    test('intersection snap finds where two non-parallel lines cross', () => {
        // Lines deliberately chosen so the cursor is far from any midpoint:
        //   Line 1: (0, 0) → (10, 0)          midpoint (5, 0)
        //   Line 2: (3, -2) → (5, 4)          midpoint (4, 1)
        //   They cross Line 1 (y=0) at  x = 3 + (1/3)*2 = 11/3 ≈ 3.667
        const s = makeSketchData(stockPlane('XY'));
        const a1 = addEntity(s, makePoint(0, 0));
        const b1 = addEntity(s, makePoint(10, 0));
        addEntity(s, makeLine(a1.id, b1.id));
        const a2 = addEntity(s, makePoint(3, -2));
        const b2 = addEntity(s, makePoint(5,  4));
        addEntity(s, makeLine(a2.id, b2.id));
        // Cursor right on the intersection (~0.1 mm off); tight snapRadius so
        // the much-further midpoints can't win.
        const r = snap({ x: 3.7, y: 0.05 }, s, { gridSize: 0.01, snapRadius: 0.5 });
        assert.equal(r.kind, SNAP_KINDS.INTERSECT);
        assert.ok(near(r.point.x, 11 / 3, 1e-6));
        assert.ok(near(r.point.y, 0, 1e-6));
    });

    test('on-line snap is enabled only with an anchor', () => {
        const s = makeSketchData(stockPlane('XY'));
        const a = addEntity(s, makePoint(0, 0));
        const b = addEntity(s, makePoint(10, 0));
        addEntity(s, makeLine(a.id, b.id));
        // Without anchor — should NOT take on-line (too jumpy without context)
        const noAnchor = snap({ x: 3, y: 0.3 }, s, { gridSize: 1, snapRadius: 0.5 });
        assert.notEqual(noAnchor.kind, SNAP_KINDS.ON_LINE);
        // With anchor — on-line wins
        const withAnchor = snap({ x: 3, y: 0.3 }, s, {
            gridSize: 1, snapRadius: 0.5, anchor: { x: 3, y: -5 },
        });
        assert.equal(withAnchor.kind, SNAP_KINDS.ON_LINE);
        assert.ok(near(withAnchor.point.y, 0));
    });

    test('ortho snap locks H or V from the anchor', () => {
        const s = makeSketchData(stockPlane('XY'));
        const r = snap({ x: 10, y: 0.3 }, s, { gridSize: 1, anchor: { x: 0, y: 0 } });
        assert.equal(r.kind, SNAP_KINDS.ORTHO);
        assert.equal(r.extra.axis, 'h');
        assert.equal(r.point.y, 0);
    });

    test('angle snap locks the cursor to 45° from the anchor', () => {
        const s = makeSketchData(stockPlane('XY'));
        // Cursor at ~(10, 10.5) — close to 45° = (10, 10); within 3° tol
        const r = snap({ x: 10, y: 10.5 }, s, {
            gridSize: 1, anchor: { x: 0, y: 0 }, orthoTol: 0.01, angleTolDeg: 3,
        });
        assert.equal(r.kind, SNAP_KINDS.ANGLE);
        assert.equal(r.extra.angleDeg, 45);
    });

    test('grid snap is the fallback', () => {
        const s = makeSketchData(stockPlane('XY'));
        const r = snap({ x: 4.4, y: 7.6 }, s, { gridSize: 1 });
        assert.equal(r.kind, SNAP_KINDS.GRID);
        assert.deepEqual(r.point, { x: 4, y: 8 });
    });

    test('no-snap path when gridSize is 0 and nothing else hits', () => {
        const s = makeSketchData(stockPlane('XY'));
        const r = snap({ x: 4.4, y: 7.6 }, s, { gridSize: 0 });
        assert.equal(r.kind, SNAP_KINDS.NONE);
        assert.deepEqual(r.point, { x: 4.4, y: 7.6 });
    });

    test('vertex snap respects excludeId', () => {
        const { s, ids } = sketchWithPoints([[5, 0]]);
        const r = snap({ x: 5, y: 0 }, s, { gridSize: 1, snapRadius: 1, excludeId: ids[0] });
        assert.notEqual(r.kind, SNAP_KINDS.VERTEX);
    });
});

// ── inferConstraints ────────────────────────────────────────────────────────
suite('inferConstraints', () => {
    test('midpoint snap → midpoint constraint', () => {
        const out = inferConstraints(SNAP_KINDS.MIDPOINT, { lineId: 'L1' });
        assert.equal(out[0].kind, 'midpoint');
    });

    test('on-line snap → point-on-line constraint', () => {
        const out = inferConstraints(SNAP_KINDS.ON_LINE, { lineId: 'L1' });
        assert.equal(out[0].kind, 'point-on-line');
    });

    test('ortho axis h → horizontal constraint', () => {
        const out = inferConstraints(SNAP_KINDS.ORTHO, { axis: 'h' });
        assert.equal(out[0].kind, 'horizontal');
    });

    test('ortho axis v → vertical constraint', () => {
        const out = inferConstraints(SNAP_KINDS.ORTHO, { axis: 'v' });
        assert.equal(out[0].kind, 'vertical');
    });

    test('vertex/intersect/grid produce no auto-constraints', () => {
        assert.deepEqual(inferConstraints(SNAP_KINDS.VERTEX,     {}), []);
        assert.deepEqual(inferConstraints(SNAP_KINDS.INTERSECT,  {}), []);
        assert.deepEqual(inferConstraints(SNAP_KINDS.GRID,       {}), []);
    });
});

// ── Tool state machines (no canvas) ─────────────────────────────────────────

function makeStubEditor() {
    const sketch = makeSketchData(stockPlane('XY'));
    const renderer = {
        previewLine() { return {}; },
        previewRect() { return {}; },
        previewCircle() { return {}; },
        previewPolygon() { return {}; },
        setPreview() {},
        setSnap() {},
        render() {},
    };
    return {
        sketchData: sketch,
        polygonSides: 6,
        commitDirty() { this._dirty = (this._dirty || 0) + 1; },
        setDimReadout() {},
        renderer,
    };
}

function ctx(local, snap, sketch, renderer) {
    return { local, world: [0, 0, 0], snap, sketch, renderer, event: { button: 0 } };
}

suite('lineTool3D', () => {
    test('first click adds a Point and stores the anchor', () => {
        const ed = makeStubEditor();
        const tool = lineTool3D(); tool._editor = ed; tool.activate();
        const local = { x: 0, y: 0 };
        const snap = { kind: SNAP_KINDS.GRID, point: local };
        tool.onPointerDown(ctx(local, snap, ed.sketchData, ed.renderer));
        assert.equal(entityCount(ed.sketchData), 1);
    });

    test('second click adds a Point + Line; chain continues', () => {
        const ed = makeStubEditor();
        const tool = lineTool3D(); tool._editor = ed; tool.activate();
        const snap1 = { kind: SNAP_KINDS.GRID, point: { x: 0, y: 0 } };
        const snap2 = { kind: SNAP_KINDS.GRID, point: { x: 10, y: 0 } };
        tool.onPointerDown(ctx({x:0,y:0},  snap1, ed.sketchData, ed.renderer));
        tool.onPointerDown(ctx({x:10,y:0}, snap2, ed.sketchData, ed.renderer));
        // 2 points + 1 line
        assert.equal(entityCount(ed.sketchData), 3);
        assert.equal(ed._dirty, 1);
    });

    test('vertex snap on second click reuses the existing Point id', () => {
        const ed = makeStubEditor();
        const existing = addEntity(ed.sketchData, makePoint(10, 0));
        const tool = lineTool3D(); tool._editor = ed; tool.activate();
        const snap1 = { kind: SNAP_KINDS.GRID,   point: { x: 0, y: 0 } };
        const snap2 = { kind: SNAP_KINDS.VERTEX, point: { x: 10, y: 0 }, extra: { entityId: existing.id } };
        tool.onPointerDown(ctx({x:0,y:0},  snap1, ed.sketchData, ed.renderer));
        tool.onPointerDown(ctx({x:10,y:0}, snap2, ed.sketchData, ed.renderer));
        // No duplicate Point — existing reused; +1 new Point + 1 Line
        assert.equal(entityCount(ed.sketchData), 3);
    });

    test('ortho-snapped segment auto-adds a horizontal constraint', () => {
        const ed = makeStubEditor();
        const tool = lineTool3D(); tool._editor = ed; tool.activate();
        const snap1 = { kind: SNAP_KINDS.GRID, point: { x: 0, y: 0 } };
        const snap2 = { kind: SNAP_KINDS.ORTHO, point: { x: 10, y: 0 }, extra: { kind: 'ortho', axis: 'h' } };
        tool.onPointerDown(ctx({x:0,y:0},  snap1, ed.sketchData, ed.renderer));
        tool.onPointerDown(ctx({x:10,y:0}, snap2, ed.sketchData, ed.renderer));
        const cs = Object.values(ed.sketchData.constraints).map(c => c.kind);
        assert.ok(cs.includes(CONSTRAINT_KIND.HORIZONTAL));
    });

    test('midpoint-snapped Point auto-adds a midpoint constraint', () => {
        const ed = makeStubEditor();
        const a  = addEntity(ed.sketchData, makePoint(0, 0));
        const b  = addEntity(ed.sketchData, makePoint(10, 0));
        const L  = addEntity(ed.sketchData, makeLine(a.id, b.id));
        const tool = lineTool3D(); tool._editor = ed; tool.activate();
        const snap1 = { kind: SNAP_KINDS.MIDPOINT, point: { x: 5, y: 0 }, extra: { lineId: L.id } };
        tool.onPointerDown(ctx({x:5,y:0}, snap1, ed.sketchData, ed.renderer));
        const cs = Object.values(ed.sketchData.constraints).map(c => c.kind);
        assert.ok(cs.includes(CONSTRAINT_KIND.MIDPOINT));
    });

    test('Escape resets the in-progress chain', () => {
        const ed = makeStubEditor();
        const tool = lineTool3D(); tool._editor = ed; tool.activate();
        tool.onPointerDown(ctx({x:0,y:0}, { kind: SNAP_KINDS.GRID, point: { x: 0, y: 0 } }, ed.sketchData, ed.renderer));
        const handled = tool.onKeyDown({ key: 'Escape' });
        assert.equal(handled, true);
        // Next click drops a fresh Point, no Line
        tool.onPointerDown(ctx({x:5,y:5}, { kind: SNAP_KINDS.GRID, point: { x: 5, y: 5 } }, ed.sketchData, ed.renderer));
        assert.equal(entityCount(ed.sketchData), 2);
    });
});

suite('rectTool3D', () => {
    test('two clicks add 2 corner Points + 1 Rectangle', () => {
        const ed = makeStubEditor();
        const tool = rectTool3D(); tool._editor = ed; tool.activate();
        tool.onPointerDown(ctx({x:0,y:0},  { kind: SNAP_KINDS.GRID, point: { x: 0,  y: 0 } }, ed.sketchData, ed.renderer));
        tool.onPointerDown(ctx({x:10,y:5}, { kind: SNAP_KINDS.GRID, point: { x: 10, y: 5 } }, ed.sketchData, ed.renderer));
        assert.equal(entityCount(ed.sketchData), 3);
        assert.equal(ed._dirty, 1);
    });
});

suite('circleTool3D', () => {
    test('two clicks add a centre + Circle of dragged radius', () => {
        const ed = makeStubEditor();
        const tool = circleTool3D(); tool._editor = ed; tool.activate();
        tool.onPointerDown(ctx({x:0,y:0}, { kind: SNAP_KINDS.GRID, point: { x: 0, y: 0 } }, ed.sketchData, ed.renderer));
        tool.onPointerDown(ctx({x:5,y:0}, { kind: SNAP_KINDS.GRID, point: { x: 5, y: 0 } }, ed.sketchData, ed.renderer));
        const c = Object.values(ed.sketchData.entities).find(e => e.kind === 'circle');
        assert.ok(c);
        assert.ok(near(c.params.radius, 5));
    });
});

suite('polygonTool3D', () => {
    test('uses editor.polygonSides for the side count', () => {
        const ed = makeStubEditor();
        ed.polygonSides = 8;
        const tool = polygonTool3D(); tool._editor = ed; tool.activate();
        tool.onPointerDown(ctx({x:0,y:0},  { kind: SNAP_KINDS.GRID, point: { x: 0,  y: 0 } }, ed.sketchData, ed.renderer));
        tool.onPointerDown(ctx({x:10,y:0}, { kind: SNAP_KINDS.GRID, point: { x: 10, y: 0 } }, ed.sketchData, ed.renderer));
        const p = Object.values(ed.sketchData.entities).find(e => e.kind === 'polygon');
        assert.ok(p);
        assert.equal(p.params.sides, 8);
        assert.ok(near(p.params.radius, 10));
    });
});

runAll();
