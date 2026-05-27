// M5 x 20 socket-cap bolt. ParaForm immutable asset.
// @dependency lib/semantic_api.scad
// @dependency lib/fasteners.scad
//
// Origin Anchor Rule: [0,0,0] is the underside of the head, on the bolt axis.
// +Z = threaded shank direction. Head: OD 8.5 mm, height 5.0 mm.

module bolt_m5x20_mesh() {
    color([0.60, 0.60, 0.65])
        cylinder(d=5.0, h=20, center=false, $fn=24);
    color([0.50, 0.50, 0.55])
        translate([0, 0, -5.0])
            cylinder(d=8.5, h=5.0, center=false, $fn=24);
}

module bolt_m5x20_clearance(access_depth=60) {
    translate([0, 0, -0.1])
        cylinder(d=5.4, h=20.2, center=false, $fn=20);
    translate([0, 0, -5.2])
        cylinder(d=8.6, h=5.2, center=false, $fn=24);
    translate([0, 0, -access_depth])
        cylinder(d=8.6, h=access_depth, center=false, $fn=24);
}
