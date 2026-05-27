// N20 micro gear motor (generic). ParaForm immutable asset.
// @dependency lib/semantic_api.scad
//
// Origin Anchor Rule: [0,0,0] is the center of the output shaft end face.
// Gear box: 10 x 12 x 15 mm. Motor body: 10 x 10 x 20 mm behind gear box.
// Shaft: 3 mm OD, 9 mm long, extends in +Z.
// Total depth (gear+motor): 35 mm in -Z from origin.

module n20_mesh() {
    // Gearbox (roughly square, sits in Z = 0 to -15)
    color([0.55, 0.55, 0.58])
        translate([-10/2, -12/2, -15])
            cube([10, 12, 15], center=false);
    // Motor body (cylindrical approximated as rounded cube, Z = -15 to -35)
    color([0.20, 0.20, 0.22])
        translate([-5, -5, -35])
            cube([10, 10, 20], center=false);
    // Output shaft (Z = 0 to +9)
    color([0.68, 0.68, 0.70])
        cylinder(d=3, h=9, center=false, $fn=20);
    // Wire pigtail stub at motor back
    color([0.10, 0.10, 0.12])
        translate([-1, -4, -35])
            cube([2, 1, 6], center=false);
}

// Clearance: body + shaft passage.
module n20_clearance() {
    translate([-10/2 - 0.3, -12/2 - 0.3, -35 - 0.3])
        cube([10 + 0.6, 12 + 0.6, 35 + 0.6], center=false);
    translate([0, 0, -0.1])
        cylinder(d=3.4, h=10, center=false, $fn=20);
}
