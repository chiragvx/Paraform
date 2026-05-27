// DS3225 25kg waterproof digital servo. ParaForm immutable asset.
// @dependency lib/semantic_api.scad
//
// Origin Anchor Rule: [0,0,0] is the center of the output spline.
// Body envelope: 40.5 x 20.0 x 38.5 mm (excluding flange).
// Mounting flange: 54.5 x 20.0 x 2.5 mm, top of flange 7.5 mm below spline center.
// Output shaft: 6.0 mm spline, 4-mount M3 holes at ±13.5, ±6.85.

module ds3225_mesh() {
    // Body
    color([0.10, 0.10, 0.13])
        translate([-40.5/2 + 10.5, -20.0/2, -38.5])
            cube([40.5, 20.0, 38.5], center=false);
    // Mounting flange
    color([0.10, 0.10, 0.13])
        translate([-54.5/2 + 10.5, -20.0/2, -7.5 - 2.5])
            cube([54.5, 20.0, 2.5], center=false);
    // Horn boss
    color([0.80, 0.80, 0.80])
        translate([0, 0, -3.0])
            cylinder(d=21.0, h=5.5, center=false, $fn=48);
    // Output spline
    color([0.92, 0.92, 0.92])
        cylinder(d=6.0, h=5.0, center=false, $fn=24);
}

module ds3225_clearance() {
    translate([-40.5/2 + 10.5 - 0.4, -20.0/2 - 0.4, -38.5 - 0.4])
        cube([40.5 + 0.8, 20.0 + 0.8, 38.5 + 0.8], center=false);
    translate([-54.5/2 + 10.5 - 0.4, -20.0/2 - 0.4, -7.5 - 2.5 - 0.4])
        cube([54.5 + 0.8, 20.0 + 0.8, 2.5 + 0.8], center=false);
}
