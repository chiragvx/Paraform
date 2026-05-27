// ESP32 DevKit V1 (30-pin). ParaForm immutable asset.
// @dependency lib/semantic_api.scad
//
// Origin Anchor Rule: [0,0,0] is the corner at (X-min, Y-min), bottom of PCB.
// PCB: 25.4 x 48.26 mm. Thickness: 1.6 mm.
// Micro-USB at Y-max end. Two 15-pin 2.54 mm headers on each long edge.
// Mount: no dedicated holes — typically held by side-rail clips.
// Component height: 8 mm above PCB (antenna protrudes 2 mm past PCB on Y-max).

module esp32_devkit_mesh() {
    // PCB
    color([0.03, 0.18, 0.40])
        cube([25.4, 48.26, 1.6], center=false);
    // ESP32 module (metal shielded can, roughly 18x26mm)
    color([0.78, 0.78, 0.78])
        translate([3.7, 10, 1.6])
            cube([18, 26, 3.5], center=false);
    // Micro-USB connector at top
    color([0.70, 0.70, 0.72])
        translate([8.7, 45.5, 1.6])
            cube([8, 4.5, 3.5], center=false);
    // Boot / EN buttons
    color([0.80, 0.30, 0.30]) {
        translate([2, 36, 1.6]) cube([4, 4, 3.5], center=false);
        translate([20, 36, 1.6]) cube([4, 4, 3.5], center=false);
    }
    // Headers (left + right edges)
    color([0.10, 0.10, 0.10]) {
        translate([0, 2, 1.6]) cube([1.5, 38, 6.5], center=false);
        translate([23.9, 2, 1.6]) cube([1.5, 38, 6.5], center=false);
    }
}

// Clearance: PCB footprint + antenna + component height.
module esp32_devkit_clearance() {
    translate([-0.4, -0.4, -0.1])
        cube([25.4 + 0.8, 48.26 + 2.5 + 0.8, 11], center=false);
}
