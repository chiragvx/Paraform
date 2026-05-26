// SG90 micro servo. ParaForm immutable asset.
// @dependency lib/semantic_api.scad
//
// Origin Anchor Rule: [0,0,0] is the center of the output spline (top of horn boss).
// Body envelope: 22.5 x 11.8 x 22.7 (excluding mounting flange).
// Mounting flange: 32.5 x 11.8 x 2.5, centered along the body Y axis,
// offset upward so flange top sits 5.0mm below the spline center.

module sg90_mesh() {
    // Body (origin at spline center; body sits below).
    color([0.15, 0.15, 0.18])
        translate([-22.5/2 + 5.5, -11.8/2, -22.7])
            cube([22.5, 11.8, 22.7], center=false);

    // Mounting flange.
    color([0.15, 0.15, 0.18])
        translate([-32.5/2 + 5.5, -11.8/2, -5.0 - 2.5])
            cube([32.5, 11.8, 2.5], center=false);

    // Horn boss + spline.
    color([0.9, 0.9, 0.9])
        translate([0, 0, -2])
            cylinder(d=11.8, h=4, center=false, $fn=32);
    color([0.95, 0.95, 0.95])
        cylinder(d=4.6, h=3, center=false, $fn=24);
}

// Subtractive clearance volume — body + flange + small margin.
module sg90_clearance() {
    translate([-22.5/2 + 5.5 - 0.3, -11.8/2 - 0.3, -22.7 - 0.3])
        cube([22.5 + 0.6, 11.8 + 0.6, 22.7 + 0.6], center=false);
    translate([-32.5/2 + 5.5 - 0.3, -11.8/2 - 0.3, -5.0 - 2.5 - 0.3])
        cube([32.5 + 0.6, 11.8 + 0.6, 2.5 + 0.6], center=false);
    // Cable clearance out the back.
    translate([-22.5/2 + 5.5 - 8, -2, -18])
        cube([8, 4, 4], center=false);
}
