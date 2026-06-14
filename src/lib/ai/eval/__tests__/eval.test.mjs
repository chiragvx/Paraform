/**
 * Eval substrate tests.
 *
 * Run via:
 *   node src/lib/ai/eval/__tests__/eval.test.mjs
 *
 * Pure + offline — these import only the eval modules (which import only each
 * other), so no kernel, no $lib alias, no register hook is needed. Covers:
 *   1. scorer scores a PASSING DocResult and a FAILING one correctly, and the
 *      assembly checks (mateSolved / inducedJoint / swapStable) work.
 *   2. data_synth is deterministic — same index twice → byte-identical JSON,
 *      and every synthesized triplet's program uses real tool names.
 *   3. verifyTriplet gates on executed geometry (keep on match, drop on mismatch).
 *   4. the benchmark suite is well-formed and the scoreboard renders.
 */

import assert from 'node:assert/strict';

import { scoreTask, scoreCheck, scoreSuite } from '../scorer.js';
import { synthTriplet, synthDataset, verifyTriplet } from '../data_synth.js';
import { BENCHMARK_TASKS } from '../benchmark/tasks.js';
import { formatScoreboard, aggregate } from '../scoreboard.js';

let _pass = 0, _fail = 0;
function t(name, fn) {
    try { fn(); console.log(`  ok  ${name}`); _pass++; }
    catch (e) { console.error(`  FAIL ${name}\n    ${e?.stack || e?.message || e}`); _fail++; }
}

console.log('── AI eval substrate ──');

// The real tool names a synthesized program is allowed to reference.
const REAL_TOOLS = new Set([
    'addBox', 'addCylinder', 'addSphere', 'addExtrude', 'addRevolve',
    'addHole', 'addSketch', 'addFillet', 'addChamfer', 'addShell',
    'placeLibraryPart', 'declareConnector', 'add_mate', 'replace_component',
]);

// ── 1. scorer: passing vs failing ────────────────────────────────────────────

t('scorer: a fully-conforming DocResult passes every check', () => {
    const task = {
        id: 'cube',
        spec: {
            acceptance: [
                { kind: 'bbox', axis: 'x', size: 20 },
                { kind: 'bbox', axis: 'z', size: 20 },
                { kind: 'solidCount', equals: 1 },
                { kind: 'volume', equals: 8000, tol: 1 },
            ],
            negative: [{ kind: 'holeCount', equals: 0 }],
            assembly: [],
        },
    };
    const docResult = {
        bbox: { min: [-10, -10, 0], max: [10, 10, 20] },
        solidCount: 1,
        volume: 8000,
        holeCount: 0,
    };
    const score = scoreTask(task, docResult);
    assert.equal(score.passed, true, JSON.stringify(score.failures));
    assert.equal(score.total, 5);
    assert.equal(score.passedCount, 5);
    assert.equal(score.score, 1);
});

t('scorer: a wrong-size / extra-hole DocResult fails the right checks', () => {
    const task = {
        id: 'cube',
        spec: {
            acceptance: [
                { kind: 'bbox', axis: 'x', size: 20 },
                { kind: 'solidCount', equals: 1 },
            ],
            negative: [{ kind: 'holeCount', equals: 0 }],
            assembly: [],
        },
    };
    const docResult = {
        bbox: { min: [0, 0, 0], max: [25, 25, 25] },  // 25, not 20
        solidCount: 1,
        holeCount: 2,                                  // should be 0
    };
    const score = scoreTask(task, docResult);
    assert.equal(score.passed, false);
    assert.equal(score.total, 3);
    assert.equal(score.passedCount, 1);   // only solidCount passes
    const failedKinds = score.failures.map((f) => f.check.kind).sort();
    assert.deepEqual(failedKinds, ['bbox', 'holeCount']);
});

t('scorer: a missing measured field fails closed (does not crash or pass)', () => {
    const r = scoreCheck({ kind: 'noInterference' }, {});  // interference never measured
    assert.equal(r.passed, false);
    assert.equal(r.actual, 'not measured');
});

t('scorer: assembly checks — mateSolved / inducedJoint', () => {
    const docOk = { mates: [{ solved: true, inducedJoint: 'prismatic' }] };
    assert.equal(scoreCheck({ kind: 'mateSolved' }, docOk).passed, true);
    assert.equal(scoreCheck({ kind: 'inducedJoint', equals: 'prismatic' }, docOk).passed, true);
    assert.equal(scoreCheck({ kind: 'inducedJoint', equals: 'revolute' }, docOk).passed, false);

    const docUnsolved = { mates: [{ solved: false, inducedJoint: 'prismatic' }] };
    assert.equal(scoreCheck({ kind: 'mateSolved' }, docUnsolved).passed, false);

    // No mates at all → mateSolved fails closed (nothing to solve isn't a pass).
    assert.equal(scoreCheck({ kind: 'mateSolved' }, { mates: [] }).passed, false);
});

t('scorer: assembly checks — swapStable / casingBossAligned', () => {
    assert.equal(scoreCheck({ kind: 'swapStable' }, { swapStable: true }).passed, true);
    assert.equal(scoreCheck({ kind: 'swapStable' }, { swapStable: false }).passed, false);
    assert.equal(scoreCheck({ kind: 'swapStable' }, {}).passed, false);

    const bosses = { casingBosses: [{ aligned: true }, { aligned: true }, { aligned: true }, { aligned: true }] };
    assert.equal(scoreCheck({ kind: 'casingBossAligned', equals: 4 }, bosses).passed, true);
    assert.equal(scoreCheck({ kind: 'casingBossAligned', equals: 4 },
        { casingBosses: [{ aligned: true }, { aligned: false }] }).passed, false);
});

t('scorer: mustNotHaveHoleAt — passes when absent, fails when a hole is present there', () => {
    const clean = { holes: [{ origin: [0, 0, 0] }] };
    assert.equal(scoreCheck({ kind: 'mustNotHaveHoleAt', origin: [40, 40, 0] }, clean).passed, true);
    const dirty = { holes: [{ origin: [40, 40, 0] }] };
    assert.equal(scoreCheck({ kind: 'mustNotHaveHoleAt', origin: [40, 40, 0] }, dirty).passed, false);
});

t('scorer: unknown check kind fails closed', () => {
    const r = scoreCheck({ kind: 'totallyMadeUp' }, {});
    assert.equal(r.passed, false);
});

// ── 2. data_synth determinism ────────────────────────────────────────────────

t('data_synth: synthTriplet(i) is byte-identical across calls', () => {
    for (const i of [0, 1, 2, 3, 4, 7, 13, 42, 99]) {
        const a = JSON.stringify(synthTriplet(i));
        const b = JSON.stringify(synthTriplet(i));
        assert.equal(a, b, `triplet ${i} differs between calls`);
    }
});

t('data_synth: synthDataset is deterministic and covers all families', () => {
    const d1 = JSON.stringify(synthDataset(20));
    const d2 = JSON.stringify(synthDataset(20));
    assert.equal(d1, d2, 'dataset not reproducible');

    // 20 triplets over 5 families → at least one of each family prefix appears.
    const ids = synthDataset(20).map((x) => x.id.replace(/-\d+$/, ''));
    for (const fam of ['synth-cube', 'synth-plate', 'synth-rod', 'synth-extrusion', 'synth-bearing']) {
        assert.ok(ids.includes(fam), `family ${fam} missing from dataset`);
    }
});

t('data_synth: every triplet is well-formed and uses real tool names', () => {
    for (const tr of synthDataset(25)) {
        assert.equal(typeof tr.id, 'string');
        assert.ok(tr.id.length > 0);
        assert.equal(typeof tr.prompt, 'string');
        assert.ok(tr.prompt.length > 0);
        assert.ok(Array.isArray(tr.typedOpProgram) && tr.typedOpProgram.length > 0);
        for (const op of tr.typedOpProgram) {
            assert.ok(REAL_TOOLS.has(op.tool), `triplet ${tr.id} uses unknown tool ${op.tool}`);
            assert.equal(typeof op.input, 'object');
        }
        const spec = tr.acceptanceSpec;
        assert.ok(spec && Array.isArray(spec.acceptance));
        assert.ok(Array.isArray(spec.negative) && Array.isArray(spec.assembly));
    }
});

t('data_synth: assembly triplets carry connectors + mates + a joint assertion', () => {
    // index 3 is the bolt-into-extrusion family (3 % 5 === 3).
    const tr = synthTriplet(3);
    assert.match(tr.id, /^synth-extrusion-/);
    const tools = tr.typedOpProgram.map((o) => o.tool);
    assert.ok(tools.includes('declareConnector'), 'has a declareConnector op');
    assert.ok(tools.includes('add_mate'), 'has an add_mate op');
    const jointCheck = tr.acceptanceSpec.assembly.find((c) => c.kind === 'inducedJoint');
    assert.ok(jointCheck, 'asserts an inducedJoint');
    assert.ok(['fixed', 'prismatic'].includes(jointCheck.equals));
});

// ── 3. verifyTriplet keep-gate ───────────────────────────────────────────────

t('verifyTriplet: KEEPS a triplet whose executed geometry matches its spec', () => {
    const tr = synthTriplet(0);   // a cube
    const s = tr.acceptanceSpec.acceptance.find((c) => c.kind === 'volume');
    const side = Math.cbrt(s.equals);
    const docResult = {
        bbox: { min: [-side / 2, -side / 2, 0], max: [side / 2, side / 2, side] },
        solidCount: 1,
        volume: s.equals,
        holeCount: 0,
    };
    const v = verifyTriplet(tr, docResult);
    assert.equal(v.ok, true, JSON.stringify(v.failures));
    assert.equal(v.score, 1);
});

t('verifyTriplet: DROPS a triplet whose executed geometry does NOT match', () => {
    const tr = synthTriplet(0);   // a cube
    const docResult = {
        bbox: { min: [0, 0, 0], max: [5, 5, 5] },  // wrong size
        solidCount: 2,                              // wrong count
        volume: 125,
        holeCount: 1,                               // negative-check violation
    };
    const v = verifyTriplet(tr, docResult);
    assert.equal(v.ok, false);
    assert.ok(v.failures.length > 0);
});

// ── 4. benchmark suite + scoreboard ──────────────────────────────────────────

t('benchmark: suite is well-formed (ids unique, prompts + specs present)', () => {
    assert.ok(Array.isArray(BENCHMARK_TASKS));
    assert.ok(BENCHMARK_TASKS.length >= 10, `expected >= 10 tasks, got ${BENCHMARK_TASKS.length}`);
    const seen = new Set();
    let hasAssembly = false;
    for (const task of BENCHMARK_TASKS) {
        assert.equal(typeof task.id, 'string');
        assert.ok(!seen.has(task.id), `duplicate task id ${task.id}`);
        seen.add(task.id);
        assert.equal(typeof task.prompt, 'string');
        assert.ok(task.prompt.length > 0);
        const spec = task.spec || {};
        assert.ok(Array.isArray(spec.acceptance) && spec.acceptance.length > 0,
            `${task.id} has acceptance checks`);
        if (Array.isArray(spec.assembly) && spec.assembly.length) hasAssembly = true;
    }
    assert.ok(hasAssembly, 'at least one task carries assembly checks');
});

t('scoreboard: aggregate + markdown render over a mixed suite', () => {
    // Score the whole benchmark against an empty result map → all fail closed.
    const scores = scoreSuite(BENCHMARK_TASKS, {});
    const agg = aggregate(scores);
    assert.equal(agg.tasks, BENCHMARK_TASKS.length);
    assert.equal(agg.passed, 0, 'empty results fail every task closed');
    assert.equal(agg.passRate, 0);

    const md = formatScoreboard(scores, { title: 'Test run', stamp: 'unit-test' });
    assert.match(md, /# Test run/);
    assert.match(md, /Tasks passed:/);
    assert.match(md, /Single-part metrics/);
    // Every task id should appear as a row.
    for (const task of BENCHMARK_TASKS) assert.ok(md.includes(task.id), `${task.id} in scoreboard`);
});

// ── summary ──────────────────────────────────────────────────────────────────
console.log(`\n${_pass} passed, ${_fail} failed`);
if (_fail > 0) process.exit(1);
