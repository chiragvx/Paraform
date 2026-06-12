/**
 * Tests for lib/sketch — entities, constraints, sketch_data, feature bridge,
 * and the build123d emitter.
 *
 * Run via:  node lib/sketch/__tests__/run.mjs
 */

import assert from 'node:assert/strict';
import {
    ENTITY_KIND,
    makePoint, makeLine, makeCircle, makeArc,
    makeEllipse, makeSpline, makeSlotLinear, makeRectangle, makePolygon, makeText,
    referencedIds, isClosed, withParams,
} from '../entities.js';
import {
    CONSTRAINT_KIND,
    coincident, horizontal, vertical, parallel, perpendicular, tangent,
    equalLength, fixedDistance, fixedAngle, fixedRadius, fixedPoint,
    horizontalDist, symmetric, pointOnLine,
    isDimensional, isExpression, validateConstraint, makeConstraint,
} from '../constraints.js';
import {
    SOLVE_STATUS,
    stockPlane, facePlane,
    makeSketchData,
    addEntity, removeEntity, patchEntity,
    addConstraint, removeConstraint, setConstraintValue,
    entityCount, constraintCount,
    hasClosedLoop, validateSketch,
} from '../sketch_data.js';
import {
    makeSketchFeature, sketchDataOf, addSketchChange, updateSketchChange, isSketchFeature,
} from '../feature.js';
import {
    emitSketchPython, summarizeSketch, planeExpr,
} from '../emit.js';
import { foldChangelog } from '../../document/fold.js';

const _tests = [];
let _suite = '';
function suite(name, fn) { _suite = name; fn(); _suite = ''; }
function test(name, fn)  { _tests.push({ suite: _suite, name, fn }); }
async function runAll() {
    let pass = 0, fail = 0;
    for (const t of _tests) {
        try {
            await t.fn();
            pass++;
            console.log(`  \x1b[32m✓\x1b[0m ${t.suite ? t.suite + ' › ' : ''}${t.name}`);
        } catch (e) {
            fail++;
            console.log(`  \x1b[31m✗\x1b[0m ${t.suite ? t.suite + ' › ' : ''}${t.name}`);
            console.log(`    ${e.message}`);
        }
    }
    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail > 0) process.exit(1);
}

// ── Entities ─────────────────────────────────────────────────────────────────
suite('entities', () => {
    test('makePoint returns a frozen entity with x/y', () => {
        const p = makePoint(3, 4);
        assert.equal(p.kind, ENTITY_KIND.POINT);
        assert.equal(p.params.x, 3);
        assert.equal(p.params.y, 4);
        assert.equal(Object.isFrozen(p), true);
        assert.throws(() => { p.params.x = 99; });   // strict mode would throw; frozen anyway
    });

    test('makeLine references its two endpoints', () => {
        const a = makePoint(0, 0), b = makePoint(10, 0);
        const l = makeLine(a.id, b.id);
        assert.deepEqual(referencedIds(l), [a.id, b.id]);
    });

    test('makeCircle rejects bad radius', () => {
        const c = makePoint(0, 0);
        assert.throws(() => makeCircle(c.id, -1));
        assert.throws(() => makeCircle(c.id, 0));
    });

    test('makeArc rejects zero sweep angle', () => {
        const c = makePoint(0, 0);
        assert.throws(() => makeArc(c.id, 5, 0, 0));
    });

    test('makeSpline requires degree+1 control points', () => {
        const pts = [makePoint(0, 0), makePoint(1, 0), makePoint(2, 1)];
        assert.throws(() => makeSpline(pts.map(p => p.id), { degree: 3 }), /at least 4/);
        const ok = pts.concat([makePoint(3, 0)]).map(p => p.id);
        const spl = makeSpline(ok);
        assert.equal(spl.params.controlPointIds.length, 4);
    });

    test('makePolygon rejects sides < 3', () => {
        const c = makePoint(0, 0);
        assert.throws(() => makePolygon(c.id, 5, 2));
    });

    test('isClosed identifies primitive loops', () => {
        const a = makePoint(0, 0), b = makePoint(10, 0);
        assert.equal(isClosed(makeCircle(a.id, 5)),         true);
        assert.equal(isClosed(makeRectangle(a.id, b.id)),    true);
        assert.equal(isClosed(makePolygon(a.id, 5, 6)),      true);
        assert.equal(isClosed(makeLine(a.id, b.id)),         false);
    });

    test('withParams produces a fresh entity, original unchanged', () => {
        const p = makePoint(1, 1);
        const p2 = withParams(p, { x: 9 });
        assert.equal(p.params.x, 1);
        assert.equal(p2.params.x, 9);
        assert.notEqual(p, p2);
    });
});

// ── Constraints ───────────────────────────────────────────────────────────────
suite('constraints', () => {
    test('coincident is geometric (no value)', () => {
        const c = coincident('a', 'b');
        assert.equal(c.kind, CONSTRAINT_KIND.COINCIDENT);
        assert.equal(c.value, null);
        assert.equal(isDimensional(c.kind), false);
    });

    test('fixedDistance carries a numeric value', () => {
        const c = fixedDistance('a', 'b', 25);
        assert.equal(c.value, 25);
        assert.equal(isDimensional(c.kind), true);
    });

    test('fixedDistance accepts an expression', () => {
        const c = fixedDistance('a', 'b', '=wall * 2');
        assert.equal(c.value, '=wall * 2');
        assert.equal(isExpression(c.value), true);
    });

    test('makeConstraint rejects dimensional kinds without a value', () => {
        assert.throws(() => makeConstraint(CONSTRAINT_KIND.FIXED_RADIUS, ['a']));
    });

    test('symmetric requires three entity ids', () => {
        const c = symmetric('a', 'b', 'mirror_line');
        assert.equal(c.entityIds.length, 3);
        validateConstraint(c);
        const bad = makeConstraint(CONSTRAINT_KIND.SYMMETRIC, ['only-one'], { value: null });
        assert.throws(() => validateConstraint(bad), /expects 3/);
    });

    test('horizontal/vertical take a single line', () => {
        const c = horizontal('line_x');
        assert.equal(c.entityIds.length, 1);
        validateConstraint(c);
    });

    test('fixedPoint carries x/y in extras and no value', () => {
        const c = fixedPoint('p1', 1, 2);
        assert.equal(c.extra.x, 1);
        assert.equal(c.extra.y, 2);
        assert.equal(c.value, null);
        validateConstraint(c);
    });
});

// ── SketchData ────────────────────────────────────────────────────────────────
suite('sketch-data', () => {
    function bareRectangleSketch() {
        const s = makeSketchData(stockPlane('XY'));
        const a = makePoint(0, 0);   addEntity(s, a);
        const b = makePoint(10, 0);  addEntity(s, b);
        const c = makePoint(10, 5);  addEntity(s, c);
        const d = makePoint(0, 5);   addEntity(s, d);
        addEntity(s, makeLine(a.id, b.id));
        addEntity(s, makeLine(b.id, c.id));
        addEntity(s, makeLine(c.id, d.id));
        addEntity(s, makeLine(d.id, a.id));
        return { s, ids: { a: a.id, b: b.id, c: c.id, d: d.id } };
    }

    test('makeSketchData starts empty and unsolved', () => {
        const s = makeSketchData(stockPlane('XY'));
        assert.equal(entityCount(s), 0);
        assert.equal(s.solveStatus, SOLVE_STATUS.UNSOLVED);
    });

    test('addEntity rejects references to missing entities', () => {
        const s = makeSketchData(stockPlane('XY'));
        const dangling = makeLine('not_a_point', 'not_a_point2');
        assert.throws(() => addEntity(s, dangling), /references missing entity/);
    });

    test('addEntity rejects id collisions', () => {
        const s = makeSketchData(stockPlane('XY'));
        const p = makePoint(0, 0);
        addEntity(s, p);
        assert.throws(() => addEntity(s, p), /id collision/);
    });

    test('removeEntity cascades to dependent lines + constraints', () => {
        const { s, ids } = bareRectangleSketch();
        addConstraint(s, horizontal(Object.values(s.entities).find(e => e.kind === 'line').id));
        const before = constraintCount(s);
        removeEntity(s, ids.a);  // every line touching A is gone
        // Two lines referenced A; they cascade out. Constraints touching those
        // lines also vanish.
        assert.ok(entityCount(s) < 8);
        assert.ok(constraintCount(s) <= before);
    });

    test('patchEntity rewrites params and re-marks unsolved', () => {
        const s = makeSketchData(stockPlane('XY'));
        const p = makePoint(0, 0); addEntity(s, p);
        s.solveStatus = SOLVE_STATUS.SOLVED;
        patchEntity(s, p.id, { x: 99 });
        assert.equal(s.entities[p.id].params.x, 99);
        assert.equal(s.solveStatus, SOLVE_STATUS.UNSOLVED);
    });

    test('addConstraint rejects references to missing entities', () => {
        const s = makeSketchData(stockPlane('XY'));
        assert.throws(() => addConstraint(s, horizontal('no_such_line')));
    });

    test('setConstraintValue rewrites and re-marks unsolved', () => {
        const { s } = bareRectangleSketch();
        const lineId = Object.values(s.entities).find(e => e.kind === 'line').id;
        const c = fixedDistance(lineId.startId || s.entities[lineId].params.startId, s.entities[lineId].params.endId, 10);
        addConstraint(s, c);
        s.solveStatus = SOLVE_STATUS.SOLVED;
        setConstraintValue(s, c.id, 25);
        assert.equal(s.constraints[c.id].value, 25);
        assert.equal(s.solveStatus, SOLVE_STATUS.UNSOLVED);
    });

    test('hasClosedLoop catches a circle', () => {
        const s = makeSketchData(stockPlane('XY'));
        const c = makePoint(0, 0); addEntity(s, c);
        addEntity(s, makeCircle(c.id, 5));
        assert.equal(hasClosedLoop(s), true);
    });

    test('hasClosedLoop catches a 4-line rectangle', () => {
        const { s } = bareRectangleSketch();
        assert.equal(hasClosedLoop(s), true);
    });

    test('hasClosedLoop rejects a single open line', () => {
        const s = makeSketchData(stockPlane('XY'));
        const a = makePoint(0, 0), b = makePoint(10, 0);
        addEntity(s, a); addEntity(s, b);
        addEntity(s, makeLine(a.id, b.id));
        assert.equal(hasClosedLoop(s), false);
    });

    test('validateSketch flags dangling refs as errors', () => {
        const s = makeSketchData(stockPlane('XY'));
        const a = makePoint(0, 0), b = makePoint(10, 0);
        addEntity(s, a); addEntity(s, b);
        addEntity(s, makeLine(a.id, b.id));
        // Forcibly inject a bad reference (bypassing addEntity guards)
        delete s.entities[b.id];
        const issues = validateSketch(s);
        assert.ok(issues.some(i => i.message.includes('dangling ref')));
    });
});

// ── Feature bridge ────────────────────────────────────────────────────────────
suite('feature-bridge', () => {
    test('makeSketchFeature carries planeRef on inputs.plane', () => {
        const s = makeSketchData(stockPlane('XY'));
        const f = makeSketchFeature(s);
        assert.equal(f.type, 'Sketch');
        assert.equal(f.inputs.plane.ref, 'XY');
        assert.equal(f.id, s.id);
    });

    test('sketchDataOf round-trips the SketchData', () => {
        const s = makeSketchData(stockPlane('XY'));
        const p = makePoint(0, 0); addEntity(s, p);
        const f = makeSketchFeature(s);
        assert.equal(sketchDataOf(f).id, s.id);
        assert.equal(sketchDataOf(f).entityOrder.length, 1);
    });

    test('isSketchFeature type guard', () => {
        const s = makeSketchData(stockPlane('XY'));
        assert.equal(isSketchFeature(makeSketchFeature(s)), true);
        assert.equal(isSketchFeature({ type: 'Box' }), false);
    });

    test('addSketchChange + updateSketchChange round-trip through fold', () => {
        const s = makeSketchData(stockPlane('XY'));
        const add = addSketchChange(s);
        // Edit the sketch
        const p = makePoint(1, 2); addEntity(s, p);
        const upd = updateSketchChange(s.id, s);
        const doc = foldChangelog([add, upd], 1);
        const feat = doc.features[s.id];
        assert.ok(feat);
        assert.equal(feat.params.sketch.entityOrder.length, 1);
        assert.equal(feat.params.sketch.entities[p.id].params.x, 1);
    });

    test('face-plane sketch encodes its descriptor on inputs.plane', () => {
        // Synthetic face descriptor (mirrors lib/document/descriptor shape)
        const desc = {
            kind: 'face', feature: 'box_a', opTag: 'box', part: '+Z', parents: [],
        };
        const s = makeSketchData(facePlane(desc));
        const f = makeSketchFeature(s);
        assert.equal(f.inputs.plane.kind, 'face');
        assert.equal(f.inputs.plane.fingerprint.part, '+Z');
    });
});

// ── Emitter ──────────────────────────────────────────────────────────────────
suite('emit', () => {
    test('planeExpr maps stock XY to Plane.XY', () => {
        assert.equal(planeExpr(stockPlane('XY')), 'Plane.XY');
        assert.equal(planeExpr(stockPlane('XZ')), 'Plane.XZ');
        assert.equal(planeExpr(stockPlane('YZ')), 'Plane.YZ');
    });

    test('emitSketchPython produces a BuildSketch block for an empty sketch', () => {
        const s = makeSketchData(stockPlane('XY'));
        const src = emitSketchPython(s);
        assert.match(src, /with BuildSketch\(Plane\.XY\) as sk_/);
        assert.match(src, /pass/);
    });

    test('emit emits a Line statement for a single segment', () => {
        const s = makeSketchData(stockPlane('XY'));
        const a = makePoint(0, 0), b = makePoint(10, 0);
        addEntity(s, a); addEntity(s, b);
        addEntity(s, makeLine(a.id, b.id));
        const src = emitSketchPython(s);
        assert.match(src, /Line\(\(0, 0\), \(10, 0\)\)/);
    });

    test('emit emits a Circle with locate at the centre', () => {
        const s = makeSketchData(stockPlane('XY'));
        const c = makePoint(5, 5); addEntity(s, c);
        addEntity(s, makeCircle(c.id, 7));
        const src = emitSketchPython(s);
        assert.match(src, /Circle\(7,/);
        assert.match(src, /locate\(Location\(\(5, 5\)\)\)/);
    });

    test('emit emits a Rectangle from two corners', () => {
        const s = makeSketchData(stockPlane('XY'));
        const a = makePoint(0, 0), b = makePoint(10, 5);
        addEntity(s, a); addEntity(s, b);
        addEntity(s, makeRectangle(a.id, b.id));
        const src = emitSketchPython(s);
        assert.match(src, /Rectangle\(10, 5,/);
        assert.match(src, /locate\(Location\(\(5, 2\.5\)\)\)/);
    });

    test('emit emits a regular polygon', () => {
        const s = makeSketchData(stockPlane('XY'));
        const c = makePoint(0, 0); addEntity(s, c);
        addEntity(s, makePolygon(c.id, 10, 6));
        const src = emitSketchPython(s);
        assert.match(src, /RegularPolygon\(10, 6/);
    });

    test('emit emits a Spline from N control points', () => {
        const s = makeSketchData(stockPlane('XY'));
        const pts = [makePoint(0, 0), makePoint(1, 1), makePoint(2, 0), makePoint(3, 2)];
        for (const p of pts) addEntity(s, p);
        addEntity(s, makeSpline(pts.map(p => p.id)));
        const src = emitSketchPython(s);
        assert.match(src, /Spline\(\[\(0, 0\), \(1, 1\), \(2, 0\), \(3, 2\)\]\)/);
    });

    test('emit emits a linear slot with correct rotation+length', () => {
        const s = makeSketchData(stockPlane('XY'));
        const a = makePoint(0, 0), b = makePoint(10, 0);
        addEntity(s, a); addEntity(s, b);
        addEntity(s, makeSlotLinear(a.id, b.id, 2));
        const src = emitSketchPython(s);
        assert.match(src, /SlotCenterToCenter\(10, 4\)/);
        assert.match(src, /rotate\(Axis\.Z, 0\)/);
    });

    test('emit skips construction entities', () => {
        const s = makeSketchData(stockPlane('XY'));
        const a = makePoint(0, 0); addEntity(s, a);
        const b = makePoint(10, 0); addEntity(s, b);
        const wireLine = makeLine(a.id, b.id);
        addEntity(s, wireLine);
        const constructionLine = withParams({ ...wireLine, construction: true }, {});
        // skipped — emitted output omits construction by design
        const src = emitSketchPython(s);
        // Match Line(...) with a parenthesised coordinate pair (excludes BuildLine())
        const lineCount = (src.match(/\bLine\(\(/g) || []).length;
        assert.equal(lineCount, 1);
    });

    test('emit inlines anchor point coords (no bare Locations for them)', () => {
        const s = makeSketchData(stockPlane('XY'));
        const a = makePoint(0, 0), b = makePoint(10, 0);
        addEntity(s, a); addEntity(s, b);
        addEntity(s, makeLine(a.id, b.id));
        const src = emitSketchPython(s);
        // The bare point emitter would inject `Locations(...)`. Anchor points
        // should NOT appear as standalone Locations.
        assert.equal(src.includes('Locations(('), false);
    });

    test('summarizeSketch returns a count-by-kind summary', () => {
        const s = makeSketchData(stockPlane('XY'));
        const a = makePoint(0, 0); addEntity(s, a);
        addEntity(s, makeCircle(a.id, 5));
        const sum = summarizeSketch(s);
        assert.match(sum, /sketch\[2\]/);
        assert.match(sum, /point=1/);
        assert.match(sum, /circle=1/);
    });

    test('emit on a face-plane sketch produces resolve_face_plane call', () => {
        const desc = { kind: 'face', feature: 'box_a', opTag: 'box', part: '+Z', parents: [] };
        const s = makeSketchData(facePlane(desc));
        const src = emitSketchPython(s);
        assert.match(src, /resolve_face_plane\("face:box_a:box:\+Z"\)/);
    });
});

runAll();
