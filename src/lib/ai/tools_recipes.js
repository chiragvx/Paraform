/**
 * Part-Recipe tool — instantiate a parametric structural part from the recipe
 * library (src/lib/recipes/index.js) as a BuildScript feature.
 *
 * THE KEYSTONE (PLAN-functional-design-brain.md §3): every structural part is
 * authored as `part = f(hosted component, load, neighbours)` in CODE, so it
 * REFLOWS when the hosted servo / load changes. A recipe turns a small,
 * checkable input (`{ recipe, params }`) into a full build123d source string;
 * this tool runs that source down the SAME path as writeBuildScript so the
 * result is an ordinary, tunable BuildScript feature (its load-bearing numbers
 * surface as `# param` sliders).
 *
 * It is a thin wrapper over tools_code.js's mechanism on purpose: same
 * guardScript pre-check, same addBuildScript commit, same never-throw tool
 * contract and write-op result envelope. The recipe is the value-add; the
 * plumbing is reused.
 */

import { addBuildScript } from '../../../lib/document/index.js';
import { guardScript } from './script_guard.js';
import { S } from './tools_util.js';
import { buildRecipeSource, RECIPE_NAMES } from '../recipes/index.js';

export const RECIPE_TOOLS = [
    {
        name: 'build_part_recipe',
        description:
            'Instantiate a STRUCTURAL part from the parametric recipe library — a part authored as f(the component it hosts, the load, its neighbours), so it reflows when the servo or load changes. ' +
            'PREFER this over hand-writing a bracket with writeBuildScript for any standard structural archetype. ' +
            'DISCOVER recipes with list_recipes and read their parameters with describe_recipe(recipe); every param has a default, so `params` is optional and each value you pass becomes a `# param` slider. ' +
            'The result is a sandboxed build123d BuildScript (Z-up, mm) that auto-compiles — on failure you get the kernel error and repair with editBuildScript. ' +
            'Bind it via `componentId`; add snap points with declareConnector after it compiles.',
        input_schema: {
            type: 'object',
            properties: {
                recipe: S('Which recipe to instantiate (a name from list_recipes, e.g. "servoMount"). Validated at runtime; on a wrong name you get the valid list back.'),
                params: {
                    type: 'object',
                    description: 'Recipe inputs that drive the f(component, load, neighbour) derivation — names/units per describe_recipe(recipe). Anything omitted falls back to a sensible default.',
                    additionalProperties: true,
                },
                name: S('Optional display name for the part (defaults to the recipe name)'),
                componentId: S('Target component id to bind the part to (default: active / root)'),
            },
            required: ['recipe'],
        },
        handler: (i) => {
            const recipe = String((i && i.recipe) || '');
            if (!RECIPE_NAMES.includes(recipe)) {
                return {
                    ok: false,
                    error: `unknown recipe '${recipe}' — choose one of: ${RECIPE_NAMES.join(', ')}`,
                };
            }
            const params = (i && i.params && typeof i.params === 'object') ? i.params : {};

            let code;
            try {
                code = buildRecipeSource(recipe, params);
            } catch (err) {
                return { ok: false, error: `recipe '${recipe}' failed to generate code: ${String((err && err.message) || err)}` };
            }
            if (typeof code !== 'string' || code.length === 0) {
                return { ok: false, error: `recipe '${recipe}' produced no source` };
            }

            // Same pre-check writeBuildScript runs — fast, specific feedback.
            const g = guardScript(code);
            if (!g.ok) return { ok: false, error: g.error };

            const name = (i && i.name) ? String(i.name) : recipe;
            let f;
            try {
                f = addBuildScript({ code, name, componentId: i && i.componentId });
            } catch (err) {
                return { ok: false, error: `addBuildScript threw: ${String((err && err.message) || err)}` };
            }
            if (!f || !f.id) return { ok: false, error: 'addBuildScript did not return a feature' };

            return {
                ok: true,
                featureId: f.id,
                name: f.name,
                recipe,
                summary: `Recipe ${recipe} -> BuildScript ${f.name}`,
            };
        },
    },
];

export default RECIPE_TOOLS;
