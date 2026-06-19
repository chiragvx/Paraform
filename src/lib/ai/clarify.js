/**
 * Clarifying-question block parsing for the chat panel.
 *
 * When the AI asks the Stage-0 clarifying questions (clarify → plan → approve →
 * build), it emits them as a fenced ```ask block so the UI can render clickable
 * option chips instead of a wall of prose:
 *
 *   ```ask
 *   { "questions": [
 *       { "q": "Custom 3D-printed, a COTS unit, or an existing fan?",
 *         "options": ["Custom 3D-printed", "COTS unit", "Existing fan"],
 *         "default": "Custom 3D-printed" },
 *       { "q": "Fan outer diameter?", "options": ["50 mm","70 mm","90 mm"],
 *         "default": "70 mm", "multi": false }
 *   ] }
 *   ```
 *
 * Both functions are TOTAL — they never throw; malformed/partial input yields a
 * graceful fallback (null / passthrough), so plain-prose questions still render.
 */

// Tolerant of BOTH the canonical multi-line form (```ask\n{…}\n```) AND the
// inline form some models emit (```ask {…}``` on a single line). Requiring a
// newline after the opening fence / before the closing fence silently dropped
// the inline form — the block rendered as raw text and the turn dead-ended
// waiting for answers it could never receive. `\s*` after the tag eats an
// optional space or newline; the lazy body runs to the first closing fence.
const FENCE = /```ask\s*([\s\S]*?)```/;

/**
 * Parse the first ```ask block out of an assistant message.
 * @returns {{ before:string, questions:Array, after:string } | null}
 */
export function parseAskBlock(text) {
    if (typeof text !== 'string' || !text.includes('```ask')) return null;
    const m = text.match(FENCE);
    if (!m) return null;
    let data;
    try { data = JSON.parse(m[1]); } catch { return null; }
    const raw = Array.isArray(data && data.questions) ? data.questions : null;
    if (!raw || !raw.length) return null;

    const questions = [];
    for (const q of raw) {
        if (!q || typeof q.q !== 'string' || !q.q.trim()) continue;
        const options = Array.isArray(q.options)
            ? q.options.map((o) => String(o)).map((s) => s.trim()).filter(Boolean)
            : [];
        questions.push({
            q: q.q.trim(),
            options,
            default: typeof q.default === 'string' && options.includes(q.default.trim()) ? q.default.trim() : null,
            multi: q.multi === true,
        });
    }
    if (!questions.length) return null;

    return {
        before: text.slice(0, m.index).trim(),
        questions,
        after: text.slice(m.index + m[0].length).trim(),
    };
}

/**
 * Strip an OPENED-but-not-yet-CLOSED ```ask fence for clean mid-stream display
 * (the block JSON shouldn't flash as raw text while the model is still typing).
 * Returns the text up to the dangling fence, trimmed.
 */
export function stripPartialAsk(text) {
    if (typeof text !== 'string') return text;
    const open = text.lastIndexOf('```ask');
    if (open === -1) return text;
    // Closed already? then there's nothing partial to strip.
    if (text.indexOf('```', open + 6) !== -1) return text;
    return text.slice(0, open).trimEnd();
}
