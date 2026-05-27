// MR105ZZ shielded miniature radial bearing. ParaForm immutable asset.
// @dependency lib/semantic_api.scad
//
// Origin Anchor Rule: [0,0,0] is the center of the bore (axis of rotation).
// OD 10 mm, bore 5 mm, width 4 mm.

module bearing_mr105zz_mesh() {
    difference() {
        color([0.70, 0.70, 0.72])
            translate([0, 0, -4/2])
                cylinder(d=10, h=4, center=false, $fn=64);
        translate([0, 0, -4/2 - 0.1])
            cylinder(d=5, h=4 + 0.2, center=false, $fn=32);
    }
}

// Press-fit pocket: 9.9 mm OD, 4.1 mm deep.
module bearing_mr105zz_clearance() {
    translate([0, 0, -4.1/2])
        cylinder(d=9.9, h=4.1, center=false, $fn=64);
}
