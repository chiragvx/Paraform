// ParaForm Semantic API — banned-primitive replacements.
// Spec: updatex.md §3A. The AI MUST use these instead of raw cube/cylinder.

// Centered plate. Bounding box always (w, d, h), origin at geometric center.
module ai_plate(w, d, h) {
    translate([-w/2, -d/2, -h/2])
        cube([w, d, h], center=false);
}

// Through-hole drill with Z-fighting protection.
// Origin = center of top face of the parent surface; cuts down through `thickness`.
module ai_drill_clearance(d, thickness) {
    translate([0, 0, -1])
        cylinder(d=d, h=thickness + 2, center=false, $fn=32);
}

// Centered rod along Z axis, length `l`, diameter `d`.
module ai_rod(d, l) {
    translate([0, 0, -l/2])
        cylinder(d=d, h=l, center=false, $fn=48);
}

// Hollow shell with uniform wall. Bounding box (w, d, h), wall thickness `wall`.
// Open on +Z. Origin at geometric center of the outer envelope.
module ai_shell(w, d, h, wall) {
    difference() {
        ai_plate(w, d, h);
        translate([0, 0, wall])
            ai_plate(w - 2*wall, d - 2*wall, h);
    }
}

// Standardized mounting tab (lug) for bolting plates together.
// Origin at the bolt-hole center; tab extends in +X by `length`.
module ai_mount_tab(length, width, thickness, bolt_d) {
    difference() {
        translate([0, -width/2, -thickness/2])
            cube([length, width, thickness], center=false);
        ai_drill_clearance(bolt_d, thickness);
    }
}
