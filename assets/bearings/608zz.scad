// 608ZZ shielded radial bearing. ParaForm immutable asset.
// @dependency lib/semantic_api.scad
//
// Origin Anchor Rule: [0,0,0] is the center of the bore (axis of rotation).
// OD 22, bore 8, width 7.

module bearing_608zz_mesh() {
    difference() {
        color([0.7, 0.7, 0.72])
            translate([0, 0, -7/2])
                cylinder(d=22, h=7, center=false, $fn=64);
        translate([0, 0, -7/2 - 0.1])
            cylinder(d=8, h=7 + 0.2, center=false, $fn=48);
    }
}

// Press-fit pocket (slight interference: 21.9 OD, 7.1 deep).
module bearing_608zz_clearance() {
    translate([0, 0, -7.1/2])
        cylinder(d=21.9, h=7.1, center=false, $fn=64);
}
