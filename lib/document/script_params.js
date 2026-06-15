/**
 * BuildScript parameter hoisting (Phase C2) — make an opaque build123d
 * `BuildScript` less of a black box by surfacing top-of-script numeric
 * constants as editable sliders, the way OpenSCAD's Customizer and Adam CAD's
 * auto-slider-ization do. This keeps an AI-authored (or hand-authored) script
 * *tweakable without editing code* — the single most-loved affordance of
 * code-CAD parametrics — so a script still behaves like an editable feature
 * step rather than a baked blob.
 *
 * Convention (deliberately conservative — we only hoist what the author opts
 * in to, so arbitrary constants aren't turned into UI noise):
 *
 *     WIDTH  = 40        # param              → slider, no bounds
 *     HOLE_D = 5         # param [1:12]       → slider 1..12
 *     COUNT  = 6         # param 2..24        → slider 2..24
 *     ANGLE  = 30.0      # param [0:90] deg   → slider 0..90, unit "deg"
 *
 * Only simple numeric literals are hoisted, and only lines carrying the
 * `# param` marker. Everything is pure string work — no Python execution — so
 * it is fully unit-testable and safe to run client-side.
 */

// One assignment line: indent, NAME, = , number, optional `# ...` comment.
const ASSIGN_RE = /^(\s*)([A-Za-z_]\w*)(\s*=\s*)(-?\d+(?:\.\d+)?)(\s*#.*)?$/;

/** Parse `[min:max]` or `min..max` or `min:max` out of a comment string. */
function parseRange(comment) {
  if (!comment) return {};
  const m = comment.match(/\[?\s*(-?\d+(?:\.\d+)?)\s*(?:\.\.|:)\s*(-?\d+(?:\.\d+)?)\s*\]?/);
  if (!m) return {};
  const min = Number(m[1]);
  const max = Number(m[2]);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) return {};
  return { min, max };
}

/** Pull a trailing unit token (e.g. "deg", "mm") out of the comment, if any. */
function parseUnit(comment) {
  if (!comment) return undefined;
  const m = comment.match(/\b(mm|cm|m|deg|rad|in|°)\b/);
  return m ? m[1] : undefined;
}

/**
 * Extract the hoistable parameters from a BuildScript source string.
 * @param {string} code
 * @returns {Array<{ name:string, value:number, min?:number, max?:number, unit?:string, line:number }>}
 */
export function extractScriptParams(code) {
  if (!code || typeof code !== 'string') return [];
  const out = [];
  const seen = new Set();
  const lines = code.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(ASSIGN_RE);
    if (!m) continue;
    const comment = m[5] || '';
    if (!/\bparam\b/i.test(comment)) continue;   // opt-in marker required
    const name = m[2];
    if (seen.has(name)) continue;                 // first declaration wins
    seen.add(name);
    const { min, max } = parseRange(comment);
    const unit = parseUnit(comment);
    const p = { name, value: Number(m[4]), line: i };
    if (min !== undefined) p.min = min;
    if (max !== undefined) p.max = max;
    if (unit !== undefined) p.unit = unit;
    out.push(p);
  }
  return out;
}

/**
 * Return a copy of `code` with the hoisted parameter `name` set to `value`.
 * Preserves indentation, spacing, and the trailing `# param` comment. Returns
 * the original string unchanged if the parameter isn't found, so callers can
 * commit unconditionally. Integer-valued floats stay integers; fractional
 * values are written with their decimals.
 *
 * @param {string} code
 * @param {string} name
 * @param {number} value
 * @returns {string}
 */
export function setScriptParam(code, name, value) {
  if (!code || typeof code !== 'string') return code;
  if (!Number.isFinite(value)) return code;
  const lines = code.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(ASSIGN_RE);
    if (!m || m[2] !== name) continue;
    const comment = m[5] || '';
    if (!/\bparam\b/i.test(comment)) continue;
    const literal = Number.isInteger(value) ? String(value) : String(value);
    lines[i] = `${m[1]}${m[2]}${m[3]}${literal}${comment}`;
    return lines.join('\n');
  }
  return code;
}
