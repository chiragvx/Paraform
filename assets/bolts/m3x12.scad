// M3 × 12 socket-cap bolt. ParaForm immutable asset.
// @dependency lib/semantic_api.scad
// @dependency lib/fasteners.scad
//
// Origin Anchor Rule: [0,0,0] is the underside of the head, on the bolt axis.
// +Z = threaded shank direction.

module bolt_m3x12_mesh() {
    color([0.6, 0.6, 0.65])
        cylinder(d=3.0, h=12, center=false, $fn=24);
    color([0.5, 0.5, 0.55])
        translate([0, 0, -3.0])
            cylinder(d=5.5, h=3.0, center=false, $fn=24);
}

// Subtractive: identical profile to fastener_m3_cap, fixed access_depth.
module bolt_m3x12_clearance(access_depth=60) {
    fastener_m3_cap(screw_length=12, access_depth=access_depth);
}
