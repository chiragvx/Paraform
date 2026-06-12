/**
 * Tests for the sketch operations + builder + extrude/revolve integration.
 * Run via:  node lib/document/__tests__/sketch_integration.mjs
 */

import assert from 'node:assert/strict';
import {
    rectangleSketch, circleSketch, polygonSketch, slotSketch, ellipseSketch,
    newSketch, SketchBuilder,
} from '../sketch_ops.js';
import {
    extrudeSketch, revolveSketch, addFillet,
} from '../operations.js';
import {
    resetDocumentStore, getDocumentStore,
} from '../store.js';
import { emitDocument } from '../emit.js';
import { sketchDataOf } from '../../sketch/feature.js';
import { topoOrder, dependenciesOf } from '../dag.js';

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

const fresh = () => resetDocumentStore();

// ── Quick helpers ────────────────────────────────────────────────────────────
suite('quick-helpers', () => {
    test('rectangleSketch commits a Sketch feature carrying a Rectangle entity', () => {
        const store = fresh();
        const sk = rectangleSketch('XY', 20, 10);
        assert.equal(sk.type, 'Sketch');
        const data = sketchDataOf(store.doc.features[sk.id]);
        const kinds = Object.values(data.entities).map(e => e.kind);
        assert.ok(kinds.includes('rectangle'));
        assert.equal(data.planeRef.name, 'XY');
    });

    test('circleSketch carries a Circle of the requested radius', () => {
        const store = fresh();
        const sk = circleSketch('XZ', 7);
        const data = sketchDataOf(store.doc.features[sk.id]);
        const circle = Object.values(data.entities).find(e => e.kind === 'circle');
        assert.ok(circle);
        assert.equal(circle.params.radius, 7);
        assert.equal(data.planeRef.name, 'XZ');
    });

    test('polygonSketch supports inscribed and rotation', () => {
        const store = fresh();
        const sk = polygonSketch('XY', 6, 10, { inscribed: true, rotation: Math.PI / 6 });
        const data = sketchDataOf(store.doc.features[sk.id]);
        const poly = Object.values(data.entities).find(e => e.kind === 'polygon');
        assert.ok(poly);
        assert.equal(poly.params.sides, 6);
        assert.equal(poly.params.inscribed, true);
    });

    test('slotSketch carries a SlotLinear of the right length+width', () => {
        const store = fresh();
        const sk = slotSketch('XY', 20, 4);
        const data = sketchDataOf(store.doc.features[sk.id]);
        const slot = Object.values(data.entities).find(e => e.kind === 'slot-linear');
        assert.ok(slot);
        assert.equal(slot.params.radius, 2);   // half-width
    });

    test('ellipseSketch carries an Ellipse', () => {
        const store = fresh();
        const sk = ellipseSketch('XY', 10, 6);
        const data = sketchDataOf(store.doc.features[sk.id]);
        const el = Object.values(data.entities).find(e => e.kind === 'ellipse');
        assert.ok(el);
        assert.equal(el.params.majorRadius, 10);
        assert.equal(el.params.minorRadius, 6);
    });
});

// ── Sketch + Extrude / Revolve ───────────────────────────────────────────────
suite('extrude-revolve', () => {
    test('extrudeSketch produces a downstream Extrude feature with the right ref', () => {
        const store = fresh();
        const sk = rectangleSketch('XY', 20, 10);
        const ex = extrudeSketch(sk, { amount: 5 });
        assert.equal(ex.type, 'Extrude');
        assert.equal(ex.inputs.sketch.sketchId, sk.id);
        // DAG: sketch → extrude
        const deps = dependenciesOf(store.doc);
        assert.ok(deps.get(ex.id).has(sk.id));
    });

    test('extrudeSketch accepts a feature id directly', () => {
        const store = fresh();
        const sk = circleSketch('XY', 4);
        const ex = extrudeSketch(sk.id, { amount: 12 });
        assert.equal(ex.inputs.sketch.sketchId, sk.id);
    });

    test('revolveSketch wires a Revolve with axis ref', () => {
        const store = fresh();
        const sk = circleSketch('XY', 4);
        const rv = revolveSketch(sk, { angle: 270, axis: 'Y' });
        assert.equal(rv.type, 'Revolve');
        assert.equal(rv.inputs.sketch.sketchId, sk.id);
        assert.equal(rv.inputs.axis.ref, 'Y');
        assert.equal(rv.params.angle, 270);
    });

    test('chained sketch → extrude → fillet keeps DAG topology correct', () => {
        const store = fresh();
        const sk = rectangleSketch('XY', 20, 20);
        const ex = extrudeSketch(sk, { amount: 8 });
        const fil = addFillet(ex.id, { radius: 1 });
        const order = topoOrder(store.doc);
        assert.deepEqual(order, [sk.id, ex.id, fil.id]);
    });
});

// ── SketchBuilder fluent API ────────────────────────────────────────────────
suite('builder', () => {
    test('newSketch returns a SketchBuilder with chainable adders', () => {
        fresh();
        const b = newSketch('XY');
        assert.ok(b instanceof SketchBuilder);
        const a = b.point(0, 0);
        const z = b.point(10, 0);
        b.line(a, z);
        assert.equal(b.entityCount, 3);   // 2 points + 1 line
    });

    test('line(x1, y1, x2, y2) auto-creates the two anchor points', () => {
        fresh();
        const b = newSketch('XY');
        b.line(0, 0, 10, 0);
        assert.equal(b.entityCount, 3);   // 2 points + 1 line
    });

    test('rect(x1, y1, x2, y2) auto-creates the two corner points', () => {
        fresh();
        const b = newSketch('XY');
        b.rect(0, 0, 20, 10);
        assert.equal(b.entityCount, 3);   // 2 corners + 1 rectangle
    });

    test('constraint helpers add the right kinds', () => {
        fresh();
        const b = newSketch('XY');
        const a = b.point(0, 0);
        const z = b.point(10, 0);
        const L = b.line(a, z);
        b.horizontal(L).lockPoint(a, 0, 0).dim(a, z, 25);
        const data = b.data;
        const kinds = Object.values(data.constraints).map(c => c.kind);
        assert.ok(kinds.includes('horizontal'));
        assert.ok(kinds.includes('fixed-point'));
        assert.ok(kinds.includes('fixed-distance'));
    });

    test('builder.solve() returns ok for a properly-constrained sketch', () => {
        fresh();
        const b = newSketch('XY');
        const a = b.point(0, 0);
        const z = b.point(1, 0);
        b.line(a, z);
        const result = b.solve();
        // Two points, zero constraints — solver reports ok with dof=4
        assert.equal(result.status, 'ok');
    });

    test('builder.commit() only allowed once', () => {
        fresh();
        const b = newSketch('XY');
        b.rect(0, 0, 5, 5);
        b.commit();
        assert.throws(() => b.commit(), /already committed/);
    });

    test('committed sketch flows through emit as build123d Python', () => {
        fresh();
        const b = newSketch('XY');
        b.rect(0, 0, 20, 10);
        const sk = b.commit();
        const ex = extrudeSketch(sk, { amount: 5 });
        const { code } = emitDocument(getDocumentStore().doc);
        assert.match(code, new RegExp(`with BuildSketch\\(Plane.XY\\) as sk_${sk.id}:`));
        assert.match(code, /Rectangle\(20, 10,/);
        assert.match(code, new RegExp(`n_${ex.id} = extrude\\(n_${sk.id},`));
    });

    test('a parametric rectangle solves to the requested width/height', () => {
        fresh();
        const b = newSketch('XY');
        const a = b.point(0, 0);
        const corner = b.point(1, 1);
        b.lockPoint(a, 0, 0);
        b.hDim(a, corner, 25);
        b.vDim(a, corner, 12);
        const result = b.solve();
        assert.equal(result.status, 'ok');
        const cornerEntity = b.data.entities[corner];
        assert.ok(Math.abs(cornerEntity.params.x - 25) < 1e-3);
        assert.ok(Math.abs(cornerEntity.params.y - 12) < 1e-3);
    });
});

// ── Emit roundtrip ──────────────────────────────────────────────────────────
suite('emit-roundtrip', () => {
    test('rectangle sketch + extrude emits a valid build123d block', () => {
        fresh();
        const sk = rectangleSketch('XY', 20, 10);
        const ex = extrudeSketch(sk, { amount: 5 });
        const { code, leafIds } = emitDocument(getDocumentStore().doc);
        assert.match(code, /from build123d import \*/);
        assert.match(code, /Rectangle\(20, 10,/);
        assert.match(code, new RegExp(`n_${ex.id} = extrude\\(n_${sk.id}, amount=5\\)`));
        // Extrude consumes the sketch → sketch is not a leaf, extrude is
        assert.deepEqual(leafIds, [ex.id]);
    });

    test('circle sketch + revolve emits a Revolve statement', () => {
        fresh();
        const sk = circleSketch('XY', 3);
        const rv = revolveSketch(sk, { angle: 180, axis: 'Y' });
        const { code } = emitDocument(getDocumentStore().doc);
        assert.match(code, /Circle\(3,/);
        assert.match(code, new RegExp(`n_${rv.id} = revolve\\(n_${sk.id}, axis=Axis.Y, revolution_arc=180\\)`));
    });

    test('hexagon sketch + extrude emits a RegularPolygon statement', () => {
        fresh();
        const sk = polygonSketch('XY', 6, 8);
        extrudeSketch(sk, { amount: 4 });
        const { code } = emitDocument(getDocumentStore().doc);
        assert.match(code, /RegularPolygon\(8, 6,/);
    });

    test('slot sketch emits a SlotCenterToCenter', () => {
        fresh();
        const sk = slotSketch('XY', 20, 6);
        extrudeSketch(sk, { amount: 3 });
        const { code } = emitDocument(getDocumentStore().doc);
        assert.match(code, /SlotCenterToCenter\(20, 6\)/);
    });

    test('chained sketch → extrude → fillet emits the right call order', () => {
        fresh();
        const sk = rectangleSketch('XY', 20, 20);
        const ex = extrudeSketch(sk, { amount: 8 });
        const fil = addFillet(ex.id, { radius: 1 });
        const { code } = emitDocument(getDocumentStore().doc);
        const idxSk = code.indexOf(`sk_${sk.id}`);
        const idxEx = code.indexOf(`n_${ex.id} = extrude`);
        const idxFi = code.indexOf(`n_${fil.id} = fillet`);
        assert.ok(idxSk < idxEx);
        assert.ok(idxEx < idxFi);
    });
});

runAll();
