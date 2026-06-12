/**
 * Public entry point for the Phase 2b Layer 1 deterministic spec
 * extractor. See tracker/15-deterministic-extractor.md.
 *
 * `extract(specText): ExtractResult` is the one function downstream
 * consumers should call. Everything else (tokenizer, subparsers,
 * lexicons) is implementation detail.
 *
 * ExtractResult shape:
 *
 *   {
 *     constraints: Constraint[],
 *     residualText: string,          // for layer 3 (LLM residual)
 *     ambiguities: AmbiguityNote[],  // for spec 09 manifest
 *     spans: { [idx]: [start, end] } // source spans per constraint
 *   }
 *
 * Each Constraint carries a `_c` discriminator (see types.js) so callers
 * can `switch` on it without an `instanceof` chain. The tag also makes
 * the records serialisable as JSON — important since the repair loop
 * (spec 08) round-trips them into the LLM prompt as structured input.
 */

import { tokenize } from './tokenize.js';
import { parse }    from './grammar.js';

export { CONSTRAINT_KIND, DIMENSION_AXIS } from './types.js';

/**
 * @param {string} specText
 * @returns {{
 *   constraints: object[],
 *   residualText: string,
 *   ambiguities: object[],
 *   spans: Record<number, [number, number]>
 * }}
 */
export function extract(specText) {
    if (typeof specText !== 'string' || !specText.trim()) {
        return { constraints: [], residualText: '', ambiguities: [], spans: {} };
    }
    const tokens = tokenize(specText);
    const result = parse(tokens, specText);
    return result;
}
