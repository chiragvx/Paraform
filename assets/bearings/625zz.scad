// 625ZZ shielded radial bearing. ParaForm immutable asset.
// @dependency lib/semantic_api.scad
//
// Origin Anchor Rule: [0,0,0] is the center of the bore (axis of rotation).
// OD 16 mm, bore 5 mm, width 5 mm.

module bearing_625zz_mesh() {
    difference() {
        color([0.70, 0.70, 0.72])
            translate([0, 0, -5/2])
                cylinder(d=16, h=5, center=false, $fn=64);
        translate([0, 0, -5/2 - 0.1])
            cylinder(d=5, h=5 + 0.2, center=false, $fn=32);
    }
}

// Press-fit pocket: 15.9 mm OD, 5.1 mm deep.
module bearing_625zz_clearance() {
    translate([0, 0, -5.1/2])
        cylinder(d=15.9, h=5.1, center=false, $fn=64);
}
