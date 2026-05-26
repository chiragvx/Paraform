/**
 * ParaForm Confidence Scoreboard — updatex.md §6.
 * Five milestones, total = 100%. Emits 'change' events when any flip.
 *
 * Weights:
 *   1. Semantic Linter Pass   +20%
 *   2. CLI Compilation Pass   +40%   (here: wasm compile + no assert())
 *   3. Zero-Clash Verification +10%  (M3)
 *   4. Tool Path Verification  +10%  (M3)
 *   5. Kinematic Sweep Pass   +20%   (M5)
 */

const WEIGHTS = {
    linter:    20,
    compile:   40,
    clash:     10,
    toolPath:  10,
    kinematic: 20,
};

const ORDER = ['linter', 'compile', 'clash', 'toolPath', 'kinematic'];

class Scoreboard extends EventTarget {
    constructor() {
        super();
        this.state = {
            linter:    null, // null = not yet run, true = pass, false = fail
            compile:   null,
            clash:     null,
            toolPath:  null,
            kinematic: null,
        };
        this.details = {}; // { linter: errors[], compile: assertMessages[] }
    }

    mark(key, ok, details = null) {
        if (!(key in this.state)) {
            console.warn('[Scoreboard] unknown key', key);
            return;
        }
        const changed = this.state[key] !== ok;
        this.state[key] = ok;
        if (details !== null) this.details[key] = details;

        if (changed) {
            this.dispatchEvent(new CustomEvent('change', {
                detail: { key, ok, score: this.score(), state: { ...this.state }, details: { ...this.details } }
            }));
        }
    }

    /** Reset to "not yet run" — typically called at the start of a new generation. */
    reset() {
        for (const k of ORDER) this.state[k] = null;
        this.details = {};
        this.dispatchEvent(new CustomEvent('change', {
            detail: { key: null, ok: null, score: 0, state: { ...this.state }, details: {} }
        }));
    }

    score() {
        let total = 0;
        for (const k of ORDER) {
            if (this.state[k] === true) total += WEIGHTS[k];
        }
        return total;
    }

    snapshot() {
        return { score: this.score(), state: { ...this.state }, details: { ...this.details } };
    }
}

export const scoreboard = new Scoreboard();
export const SCORE_ORDER = ORDER;
export const SCORE_WEIGHTS = WEIGHTS;
