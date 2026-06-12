/**
 * Fit-class subparser.
 *
 * Two paths:
 *   FIT_CLASS token  → constraint.class = "H7/g6"
 *   FIT_NAME token   → constraint.class = canonical lexicon slug
 *                       ('press' for "interference fit", "press fit", etc.)
 *
 * Eats a trailing "fit" word if present; the FIT_NAME tokens often already
 * include it from the lexicon. Returns null on no match.
 */

import * as T from '../types.js';

export function parse(tokens, startIdx) {
    const t = tokens[startIdx];
    if (!t) return null;

    if (t.kind === 'FIT_CLASS') {
        let consumed = 1;
        // optional trailing "fit"
        const next = tokens[startIdx + 1];
        if (next && next.kind === 'WORD' && /^fit$/i.test(next.value)) consumed++;
        return {
            constraints: [T.fitClass(t.data.class)],
            consumed,
        };
    }

    if (t.kind === 'FIT_NAME') {
        return {
            constraints: [T.fitClass(t.data.entry.canonical)],
            consumed: 1,
        };
    }

    return null;
}
