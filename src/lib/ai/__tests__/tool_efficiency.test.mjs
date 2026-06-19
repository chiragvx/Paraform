/**
 * Tool-surface efficiency tests — the three tiers that keep the AI tool block
 * cheap and bounded as the catalog grows:
 *
 *   Tier 1 — Anthropic prompt caching: the (stable, ~30k-token) tools block and
 *            the rolling conversation prefix carry cache_control breakpoints so
 *            iterations 2..N of a build read them at ~10% cost instead of
 *            re-billing them in full.
 *   Tier 2 — Generator meta-tools: the whole parametric-generator catalog is
 *            reachable through THREE constant tools (list/describe/generate), so
 *            the advertised surface is O(1) regardless of catalog size, and
 *            generate_part is build-gated like a direct generator.
 *   Tier 3 — Triage: individual generators are advertised only when named; the
 *            meta-tools + core surface stay on; web tools are cue-gated.
 *
 * Run standalone:
 *   node --import ./src/lib/commands/__tests__/_register.mjs \
 *        src/lib/ai/__tests__/tool_efficiency.test.mjs
 * Also wired into lib/document/__tests__/all.mjs (npm test).
 */
import assert from 'node:assert/strict';

import { AGENT_TOOLS, evaluateBuildGate } from '../tools.js';
import { getProvider } from '../providers/index.js';
import { selectAgentTools } from '../agent.js';
import { GENERATOR_TOOLS } from '../tools_generators.js';
import { GENERATOR_META_TOOLS } from '../tools_generator_meta.js';
import { RECIPE_TOOLS } from '../tools_recipes.js';
import { RECIPE_META_TOOLS } from '../tools_recipe_meta.js';
import { RECIPE_NAMES, RECIPE_SPECS } from '../../recipes/index.js';

// Call the meta-tool handlers directly (not through dispatchTool) so these stay
// isolation-safe in the shared all.mjs harness — no build-gate, no plan-graph
// coupling, no mutation of the singleton document store.
const _meta = new Map(GENERATOR_META_TOOLS.map((t) => [t.name, t.handler]));
const listGenerators = _meta.get('list_generators');
const describeGenerator = _meta.get('describe_generator');
const generatePart = _meta.get('generate_part');

const _rmeta = new Map(RECIPE_META_TOOLS.map((t) => [t.name, t.handler]));
const listRecipes = _rmeta.get('list_recipes');
const describeRecipe = _rmeta.get('describe_recipe');

let _pass = 0, _fail = 0;
async function t(name, fn) {
    try { await fn(); console.log(`  ok  ${name}`); _pass++; }
    catch (e) { console.error(`  FAIL ${name}\n    ${e?.stack || e?.message || e}`); _fail++; }
}

console.log('── tool-surface efficiency (caching · meta-tools · triage) ──');

// ── Tier 1 — prompt caching ───────────────────────────────────────────────────

await t('Tier1: anthropic.toolsForProvider marks ONLY the last tool with cache_control', () => {
    const anthropic = getProvider('anthropic');
    const tools = anthropic.toolsForProvider(AGENT_TOOLS);
    assert.equal(tools.length, AGENT_TOOLS.length, 'count preserved');
    const withCC = tools.filter((x) => x.cache_control);
    assert.equal(withCC.length, 1, 'exactly one cache breakpoint on the tools block');
    assert.deepEqual(tools[tools.length - 1].cache_control, { type: 'ephemeral' }, 'last tool is the breakpoint');
    assert.ok(!tools[0].cache_control, 'first tool is not marked');
    // Schema still passes through intact (caching must not disturb the contract).
    assert.ok(tools[tools.length - 1].input_schema, 'last tool keeps its input_schema');
});

await t('Tier1: anthropic.buildBody puts a rolling cache breakpoint on the last message block', () => {
    const anthropic = getProvider('anthropic');
    const history = [];
    anthropic.appendToolResults(history, [{ id: 'tu-1', name: 'addBox', result: { ok: true } }]);
    const { body } = anthropic.buildBody({
        system: 'sys', history, tools: [], model: 'claude-opus-4-8', maxTokens: 100, stream: false,
    });
    const last = body.messages[body.messages.length - 1];
    const block = last.content[last.content.length - 1];
    assert.deepEqual(block.cache_control, { type: 'ephemeral' }, 'last block of last message is cached');
    assert.equal(block.type, 'tool_result', 'breakpoint sits on the real content block, not a wrapper');
});

await t('Tier1: a plain string-content message is left untouched (nowhere to hang a marker)', () => {
    const anthropic = getProvider('anthropic');
    const history = [{ role: 'user', text: 'make a cube' }];
    const { body } = anthropic.buildBody({
        system: 'sys', history, tools: [], model: 'claude-opus-4-8', maxTokens: 100, stream: false,
    });
    const last = body.messages[body.messages.length - 1];
    assert.equal(typeof last.content, 'string', 'string content stays a string');
});

// ── Tier 2 — generator meta-tools ─────────────────────────────────────────────

await t('Tier2: the three meta-tools are registered in AGENT_TOOLS', () => {
    const names = new Set(AGENT_TOOLS.map((x) => x.name));
    for (const n of ['list_generators', 'describe_generator', 'generate_part']) {
        assert.ok(names.has(n), `AGENT_TOOLS missing ${n}`);
    }
});

await t('Tier2: list_generators returns the catalog as { kind, purpose }', () => {
    const r = listGenerators({});
    assert.ok(r.ok && Array.isArray(r.generators), 'returns a generators array');
    assert.equal(r.generators.length, GENERATOR_TOOLS.length, 'one entry per catalog generator');
    assert.ok(r.generators.every((g) => typeof g.kind === 'string' && typeof g.purpose === 'string'));
    // filter narrows the list
    const f = listGenerators({ filter: 'bracket' });
    assert.ok(f.ok && f.generators.length >= 1 && f.generators.length < r.generators.length, 'filter narrows');
    assert.ok(f.generators.some((g) => /bracket/i.test(g.kind)));
});

await t('Tier2: describe_generator returns the parameter schema for a kind (forgiving alias)', () => {
    const byName = describeGenerator({ kind: 'addBracket' });
    assert.ok(byName.ok && byName.parameters && byName.parameters.type === 'object', 'schema returned');
    assert.equal(byName.kind, 'addBracket', 'canonical kind echoed');
    // bare/lower-case alias resolves to the same generator
    const byAlias = describeGenerator({ kind: 'bracket' });
    assert.ok(byAlias.ok && byAlias.kind === 'addBracket', 'alias "bracket" resolves');
    const bad = describeGenerator({ kind: 'definitelyNotAGenerator' });
    assert.ok(!bad.ok && /unknown generator/i.test(bad.error), 'unknown kind → helpful error');
});

await t('Tier2: generate_part validates required params and reports a pointed hint', () => {
    // addPulley requires `diameter`; empty params → required pre-check fires
    // BEFORE the handler runs (so nothing is built / no store mutation).
    const missing = generatePart({ kind: 'addPulley', params: {} });
    assert.ok(!missing.ok, 'missing required param is rejected');
    assert.ok(/required|missing|describe_generator/i.test(missing.error), 'pointed hint');
    assert.match(missing.error, /diameter/, 'names the missing field');
    const unknown = generatePart({ kind: 'nope', params: {} });
    assert.ok(!unknown.ok && /unknown generator/i.test(unknown.error), 'unknown kind → error');
});

await t('Tier2: generate_part is build-gated (cannot be a hole through the approval gate)', () => {
    // The gate keys on the tool NAME, so generate_part must be treated as a
    // creator: a multi-node UNAPPROVED plan blocks it, exactly like a direct
    // generator call.
    const blocked = evaluateBuildGate('generate_part', { planNodes: 3, planApproved: false });
    assert.ok(blocked && /not approved/i.test(blocked.error), 'unapproved plan blocks generate_part');
    const allowed = evaluateBuildGate('generate_part', { planNodes: 3, planApproved: true });
    assert.equal(allowed, null, 'approved plan lets it through');
});

// ── Tier 2b — recipe meta-tools (catalog collapsed behind discovery) ──────────

await t('Tier2b: list_recipes + describe_recipe are registered in AGENT_TOOLS', () => {
    const names = new Set(AGENT_TOOLS.map((x) => x.name));
    for (const n of ['list_recipes', 'describe_recipe', 'build_part_recipe']) {
        assert.ok(names.has(n), `AGENT_TOOLS missing ${n}`);
    }
});

await t('Tier2b: RECIPE_SPECS stays in lock-step with the recipe registry', () => {
    // Every recipe has metadata and vice-versa — drift here is a silent
    // describe_recipe gap, so assert the two sets are identical.
    assert.deepEqual(
        new Set(Object.keys(RECIPE_SPECS)),
        new Set(RECIPE_NAMES),
        'RECIPE_SPECS keys must match RECIPE_NAMES exactly',
    );
});

await t('Tier2b: list_recipes returns the catalog as { recipe, purpose }', () => {
    const r = listRecipes({});
    assert.ok(r.ok && Array.isArray(r.recipes), 'returns a recipes array');
    assert.equal(r.recipes.length, RECIPE_NAMES.length, 'one entry per recipe');
    assert.ok(r.recipes.every((x) => typeof x.recipe === 'string' && typeof x.purpose === 'string' && x.purpose.length));
    const f = listRecipes({ filter: 'servo' });
    assert.ok(f.ok && f.recipes.length >= 1 && f.recipes.length < r.recipes.length, 'filter narrows');
    assert.ok(f.recipes.some((x) => /servo/i.test(x.recipe) || /servo/i.test(x.purpose)));
});

await t('Tier2b: describe_recipe returns a real parameter schema (forgiving alias)', () => {
    const d = describeRecipe({ recipe: 'servoMount' });
    assert.ok(d.ok && d.parameters && d.parameters.type === 'object', 'schema returned');
    assert.equal(d.recipe, 'servoMount', 'canonical name echoed');
    assert.ok(d.parameters.properties && d.parameters.properties.loadNm, 'param properties present');
    assert.ok(typeof d.purpose === 'string' && d.purpose.length, 'purpose present');
    // case-insensitive alias resolves to the same recipe
    const alias = describeRecipe({ recipe: 'SERVOMOUNT' });
    assert.ok(alias.ok && alias.recipe === 'servoMount', 'alias resolves');
});

await t('Tier2b: a describe miss is recoverable in one hop (points back to list_recipes)', () => {
    // The recoverability contract: an unknown name does not dead-end — it returns
    // a pointed error naming list_recipes, so the model can search again in-band.
    const miss = describeRecipe({ recipe: 'notARecipe' });
    assert.ok(!miss.ok, 'unknown recipe rejected');
    assert.match(miss.error, /unknown recipe/i, 'explains the miss');
    assert.match(miss.error, /list_recipes/i, 'names the recovery tool');
});

await t('Tier2b: build_part_recipe is SLIM — the per-recipe catalog moved to describe_recipe', () => {
    // The whole point: the always-on build tool must NOT inline every recipe's
    // parameter docs (that is the O(N) growth we removed). It should be small and
    // point at the discovery tools instead.
    const bpr = AGENT_TOOLS.find((x) => x.name === 'build_part_recipe');
    assert.ok(bpr, 'build_part_recipe present');
    const wire = JSON.stringify(bpr);
    // Pointer to the discovery surface is present...
    assert.match(bpr.description, /describe_recipe/, 'points at describe_recipe');
    // ...and the inlined per-recipe param catalog is gone (a tell-tale of the old
    // fat description was listing recipe-specific param objects inline).
    assert.ok(!/innerL,\s*innerW,\s*innerH/.test(bpr.description), 'no inlined per-recipe param catalog');
    assert.ok(!Array.isArray(bpr.input_schema.properties.recipe.enum), 'recipe is a free string (O(1)), not a growing enum');
    // Budget: a slim build tool serialises well under the old fat one (~2.76k
    // chars / ~838 tok). Guards against the catalog creeping back into the
    // always-on description.
    assert.ok(wire.length < 1600, `build_part_recipe should be slim, got ${wire.length} chars`);
});

// ── Tier 3 — triage ───────────────────────────────────────────────────────────

await t('Tier3: an unnamed generator is NOT advertised, but the meta-tools + core are', () => {
    const advertised = new Set(selectAgentTools(AGENT_TOOLS, 'make me a phone stand').map((x) => x.name));
    // meta-tools always on
    for (const n of ['list_generators', 'describe_generator', 'generate_part']) {
        assert.ok(advertised.has(n), `meta-tool ${n} should always be advertised`);
    }
    // a niche generator not named in the request is withheld (reachable via generate_part)
    assert.ok(!advertised.has('addAuger'), 'unnamed niche generator is withheld');
    // core editing/observe tools stay on
    assert.ok(advertised.has('addBox'), 'core primitive stays advertised');
    // recipe discovery + build stay on (the recipe catalog is reachable every turn)
    for (const n of ['list_recipes', 'describe_recipe', 'build_part_recipe']) {
        assert.ok(advertised.has(n), `recipe surface ${n} should always be advertised`);
    }
});

await t('Tier3: a generator named in the request IS advertised directly', () => {
    const advertised = new Set(selectAgentTools(AGENT_TOOLS, 'I need a battery holder').map((x) => x.name));
    assert.ok(advertised.has('addBatteryHolder'), 'named generator surfaces directly');
});

await t('Tier3: web tools are cue-gated', () => {
    const noCue = new Set(selectAgentTools(AGENT_TOOLS, 'extrude this sketch 5mm').map((x) => x.name));
    assert.ok(!noCue.has('web_search'), 'web_search withheld with no research cue');
    const withCue = new Set(selectAgentTools(AGENT_TOOLS, 'search for the NEMA 17 datasheet online').map((x) => x.name));
    assert.ok(withCue.has('web_search'), 'web_search advertised when research is implied');
});

console.log(`\n${_pass} passed, ${_fail} failed`);
if (typeof process !== 'undefined' && process.exitCode === undefined && _fail > 0) process.exitCode = 1;
export const ok = _fail === 0;
