/**
 * Spatial subparser.
 *
 * Recognises:
 *   SPATIAL_REL                              → datum-only constraint
 *   (NUMBER UNIT)? SPATIAL_REL               → datum + offset, when the
 *                                              SPATIAL_REL is "from each edge"
 *                                              / "inset" / "from edge".
 *
 * Resolves the constraint's `target` field heuristically from look-ahead
 * AND look-behind:
 *   - "four holes at the corners"  → target='holes', count=4
 *   - "M3 boss on the top face"    → target='feature'
 *   - default                      → 'feature'
 *
 * Quantifiers in the look-behind are pulled into `count`.
 */

import * as T from '../types.js';

const HOLE_WORDS    = new Set(['hole', 'holes', 'bore', 'bores', 'clearance', 'tap', 'tapped', 'thread', 'threaded']);
const FEATURE_HINTS = new Set([
    'boss', 'bosses', 'pocket', 'pockets', 'slot', 'slots', 'groove', 'grooves',
    'rib', 'ribs', 'logo', 'feature', 'features', 'cutout', 'cutouts',
    'fillet', 'fillets', 'chamfer', 'chamfers', 'counterbore', 'countersink',
    'engraving', 'text',
]);

/** Classify spatial target by walking both directions for a noun hint. */
function classifyContext(tokens, startIdx) {
    let target = null;       // null = unknown yet
    let count = null;

    // Look BACK first — most spec text places the noun before the relation.
    let look = startIdx - 1;
    let steps = 0;
    while (look >= 0 && steps < 6) {
        const tk = tokens[look];
        if (tk.kind === 'PUNCT') { look--; continue; }
        if (tk.kind === 'WORD') {
            const w = tk.value.toLowerCase();
            if (HOLE_WORDS.has(w))    { if (target == null) target = 'holes';   look--; steps++; continue; }
            if (FEATURE_HINTS.has(w)) { if (target == null) target = 'feature'; look--; steps++; continue; }
            look--; steps++; continue;
        }
        if (tk.kind === 'QUANTIFIER') {
            if (tk.data.count != null && count == null) count = tk.data.count;
            look--; steps++; continue;
        }
        if (tk.kind === 'M_SIZE' || tk.kind === 'M_X_LEN' || tk.kind === 'ISO_CODE') {
            // a fastener — but skip past it; the noun might be on the OTHER side
            // (e.g. "M5 hole centered").
            look--; steps++; continue;
        }
        if (tk.kind === 'NUMBER' || tk.kind === 'UNIT' || tk.kind === 'DIA' || tk.kind === 'SPATIAL_REL') {
            look--; steps++; continue;
        }
        break;
    }

    // Look FORWARD a couple of tokens for a hole/feature noun ("centered bore").
    if (target == null) {
        let fwd = startIdx + 1;
        let fsteps = 0;
        while (fwd < tokens.length && fsteps < 4) {
            const tk = tokens[fwd];
            if (tk.kind === 'PUNCT') { fwd++; fsteps++; continue; }
            if (tk.kind === 'WORD') {
                const w = tk.value.toLowerCase();
                if (HOLE_WORDS.has(w))    { target = 'holes'; break; }
                if (FEATURE_HINTS.has(w)) { target = 'feature'; break; }
                fwd++; fsteps++; continue;
            }
            break;
        }
    }

    return { target: target ?? 'feature', count };
}

export function parse(tokens, startIdx) {
    const t = tokens[startIdx];
    if (!t) return null;

    // (NUMBER UNIT)? SPATIAL_REL  — offset preceding "from each edge" etc.
    if (t.kind === 'NUMBER') {
        const u = tokens[startIdx + 1];
        const s = tokens[startIdx + 2];
        if (u && u.kind === 'UNIT' && s && s.kind === 'SPATIAL_REL' &&
            /from-each-edge|inset|from-edge/.test(s.data.datum)) {
            const ctx = classifyContext(tokens, startIdx);
            return {
                constraints: [T.spatial(ctx.target, s.data.datum, t.data.value, ctx.count)],
                consumed: 3,
            };
        }
        return null;
    }

    if (t.kind === 'SPATIAL_REL') {
        const ctx = classifyContext(tokens, startIdx);
        let datum = t.data.datum;
        let consumed = 1;
        let offset = null;

        // Special: "inset N mm from the edge" — fold the offset into one
        // inset-from-edge constraint.
        if (datum === 'inset-from-edge') {
            const n = tokens[startIdx + 1];
            const u = tokens[startIdx + 2];
            const s = tokens[startIdx + 3];
            if (n && n.kind === 'NUMBER' && u && u.kind === 'UNIT') {
                offset = n.data.value;
                consumed = 3;
                if (s && s.kind === 'SPATIAL_REL' && /from-edge|from-each-edge/.test(s.data.datum)) {
                    consumed = 4;
                }
            }
        }
        return {
            constraints: [T.spatial(ctx.target, datum, offset, ctx.count)],
            consumed,
        };
    }

    return null;
}
