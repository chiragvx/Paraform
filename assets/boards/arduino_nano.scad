// Arduino Nano V3. ParaForm immutable asset.
// @dependency lib/semantic_api.scad
//
// Origin Anchor Rule: [0,0,0] is the center of the PCB, at the bottom face.
// PCB: 18 x 45 mm. Thickness: 1.6 mm.
// Component height above PCB: ~10 mm (tallest cap / USB connector).
// Headers: 2x 15-pin at Y = ±7.62 mm from center, Z = 0 (through-hole, pins below).
// USB Mini-B: at one short edge (Y = -22.5), center of edge.
// Mount pins extend 3 mm below PCB.

module arduino_nano_mesh() {
    // PCB
    color([0.03, 0.25, 0.08])
        translate([-18/2, -45/2, 0])
            cube([18, 45, 1.6], center=false);
    // Chip (ATmega328P) — center of board
    color([0.08, 0.08, 0.08])
        translate([-5, -8, 1.6])
            cube([10, 16, 1.2], center=false);
    // USB Mini-B connector
    color([0.75, 0.75, 0.78])
        translate([-4, -45/2 - 1.5, 1.6])
            cube([8, 6, 4.5], center=false);
    // Header pins (left bank) — visual only
    color([0.20, 0.20, 0.20])
        translate([-9, -37, -3])
            cube([1.5, 30, 3], center=false);
    // Header pins (right bank)
    color([0.20, 0.20, 0.20])
        translate([7.5, -37, -3])
            cube([1.5, 30, 3], center=false);
}

// Clearance: PCB outline + component height + header pins below.
module arduino_nano_clearance() {
    // Above PCB (components)
    translate([-18/2 - 0.3, -45/2 - 0.3, 0])
        cube([18 + 0.6, 45 + 0.6, 12], center=false);
    // Below PCB (solder + pins)
    translate([-18/2 - 0.3, -45/2 - 0.3, -3.5])
        cube([18 + 0.6, 45 + 0.6, 3.5], center=false);
}
