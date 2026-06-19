/**
 * Generator meta-tools — collapse the whole parametric-generator catalog behind
 * THREE constant tools instead of advertising N generators every turn.
 *
 *   list_generators(filter?)     → [{ kind, purpose }]   — discover what exists
 *   describe_generator(kind)     → { description, parameters, required }
 *   generate_part(kind, params)  → builds the part (delegates to the generator)
 *
 * Why this exists (token efficiency / unbounded growth):
 *   The generator catalog is the project's main growth vector — the roadmap adds
 *   dozens-to-hundreds more (brackets, mounts, pulleys, enclosures, …). If every
 *   generator is a top-level tool, the advertised surface — and the tokens paid
 *   on EVERY turn — grows linearly with the catalog. Behind these three
 *   meta-tools the advertised cost is O(1): three tools whether the catalog holds
 *   5 generators or 500. The per-kind parameter schema (the heavy part) is
 *   fetched on demand via describe_generator only when the model commits to a
 *   kind, instead of shipping all of them up front.
 *
 * The individual generators STILL exist in GENERATOR_TOOLS (so they remain in
 * AGENT_TOOLS and dispatchable by name for tests / direct calls / the keyword
 * triage path) — these meta-tools are an additional, always-on access route, not
 * a replacement of the registry.
 *
 * generate_part is build-gated in tools.js exactly like a direct generator call,
 * so it cannot fabricate a part past the clarify→plan→approve gate.
 */

import { GENERATOR_TOOLS } from './tools_generators.js';
import { S } from './tools_util.js';

// kind → generator tool. Indexed by the canonical name ('addBracket') AND by a
// few forgiving aliases (no 'add' prefix, lower-case) so the model can say
// "bracket" or "Bracket" and still land the right generator.
const _BY_KIND = new Map();
for (const t of GENERATOR_TOOLS) {
    if (!t || typeof t.name !== 'string') continue;
    _BY_KIND.set(t.name, t);
    _BY_KIND.set(t.name.toLowerCase(), t);
    const bare = t.name.replace(/^add/, '');
    _BY_KIND.set(bare, t);
    _BY_KIND.set(bare.toLowerCase(), t);
}

/** Resolve a loosely-typed kind to its generator, or null. */
function _resolve(kind) {
    if (typeof kind !== 'string' || !kind) return null;
    return _BY_KIND.get(kind) || _BY_KIND.get(kind.toLowerCase())
        || _BY_KIND.get(kind.replace(/^add/i, '')) || null;
}

/** First sentence (or ~110 chars) of a generator's description — the one-liner. */
function _purpose(desc) {
    const d = String(desc || '').trim();
    const m = d.match(/^.*?[.!](?:\s|$)/);
    const head = (m ? m[0] : d).trim();
    return head.length > 130 ? `${head.slice(0, 127)}…` : head;
}

/** Required-field list for a generator schema, for the describe payload + hints. */
function _required(t) {
    return (t && t.input_schema && Array.isArray(t.input_schema.required)) ? t.input_schema.required : [];
}

export const GENERATOR_META_TOOLS = [
    {
        name: 'list_generators',
        description:
            'List the parametric part GENERATORS available (each is a one-call, ready-to-print part — gear, bracket, mount, pulley, enclosure, holder, …). Returns { kind, purpose } per generator. Use this to discover the right kind, then describe_generator(kind) for its parameters, then generate_part(kind, params) to build it. Prefer a generator over hand-stacking primitives for any standard part.',
        input_schema: {
            type: 'object',
            properties: {
                filter: S('Optional substring to narrow the list (e.g. "gear", "mount", "box"). Matches the kind name.'),
            },
        },
        handler: ({ filter } = {}) => {
            const f = (typeof filter === 'string' && filter.trim()) ? filter.trim().toLowerCase() : null;
            const generators = GENERATOR_TOOLS
                .filter((t) => t && typeof t.name === 'string')
                .filter((t) => !f || t.name.toLowerCase().includes(f) || _purpose(t.description).toLowerCase().includes(f))
                .map((t) => ({ kind: t.name, purpose: _purpose(t.description) }));
            return { ok: true, count: generators.length, generators };
        },
    },
    {
        name: 'describe_generator',
        description:
            'Get the full description + parameter schema for ONE generator kind (names come from list_generators). Call this before generate_part when you are unsure of a generator\'s parameters or units.',
        input_schema: {
            type: 'object',
            properties: {
                kind: S('The generator kind, e.g. "addBracket" or "bracket" (from list_generators).'),
            },
            required: ['kind'],
        },
        handler: ({ kind } = {}) => {
            const t = _resolve(kind);
            if (!t) return { ok: false, error: `unknown generator kind '${kind}'. Call list_generators to see valid kinds.` };
            return {
                ok: true,
                kind: t.name,
                description: t.description,
                parameters: t.input_schema,
                required: _required(t),
            };
        },
    },
    {
        name: 'generate_part',
        description:
            'Build a parametric part in ONE call by kind + parameters. `kind` comes from list_generators (e.g. "addBracket"); `params` matches that kind\'s schema (see describe_generator). This is the preferred way to make any standard part — it produces a correct, ready-to-print body with the right features, instead of a stack of bare primitives. Verify with measure afterwards.',
        input_schema: {
            type: 'object',
            properties: {
                kind: S('The generator kind to build, e.g. "addBracket" (from list_generators).'),
                params: {
                    type: 'object',
                    description: 'Parameters for this kind — names/units per describe_generator(kind). Dimensions in mm.',
                },
            },
            required: ['kind'],
        },
        handler: ({ kind, params } = {}) => {
            const t = _resolve(kind);
            if (!t) return { ok: false, error: `unknown generator kind '${kind}'. Call list_generators to see valid kinds.` };
            const args = (params && typeof params === 'object' && !Array.isArray(params)) ? params : {};
            // Required-field pre-check so a weak model gets a pointed hint instead
            // of a deep build123d failure. The generator's own handler still does
            // the real validation + fail-safe emit.
            const missing = _required(t).filter((r) => args[r] === undefined || args[r] === null);
            if (missing.length) {
                return {
                    ok: false,
                    error: `generate_part(${t.name}) is missing required param(s): ${missing.join(', ')}. Call describe_generator("${t.name}") for the full schema.`,
                };
            }
            try {
                const r = t.handler(args);
                return (r && typeof r === 'object') ? r : { ok: true, result: r };
            } catch (e) {
                return { ok: false, error: `generate_part(${t.name}) failed: ${(e && e.message) || String(e)}` };
            }
        },
    },
];

export default GENERATOR_META_TOOLS;
