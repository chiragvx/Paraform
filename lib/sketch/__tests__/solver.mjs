/**
 * Tests for the Phase 1C solver facade + Newton implementation.
 * Run via:  node lib/sketch/__tests__/solver.mjs
 */

import assert from 'node:assert/strict';
import {
    makePoint, makeLine, makeCircle, makeRectangle,
} from '../entities.js';
import {
    coincident, horizontal, vertical, parallel, perpendicular,
    fixedDistance, fixedRadius, fixedPoint, fixedAngle,
    midpoint, equalLength, equalRadius, tangent,
    horizontalDist, verticalDist, pointOnLine, pointOnCircle, symmetric, equalDistance,
} from '../constraints.js';
import {
    makeSketchData, stockPlane, addEntity, addConstraint,
} from '../sketch_data.js';
import {
    solve, registerSolver, setSolver, getActiveSolver, availableSolvers,
    newtonSolver,
} from '../solver/index.js';
import { planegcsSolver } from '../solver/planegcs.js';
import { SOLVE_STATUS } from '../sketch_data.js';

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

const near = (a, b, tol = 1e-3) => Math.abs(a - b) <= tol;
function assertNear(got, want, tol = 1e-3, msg = '') {
    if (!near(got, want, tol)) {
        throw new Error(`${msg} expected ${want}, got ${got} (tol=${tol})`);
    }
}

// ── Facade ───────────────────────────────────────────────────────────────────
suite('facade', () => {
    test('newton solver is registered by default', () => {
        const names = availableSolvers();
        assert.ok(names.includes('newton'));
        assert.equal(getActiveSolver().name, 'newton');
    });

    test('registerSolver accepts the planegcs stub', () => {
        registerSolver(planegcsSolver);
        assert.ok(availableSolvers().includes('planegcs'));
        // Default solver is still newton
        assert.equal(getActiveSolver().name, 'newton');
    });

    test('setSolver switches the active impl', () => {
        registerSolver(planegcsSolver);
        setSolver('planegcs');
        assert.equal(getActiveSolver().name, 'planegcs');
        setSolver('newton');
        assert.equal(getActiveSolver().name, 'newton');
    });

    test('setSolver rejects unknown names', () => {
        assert.throws(() => setSolver('nonexistent'), /unknown solver/);
    });

    test('solve() with override solver routes through the named impl', () => {
        registerSolver(planegcsSolver);
        const s = makeSketchData(stockPlane('XY'));
        assert.throws(() => solve(s, { solver: 'planegcs' }), /not yet wired/);
    });
});

// ── Trivially solved ─────────────────────────────────────────────────────────
suite('trivial', () => {
    test('empty sketch solves immediately', () => {
        const s = makeSketchData(stockPlane('XY'));
        const r = solve(s);
        assert.equal(r.status, 'ok');
        assert.equal(r.dof, 0);
        assert.equal(s.solveStatus, SOLVE_STATUS.SOLVED);
    });

    test('single unconstrained point reports as under', () => {
        const s = makeSketchData(stockPlane('XY'));
        addEntity(s, makePoint(0, 0));
        const r = solve(s);
        assert.equal(r.status, 'ok');     // no constraints, no residuals
        assert.equal(r.dof, 2);
        assert.equal(s.solveStatus, SOLVE_STATUS.SOLVED);
    });
});

// ── Geometric constraints ───────────────────────────────────────────────────
suite('geometric', () => {
    test('coincident pulls two points to the same location', () => {
        const s = makeSketchData(stockPlane('XY'));
        const p1 = makePoint(0, 0);   addEntity(s, p1);
        const p2 = makePoint(5, 7);   addEntity(s, p2);
        addConstraint(s, coincident(p1.id, p2.id));
        const r = solve(s);
        assert.equal(r.status, 'ok');
        assertNear(s.entities[p1.id].params.x, s.entities[p2.id].params.x);
        assertNear(s.entities[p1.id].params.y, s.entities[p2.id].params.y);
    });

    test('horizontal flattens a line', () => {
        const s = makeSketchData(stockPlane('XY'));
        const a = makePoint(0, 0);   addEntity(s, a);
        const b = makePoint(10, 5);  addEntity(s, b);
        const l = makeLine(a.id, b.id); addEntity(s, l);
        addConstraint(s, fixedPoint(a.id, 0, 0));   // anchor one end
        addConstraint(s, horizontal(l.id));
        const r = solve(s);
        assert.equal(r.status, 'ok');
        assertNear(s.entities[a.id].params.y, s.entities[b.id].params.y);
    });

    test('vertical aligns a line on Y', () => {
        const s = makeSketchData(stockPlane('XY'));
        const a = makePoint(0, 0);   addEntity(s, a);
        const b = makePoint(7, 10);  addEntity(s, b);
        const l = makeLine(a.id, b.id); addEntity(s, l);
        addConstraint(s, fixedPoint(a.id, 0, 0));
        addConstraint(s, vertical(l.id));
        solve(s);
        assertNear(s.entities[a.id].params.x, s.entities[b.id].params.x);
    });

    test('parallel keeps cross product = 0', () => {
        const s = makeSketchData(stockPlane('XY'));
        const a = makePoint(0, 0);    addEntity(s, a);
        const b = makePoint(10, 0);   addEntity(s, b);
        const c = makePoint(0, 5);    addEntity(s, c);
        const d = makePoint(8, 5.7);  addEntity(s, d);
        const L1 = makeLine(a.id, b.id); addEntity(s, L1);
        const L2 = makeLine(c.id, d.id); addEntity(s, L2);
        addConstraint(s, fixedPoint(a.id, 0, 0));
        addConstraint(s, fixedPoint(b.id, 10, 0));
        addConstraint(s, fixedPoint(c.id, 0, 5));
        addConstraint(s, parallel(L1.id, L2.id));
        const r = solve(s);
        assert.equal(r.status, 'ok');
        // L2 should also be horizontal because L1 is
        assertNear(s.entities[c.id].params.y, s.entities[d.id].params.y);
    });

    test('perpendicular drives dot product → 0', () => {
        const s = makeSketchData(stockPlane('XY'));
        const a = makePoint(0, 0); addEntity(s, a);
        const b = makePoint(10, 0); addEntity(s, b);
        const c = makePoint(0, 0); addEntity(s, c);
        const d = makePoint(5, 5); addEntity(s, d);
        const L1 = makeLine(a.id, b.id); addEntity(s, L1);
        const L2 = makeLine(c.id, d.id); addEntity(s, L2);
        addConstraint(s, fixedPoint(a.id, 0, 0));
        addConstraint(s, fixedPoint(b.id, 10, 0));
        addConstraint(s, fixedPoint(c.id, 0, 0));
        addConstraint(s, perpendicular(L1.id, L2.id));
        const r = solve(s);
        assert.equal(r.status, 'ok');
        // L2 should now be vertical: d.x ≈ c.x
        assertNear(s.entities[d.id].params.x, s.entities[c.id].params.x, 0.01);
    });

    test('equal length matches two line lengths', () => {
        const s = makeSketchData(stockPlane('XY'));
        const a = makePoint(0, 0);   addEntity(s, a);
        const b = makePoint(10, 0);  addEntity(s, b);
        const c = makePoint(0, 5);   addEntity(s, c);
        const d = makePoint(7, 5);   addEntity(s, d);
        const L1 = makeLine(a.id, b.id); addEntity(s, L1);
        const L2 = makeLine(c.id, d.id); addEntity(s, L2);
        // Pin three points; let L2's free endpoint slide
        addConstraint(s, fixedPoint(a.id, 0, 0));
        addConstraint(s, fixedPoint(b.id, 10, 0));
        addConstraint(s, fixedPoint(c.id, 0, 5));
        addConstraint(s, horizontal(L2.id));
        addConstraint(s, equalLength(L1.id, L2.id));
        const r = solve(s);
        assert.equal(r.status, 'ok');
        const dx = s.entities[d.id].params.x - s.entities[c.id].params.x;
        assertNear(Math.abs(dx), 10, 0.01);
    });

    test('equal radius syncs two circles', () => {
        const s = makeSketchData(stockPlane('XY'));
        const c1 = makePoint(0, 0); addEntity(s, c1);
        const c2 = makePoint(20, 0); addEntity(s, c2);
        const C1 = makeCircle(c1.id, 5);  addEntity(s, C1);
        const C2 = makeCircle(c2.id, 3);  addEntity(s, C2);
        addConstraint(s, fixedPoint(c1.id, 0, 0));
        addConstraint(s, fixedPoint(c2.id, 20, 0));
        addConstraint(s, fixedRadius(C1.id, 7));
        addConstraint(s, equalRadius(C1.id, C2.id));
        const r = solve(s);
        assert.equal(r.status, 'ok');
        assertNear(s.entities[C1.id].params.radius, 7);
        assertNear(s.entities[C2.id].params.radius, 7);
    });

    test('midpoint pins a point to the middle of a line', () => {
        const s = makeSketchData(stockPlane('XY'));
        const a = makePoint(0, 0);    addEntity(s, a);
        const b = makePoint(20, 0);   addEntity(s, b);
        const m = makePoint(2, 1);    addEntity(s, m);
        const L = makeLine(a.id, b.id); addEntity(s, L);
        addConstraint(s, fixedPoint(a.id, 0, 0));
        addConstraint(s, fixedPoint(b.id, 20, 0));
        addConstraint(s, midpoint(m.id, L.id));
        const r = solve(s);
        assert.equal(r.status, 'ok');
        assertNear(s.entities[m.id].params.x, 10);
        assertNear(s.entities[m.id].params.y, 0);
    });

    test('point-on-line snaps a point onto a line\'s axis', () => {
        const s = makeSketchData(stockPlane('XY'));
        const a = makePoint(0, 0);   addEntity(s, a);
        const b = makePoint(10, 0);  addEntity(s, b);
        const p = makePoint(5, 3);   addEntity(s, p);
        const L = makeLine(a.id, b.id); addEntity(s, L);
        addConstraint(s, fixedPoint(a.id, 0, 0));
        addConstraint(s, fixedPoint(b.id, 10, 0));
        addConstraint(s, horizontalDist(a.id, p.id, 5));    // pin x = 5
        addConstraint(s, pointOnLine(p.id, L.id));
        const r = solve(s);
        assert.equal(r.status, 'ok');
        assertNear(s.entities[p.id].params.y, 0);
        assertNear(s.entities[p.id].params.x, 5);
    });

    test('point-on-circle puts a point on the rim', () => {
        const s = makeSketchData(stockPlane('XY'));
        const c = makePoint(0, 0);    addEntity(s, c);
        const C = makeCircle(c.id, 5); addEntity(s, C);
        const p = makePoint(3, 0);    addEntity(s, p);
        addConstraint(s, fixedPoint(c.id, 0, 0));
        addConstraint(s, fixedRadius(C.id, 5));
        addConstraint(s, pointOnCircle(p.id, C.id));
        addConstraint(s, horizontalDist(c.id, p.id, 5));    // forces p to (5, 0)
        const r = solve(s);
        assert.equal(r.status, 'ok');
        const dx = s.entities[p.id].params.x, dy = s.entities[p.id].params.y;
        assertNear(Math.sqrt(dx*dx + dy*dy), 5);
    });

    test('symmetric mirrors point B about a line through A', () => {
        const s = makeSketchData(stockPlane('XY'));
        // Define a horizontal mirror line
        const m1 = makePoint(0, 5);   addEntity(s, m1);
        const m2 = makePoint(10, 5);  addEntity(s, m2);
        const ML = makeLine(m1.id, m2.id); addEntity(s, ML);
        // Two points to be made symmetric
        const a = makePoint(2, 3);   addEntity(s, a);
        const b = makePoint(2, 9);   addEntity(s, b);   // close to mirror of (2,3) → (2,7)
        addConstraint(s, fixedPoint(m1.id, 0, 5));
        addConstraint(s, fixedPoint(m2.id, 10, 5));
        addConstraint(s, fixedPoint(a.id, 2, 3));
        addConstraint(s, symmetric(a.id, b.id, ML.id));
        const r = solve(s);
        assert.equal(r.status, 'ok');
        assertNear(s.entities[b.id].params.x, 2);
        assertNear(s.entities[b.id].params.y, 7);
    });
});

// ── Dimensional constraints ─────────────────────────────────────────────────
suite('dimensional', () => {
    test('fixedDistance sets two-point distance', () => {
        const s = makeSketchData(stockPlane('XY'));
        const a = makePoint(0, 0);   addEntity(s, a);
        const b = makePoint(1, 0);   addEntity(s, b);
        addConstraint(s, fixedPoint(a.id, 0, 0));
        addConstraint(s, horizontalDist(a.id, b.id, 12));
        addConstraint(s, verticalDist(a.id, b.id, 0));
        const r = solve(s);
        assert.equal(r.status, 'ok');
        assertNear(s.entities[b.id].params.x, 12);
        assertNear(s.entities[b.id].params.y, 0);
    });

    test('fixedRadius locks a circle radius', () => {
        const s = makeSketchData(stockPlane('XY'));
        const c = makePoint(0, 0);    addEntity(s, c);
        const C = makeCircle(c.id, 3); addEntity(s, C);
        addConstraint(s, fixedPoint(c.id, 0, 0));
        addConstraint(s, fixedRadius(C.id, 8.5));
        const r = solve(s);
        assert.equal(r.status, 'ok');
        assertNear(s.entities[C.id].params.radius, 8.5);
    });

    test('fixedDistance accepts an expression referencing a Document parameter', () => {
        const s = makeSketchData(stockPlane('XY'));
        const a = makePoint(0, 0);  addEntity(s, a);
        const b = makePoint(3, 0);  addEntity(s, b);
        addConstraint(s, fixedPoint(a.id, 0, 0));
        addConstraint(s, horizontalDist(a.id, b.id, '=wall * 2'));
        addConstraint(s, verticalDist(a.id, b.id, 0));
        // Inject a Document-style parameter map
        const docParams = { p1: { name: 'wall', value: 7 } };
        const r = solve(s, { documentParameters: docParams });
        assert.equal(r.status, 'ok');
        assertNear(s.entities[b.id].params.x, 14);    // wall * 2
    });

    test('fixedAngle drives the angle between two lines', () => {
        const s = makeSketchData(stockPlane('XY'));
        const a = makePoint(0, 0);   addEntity(s, a);
        const b = makePoint(10, 0);  addEntity(s, b);
        const c = makePoint(0, 0);   addEntity(s, c);
        const d = makePoint(5, 1);   addEntity(s, d);
        const L1 = makeLine(a.id, b.id); addEntity(s, L1);
        const L2 = makeLine(c.id, d.id); addEntity(s, L2);
        addConstraint(s, fixedPoint(a.id, 0, 0));
        addConstraint(s, fixedPoint(b.id, 10, 0));
        addConstraint(s, fixedPoint(c.id, 0, 0));
        addConstraint(s, fixedDistance(c.id, d.id, 5));
        addConstraint(s, fixedAngle(L1.id, L2.id, 45));
        const r = solve(s);
        assert.equal(r.status, 'ok');
        // L2 should now point along (cos45, sin45) * 5 from origin
        assertNear(s.entities[d.id].params.x, 5 * Math.cos(Math.PI / 4), 0.05);
        assertNear(s.entities[d.id].params.y, 5 * Math.sin(Math.PI / 4), 0.05);
    });
});

// ── Composite: parametric rectangle ─────────────────────────────────────────
suite('composite', () => {
    test('a parametric horizontal-rectangle sketch solves to spec', () => {
        const s = makeSketchData(stockPlane('XY'));
        const a = makePoint(0, 0);     addEntity(s, a);
        const b = makePoint(5, 0);     addEntity(s, b);
        const c = makePoint(5, 3);     addEntity(s, c);
        const d = makePoint(0, 3);     addEntity(s, d);
        const ab = makeLine(a.id, b.id); addEntity(s, ab);
        const bc = makeLine(b.id, c.id); addEntity(s, bc);
        const cd = makeLine(c.id, d.id); addEntity(s, cd);
        const da = makeLine(d.id, a.id); addEntity(s, da);
        addConstraint(s, fixedPoint(a.id, 0, 0));
        addConstraint(s, horizontal(ab.id));
        addConstraint(s, horizontal(cd.id));
        addConstraint(s, vertical(bc.id));
        addConstraint(s, vertical(da.id));
        addConstraint(s, horizontalDist(a.id, b.id, 20));
        addConstraint(s, verticalDist(a.id, d.id, 12));
        const r = solve(s);
        assert.equal(r.status, 'ok');
        // Width 20, height 12
        assertNear(s.entities[b.id].params.x, 20);
        assertNear(s.entities[c.id].params.x, 20);
        assertNear(s.entities[c.id].params.y, 12);
        assertNear(s.entities[d.id].params.y, 12);
    });
});

runAll();
