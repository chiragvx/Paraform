/**
 * Recipe meta-tools — collapse the structural-recipe catalog behind a small,
 * FIXED discovery surface so the advertised cost is O(1) as the recipe library
 * grows. Mirrors tools_generator_meta.js (the proven Tier-2 pattern).
 *
 *   list_recipes(filter?)        → [{ recipe, purpose }]      — discover what exists
 *   describe_recipe(recipe)      → { purpose, parameters, required }  — fetch ONE schema
 *   build_part_recipe(recipe,…)  → builds it (lives in tools_recipes.js)
 *
 * Why only two tools here (not three): unlike generators — which had 37 separate
 * direct tools to hide — recipes already route through ONE dispatch tool
 * (`build_part_recipe`). So the build verb stays where it is (slimmed), and this
 * module adds the discovery pair around it. The three together ARE the recipe
 * meta-surface.
 *
 * ── The recoverability contract (why this beats host-side tool retrieval) ──────
 *
 * On the OpenRouter / OpenAI-compatible path there is NO server-side tool search:
 * whatever sits in the request `tools` array is the model's entire tool universe
 * for that call, and the model cannot ask for a tool it can't see. Host-side
 * retrieval (embed → top-K → put in `tools`) has a fatal failure mode: if the
 * retriever misses, the capability is INVISIBLE and the model fakes it with
 * primitives or gives up — with no way to recover.
 *
 * These meta-tools dodge that because:
 *
 *   1. The `tools` array stays STATIC across a whole build. list_recipes /
 *      describe_recipe / build_part_recipe are advertised every turn, unchanged.
 *      Discovery happens through tool RESULTS (describe_recipe's return payload),
 *      NOT by mutating the advertised tool set. A stable `tools` prefix is also
 *      what keeps the prompt cache warm on the providers that cache (Claude /
 *      Gemini / DeepSeek / OpenAI via OpenRouter) — swapping tools mid-build
 *      would invalidate it.
 *
 *   2. A miss is recoverable in ONE extra model-driven hop. describe_recipe
 *      returns the full parameter schema as data; on an unknown name it returns a
 *      pointed error naming list_recipes. So the model can always search again
 *      (list_recipes), read the schema (describe_recipe), then build — entirely
 *      in-band, because the discovery tools are always present. The capability is
 *      never invisible the way a retrieval-miss would make it.
 *
 * This is the portable substrate: it works on every provider. Anthropic's
 * server-side tool_search is a strictly-better OVERLAY where available (in-band,
 * append-cached, no extra hop) — but a model that falls back to this path still
 * works, so we never depend on a provider-specific feature.
 */

import { RECIPE_NAMES, RECIPE_SPECS } from '../recipes/index.js';
import { S } from './tools_util.js';

/** Resolve a loosely-typed recipe name to its canonical key + spec, or null. */
function _resolve(recipe) {
    if (typeof recipe !== 'string' || !recipe) return null;
    const want = recipe.trim();
    if (RECIPE_SPECS[want]) return { name: want, spec: RECIPE_SPECS[want] };
    // forgiving: case-insensitive match against the canonical names
    const lc = want.toLowerCase();
    const hit = RECIPE_NAMES.find((n) => n.toLowerCase() === lc);
    return hit ? { name: hit, spec: RECIPE_SPECS[hit] } : null;
}

/** Build a real JSON-Schema `parameters` object from a recipe spec's param map. */
function _parameters(spec) {
    const properties = {};
    for (const [k, v] of Object.entries((spec && spec.params) || {})) {
        const prop = { type: v.type || 'number', description: v.description || '' };
        if (v.default !== undefined) prop.description += ` (default ${v.default})`;
        properties[k] = prop;
    }
    return { type: 'object', properties, additionalProperties: true };
}

export const RECIPE_META_TOOLS = [
    {
        name: 'list_recipes',
        description:
            'List the STRUCTURAL part RECIPES available — each is a part authored as f(the component it hosts, the load, its neighbours), so it reflows when the servo/load changes (servo mounts, links, clevises, ball sockets, body shells, vent grilles, …). Returns { recipe, purpose } per recipe. Use this to discover the right recipe, then describe_recipe(recipe) for its parameters, then build_part_recipe(recipe, params) to build it. Prefer a recipe over hand-writing a bracket for any of these archetypes.',
        input_schema: {
            type: 'object',
            properties: {
                filter: S('Optional substring to narrow the list (e.g. "servo", "joint", "shell"). Matches the recipe name or purpose.'),
            },
        },
        handler: ({ filter } = {}) => {
            const f = (typeof filter === 'string' && filter.trim()) ? filter.trim().toLowerCase() : null;
            const recipes = RECIPE_NAMES
                .map((name) => ({ recipe: name, purpose: (RECIPE_SPECS[name] && RECIPE_SPECS[name].purpose) || '' }))
                .filter((r) => !f || r.recipe.toLowerCase().includes(f) || r.purpose.toLowerCase().includes(f));
            return { ok: true, count: recipes.length, recipes };
        },
    },
    {
        name: 'describe_recipe',
        description:
            'Get the purpose + full parameter schema for ONE structural recipe (names come from list_recipes). Call this before build_part_recipe when you are unsure of a recipe\'s parameters or units. Every parameter has a sensible default, so you can also build with only the ones you want to override.',
        input_schema: {
            type: 'object',
            properties: {
                recipe: S('The recipe name, e.g. "servoMount" (from list_recipes).'),
            },
            required: ['recipe'],
        },
        handler: ({ recipe } = {}) => {
            const r = _resolve(recipe);
            if (!r) return { ok: false, error: `unknown recipe '${recipe}'. Call list_recipes to see valid recipe names.` };
            return {
                ok: true,
                recipe: r.name,
                purpose: r.spec.purpose,
                parameters: _parameters(r.spec),
                required: Array.isArray(r.spec.required) ? r.spec.required : [],
            };
        },
    },
];

export default RECIPE_META_TOOLS;
