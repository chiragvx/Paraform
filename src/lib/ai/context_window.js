/**
 * Context-window management for the agent loop.
 *
 * THE PROBLEM. `runAgentTurn` keeps ONE growing `messages` array and re-sends the
 * WHOLE conversation on every iteration (provider.buildBody gets all of it each
 * call). On un-caching providers — most OpenRouter open-weight models — every
 * token of that transcript is re-billed on every call. So a build that takes N
 * model round-trips pays ~O(N²) in input tokens: a 68-call laptop-stand run
 * re-ships a transcript that has grown to tens of thousands of tokens, 68 times.
 * The dominant cost is NOT the (bounded) tool defs — it is the accumulating
 * history, and the two biggest items in it are verbose tool-RESULT payloads
 * (compile dumps, document summaries, measure tables) and the giant code blobs
 * that ride along in writeBuildScript/editBuildScript tool-call INPUTS.
 *
 * THE FIX. `compactHistory` returns a send-only view of the history: the goal
 * (first user turn) and the last few exchanges are kept verbatim; everything
 * OLDER has its heavy payloads collapsed to compact digests. It NEVER removes a
 * message or a tool call/result and never rewrites ids — it only shrinks the
 * contents of old turns — so the assistant tool_use ↔ user tool_result pairing
 * every provider relies on stays intact. The canonical `messages` array is left
 * untouched (the full transcript still lives in the chat store); compaction is a
 * lens applied at send time and recomputed each iteration.
 *
 * This is provider-agnostic: it operates on the normalized history shape
 * documented in providers/index.js — Array<{ role, text?, toolCalls?,
 * toolResults?, images? }>.
 */

// Identifying fields worth preserving from a tool RESULT — enough for the model
// to remember "I built featureId X and it compiled", without the full payload.
const RESULT_KEEP_KEYS = [
    'ok', 'summary', 'featureId', 'featureIds', 'componentId', 'newComponentId',
    'name', 'recipe', 'mateId', 'jointId', 'parameterId', 'count', 'pass',
    'error', 'gated', 'views', 'note',
];

function clip(s, max) {
    s = String(s);
    return s.length > max ? s.slice(0, max) + `…(+${s.length - max})` : s;
}

/** Rough token estimate (chars/4) — good enough for a budget tripwire. */
export function estimateTokens(value) {
    let chars = 0;
    if (typeof value === 'string') chars = value.length;
    else {
        try { chars = JSON.stringify(value).length; } catch { chars = 0; }
    }
    return Math.ceil(chars / 4);
}

/** Shrink a tool RESULT to its identifying fields, capped. Pure. */
export function digestResult(result, budget = 240) {
    if (result == null || typeof result !== 'object') {
        return typeof result === 'string' ? clip(result, budget) : result;
    }
    if (Array.isArray(result)) return { _items: result.length };
    const keep = {};
    for (const k of RESULT_KEEP_KEYS) {
        if (result[k] !== undefined) {
            keep[k] = typeof result[k] === 'string' ? clip(result[k], budget) : result[k];
        }
    }
    if (Object.keys(keep).length === 0) {
        // Nothing recognizable — keep a clipped JSON so the thread isn't lost.
        try { return { _digest: clip(JSON.stringify(result), budget) }; }
        catch { return { _digest: '[unserializable result]' }; }
    }
    return keep;
}

/** Shrink a tool-call INPUT: keep small/identifying keys, elide long strings
 *  (e.g. the build123d source on writeBuildScript/editBuildScript). Pure. */
export function digestInput(input, budget = 240) {
    if (input == null || typeof input !== 'object' || Array.isArray(input)) return input;
    let json;
    try { json = JSON.stringify(input); } catch { return { _elided: true }; }
    if (json.length <= budget) return input;               // already small — keep as-is
    const out = {};
    for (const [k, v] of Object.entries(input)) {
        if (typeof v === 'string' && v.length > 80) out[k] = `<elided ${v.length} chars>`;
        else if (v && typeof v === 'object') {
            const sub = (() => { try { return JSON.stringify(v); } catch { return ''; } })();
            out[k] = sub.length > budget ? { _elided: sub.length } : v;
        } else out[k] = v;
    }
    return out;
}

/**
 * Return a send-only, compacted copy of the normalized history. Non-mutating.
 *
 * @param {Array} history  normalized [{ role, text?, toolCalls?, toolResults?, images? }]
 * @param {object} [opts]
 * @param {number} [opts.keepRecent=8]   trailing messages kept fully verbatim
 * @param {number} [opts.resultBudget=240] char cap for a digested result / elision
 * @param {number} [opts.textBudget=700]  char cap for aged assistant/user prose
 * @param {number} [opts.keepImages=2]    most-recent image-bearing turns that keep their images
 */
export function compactHistory(history, opts = {}) {
    if (!Array.isArray(history) || history.length === 0) return history;
    const keepRecent = opts.keepRecent ?? 8;
    const resultBudget = opts.resultBudget ?? 240;
    const textBudget = opts.textBudget ?? 700;
    const keepImages = opts.keepImages ?? 2;

    const n = history.length;
    const recentFrom = Math.max(1, n - keepRecent); // index 0 (the goal) is never in the "old" zone

    // Which old messages may keep their images (the most recent image-bearing
    // ones in the OLD zone). Newer-than-recentFrom turns keep images regardless.
    const oldImageIdx = [];
    for (let i = 1; i < recentFrom; i++) {
        if (history[i] && Array.isArray(history[i].images) && history[i].images.length) oldImageIdx.push(i);
    }
    const imagesToKeep = new Set(oldImageIdx.slice(-keepImages));

    const out = new Array(n);
    for (let i = 0; i < n; i++) {
        const m = history[i];
        // Verbatim: the goal (index 0) and the recent window.
        if (i === 0 || i >= recentFrom || !m || typeof m !== 'object') { out[i] = m; continue; }

        const c = { role: m.role };
        if (typeof m.text === 'string' && m.text) {
            c.text = m.text.length > textBudget ? clip(m.text, textBudget) : m.text;
        }
        if (Array.isArray(m.toolCalls)) {
            c.toolCalls = m.toolCalls.map((tc) => ({
                ...(tc.id !== undefined ? { id: tc.id } : {}),
                name: tc.name,
                input: digestInput(tc.input, resultBudget),
            }));
        }
        if (Array.isArray(m.toolResults)) {
            c.toolResults = m.toolResults.map((tr) => ({
                ...(tr.id !== undefined ? { id: tr.id } : {}),
                name: tr.name,
                result: digestResult(tr.result, resultBudget),
            }));
        }
        if (Array.isArray(m.images) && m.images.length) {
            if (imagesToKeep.has(i)) c.images = m.images;
            // else: aged-out renders are dropped (huge base64) — keep a breadcrumb.
            else c.text = (c.text ? c.text + ' ' : '') + `[${m.images.length} earlier render(s) omitted]`;
        }
        out[i] = c;
    }
    return out;
}

export default compactHistory;
