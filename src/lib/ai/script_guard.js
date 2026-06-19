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

// Paraform typed-op TOOL names. These are DOCUMENT operations exposed to the
// agent OUTSIDE a script (addBox, addGear, placeLibraryPart, …) — they are NOT
// functions in the build123d sandbox. A script that calls one dies with a
// NameError at compile ("name 'addGear' is not defined"); the model then burns
// turns guessing. Catch the common ones HERE with an actionable redirect: either
// call the tool directly, or write the geometry in plain build123d. The list is
// not exhaustive — an unlisted tool still NameErrors in the sandbox, this just
// turns the frequent mistakes into a clear message up front. Mirrors the
// generators/primitives in _BUILD_GATED (tools.js); keep roughly in step.
const TYPED_OP_TOOLS = [
    // primitives + feature ops
    'addBox', 'addCylinder', 'addSphere', 'addTorus', 'addCone',
    'addSketch', 'addExtrude', 'addRevolve', 'addSweep', 'addLoft',
    'addFillet', 'addChamfer', 'addShell', 'addHole',
    'addUnion', 'addCut', 'addIntersect',
    // parametric generators
    'addGear', 'addPulley', 'addSprocket', 'addTSlotExtrusion', 'addScrewBoss', 'addStandoff',
    'addFan', 'addFanBlade', 'addImpeller', 'addAuger', 'addBlowerWheel', 'addPaddleWheel',
    'addMountingPlate', 'addBracket', 'addGusset', 'addTSlotBracket', 'addShaftHub',
    'addThreadedInsertBoss', 'addNutTrap', 'addSnapHook',
    'addBearingPocket', 'addMotorMount', 'addShaftCoupler', 'addWheel', 'addTimingPulley', 'addRackGear',
    'addProjectBox', 'addLid', 'addPCBTray', 'addHinge', 'addKnob', 'addHandle', 'addFoot',
    'addBatteryHolder', 'addDINRailClip', 'addCableClip', 'addGridfinityBin', 'addPiCase',
    // placement / assembly / scripting
    'placeLibraryPart', 'addStandardPart', 'add_mate', 'replace_component', 'build_part_recipe',
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

    // 4) Paraform typed-op tool calls — these don't exist inside the build123d
    //    sandbox (they're document operations, not script functions), so a script
    //    that calls one would NameError at compile. Redirect early. The `(^|…)`
    //    prefix avoids matching method calls (`obj.addBox(`) and longer
    //    identifiers (`my_addGear(`); a name the script DEFINES itself
    //    (`def addGear(...)` — a user implementing their own helper) is allowed.
    for (const fn of TYPED_OP_TOOLS) {
        const e = _esc(fn);
        if (!new RegExp(`(^|[^.\\w])${e}\\s*\\(`, 'm').test(code)) continue;
        if (new RegExp(`\\bdef\\s+${e}\\s*\\(`).test(code)) continue;  // locally defined → their own
        return { ok: false, error:
            `'${fn}' is a Paraform typed-op TOOL, not a function available inside a build123d script (the sandbox has only build123d, math, numpy). Two options: (1) call the ${fn} tool DIRECTLY instead of from a script, or (2) build this geometry with pure build123d here (primitives, lofts, sweeps, booleans). A BuildScript is the escape hatch for geometry the typed ops can't express — not for re-invoking them.` };
    }

    return { ok: true };
}

export default guardScript;
