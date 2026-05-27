// M4 x 16 socket-cap bolt. ParaForm immutable asset.
// @dependency lib/semantic_api.scad
// @dependency lib/fasteners.scad
//
// Origin Anchor Rule: [0,0,0] is the underside of the head, on the bolt axis.
// +Z = threaded shank direction. Head: OD 7.0 mm, height 4.0 mm.

module bolt_m4x16_mesh() {
    color([0.60, 0.60, 0.65])
        cylinder(d=4.0, h=16, center=false, $fn=24);
    color([0.50, 0.50, 0.55])
        translate([0, 0, -4.0])
            cylinder(d=7.0, h=4.0, center=false, $fn=24);
}

module bolt_m4x16_clearance(access_depth=60) {
    translate([0, 0, -0.1])
        cylinder(d=4.3, h=16.2, center=false, $fn=20);
    translate([0, 0, -4.2])
        cylinder(d=7.1, h=4.2, center=false, $fn=24);
    translate([0, 0, -access_depth])
        cylinder(d=7.1, h=access_depth, center=false, $fn=24);
}
