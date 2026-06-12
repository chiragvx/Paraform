/**
 * Process subparser.
 *
 * PROCESS token → one ProcessHint constraint with the lexicon-canonical slug.
 */

import * as T from '../types.js';

export function parse(tokens, startIdx) {
    const t = tokens[startIdx];
    if (!t || t.kind !== 'PROCESS') return null;

    return {
        constraints: [T.process(t.data.entry.canonical)],
        consumed: 1,
    };
}
