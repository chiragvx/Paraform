/**
 * Tests for the advanced operation wrappers in operations.js — Sweep,
 * Loft, Hole, PathPattern — plus their emitter output in emit.js.
 *
 * Each operation needs to commit a well-shaped feature (right `type`,
 * `params`, `inputs`) AND emit the expected build123d Python so the
 * kernel harness recognises it.
 *
 * Run via:  node lib/document/__tests__/advanced_ops.mjs
 */

import assert from 'node:assert/strict';
import {
    addBox, addCylinder,
    addSweep, addLoft, addHole, addHelix, addPathPattern,
    rectangleSketch, circleSketch,
    deleteFeature, resetDocument,
} from '../index.js';
import { resetDocumentStore, getDocumentStore } from '../store.js';
import { emitDocument } from '../emit.js';

const _tests = [];
let _suite = '';
function suite(name, fn) { _suite = name; fn(); _suite = ''; }
function test(name, fn)  { _tests.push({ suite: _suite, name, fn }); }
async function runAll() {
    let pass = 0, fail = 0;
    for (const t of _tests) {
        resetDocumentStore();
        try { await t.fn(); pass++; console.log(`  \x1b[32m✓\x1b[0m ${t.suite ? t.suite + ' › ' : ''}${t.name}`); }
        catch (e) { fail++; console.log(`  \x1b[31m✗\x1b[0m ${t.suite ? t.suite + ' › ' : ''}${t.name}`); console.log(`    ${e.message}`); }
    }
    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail > 0) process.exit(1);
}

// ── addSweep ────────────────────────────────────────────────────────────────
suite('addSweep', () => {
    test('creates a Sweep feature with sketch + path inputs', () => {
        const profile = circleSketch('XY', 1);
        const path = circleSketch('XZ', 10);
        const f = addSweep(profile.id, path.id);
        assert.equal(f.type, 'Sweep');
        assert.equal(f.inputs.sketch.sketchId, profile.id);
        assert.equal(f.inputs.path.sketchId, path.id);
    });

    test('emits `sweep(profile, path=...)` Python', () => {
        const profile = circleSketch('XY', 1);
        const path = circleSketch('XZ', 10);
        const f = addSweep(profile.id, path.id);
        const { code } = emitDocument(getDocumentStore().doc);
        // Must reference both sketch variables and call sweep
        assert.ok(code.includes(`n_${f.id} = sweep(n_${profile.id}, path=n_${path.id})`),
            `expected sweep emit, got:\n${code}`);
    });

    test('throws when profile is missing', () => {
        const path = circleSketch('XZ', 5);
        assert.throws(() => addSweep(null, path.id), /addSweep/);
    });

    test('throws when path is missing', () => {
        const profile = circleSketch('XY', 1);
        assert.throws(() => addSweep(profile.id, null), /addSweep/);
    });
});

// ── addLoft ─────────────────────────────────────────────────────────────────
suite('addLoft', () => {
    test('creates a Loft feature with an array of sketch refs', () => {
        const a = circleSketch('XY', 5);
        const b = circleSketch('XY', 2);
        const f = addLoft([a.id, b.id]);
        assert.equal(f.type, 'Loft');
        assert.equal(f.inputs.sketches.length, 2);
        assert.equal(f.inputs.sketches[0].sketchId, a.id);
        assert.equal(f.inputs.sketches[1].sketchId, b.id);
        assert.equal(f.params.ruled, false);
    });

    test('accepts ruled=true', () => {
        const a = circleSketch('XY', 5);
        const b = circleSketch('XY', 2);
        const f = addLoft([a.id, b.id], { ruled: true });
        assert.equal(f.params.ruled, true);
    });

    test('emits `loft([s1, s2], ruled=False)` Python', () => {
        const a = circleSketch('XY', 5);
        const b = circleSketch('XY', 2);
        const f = addLoft([a.id, b.id]);
        const { code } = emitDocument(getDocumentStore().doc);
        assert.ok(code.includes(`n_${f.id} = loft([n_${a.id}, n_${b.id}], ruled=False)`),
            `expected loft emit, got:\n${code}`);
    });

    test('throws when fewer than 2 sketches are supplied', () => {
        const a = circleSketch('XY', 5);
        assert.throws(() => addLoft([a.id]),     /at least 2/);
        assert.throws(() => addLoft([]),         /at least 2/);
        assert.throws(() => addLoft(null),       /at least 2/);
    });
});

// ── addHole ─────────────────────────────────────────────────────────────────
suite('addHole', () => {
    test('creates a simple Hole feature on the target body', () => {
        const box = addBox();
        const f = addHole(box.id, { diameter: 5, depth: 10 });
        assert.equal(f.type, 'Hole');
        assert.equal(f.inputs.body.featureId, box.id);
        assert.equal(f.params.diameter, 5);
        assert.equal(f.params.depth, 10);
        assert.equal(f.params.type, 'simple');
        assert.equal(f.params.through, false);
    });

    test('counterbore stores counterDia + counterDepth', () => {
        const box = addBox();
        const f = addHole(box.id, {
            diameter: 3.2, depth: 10,
            type: 'counterbore', counterDia: 6, counterDepth: 3,
        });
        assert.equal(f.params.type, 'counterbore');
        assert.equal(f.params.counterDia, 6);
        assert.equal(f.params.counterDepth, 3);
    });

    test('countersink stores counterDia only (angle defaulted in kernel)', () => {
        const box = addBox();
        const f = addHole(box.id, {
            diameter: 3.2, type: 'countersink', counterDia: 6,
        });
        assert.equal(f.params.type, 'countersink');
        assert.equal(f.params.counterDia, 6);
        assert.equal(f.params.counterDepth, undefined);
    });

    test('through=true is stored verbatim in params', () => {
        const box = addBox();
        const f = addHole(box.id, { through: true });
        assert.equal(f.params.through, true);
    });

    test('emits `make_hole(body, location=None, diameter=..., depth=...)` for simple holes', () => {
        const box = addBox();
        const f = addHole(box.id, { diameter: 4, depth: 10 });
        const { code } = emitDocument(getDocumentStore().doc);
        assert.ok(code.includes(`n_${f.id} = make_hole(n_${box.id}, location=None, diameter=4, depth=10)`),
            `expected hole emit, got:\n${code}`);
    });

    test('through hole emits depth=None (kernel interprets as through-hole)', () => {
        const box = addBox();
        const f = addHole(box.id, { diameter: 4, through: true });
        const { code } = emitDocument(getDocumentStore().doc);
        assert.ok(code.includes(`make_hole(n_${box.id}, location=None, diameter=4, depth=None)`),
            `expected through-hole emit, got:\n${code}`);
    });

    test('counterbore variant emits counter_bore_diameter + counter_bore_depth', () => {
        const box = addBox();
        const f = addHole(box.id, {
            diameter: 3.2, depth: 10,
            type: 'counterbore', counterDia: 6, counterDepth: 3,
        });
        const { code } = emitDocument(getDocumentStore().doc);
        assert.ok(code.includes('counter_bore_diameter=6'), `missing counterbore dia:\n${code}`);
        assert.ok(code.includes('counter_bore_depth=3'),    `missing counterbore depth:\n${code}`);
    });

    test('throws when target body id is missing', () => {
        assert.throws(() => addHole(null, { diameter: 5 }), /target/);
    });
});

// ── addPathPattern ──────────────────────────────────────────────────────────
suite('addPathPattern', () => {
    test('creates a PathPattern feature with body + path inputs', () => {
        const cyl = addCylinder();
        const path = circleSketch('XZ', 20);
        const f = addPathPattern(cyl.id, path.id, { count: 8 });
        assert.equal(f.type, 'PathPattern');
        assert.equal(f.inputs.body.featureId, cyl.id);
        assert.equal(f.inputs.path.sketchId, path.id);
        assert.equal(f.params.count, 8);
    });

    test('default count is 5', () => {
        const cyl = addCylinder();
        const path = circleSketch('XZ', 20);
        const f = addPathPattern(cyl.id, path.id);
        assert.equal(f.params.count, 5);
    });

    test('emits `pattern_path(body, path=..., count=...)` Python', () => {
        const cyl = addCylinder();
        const path = circleSketch('XZ', 20);
        const f = addPathPattern(cyl.id, path.id, { count: 8 });
        const { code } = emitDocument(getDocumentStore().doc);
        assert.ok(code.includes(`n_${f.id} = pattern_path(n_${cyl.id}, path=n_${path.id}, count=8)`),
            `expected pattern_path emit, got:\n${code}`);
    });

    test('throws when body or path missing', () => {
        const cyl = addCylinder();
        const path = circleSketch('XZ', 20);
        assert.throws(() => addPathPattern(null, path.id));
        assert.throws(() => addPathPattern(cyl.id, null));
    });
});

// ── addHelix ────────────────────────────────────────────────────────────────
suite('addHelix', () => {
    test('creates a Helix feature with the supplied params', () => {
        const f = addHelix({ pitch: 4, height: 30, radius: 6 });
        assert.equal(f.type, 'Helix');
        assert.equal(f.params.pitch, 4);
        assert.equal(f.params.height, 30);
        assert.equal(f.params.radius, 6);
        assert.equal(f.params.coneAngle, 0);
        assert.equal(f.params.lefthand, false);
    });

    test('default params produce a sensible cylindrical helix', () => {
        const f = addHelix();
        assert.equal(f.params.pitch, 5);
        assert.equal(f.params.height, 20);
        assert.equal(f.params.radius, 5);
    });

    test('coneAngle + lefthand are stored verbatim', () => {
        const f = addHelix({ coneAngle: 15, lefthand: true });
        assert.equal(f.params.coneAngle, 15);
        assert.equal(f.params.lefthand, true);
    });

    test('emits `Helix(pitch, height, radius, cone_angle=..., lefthand=...)`', () => {
        const f = addHelix({ pitch: 4, height: 30, radius: 6 });
        const { code } = emitDocument(getDocumentStore().doc);
        assert.ok(code.includes(`n_${f.id} = Helix(4, 30, 6, cone_angle=0, lefthand=False)`),
            `expected helix emit, got:\n${code}`);
    });

    test('Helix is a leaf body in an otherwise empty document', () => {
        const f = addHelix();
        const { leafIds } = emitDocument(getDocumentStore().doc);
        assert.ok(leafIds.includes(f.id));
    });
});

// ── Sweep along Helix ───────────────────────────────────────────────────────
suite('addSweep › Helix path', () => {
    test('Helix path becomes a bodyRef (not a sketchRef) on the Sweep feature', () => {
        const profile = circleSketch('XZ', 0.5);
        const helix = addHelix({ pitch: 4, height: 20, radius: 5 });
        const sweep = addSweep(profile.id, helix.id);
        assert.equal(sweep.inputs.path.kind, 'body');
        assert.equal(sweep.inputs.path.featureId, helix.id);
    });

    test('emit produces `sweep(profile, path=n_<helix>)` with helix as path var', () => {
        const profile = circleSketch('XZ', 0.5);
        const helix = addHelix({ pitch: 4, height: 20, radius: 5 });
        const sweep = addSweep(profile.id, helix.id);
        const { code } = emitDocument(getDocumentStore().doc);
        assert.ok(code.includes(`n_${sweep.id} = sweep(n_${profile.id}, path=n_${helix.id})`),
            `expected helix-sweep emit, got:\n${code}`);
    });

    test('a Sketch path still wires as a sketchRef (no regression on the old shape)', () => {
        const profile = circleSketch('XY', 1);
        const path = circleSketch('XZ', 10);
        const sweep = addSweep(profile.id, path.id);
        assert.equal(sweep.inputs.path.kind, 'sketch');
        assert.equal(sweep.inputs.path.sketchId, path.id);
    });
});

// ── Composition / DAG ───────────────────────────────────────────────────────
suite('composition', () => {
    test('Box → Hole produces the box as upstream of the hole in the DAG', () => {
        const box = addBox();
        const hole = addHole(box.id, { diameter: 3.2, through: true });
        const doc = getDocumentStore().doc;
        // Hole's inputs should reference the box
        assert.equal(doc.features[hole.id].inputs.body.featureId, box.id);
        // After emit, the hole becomes the leaf body (box is consumed)
        const { leafIds } = emitDocument(doc);
        assert.ok(leafIds.includes(hole.id));
        assert.ok(!leafIds.includes(box.id));
    });

    test('Sweep result is a leaf body that downstream features can reference', () => {
        const profile = circleSketch('XY', 1);
        const path = circleSketch('XZ', 20);
        const sweep = addSweep(profile.id, path.id);
        // Adding a hole that targets the sweep should work
        const hole = addHole(sweep.id, { diameter: 0.5, through: true });
        const doc = getDocumentStore().doc;
        assert.equal(doc.features[hole.id].inputs.body.featureId, sweep.id);
        const { leafIds } = emitDocument(doc);
        assert.ok(leafIds.includes(hole.id));
        assert.ok(!leafIds.includes(sweep.id));   // consumed by the hole
    });

    test('deleting the sweep cleanly drops its emit line', () => {
        const profile = circleSketch('XY', 1);
        const path = circleSketch('XZ', 20);
        const sweep = addSweep(profile.id, path.id);
        deleteFeature(sweep.id);
        const { code } = emitDocument(getDocumentStore().doc);
        assert.ok(!code.includes(`n_${sweep.id} = sweep`),
            `sweep line should be gone after delete:\n${code}`);
    });
});

await runAll();
