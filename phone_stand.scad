// ============================================================
//  Parametric Phone / Tablet Stand
//  Inspired by the folding 3D-printed stand in the reference image
//
//  All dimensions in millimetres.
//  Pieces:
//    1. base_plate()        – rectangular frame with cable slot & pivot hole
//    2. phone_rest()        – angled cradle panel that holds the device
//    3. support_arm()       – vertical strut that props the phone_rest up
//    4. ratchet_slider()    – toothed slider that locks the arm angle
//    5. hinge_pin()         – shared pivot rod (print 2×)
//
//  Assembly:
//    • Hinge pins go through the base_plate pivot holes.
//    • support_arm bottom tab slots into the ratchet_slider channel.
//    • phone_rest and support_arm are linked at the top hinge.
//    • ratchet_slider rides inside the base_plate rail, teeth engage
//      the base rail teeth to lock angle.
//
//  Render individual parts by calling the module at the bottom,
//  or set SHOW_EXPLODED = true for a spread-out preview.
// ============================================================

/* ── Global parameters ─────────────────────────────────── */

// ── Device envelope (what you're holding up)
device_w      = 72;    // phone width  (portrait)
device_h      = 155;   // phone height (portrait)
device_thick  = 10;    // phone thickness including case

// ── Base plate
base_w        = 130;   // outer width  of the base frame
base_d        = 110;   // outer depth  of the base frame
base_thick    = 4;     // wall / floor thickness
base_wall     = 6;     // side-wall width of the frame
cable_slot_w  = 20;    // width of cable pass-through slot in base front
cable_slot_d  = 8;     // depth of cable slot

// ── Phone rest (cradle panel)
rest_angle    = 70;    // default tilt angle from horizontal (degrees)
rest_w        = device_w + 8;  // slightly wider than phone
rest_h        = device_h * 0.55; // panel height (lower half of phone)
rest_thick    = 3.5;
lip_h         = 6;     // bottom lip that catches the phone
lip_thick     = 4;

// ── Support arm
arm_w         = 10;    // arm cross-section width
arm_thick     = 4;     // arm cross-section thickness
// arm_h computed from geometry

// ── Ratchet / angle-lock slider
tooth_count   = 10;
tooth_pitch   = 5;     // centre-to-centre
tooth_h       = 3;
tooth_w       = base_wall - 1;
slider_travel = tooth_count * tooth_pitch; // total travel
slider_thick  = base_thick + 1;

// ── Hinge pin
pin_d         = 3;     // diameter
pin_len       = rest_w + 4;  // spans the full rest width + ears
pin_head_d    = 6;
pin_head_h    = 2;

// ── Clearance / tolerance
cl            = 0.3;   // general print clearance

// ── Preview layout
SHOW_EXPLODED = true;  // set false to see a single part
PART          = "all"; // "base" | "rest" | "arm" | "slider" | "pin" | "all"

/* ── Utilities ──────────────────────────────────────────── */
module fillet_box(w, d, h, r=2) {
    // Box with rounded vertical edges
    hull() {
        for (x=[r, w-r]) for (y=[r, d-r])
            translate([x, y, 0]) cylinder(r=r, h=h, $fn=24);
    }
}

/* ── 1. BASE PLATE ──────────────────────────────────────── */
//
//  Rectangular open frame.  Features:
//    • Two pivot-pin holes on the front rail (for phone_rest ears)
//    • Ratchet-tooth rail on the right inner wall
//    • Cable slot cut into the front wall
//    • Screw / rubber-foot holes at corners
//
module base_plate() {
    difference() {
        // Outer solid
        fillet_box(base_w, base_d, base_thick, r=3);

        // Hollow centre (leave walls)
        translate([base_wall, base_wall, -0.01])
            cube([base_w - 2*base_wall,
                  base_d - 2*base_wall,
                  base_thick + 0.02]);

        // Cable slot in FRONT wall (y=0 face)
        cx = (base_w - cable_slot_w) / 2;
        translate([cx, -0.01, -0.01])
            cube([cable_slot_w, cable_slot_d + 0.01, base_thick + 0.02]);

        // Corner rubber-foot holes (M3 countersink style)
        for (x=[base_wall/2, base_w - base_wall/2])
            for (y=[base_wall/2, base_d - base_wall/2])
                translate([x, y, -0.01])
                    cylinder(d=3.4, h=base_thick+0.02, $fn=16);
    }

    // ── Ratchet teeth rail on RIGHT inner wall ──────────
    // Teeth face inward (negative X direction)
    for (i=[0:tooth_count-1]) {
        tx = base_w - base_wall;          // inner face of right wall
        ty = base_wall + i * tooth_pitch + 1;
        translate([tx, ty, base_thick])
            ratchet_tooth_block();
    }

    // ── Pivot-pin bosses on BACK inner wall ─────────────
    //  Two bosses side by side, centred, for the support arm base pivot
    arm_pivot_y = base_d - base_wall - 1;
    for (ox=[-arm_w, arm_w])
        translate([base_w/2 + ox, arm_pivot_y, base_thick])
            pivot_boss(pin_d, h=5);

    // ── Pivot-pin bosses on FRONT inner face (phone-rest pivot) ──
    for (ox=[-rest_w/2 + arm_w, rest_w/2 - arm_w])
        translate([base_w/2 + ox, base_wall, base_thick])
            pivot_boss(pin_d, h=5);
}

module pivot_boss(hole_d, h=5) {
    difference() {
        cylinder(d=hole_d + 4, h=h, $fn=24);
        translate([0,0,-0.01]) cylinder(d=hole_d + cl, h=h+0.02, $fn=16);
    }
}

// A single upward ratchet tooth (wedge profile)
module ratchet_tooth_block() {
    // Wedge: vertical back, sloped front
    w = tooth_w;
    h = tooth_h;
    p = tooth_pitch * 0.7;
    // Point inward (−X) by rotating
    rotate([0,0,180])
    linear_extrude(w)
        polygon([[0,0],[h,0],[0,p]]);
}

/* ── 2. PHONE REST (cradle panel) ───────────────────────── */
//
//  Flat angled panel with:
//    • Bottom lip to catch device
//    • Ear tabs at top for hinge pin
//    • Hinge ears at bottom connecting to base front bosses
//
module phone_rest() {
    // Main panel (lies flat; assembler rotates to rest_angle)
    union() {
        // Panel body
        cube([rest_w, rest_h, rest_thick]);

        // Bottom lip (catches phone)
        translate([0, -lip_h, 0])
            cube([rest_w, lip_h, lip_thick]);

        // Side edge rails (stiffen the panel)
        for (x=[0, rest_w - rest_thick])
            translate([x, 0, rest_thick])
                cube([rest_thick, rest_h, 2]);

        // Top hinge ears (pair)
        ear_t = 5;
        for (x=[rest_thick, rest_w - rest_thick - ear_t])
            translate([x, rest_h - 0.01, 0])
                hinge_ear(ear_t, pin_d);

        // Bottom pivot ears (connect to base front bosses)
        for (x=[arm_w - pin_head_d/2,
                rest_w - arm_w - pin_head_d/2])
            translate([x, -0.01, 0])
                hinge_ear(pin_head_d, pin_d);
    }
}

module hinge_ear(w, hole_d) {
    h = w * 1.2;
    difference() {
        union() {
            cube([w, h, rest_thick]);
            translate([w/2, h, rest_thick/2])
                rotate([-90,0,0]) cylinder(d=w, h=0.01, $fn=24); // cosmetic fillet
        }
        // Pin hole
        translate([w/2, -0.01, rest_thick/2])
            rotate([-90,0,0])
                cylinder(d=hole_d + cl, h=h+0.02, $fn=16);
    }
}

/* ── 3. SUPPORT ARM ─────────────────────────────────────── */
//
//  Vertical strut.
//    • Top end: hinge ear that links to top of phone_rest
//    • Bottom end: T-tab that slides into ratchet_slider channel
//
// Geometry: arm height = vertical rise when rest is at rest_angle
arm_h = rest_h * sin(rest_angle) + base_d * 0.3;

module support_arm() {
    union() {
        // Main bar
        cube([arm_w, arm_thick, arm_h]);

        // Top hinge ear
        translate([0, 0, arm_h])
            hinge_ear(arm_w, pin_d);

        // Bottom T-tab (slides into slider channel)
        tab_w = arm_w + 4;
        tab_t = 3;
        translate([-(tab_w - arm_w)/2, arm_thick, 0])
            cube([tab_w, tab_t, arm_thick * 2]);

        // Gusset triangles (stiffeners)
        for (side=[0,1])
            mirror([side,0,0])
                translate([0, 0, arm_h * 0.3])
                    gusset(arm_thick, arm_h * 0.2);
    }
}

module gusset(d, h) {
    linear_extrude(d)
        polygon([[0,0],[d,0],[0,h]]);
}

/* ── 4. RATCHET SLIDER ──────────────────────────────────── */
//
//  Slides along the right inner rail of the base plate.
//  The arm's T-tab pivots inside the slider's channel.
//  Teeth on the slider engage the base rail teeth.
//
slider_body_w  = base_wall - 2*cl;
slider_body_d  = tooth_pitch * 3;
slider_body_h  = base_thick * 2 + tooth_h + 2;

module ratchet_slider() {
    difference() {
        union() {
            // Body that rides inside the base rail channel
            fillet_box(slider_body_w, slider_body_d, slider_body_h, r=1);

            // T-tab channel block (on the inward face)
            tab_w = arm_w + 4 + 2*cl;
            translate([-tab_w/2 + slider_body_w/2, slider_body_d * 0.2, 0])
                cube([tab_w, slider_body_d * 0.6, slider_body_h]);

            // Matching ratchet teeth on outward face (engage base teeth)
            for (i=[0:2])
                translate([slider_body_w, i*tooth_pitch, slider_body_h - tooth_h])
                    rotate([0,0,0])
                        ratchet_tooth_block();
        }

        // T-slot for arm tab
        tab_slot_w = arm_w + 4 + cl;
        tab_slot_h = arm_thick * 2 + cl;
        translate([(slider_body_w - tab_slot_w)/2,
                   -0.01,
                   (slider_body_h - tab_slot_h)/2])
            cube([tab_slot_w, slider_body_d + 0.02, tab_slot_h + 0.5]);

        // Pivot pin hole through slider (arm pivots here)
        translate([slider_body_w/2, slider_body_d/2, -0.01])
            cylinder(d=pin_d + cl, h=slider_body_h + 0.02, $fn=16);
    }
}

/* ── 5. HINGE PIN ───────────────────────────────────────── */
//
//  Simple rod with a flared head on one end.
//  Print 2: one for top hinge, one for base pivot.
//
module hinge_pin() {
    union() {
        // Shaft
        cylinder(d=pin_d, h=pin_len, $fn=20);
        // Head (flange)
        cylinder(d=pin_head_d, h=pin_head_h, $fn=24);
        // Chamfer on tip
        translate([0,0,pin_len - 1])
            cylinder(d1=pin_d, d2=pin_d*0.6, h=1, $fn=16);
    }
}

/* ── EXPLODED / SINGLE PART LAYOUT ─────────────────────── */

module show_part(name) {
    if (name == "base"   || name == "all") base_plate();
    if (name == "rest"   || name == "all")
        translate([0, SHOW_EXPLODED ? base_d + 20 : 0, 0])
            phone_rest();
    if (name == "arm"    || name == "all")
        translate([SHOW_EXPLODED ? base_w + 20 : 0,
                   SHOW_EXPLODED ? 0 : 0, 0])
            support_arm();
    if (name == "slider" || name == "all")
        translate([SHOW_EXPLODED ? base_w + 20 : 0,
                   SHOW_EXPLODED ? base_d + 20 : 0, 0])
            ratchet_slider();
    if (name == "pin"    || name == "all") {
        // Print 2 pins side by side
        translate([SHOW_EXPLODED ? -30 : 0, 0, 0])
            hinge_pin();
        translate([SHOW_EXPLODED ? -30 : 0,
                   SHOW_EXPLODED ? 15  : 0, 0])
            hinge_pin();
    }
}

// ── Entry point ─────────────────────────────────────────
show_part(PART);

// ============================================================
//  PRINT NOTES
//  • Recommended layer height: 0.2 mm
//  • Infill: 30 % gyroid for base / rest; 50 % for arm
//  • Supports: needed for hinge ears (rest & arm)
//  • Orientation:
//      base_plate  – flat on bed (as-is)
//      phone_rest  – flat on bed (lip pointing down)
//      support_arm – standing upright OR flat with supports
//      ratchet_slider – upright so teeth print cleanly
//      hinge_pin   – lying on side (seam along shaft)
//  • Material: PETG or PLA+ recommended
//  • Clearance (cl=0.3) is for a well-tuned 0.4 mm nozzle;
//    increase to 0.4 if parts are too tight.
// ============================================================
