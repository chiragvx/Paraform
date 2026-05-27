// Raspberry Pi Zero 2W. ParaForm immutable asset.
// @dependency lib/semantic_api.scad
//
// Origin Anchor Rule: [0,0,0] is the corner at (X-min, Y-min), bottom of PCB.
// PCB: 30 x 65 mm. Thickness: 1.0 mm.
// Mount holes: M2.5 at (3.5, 3.5), (26.5, 3.5), (3.5, 61.5), (26.5, 61.5)
// Connectors: Micro-USB PWR at Y=10.6, Micro-USB OTG at Y=16.5 (X-min edge)
//             Mini HDMI at Y=25 (X-min edge). CSI camera at Y=43.5 (X-min edge).
//             40-pin GPIO header at X=1.27, Y=5.25 through Y=57.0.
// Component height: ~3.5 mm above PCB (SoC package + RAM).

module rpi_zero2w_mesh() {
    // PCB
    color([0.03, 0.22, 0.03])
        cube([30, 65, 1.0], center=false);
    // SoC + DRAM package (center-ish)
    color([0.08, 0.08, 0.08])
        translate([10, 22, 1.0])
            cube([12, 12, 1.4], center=false);
    // RP2040-based companion chip (smaller)
    color([0.08, 0.08, 0.08])
        translate([18, 40, 1.0])
            cube([7, 7, 1.0], center=false);
    // PWR Micro-USB
    color([0.72, 0.72, 0.74])
        translate([-1.5, 8.6, 1.0])
            cube([5.5, 7, 3.5], center=false);
    // OTG Micro-USB
    color([0.72, 0.72, 0.74])
        translate([-1.5, 14.5, 1.0])
            cube([5.5, 7, 3.5], center=false);
    // Mini HDMI
    color([0.40, 0.40, 0.42])
        translate([-1.0, 22, 1.0])
            cube([7.5, 12, 3.0], center=false);
    // GPIO header (40-pin, 2x20, at X-min side, starting Y≈5.25)
    color([0.15, 0.15, 0.15])
        translate([1.27, 5.25, 1.0])
            cube([5.08, 51.74, 8.5], center=false);
}

// Mount holes (for use in difference())
module rpi_zero2w_mount_holes(depth=10) {
    for (pos = [[3.5, 3.5], [26.5, 3.5], [3.5, 61.5], [26.5, 61.5]]) {
        translate([pos[0], pos[1], -0.1])
            cylinder(d=2.7, h=depth + 0.2, center=false, $fn=16);
    }
}

// Clearance: PCB + connector overhang + component height.
module rpi_zero2w_clearance() {
    translate([-2.0, -0.4, -0.1])
        cube([30 + 2.5, 65 + 0.8, 12], center=false);
}
