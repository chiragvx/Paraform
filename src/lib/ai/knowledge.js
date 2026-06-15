/**
 * Domain-knowledge loader for the Functional-Design Brain (PLAN §4).
 *
 * The model (potentially a weak one like GPT-OSS 120B) doesn't know what a
 * quadruped is, how to size a servo, or what clearance a printed fit needs.
 * The scaffold does — and injects it. This module is the read side of that
 * injected expertise: it ships three static JSON payloads (mechanism pattern
 * cards, the servo upgrade ladder, DFM/DFA rule packs) and exposes small,
 * alias-aware accessors that S1/S2/S5/S10 stages (and `plan_mechanism`) call.
 *
 * JSON is imported via the ESM import-attribute style already used across this
 * repo (see lib/invariants/lookups.js, lib/extractor/tokenize.js):
 *   import X from './x.json' with { type: 'json' };
 * Vite + modern Node both support this. No fetch, no inline literal.
 *
 * Contract: every exported function is total — it NEVER throws. Bad input
 * yields null / [] rather than an exception, so callers in the AI pipeline
 * can probe freely without try/catch.
 */

import MECHANISMS from './knowledge/mechanisms.json' with { type: 'json' };
import SERVOS from './knowledge/servos.json' with { type: 'json' };
import DFM from './knowledge/dfm.json' with { type: 'json' };

// ── normalization helpers ────────────────────────────────────────────────────

/** Lowercase, trim, collapse separators so "Robot-Arm", "robot arm",
 *  "robot_arm" all normalize to the same key. Non-strings -> "". */
function _norm(s) {
    if (typeof s !== 'string') return '';
    return s.trim().toLowerCase().replace(/[\s_\-]+/g, ' ').replace(/\s+/g, ' ');
}

/** Defensive array view. */
function _arr(x) {
    return Array.isArray(x) ? x : [];
}

// ── mechanism pattern cards ──────────────────────────────────────────────────

const _CARDS = _arr(MECHANISMS);

// Build an alias -> card index once, normalized, archetype + every alias.
const _CARD_INDEX = (() => {
    const idx = new Map();
    for (const card of _CARDS) {
        if (!card || typeof card !== 'object') continue;
        const keys = [card.archetype, ..._arr(card.aliases)];
        for (const k of keys) {
            const nk = _norm(k);
            if (nk && !idx.has(nk)) idx.set(nk, card);
        }
    }
    return idx;
})();

/**
 * Look up a Mechanism Pattern Card by archetype or alias (case-/separator-
 * insensitive). Falls back to a loose substring match against the index so a
 * request like "make a robot dog please" still resolves "robot dog" ->
 * quadruped. Returns the card object or null.
 *
 * @param {string} archetype  archetype id or any known alias / phrase
 * @returns {object|null}
 */
export function getPatternCard(archetype) {
    const needle = _norm(archetype);
    if (!needle) return null;

    // 1. exact archetype/alias hit.
    const exact = _CARD_INDEX.get(needle);
    if (exact) return exact;

    // 2. loose: any indexed key contained in the needle, or vice versa.
    //    Prefer the longest matching key (most specific wins).
    let best = null;
    let bestLen = 0;
    for (const [key, card] of _CARD_INDEX) {
        if (key.length < 3) continue; // skip ultra-short keys to avoid noise
        if (needle.includes(key) || key.includes(needle)) {
            if (key.length > bestLen) {
                best = card;
                bestLen = key.length;
            }
        }
    }
    return best;
}

/**
 * List the canonical archetype ids that have pattern cards.
 * @returns {string[]}
 */
export function listArchetypes() {
    return _CARDS
        .filter((c) => c && typeof c.archetype === 'string')
        .map((c) => c.archetype);
}

// ── servo upgrade ladder ─────────────────────────────────────────────────────

const _SERVO_LADDER = _arr(SERVOS && SERVOS.ladder);

const _SERVO_INDEX = (() => {
    const idx = new Map();
    for (const s of _SERVO_LADDER) {
        if (!s || typeof s !== 'object') continue;
        const nk = _norm(s.id);
        if (nk) idx.set(nk, s);
    }
    return idx;
})();

/**
 * The full servo ladder, weakest -> strongest (array order is the ladder).
 * Returns a shallow copy so callers can't mutate the cached data.
 * @returns {object[]}
 */
export function getServoLadder() {
    return _SERVO_LADDER.slice();
}

/**
 * Given a servo id (e.g. "SG90"), return the NEXT (stronger) rung's record so
 * "servo too weak" is a deterministic step up. Case-insensitive on the id.
 * Returns null if the id is unknown or already at the top of the ladder.
 *
 * @param {string} id  current servo id
 * @returns {object|null}
 */
export function nextServo(id) {
    const cur = _SERVO_INDEX.get(_norm(id));
    if (!cur) return null;
    const nextId = _norm(cur.nextRung);
    if (!nextId) return null; // top of ladder
    return _SERVO_INDEX.get(nextId) || null;
}

// ── DFM / DFA rule packs ─────────────────────────────────────────────────────

const _DFM_RULES = _arr(DFM && DFM.rules);

/**
 * The DFM/DFA checklist rule packs (printed-mating clearance bands, min wall
 * by feature, overhang/support angle, bolt thread-engagement depth, etc.).
 * Returns a shallow copy.
 * @returns {object[]}
 */
export function getDfmRules() {
    return _DFM_RULES.slice();
}
