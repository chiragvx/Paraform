/**
 * Static pre-check for AI-authored build123d scripts.
 *
 * When the model drops to raw Python via the tools_code.js escape hatch, this
 * guard gives it FAST, CLEAR feedback before anything is committed to the
 * document or shipped to the kernel — "you imported `os`, that's blocked" beats
 * a silent failure or a sandbox rejection three turns later.
 *
 * It is DELIBERATELY CONSERVATIVE and string-level: a regex/substring scan, not
 * an AST or a real sandbox. It will not catch every escape (obfuscated builtin
 * lookups, string concatenation tricks) and it is NOT a security boundary — the
 * actual enforcement is a kernel-side sandbox built separately. This layer only
 * exists to keep the model honest and to fail obvious mistakes early. Treat a
 * `{ ok:true }` here as "looks sane to send on", never as "proven safe".
 *
 * Returns on the FIRST violation found, with a message naming the offending
 * token so the model can self-repair on the next step.
 */

// Modules that have no business inside a CAD body script — filesystem, network,
// process control, serialisation, and reflection escape hatches. `math`/`numpy`
// and of course `build123d` are intentionally absent (they're expected).
const BLOCKED_MODULES = [
    'os', 'sys', 'subprocess', 'socket', 'shutil', 'pathlib', 'importlib',
    'ctypes', 'requests', 'urllib', 'http', 'pickle', 'marshal',
    'multiprocessing', 'threading', 'builtins', 'io', 'tempfile', 'glob',
];

// Builtins that read/write arbitrary code, files, or attributes. Matched as
// CALL tokens (`name(`) so an attribute or variable that merely shares the name
// is not flagged.
const BLOCKED_CALLS = [
    'eval', 'exec', 'compile', 'open', '__import__', 'globals', 'locals',
    'vars', 'getattr', 'setattr', 'delattr', 'input',
];

// Dunder strings used to walk the object graph back out to the interpreter.
const BLOCKED_DUNDERS = [
    '__subclasses__', '__globals__', '__builtins__', '__bases__', '__mro__',
    '__class__',
];

/** Escape a token for safe interpolation into a RegExp source. */
function _esc(tok) {
    return tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a matcher for a blocked import. Catches all of:
 *   import os
 *   import os.path
 *   import os as o
 *   from os import getcwd
 *   from os.path import join
 * The `\b` word boundaries mean a variable literally named `import_count` (no
 * `import`/`from` keyword in front) does NOT trip the import rules.
 */
function _importRegexes(mod) {
    const m = _esc(mod);
    return [
        // `import <mod>` / `import <mod>.sub` / `import <mod> as x`
        new RegExp(`(^|;)\\s*import\\s+${m}\\b`, 'm'),
        // `from <mod> import …` / `from <mod>.sub import …`
        new RegExp(`(^|;)\\s*from\\s+${m}\\b`, 'm'),
    ];
}

/**
 * Static safety pre-check for a build123d script.
 *
 * @param {string} code
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function guardScript(code) {
    if (typeof code !== 'string' || code.length === 0) {
        return { ok: false, error: 'script code must be a non-empty string' };
    }

    // 1) Dangerous module imports (import X / import X.y / from X / from X.y).
    for (const mod of BLOCKED_MODULES) {
        for (const re of _importRegexes(mod)) {
            if (re.test(code)) {
                return { ok: false, error: `blocked import of module '${mod}' — filesystem/network/process/reflection access is not allowed in a build123d script (sandboxed). Use only build123d, math, and numpy.` };
            }
        }
    }

    // 2) Dangerous builtins used as calls (`name(`), tolerant of whitespace.
    for (const name of BLOCKED_CALLS) {
        const re = new RegExp(`\\b${_esc(name)}\\s*\\(`);
        if (re.test(code)) {
            return { ok: false, error: `blocked call to '${name}(' — dynamic code/file/attribute access is not allowed in a build123d script. Build the body with normal build123d API calls.` };
        }
    }

    // 3) Dunder escape strings (no call paren needed — the string itself is the
    //    escape vector, e.g. ().__class__.__bases__).
    for (const d of BLOCKED_DUNDERS) {
        if (code.includes(d)) {
            return { ok: false, error: `blocked dunder '${d}' — interpreter-escape attribute access is not allowed in a build123d script.` };
        }
    }

    return { ok: true };
}

export default guardScript;
