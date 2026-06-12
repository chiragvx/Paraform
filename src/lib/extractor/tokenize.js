/**
 * Stateless tokenizer for the deterministic spec extractor.
 *
 * Walks the raw spec text once, left-to-right, attempting longest-match
 * regex sweeps in priority order. Each match emits a `Token` carrying its
 * `[start, end]` span into the original text — every downstream constraint
 * inherits these so the consumer can underline / highlight the source.
 *
 * Token kinds (single source of truth — keep in sync with the subparsers):
 *
 *   ISO_CODE        "iso4762-m3-16", "ISO 4762", "ISO 273"
 *   M_X_LEN         "M3×16", "M3x16", "M3 × 16"
 *   M_SIZE          "M3", "M2.5", "M10"
 *   BEARING_ID      4-digit IDs in the 6xxx range, or 3-digit 6xx
 *   FIT_CLASS       "H7/g6", "H7/h6", "H7/k6"
 *   FIT_NAME        "press fit", "slip fit", "slide fit", "running fit", ...
 *   KINEMATIC       "SCARA", "delta robot", "6-DOF arm", "CoreXY", ...
 *   DOF             "4-DOF", "6-DOF" (separate so kinematic subparser pairs them)
 *   DIM_TUPLE       "60×40×3", "60 × 40 × 3" — multi-axis primary dim
 *   DIA             "Ø22", "Ø 22"
 *   TOLERANCE       "±0.05", "+0.1/-0.0", "IT7"
 *   PROCESS         "3D printed", "CNC machined", "injection molded", ...
 *   MATERIAL        lexicon match
 *   QUANTIFIER      "four", "all four", "every", "each", "1×", "4×"
 *   SPATIAL_REL     "from each edge", "at the corners", "centered", ...
 *   PAYLOAD         "5 kg", "10 N" (load values; emitted separately so we
 *                   can keep DIMENSION confined to lengths)
 *   NUMBER          bare numeric literal
 *   UNIT            "mm", "cm", "m", "in", "mm/s"
 *   WORD            fallback word
 *   PUNCT           "," ";" "." "(" ")"
 *
 * The tokenizer does *not* try to be a parser. It surfaces "this slice
 * looks like an M-size code" without committing to whether the next
 * sentence will turn it into a clearance constraint or a screw catalog
 * lookup — the grammar resolves that.
 *
 * Lexicons (materials, processes, fits, kinematics) ship as JSON so they
 * grow without code changes. We import them lazily at module-init so the
 * regexes stay constant.
 */

import materialsLex   from './lexicons/materials.json' with { type: 'json' };
import processesLex   from './lexicons/processes.json' with { type: 'json' };
import fitsLex        from './lexicons/fits.json'      with { type: 'json' };
import kinematicsLex  from './lexicons/kinematics.json' with { type: 'json' };

/** Build a giant alternation regex of lexicon aliases, longest-first to
 * defeat substring shadowing ("stainless steel" before "steel"). Returns
 * `{ pattern, lookup }` where `lookup` is `alias-lowercase → entry`. */
function buildLexicon(lex) {
    const lookup = new Map();
    for (const entry of lex.entries) {
        for (const a of entry.aliases) lookup.set(a.toLowerCase(), entry);
    }
    const aliases = [...lookup.keys()].sort((a, b) => b.length - a.length);
    // Escape regex metachars in aliases (only `.` and `-` actually appear today).
    const escaped = aliases.map((s) => s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'));
    // Word-boundary on both ends so "alu" doesn't grab "aluminum".
    const pattern = new RegExp(`\\b(?:${escaped.join('|')})\\b`, 'i');
    return { pattern, lookup };
}

const MATERIALS  = buildLexicon(materialsLex);
const PROCESSES  = buildLexicon(processesLex);
const FITS_NAMED = buildLexicon(fitsLex);
const KINEMATICS = buildLexicon(kinematicsLex);

/** Recognised length / velocity units. */
const UNIT_RE = /^(mm\/s|mm|cm|m|in|inch|inches|")/i;
/** Recognised load units. */
const LOAD_UNIT_RE = /^(kg|N|lbs|lb)\b/;

/** A single token. `value` is the raw matched substring; `data` is
 * subparser-friendly pre-parsed payload (a number, the lexicon entry, etc). */
function tok(kind, value, start, end, data = null) {
    return { kind, value, start, end, data };
}

/** Quantifier word table → numeric count. `null` = "every / each / all" — the
 * subparser handles the count contextually. */
const QUANTIFIER_WORDS = {
    'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5,
    'six': 6, 'seven': 7, 'eight': 8, 'nine': 9, 'ten': 10,
    'each': null, 'every': null, 'all': null, 'both': 2,
};

/** Spatial-relation surface phrases. Long ones first (longest-match).
 *  `implicitCount` lets a phrase like "at all four corners" carry the
 *  embedded quantifier without forcing a downstream subparser to text-mine
 *  the phrase. */
const SPATIAL_PHRASES = [
    { phrase: 'from each edge',  datum: 'from-each-edge', implicitCount: 4 },
    { phrase: 'from the edge',   datum: 'from-edge' },
    { phrase: 'inset from the edge', datum: 'inset-from-edge' },
    { phrase: 'inset',           datum: 'inset-from-edge' },
    { phrase: 'at the corners',  datum: 'each-corner', implicitCount: 4 },
    { phrase: 'at the four corners', datum: 'each-corner', implicitCount: 4 },
    { phrase: 'at all four corners', datum: 'each-corner', implicitCount: 4 },
    { phrase: 'at each corner',  datum: 'each-corner', implicitCount: 4 },
    { phrase: 'on the top face', datum: 'top-face' },
    { phrase: 'on the bottom face', datum: 'bottom-face' },
    { phrase: 'on the front face', datum: 'front-face' },
    { phrase: 'on the back face', datum: 'back-face' },
    { phrase: 'on the left face', datum: 'left-face' },
    { phrase: 'on the right face', datum: 'right-face' },
    { phrase: 'on the plate',    datum: 'centered' },
    { phrase: 'on center',       datum: 'centered' },
    { phrase: 'centered',        datum: 'centered' },
    { phrase: 'concentric',      datum: 'concentric' },
];

/** Tokenize raw text. Pure function. */
export function tokenize(text) {
    const tokens = [];
    let i = 0;
    const N = text.length;

    while (i < N) {
        const ch = text[i];

        // Skip whitespace.
        if (/\s/.test(ch)) { i++; continue; }

        const rest = text.slice(i);

        // ── ISO catalog id: "iso4762-m3-16", "iso273-m4-medium" ─────────────
        let m = rest.match(/^iso\d+-m(\d+(?:\.\d+|p\d+)?)(?:-(\d+|close|medium|loose))?/i);
        if (m) {
            tokens.push(tok('ISO_CODE', m[0], i, i + m[0].length, {
                standard: m[0].split('-')[0].toUpperCase().replace('ISO', 'ISO '),
                catalogPrefix: m[0].split('-')[0].toLowerCase(),
                nominalSize: 'M' + m[1].replace('p', '.'),
                tail: m[2] || null,
            }));
            i += m[0].length;
            continue;
        }

        // ── "ISO 4762", "ISO 4032", "ISO 273" ────────────────────────────────
        m = rest.match(/^ISO\s+(\d{3,5})/i);
        if (m) {
            tokens.push(tok('ISO_CODE', m[0], i, i + m[0].length, {
                standard: 'ISO ' + m[1],
                catalogPrefix: 'iso' + m[1],
            }));
            i += m[0].length;
            continue;
        }

        // ── "M3×16", "M3x16", "M3 × 16" — fastener with length ──────────────
        m = rest.match(/^M(\d+(?:\.\d+)?)\s*[×x✕*]\s*(\d+(?:\.\d+)?)/);
        if (m) {
            tokens.push(tok('M_X_LEN', m[0], i, i + m[0].length, {
                nominalSize: 'M' + m[1],
                length: Number(m[2]),
            }));
            i += m[0].length;
            continue;
        }

        // ── "M3", "M2.5" — bare metric thread size ──────────────────────────
        // Require a word break after (i.e., not followed by another digit).
        m = rest.match(/^M(\d+(?:\.\d+)?)(?![\d.])/);
        if (m) {
            tokens.push(tok('M_SIZE', m[0], i, i + m[0].length, {
                nominalSize: 'M' + m[1],
            }));
            i += m[0].length;
            continue;
        }

        // ── Fit class "H7/g6", "H7/h6", "H7/k6" ─────────────────────────────
        m = rest.match(/^H(\d)\/([ghkpnrjm])(\d)/);
        if (m) {
            tokens.push(tok('FIT_CLASS', m[0], i, i + m[0].length, {
                class: m[0],
            }));
            i += m[0].length;
            continue;
        }

        // ── Named fit phrase ("press fit", "slip fit", ...) ─────────────────
        const fitNamed = FITS_NAMED.pattern.exec(rest);
        if (fitNamed && fitNamed.index === 0) {
            const phrase = fitNamed[0];
            const entry  = FITS_NAMED.lookup.get(phrase.toLowerCase());
            tokens.push(tok('FIT_NAME', phrase, i, i + phrase.length, { entry }));
            i += phrase.length;
            continue;
        }

        // ── DOF "4-DOF", "6-DOF" ────────────────────────────────────────────
        m = rest.match(/^(\d+)[-\s]?DOF\b/i);
        if (m) {
            tokens.push(tok('DOF', m[0], i, i + m[0].length, {
                dof: Number(m[1]),
            }));
            i += m[0].length;
            continue;
        }

        // ── Kinematic mechanism (lexicon) ───────────────────────────────────
        const kine = KINEMATICS.pattern.exec(rest);
        if (kine && kine.index === 0) {
            const phrase = kine[0];
            const entry  = KINEMATICS.lookup.get(phrase.toLowerCase());
            tokens.push(tok('KINEMATIC', phrase, i, i + phrase.length, { entry }));
            i += phrase.length;
            continue;
        }

        // ── Multi-axis dimension tuple "60×40×3", "60 × 40 × 3" ─────────────
        m = rest.match(/^(\d+(?:\.\d+)?)\s*[×x✕*]\s*(\d+(?:\.\d+)?)(?:\s*[×x✕*]\s*(\d+(?:\.\d+)?))?/);
        if (m && !/^M/.test(m[0])) {
            const axes = [Number(m[1]), Number(m[2])];
            if (m[3] != null) axes.push(Number(m[3]));
            tokens.push(tok('DIM_TUPLE', m[0], i, i + m[0].length, { values: axes }));
            i += m[0].length;
            continue;
        }

        // ── Diameter "Ø22", "Ø 22", "⌀22", "d22" ───────────────────────────
        m = rest.match(/^[Ø⌀∅]\s*(\d+(?:\.\d+)?)/);
        if (m) {
            tokens.push(tok('DIA', m[0], i, i + m[0].length, { value: Number(m[1]) }));
            i += m[0].length;
            continue;
        }

        // ── Tolerance "±0.05", "+0.1/-0.0", "IT7" ──────────────────────────
        m = rest.match(/^±\s*(\d+(?:\.\d+)?)/);
        if (m) {
            tokens.push(tok('TOLERANCE', m[0], i, i + m[0].length, {
                plus: Number(m[1]), minus: Number(m[1]),
            }));
            i += m[0].length;
            continue;
        }
        m = rest.match(/^\+\s*(\d+(?:\.\d+)?)\s*\/\s*-\s*(\d+(?:\.\d+)?)/);
        if (m) {
            tokens.push(tok('TOLERANCE', m[0], i, i + m[0].length, {
                plus: Number(m[1]), minus: Number(m[2]),
            }));
            i += m[0].length;
            continue;
        }
        m = rest.match(/^IT(\d+)/);
        if (m) {
            tokens.push(tok('TOLERANCE', m[0], i, i + m[0].length, {
                gradeIT: Number(m[1]),
            }));
            i += m[0].length;
            continue;
        }

        // ── Process (lexicon match) ─────────────────────────────────────────
        const proc = PROCESSES.pattern.exec(rest);
        if (proc && proc.index === 0) {
            const phrase = proc[0];
            const entry  = PROCESSES.lookup.get(phrase.toLowerCase());
            tokens.push(tok('PROCESS', phrase, i, i + phrase.length, { entry }));
            i += phrase.length;
            continue;
        }

        // ── Material (lexicon match) ────────────────────────────────────────
        const mat = MATERIALS.pattern.exec(rest);
        if (mat && mat.index === 0) {
            const phrase = mat[0];
            const entry  = MATERIALS.lookup.get(phrase.toLowerCase());
            tokens.push(tok('MATERIAL', phrase, i, i + phrase.length, { entry }));
            i += phrase.length;
            continue;
        }

        // ── Spatial relation phrase ─────────────────────────────────────────
        const sp = findSpatial(rest);
        if (sp) {
            tokens.push(tok('SPATIAL_REL', sp.match, i, i + sp.match.length, {
                datum: sp.datum,
                implicitCount: sp.implicitCount ?? null,
            }));
            i += sp.match.length;
            continue;
        }

        // ── Quantifier "four", "4×", "every other" ──────────────────────────
        m = rest.match(/^(\d+)\s*[×x]\s+/);
        if (m) {
            tokens.push(tok('QUANTIFIER', m[1], i, i + m[0].length, {
                count: Number(m[1]),
            }));
            i += m[0].length;
            continue;
        }
        // word-based quantifier
        const qm = rest.match(/^[A-Za-z]+/);
        if (qm) {
            const word = qm[0].toLowerCase();
            if (Object.prototype.hasOwnProperty.call(QUANTIFIER_WORDS, word)) {
                tokens.push(tok('QUANTIFIER', word, i, i + qm[0].length, {
                    count: QUANTIFIER_WORDS[word],
                }));
                i += qm[0].length;
                continue;
            }
        }

        // ── Bearing id: 3- or 4-digit numbers in 6000-series, 625-style ────
        m = rest.match(/^(6\d{3}|6\d{2}|625|626|624)\b/);
        if (m) {
            tokens.push(tok('BEARING_ID', m[0], i, i + m[0].length, {
                nominalSize: m[0],
            }));
            i += m[0].length;
            continue;
        }

        // ── Number (followed-by-unit or bare) ───────────────────────────────
        m = rest.match(/^(\d+(?:\.\d+)?)/);
        if (m) {
            tokens.push(tok('NUMBER', m[0], i, i + m[0].length, {
                value: Number(m[0]),
            }));
            i += m[0].length;
            // Look ahead for a unit to attach as the next token.
            continue;
        }

        // ── Unit ────────────────────────────────────────────────────────────
        const um = rest.match(UNIT_RE);
        if (um) {
            tokens.push(tok('UNIT', um[0], i, i + um[0].length, { unit: normalizeUnit(um[0]) }));
            i += um[0].length;
            continue;
        }
        const lu = rest.match(LOAD_UNIT_RE);
        if (lu) {
            tokens.push(tok('UNIT', lu[0], i, i + lu[0].length, { unit: lu[0], isLoad: true }));
            i += lu[0].length;
            continue;
        }

        // ── Punctuation ────────────────────────────────────────────────────
        if (/[,.;:()[\]{}/\\]/.test(ch)) {
            tokens.push(tok('PUNCT', ch, i, i + 1));
            i++;
            continue;
        }

        // ── Fallback word ──────────────────────────────────────────────────
        const wm = rest.match(/^[A-Za-z][A-Za-z0-9_'-]*/);
        if (wm) {
            tokens.push(tok('WORD', wm[0], i, i + wm[0].length));
            i += wm[0].length;
            continue;
        }

        // Unknown single-char: emit as PUNCT to advance.
        tokens.push(tok('PUNCT', ch, i, i + 1));
        i++;
    }

    return tokens;
}

function findSpatial(rest) {
    const lower = rest.toLowerCase();
    for (const sp of SPATIAL_PHRASES) {
        if (lower.startsWith(sp.phrase)) {
            return {
                match: rest.slice(0, sp.phrase.length),
                datum: sp.datum,
                implicitCount: sp.implicitCount ?? null,
            };
        }
    }
    return null;
}

function normalizeUnit(u) {
    const s = u.toLowerCase();
    if (s === 'inch' || s === 'inches' || s === '"') return 'in';
    return s;
}
