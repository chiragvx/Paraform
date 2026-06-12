/**
 * Spec 08 — repair loop.
 *
 * Run via:
 *   node --import ./src/lib/commands/__tests__/_register.mjs \
 *        src/lib/__tests__/spec08_repair.mjs
 *
 * Covers:
 *   1. constraint → ops mapping (Box, Cylinder, StandardPart, Material)
 *   2. single-iteration success path (deterministic extractor handles it)
 *   3. two-iteration repair path (first pass fails an invariant,
 *      mock LLM proposes the fix, second pass passes)
 *   4. max-iter cap
 *   5. telemetry append (JSONL round-trip)
 *   6. LLM client rule table behaviour
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { extract } from '$lib/extractor/index.js';
import { constraintsToOps } from '$lib/repair/constraint_to_ops.js';
import { runRepairLoop, applyOps, DEFAULT_MAX_ITER } from '$lib/repair/loop.js';
import {
    callLlmClient,
    setLlmClientForTests,
    proposeFix,
} from '$lib/repair/llm_client.js';
import { summariseRun, appendRepairRun } from '$lib/repair/telemetry.js';
import {
    resetDocumentStore,
    getDocumentStore,
} from '../../../lib/document/index.js';
import { CONSTRAINT_KIND, DIMENSION_AXIS } from '$lib/extractor/types.js';

let _pass = 0, _fail = 0;
function t(name, fn) {
    try {
        const r = fn();
        if (r && typeof r.then === 'function') {
            return r.then(
                () => { console.log(`  ok  ${name}`); _pass++; },
                (e) => { console.error(`  FAIL ${name}\n    ${e?.stack || e?.message || e}`); _fail++; },
            );
        }
        console.log(`  ok  ${name}`);
        _pass++;
    } catch (e) {
        console.error(`  FAIL ${name}\n    ${e?.stack || e?.message || e}`);
        _fail++;
    }
}

console.log('── spec 08 — repair loop ──');

const TESTS = [];

// 1. constraint → ops mapping ────────────────────────────────────────────────
TESTS.push(() => t('constraintsToOps: three unlabelled dims → addBox', () => {
    const constraints = [
        { _c: CONSTRAINT_KIND.DIMENSION, axis: null, value: 60, unit: 'mm' },
        { _c: CONSTRAINT_KIND.DIMENSION, axis: null, value: 40, unit: 'mm' },
        { _c: CONSTRAINT_KIND.DIMENSION, axis: null, value: 3,  unit: 'mm' },
    ];
    const { ops } = constraintsToOps(constraints);
    assert.equal(ops.length, 1);
    assert.equal(ops[0].kind, 'addBox');
    assert.equal(ops[0].params.length, 60);
    assert.equal(ops[0].params.width, 40);
    assert.equal(ops[0].params.height, 3);
}));

TESTS.push(() => t('constraintsToOps: diameter + length → addCylinder', () => {
    const constraints = [
        { _c: CONSTRAINT_KIND.DIMENSION, axis: DIMENSION_AXIS.DIAMETER, value: 10, unit: 'mm' },
        { _c: CONSTRAINT_KIND.DIMENSION, axis: DIMENSION_AXIS.HEIGHT,   value: 20, unit: 'mm' },
    ];
    const { ops } = constraintsToOps(constraints);
    assert.equal(ops.length, 1);
    assert.equal(ops[0].kind, 'addCylinder');
    assert.equal(ops[0].params.radius, 5);
    assert.equal(ops[0].params.height, 20);
}));

TESTS.push(() => t('constraintsToOps: part selection → addStandardPart with assembled entryId', () => {
    const constraints = [
        { _c: CONSTRAINT_KIND.PART_SELECTION, catalogPrefix: 'iso4762',
          nominalSize: 'M3', qty: 4, role: 'fastener', length: 16 },
    ];
    const { ops } = constraintsToOps(constraints);
    assert.equal(ops.length, 1);
    assert.equal(ops[0].kind, 'addStandardPart');
    assert.equal(ops[0].params.entryId, 'iso4762-m3-16');
    assert.equal(ops[0].params.qty, 4);
}));

TESTS.push(() => t('constraintsToOps: material follows a body op', () => {
    const constraints = [
        { _c: CONSTRAINT_KIND.DIMENSION, axis: null, value: 10, unit: 'mm' },
        { _c: CONSTRAINT_KIND.DIMENSION, axis: null, value: 10, unit: 'mm' },
        { _c: CONSTRAINT_KIND.DIMENSION, axis: null, value: 10, unit: 'mm' },
        { _c: CONSTRAINT_KIND.MATERIAL,  material: 'aluminum', grade: '6061' },
    ];
    const { ops, unmapped } = constraintsToOps(constraints);
    assert.equal(unmapped.length, 0);
    assert.equal(ops.length, 2);
    assert.equal(ops[1].kind, 'setMaterial');
    assert.equal(ops[1].params.material, 'aluminum');
    assert.equal(ops[1].params.grade, '6061');
}));

TESTS.push(() => t('constraintsToOps: material without a body lands in unmapped', () => {
    const constraints = [
        { _c: CONSTRAINT_KIND.MATERIAL, material: 'aluminum', grade: '6061' },
    ];
    const { ops, unmapped } = constraintsToOps(constraints);
    assert.equal(ops.length, 0);
    assert.equal(unmapped.length, 1);
}));

TESTS.push(() => t('constraintsToOps: inch units convert to mm', () => {
    const constraints = [
        { _c: CONSTRAINT_KIND.DIMENSION, axis: null, value: 1, unit: 'in' },
        { _c: CONSTRAINT_KIND.DIMENSION, axis: null, value: 2, unit: 'in' },
        { _c: CONSTRAINT_KIND.DIMENSION, axis: null, value: 0.5, unit: 'in' },
    ];
    const { ops } = constraintsToOps(constraints);
    assert.equal(ops[0].kind, 'addBox');
    assert.equal(ops[0].params.length, 25.4);
    assert.equal(ops[0].params.width, 50.8);
}));

TESTS.push(() => t('constraintsToOps: spatial constraints surface as unmapped', () => {
    const constraints = [
        { _c: CONSTRAINT_KIND.SPATIAL, target: 'holes', datum: 'each-corner', offset: 5, count: 4 },
    ];
    const { ops, unmapped } = constraintsToOps(constraints);
    assert.equal(ops.length, 0);
    assert.equal(unmapped.length, 1);
}));

// 2. applyOps lands features on the doc ──────────────────────────────────────
TESTS.push(() => t('applyOps: addBox + setMaterial stamps material on the right feature', () => {
    resetDocumentStore();
    const { applied, errors } = applyOps([
        { kind: 'addBox', params: { length: 10, width: 10, height: 10 } },
        { kind: 'setMaterial', params: { material: 'aluminum', grade: '6061', target: 'lastBody' } },
    ]);
    assert.equal(errors.length, 0);
    assert.equal(applied.length, 2);
    const doc = getDocumentStore().doc;
    const features = Object.values(doc.features || {});
    assert.equal(features.length, 1);
    assert.equal(features[0].type, 'Box');
    assert.equal(features[0].params.material, 'aluminum 6061');
}));

TESTS.push(() => t('applyOps: setMaterial with no body returns op error (not throw)', () => {
    resetDocumentStore();
    const { errors } = applyOps([
        { kind: 'setMaterial', params: { material: 'aluminum', target: 'lastBody' } },
    ]);
    assert.equal(errors.length, 1);
}));

// 3. End-to-end loop: success in one pass when extractor + invariants OK ─────
TESTS.push(() => t('runRepairLoop: warnings-only first pass still reports success', async () => {
    // Simple cube spec — the deterministic mapper produces the box op,
    // and we stub invariants to return only warnings so the loop's
    // "errors === 0 ⇒ pass" rule fires.
    const r = await runRepairLoop({
        specText: '10×10×10 mm cube',
        runDfm: async () => ({ pass: true, warnings: [], errors: [] }),
        runInvariants: async () => ({
            pass: false,
            warnings: [{ id: 'i-material-assigned', result: { severity: 'warning', message: 'no material' } }],
            errors: [],
            byScope: {},
        }),
    });
    assert.equal(r.success, true);
    assert.ok(r.iterations.length >= 1);
}));

// 4. Two-iteration repair path ────────────────────────────────────────────────
TESTS.push(() => t('runRepairLoop: first pass fails invariant, LLM patches, second pass passes', async () => {
    // We fake an invariant runner that fails on first call (no material),
    // passes on second call (material set). The mock LLM produces a
    // setMaterial op via its rule table.
    let invCalls = 0;
    const fakeInvariants = async (_ctx) => {
        invCalls++;
        if (invCalls === 1) {
            return {
                pass: false,
                warnings: [],
                errors: [{
                    id: 'i-material-assigned',
                    scope: 'per-feature',
                    targetId: null,
                    result: { ok: false, severity: 'error', message: 'no material' },
                }],
                byScope: {},
            };
        }
        return { pass: true, warnings: [], errors: [], byScope: {} };
    };

    const r = await runRepairLoop({
        specText: '10×10×10 mm cube',
        runInvariants: fakeInvariants,
        maxIter: 3,
    });
    assert.equal(r.success, true);
    assert.equal(r.iterations.length, 2);
    assert.equal(r.llmCalls, 1);
    // Patch op should be a setMaterial coming from the rule table.
    const patch = r.iterations[1].failures; // last iter
    assert.ok(r.iterations[0].patchOps.length >= 1);
    assert.equal(r.iterations[0].patchOps[0].kind, 'setMaterial');
    void patch;
}));

// 5. Max-iter cap ────────────────────────────────────────────────────────────
TESTS.push(() => t('runRepairLoop: gives up after maxIter when failures persist', async () => {
    const everFailing = async () => ({
        pass: false,
        warnings: [],
        errors: [{
            id: 'i-material-assigned',
            scope: 'per-feature',
            result: { ok: false, severity: 'error', message: 'still no material' },
        }],
        byScope: {},
    });
    const r = await runRepairLoop({
        specText: '10×10×10 mm cube',
        runInvariants: everFailing,
        maxIter: 2,
    });
    assert.equal(r.success, false);
    assert.equal(r.iterations.length, 2);
    // One LLM call per attempted repair = (maxIter - 1) when the loop
    // bails because failures don't clear.
    assert.ok(r.llmCalls >= 1);
}));

TESTS.push(() => t('runRepairLoop: empty LLM proposal short-circuits the loop', async () => {
    const everFailing = async () => ({
        pass: false,
        warnings: [],
        errors: [{
            id: 'unrecognised-failure',
            result: { ok: false, severity: 'error', message: 'no rule for this' },
        }],
        byScope: {},
    });
    const r = await runRepairLoop({
        specText: '10×10×10 mm cube',
        runInvariants: everFailing,
        maxIter: 5,
    });
    // No matching rule → LLM returns ops:[]. Loop bails after the first
    // LLM call without burning the remaining budget.
    assert.equal(r.success, false);
    assert.equal(r.llmCalls, 1);
    assert.equal(r.iterations.length, 1);
}));

// 6. LLM client rule table ────────────────────────────────────────────────────
TESTS.push(() => t('proposeFix: missing material → setMaterial 6061', async () => {
    const { ops, rationale } = await proposeFix({
        goal: 'cube',
        failures: [{ id: 'i-material-assigned', targetId: 'feat_1' }],
    });
    assert.equal(ops.length, 1);
    assert.equal(ops[0].kind, 'setMaterial');
    assert.equal(ops[0].params.grade, '6061');
    assert.equal(ops[0].params.target, 'feat_1');
    assert.match(rationale, /ruleMissingMaterial/);
}));

TESTS.push(() => t('proposeFix: missing process → setProcess 3d-print', async () => {
    const { ops } = await proposeFix({
        goal: 'cube',
        failures: [{ id: 'i-process-assigned' }],
    });
    assert.equal(ops.length, 1);
    assert.equal(ops[0].kind, 'setProcess');
    assert.equal(ops[0].params.process, '3d-print');
}));

TESTS.push(() => t('proposeFix: zero-radius fillet → setFeatureParams with default radius', async () => {
    const { ops } = await proposeFix({
        goal: 'fillet',
        failures: [{ id: 'i-fillet-radius-positive', targetId: 'feat_xy' }],
    });
    assert.equal(ops.length, 1);
    assert.equal(ops[0].kind, 'setFeatureParams');
    assert.equal(ops[0].params.patch.radius, 1);
}));

TESTS.push(() => t('proposeFix: unrecognised failure → no ops', async () => {
    const { ops, rationale } = await proposeFix({
        goal: 'x',
        failures: [{ id: 'i-something-else' }],
    });
    assert.equal(ops.length, 0);
    assert.match(rationale, /no matching rule/);
}));

TESTS.push(() => t('setLlmClientForTests: override is honoured by callLlmClient', async () => {
    setLlmClientForTests(async () => ({ ops: [{ kind: 'noop', params: {} }], rationale: 'fake' }));
    const r = await callLlmClient({ goal: '', failures: [] });
    assert.equal(r.ops.length, 1);
    assert.equal(r.rationale, 'fake');
    setLlmClientForTests(null);
}));

// 7. Telemetry append ────────────────────────────────────────────────────────
TESTS.push(() => t('summariseRun: extracts the headline fields', () => {
    const sum = summariseRun({
        success: true,
        iterations: [{ iter: 0 }, { iter: 1 }],
        llmCalls: 1,
        failures: [{ severity: 'warning' }],
        coverage: { mapped: 3, total: 4 },
        unmapped: [{}],
    }, { goal: 'g' });
    assert.equal(sum.ok, true);
    assert.equal(sum.iterations, 2);
    assert.equal(sum.llmCalls, 1);
    assert.equal(sum.finalFailureCount, 1);
    assert.equal(sum.finalErrorCount, 0);
    assert.equal(sum.unmappedCount, 1);
    assert.equal(sum.goal, 'g');
}));

TESTS.push(() => t('appendRepairRun: round-trips through JSONL', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paraform-repair-'));
    const target = path.join(dir, 'runs.jsonl');
    const r1 = await appendRepairRun({ ts: 1, ok: true }, { path: target });
    assert.equal(r1.ok, true);
    const r2 = await appendRepairRun({ ts: 2, ok: false }, { path: target });
    assert.equal(r2.ok, true);
    const body = await fs.readFile(target, 'utf8');
    const lines = body.trim().split('\n');
    assert.equal(lines.length, 2);
    const j0 = JSON.parse(lines[0]);
    const j1 = JSON.parse(lines[1]);
    assert.equal(j0.ts, 1);
    assert.equal(j1.ok, false);
    await fs.rm(dir, { recursive: true, force: true });
}));

// 8. End-to-end runRepairLoop on the worked extractor example ────────────────
TESTS.push(() => t('runRepairLoop: extractor worked example produces ops', async () => {
    const r = await runRepairLoop({
        specText: '60×40×3 mm aluminum plate with four M3 clearance holes at the corners, 5 mm from each edge',
        runDfm: async () => ({ pass: true, warnings: [], errors: [] }),
        // Skip invariant runs that would need a kernel — the constraint → ops mapper is the unit under test here.
        runInvariants: async () => ({ pass: true, warnings: [], errors: [], byScope: {} }),
    });
    assert.equal(r.success, true);
    // Should produce a box op and at least one standard-part op.
    const kinds = r.ops.map((o) => o.kind);
    assert.ok(kinds.includes('addBox'));
    assert.ok(kinds.includes('addStandardPart'));
}));

TESTS.push(() => t('runRepairLoop: DEFAULT_MAX_ITER is 3', () => {
    assert.equal(DEFAULT_MAX_ITER, 3);
}));

// ── Driver ──
for (const fn of TESTS) await fn();

console.log(`\n  ${_pass} passed, ${_fail} failed`);
process.exit(_fail > 0 ? 1 : 0);
