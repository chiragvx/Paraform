/**
 * ParaForm Semantic Linter — updatex.md §3A + §6 Milestone 1.
 *
 * G3 (plan): naive `cube(` regex is trivially bypassed by comments/whitespace.
 * Pipeline:
 *   1. NORMALIZE: strip // line comments, /* block * / comments, string literals,
 *      collapse runs of whitespace to single space, preserve line numbers via
 *      newline placeholder so error messages still point at the right line.
 *   2. SCAN: apply rule regexes to the normalized text.
 *   3. SCOPE: rule 4 (no top-level transforms) uses a brace counter to skip
 *      transforms nested inside any `module foo() { … }`.
 */

import { getAssetManifest, getAssetSource } from '../catalog.js';

const BANNED_PRIMITIVES = ['cube', 'cylinder', 'sphere', 'polyhedron'];
const TRANSFORM_OPS = ['translate', 'rotate', 'mirror', 'scale', 'multmatrix'];

function knownAssetPaths() {
    const fromManifest = getAssetManifest().map(a => a.file);
    return new Set([
        ...fromManifest,
        'lib/semantic_api.scad',
        'lib/fasteners.scad',
    ]);
}

/**
 * Strip comments + string literals, replacing each removed character with a
 * space (or newline for newlines inside the removed range) so line/column
 * numbers in the normalized output match the original.
 */
export function normalize(source) {
    const out = [];
    let i = 0;
    const n = source.length;
    while (i < n) {
        const c = source[i];
        const next = source[i + 1];

        // Line comment
        if (c === '/' && next === '/') {
            while (i < n && source[i] !== '\n') { out.push(' '); i++; }
            continue;
        }
        // Block comment
        if (c === '/' && next === '*') {
            out.push(' ', ' ');
            i += 2;
            while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
                out.push(source[i] === '\n' ? '\n' : ' ');
                i++;
            }
            if (i < n) { out.push(' ', ' '); i += 2; }
            continue;
        }
        // String literal
        if (c === '"') {
            out.push('"');
            i++;
            while (i < n && source[i] !== '"') {
                if (source[i] === '\\' && i + 1 < n) { out.push(' ', ' '); i += 2; continue; }
                out.push(source[i] === '\n' ? '\n' : ' ');
                i++;
            }
            if (i < n) { out.push('"'); i++; }
            continue;
        }

        out.push(c);
        i++;
    }
    return out.join('');
}

function lineOf(text, index) {
    let line = 1;
    for (let i = 0; i < index && i < text.length; i++) {
        if (text[i] === '\n') line++;
    }
    return line;
}

/**
 * Lint result:
 *   ok       — true when no HARD errors are present (generation is not blocked)
 *   errors   — hard errors: guaranteed WASM compile failures (block + retry)
 *   warnings — soft warnings: style / best-practice (shown in chat, never block)
 *
 * Hard errors (block generation):
 *   unknown-use  — `use <>` path that cannot resolve; WASM will fail to compile.
 *
 * Soft warnings (informational only):
 *   no-raw-primitives      — prefers ai_* wrappers but raw primitives still compile
 *   no-top-level-transform — style advice; translate() at top level is valid SCAD
 *   fastener-access-depth  — missing access_depth is a safety hint, not a compile error
 */
export function lint(source, opts = {}) {
    const { allowPrimitivesInLib = true, fileName = 'input.scad' } = opts;

    // Library files are allowed to use raw primitives — they're the wrappers.
    if (allowPrimitivesInLib && fileName.startsWith('lib/')) {
        return { ok: true, errors: [], warnings: [] };
    }

    const norm = normalize(source);
    const errors   = [];   // hard — block generation
    const warnings = [];   // soft — show in chat, never block

    // ── HARD: Rule 2 — every `use <…>` must resolve to a known path.
    // Unknown imports cause guaranteed WASM compile failures with cryptic errors.
    const known = knownAssetPaths();
    const useRe = /\buse\s*<\s*([^>]+?)\s*>/g;
    let um;
    while ((um = useRe.exec(norm)) !== null) {
        const path = um[1].trim();
        if (!known.has(path) && !getAssetSource(path)) {
            errors.push({
                rule: 'unknown-use',
                message: `\`use <${path}>\` cannot be resolved. Remove it or use a registered path (lib/semantic_api.scad, lib/fasteners.scad, or an asset file).`,
                line: lineOf(norm, um.index),
            });
        }
    }

    // ── SOFT: Rule 1 — raw primitive usage (style recommendation only).
    // Raw cube/cylinder/sphere still compile correctly; ai_* wrappers are preferred.
    for (const prim of BANNED_PRIMITIVES) {
        const re = new RegExp(`\\b${prim}\\s*\\(`, 'g');
        let m;
        while ((m = re.exec(norm)) !== null) {
            warnings.push({
                rule: 'no-raw-primitives',
                message: `\`${prim}(\` — consider using ai_* wrappers (ai_plate, ai_rod, ai_shell) for consistent wall-thickness enforcement.`,
                line: lineOf(norm, m.index),
            });
            break; // one warning per primitive type is enough — avoid flooding
        }
    }

    // ── SOFT: Rule 3 — fastener access_depth hint.
    const fastRe = /\b(fastener_m\d+_cap)\s*\(([^)]*)\)/g;
    let fm;
    while ((fm = fastRe.exec(norm)) !== null) {
        if (!/access_depth\s*=/.test(fm[2])) {
            warnings.push({
                rule: 'fastener-access-depth',
                message: `\`${fm[1]}(...)\` — add access_depth to validate the tool clearance corridor.`,
                line: lineOf(norm, fm.index),
            });
        }
    }

    // ── SOFT: Rule 4 — top-level transforms (style recommendation only).
    // Valid SCAD; wrapping in a module is good practice but not required.
    let depth = 0;
    let idx = 0;
    let topLevelTransformWarned = false;
    while (idx < norm.length && !topLevelTransformWarned) {
        const c = norm[idx];
        if (c === '{') { depth++; idx++; continue; }
        if (c === '}') { depth = Math.max(0, depth - 1); idx++; continue; }

        if (depth === 0) {
            for (const op of TRANSFORM_OPS) {
                if (norm.startsWith(op, idx)) {
                    const before = idx === 0 ? ' ' : norm[idx - 1];
                    const after  = norm[idx + op.length] || ' ';
                    if (!/\w/.test(before) && /[\s(]/.test(after)) {
                        warnings.push({
                            rule: 'no-top-level-transform',
                            message: `Top-level \`${op}(…)\` outside a module — wrapping geometry in \`module my_part() { … }\` improves reusability.`,
                            line: lineOf(norm, idx),
                        });
                        topLevelTransformWarned = true; // one warning total
                        idx += op.length;
                        break;
                    }
                }
            }
        }
        idx++;
    }

    return { ok: errors.length === 0, errors, warnings };
}

/**
 * Format errors as a compact text block suitable for re-prompting the LLM.
 */
export function formatErrorsForLLM(errors) {
    if (!errors.length) return '';
    return errors.map(e => `  • Line ${e.line} [${e.rule}]: ${e.message}`).join('\n');
}
