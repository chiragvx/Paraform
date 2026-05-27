/**
 * Geometry / printability validator.
 * Runs on normalized SCAD source after the semantic linter passes.
 * Returns warnings (not errors) — issues that won't prevent compilation
 * but will produce fragile or unprintable parts.
 */

import { normalize } from './linter.js';

const MIN_WALL    = 1.2;   // FDM minimum printable wall thickness (mm)
const MIN_FEATURE = 1.6;   // Minimum standalone feature diameter (mm)
const MAX_FN      = 128;   // $fn above this slows compile without improving print quality

function lineOf(text, index) {
    let line = 1;
    for (let i = 0; i < index && i < text.length; i++) {
        if (text[i] === '\n') line++;
    }
    return line;
}

/**
 * @returns {{ warnings: Array<{rule, message, line}> }}
 */
export function validateGeometry(source) {
    const norm = normalize(source);
    const warnings = [];

    // W1 — named wall-thickness parameter below FDM minimum
    const wallRe = /\b(wall(?:_thickness)?|wall_t|thickness|shell_t)\s*=\s*([0-9]*\.?[0-9]+)/g;
    let m;
    while ((m = wallRe.exec(norm)) !== null) {
        const val = parseFloat(m[2]);
        if (val > 0 && val < MIN_WALL) {
            warnings.push({
                rule: 'thin-wall',
                message: `\`${m[1]} = ${val}\` is below the FDM minimum of ${MIN_WALL} mm. Parts thinner than this will be fragile or fail to print.`,
                line: lineOf(norm, m.index),
            });
        }
    }

    // W2 — ai_plate with thin height argument
    const plateRe = /\bai_plate\s*\(\s*[^,]+,\s*[^,]+,\s*([0-9]*\.?[0-9]+)/g;
    while ((m = plateRe.exec(norm)) !== null) {
        const h = parseFloat(m[1]);
        if (!isNaN(h) && h > 0 && h < MIN_WALL) {
            warnings.push({
                rule: 'thin-plate',
                message: `ai_plate height ${h} mm is below the FDM minimum (${MIN_WALL} mm) — the plate will be too fragile to print reliably.`,
                line: lineOf(norm, m.index),
            });
        }
    }

    // W3 — ai_rod with tiny diameter
    const rodRe = /\bai_rod\s*\(\s*([0-9]*\.?[0-9]+)/g;
    while ((m = rodRe.exec(norm)) !== null) {
        const d = parseFloat(m[1]);
        if (!isNaN(d) && d > 0 && d < MIN_FEATURE) {
            warnings.push({
                rule: 'thin-rod',
                message: `ai_rod diameter ${d} mm is below ${MIN_FEATURE} mm — likely unprintable on FDM without special settings.`,
                line: lineOf(norm, m.index),
            });
        }
    }

    // W4 — $fn above useful threshold
    const fnRe = /\$fn\s*=\s*([0-9]+)/g;
    while ((m = fnRe.exec(norm)) !== null) {
        const fn = parseInt(m[1], 10);
        if (fn > MAX_FN) {
            warnings.push({
                rule: 'high-fn',
                message: `$fn = ${fn} produces unnecessarily dense geometry and will significantly slow compilation. Use ≤ 64 for printable parts.`,
                line: lineOf(norm, m.index),
            });
        }
    }

    // W5 — top-level ai_shell with zero or missing wall parameter
    // ai_shell(w, d, h, wall) — 4th arg < MIN_WALL
    const shellRe = /\bai_shell\s*\([^)]+\)/g;
    while ((m = shellRe.exec(norm)) !== null) {
        const args = m[0].slice(m[0].indexOf('(') + 1, -1).split(',').map(s => s.trim());
        if (args.length >= 4) {
            const wall = parseFloat(args[3]);
            if (!isNaN(wall) && wall > 0 && wall < MIN_WALL) {
                warnings.push({
                    rule: 'thin-shell-wall',
                    message: `ai_shell wall = ${wall} mm is below the FDM minimum (${MIN_WALL} mm).`,
                    line: lineOf(norm, m.index),
                });
            }
        }
    }

    // W6 — large overhang heuristic: translate Z by more than 10mm above origin
    // with no obvious support geometry (very rough — catches floating islands)
    const translateRe = /\btranslate\s*\(\s*\[[^\]]*,\s*[^\]]*,\s*(-?[0-9]*\.?[0-9]+)\s*\]/g;
    while ((m = translateRe.exec(norm)) !== null) {
        const z = parseFloat(m[1]);
        if (z > 20) {
            warnings.push({
                rule: 'large-z-offset',
                message: `translate Z = ${z} mm — verify this geometry has adequate support. Parts floating more than 20 mm above the build plate need support structures or a redesign.`,
                line: lineOf(norm, m.index),
            });
        }
    }

    return { warnings };
}

export function formatGeometryWarnings(warnings) {
    if (!warnings.length) return '';
    return warnings.map(w => `  ⚠ Line ${w.line} [${w.rule}]: ${w.message}`).join('\n');
}
