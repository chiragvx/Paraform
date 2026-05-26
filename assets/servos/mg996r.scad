// MG996R standard servo. ParaForm immutable asset.
// @dependency lib/semantic_api.scad
//
// Origin Anchor Rule: [0,0,0] is the center of the output spline.
// Body envelope: 40.7 x 19.7 x 42.9 (excluding flange).
// Mounting flange: 54.0 x 19.7 x 2.5, top of flange 7.6mm below spline center.

module mg996r_mesh() {
    color([0.12, 0.12, 0.15])
        translate([-40.7/2 + 10, -19.7/2, -42.9])
            cube([40.7, 19.7, 42.9], center=false);

    color([0.12, 0.12, 0.15])
        translate([-54.0/2 + 10, -19.7/2, -7.6 - 2.5])
            cube([54.0, 19.7, 2.5], center=false);

    color([0.85, 0.85, 0.85])
        translate([0, 0, -3])
            cylinder(d=20, h=5, center=false, $fn=48);
    color([0.95, 0.95, 0.95])
        cylinder(d=5.8, h=4, center=false, $fn=24);
}

module mg996r_clearance() {
    translate([-40.7/2 + 10 - 0.4, -19.7/2 - 0.4, -42.9 - 0.4])
        cube([40.7 + 0.8, 19.7 + 0.8, 42.9 + 0.8], center=false);
    translate([-54.0/2 + 10 - 0.4, -19.7/2 - 0.4, -7.6 - 2.5 - 0.4])
        cube([54.0 + 0.8, 19.7 + 0.8, 2.5 + 0.8], center=false);
}
