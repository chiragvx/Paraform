/**
 * Grammar driver — composes the subparsers into one walk over the token
 * stream.
 *
 * Strategy: at each cursor position, try subparsers in priority order
 * (highest density / most-structured first). On first match, splice the
 * resulting constraint(s) into the output, jump the cursor past the
 * consumed tokens, mark them. On no match, the token is "unconsumed" — it
 * gets stitched back into `residualText` for layer 3 (LLM residual
 * compiler).
 *
 * Priority order (per spec):
 *   1. iso_part  — fastener callouts (highest density)
 *   2. fit_class — H7/g6, press fit
 *   3. kinematic — SCARA / DOF / mechanism
 *   4. dimension — 60×40×3, Ø22, "5 mm"
 *   5. spatial   — "5 mm from each edge", "centered"
 *   6. tolerance — ±0.05, IT7 (handled inline; no subparser file
 *                  because the tokenizer already produces the typed payload)
 *   7. material  — lexicon match
 *   8. process   — lexicon match
 *
 * Backref handling — iso_part can claim a leading QUANTIFIER (e.g. "four"
 * one token before "M3 clearance"). When that happens, the grammar marks
 * the quantifier as consumed too, even though it's BEFORE the iso_part's
 * own start. This keeps it out of `residualText`.
 *
 * Constraint spans are recorded for every emitted constraint so the
 * downstream UI can underline source text.
 */

import * as ISOPart    from './subparsers/iso_part.js';
import * as FitClass   from './subparsers/fit_class.js';
import * as Tolerance  from './subparsers/tolerance.js';
import * as Kinematic  from './subparsers/kinematic.js';
import * as Dimension  from './subparsers/dimension.js';
import * as Spatial    from './subparsers/spatial.js';
import * as Material   from './subparsers/material.js';
import * as Process    from './subparsers/process.js';
import * as T          from './types.js';

// Priority order matters. iso_part is highest density. Spatial runs BEFORE
// dimension because a "5 mm from each edge" pattern would otherwise lose
// its "5 mm" to the dimension parser before spatial gets a chance to grab
// it as an offset.
const SUBPARSERS = [
    { name: 'iso_part',   fn: ISOPart.parse },
    { name: 'fit_class',  fn: FitClass.parse },
    // tolerance must run after fit_class so "H7/g6" is consumed as a
    // paired fit-class first; lone "H7" / "IT7" / "±N" fall through to
    // tolerance below.
    { name: 'tolerance',  fn: Tolerance.parse },
    { name: 'kinematic',  fn: Kinematic.parse },
    { name: 'spatial',    fn: Spatial.parse },
    { name: 'dimension',  fn: Dimension.parse },
    { name: 'material',   fn: Material.parse },
    { name: 'process',    fn: Process.parse },
];

/**
 * @param {Token[]} tokens
 * @param {string}  sourceText  the original text, for residual reconstruction
 */
export function parse(tokens, sourceText) {
    const constraints = [];
    const ambiguities = [];
    const spans = {};
    const consumed = new Array(tokens.length).fill(false);

    // Pre-scan: identify a primary shape noun (cube/cylinder/disc/rod/plate/...)
    // so dimension constraints can be axis-labelled when the spec text is
    // bare ("40 mm cube" → length).
    const SHAPE_NOUN_AXIS = {
        cube: 'length', cubes: 'length',
        cylinder: 'length', cylinders: 'length',
        rod: 'length', rods: 'length',
        bar: 'length', shaft: 'length',
        disc: 'thickness', disk: 'thickness', washer: 'thickness',
        sleeve: 'length', tube: 'length',
        plate: 'thickness', panel: 'thickness', sheet: 'thickness',
        bracket: 'length', brackets: 'length',
        block: 'length', blocks: 'length',
        spacer: 'length', spacers: 'length',
    };
    let primaryNoun = null;
    const NOUN_KEYS = Object.keys(SHAPE_NOUN_AXIS);
    for (const tk of tokens) {
        if (tk.kind !== 'WORD') continue;
        const w = tk.value.toLowerCase();
        if (Object.prototype.hasOwnProperty.call(SHAPE_NOUN_AXIS, w)) {
            primaryNoun = w;
            break;
        }
        // Substring match (e.g. "L-bracket" → "bracket").
        for (const k of NOUN_KEYS) {
            if (k.length >= 4 && w.includes(k)) { primaryNoun = k; break; }
        }
        if (primaryNoun) break;
    }
    const inferredAxis = primaryNoun ? SHAPE_NOUN_AXIS[primaryNoun] : null;

    let i = 0;
    while (i < tokens.length) {
        if (consumed[i]) { i++; continue; }

        let matched = false;
        for (const { name, fn } of SUBPARSERS) {
            const r = fn(tokens, i);
            if (!r) continue;

            // Bookkeeping for the leading-quantifier backref (iso_part).
            const startIdx = (r.leadingQuantifierIdx != null && r.leadingQuantifierIdx >= 0)
                ? r.leadingQuantifierIdx
                : i;
            const endIdx = i + r.consumed - 1;

            for (let k = startIdx; k <= endIdx; k++) consumed[k] = true;

            const startChar = tokens[startIdx].start;
            const endChar   = tokens[endIdx].end;

            for (const c of r.constraints) {
                let emit = { ...c, _src: name };
                if (emit._c === T.CONSTRAINT_KIND.DIMENSION && emit.axis == null && inferredAxis) {
                    emit = { ...emit, axis: inferredAxis };
                }
                // Dedupe — drop a spatial constraint that already exists with
                // identical target+datum+offset+count. Two "centered" phrases
                // shouldn't yield two constraints.
                const isDup = constraints.some((existing) => sameConstraint(existing, emit));
                if (isDup) continue;
                const idx = constraints.length;
                constraints.push(emit);
                spans[idx] = [startChar, endChar];
            }
            if (Array.isArray(r.ambiguities)) ambiguities.push(...r.ambiguities);
            // Emit fastener-length ambiguity for bare M-size with no length.
            for (const c of r.constraints) {
                if (c._c === T.CONSTRAINT_KIND.PART_SELECTION &&
                    c.catalogPrefix === 'iso4762' &&
                    c.length == null) {
                    ambiguities.push({
                        kind: 'fastener-length',
                        detail: `${c.nominalSize} length unspecified`,
                        field: 'length',
                    });
                }
            }

            i = endIdx + 1;
            matched = true;
            break;
        }
        if (!matched) i++;
    }

    // Residual text: reconstruct from unconsumed token spans. We keep PUNCT
    // and "fit" filler etc. only if their token is unconsumed — but we
    // don't reconstruct via spans; we mark each character of the source as
    // covered, then concat the uncovered slices.
    const covered = new Array(sourceText.length).fill(false);
    for (let k = 0; k < tokens.length; k++) {
        if (!consumed[k]) continue;
        const tk = tokens[k];
        for (let p = tk.start; p < tk.end; p++) covered[p] = true;
    }
    // Also mark whitespace as covered if both neighbours are covered.
    let residualText = '';
    let buf = '';
    for (let p = 0; p < sourceText.length; p++) {
        if (covered[p]) {
            if (buf.trim()) { residualText += (residualText ? ' ' : '') + buf.trim(); }
            buf = '';
        } else {
            buf += sourceText[p];
        }
    }
    if (buf.trim()) residualText += (residualText ? ' ' : '') + buf.trim();
    // Strip filler punctuation-only residual.
    residualText = residualText.replace(/[\s,;.()]+/g, ' ').trim();
    // Drop bare structural words that survive but carry no info.
    const FILLER = /^(of|for|the|a|an|with|and|into|between|on|to|fit|fits|holes|hole|cube|cylinder|plate|panel|disc|rod|block|spacer|housing|enclosure|shell|sleeve|shield|bushing|insert|spindle|frame|stage|platform|robot|arm|pin|dowel|bore|seat|tall|wide|long|thick|deep|high|seat|piece|piece|out|t6|t3|h32|grade)$/i;
    residualText = residualText.split(/\s+/).filter((w) => w && !FILLER.test(w)).join(' ');

    return { constraints, residualText, ambiguities, spans };
}

/** Structural equality across constraint key fields (ignoring `_src` and
 *  `_c` is identical first). */
function sameConstraint(a, b) {
    if (a._c !== b._c) return false;
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    keys.delete('_src');
    for (const k of keys) {
        if (a[k] !== b[k]) return false;
    }
    return true;
}
