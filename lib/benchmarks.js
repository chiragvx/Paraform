/**
 * Benchmark suite — 10 reference designs.
 * Run via: window.runBenchmarks() in the browser console.
 *
 * Each benchmark runs the SCAD source through lint + geometry validation.
 * "compile" flag means it also queues a WASM compile via the pool.
 */

import { lint, formatErrorsForLLM } from './validators/linter.js';
import { validateGeometry, formatGeometryWarnings } from './validators/geometry.js';

export const BENCHMARKS = [
    {
        id: 'simple_box',
        label: 'Simple parametric box',
        source: `
use <lib/semantic_api.scad>
wall = 2.0; // [number, Wall Thickness, 1.2, 5, 0.1]
w = 80;     // [number, Width, 20, 200, 1]
d = 60;     // [number, Depth, 20, 200, 1]
h = 40;     // [number, Height, 10, 150, 1]
module my_box() { ai_shell(w, d, h, wall); }
my_box();
`,
        expectLintOk: true,
        expectWarnings: 0,
    },
    {
        id: 'servo_bracket',
        label: 'SG90 servo mount bracket',
        source: `
use <lib/semantic_api.scad>
wall = 2.5; // [number, Wall, 1.5, 5, 0.1]
module servo_bracket() {
    difference() {
        ai_plate(50, 40, wall);
        skill_mounting_holes(34.5, 7.8, 2.4, wall);
    }
}
servo_bracket();
`,
        expectLintOk: true,
        expectWarnings: 0,
    },
    {
        id: 'vented_enclosure',
        label: 'Vented electronics enclosure',
        source: `
use <lib/semantic_api.scad>
wall = 2.0; // [number, Wall, 1.5, 4, 0.1]
module vented_box() {
    difference() {
        ai_shell(100, 70, 50, wall);
        skill_ventilation_grid(4, 6, 2, 8, 3, 4, wall);
    }
}
vented_box();
`,
        expectLintOk: true,
        expectWarnings: 0,
    },
    {
        id: 'cable_gland_panel',
        label: 'Panel with cable routing holes',
        source: `
use <lib/semantic_api.scad>
wall = 3.0; // [number, Wall, 2, 6, 0.5]
module cable_panel() {
    difference() {
        ai_plate(80, 60, wall);
        translate([0, 0, 0]) skill_cable_routing(6, wall);
        translate([20, 0, 0]) skill_cable_routing(4, wall);
        translate([-20, 0, 0]) skill_cable_routing(8, wall);
    }
}
cable_panel();
`,
        expectLintOk: true,
        expectWarnings: 0,
    },
    {
        id: 'snap_lid',
        label: 'Snap-fit lid',
        source: `
use <lib/semantic_api.scad>
module snap_lid() {
    union() {
        ai_plate(80, 60, 2);
        translate([40, 0, 2]) skill_snap_fit_tab(8, 1.5, 10, 2);
        translate([-40, 0, 2]) skill_snap_fit_tab(8, 1.5, 10, 2);
    }
}
snap_lid();
`,
        expectLintOk: true,
        expectWarnings: 0,
    },
    {
        id: 'labelled_plate',
        label: 'Plate with embossed text',
        source: `
use <lib/semantic_api.scad>
module labelled_plate() {
    union() {
        ai_plate(80, 40, 3);
        translate([0, 0, 3]) skill_text_emboss("ParaForm", 8, 1);
    }
}
labelled_plate();
`,
        expectLintOk: true,
        expectWarnings: 0,
    },
    {
        id: 'pi_mount',
        label: 'Raspberry Pi Zero mount tray',
        source: `
use <lib/semantic_api.scad>
wall = 2.0; // [number, Wall, 1.5, 4, 0.1]
module pi_tray() {
    difference() {
        ai_plate(75, 40, wall);
        skill_board_cutout(65, 30, wall, 0.5);
        skill_mounting_holes(58, 23, 2.4, wall);
    }
}
pi_tray();
`,
        expectLintOk: true,
        expectWarnings: 0,
    },
    {
        id: 'thin_wall_fail',
        label: 'Thin-wall warning trigger',
        source: `
use <lib/semantic_api.scad>
wall = 0.8; // intentionally thin
module thin_box() { ai_shell(50, 40, 30, wall); }
thin_box();
`,
        expectLintOk: true,
        expectWarnings: 1,   // should flag thin-shell-wall
    },
    {
        id: 'raw_primitive_fail',
        label: 'Raw primitive lint block',
        source: `
// Intentionally banned — lint should reject this
cube([50, 40, 30]);
`,
        expectLintOk: false,
        expectWarnings: 0,
    },
    {
        id: 'bearing_housing',
        label: '608ZZ bearing housing',
        source: `
use <lib/semantic_api.scad>
wall = 3.0; // [number, Wall, 2, 6, 0.5]
od = 28;    // [number, Outer Diameter, 24, 60, 1]
h  = 9;     // [number, Housing Height, 7, 30, 0.5]
module bearing_housing() {
    difference() {
        ai_rod(od, h);
        ai_drill_clearance(22, h);
    }
}
bearing_housing();
`,
        expectLintOk: true,
        expectWarnings: 0,
    },
];

/**
 * Run all benchmarks through lint + geometry validation (no WASM needed).
 * @returns {Array<BenchmarkResult>}
 */
export function runBenchmarks() {
    const results = [];

    for (const bench of BENCHMARKS) {
        const lintResult  = lint(bench.source, { fileName: 'bench.scad' });
        const geomResult  = validateGeometry(bench.source);

        const lintPass    = lintResult.ok === bench.expectLintOk;
        const warnPass    = bench.expectWarnings == null || geomResult.warnings.length === bench.expectWarnings;
        const pass        = lintPass && warnPass;

        results.push({
            id:       bench.id,
            label:    bench.label,
            pass,
            lintOk:   lintResult.ok,
            lintErrors: lintResult.errors,
            warnings: geomResult.warnings,
            notes: [
                !lintPass  ? `lint expected ${bench.expectLintOk} got ${lintResult.ok}` : null,
                !warnPass  ? `warnings expected ${bench.expectWarnings} got ${geomResult.warnings.length}` : null,
            ].filter(Boolean).join('; '),
        });
    }

    const passed = results.filter(r => r.pass).length;
    console.group(`[Benchmarks] ${passed}/${results.length} passed`);
    for (const r of results) {
        const icon = r.pass ? '✓' : '✗';
        if (r.pass) {
            console.log(`${icon} ${r.id} — ${r.label}`);
        } else {
            console.warn(`${icon} ${r.id} — ${r.label}`, r.notes, { lintErrors: r.lintErrors, warnings: r.warnings });
        }
    }
    console.groupEnd();

    return results;
}
