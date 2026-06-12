/**
 * Kinematic subparser.
 *
 * Recognises:
 *   DOF KINEMATIC                  → 4-DOF SCARA
 *   KINEMATIC DOF                  → SCARA, 4-DOF (rare; supported)
 *   KINEMATIC                      → bare; uses lexicon `defaultDof`
 *
 * Also handles load follow-on:
 *   ... payload 5 kg               → emits a LOAD constraint when payload-
 *                                    word followed by NUMBER UNIT(load).
 *
 * Load handling is split out into its own micro-parser inside this file —
 * it lives with kinematic because that's where load specs most often
 * appear in real text ("4-DOF arm payload 5 kg").
 */

import * as T from '../types.js';

const PAYLOAD_WORDS = new Set(['payload', 'load', 'capacity']);

export function parse(tokens, startIdx) {
    const t = tokens[startIdx];
    if (!t) return null;

    let mechanism = null;
    let dof = null;
    let consumed = 0;

    if (t.kind === 'DOF') {
        // DOF KINEMATIC?
        const next = tokens[startIdx + 1];
        if (next && next.kind === 'KINEMATIC') {
            mechanism = next.data.entry.canonical;
            dof = t.data.dof;
            consumed = 2;
        } else if (next && next.kind === 'WORD' && /^(arm|robot|stage|manipulator)$/i.test(next.value)) {
            // "6-DOF arm" — lexicon entry for six-axis-arm covers it
            mechanism = dof === 6 ? 'six-axis-arm' : null;
            // Map to family by DOF count when no explicit lexicon hit
            dof = t.data.dof;
            mechanism = dof === 6 ? 'six-axis-arm' : 'arm';
            consumed = 2;
        } else {
            // bare DOF — leave for residual
            return null;
        }
    } else if (t.kind === 'KINEMATIC') {
        mechanism = t.data.entry.canonical;
        dof = t.data.entry.defaultDof ?? null;
        consumed = 1;
        // KINEMATIC DOF?
        const next = tokens[startIdx + 1];
        if (next && next.kind === 'DOF') {
            dof = next.data.dof;
            consumed = 2;
        } else if (next && next.kind === 'WORD' && /^with$/i.test(next.value)) {
            const after = tokens[startIdx + 2];
            if (after && after.kind === 'DOF') {
                dof = after.data.dof;
                consumed = 3;
            }
        }
    } else {
        return null;
    }

    if (!mechanism) return null;

    const constraints = [T.kinematic(mechanism, dof)];

    // Look ahead a few tokens for a "payload N kg" pattern.
    const loadCs = tryParseLoad(tokens, startIdx + consumed);
    if (loadCs) {
        constraints.push(loadCs.constraint);
        consumed += loadCs.consumed;
    }

    return { constraints, consumed };
}

function tryParseLoad(tokens, startIdx) {
    // Walk up to 4 tokens forward, skipping PUNCT, looking for PAYLOAD_WORD
    let i = startIdx;
    let scanned = 0;
    while (i < tokens.length && scanned < 4) {
        const tk = tokens[i];
        if (!tk) return null;
        if (tk.kind === 'PUNCT' || (tk.kind === 'WORD' && /^(and|of)$/i.test(tk.value))) {
            i++; scanned++; continue;
        }
        if (tk.kind === 'WORD' && PAYLOAD_WORDS.has(tk.value.toLowerCase())) {
            const nm = tokens[i + 1];
            const un = tokens[i + 2];
            if (nm && nm.kind === 'NUMBER' && un && un.kind === 'UNIT' && un.data.isLoad) {
                return {
                    constraint: T.load(nm.data.value, 'static', un.data.unit),
                    consumed: (i - startIdx) + 3,
                };
            }
            return null;
        }
        break;
    }
    return null;
}
