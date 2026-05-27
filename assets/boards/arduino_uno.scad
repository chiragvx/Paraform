// Arduino Uno R3. ParaForm immutable asset.
// @dependency lib/semantic_api.scad
//
// Origin Anchor Rule: [0,0,0] is the corner at (X-min, Y-min), bottom of PCB.
// PCB: 68.6 x 53.4 mm. Thickness: 1.6 mm.
// Component clearance above: 15 mm (USB-A + DC barrel jack).
// Mount holes (M3): (14.0, 2.54), (66.04, 35.56), (66.04, 5.08), (15.24, 50.8)

module arduino_uno_mesh() {
    // PCB
    color([0.03, 0.25, 0.08])
        cube([68.6, 53.4, 1.6], center=false);
    // ATmega328P chip
    color([0.08, 0.08, 0.08])
        translate([27, 18, 1.6])
            cube([10, 10, 1.2], center=false);
    // USB Type-B connector
    color([0.70, 0.70, 0.72])
        translate([1, 38, 1.6])
            cube([12, 12, 11], center=false);
    // DC barrel jack
    color([0.15, 0.15, 0.15])
        translate([1, 2, 1.6])
            cube([9, 12, 10], center=false);
    // 16MHz crystal
    color([0.85, 0.82, 0.60])
        translate([42, 26, 1.6])
            cube([5, 3, 3], center=false);
    // Shield headers (silhouette only)
    color([0.20, 0.20, 0.20]) {
        translate([14.5, 0, 1.6]) cube([54, 2.54, 8.5], center=false);  // bottom row
        translate([14.5, 50.8, 1.6]) cube([38, 2.54, 8.5], center=false); // top row
        translate([0, 14.5, 1.6]) cube([2.54, 28, 8.5], center=false);  // left power
        translate([64, 7.6, 1.6]) cube([2.54, 40, 8.5], center=false);  // right analog
    }
}

// Mount hole positions as a module for use in difference()
module arduino_uno_mount_holes(depth=10) {
    for (pos = [[14.0, 2.54], [66.04, 35.56], [66.04, 5.08], [15.24, 50.8]]) {
        translate([pos[0], pos[1], -0.1])
            cylinder(d=3.2, h=depth + 0.2, center=false, $fn=16);
    }
}

// Clearance: full footprint + component height.
module arduino_uno_clearance() {
    translate([-0.4, -0.4, -0.1])
        cube([68.6 + 0.8, 53.4 + 0.8, 18], center=false);
}
