/**
 * Dimension subparser.
 *
 * Recognises three shapes:
 *   1) DIM_TUPLE          → one Dimension per axis
 *   2) DIA + (NUMBER UNIT)?  Ø22, Ø22 mm
 *   3) NUMBER UNIT        → one Dimension, axis inferred from a nearby
 *                          keyword if available ("tall", "wide", "thick").
 *
 * Pure function over the token stream. Returns either
 *   { constraints: Constraint[], consumed: number }
 * or `null` if the token at `startIdx` doesn't start a dimension.
 *
 * The axis-inference rule is intentionally minimal — anything ambiguous
 * stays in residual text and feeds layer 3.
 */

import * as T from '../types.js';

/** Words that follow a NUMBER UNIT pair and label which axis it is. */
const AXIS_FOLLOWS = {
    'tall':       'height',
    'high':       'height',
    'height':     'height',
    'wide':       'width',
    'width':      'width',
    'long':       'length',
    'length':     'length',
    'deep':       'depth',
    'depth':      'depth',
    'thick':      'thickness',
    'thickness':  'thickness',
    'speed':      'speed',
};

const TUPLE_AXES = ['length', 'width', 'thickness'];

export function parse(tokens, startIdx) {
    const t = tokens[startIdx];
    if (!t) return null;

    if (t.kind === 'DIM_TUPLE') {
        // Pull off unit if it follows.
        const next = tokens[startIdx + 1];
        const unit = (next && next.kind === 'UNIT' && !next.data?.isLoad) ? next.data.unit : 'mm';
        const values = t.data.values;
        const constraints = values.map((v, i) =>
            T.dimension(TUPLE_AXES[i] ?? null, v, unit)
        );
        return {
            constraints,
            consumed: (next && next.kind === 'UNIT' && !next.data?.isLoad) ? 2 : 1,
        };
    }

    if (t.kind === 'DIA') {
        // Ø22 — optional UNIT next.
        const next = tokens[startIdx + 1];
        const unit = (next && next.kind === 'UNIT' && !next.data?.isLoad) ? next.data.unit : 'mm';
        const consumed = (next && next.kind === 'UNIT' && !next.data?.isLoad) ? 2 : 1;
        return {
            constraints: [T.dimension('diameter', t.data.value, unit)],
            consumed,
        };
    }

    if (t.kind === 'NUMBER') {
        const next = tokens[startIdx + 1];
        if (!next || next.kind !== 'UNIT') return null;
        if (next.data?.isLoad) return null; // load-units handled elsewhere

        // Try axis lookahead: NUMBER UNIT (PUNCT)? WORD-axis. Scan up to 3
        // words forward so "200 mm/s tool speed" → axis=speed.
        let axis = null;
        let consumed = 2;
        for (let off = 2; off <= 4; off++) {
            const after = tokens[startIdx + off];
            if (!after) break;
            if (after.kind === 'PUNCT') continue;
            if (after.kind !== 'WORD') break;
            const a = AXIS_FOLLOWS[after.value.toLowerCase()];
            if (a) { axis = a; break; }
        }

        // "40 mm cube" → leave axis null; resolver assigns from "cube".
        return {
            constraints: [T.dimension(axis, t.data.value, next.data.unit)],
            consumed,
        };
    }

    return null;
}
