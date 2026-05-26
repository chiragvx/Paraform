// ParaForm Fastener Library — deterministic 3-layer subtractive cutouts.
// Spec: updatex.md §4. Origin = center of the bolt thread, +Z = bolt insertion direction.
// Every fastener emits: thread core + head pocket + tool access corridor.

// M3 socket cap. Thread Ø3.4 clearance. Head Ø6.5 × 3.5 deep.
module fastener_m3_cap(screw_length=12, access_depth=80) {
    cylinder(d=3.4, h=screw_length + 2, center=false, $fn=24);
    translate([0, 0, -1])
        cylinder(d=6.5, h=3.5, center=false, $fn=24);
    translate([0, 0, -access_depth])
        cylinder(d=7.0, h=access_depth, center=false, $fn=24);
}

// M2 socket cap. Thread Ø2.4. Head Ø4.0 × 2.5 deep.
module fastener_m2_cap(screw_length=8, access_depth=60) {
    cylinder(d=2.4, h=screw_length + 2, center=false, $fn=20);
    translate([0, 0, -1])
        cylinder(d=4.0, h=2.5, center=false, $fn=20);
    translate([0, 0, -access_depth])
        cylinder(d=4.5, h=access_depth, center=false, $fn=20);
}

// M4 socket cap. Thread Ø4.5. Head Ø8.0 × 4.5 deep.
module fastener_m4_cap(screw_length=16, access_depth=80) {
    cylinder(d=4.5, h=screw_length + 2, center=false, $fn=24);
    translate([0, 0, -1])
        cylinder(d=8.0, h=4.5, center=false, $fn=24);
    translate([0, 0, -access_depth])
        cylinder(d=8.5, h=access_depth, center=false, $fn=24);
}

// M5 socket cap. Thread Ø5.5. Head Ø10.0 × 5.5 deep.
module fastener_m5_cap(screw_length=20, access_depth=100) {
    cylinder(d=5.5, h=screw_length + 2, center=false, $fn=28);
    translate([0, 0, -1])
        cylinder(d=10.0, h=5.5, center=false, $fn=28);
    translate([0, 0, -access_depth])
        cylinder(d=10.5, h=access_depth, center=false, $fn=28);
}

// Tool-access-only volume. Use this in validation mode to isolate the
// access corridor without also subtracting the thread/head pockets.
module fastener_tool_corridor(d=7.0, access_depth=80) {
    translate([0, 0, -access_depth])
        cylinder(d=d, h=access_depth, center=false, $fn=24);
}
