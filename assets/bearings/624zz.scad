// 624ZZ shielded radial bearing. ParaForm immutable asset.
// @dependency lib/semantic_api.scad
//
// Origin Anchor Rule: [0,0,0] is the center of the bore (axis of rotation).
// OD 13 mm, bore 4 mm, width 5 mm.

module bearing_624zz_mesh() {
    difference() {
        color([0.70, 0.70, 0.72])
            translate([0, 0, -5/2])
                cylinder(d=13, h=5, center=false, $fn=64);
        translate([0, 0, -5/2 - 0.1])
            cylinder(d=4, h=5 + 0.2, center=false, $fn=32);
    }
}

// Press-fit pocket: 12.9 mm OD, 5.1 mm deep.
module bearing_624zz_clearance() {
    translate([0, 0, -5.1/2])
        cylinder(d=12.9, h=5.1, center=false, $fn=64);
}
