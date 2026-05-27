export const SKILLS = [
    {
        id: 'mounting_holes',
        name: 'Mounting Holes',
        category: 'fastening',
        description: 'Cylindrical through-holes at 4 corners of a rectangular pattern. Use inside difference().',
        usage: 'skill_mounting_holes(pattern_x, pattern_y, hole_d, depth)',
        params: [
            { key: 'pattern_x', label: 'Pattern Width',    type: 'number',  min: 5,   max: 300, default: 20,  unit: 'mm', desc: 'X distance between hole centres' },
            { key: 'pattern_y', label: 'Pattern Depth',    type: 'number',  min: 5,   max: 300, default: 15,  unit: 'mm', desc: 'Y distance between hole centres' },
            { key: 'hole_d',    label: 'Hole Diameter',    type: 'number',  min: 1.5, max: 8,   default: 3.4, unit: 'mm', desc: '2.4=M2, 3.4=M3, 4.5=M4 clearance' },
            { key: 'depth',     label: 'Depth',            type: 'number',  min: 1,   max: 100, default: 10,  unit: 'mm' },
        ],
        scad: `
module skill_mounting_holes(pattern_x=20, pattern_y=15, hole_d=3.4, depth=10) {
    for (sx = [-1, 1], sy = [-1, 1])
        translate([sx * pattern_x / 2, sy * pattern_y / 2, 0])
            cylinder(d=hole_d, h=depth + 2, center=false, $fn=24);
}`,
    },
    {
        id: 'ventilation_grid',
        name: 'Ventilation Grid',
        category: 'thermal',
        description: 'Rectangular slot array for airflow. Use inside difference() on a wall face.',
        usage: 'skill_ventilation_grid(rows, cols, slot_w, slot_h, gap_x, gap_y, wall_t)',
        params: [
            { key: 'rows',   label: 'Rows',            type: 'integer', min: 1,   max: 20, default: 3 },
            { key: 'cols',   label: 'Columns',         type: 'integer', min: 1,   max: 20, default: 5 },
            { key: 'slot_w', label: 'Slot Width',      type: 'number',  min: 0.8, max: 20, default: 2,  unit: 'mm' },
            { key: 'slot_h', label: 'Slot Height',     type: 'number',  min: 2,   max: 60, default: 8,  unit: 'mm' },
            { key: 'gap_x',  label: 'Gap X',           type: 'number',  min: 1,   max: 20, default: 3,  unit: 'mm' },
            { key: 'gap_y',  label: 'Gap Y',           type: 'number',  min: 1,   max: 20, default: 4,  unit: 'mm' },
            { key: 'wall_t', label: 'Wall Thickness',  type: 'number',  min: 1,   max: 10, default: 2,  unit: 'mm' },
        ],
        scad: `
module skill_ventilation_grid(rows=3, cols=5, slot_w=2, slot_h=8, gap_x=3, gap_y=4, wall_t=2) {
    for (r = [0:rows-1], c = [0:cols-1])
        translate([
            (c - (cols-1)/2) * (slot_w + gap_x) - slot_w/2,
            (r - (rows-1)/2) * (slot_h + gap_y) - slot_h/2,
            -1
        ])
        cube([slot_w, slot_h, wall_t + 2]);
}`,
    },
    {
        id: 'cable_routing',
        name: 'Cable Routing',
        category: 'routing',
        description: 'Cylindrical passthrough hole for cables. Use inside difference().',
        usage: 'skill_cable_routing(d, wall_t)',
        params: [
            { key: 'd',      label: 'Diameter',        type: 'number', min: 2,  max: 30, default: 5, unit: 'mm' },
            { key: 'wall_t', label: 'Wall Thickness',  type: 'number', min: 1,  max: 20, default: 2, unit: 'mm' },
        ],
        scad: `
module skill_cable_routing(d=5, wall_t=2) {
    translate([0, 0, -1])
        cylinder(d=d, h=wall_t + 2, center=false, $fn=32);
}`,
    },
    {
        id: 'board_cutout',
        name: 'Board Cutout',
        category: 'electronics',
        description: 'Rectangular PCB opening with 0.5 mm clearance. See BOARD_FOOTPRINTS for standard sizes. Use inside difference().',
        usage: 'skill_board_cutout(w, d, wall_t)',
        params: [
            { key: 'w',      label: 'Board Width',    type: 'number', min: 10, max: 200, default: 65,  unit: 'mm' },
            { key: 'd',      label: 'Board Depth',    type: 'number', min: 10, max: 200, default: 30,  unit: 'mm' },
            { key: 'wall_t', label: 'Wall Thickness', type: 'number', min: 1,  max: 20,  default: 2,   unit: 'mm' },
            { key: 'clr',    label: 'Clearance',      type: 'number', min: 0,  max: 2,   default: 0.5, unit: 'mm' },
        ],
        scad: `
module skill_board_cutout(w=65, d=30, wall_t=2, clr=0.5) {
    translate([-(w + clr*2)/2, -(d + clr*2)/2, -1])
        cube([w + clr*2, d + clr*2, wall_t + 2]);
}`,
    },
    {
        id: 'snap_fit_tab',
        name: 'Snap-Fit Tab',
        category: 'assembly',
        description: 'Flexible clip tab with locking hook. Use with union() on a panel edge.',
        usage: 'skill_snap_fit_tab(w, t, h, hook_h)',
        params: [
            { key: 'w',      label: 'Tab Width',   type: 'number', min: 3,   max: 30, default: 8,   unit: 'mm' },
            { key: 't',      label: 'Thickness',   type: 'number', min: 0.8, max: 3,  default: 1.5, unit: 'mm' },
            { key: 'h',      label: 'Height',      type: 'number', min: 4,   max: 40, default: 12,  unit: 'mm' },
            { key: 'hook_h', label: 'Hook Height', type: 'number', min: 0.5, max: 4,  default: 2,   unit: 'mm' },
        ],
        scad: `
module skill_snap_fit_tab(w=8, t=1.5, h=12, hook_h=2) {
    union() {
        translate([-w/2, 0, 0]) cube([w, t, h]);
        translate([-w/2, -hook_h, h - hook_h]) cube([w, t + hook_h, hook_h]);
    }
}`,
    },
    {
        id: 'text_emboss',
        name: 'Text Emboss',
        category: 'aesthetics',
        description: 'Raised or recessed text. union() for raised, difference() for recessed.',
        usage: 'skill_text_emboss(txt, size, depth)',
        params: [
            { key: 'txt',   label: 'Text',  type: 'string', default: 'TEXT' },
            { key: 'size',  label: 'Size',  type: 'number', min: 3,   max: 60, default: 8, unit: 'mm' },
            { key: 'depth', label: 'Depth', type: 'number', min: 0.4, max: 5,  default: 1, unit: 'mm' },
        ],
        scad: `
module skill_text_emboss(txt="TEXT", size=8, depth=1) {
    linear_extrude(height=depth)
        text(txt, size=size, halign="center", valign="center");
}`,
    },
];

export const BOARD_FOOTPRINTS = {
    pi_zero_2w:      { w: 65.0,  d: 30.0, label: 'Raspberry Pi Zero / Zero 2W' },
    pi_4:            { w: 85.0,  d: 56.0, label: 'Raspberry Pi 4 / 3B+' },
    arduino_nano:    { w: 43.2,  d: 17.8, label: 'Arduino Nano' },
    arduino_uno:     { w: 68.6,  d: 53.3, label: 'Arduino Uno' },
    arduino_mega:    { w: 101.6, d: 53.3, label: 'Arduino Mega 2560' },
    esp32_devkit:    { w: 51.4,  d: 28.2, label: 'ESP32 DevKit-C' },
    nodemcu_esp8266: { w: 49.0,  d: 26.0, label: 'NodeMCU (ESP8266)' },
    seeed_xiao:      { w: 21.0,  d: 17.5, label: 'Seeed Studio XIAO' },
};

export function getSkill(id) { return SKILLS.find(s => s.id === id); }

export function getAllSkillScad() { return SKILLS.map(s => s.scad).join('\n'); }

export function buildSkillContext() {
    const lines = [
        '## Available Skills',
        '',
        'Skills are pre-built OpenSCAD module functions auto-injected into every compile.',
        'Call them directly — no `use <>` required.',
        'Subtractive skills (holes, slots, cutouts) go inside `difference()`.',
        'Additive skills (tabs, text) go inside `union()`.',
        '',
    ];
    for (const skill of SKILLS) {
        lines.push(`### ${skill.name} [${skill.id}]`);
        lines.push(skill.description);
        lines.push(`Call: \`${skill.usage}\``);
        lines.push('Parameters:');
        for (const p of skill.params) {
            const unitStr = p.unit ? ` (${p.unit})` : '';
            const descStr = p.desc ? ` — ${p.desc}` : '';
            lines.push(`  - ${p.key}: default ${p.default}${unitStr}${descStr}`);
        }
        lines.push('');
    }
    lines.push('## Known Board Footprints (use with skill_board_cutout)');
    for (const [id, fp] of Object.entries(BOARD_FOOTPRINTS)) {
        lines.push(`  - ${id}: w=${fp.w}, d=${fp.d}  (${fp.label})`);
    }
    return lines.join('\n');
}
