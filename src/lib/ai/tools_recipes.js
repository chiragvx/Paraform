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
            'Instantiate a STRUCTURAL part from the parametric recipe library — the keystone of functional design: a part authored as f(the component it hosts, the load, its neighbours), so it reflows when the servo or load changes. ' +
            'PREFER this over hand-writing a bracket with writeBuildScript when the part is one of the archetypes below — the recipe already derives the hole pattern / envelope / wall from the inputs and exposes the load-bearing numbers as `# param` sliders. ' +
            'Recipes (pick one by `recipe`): ' +
            'servoMount (cradles a servo by its flange — hole pattern + body envelope derive from the servo dims, wall from load); ' +
            'legLink (a beam/link between two joints — length derives from neighbour spacing, end bores from the pivot pin); ' +
            'revoluteClevis (forked ears + coaxial pin bore for a single-axis revolute joint — slot derives from the mating tongue); ' +
            'ballSocket (a snap-fit spherical cup for a multi-DOF ball joint — socket radius derives from the ball); ' +
            'bodyShellWithBosses (a hollow chassis/casing with lid screw bosses — cavity is the electronics keep-out, wall from load); ' +
            'ventGrille (a louvred panel over a heat source — slot count/pitch derive from the open-area target). ' +
            'Pass per-recipe `params` to override any derived value (each becomes a slider). The result is a build123d 0.10 BuildScript (Z-up, mm, sandboxed) that auto-compiles; if it fails you get the kernel error and repair it with editBuildScript. ' +
            'Bind it to the component it serves via `componentId`. To give it snap points, declareConnector after it compiles (create-only / immutable).',
        input_schema: {
            type: 'object',
            properties: {
                recipe: {
                    type: 'string',
                    enum: RECIPE_NAMES,
                    description:
                        'Which recipe to instantiate. One of: ' + RECIPE_NAMES.join(', ') + '.',
                },
                params: {
                    type: 'object',
                    description:
                        'Recipe inputs that drive the f(component, load, neighbour) derivation. ' +
                        'Common keys: servo (a servo dims object, e.g. {bodyL,bodyW,bodyH,flangeEar,flangeZ,bossR,shaftR,mountHoleD}), ' +
                        'loadNm (joint load in Nm — drives wall thickness), clearance (printed mating clearance mm). ' +
                        'Per-recipe: legLink {lengthMm,boreD}; revoluteClevis {tongueW,pinD,baseW}; ballSocket {ballD,stemD}; ' +
                        'bodyShellWithBosses {innerL,innerW,innerH,screwD,bossCount}; ventGrille {panelL,panelW,slotCount,openFraction}. ' +
                        'Anything omitted falls back to a sensible (SG90-ish) default.',
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
