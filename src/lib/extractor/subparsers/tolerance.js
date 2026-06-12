/**
 * Tolerance subparser.
 *
 * Handles four shapes the tokenizer (or fallback) surfaces:
 *
 *   1. TOLERANCE token with `plus`/`minus` numeric data
 *        — symmetric ±N, asymmetric +N/-N. Optionally followed by a UNIT
 *          token (mm | in | "). Inches convert to mm × 25.4.
 *   2. TOLERANCE token with `gradeIT` data
 *        — `IT7` style. plus/minus null unless we can resolve a nominal
 *          size from the immediately preceding NUMBER+UNIT / DIA token.
 *   3. WORD token matching /^H\d+$/  (e.g. "H7")
 *        — hole-basis upper-only.  itGrade=N, offset 0..+band.
 *      WORD matching /^h\d+$/  (e.g. "h6")
 *        — shaft-basis lower-only. itGrade=N, offset -band..0.
 *      MUST NOT be followed by `/` (fit_class catches H7/g6 paired form
 *      via its own FIT_CLASS token long before we get here, but the
 *      defensive check is cheap).
 *
 * Target binding (`all` vs `last-dimension`):
 *   We only see tokens, not previously-emitted constraints. Heuristic:
 *   if the immediately-preceding non-PUNCT token is UNIT/NUMBER/DIA/
 *   DIM_TUPLE, the tolerance attaches to the just-described dimension
 *   → target = `last-dimension`. Otherwise → `all`.
 *
 * Returns { constraints, consumed } or null on no match.
 */

import * as T from '../types.js';
import gradesTable from '../lookups/it_grades.json' with { type: 'json' };

const IN_TO_MM = 25.4;

/** Words that label an axis (post-number form: "60 mm long ±0.05"). When
 *  we walk back from a tolerance and find one of these, the preceding
 *  NUMBER+UNIT is still the dimension we're attaching to. */
const AXIS_LABEL_WORDS = new Set([
    'long', 'length', 'wide', 'width', 'tall', 'high', 'height',
    'thick', 'thickness', 'deep', 'depth', 'diameter', 'dia',
]);

/** Decide whether this tolerance attaches to the last dimension or is
 *  a default-for-everything declaration. */
function inferTarget(tokens, startIdx) {
    let sawAxisLabelOnly = false;
    for (let k = startIdx - 1; k >= 0 && k >= startIdx - 4; k--) {
        const prev = tokens[k];
        if (!prev) break;
        if (prev.kind === 'PUNCT') continue;
        if (prev.kind === 'UNIT' || prev.kind === 'NUMBER' ||
            prev.kind === 'DIA'  || prev.kind === 'DIM_TUPLE') {
            return 'last-dimension';
        }
        // Allow stepping past a single axis-label word ("long", "wide", etc.)
        // so "60 mm long ±0.05" still binds to the 60 mm dimension.
        if (prev.kind === 'WORD' && !sawAxisLabelOnly &&
            AXIS_LABEL_WORDS.has(prev.value.toLowerCase())) {
            sawAxisLabelOnly = true;
            continue;
        }
        break;
    }
    return 'all';
}

/** Walk back from startIdx to find a nominal size in mm. Recognises
 *  DIA (already in mm), NUMBER+UNIT (convert from in if needed), and
 *  DIM_TUPLE (uses the first axis as a proxy). Returns null if nothing
 *  resolvable nearby. */
function findNominalSize(tokens, startIdx) {
    for (let k = startIdx - 1; k >= 0 && k >= startIdx - 6; k--) {
        const prev = tokens[k];
        if (!prev) break;
        if (prev.kind === 'PUNCT' || prev.kind === 'WORD') continue;
        if (prev.kind === 'DIA') return prev.data.value;
        if (prev.kind === 'DIM_TUPLE') return prev.data.values[0];
        if (prev.kind === 'UNIT' && !prev.data?.isLoad) {
            const num = tokens[k - 1];
            if (num && num.kind === 'NUMBER') {
                let v = num.data.value;
                if (prev.data.unit === 'in') v *= IN_TO_MM;
                return v;
            }
        }
        if (prev.kind === 'NUMBER') return prev.data.value;
    }
    return null;
}

/** Look up the IT-band (in mm, half-width — i.e. ± value) for a given
 *  grade and nominal size. Returns null if grade unknown or size is out
 *  of the table's [3, 250] mm window. */
export function resolveITGrade(itGrade, nominalSizeMm) {
    if (nominalSizeMm == null || nominalSizeMm <= 0) return null;
    const key = `IT${itGrade}`;
    const row = gradesTable.grades?.[key];
    if (!row) return null;
    // Range key format: "lo-hi", lo exclusive of below, hi inclusive.
    let found = null;
    for (const range of gradesTable.ranges) {
        const [lo, hi] = range.split('-').map(Number);
        if (nominalSizeMm > lo && nominalSizeMm <= hi) { found = range; break; }
    }
    // Edge: nominalSizeMm exactly 3 should land in 3-6 too.
    if (!found && nominalSizeMm === 3) found = '3-6';
    if (!found) return null;
    const micrometers = row[found];
    if (micrometers == null) return null;
    return micrometers / 1000; // → mm
}

/** Helper: given a TOLERANCE token at startIdx with plus/minus, sniff
 *  the next UNIT token for inch conversion and return { plus, minus,
 *  unit, consumed }. */
function consumeUnit(tokens, startIdx, plus, minus) {
    const next = tokens[startIdx + 1];
    let consumed = 1;
    let unit = 'mm';
    if (next && next.kind === 'UNIT' && !next.data?.isLoad) {
        consumed = 2;
        unit = next.data.unit;
        if (unit === 'in') {
            plus  = plus  == null ? plus  : plus  * IN_TO_MM;
            minus = minus == null ? minus : minus * IN_TO_MM;
            unit  = 'mm';
        }
    }
    return { plus, minus, unit, consumed };
}

export function parse(tokens, startIdx) {
    const t = tokens[startIdx];
    if (!t) return null;

    // ── TOLERANCE token paths ────────────────────────────────────────────
    if (t.kind === 'TOLERANCE') {
        const target = inferTarget(tokens, startIdx);

        // IT-grade variant — data.gradeIT is set.
        if (t.data && t.data.gradeIT != null) {
            const itGrade = t.data.gradeIT;
            const nominal = findNominalSize(tokens, startIdx);
            const band = nominal != null ? resolveITGrade(itGrade, nominal) : null;
            const extra = { itGrade };
            let plus  = null;
            let minus = null;
            if (band != null) {
                // Total IT band split as ± half. (Symmetric assumption when
                // no H/h tolerance class is specified.)
                plus  = band / 2;
                minus = band / 2;
                extra.nominalSize = nominal;
            } else {
                extra.ambiguous = nominal == null
                    ? 'nominal-size-unresolved'
                    : 'nominal-size-out-of-table';
            }
            return {
                constraints: [T.tolerance(target, plus, minus, 'mm', extra)],
                consumed: 1,
            };
        }

        // Numeric ±N or +N/-N — data has plus & minus.
        let { plus, minus, unit, consumed } = consumeUnit(
            tokens, startIdx, t.data.plus, t.data.minus
        );
        return {
            constraints: [T.tolerance(target, plus, minus, unit)],
            consumed,
        };
    }

    // ── Lone "H7" / "h6" WORD path ───────────────────────────────────────
    if (t.kind === 'WORD') {
        const m = /^([Hh])(\d+)$/.exec(t.value);
        if (!m) return null;
        // Defensive: bail if followed by '/' — that's a paired fit class
        // that the tokenizer should have caught (but didn't if we got
        // here). Letting it fall through preserves it in residualText.
        const next = tokens[startIdx + 1];
        if (next && next.kind === 'PUNCT' && next.value === '/') return null;

        const isHole = m[1] === 'H';
        const itGrade = Number(m[2]);
        if (!Number.isFinite(itGrade) || itGrade < 1 || itGrade > 18) return null;

        const target  = inferTarget(tokens, startIdx);
        const nominal = findNominalSize(tokens, startIdx);
        const band    = nominal != null ? resolveITGrade(itGrade, nominal) : null;

        const extra = { itGrade };
        let plus  = null;
        let minus = null;
        if (band != null) {
            // H<N>: 0 to +band  (hole upper-only).
            // h<N>: -band to 0  (shaft lower-only).
            // Encode as plus/minus (always non-negative, like the rest of
            // the corpus's ± shape).
            if (isHole) { plus = band * 2; minus = 0; }
            else        { plus = 0;        minus = band * 2; }
            extra.nominalSize = nominal;
        } else {
            extra.ambiguous = nominal == null
                ? 'nominal-size-unresolved'
                : 'nominal-size-out-of-table';
        }
        return {
            constraints: [T.tolerance(target, plus, minus, 'mm', extra)],
            consumed: 1,
        };
    }

    return null;
}
