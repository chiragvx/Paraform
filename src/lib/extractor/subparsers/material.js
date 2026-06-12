/**
 * Material subparser.
 *
 * Single MATERIAL token → one MaterialSpec constraint. Records an
 * AmbiguityNote when the lexicon entry has `needsGrade: true` (e.g. bare
 * "aluminum" without a grade); the spec 09 assumptions manifest will then
 * surface the default (`gradeDefault`) as overridable.
 */

import * as T from '../types.js';

export function parse(tokens, startIdx) {
    const t = tokens[startIdx];
    if (!t || t.kind !== 'MATERIAL') return null;

    const entry = t.data.entry;
    const constraint = T.material(entry.canonical);

    const ambiguities = [];
    if (entry.needsGrade) {
        ambiguities.push({
            kind: 'material-grade',
            detail: `${entry.canonical} grade unspecified (default: ${entry.gradeDefault ?? 'n/a'})`,
            field: 'material',
        });
    }

    return {
        constraints: [constraint],
        consumed: 1,
        ambiguities,
    };
}
