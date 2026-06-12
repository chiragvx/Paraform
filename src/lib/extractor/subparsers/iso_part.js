/**
 * ISO part subparser.
 *
 * Highest-priority subparser — runs before dimension so that "M3×16" is
 * read as a fastener (size + length) rather than a generic dimension
 * tuple, and so "608 bearing" survives the bearing-id classifier.
 *
 * Patterns:
 *   ISO_CODE                           → iso4762-m3-16 → catalog lookup
 *   ISO_CODE NUMBER                    → ISO 4762 M4 12 (rare; not implemented yet)
 *   M_X_LEN [SHCS|screw]               → iso4762-mX-Y
 *   M_SIZE [clearance|tap|thread]      → iso273-mX (clearance) / iso4762-mX
 *   M_SIZE [hole|screw|bolt]
 *   BEARING_ID [bearing]
 *
 * Quantifier handling — if a QUANTIFIER token immediately precedes (or
 * the SECOND-previous is QUANTIFIER and ISO part is preceded by a "places"
 * word), pull the count off it.
 *
 * Returns `{ constraints, consumed, leadingQuantifierConsumed }`.
 * `leadingQuantifierConsumed` lets the grammar know NOT to double-count
 * the quantifier that we backref'd into our constraint.
 */

import * as T from '../types.js';

const ROLE_WORDS = {
    'clearance': 'clearance',
    'clear':     'clearance',
    'tap':       'tap',
    'tapped':    'tap',
    'threaded':  'thread',
    'thread':    'thread',
    'through':   'clearance',
};

const FASTENER_WORDS = new Set([
    'shcs', 'screw', 'screws', 'bolt', 'bolts', 'cap', 'fastener', 'fasteners', 'machine',
]);

const HOLE_WORDS = new Set(['hole', 'holes']);

const BEARING_WORDS = new Set(['bearing', 'bearings']);

/** Look back across spaces / "places" / "of" for a leading quantifier.
 *  Returns `{idx, count}` or null. A bare NUMBER token immediately before
 *  a fastener also counts ("6 M6×20 SHCS" → qty=6). */
function findLeadingQuantifier(tokens, startIdx) {
    let look = startIdx - 1;
    let skipped = 0;
    while (look >= 0 && skipped < 3) {
        const tk = tokens[look];
        if (tk.kind === 'QUANTIFIER') return { idx: look, count: tk.data.count };
        // Bare NUMBER acting as a count, but ONLY if the immediately-preceding
        // token isn't another number (avoid eating a dimension's value).
        if (tk.kind === 'NUMBER' && (look === 0 || tokens[look - 1].kind !== 'NUMBER')) {
            // Don't gobble a dimension number — require absence of a following UNIT
            // between it and the fastener token. We're at startIdx; the token at
            // look+1 should NOT be a UNIT.
            const between = tokens.slice(look + 1, startIdx);
            const hasUnit = between.some((b) => b.kind === 'UNIT');
            if (!hasUnit) return { idx: look, count: tk.data.value };
        }
        if (tk.kind === 'PUNCT') { look--; continue; }
        if (tk.kind === 'WORD' && /^(of|x)$/i.test(tk.value)) { look--; skipped++; continue; }
        break;
    }
    return null;
}

/** Look forward for a trailing "N places" pattern (or bare " × N"). */
function findTrailingQuantifier(tokens, endIdxExclusive) {
    let i = endIdxExclusive;
    let scanned = 0;
    while (i < tokens.length && scanned < 6) {
        const tk = tokens[i];
        if (!tk) return null;
        // PUNCT '×' immediately followed by NUMBER = bare quantifier.
        if (tk.kind === 'PUNCT' && /[×x✕*]/.test(tk.value)) {
            const next = tokens[i + 1];
            if (next && next.kind === 'NUMBER') {
                return { idx: i, lastIdx: i + 1, count: next.data.value };
            }
            i++; scanned++; continue;
        }
        if (tk.kind === 'PUNCT') { i++; scanned++; continue; }
        // Filler words don't disqualify a trailing quantifier.
        if (tk.kind === 'WORD' && /^(at|the|of|in|on|across)$/i.test(tk.value)) {
            i++; scanned++; continue;
        }
        // "N places" / "N pcs" / "N×"
        if (tk.kind === 'NUMBER') {
            const next = tokens[i + 1];
            if (next && next.kind === 'WORD' && /^(places|pcs|pieces|qty|off)$/i.test(next.value)) {
                return { idx: i, lastIdx: i + 1, count: tk.data.value };
            }
            // "× 4" written as DIM_TUPLE-ish — the tokenizer collapses that into
            // a DIM_TUPLE only if both sides are numbers. After an ISO_CODE we
            // can see PUNCT × NUMBER; check that.
        }
        if (tk.kind === 'QUANTIFIER') {
            if (tk.data.count != null) return { idx: i, lastIdx: i, count: tk.data.count };
            i++; scanned++; continue;
        }
        // A SPATIAL_REL with an implicit count ("at the four corners" → 4)
        // also counts as a trailing quantifier. We don't claim the
        // SPATIAL_REL's tokens here — leave them for the spatial subparser.
        if (tk.kind === 'SPATIAL_REL' && tk.data.implicitCount != null) {
            return { idx: i, lastIdx: i - 1, count: tk.data.implicitCount, noConsume: true };
        }
        // Catch a bare "×N" pattern that survived as WORD/PUNCT.
        if ((tk.kind === 'WORD' && /^x$/i.test(tk.value)) ||
            (tk.kind === 'PUNCT' && /[×x✕*]/.test(tk.value))) {
            const next = tokens[i + 1];
            if (next && next.kind === 'NUMBER') {
                return { idx: i, lastIdx: i + 1, count: next.data.value };
            }
        }
        break;
    }
    return null;
}

/** Walk forward up to 4 tokens looking for a role word (clearance/tap) or
 *  fastener marker; returns the consumed count + a parsed { role, isFastener,
 *  isBearing, isHole }. */
function classifyTrailing(tokens, idx) {
    let i = idx;
    let role = null;
    let isFastener = false;
    let isBearing  = false;
    let isHole     = false;
    let extra = 0;
    for (let step = 0; step < 5 && i < tokens.length; step++) {
        const tk = tokens[i];
        // Only skip plain comma/period filler — '×' is a quantifier marker
        // and must reach the trailing-quantifier scan.
        if (tk.kind === 'PUNCT' && /[,;.:]/.test(tk.value)) { i++; extra++; continue; }
        if (tk.kind !== 'WORD') break;
        const w = tk.value.toLowerCase();
        if (Object.prototype.hasOwnProperty.call(ROLE_WORDS, w)) {
            role = ROLE_WORDS[w]; i++; extra++; continue;
        }
        if (FASTENER_WORDS.has(w))   { isFastener = true; i++; extra++; continue; }
        if (HOLE_WORDS.has(w))       { isHole = true; i++; extra++; continue; }
        if (BEARING_WORDS.has(w))    { isBearing = true; i++; extra++; continue; }
        break;
    }
    return { role, isFastener, isBearing, isHole, consumed: extra };
}

export function parse(tokens, startIdx) {
    const t = tokens[startIdx];
    if (!t) return null;

    let constraint = null;
    let consumed = 1;

    if (t.kind === 'ISO_CODE') {
        const { catalogPrefix, nominalSize, tail } = t.data;
        let length = null;
        if (tail && /^\d+$/.test(tail)) length = Number(tail);
        // If the very next token is M_SIZE or M_X_LEN, fold it into this
        // selection (e.g. "ISO 4762 M4×12" — ISO_CODE supplies prefix, the
        // M_X_LEN supplies size + length).
        const next = tokens[startIdx + 1];
        let ns = nominalSize;
        if (next && next.kind === 'M_X_LEN') {
            ns = next.data.nominalSize;
            length = next.data.length;
            consumed = 2;
        } else if (next && next.kind === 'M_SIZE') {
            ns = next.data.nominalSize;
            consumed = 2;
        }
        constraint = T.partSelection(catalogPrefix, ns, 1, null, length);
    } else if (t.kind === 'M_X_LEN') {
        constraint = T.partSelection('iso4762', t.data.nominalSize, 1, null, t.data.length);
    } else if (t.kind === 'M_SIZE') {
        constraint = T.partSelection('iso4762', t.data.nominalSize, 1, null, null);
    } else if (t.kind === 'BEARING_ID') {
        // Only commit if a bearing word follows OR a leading "bearing"/quantifier hint exists.
        const cl = classifyTrailing(tokens, startIdx + 1);
        if (!cl.isBearing) {
            // Also accept if a leading "bearings" word would follow later — but
            // for v1, require explicit context.
            return null;
        }
        constraint = T.partSelection('bearing', t.data.nominalSize, 1, null, null);
        consumed += cl.consumed;
        // Leading-quantifier merge
        const lq = findLeadingQuantifier(tokens, startIdx);
        if (lq && lq.count != null) constraint.qty = lq.count;
        return { constraints: [constraint], consumed, leadingQuantifierIdx: lq ? lq.idx : -1 };
    } else {
        return null;
    }

    // Trailing classifier
    const cl = classifyTrailing(tokens, startIdx + consumed);
    consumed += cl.consumed;

    if (cl.isBearing) constraint.catalogPrefix = 'bearing';
    if (cl.isHole && cl.role === 'clearance') {
        constraint.catalogPrefix = 'iso273';
        constraint.role = 'clearance';
    } else if (cl.isHole && cl.role === 'tap') {
        constraint.catalogPrefix = 'iso273';
        constraint.role = 'tap';
    } else if (cl.role) {
        constraint.role = cl.role;
    }
    // bare "M3 screws" → iso4762
    if (cl.isFastener && !cl.isHole) {
        constraint.catalogPrefix = 'iso4762';
    }

    // Trailing-quantifier merge ("M4×12, 2 places" / "×4")
    const tq = findTrailingQuantifier(tokens, startIdx + consumed);
    let trailingLastIdx = -1;
    if (tq && tq.count != null) {
        constraint.qty = tq.count;
        if (!tq.noConsume) trailingLastIdx = tq.lastIdx;
    }

    // Leading-quantifier merge
    const lq = findLeadingQuantifier(tokens, startIdx);
    if (lq && lq.count != null) constraint.qty = lq.count;

    // Extend `consumed` to swallow the trailing quantifier tokens too.
    if (trailingLastIdx >= 0) {
        consumed = (trailingLastIdx - startIdx) + 1;
    }

    return {
        constraints: [constraint],
        consumed,
        leadingQuantifierIdx: lq ? lq.idx : -1,
    };
}
