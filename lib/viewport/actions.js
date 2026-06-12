/**
 * Action registry — single source of truth for "things the user can do".
 *
 * One action description drives:
 *   - The command search palette (fuzzy lookup by label / id / category)
 *   - The marking menu (per-context radial pie)
 *   - Hotkey hint rendering (so the search lists keys next to labels)
 *   - Future: ribbon / context strip / toolbar
 *
 * Pure data + pure helpers. No DOM, no Three.js. The UI layers (palette,
 * marking menu) consume the registry through `filterActions(ctx)` and
 * `fuzzyMatch(query, actions)`.
 *
 *   Action {
 *     id:        string,                 // unique stable id, dotted ("view.front")
 *     label:     string,                 // shown in palette + menu
 *     category:  string,                 // 'View' | 'Document' | 'Sketch' | …
 *     hotkey?:   string,                 // human-readable hint, e.g. "Ctrl+1", "F"
 *     icon?:     string,                 // optional Material Symbol name
 *     keywords?: string[],               // extra fuzzy-match terms
 *     run:       (ctx) => void,          // executes the action
 *     isEnabled?:(ctx) => boolean,       // greyed-out when false (default: true)
 *     isVisible?:(ctx) => boolean,       // hidden entirely when false (default: true)
 *     disabledReason?:(ctx) => string,   // surface-able hint when isEnabled is false
 *     contextHint?:string,               // shown as a secondary line in the palette
 *   }
 *
 *   ActionContext {
 *     bridge:     v4 bridge,
 *     store:      v4 DocumentStore,
 *     ops:        v4 ops bag (window.__pf4.ops),
 *     selection:  PickingSelection,
 *     viewportCtl:ViewportController,
 *     sketchActive: boolean,
 *     toast:      (msg, kind?) => void,
 *   }
 *
 * The registry also tracks per-user state: recents (last invocation order)
 * and pins (favorites surfaced at the top). Both persist via the storage
 * adapter the host passes in (defaults to localStorage).
 */

const RECENT_KEY = 'paraform_action_recents';
const PINS_KEY   = 'paraform_action_pins';
const MAX_RECENT = 12;

export class ActionRegistry {
    /**
     * @param {object}  [opts]
     * @param {Storage} [opts.storage]   — defaults to window.localStorage when available
     */
    constructor(opts = {}) {
        /** @type {Map<string, import('./actions.js').Action>} */
        this._actions = new Map();
        this._storage = opts.storage
            ?? (typeof localStorage !== 'undefined' ? localStorage : null);
        this._recents = this._load(RECENT_KEY, []);
        this._pins    = new Set(this._load(PINS_KEY, []));
    }

    /** Register a single action. Overwrites any existing action with the same id. */
    register(action) {
        if (!action || typeof action.id !== 'string') throw new Error('register: missing id');
        if (typeof action.run !== 'function')        throw new Error(`register(${action.id}): missing run`);
        if (!action.label)                            throw new Error(`register(${action.id}): missing label`);
        const a = {
            category: 'General',
            keywords: [],
            ...action,
            isEnabled: action.isEnabled || (() => true),
            isVisible: action.isVisible || (() => true),
            disabledReason: action.disabledReason || null,
        };
        this._actions.set(a.id, a);
        return this;
    }

    /**
     * Look up the human-readable reason an action is disabled. Returns:
     *   - null when the action doesn't exist or isn't disabled
     *   - the action's `disabledReason(ctx)` string if it provided one
     *   - a generic fallback "{label} isn't available right now."
     */
    reasonDisabled(id, ctx) {
        const a = this._actions.get(id);
        if (!a) return null;
        try { if (a.isEnabled(ctx)) return null; }
        catch { return null; }
        if (typeof a.disabledReason === 'function') {
            try { return a.disabledReason(ctx); } catch {}
        }
        return `${a.label} isn’t available right now.`;
    }

    /** Bulk-register. */
    registerAll(actions) { for (const a of actions) this.register(a); return this; }

    /** Get by id, or `undefined`. */
    get(id) { return this._actions.get(id); }

    /** All actions, regardless of visibility. */
    all() { return [...this._actions.values()]; }

    /**
     * Filter visible+enabled actions for a given context. The host passes
     * `ctx`; `isVisible` / `isEnabled` close over it.
     */
    filter(ctx, { includeDisabled = true } = {}) {
        const out = [];
        for (const a of this._actions.values()) {
            try {
                if (!a.isVisible(ctx)) continue;
                if (!includeDisabled && !a.isEnabled(ctx)) continue;
                out.push(a);
            } catch { /* an action's visibility threw — skip */ }
        }
        return out;
    }

    /** Execute by id, marking it as recent on success. Returns truthy on run. */
    run(id, ctx) {
        const a = this._actions.get(id);
        if (!a) return false;
        if (!a.isVisible(ctx) || !a.isEnabled(ctx)) return false;
        try {
            a.run(ctx);
            this._touchRecent(id);
            return true;
        } catch (e) {
            console.warn(`[actions] ${id} failed:`, e && e.message);
            return false;
        }
    }

    // ── Recents + pins ─────────────────────────────────────────────────────

    recents(limit = 6) {
        return this._recents.slice(0, limit).map(id => this._actions.get(id)).filter(Boolean);
    }

    isPinned(id) { return this._pins.has(id); }

    pins() {
        return [...this._pins].map(id => this._actions.get(id)).filter(Boolean);
    }

    togglePin(id) {
        if (!this._actions.has(id)) return;
        if (this._pins.has(id)) this._pins.delete(id);
        else this._pins.add(id);
        this._save(PINS_KEY, [...this._pins]);
    }

    _touchRecent(id) {
        this._recents = [id, ...this._recents.filter(x => x !== id)].slice(0, MAX_RECENT);
        this._save(RECENT_KEY, this._recents);
    }

    _load(key, fallback) {
        try {
            if (!this._storage) return fallback;
            const raw = this._storage.getItem(key);
            return raw ? JSON.parse(raw) : fallback;
        } catch { return fallback; }
    }

    _save(key, value) {
        try { if (this._storage) this._storage.setItem(key, JSON.stringify(value)); }
        catch { /* private mode etc. */ }
    }
}

// ── Fuzzy match ────────────────────────────────────────────────────────────

/**
 * Score how well `query` matches one action's text. Higher is better.
 * Returns 0 when the query doesn't appear at all (caller filters).
 *
 * Heuristics (in priority):
 *   - Exact id / label match            → very high
 *   - Word-prefix in label               → high
 *   - All chars appear in order (subseq) → mid, bonus for contiguity
 *   - Match in keywords / category       → low
 */
export function scoreAction(query, action) {
    if (!query) return 1;       // empty query — preserve original order
    const q = query.toLowerCase().trim();
    if (!q) return 1;
    const label = (action.label || '').toLowerCase();
    const id    = (action.id || '').toLowerCase();
    const cat   = (action.category || '').toLowerCase();
    const kws   = (action.keywords || []).map(s => s.toLowerCase());

    if (label === q || id === q) return 1000;
    if (label.startsWith(q))     return 800;
    if (id.endsWith('.' + q))    return 700;

    // Word-start in label
    const wordHit = label.split(/[\s.-]+/).some(w => w.startsWith(q));
    if (wordHit) return 600;

    // Contiguous substring in label
    if (label.includes(q)) return 400 + (q.length / label.length) * 50;

    // Subsequence in label (typed chars in order, with gaps)
    const sub = subseqScore(q, label);
    if (sub > 0) return 200 + sub;

    // Keywords / category / id fragments
    if (kws.some(k => k.includes(q))) return 120;
    if (cat.includes(q))              return 80;
    if (id.includes(q))               return 60;
    return 0;
}

/** Length-of-longest-contiguous-run inside a label sub-sequence. */
function subseqScore(q, label) {
    let qi = 0, run = 0, best = 0;
    for (let i = 0; i < label.length && qi < q.length; i++) {
        if (label[i] === q[qi]) {
            run++;
            qi++;
            if (run > best) best = run;
        } else {
            run = 0;
        }
    }
    if (qi < q.length) return 0;        // not all chars matched
    return best * 4 + q.length;
}

/**
 * Rank a list of actions against a query. Recents and pins get a bias so
 * familiar items float upward (Fusion-style "recently used" toolbox feel).
 *
 * @param {string} query
 * @param {Action[]} actions
 * @param {object}   [opts]
 * @param {Set<string>} [opts.pins]
 * @param {string[]}    [opts.recents]
 */
export function fuzzyMatch(query, actions, { pins = new Set(), recents = [] } = {}) {
    const recentBias = new Map(recents.map((id, i) => [id, (recents.length - i) * 8]));
    const results = [];
    for (const a of actions) {
        const base = scoreAction(query, a);
        if (base <= 0) continue;
        const pinBoost  = pins.has(a.id) ? 50 : 0;
        const recBoost  = recentBias.get(a.id) || 0;
        results.push({ action: a, score: base + pinBoost + recBoost });
    }
    results.sort((a, b) => b.score - a.score || a.action.label.localeCompare(b.action.label));
    return results.map(r => r.action);
}
