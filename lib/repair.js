/**
 * WASM compile-error categorizer and repair message builder.
 * Used by finalizeModularRender and finalizeMultiPartRender to build
 * targeted LLM correction prompts when OpenSCAD compilation fails.
 */

export const MAX_COMPILE_RETRIES = 3;

const ERROR_PATTERNS = [
    {
        pattern: /CGAL|Manifold|not.*manifold|degenerate|boolean.*operation|self.intersect/i,
        category: 'non-manifold',
        hint: 'The geometry has non-manifold surfaces or degenerate faces. Ensure every volume subtracted inside `difference()` fully penetrates the parent solid by at least 1 mm past each face (translate 1 mm before, height += 2). Avoid zero-thickness walls and self-intersecting geometry.',
    },
    {
        pattern: /File.*not found|Cannot open.*file|use.*no such|WARNING.*include.*not found|include.*failed/i,
        category: 'missing-file',
        hint: 'A `use <...>` path cannot be resolved inside the worker. Only use `lib/semantic_api.scad` and `lib/fasteners.scad` — all other imports are banned. Remove every other `use` or `include` statement.',
    },
    {
        pattern: /syntax error|parse error|unexpected.*token|expected.*got|ERROR.*:.*line \d|unterminated/i,
        category: 'syntax',
        hint: 'The code has a syntax error. Check for: missing semicolons after statements, unbalanced braces/parentheses, invalid use of = vs ==, or OpenSCAD keywords used as variable names.',
    },
    {
        pattern: /undefined.*variable|unknown.*identifier|WARNING.*undefined|variable.*not.*defined|undeclared/i,
        category: 'undefined-identifier',
        hint: 'A variable or module name is undefined. Declare all variables at the top of the file. Module names are case-sensitive in OpenSCAD. Ensure every called module is either defined in this file or comes from an allowed `use <>` import.',
    },
    {
        pattern: /recursion|circular|recursive.*module|stack overflow/i,
        category: 'recursion',
        hint: 'A recursive or circular module dependency was detected. Add a clear base-case condition that stops recursion, or restructure to avoid calling the same module from within itself.',
    },
    {
        pattern: /division.*zero|nan|infinite|overflow/i,
        category: 'arithmetic',
        hint: 'An arithmetic error (division by zero, NaN, or overflow) occurred. Guard all divisions with a check that the denominator is non-zero. Avoid extremely large or small values.',
    },
];

/**
 * Classify a WASM stderr blob into a named category + actionable hint.
 * @returns {{ category: string, hint: string }}
 */
export function categorizeWasmError(errorText) {
    for (const { pattern, category, hint } of ERROR_PATTERNS) {
        if (pattern.test(errorText)) return { category, hint };
    }
    return {
        category: 'compile-error',
        hint: 'A general compile error occurred. Read the compiler output carefully — it usually names the file and line number. Fix the specific issue mentioned before returning.',
    };
}

/**
 * Build the injected [assistant, user] message pair that the repair loop
 * appends to the conversation before re-calling the LLM.
 *
 * @param {string} category     - from categorizeWasmError
 * @param {string} hint         - from categorizeWasmError
 * @param {string} errorText    - raw WASM stderr
 * @param {string} pendingCode  - the SCAD source that failed
 * @param {number} attempt      - current attempt number (1-based)
 * @param {number} maxAttempts  - MAX_COMPILE_RETRIES
 * @returns {Array<{role:string, content:string}>}
 */
export function buildRepairMessages(category, hint, errorText, pendingCode, attempt, maxAttempts) {
    const lines = errorText.split('\n').filter(l => l.trim());
    const shortErr = lines.slice(0, 12).join('\n');
    const attemptNote = maxAttempts > 1 ? ` (repair attempt ${attempt}/${maxAttempts})` : '';

    return [
        {
            role: 'assistant',
            content: JSON.stringify({ changes: 'Code applied', openscad_code: pendingCode }),
        },
        {
            role: 'user',
            content: [
                `The OpenSCAD code failed to compile${attemptNote}.`,
                ``,
                `Error category: ${category}`,
                `What to fix: ${hint}`,
                ``,
                `Compiler output:`,
                shortErr,
                ``,
                `Return ONLY the corrected code in the same JSON format: { "changes": "...", "openscad_code": "..." }`,
            ].join('\n'),
        },
    ];
}
