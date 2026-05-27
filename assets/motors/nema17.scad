// NEMA17 stepper motor. ParaForm immutable asset.
// @dependency lib/semantic_api.scad
//
// Origin Anchor Rule: [0,0,0] is the center of the front face (mounting face).
// Body: 42.3 x 42.3 x 40 mm (standard 40mm stack). Motor extends in -Z direction.
// Mounting: 4x M3 holes at ±15.25 mm on a square pattern (31mm bolt circle diagonal).
// Output shaft: 5 mm diameter, 24 mm long, D-flat. Shaft tip at Z = +24.
// Front boss: 22 mm diameter, 2 mm tall boss centered on front face (Z = 0 to +2).
// Connector: 4-pin JST-XH on the side, ~15 mm from back.

module nema17_mesh() {
    // Body (sits behind the front face, Z = 0 to -40)
    color([0.22, 0.22, 0.25])
        translate([-42.3/2, -42.3/2, -40])
            cube([42.3, 42.3, 40], center=false);
    // Front boss (Z = 0 to +2)
    color([0.30, 0.30, 0.33])
        cylinder(d=22, h=2, center=false, $fn=48);
    // Output shaft (Z = 2 to +26, i.e. 24 mm exposed)
    color([0.65, 0.65, 0.68])
        translate([0, 0, 2])
            cylinder(d=5, h=24, center=false, $fn=24);
    // D-flat visual (approximate — subtract a thin slab on one side)
    color([0.55, 0.55, 0.58])
        translate([2.0, -1.5, 2])
            cube([3, 3, 22], center=false);
    // Corner bolt bosses
    color([0.20, 0.20, 0.23])
    for (dx = [-1, 1], dy = [-1, 1]) {
        translate([dx * 15.25, dy * 15.25, -1])
            cylinder(d=5, h=1.5, center=false, $fn=16);
    }
}

// Subtractive clearance: body envelope + shaft + connector pocket.
module nema17_clearance() {
    translate([-42.3/2 - 0.4, -42.3/2 - 0.4, -40 - 0.4])
        cube([42.3 + 0.8, 42.3 + 0.8, 40 + 0.8], center=false);
    // Shaft passage
    translate([0, 0, -0.1])
        cylinder(d=5.5, h=28, center=false, $fn=24);
    // Boss clearance
    translate([0, 0, -0.1])
        cylinder(d=22.5, h=2.5, center=false, $fn=48);
    // M3 bolt clearance holes on mounting face
    for (dx = [-1, 1], dy = [-1, 1]) {
        translate([dx * 15.25, dy * 15.25, -41])
            cylinder(d=3.2, h=45, center=false, $fn=16);
    }
}
