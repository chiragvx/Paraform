// M2 x 8 socket-cap bolt. ParaForm immutable asset.
// @dependency lib/semantic_api.scad
// @dependency lib/fasteners.scad
//
// Origin Anchor Rule: [0,0,0] is the underside of the head, on the bolt axis.
// +Z = threaded shank direction.

module bolt_m2x8_mesh() {
    color([0.60, 0.60, 0.65])
        cylinder(d=2.0, h=8, center=false, $fn=20);
    color([0.50, 0.50, 0.55])
        translate([0, 0, -2.0])
            cylinder(d=3.8, h=2.0, center=false, $fn=20);
}

module bolt_m2x8_clearance(access_depth=40) {
    // Through-hole: 2.2 mm; head pocket: 3.8 mm OD x 2.2 mm deep.
    translate([0, 0, -0.1])
        cylinder(d=2.2, h=8.2, center=false, $fn=16);
    translate([0, 0, -2.2])
        cylinder(d=3.9, h=2.2, center=false, $fn=20);
    // Hex key clearance above head (1.3 mm hex)
    translate([0, 0, -access_depth])
        cylinder(d=3.9, h=access_depth, center=false, $fn=20);
}
