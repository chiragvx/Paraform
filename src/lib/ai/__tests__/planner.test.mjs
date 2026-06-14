/**
 * Connector-aware decomposition planner tests.
 *
 * Verifies that buildAssemblyPlan emits the canonical seam order for a real
 * multi-part assembly, that a custom-built part gets a declareConnector step
 * BEFORE its mate, that every mate is followed by a verify and the plan ends in
 * a whole-assembly verify, and that the planner is deterministic (byte-identical
 * output for identical input — no Date/random). Also exercises the plan_assembly
 * tool wrapper and summarizePlan.
 *
 * Run via:
 *   node --import ./src/lib/commands/__tests__/_register.mjs \
 *        src/lib/ai/__tests__/planner.test.mjs
 */
import assert from 'node:assert/strict';

import { buildAssemblyPlan, summarizePlan, PLAN_KIND_ORDER } from '$lib/ai/planner.js';
import { PLANNER_TOOLS } from '$lib/ai/tools_planner.js';

let _pass = 0, _fail = 0;
async function t(name, fn) {
    try { await fn(); console.log(`  ok  ${name}`); _pass++; }
    catch (e) { console.error(`  FAIL ${name}\n    ${e?.stack || e?.message || e}`); _fail++; }
}

console.log('── Connector-aware decomposition planner ──');

/** Pull the ordered list of step kinds out of a plan. */
const kindsOf = (plan) => plan.steps.map((s) => s.kind);

await t('2-part bolted assembly: place bolt, place nut, mate, verify in canonical order', () => {
    const plan = buildAssemblyPlan({
        goal: 'M5 bolt and nut clamping two plates',
        parts: [
            { name: 'bolt', source: 'library', mates: [{ to: 'nut', via: 'thread' }] },
            { name: 'nut', source: 'library' },
        ],
    });
    assert.equal(plan.template, false, 'a part list yields a concrete (non-template) plan');
    const kinds = kindsOf(plan);

    // First step is always the decomposition.
    assert.equal(kinds[0], 'decompose', 'plan starts by decomposing the goal');

    // Both library parts are PLACED (not built), then the seam is mated, then verified.
    assert.deepEqual(kinds, ['decompose', 'place', 'place', 'mate', 'verify', 'verify'],
        `unexpected kind order: ${kinds.join(' → ')}`);

    // No declareConnector for an all-library assembly (parts ship connectors).
    assert.ok(!kinds.includes('declareConnector'), 'library-only parts need no connector declaration');

    // Step ids are sequential 1..N integers.
    plan.steps.forEach((s, idx) => assert.equal(s.step, idx + 1, 'sequential integer step ids'));

    // The mate depends on BOTH endpoints (the bolt place AND the nut place).
    const mate = plan.steps.find((s) => s.kind === 'mate');
    const placeIds = plan.steps.filter((s) => s.kind === 'place').map((s) => s.step);
    for (const id of placeIds) {
        assert.ok(mate.dependsOn.includes(id), `mate must depend on place step ${id}`);
    }

    // The final step is the whole-assembly verify and depends on the mate.
    const last = plan.steps[plan.steps.length - 1];
    assert.equal(last.kind, 'verify');
    assert.ok(last.dependsOn.includes(mate.step), 'final verify depends on the mate');
});

await t('custom-built part yields a declareConnector step BEFORE its mate', () => {
    const plan = buildAssemblyPlan({
        goal: 'custom bracket bolted onto a base plate',
        parts: [
            { name: 'base', source: 'build' },
            { name: 'bracket', source: 'build', mates: [{ to: 'base', via: 'bore' }] },
        ],
    });
    const steps = plan.steps;

    // Each built part gets build → declareConnector.
    const bracketBuild = steps.find((s) => s.kind === 'build' && s.part === 'bracket');
    const bracketDecl = steps.find((s) => s.kind === 'declareConnector' && s.part === 'bracket');
    assert.ok(bracketBuild, 'bracket has a build step');
    assert.ok(bracketDecl, 'bracket has a declareConnector step');
    assert.ok(bracketDecl.step > bracketBuild.step, 'declareConnector comes after build');
    assert.ok(bracketDecl.dependsOn.includes(bracketBuild.step), 'declareConnector depends on the build');

    // The mate comes AFTER both parts have declared their connectors.
    const mate = steps.find((s) => s.kind === 'mate');
    assert.ok(mate, 'there is a mate step');
    assert.ok(mate.step > bracketDecl.step, 'mate runs after the connector is declared');
    assert.ok(mate.dependsOn.includes(bracketDecl.step),
        'mate depends on the custom part connector being declared first');
    const baseDecl = steps.find((s) => s.kind === 'declareConnector' && s.part === 'base');
    assert.ok(mate.dependsOn.includes(baseDecl.step), 'mate also depends on the host connector being declared');

    // Every mate is immediately followed by a verify of that seam.
    const mateIdx = steps.indexOf(mate);
    assert.equal(steps[mateIdx + 1].kind, 'verify', 'a verify follows each mate');
});

await t('a verify follows every mate, plus one final whole-assembly verify', () => {
    const plan = buildAssemblyPlan({
        goal: 'three-part stack',
        parts: [
            { name: 'a', source: 'library' },
            { name: 'b', source: 'library', mates: [{ to: 'a', via: 'planar' }] },
            { name: 'c', source: 'library', mates: [{ to: 'b', via: 'planar' }] },
        ],
    });
    const mates = plan.steps.filter((s) => s.kind === 'mate');
    const verifies = plan.steps.filter((s) => s.kind === 'verify');
    assert.equal(mates.length, 2, 'two seams → two mates');
    // one verify per mate + one final whole-assembly verify.
    assert.equal(verifies.length, mates.length + 1, 'a verify per mate plus a final assembly verify');
    assert.equal(plan.steps[plan.steps.length - 1].kind, 'verify', 'plan ends on a verify');
});

await t('channel seam (slot/rail) is flagged as a prismatic-inducing mate', () => {
    const plan = buildAssemblyPlan({
        goal: 'sliding nut in a 2020 extrusion',
        parts: [
            { name: 'extrusion', source: 'library' },
            { name: 'tnut', source: 'library', mates: [{ to: 'extrusion', via: 'slot' }] },
        ],
    });
    const mate = plan.steps.find((s) => s.kind === 'mate');
    assert.ok(/prismatic/i.test(mate.detail), 'a slot/rail seam mate mentions the prismatic joint');
});

await t('template plan (no parts) keeps the canonical order and is marked template', () => {
    const plan = buildAssemblyPlan({ goal: 'some complex multi-part thing' });
    assert.equal(plan.template, true, 'no parts → template plan');
    const kinds = kindsOf(plan);
    // Every canonical kind appears exactly in order.
    assert.deepEqual(kinds, ['decompose', 'place', 'build', 'declareConnector', 'mate', 'verify', 'verify'],
        `template kinds out of order: ${kinds.join(' → ')}`);
    // The template's declareConnector still precedes the mate.
    const declIdx = kinds.indexOf('declareConnector');
    const mateIdx = kinds.indexOf('mate');
    assert.ok(declIdx < mateIdx, 'declareConnector before mate in the template too');
    assert.deepEqual(PLAN_KIND_ORDER, ['decompose', 'place', 'build', 'declareConnector', 'mate', 'verify']);
});

await t('determinism: identical input → byte-identical plan (no Date / random)', () => {
    const input = {
        goal: 'M5 bolt and nut clamping two plates',
        parts: [
            { name: 'bolt', source: 'library', mates: [{ to: 'nut', via: 'thread' }] },
            { name: 'nut', source: 'library' },
            { name: 'plate', source: 'build', mates: [{ to: 'bolt', via: 'bore' }] },
        ],
    };
    const a = JSON.stringify(buildAssemblyPlan(input));
    const b = JSON.stringify(buildAssemblyPlan(input));
    assert.equal(a, b, 'two runs of the same input must be byte-identical');
    // And the summary is deterministic too.
    assert.equal(
        summarizePlan(buildAssemblyPlan(input)),
        summarizePlan(buildAssemblyPlan(input)),
    );
});

await t('summarizePlan renders a markdown checklist; empty plan is handled', () => {
    const plan = buildAssemblyPlan({
        goal: 'bolt and nut',
        parts: [{ name: 'bolt', source: 'library', mates: [{ to: 'nut', via: 'thread' }] }, { name: 'nut', source: 'library' }],
    });
    const md = summarizePlan(plan);
    assert.ok(md.includes('Assembly plan'), 'has a heading');
    assert.ok(md.includes('- [ ]'), 'is a markdown checklist');
    assert.ok(/1\. decompose/.test(md), 'lists the decompose step');
    assert.equal(summarizePlan(null), '_(empty plan)_', 'null plan handled gracefully');
    assert.equal(summarizePlan({ steps: [] }), '_(empty plan)_', 'empty steps handled gracefully');
});

await t('PLANNER_TOOLS exposes plan_assembly in the standard tool shape', async () => {
    assert.ok(Array.isArray(PLANNER_TOOLS) && PLANNER_TOOLS.length === 1, 'one planner tool');
    const tool = PLANNER_TOOLS[0];
    assert.equal(tool.name, 'plan_assembly');
    assert.equal(typeof tool.description, 'string');
    assert.ok(tool.input_schema && tool.input_schema.type === 'object', 'object input_schema');
    assert.equal(typeof tool.handler, 'function', 'has a handler');

    // Handler happy path.
    const ok = await tool.handler({
        goal: 'M5 bolt and nut',
        parts: [{ name: 'bolt', source: 'library', mates: [{ to: 'nut', via: 'thread' }] }, { name: 'nut', source: 'library' }],
    });
    assert.equal(ok.ok, true, ok.error);
    assert.ok(ok.plan && Array.isArray(ok.plan.steps), 'returns a plan');
    assert.ok(typeof ok.summary === 'string' && ok.summary.length, 'returns a summary');

    // Missing goal → graceful failure, never throws.
    const bad = await tool.handler({});
    assert.equal(bad.ok, false, 'missing goal is rejected');
    assert.ok(/goal/i.test(bad.error), 'error mentions the goal');

    // Omitting parts → template plan.
    const tmpl = await tool.handler({ goal: 'something multi-part' });
    assert.equal(tmpl.ok, true);
    assert.equal(tmpl.plan.template, true, 'no parts → template plan from the tool');
});

console.log(`\n${_pass} passed, ${_fail} failed`);
if (_fail) process.exit(1);
