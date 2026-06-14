/**
 * Global assembly constraint / DOF solver tests.
 *
 * Run via:
 *   node src/lib/library/__tests__/assembly_constraints.test.mjs
 *
 * Covers the four scenarios the pairwise mate solver can't reason about:
 *   - a 2-part fixed mate         → mobility 0, exactly-constrained
 *   - a shaft + bearing revolute  → mobility 1, under-constrained
 *   - a 4-bar loop                → detectLoops finds the cycle
 *   - a floating part             → findFloatingComponents flags it
 *
 * Built on the REAL document shapes: makeComponent / makeConnector / makeMate
 * from lib/document/types.js, with the induced-joint vocabulary the connector
 * contract emits ('fixed' | 'revolute' | 'prismatic').
 */

import assert from 'node:assert/strict';

import {
    buildMateGraph, countDOF, detectLoops, classifyConstraint, findFloatingComponents,
} from '../assembly_constraints.js';
import { makeComponent, makeConnector, makeMate } from '../../../../lib/document/types.js';

let _pass = 0, _fail = 0;
function t(name, fn) {
    try { fn(); console.log(`  ok  ${name}`); _pass++; }
    catch (e) { console.error(`  FAIL ${name}\n    ${e?.stack || e?.message || e}`); _fail++; }
}

// ── Fixtures ────────────────────────────────────────────────────────────────

// A host connector lives on a component; the mate's host side references it by
// id, and `_hostComponentId` resolves the owning component via `parent`.
function hostConnector(id, parent, kind = 'planar') {
    return makeConnector({ id, parent, kind, locked: true });
}

// A mate edge between host component `hostComp` (via its connector `conId`) and
// part component `partComp`, carrying an induced joint kind.
function mate(id, conId, partComp, jointKind) {
    return makeMate({
        id,
        hostConnectorRef: { connectorId: conId },
        partConnectorRef: { connectorId: `${id}-part` },
        componentId: partComp,
        inducedJoint: { id: `jnt-${id}`, kind: jointKind },
    });
}

console.log('── global assembly constraint / DOF solver ──');

// ── 1. Two parts, one fixed mate → 0 mobility, exactly-constrained ───────────
t('2-part fixed mate: mobility 0, exactly-constrained', () => {
    const components = [
        makeComponent({ id: 'root', name: 'Document' }),
        makeComponent({ id: 'plate', name: 'Plate', parentId: 'root' }),
    ];
    const connectors = { 'c-root': hostConnector('c-root', 'root') };
    const mates = [mate('m1', 'c-root', 'plate', 'fixed')];

    const graph = buildMateGraph(components, mates, { connectors });
    assert.equal(graph.root, 'root');
    assert.equal(graph.edges.length, 1);
    assert.equal(graph.edges[0].joint, 'fixed');
    assert.equal(graph.edges[0].dof, 0);
    assert.equal(graph.edges[0].constraints, 6);

    const dof = countDOF(graph);
    // 2 bodies, one grounded → gross = 6·(2−1) = 6; fixed removes 6 → M = 0.
    assert.equal(dof.gross, 6);
    assert.equal(dof.constrained, 6);
    assert.equal(dof.remaining, 0);

    const cls = classifyConstraint(graph);
    assert.equal(cls.status, 'exactly-constrained');
    assert.equal(cls.mobility, 0);
    assert.deepEqual(findFloatingComponents(graph), []);
});

// ── 2. Shaft + bearing, one revolute mate → mobility 1 ───────────────────────
t('shaft + bearing revolute: mobility 1, under-constrained', () => {
    const components = [
        makeComponent({ id: 'root', name: 'Document' }),
        makeComponent({ id: 'shaft', name: 'Shaft', parentId: 'root' }),
    ];
    const connectors = { 'bore-root': hostConnector('bore-root', 'root', 'bore') };
    const mates = [mate('m-rev', 'bore-root', 'shaft', 'revolute')];

    const graph = buildMateGraph(components, mates, { connectors });
    assert.equal(graph.edges[0].joint, 'revolute');
    assert.equal(graph.edges[0].dof, 1);
    assert.equal(graph.edges[0].constraints, 5);

    const dof = countDOF(graph);
    // gross 6 − revolute removes 5 → M = 1 (the spin).
    assert.equal(dof.remaining, 1);

    const cls = classifyConstraint(graph);
    assert.equal(cls.status, 'under-constrained');
    assert.equal(cls.mobility, 1);
    assert.match(cls.reason, /1 free degree/);
});

// ── 3. Four-bar loop → detectLoops finds the cycle ───────────────────────────
t('4-bar loop: detectLoops finds the cycle of 4 bars', () => {
    // Ground → A → B → C → ground. Four revolute joints close a loop.
    const components = ['ground', 'barA', 'barB', 'barC'].map((id) =>
        makeComponent({ id, name: id, parentId: id === 'ground' ? null : 'ground' }));
    const connectors = {
        'g-a': hostConnector('g-a', 'ground', 'bore'),
        'a-b': hostConnector('a-b', 'barA', 'bore'),
        'b-c': hostConnector('b-c', 'barB', 'bore'),
        'c-g': hostConnector('c-g', 'ground', 'bore'),  // closes back to ground
    };
    const mates = [
        mate('m-ga', 'g-a', 'barA', 'revolute'),
        mate('m-ab', 'a-b', 'barB', 'revolute'),
        mate('m-bc', 'b-c', 'barC', 'revolute'),
        mate('m-cg', 'c-g', 'barC', 'revolute'),        // barC also mated to ground
    ];

    const graph = buildMateGraph(components, mates, { connectors, root: 'ground' });
    assert.equal(graph.edges.length, 4);

    const loops = detectLoops(graph);
    assert.equal(loops.length, 1, 'exactly one independent loop');
    const ring = loops[0].components;
    // The ring contains all four bodies of the closed chain.
    for (const id of ['ground', 'barA', 'barB', 'barC']) {
        assert.ok(ring.includes(id), `loop ring includes ${id} (got ${ring})`);
    }
    assert.equal(loops[0].edges.length, 4, 'loop closed by 4 edges');

    // 4-bar mobility (Grübler): n=4, one grounded → gross 18; four revolutes
    // remove 5 each = 20 → M = −2 by the rigid count. The classic planar 4-bar
    // is M=1 only because all joints are parallel-axis (planar) — the spatial
    // Grübler count here is intentionally the general 3-D one. We assert the
    // loop detection, the headline contract of this scenario.
    const dof = countDOF(graph);
    assert.equal(dof.bodies, 4);
    assert.equal(dof.joints, 4);

    // Determinism: same inputs → identical loop serialisation.
    const loops2 = detectLoops(buildMateGraph(components, mates, { connectors, root: 'ground' }));
    assert.deepEqual(loops2, loops);
});

// ── 4. Floating part → findFloatingComponents flags it ───────────────────────
t('floating part: no mate path to root is flagged', () => {
    const components = [
        makeComponent({ id: 'root', name: 'Document' }),
        makeComponent({ id: 'mounted', name: 'Mounted', parentId: 'root' }),
        makeComponent({ id: 'orphan', name: 'Orphan', parentId: 'root' }),  // never mated
    ];
    const connectors = { 'c-root': hostConnector('c-root', 'root') };
    const mates = [mate('m1', 'c-root', 'mounted', 'fixed')];   // only 'mounted' is mated

    const graph = buildMateGraph(components, mates, { connectors });
    const floating = findFloatingComponents(graph);
    assert.deepEqual(floating, ['orphan']);

    const cls = classifyConstraint(graph);
    assert.equal(cls.status, 'under-constrained');
    assert.deepEqual(cls.offenders.components, ['orphan']);
    assert.match(cls.reason, /float/);
});

// ── 5. Over-constraint: a loop of fixed joints is redundant ──────────────────
t('rigid loop (all-fixed) is over-constrained with offending mates', () => {
    const components = ['root', 'p1', 'p2'].map((id) =>
        makeComponent({ id, name: id, parentId: id === 'root' ? null : 'root' }));
    const connectors = {
        'r-1': hostConnector('r-1', 'root'),
        '1-2': hostConnector('1-2', 'p1'),
        'r-2': hostConnector('r-2', 'root'),   // a second weld closes a triangle
    };
    const mates = [
        mate('mA', 'r-1', 'p1', 'fixed'),
        mate('mB', '1-2', 'p2', 'fixed'),
        mate('mC', 'r-2', 'p2', 'fixed'),      // redundant: p2 already pinned via p1
    ];

    const graph = buildMateGraph(components, mates, { connectors });
    const loops = detectLoops(graph);
    assert.equal(loops.length, 1, 'one rigid loop');

    const cls = classifyConstraint(graph);
    assert.equal(cls.status, 'over-constrained');
    assert.ok(cls.offenders.mates.length >= 1, 'reports offending mate ids');
    assert.match(cls.reason, /[Oo]ver-constrained/);
});

// ── 6. Free placement (world host) anchors the part to ground ────────────────
t('free placement (world host) ties the part to ground, not floating', () => {
    const components = [
        makeComponent({ id: 'root', name: 'Document' }),
        makeComponent({ id: 'blob', name: 'Blob', parentId: 'root' }),
    ];
    const mates = [makeMate({
        id: 'm-free',
        hostConnectorRef: { world: { kind: 'planar', axis: [0, 0, 1], origin: [0, 0, 0] } },
        componentId: 'blob',
        inducedJoint: { kind: 'fixed' },
    })];
    const graph = buildMateGraph(components, mates, {});  // no connectors needed
    assert.equal(graph.edges.length, 1);
    assert.equal(graph.edges[0].a, 'root', 'world host resolves to grounded root');
    assert.deepEqual(findFloatingComponents(graph), []);
    assert.equal(classifyConstraint(graph).status, 'exactly-constrained');
});

console.log(`\n  ${_pass} passed, ${_fail} failed`);
if (_fail > 0) process.exit(1);
