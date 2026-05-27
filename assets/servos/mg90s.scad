// MG90S metal-gear micro servo. ParaForm immutable asset.
// @dependency lib/semantic_api.scad
//
// Origin Anchor Rule: [0,0,0] is the center of the output spline (top of horn boss).
// Body envelope: 22.8 x 12.2 x 22.8 mm (excluding flange).
// Mounting flange: 33.0 x 12.2 x 2.5 mm, top of flange 5.0 mm below spline center.
// Mount holes: M2 at (±10.25, ±3.9), same side as SG90 pattern.

module mg90s_mesh() {
    // Body
    color([0.18, 0.18, 0.22])
        translate([-22.8/2 + 5.5, -12.2/2, -22.8])
            cube([22.8, 12.2, 22.8], center=false);
    // Mounting flange
    color([0.18, 0.18, 0.22])
        translate([-33.0/2 + 5.5, -12.2/2, -5.0 - 2.5])
            cube([33.0, 12.2, 2.5], center=false);
    // Horn boss
    color([0.85, 0.85, 0.85])
        translate([0, 0, -2])
            cylinder(d=12.0, h=4, center=false, $fn=32);
    // Output spline
    color([0.92, 0.92, 0.92])
        cylinder(d=4.6, h=3.5, center=false, $fn=24);
}

module mg90s_clearance() {
    translate([-22.8/2 + 5.5 - 0.3, -12.2/2 - 0.3, -22.8 - 0.3])
        cube([22.8 + 0.6, 12.2 + 0.6, 22.8 + 0.6], center=false);
    translate([-33.0/2 + 5.5 - 0.3, -12.2/2 - 0.3, -5.0 - 2.5 - 0.3])
        cube([33.0 + 0.6, 12.2 + 0.6, 2.5 + 0.6], center=false);
    // Cable exit rear
    translate([-22.8/2 + 5.5 - 8, -2.0, -18])
        cube([8, 4, 4], center=false);
}
