import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader';
import { OBJExporter } from 'three/examples/jsm/exporters/OBJExporter';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils';
import { supabase } from './lib/supabase';
import { fetchCatalog, fetchScadSource, saveProject, listProjects } from './lib/catalog.js';
import { Evaluator, Operation, Brush, ADDITION, SUBTRACTION } from 'three-bvh-csg';

const csgEvaluator = new Evaluator();

// --- APP STATE ---
let currentState = {
    user: null,
    template: null,
    templates: [],
    params: {},
    jobId: 0,
    isGenerating: false,
    wireframe: false,
    view: 'landing',
    isMovingSlider: false,
    editMode: 'params', // 'params' or 'code'
    projectTitle: 'Untitled Project',
    activeGizmoTool: 'select', // 'select', 'translate', 'rotate', 'scale'
    isSelected: true, // If the active model is highlighted / selected
    isCtrlPressed: false, // Tracks if control key is pressed for rotation snapping override
    isDraggingMesh: false, // Tracks if the user is actively dragging the mesh directly with mouse
    viewportState: {
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: 1.0,
        materialColor: '#6366f1',
        materialFinish: 'semi-gloss',
        buildPlate: 'ender',
        lightPreset: 'standard',
        lightIntensity: 2.0
    }
};

let undoHistory = [];
let redoHistory = [];
let isUndoingRedoing = false;


const DEFAULT_TEMPLATES = [
    {
        id: 'blank_canvas',
        title: 'Blank Canvas',
        description: 'Start from scratch. Write manual OpenSCAD code or use AI Chat to build custom designs.',
        ui_parameters: [],
        source: `// Blank Canvas
// Describe what you want to build in the AI Chat, or write OpenSCAD code here.

cube([20, 20, 20], center=true);`,
        localPreview: (params, material) => {
            return new THREE.BoxGeometry(20, 20, 20);
        }
    },
    {
        id: 'rugged_box_v1',
        title: 'Rugged Utility Box',
        description: 'A durable, parameterized box with SD card slots.',
        ui_parameters: [
            { key: 'box_width', label: 'Width', type: 'number', min: 40, max: 150, step: 1, default: 80, unit: 'mm' },
            { key: 'box_depth', label: 'Depth', type: 'number', min: 40, max: 150, step: 1, default: 60, unit: 'mm' },
            { key: 'box_height', label: 'Height', type: 'number', min: 10, max: 80, step: 1, default: 30, unit: 'mm' },
            { key: 'wall_thickness', label: 'Wall Thickness', type: 'number', min: 1.2, max: 4.0, step: 0.1, default: 2.0, unit: 'mm' },
            { key: 'sd_slots', label: 'SD Slots', type: 'integer', min: 0, max: 12, step: 1, default: 4 },
        ],
        source: `
module main() {
    difference() {
        cube([box_width, box_depth, box_height], center=true);
        translate([0, 0, wall_thickness])
        cube([box_width - wall_thickness*2, box_depth - wall_thickness*2, box_height], center=true);
        if (sd_slots > 0) {
            for (i = [1:sd_slots]) {
                translate([(i * ((box_width - 20) / (sd_slots + 1))) - (box_width - 20)/2, 0, box_height/2 - 5]) 
                cube([24.5, 32.5, 10], center=true);
            }
        }
    }
}
main();`,
        localPreview: (params, material) => {
            const { box_width, box_depth, box_height, wall_thickness, sd_slots } = params;
            
            const outerBrush = new Brush(new THREE.BoxGeometry(box_width, box_depth, box_height), material);
            const innerBrush = new Brush(new THREE.BoxGeometry(box_width - wall_thickness * 2, box_depth - wall_thickness * 2, box_height), material);
            innerBrush.position.z = wall_thickness;
            
            let result = csgEvaluator.evaluate(outerBrush, innerBrush, SUBTRACTION);
            
            if (sd_slots > 0) {
                const slotW = 24.5;
                const slotD = 32.5;
                const slotH = 10;
                const areaW = box_width - 20;
                
                for (let i = 1; i <= sd_slots; i++) {
                    const x = (i * (areaW / (sd_slots + 1))) - areaW / 2;
                    const slotBrush = new Brush(new THREE.BoxGeometry(slotW, slotD, slotH), material);
                    slotBrush.position.set(x, 0, box_height / 2 - 5);
                    result = csgEvaluator.evaluate(result, slotBrush, SUBTRACTION);
                }
            }
            
            return result.geometry;
        }
    },
    {
        id: 'testbox_v1',
        title: 'Parametric Box & Lid',
        description: 'A simple, customizable storage box with a snug-fitting lid.',
        ui_parameters: [
            { key: 'box_length', label: 'Length', type: 'number', min: 20, max: 200, step: 1, default: 100, unit: 'mm' },
            { key: 'box_width', label: 'Width', type: 'number', min: 20, max: 200, step: 1, default: 100, unit: 'mm' },
            { key: 'box_height', label: 'Height', type: 'number', min: 10, max: 150, step: 1, default: 50, unit: 'mm' },
            { key: 'wall_thickness', label: 'Wall Thickness', type: 'number', min: 0.8, max: 5.0, step: 0.1, default: 2.0, unit: 'mm' },
            { key: 'lid_lip_height', label: 'Lid Lip', type: 'number', min: 1, max: 10, step: 1, default: 3, unit: 'mm' },
            { key: 'clearance', label: 'Fit Clearance', type: 'number', min: 0, max: 1.0, step: 0.05, default: 0.3, unit: 'mm' },
            { key: 'handle_size', label: 'Handle Size', type: 'number', min: 5, max: 40, step: 1, default: 15, unit: 'mm' },
            { key: 'part_to_show', label: 'Show Part', type: 'enum', options: ['both', 'box', 'lid'], default: 'both' }
        ],
        localPreview: (params, material) => {
            const { box_length, box_width, box_height, wall_thickness, lid_lip_height, clearance, handle_size, part_to_show } = params;
            const geometries = [];
            
            if (part_to_show === 'box' || part_to_show === 'both') {
                const outer = new Brush(new THREE.BoxGeometry(box_length, box_width, box_height), material);
                outer.position.set(box_length/2, box_width/2, box_height/2);
                
                const inner = new Brush(new THREE.BoxGeometry(box_length - wall_thickness*2, box_width - wall_thickness*2, box_height), material);
                inner.position.set(box_length/2, box_width/2, box_height/2 + wall_thickness);
                
                const boxBase = csgEvaluator.evaluate(outer, inner, SUBTRACTION).geometry;
                geometries.push(boxBase);
            }
            
            if (part_to_show === 'lid' || part_to_show === 'both') {
                const plate = new THREE.BoxGeometry(box_length, box_width, wall_thickness);
                plate.translate(box_length/2, box_width/2, wall_thickness/2);
                
                const plug = new THREE.BoxGeometry(
                    box_length - wall_thickness*2 - clearance*2, 
                    box_width - wall_thickness*2 - clearance*2, 
                    lid_lip_height
                );
                plug.translate(box_length/2, box_width/2, -lid_lip_height/2);
                
                const handle = new THREE.CylinderGeometry(handle_size/2, handle_size/2, 4, 32);
                handle.rotateX(Math.PI/2);
                handle.translate(box_length/2, box_width/2, wall_thickness + 2);
                
                const lidGeom = BufferGeometryUtils.mergeGeometries([plate, plug, handle]);
                
                if (part_to_show === 'both') {
                    lidGeom.translate(box_length + 10, 0, 0);
                }
                geometries.push(lidGeom);
            }
            
            return BufferGeometryUtils.mergeGeometries(geometries);
        },
        source: `
eps = 0.01;
module box_base() {
    difference() {
        cube([box_length, box_width, box_height]);
        translate([wall_thickness, wall_thickness, wall_thickness])
            cube([box_length - wall_thickness*2, box_width - wall_thickness*2, box_height + eps]);
    }
}

module box_lid() {
    union() {
        cube([box_length, box_width, wall_thickness]);
        translate([wall_thickness + clearance, wall_thickness + clearance, -lid_lip_height])
            cube([box_length - wall_thickness*2 - clearance*2, box_width - wall_thickness*2 - clearance*2, lid_lip_height]);
        translate([box_length/2, box_width/2, wall_thickness])
            cylinder(h = 4, d = handle_size);
    }
}

if (part_to_show == "box" || part_to_show == "both") {
    box_base();
}

if (part_to_show == "lid" || part_to_show == "both") {
    if (part_to_show == "both") {
        translate([box_length + 20, 0, 0]) box_lid();
    } else {
        box_lid();
    }
}
`
    },
    {
        id: 'hanger_v1',
        title: 'Diagonal Print Hanger',
        description: 'A full-size clothes hanger that fits diagonally on standard printer beds.',
        ui_parameters: [
            { key: 'hanger_width', label: 'Hanger Width', type: 'number', min: 200, max: 500, step: 1, default: 320, unit: 'mm' },
            { key: 'hanger_height', label: 'Body Height', type: 'number', min: 40, max: 150, step: 1, default: 80, unit: 'mm' },
            { key: 'thickness', label: 'Thickness', type: 'number', min: 2, max: 10, step: 1, default: 5, unit: 'mm' },
            { key: 'beam_width', label: 'Beam Width', type: 'number', min: 5, max: 25, step: 1, default: 10, unit: 'mm' },
            { key: 'hook_height', label: 'Hook Height', type: 'number', min: 30, max: 120, step: 1, default: 55, unit: 'mm' },
            { key: 'hook_radius', label: 'Hook Radius', type: 'number', min: 15, max: 40, step: 1, default: 20, unit: 'mm' },
        ],
        localPreview: (params) => {
            const { hanger_width, hanger_height, thickness, beam_width, hook_height, hook_radius } = params;
            
            const geometries = [];
            
            // Body Outer (Simplified as 3 cylinders)
            const c1 = new THREE.CylinderGeometry(beam_width, beam_width, thickness, 16);
            c1.translate(0, 0, thickness/2);
            geometries.push(c1);
            
            const c2 = new THREE.CylinderGeometry(beam_width, beam_width, thickness, 16);
            c2.translate(hanger_width, 0, thickness/2);
            geometries.push(c2);
            
            const c3 = new THREE.CylinderGeometry(beam_width, beam_width, thickness, 16);
            c3.translate(hanger_width/2, hanger_height, thickness/2);
            geometries.push(c3);
            
            // Hook stem
            const stem = new THREE.BoxGeometry(beam_width, hook_height, thickness);
            stem.translate(hanger_width/2, hanger_height + hook_height/2 - 5, thickness/2);
            geometries.push(stem);
            
            // Hook head (Simplified as torus)
            const torus = new THREE.TorusGeometry(hook_radius + beam_width/2, beam_width/2, 8, 16, Math.PI * 1.5);
            torus.rotateZ(-Math.PI * 0.5);
            torus.translate(hanger_width/2 + hook_radius, hanger_height + hook_height - 5, thickness/2);
            geometries.push(torus);
            
            return BufferGeometryUtils.mergeGeometries(geometries);
        },
        source: `
union() {
    hanger_body();
    hanger_hook();
}

module hanger_body() {
    difference() {
        hull() {
            translate([0,0,0]) cylinder(h=thickness, r=beam_width);
            translate([hanger_width,0,0]) cylinder(h=thickness, r=beam_width);
            translate([hanger_width/2,hanger_height,0]) cylinder(h=thickness, r=beam_width);
        }
        translate([0,0,-0.1])
        hull() {
            translate([25,15,0]) cylinder(h=thickness+0.2, r=beam_width);
            translate([hanger_width-25,15,0]) cylinder(h=thickness+0.2, r=beam_width);
            translate([hanger_width/2,hanger_height-20,0]) cylinder(h=thickness+0.2, r=beam_width);
        }
    }
}

module hanger_hook() {
    center_x = hanger_width/2;
    translate([center_x - beam_width/2, hanger_height-5, 0])
        cube([beam_width, hook_height, thickness]);
    translate([center_x, hanger_height + hook_height, 0])
        rotate_extrude(angle=270)
            translate([hook_radius,0,0])
                square([beam_width, thickness]);
}
`
    },
    {
        id: 'music_box_v1',
        title: 'Parametric Music Box',
        description: 'A fully functional music box. Customize the dimensions, song name, and print layout.',
        ui_parameters: [
            { key: 'FOR_PRINT', label: 'Layout', type: 'enum', options: ['Assembled', 'PrintPlate'], default: 'Assembled' },
            { key: 'MusicCylinderName', label: 'Song Name', type: 'string', default: 'ParaForm' },
            { key: 'musicCylinderTeeth', label: 'Cylinder Teeth', type: 'integer', min: 12, max: 48, step: 1, default: 24 },
            { key: 'pinNrX', label: 'Comb Teeth (Notes)', type: 'integer', min: 8, max: 24, step: 1, default: 13 },
            { key: 'pinNrY', label: 'Song Length', type: 'integer', min: 16, max: 128, step: 1, default: 35 },
            { key: 'wall', label: 'Wall Thickness', type: 'number', min: 1.0, max: 4.0, step: 0.1, default: 2.0, unit: 'mm' },
            { key: 'GENERATE_MUSIC_CYLINDER', label: 'Cylinder', type: 'boolean', default: true },
            { key: 'GENERATE_MID_GEAR', label: 'Transmission Gear', type: 'boolean', default: true },
            { key: 'GENERATE_CRANK_GEAR', label: 'Crank Gear', type: 'boolean', default: true },
            { key: 'GENERATE_CASE', label: 'Show Case', type: 'boolean', default: true },
            { key: 'GENERATE_CRANK', label: 'Show Crank', type: 'boolean', default: true },
            { key: 'GENERATE_PULLEY', label: 'Pulley', type: 'boolean', default: true },
            { key: 'HIGH_DETAIL_GEARS', label: 'High Detail Gears', type: 'boolean', default: false },
            { key: 'SHOW_PINS', label: 'Show Pins', type: 'boolean', default: true },
            { key: 'PERFORMANCE_MODE', label: 'Turbo Mode (Instant)', type: 'boolean', default: true }
        ],
        localPreview: (params) => {
            const { musicCylinderTeeth, pinNrX, pinNrY, wall, SHOW_PINS, GENERATE_CASE } = params;
            const diametral_pitch = 0.6;
            const musicCylinderR = (musicCylinderTeeth / diametral_pitch) / 2;
            const gearH = 3;
            const pinNrX_val = pinNrX || 13;
            const musicH = pinNrX_val * (wall + 3);
            
            const geometries = [];
            
            // Main Cylinder
            const cylinderGeom = new THREE.CylinderGeometry(musicCylinderR, musicCylinderR, musicH, 32);
            cylinderGeom.rotateX(Math.PI / 2);
            geometries.push(cylinderGeom);
            
            // Gears
            const gearGeom = new THREE.CylinderGeometry(musicCylinderR + 2, musicCylinderR + 2, gearH, 16);
            gearGeom.rotateX(Math.PI / 2);
            const gear1 = gearGeom.clone();
            gear1.translate(0, 0, -musicH / 2 - 2);
            geometries.push(gear1);
            
            // Comb
            if (GENERATE_CASE) {
                const boxGeom = new THREE.BoxGeometry(musicCylinderR * 3, wall, musicH + 20);
                boxGeom.translate(0, -musicCylinderR - wall, 0);
                geometries.push(boxGeom);
            }
            
            return BufferGeometryUtils.mergeGeometries(geometries);
        },
        source: `
// --- INLINED GEAR LIBRARY ---


// Parametric Involute Bevel and Spur Gears by GregFrost
// It is licensed under the Creative Commons - GNU LGPL 2.1 license.
// © 2010 by GregFrost, thingiverse.com/Amp
// http://www.thingiverse.com/thing:3575 and http://www.thingiverse.com/thing:3752

// Simple Test:
//gear (circular_pitch=700,
//  gear_thickness = 12,
//  rim_thickness = 15,
//  hub_thickness = 17,
//  circles=8);

//Complex Spur Gear Test:
//test_gears ();

// Meshing Double Helix:
//test_meshing_double_helix ();

module test_meshing_double_helix(){
    meshing_double_helix ();
}

// Demonstrate the backlash option for Spur gears.
//test_backlash ();

// Demonstrate how to make meshing bevel gears.
//test_bevel_gear_pair();

module test_bevel_gear_pair(){
    bevel_gear_pair ();
}

module test_bevel_gear(){bevel_gear();}

//bevel_gear();

pi=3.1415926535897932384626433832795;

//==================================================
// Bevel Gears:
// Two gears with the same cone distance, circular pitch (measured at the cone distance)
// and pressure angle will mesh.

module bevel_gear_pair (
    gear1_teeth = 41,
    gear2_teeth = 7,
    axis_angle = 90,
    outside_circular_pitch=1000)
{
    outside_pitch_radius1 = gear1_teeth * outside_circular_pitch / 360;
    outside_pitch_radius2 = gear2_teeth * outside_circular_pitch / 360;
    pitch_apex1=outside_pitch_radius2 * sin (axis_angle) +
        (outside_pitch_radius2 * cos (axis_angle) + outside_pitch_radius1) / tan (axis_angle);
    cone_distance = sqrt (pow (pitch_apex1, 2) + pow (outside_pitch_radius1, 2));
    pitch_apex2 = sqrt (pow (cone_distance, 2) - pow (outside_pitch_radius2, 2));
    echo ("cone_distance", cone_distance);
    pitch_angle1 = asin (outside_pitch_radius1 / cone_distance);
    pitch_angle2 = asin (outside_pitch_radius2 / cone_distance);
    echo ("pitch_angle1, pitch_angle2", pitch_angle1, pitch_angle2);
    echo ("pitch_angle1 + pitch_angle2", pitch_angle1 + pitch_angle2);

    rotate([0,0,90])
    translate ([0,0,pitch_apex1+20])
    {
        translate([0,0,-pitch_apex1])
        bevel_gear (
            number_of_teeth=gear1_teeth,
            cone_distance=cone_distance,
            pressure_angle=30,
            outside_circular_pitch=outside_circular_pitch);

        rotate([0,-(pitch_angle1+pitch_angle2),0])
        translate([0,0,-pitch_apex2])
        bevel_gear (
            number_of_teeth=gear2_teeth,
            cone_distance=cone_distance,
            pressure_angle=30,
            outside_circular_pitch=outside_circular_pitch);
    }
}

//Bevel Gear Finishing Options:
bevel_gear_flat = 0;
bevel_gear_back_cone = 1;

module bevel_gear (
    number_of_teeth=11,
    cone_distance=100,
    face_width=20,
    outside_circular_pitch=1000,
    pressure_angle=30,
    clearance = 0.2,
    bore_diameter=5,
    gear_thickness = 15,
    backlash = 0,
    involute_facets=0,
    finish = -1)
{
    echo ("bevel_gear",
        "teeth", number_of_teeth,
        "cone distance", cone_distance,
        face_width,
        outside_circular_pitch,
        pressure_angle,
        clearance,
        bore_diameter,
        involute_facets,
        finish);

    // Pitch diameter: Diameter of pitch circle at the fat end of the gear.
    outside_pitch_diameter  =  number_of_teeth * outside_circular_pitch / 180;
    outside_pitch_radius = outside_pitch_diameter / 2;

    // The height of the pitch apex.
    pitch_apex = sqrt (pow (cone_distance, 2) - pow (outside_pitch_radius, 2));
    pitch_angle = asin (outside_pitch_radius/cone_distance);

    echo ("Num Teeth:", number_of_teeth, " Pitch Angle:", pitch_angle);

    finish = (finish != -1) ? finish : (pitch_angle < 45) ? bevel_gear_flat : bevel_gear_back_cone;

    apex_to_apex=cone_distance / cos (pitch_angle);
    back_cone_radius = apex_to_apex * sin (pitch_angle);

    // Calculate and display the pitch angle. This is needed to determine the angle to mount two meshing cone gears.

    // Base Circle for forming the involute teeth shape.
    base_radius = back_cone_radius * cos (pressure_angle);

    // Diametrial pitch: Number of teeth per unit length.
    pitch_diametrial = number_of_teeth / outside_pitch_diameter;

    // Addendum: Radial distance from pitch circle to outside circle.
    addendum = 1 / pitch_diametrial;
    // Outer Circle
    outer_radius = back_cone_radius + addendum;

    // Dedendum: Radial distance from pitch circle to root diameter
    dedendum = addendum + clearance;

dedendum_angle = atan (dedendum / cone_distance);
    root_angle = pitch_angle - dedendum_angle;

    root_cone_full_radius = tan (root_angle)*apex_to_apex;
    back_cone_full_radius=apex_to_apex / tan (pitch_angle);

    back_cone_end_radius =
        outside_pitch_radius -
        dedendum * cos (pitch_angle) -
        gear_thickness / tan (pitch_angle);
    back_cone_descent = dedendum * sin (pitch_angle) + gear_thickness;

    // Root diameter: Diameter of bottom of tooth spaces.
    root_radius = back_cone_radius - dedendum;

    half_tooth_thickness = outside_pitch_radius * sin (360 / (4 * number_of_teeth)) - backlash / 4;
    half_thick_angle = asin (half_tooth_thickness / back_cone_radius);

    face_cone_height = apex_to_apex-face_width / cos (pitch_angle);
    face_cone_full_radius = face_cone_height / tan (pitch_angle);
    face_cone_descent = dedendum * sin (pitch_angle);
    face_cone_end_radius =
        outside_pitch_radius -
        face_width / sin (pitch_angle) -
        face_cone_descent / tan (pitch_angle);

    // For the bevel_gear_flat finish option, calculate the height of a cube to select the portion of the gear that includes the full pitch face.
    bevel_gear_flat_height = pitch_apex - (cone_distance - face_width) * cos (pitch_angle);

//  translate([0,0,-pitch_apex])
    difference ()
    {
        intersection ()
        {
            union()
            {
                rotate (half_thick_angle)
                translate ([0,0,pitch_apex-apex_to_apex])
                cylinder ($fn=number_of_teeth*2, r1=root_cone_full_radius,r2=0,h=apex_to_apex);
                for (i = [1:number_of_teeth])
//              for (i = [1:1])
                {
                    rotate ([0,0,i*360/number_of_teeth])
                    {
                        involute_bevel_gear_tooth (
                            back_cone_radius = back_cone_radius,
                            root_radius = root_radius,
                            base_radius = base_radius,
                            outer_radius = outer_radius,
                            pitch_apex = pitch_apex,
                            cone_distance = cone_distance,
                            half_thick_angle = half_thick_angle,
                            involute_facets = involute_facets);
                    }
                }
            }

            if (finish == bevel_gear_back_cone)
            {
                translate ([0,0,-back_cone_descent])
                cylinder (
                    $fn=number_of_teeth*2,
                    r1=back_cone_end_radius,
                    r2=back_cone_full_radius*2,
                    h=apex_to_apex + back_cone_descent);
            }
            else
            {
                translate ([-1.5*outside_pitch_radius,-1.5*outside_pitch_radius,0])
                cube ([3*outside_pitch_radius,
                    3*outside_pitch_radius,
                    bevel_gear_flat_height]);
            }
        }

        if (finish == bevel_gear_back_cone)
        {
            translate ([0,0,-face_cone_descent])
            cylinder (
                r1=face_cone_end_radius,
                r2=face_cone_full_radius * 2,
                h=face_cone_height + face_cone_descent+pitch_apex);
        }

        translate ([0,0,pitch_apex - apex_to_apex])
        cylinder (r=bore_diameter/2,h=apex_to_apex);
    }
}

module involute_bevel_gear_tooth (
    back_cone_radius,
    root_radius,
    base_radius,
    outer_radius,
    pitch_apex,
    cone_distance,
    half_thick_angle,
    involute_facets)
{
//  echo ("involute_bevel_gear_tooth",
//      back_cone_radius,
//      root_radius,
//      base_radius,
//      outer_radius,
//      pitch_apex,
//      cone_distance,
//      half_thick_angle);

    min_radius = max (base_radius*2,root_radius*2);

    pitch_point =
        involute (
            base_radius*2,
            involute_intersect_angle (base_radius*2, back_cone_radius*2));
    pitch_angle = atan2 (pitch_point[1], pitch_point[0]);
    centre_angle = pitch_angle + half_thick_angle;

    start_angle = involute_intersect_angle (base_radius*2, min_radius);
    stop_angle = involute_intersect_angle (base_radius*2, outer_radius*2);

    res=(involute_facets!=0)?involute_facets:($fn==0)?5:$fn/4;

    translate ([0,0,pitch_apex])
    rotate ([0,-atan(back_cone_radius/cone_distance),0])
    translate ([-back_cone_radius*2,0,-cone_distance*2])
    union ()
    {
        for (i=[1:res])
        {

let (
                point1=
                    involute (base_radius*2,start_angle+(stop_angle - start_angle)*(i-1)/res),
                point2=
                    involute (base_radius*2,start_angle+(stop_angle - start_angle)*(i)/res))
            {
                let (
                    side1_point1 = rotate_point (centre_angle, point1),
                    side1_point2 = rotate_point (centre_angle, point2),
                    side2_point1 = mirror_point (rotate_point (centre_angle, point1)),
                    side2_point2 = mirror_point (rotate_point (centre_angle, point2)))
                {
                    polyhedron (
                        points=[
                            [back_cone_radius*2+0.1,0,cone_distance*2],
                            [side1_point1[0],side1_point1[1],0],
                            [side1_point2[0],side1_point2[1],0],
                            [side2_point2[0],side2_point2[1],0],
                            [side2_point1[0],side2_point1[1],0],
                            [0.1,0,0]],
                        triangles=[[0,2,1],[0,3,2],[0,4,3],[0,1,5],[1,2,5],[2,3,5],[3,4,5],[0,5,4]]);
                }
            }
        }
    }
}

module gear_mcad (
    number_of_teeth=15,
    circular_pitch=undef, diametral_pitch=undef,
    pressure_angle=28,
    clearance = undef,
    gear_thickness=5,
    rim_thickness=undef,
    rim_width=undef,
    hub_thickness=undef,
    hub_diameter=undef,
    spokes=0,
    spoke_width=undef,
    spoke_thickness=undef,
    spoke_square=false,
    centered_gear=false,
    centered_hub=false,
    bore_diameter=undef,
    circles=0,
    circle_diameter=undef,
    backlash=0,
    twist=0,
    involute_facets=0,
    flat=false)
{
    // Check for undefined circular pitch (happens when neither circular_pitch or diametral_pitch are specified)
    if (circular_pitch==undef)
        echo("MCAD ERROR: gear module needs either a diametral_pitch or circular_pitch");

    //Convert diametrial pitch to our native circular pitch
    circular_pitch = (circular_pitch!=undef?circular_pitch:pi/diametral_pitch);

    // Calculate default clearance if not specified
    clearance = (clearance!=undef?clearance:0.25 * circular_pitch / pi);

    // Pitch diameter: Diameter of pitch circle.
    pitch_diameter  =  number_of_teeth * circular_pitch / pi;
    pitch_radius = pitch_diameter/2;
    echo (str("Teeth: ", number_of_teeth, ", Pitch Radius: ", pitch_radius, ", Clearance: ", clearance));

    // Base Circle
    base_radius = pitch_radius*cos(pressure_angle);

    // Diametrial pitch: Number of teeth per unit length.
    pitch_diametrial = number_of_teeth / pitch_diameter;

    // Addendum: Radial distance from pitch circle to outside circle.
    addendum = 1/pitch_diametrial;

    //Outer Circle
    outer_radius = pitch_radius+addendum;

    // Dedendum: Radial distance from pitch circle to root diameter
    dedendum = addendum + clearance;

    // Root diameter: Diameter of bottom of tooth spaces.
    root_radius = pitch_radius-dedendum;
    backlash_angle = backlash / pitch_radius * 180 / pi;
    half_thick_angle = (360 / number_of_teeth - backlash_angle) / 4;

    // Variables controlling the rim.
    rim_thickness = (rim_thickness!=undef?(rim_thickness!=0?rim_thickness:gear_thickness):gear_thickness * 1.5);
    rim_width = (rim_width!=undef?rim_width:root_radius * .1);
    rim_radius = root_radius - rim_width;

    // Variables controlling the hub
    hub_thickness = (hub_thickness!=undef?(hub_thickness!=0?hub_thickness:gear_thickness):gear_thickness * 2);
    hub_diameter = (hub_diameter!=undef?hub_diameter:root_radius * .3);
    hub_base = (centered_hub == false)? 0 : rim_thickness/2 - hub_thickness/2;

    // Variables controlling the spokes
    spokes = spokes == undef? 0 : spokes;
    spoke_thickness = (spoke_thickness == undef)? rim_thickness : spoke_thickness;
    spoke_width = (spokes==0)? 1 : (spoke_width == undef)?  0.75 * pi * hub_diameter / spokes : spoke_width; 
    //spoke_depth is depth spoke must penetrate into hub to ensure complete penetration
    spoke_depth = ((hub_diameter/2)^2-(spoke_width/2)^2)^0.5 +.01;
    //spoke length is length of spoke including the depth sunk into the hub
    spoke_length = spoke_depth+rim_radius-(hub_diameter/2.0);
    //spoke raius is the distance from gear center to base of the spoke(inside the hub)
    spoke_radius = (hub_diameter/2.0)-spoke_depth;

//echo (str("spoke_width: ",spoke_width,", hub_diameter: ",hub_diameter, ", spoke_depth: ",spoke_depth));

    // Variables controlling the bore
    bore_diameter = bore_diameter!=undef?bore_diameter:root_radius * .1;

    // Variables controlling the circular holes in the gear.
    circle_orbit_diameter=hub_diameter/2+rim_radius;
    circle_orbit_curcumference=pi*circle_orbit_diameter;

    // Limit the circle size to 90% of the gear face.
    circle_default_diameter = min (
        0.70*circle_orbit_curcumference/circles, 
        (rim_radius+hub_diameter/2)*0.9);
    circle_diameter=(circle_diameter != undef)? circle_diameter : circle_default_diameter;
    echo(str("cir_orb_dia: ", circle_orbit_diameter, ", cir_orb_circumf: ", circle_orbit_curcumference, ", default cir dia: ",circle_default_diameter, ", cir_dia:",circle_diameter));
    difference()
    {
        union ()
        {
            difference ()
            {
                //start with a plane toothed disk gear
                linear_extrude_flat_option(flat=flat, height=rim_thickness, convexity=10, twist=twist)
                gear_shape (
                    number_of_teeth,
                    pitch_radius = pitch_radius,
                    root_radius = root_radius,
                    base_radius = base_radius,
                    outer_radius = outer_radius,
                    half_thick_angle = half_thick_angle,
                    involute_facets=involute_facets);

                //if we have a 0 hub thickness, then hub must be removed
                if (hub_thickness == 0)
                    translate ([0,0,-1])
                    cylinder (r=rim_radius,h=rim_thickness+2);
                //if the rim is thicker than the gear, carve out gear body
                else if (rim_thickness>gear_thickness){
                    //if not centered, carve out only the top
                    if (centered_gear == false){
                        translate ([0,0,gear_thickness])
                        cylinder (r=rim_radius,h=rim_thickness);
                    }
                    else
                        //carve out half from top and half from bottom
                        union ()
                        {
                            translate ([0,0,(gear_thickness + rim_thickness)/2])
                                cylinder (r=rim_radius,h=rim_thickness+1);
                            translate ([0,0,-1 -(gear_thickness + rim_thickness)/2])
                                cylinder (r=rim_radius,h=rim_thickness+1);
                        }

                }
            }

            //extend the gear body if gear_thickness > rim_thickness unless spoked, 
            if (gear_thickness > rim_thickness)
            {
                if (centered_gear == false)
                {
                    linear_extrude_flat_option(flat=flat, height=gear_thickness)
                    circle (r=rim_radius);
                }
                else
                {
                    translate ([0,0,-(gear_thickness - rim_thickness)/2])
                    linear_extrude_flat_option(flat=flat, height=gear_thickness)
                    circle (r=rim_radius);
                }
                //if rim is thicker than body, body protrudes into rim
            }
            //add the hub
            translate ([0,0,hub_base])
            linear_extrude_flat_option(flat=flat, height=hub_thickness)
                circle (r=hub_diameter/2);

            //add in spokes
            if (spokes>0)
            {          
                for(i=[0:spokes-1])
                    translate([0,0,rim_thickness/2])
                    rotate([90,0,i*360/spokes])
                    translate([0,0,spoke_radius])
                    {
                        if (spoke_square==true){
                             resize([spoke_width,spoke_thickness,spoke_length])
                            translate([0,0,.5])
                            cube(1,center=true);
                        }
                        if (spoke_square==false){
                            resize([spoke_width,spoke_thickness,spoke_length])
                            cylinder(h=10,d=10);
                        }
                    }
            }
        }

        //remove the center bore
        translate ([0,0,-1])
        linear_extrude_flat_option(flat =flat, height=2+max(rim_thickness,hub_thickness,gear_thickness))
        circle (r=bore_diameter/2);

//remove circles from gear body
        if (circles>0)
        {
            for(i=[0:circles-1])
                rotate([0,0,i*360/circles])
                translate([circle_orbit_diameter/2,0,-1])
                linear_extrude_flat_option(flat =flat, height=max(gear_thickness,rim_thickness)+3)
                circle(r=circle_diameter/2);
        }
    }
}

module rack(
        number_of_teeth=15,
        circular_pitch=false, diametral_pitch=false,
        pressure_angle=28,
        clearance=0.2,
        rim_thickness=8,
        rim_width=5,
        flat=false)
{

    if (circular_pitch==false && diametral_pitch==false)
        echo("MCAD ERROR: gear module needs either a diametral_pitch or circular_pitch");

    //Convert diametrial pitch to our native circular pitch
    circular_pitch = (circular_pitch!=false?circular_pitch:pi/diametral_pitch);
    pitch = circular_pitch;

    addendum = circular_pitch / pi;
    dedendum = addendum + clearance;
    pitch_slope = tan(pressure_angle);

    linear_extrude_flat_option(flat=flat, height=rim_thickness)
        union()
        {
            translate([0,-dedendum-rim_width/2])
                square([number_of_teeth*pitch, rim_width],center=true);

            p1 = pitch / 4 + pitch_slope * dedendum;
            p2 = pitch / 4 - pitch_slope * addendum;
            for(i=[1:number_of_teeth])
                translate([pitch*(i-number_of_teeth/2-0.5),0])
                    polygon(points=[
                            [-p1,-dedendum],
                            [p1,-dedendum],
                            [p2,addendum],
                            [-p2,addendum]
                    ]);
        }
}

module linear_extrude_flat_option(flat =false, height = 10, center = false, convexity = 2, twist = 0)
{
    if(flat==false)
    {
        linear_extrude(height = height, center = center, convexity = convexity, twist= twist) children(0);
    }
    else
    {
        children(0);
    }

}

module gear_shape (
    number_of_teeth,
    pitch_radius,
    root_radius,
    base_radius,
    outer_radius,
    half_thick_angle,
    involute_facets)
{
    union()
    {
        rotate (half_thick_angle) circle ($fn=number_of_teeth*2, r=root_radius);

        for (i = [1:number_of_teeth])
        {
            rotate ([0,0,i*360/number_of_teeth])
            {
                involute_gear_tooth (
                    pitch_radius = pitch_radius,
                    root_radius = root_radius,
                    base_radius = base_radius,
                    outer_radius = outer_radius,
                    half_thick_angle = half_thick_angle,
                    involute_facets=involute_facets);
            }
        }
    }
}

module involute_gear_tooth (
    pitch_radius,
    root_radius,
    base_radius,
    outer_radius,
    half_thick_angle,
    involute_facets)
{
    min_radius = max (base_radius,root_radius);

    pitch_point = involute (base_radius, involute_intersect_angle (base_radius, pitch_radius));
    pitch_angle = atan2 (pitch_point[1], pitch_point[0]);
    centre_angle = pitch_angle + half_thick_angle;

    start_angle = involute_intersect_angle (base_radius, min_radius);
    stop_angle = involute_intersect_angle (base_radius, outer_radius);

    res=(involute_facets!=0)?involute_facets:($fn==0)?5:$fn/4;

    union ()
    {
        for (i=[1:res]) {
            point1=involute (base_radius,start_angle+(stop_angle - start_angle)*(i-1)/res);
            point2=involute (base_radius,start_angle+(stop_angle - start_angle)*i/res);
            side1_point1=rotate_point (centre_angle, point1);
            side1_point2=rotate_point (centre_angle, point2);
            side2_point1=mirror_point (rotate_point (centre_angle, point1));
            side2_point2=mirror_point (rotate_point (centre_angle, point2));
                polygon (
                    points=[[0,0],side1_point1,side1_point2,side2_point2,side2_point1],
                    paths=[[0,1,2,3,4,0]]);
            }
        }
}

// Mathematical Functions
//===============

// Finds the angle of the involute about the base radius at the given distance (radius) from it's center.
//source: http://www.mathhelpforum.com/math-help/geometry/136011-circle-involute-solving-y-any-given-x.html

function involute_intersect_angle (base_radius, radius) = sqrt (pow (radius/base_radius, 2) - 1) * 180 / pi;

// Calculate the involute position for a given base radius and involute angle.

function rotated_involute (rotate, base_radius, involute_angle) =
[
    cos (rotate) * involute (base_radius, involute_angle)[0] + sin (rotate) * involute (base_radius, involute_angle)[1],
    cos (rotate) * involute (base_radius, involute_angle)[1] - sin (rotate) * involute (base_radius, involute_angle)[0]
];

function mirror_point (coord) =
[
    coord[0],
    -coord[1]
];

function rotate_point (rotate, coord) =
[
    cos (rotate) * coord[0] + sin (rotate) * coord[1],
    cos (rotate) * coord[1] - sin (rotate) * coord[0]
];

function involute (base_radius, involute_angle) =
[
    base_radius*(cos (involute_angle) + involute_angle*pi/180*sin (involute_angle)),
    base_radius*(sin (involute_angle) - involute_angle*pi/180*cos (involute_angle))
];


// Test Cases
//===============

module test_gears()
{
    $fs = 0.2;
    $fa =1;
    translate([17,-15])
    {
        gear (number_of_teeth=17,
            circular_pitch=500*pi/180,
            spokes=6,
            spoke_thickness=4,
            gear_thickness=0,
            rim_thickness=5,
            hub_thickness=5,
            hub_diameter=10,
            circles=0);

        rotate ([0,0,360*4/17])
        translate ([39.088888,0,0])
        {
            gear (number_of_teeth=11,
                circular_pitch=500*pi/180,
                hub_diameter=0,
                rim_width=65);
            translate ([0,0,8])
            {
                gear (number_of_teeth=6,
                    circular_pitch=300*pi/180,
                    hub_diameter=0,
                    rim_width=5,
                    rim_thickness=6,
                    pressure_angle=31);
                rotate ([0,0,360*5/6])
                translate ([22.5,0,1])
                gear (number_of_teeth=21,
                    circular_pitch=300*pi/180,
                    bore_diameter=2,
                    hub_diameter=4,
                    rim_width=1,
                    hub_thickness=4,
                    rim_thickness=4,
                    gear_thickness=3,
                    pressure_angle=31);
            }
        }

        translate ([-61.1111111,0,0])
        {
            gear (number_of_teeth=27,
                circular_pitch=500*pi/180,
                circles=6,
                circle_diameter=12,
                spokes=6,
                gear_thickness=2,
                hub_thickness=10,
                centered_gear=true,
                spoke_thickness=3,
                hub_diameter=2*8.88888889);

            translate ([-37.5,0,0])
            rotate ([0,0,-90])
            rack (
                circular_pitch=500*pi/180
                 );

            translate ([0,0,10])
            {
                gear (
                    number_of_teeth=14,
                    circular_pitch=200*pi/180,
                    pressure_angle=5,
                    twist=30,
                    clearance = 0.2,
                    gear_thickness = 10,
                    rim_thickness = 10,
                    rim_width = 15,
                    bore_diameter=5,
                    circles=0);
                translate ([13.8888888,0,1])
                gear (
                    number_of_teeth=10,
                    circular_pitch=200*pi/180,
                    pressure_angle=5,
                    clearance = 0.2,
                    gear_thickness = 10,
                    rim_thickness = 8,
                    twist=-30*8/10,
                    rim_width = 15,
                    hub_thickness = 10,
                    centered_hub=true,
                    hub_diameter=7,
                    bore_diameter=4,
                    circles=0);
            }
        }

        rotate ([0,0,360*-5/17])
        translate ([44.444444444,0,0])
        gear (number_of_teeth=15,
            circular_pitch=500*pi/180,
            hub_diameter=10,
            rim_width=5,
            rim_thickness=5,
            gear_thickness=4,
            hub_thickness=6,
            circles=9);

        rotate ([0,0,360*-1/17])
        translate ([30.5555555,0,-1])
        gear (number_of_teeth=5,
            circular_pitch=500*pi/180,
            hub_diameter=0,
            rim_width=5,
            rim_thickness=10);
    }
}

module meshing_double_helix ()
{
    test_double_helix_gear ();

    mirror ([0,1,0])
    translate ([58.33333333,0,0])
    test_double_helix_gear (teeth=13,circles=6);
}

module test_double_helix_gear (
    teeth=17,
    circles=8)
{
    //double helical gear
    {

twist=200;
        height=20;
        pressure_angle=30;

        gear (number_of_teeth=teeth,
            circular_pitch=700*pi/180,
            pressure_angle=pressure_angle,
            clearance = 0.2,
            gear_thickness = height/2*0.5,
            rim_thickness = height/2,
            rim_width = 5,
            hub_thickness = height/2*1.2,
            hub_diameter=15,
            bore_diameter=5,
            circles=circles,
            twist=twist/teeth);
        mirror([0,0,1])
        gear (number_of_teeth=teeth,
            circular_pitch=700*pi/180,
            pressure_angle=pressure_angle,
            clearance = 0.2,
            gear_thickness = height/2,
            rim_thickness = height/2,
            rim_width = 5,
            hub_thickness = height/2,
            hub_diameter=15,
            bore_diameter=5,
            circles=circles,
            twist=twist/teeth);
    }
}

module test_backlash ()
{
    backlash = 2;
    teeth = 15;

    translate ([-29.166666,0,0])
    {
        translate ([58.3333333,0,0])
        rotate ([0,0,-360/teeth/4])
        gear (
            number_of_teeth = teeth,
            circular_pitch=700*pi/180,
            gear_thickness = 12,
            rim_thickness = 15,
            rim_width = 5,
            hub_thickness = 17,
            hub_diameter=15,
            bore_diameter=5,
            backlash = 2,
            circles=8);

        rotate ([0,0,360/teeth/4])
        gear (
            number_of_teeth = teeth,
            circular_pitch=700*pi/180,
            gear_thickness = 12,
            rim_thickness = 15,
            rim_width = 5,
            hub_thickness = 17,
            hub_diameter=15,
            bore_diameter=5,
            backlash = 2,
            circles=8);
    }

    color([0,0,1,0.5])
    translate([0,0,-5])
    cylinder ($fn=20,r=backlash / 4,h=25);
}



// Polyfill gear to gear_mcad
module gear(number_of_teeth, circular_pitch=undef, diametral_pitch=undef, pressure_angle=28, clearance=undef, gear_thickness=5, rim_thickness=undef, rim_width=undef, hub_thickness=undef, hub_diameter=undef, spokes=0, spoke_width=undef, spoke_thickness=undef, spoke_square=false, centered_gear=false, centered_hub=false, bore_diameter=undef, circles=0, circle_diameter=undef, backlash=0, twist=0, involute_facets=0, flat=false) {
    gear_mcad(number_of_teeth, circular_pitch, diametral_pitch, pressure_angle, clearance, gear_thickness, rim_thickness, rim_width, hub_thickness, hub_diameter, spokes, spoke_width, spoke_thickness, spoke_square, centered_gear, centered_hub, bore_diameter, circles, circle_diameter, backlash, twist, involute_facets, flat);
}

module writecylinder(text, where, radius, height, face, space, center, h, font) {
    translate(where)
    linear_extrude(height)
    text(text, size=h, halign="center", valign="center");
}

// Parameters are injected by the ParaForm engine above this line.

/*
 * Fully Printed Parametric Music Box With Exchangeable Song-Cylinders
 * Copyright (C) 2013  Philipp Tiefenbacher <wizards23@gmail.com>
 *
 * This program is free software; you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation; either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * The latest version can be found here:
 * https://github.com/wizard23/ParametrizedMusicBox 
 *
 * contibutions welcome! please send me pull requests!
 *
 * This project was started for the Thingiverse Customizer challenge
 * and is online customizable here:
 * http://www.thingiverse.com/thing:53235/ 
 *
 *
 * Changelog:
 *
 * 2013-03-09, wizard23
 * added name of song using write.scad
 * fixed pulley position on print plate
 *
 */

// use <MCAD/involute_gears.scad>
// removed write.scad

// Is this to generate models for 3D printing or for the assembled view?
// FOR_PRINT=1; // [0:Assembled, 1:PrintPlate]

// Should the MusicCylinder be generated? 
// GENERATE_MUSIC_CYLINDER=1; // [1:yes, 0:no]
// Should the Transmission Gear be generated?
// GENERATE_MID_GEAR=1; // [1:yes, 0:no]
// Should the CrankGear be generated?
// GENERATE_CRANK_GEAR=1; // [1:yes, 0:no]
// Should the Case (including the vibrating teeth) be generated?
// GENERATE_CASE=1; // [1:yes, 0:no]
// Should the Crank be generated?
// GENERATE_CRANK=1; // [1:yes, 0:no]
// Should the Pulley for the Crank be generated?
// GENERATE_PULLEY=1; // [1:yes, 0:no]

// this text will be put on top of the music cylinder
// MusicCylinderName="test song";
// What font do you want to use for the text?
MusicCylinderNameFont="write/Letters.dxf"; //["write/Letters.dxf":Basic,"write/orbitron.dxf":Futuristic,"write/BlackRose.dxf":Fancy]
// how large should the font be
MusicCylinderNameFontSize = 8;
// how deep should the name be carved in?
MusicCylinderNameDepth=0.6;
// should the text be on the top or on the bottom of the music cylinder?
MusicCylinderNamePosition=0; // [0:top, 1:bottom]

// the width of all the walls in the design.
// wall=2;

// how many vibrating teeth should there be? (also number of available notes) You can use the output of the generator for this field: http://www.wizards23.net/projects/musicbox/musicbox.html
// pinNrX = 13;

// what should the notes on the teeth be? Each note is encoded by 3 characters: note (C,D,E,F,G,A,B), then the accidental (#, b or blank), and then the a one digit octave. You can use the output of the generator for this field: http://www.wizards23.net/projects/musicbox/musicbox.html
teethNotes="C 0C#0D 0D#0E 0F 0F#0G 0G#0A 0A#0B 0C 1C#1D 1D#1E 1F 1";

// how many time slots should there be? (If you make this much higher you should also increase musicCylinderTeeth) You can use the output of the generator for this field: http://www.wizards23.net/projects/musicbox/musicbox.html
// pinNrY = 35;

// the actual song. each time slot has pinNrX characters. X marks a pin everything else means no pin. You can use the output of the generator for this field: http://www.wizards23.net/projects/musicbox/musicbox.html
pins="XoooooooooooooXoooooooooooooXoooooooooooooXoooooooooooooXoooooooooooooXoooooooooooooXoooooooooooooXoooooooooooooXoooooooooooooXoooooooooooooXoooooooooooooXoooooooooooooXoooooooooooooXoooXooXoooooooooooooooooooXoooXooXoooooooooooooooooooXoooXooXoooooooooooooooooooXoooXooXoooooooooooooooooooXoooXooXoooooooooooooooooooXoooXooXoooooooooooooXooXoooXoooooooooooooooooooXooXoooXoooooooooooooooooooXooXoooXoooooooooooooooooooXooXoooXoooooooooooooooooooXooXoooXoooooooooooooooooooXooXoooX";

// the number of teeth on the music cylinder
// musicCylinderTeeth = 24;

// nr of teeth on small transmission gear
midSmallTeeth = 8;
// nr of teeth on big transmission gear (for highest gear ratio this should be comparable but slightly smaller than musicCylinderTeeth)
midBigTeeth = 20;
// nr of teeth on crank gear
crankTeeth = 8;

//// Constants 

// the density of PLA (or whatever plastic you are using) in kg/m3 ((( scientiffically derived by me by taking the average of the density values I could find onthe net scaled a little bit to take into account that the print is not super dense (0.7 * (1210 + 1430)/2) )))
ro_PLA = 924; 
// elasticity module of the plastic you are using in N/m2 ((( derived by this formula I hope I got the unit conversion right 1.6*   1000000 *(2.5+7.8)/2 )))
E_PLA = 8240000; 
// the gamma factor for the geometry of the teeth (extruded rectangle), use this to tune it if you have a finite state modell of the printed teeth :) taken from http://de.wikipedia.org/wiki/Durchschlagende_Zunge#Berechnung_der_Tonh.C3.B6he
gammaTooth = 1.875; 
// the frequency of C0 (can be used for tuning if you dont have a clue about the material properties of you printing material :)
baseFrequC0 = 16.3516;


// the angle of the teeth relative to the cylinder (0 would be normal to cylinder, should be some small (<10) positive angle)
noteAlpha = 5;
// the transmission gears angle (to help get the music cylinder out easily this should be negative)
midGearAngle=-5;
// should be positive but the gear must still be held by the case...TODO: calculate this automagically from heigth and angle...
crankGearAngle=15;

// diametral pitch of the gear (if you make it smaller the teeth become bigger (the addendum becomes bigger) I tink of it as teeth per unit :)
diametral_pitch = 0.6;
// the height of all the gears
gearH=3;

// direction that crank hast to be turned it to play the song (has a bug: music is played backwards in clockwise mode so better leave it counter clockwise)
crankDirection = 0; // [1:Clockwise, 0:CounterClockwise]


// HoldderH is the height of the axis kegel

// how far should the snapping axis that holds the crank gear be? (should smaller than the other two because its closer to the corner of the case)
crankAxisHolderH = 1.55;
// how far should the snapping axis that holds the transmission gear be?
midAxisHolderH=3.3;
// how far should the snapping axis that holds the music cylinder be?
musicAxisHolderH=3.4;

pulleySlack=0.4;
crankSlack=0.2;
// for extra distance from axis to gears
snapAxisSlack=0.35; 
// for crank gear axis to case
axisSlack=0.3; 

// cutout to get Pulley in
pulleySnapL=1.2; 
// higher tolerance makes the teeth thinner and they slip, too low tolerance jams the gears
gear_tolerance = 0.1;
// used for the distance between paralell gears that should not touch (should be slightly larger than your layer with) 
gear_gap = 1;
gear_min_gap = 0.1;
gear_hold_R = 4;

// used for clean CSG operations
epsilonCSG = 0.1;
// reduce this for faster previews
$fn=(PERFORMANCE_MODE == 1 || TURBO_MODE == 1) ? 8 : 12;
// Replace Gears with Cylinders to verify gear alignment
DEBUG_GEARS = (HIGH_DETAIL_GEARS == 1) ? 0 : (PERFORMANCE_MODE == 1 || TURBO_MODE == 1) ? 1 : 0;
// Force DEBUG_GEARS to 1 if performance mode is on
_DEBUG_GEARS = (PERFORMANCE_MODE == 1 || TURBO_MODE == 1) ? 1 : DEBUG_GEARS;



crankAxisR = 3;
crankAxisCutAway = crankAxisR*0.8;
crankLength = 18;
crankAxisCutAwayH = 4;

crankExtraH=4;
crankH=crankExtraH+2*crankAxisCutAwayH;


pulleyH=10;
pulleyR=crankAxisR+wall;


/// music section
teethH = 3*0.3;
pinH= 3;
pteethMinD = 1.5;
teethGap = pinH;
pinD=1.5;
teethHolderW=5;
teethHolderH=5;

circular_pitch = 180/diametral_pitch;
addendum = 1/diametral_pitch;
musicH=pinNrX*(wall+teethGap);

echo("height of song cylinder");
echo(musicH);

pinStepX = musicH/pinNrX;
pinStepY = 360/pinNrY;

teethW = pinStepX-teethGap;
maxTeethL=TeethLen(0); 

musicCylinderR = (musicCylinderTeeth/diametral_pitch)/2;
midSmallR = (midSmallTeeth/diametral_pitch)/2;
midBigR = (midBigTeeth/diametral_pitch)/2;
crankR = (crankTeeth/diametral_pitch)/2;

centerForCrankGearInsertion=(midBigR+crankR)/2;

noteExtend = teethHolderW+maxTeethL + pteethMinD; 

midGearDist = musicCylinderR+midSmallR;
crankDist = midBigR+crankR;

midGearXPos = cos(midGearAngle)*midGearDist;
midGearZPos = sin(midGearAngle)*midGearDist;

crankGearXPos = midGearXPos + cos(crankGearAngle)*crankDist;
crankGearZPos = midGearZPos + sin(crankGearAngle)*crankDist;

echo("R of song cylinder");
echo(musicCylinderR);
maxMusicAddendum = 1.5*max(addendum, pinH);
frameH = max(musicCylinderR, -midGearZPos+midBigR) + maxMusicAddendum;

gearBoxW = 2 * (gearH+gear_gap+wall) + gear_gap;


songH = musicH+teethGap+teethGap;
frameW = gearBoxW + songH;

noteExtendY = sin(noteAlpha)*noteExtend;
noteExtendX = cos(noteAlpha)*noteExtend;
echo(noteExtendY/musicCylinderR);
noteBeta = asin(noteAlpha ? noteExtendY/musicCylinderR : 0);

echo("Note Extend");
echo(noteExtendX);

musicCylinderRX = cos(noteBeta)*musicCylinderR;

negXEnd = -(noteExtendX+musicCylinderRX);
posXEnd = crankGearXPos + crankR + 1.5*addendum + wall;

posYEnd = tan(noteAlpha)*(noteExtendX + musicCylinderRX+posXEnd);


module MyAxisSnapCutout(h, z=0, mirr=0,extra=epsilonCSG)
{
	translate([0,0,z])
	mirror([0,0,mirr])
	translate([0,0,-extra]) 
	{	
		cylinder(h=h+extra+snapAxisSlack, r1=h+extra+snapAxisSlack, r2=0, center=false);
	}
}


module MyAxisSnapHolder(h, x=0, y=0, z=0, mirr=0,extra=wall, h2=0)
{
	rotate([-90,0,0])
	mirror([0,0,mirr])
	translate([x,-z,-extra-y]) 
	{
		cylinder(h=h+extra, r1=h+extra, r2=0, center=false);
		intersection()
		{
			cylinder(h=h+extra+gear_hold_R, r1=h+extra+gear_hold_R, r2=0, center=false);
			translate([0, 0, -50 + extra -gear_min_gap])
				cube([100, 100, 100], center=true);
		}
	}
}

module MyGear(n, hPos, hNeg, mirr=0)
{
	if (DEBUG_GEARS)
	{
		translate([0,0,-hNeg]) cylinder(r=(n/diametral_pitch)/2, h=hPos+hNeg, center = false);
	}
	if (!DEBUG_GEARS)
	{
		HBgearWithDifferentLen(n=n, mirr=mirr, hPos=hPos, hNeg=hNeg, tol=gear_tolerance);
	}
}


module HBgearWithDifferentLen(n,hPos,hNeg,mirr=0, tol=0.25)
{
twistScale=50;
mirror([mirr,0,0])
translate([0,0,0])
union(){
	mirror([0,0,1])
	gear(number_of_teeth=n,
		diametral_pitch=diametral_pitch,
		gear_thickness=hNeg,
		rim_thickness=hNeg,
		hub_thickness=hNeg,
		bore_diameter=0,
		backlash=2*tol,
		clearance=2*tol,
		pressure_angle=20,
		twist=hNeg*twistScale/n,
		slices=5);
	
	gear(number_of_teeth=n,
		diametral_pitch=diametral_pitch,
		gear_thickness=hPos,
		rim_thickness=hPos,
		hub_thickness=hPos,
		bore_diameter=0,
		backlash=2*tol,
		clearance=2*tol,
		pressure_angle=20,
		twist=hPos*twistScale/n,
		slices=5);
}
}


echo("Testing NoteToFrequ, expected freq is 440");
echo(NoteToFrequ(9, 4, 0));


function TeethLen(x) = 
	1000*LengthOfTooth(NoteToFrequ(LetterToNoteIndex(teethNotes[x*3]), 
			LetterToDigit(teethNotes[x*3+2]),
			AccidentalToNoteShift(teethNotes[x*3+1])),
			teethH/1000, E_PLA, ro_PLA);

function LengthOfTooth(f, h, E, ro) = sqrt((gammaTooth*gammaTooth*h/(4*PI*f))*sqrt(E/(3*ro)));

function NoteToFrequ(note, octave, modification) = baseFrequC0*pow(2, octave)*pow(2, (note+modification)/12);

function AccidentalToNoteShift(l) =
l=="#"?1:
l=="b"?-1:
l==" "?0:
INVALID_ACCIDENTAL_CHECK_teethNotes();

function LetterToNoteIndex(l) =
l=="C"?0:
l=="D"?2:
l=="E"?4:
l=="F"?5:
l=="G"?7:
l=="A"?9:
l=="H"?11:
l=="B"?11: 
INVALID_NOTE_CHECK_teethNotes();

function LetterToDigit(l) = 
l=="0"?0:
l=="1"?1:
l=="2"?2:
l=="3"?3:
l=="4"?4:
l=="5"?5:
l=="6"?6:
l=="7"?7:
l=="8"?8:
l=="9"?9:
INVALID_DIGIT_IN_OCTAVE_CHECK_teethNotes();


module Pin()
{
	// Simplified for web performance: single cube instead of difference
	translate([-pinStepX/2,-pinD/2,-pinH])
	cube([pinStepX+teethGap, pinD, pinH],center=false);
}



module MusicCylinder(extra=0)
{
	translate([0,0,-extra]) cylinder(r = musicCylinderR, h = teethGap+musicH+extra, center=false, $fn=32);
	translate([0,0,teethGap])
	if (SHOW_PINS) {
		for (group_y = [0 : floor((pinNrY-1)/10)]) {
			if (PERFORMANCE_MODE == 1 || TURBO_MODE == 1) {


				for (y = [group_y*10 : min(group_y*10+9, pinNrY-1)]) {
					for (x = [0:pinNrX-1]) {
						assign(index = y*pinNrX + x) {
							if (pins[index] == "X") {
								rotate([0,0, y * pinStepY])
								translate([musicCylinderR, 0, (0.5+x)*pinStepX]) rotate([0,90,0])
								Pin();
							}
						}
					}
				}
			} else {
				union() {
					for (y = [group_y*10 : min(group_y*10+9, pinNrY-1)]) {
						for (x = [0:pinNrX-1]) {
							assign(index = y*pinNrX + x) {
								if (pins[index] == "X") {
									rotate([0,0, y * pinStepY])
									translate([musicCylinderR, 0, (0.5+x)*pinStepX]) rotate([0,90,0])
									Pin();
								}
							}
						}
					}
				}
			}
		}
	}
}



module MusicBox()
{
	//mirror([0,0,1])
	translate([teethHolderW+maxTeethL,0,0])

	rotate([180,0,0])
	for (x = [0:pinNrX-1])
	{
		assign(ll = TeethLen(x))
		{
			translate([-maxTeethL, x *pinStepX + teethGap, 0]) 
			{
				// teeth holder
				assign (leftAdd = (x == 0) ? gearBoxW : 0, rightAdd = (x == pinNrX-1) ? wall/2+gear_gap : 0)
				{
				translate([-(teethHolderW), epsilonCSG-leftAdd, 0]) 
					cube([teethHolderW+maxTeethL-ll, pinStepX+2*epsilonCSG+leftAdd+rightAdd, teethHolderH]);
				}
				

				// teeth
				translate([-teethHolderW/2, teethGap,0])
				color([0,1,0])cube([maxTeethL+teethHolderW/2, teethW, teethH]);
			}
		}
	}
	
}


///// CODE


mirror ([0, FOR_PRINT?crankDirection:0,0])
{
// case shape

if (GENERATE_CASE)
{	
	translate([0,0,FOR_PRINT?-negXEnd*sin(noteAlpha):0])
	intersection()
	{
		if (FOR_PRINT)
		{
			//translate([0,0, 500+negXEnd*sin(noteAlpha)]) cube([1000, 1000, 1000], center=true);

			assign(maxX = max(posXEnd, -negXEnd))
			translate([0,0, 2*frameH+negXEnd*sin(noteAlpha)]) cube([3*maxX, 2*frameW, 4*frameH], center=true);
		}
	rotate([FOR_PRINT?180:0, FOR_PRINT?-noteAlpha:0,0])
	{

	difference()
	{
		union()
		{

		// PIANO :)
		
		translate([-(noteExtendX+musicCylinderRX),-(gearH/2+gear_gap+teethGap),0]) 
			rotate([0,-noteAlpha*1,0]){
			
				MusicBox();
				translate([0,2*gearH+wall,-teethHolderW]) cube([-negXEnd,teethHolderW,teethHolderW]);
			}
	
		// snapaxis for crank
		MyAxisSnapHolder(h=crankAxisHolderH, x=crankGearXPos, y =gearH/2+gear_gap, z=crankGearZPos, mirr=0, extra=gear_gap+epsilonCSG);
	
	
	
		// snapaxis for music cylinder
		MyAxisSnapHolder(h=musicAxisHolderH, y =gearH/2-gear_gap, mirr=1, extra=gearH+2*gear_gap+wall/2);
		MyAxisSnapHolder(h=musicAxisHolderH, y =gearH/2 +1*gear_gap +songH, extra=gear_gap+epsilonCSG, mirr=0);
	
		// snapaxis for mid gear
		MyAxisSnapHolder(h=midAxisHolderH, y =1.5*gearH, x=midGearXPos, z=midGearZPos, mirr=1);
		MyAxisSnapHolder(h=midAxisHolderH, y =gearH/2+gear_gap, x=midGearXPos, z=midGearZPos, mirr=0);
	
		difference()
		{
			// side poly extruded and rotated to be side
			rotate([-90,0,0]){
				translate([0,0,-frameW+1.5*gearH + gear_gap+wall])
					linear_extrude(height=frameW) 
						polygon(points=
[[negXEnd,0],[posXEnd,-posYEnd],[posXEnd,frameH], [negXEnd,frameH]], paths=[[0,1,2,3]]);
	
			
			}

// cutout, wall then remain
		linear_extrude(height=4*frameH, center=true) 
					polygon(points=[
[negXEnd+wall,-(0.5*gearH+2*gear_gap+songH)],
[musicCylinderR+maxMusicAddendum,-(0.5*gearH+songH+2*gear_gap)],
[musicCylinderR+maxMusicAddendum,-(0.5*gearH+2*gear_gap)],
[posXEnd-wall,-(0.5*gearH+2*gear_gap)],
[posXEnd-wall,(1.5*gearH+gear_gap)],
 [negXEnd+wall,(1.5*gearH+gear_gap)]
], paths=[[0,1,2,3,4,5]]);
	

		}
	}

		// cutout, make sure gears can rotate
		linear_extrude(height=4*frameH, center=true) 
					polygon(points=[
[0+1*crankAxisR,(1.5*gearH+gear_gap)],
[0+1*crankAxisR,-(songH/2)],
[musicCylinderR+maxMusicAddendum,-(songH/2)],
[musicCylinderR+maxMusicAddendum,(1.5*gearH+gear_gap)]], paths=[[0,1,2,3]]);


// cutout because of narrow smallgear
			linear_extrude(height=4*frameH, center=true) 
					polygon(points=[
[musicCylinderR+maxMusicAddendum+wall,-(0.5*gearH+2*gear_gap+wall)],
[musicCylinderR+maxMusicAddendum+wall,-frameW],
[posXEnd+1,-frameW],
[posXEnd+1,-(0.5*gearH+2*gear_gap+wall)]], paths=[[0,1,2,3]]);


			// Crank Gear Cutouts
			translate([crankGearXPos,0,crankGearZPos])
			{
				rotate([-90,0,0])
					cylinder(h=100, r=crankAxisR+axisSlack, center=false);


				rotate([0,-90-max(crankGearAngle,45+noteAlpha),0]) 
				{

					*translate([-(crankAxisR-axisSlack),0,0]) cube([2*(crankAxisR),100, centerForCrankGearInsertion]);

					
rotate([-90,0,0])
linear_extrude(height=musicH/2, center=false) 
					polygon(points=[
[-(crankAxisR+axisSlack),-centerForCrankGearInsertion],
[(crankAxisR+axisSlack),-centerForCrankGearInsertion],
[(crankAxisR),0],
[-(crankAxisR),0]],
paths=[[0,1,2,3]]);


					translate([0*(crankR+addendum*1.5),0,centerForCrankGearInsertion])
					rotate([90,0,0])
					cylinder(h=100, r=(crankR+addendum*1.5), center=false);

					translate([0*(crankR+addendum*1.5),0,centerForCrankGearInsertion])
					mirror([0,1,0])
					rotate([90,0,0])
					cylinder(h=100, r=crankAxisR+axisSlack, center=false);

				}	
			}

	}
	
	}
}
}
}


// music cylinder and gear
if (GENERATE_MUSIC_CYLINDER)
{
	translate([FOR_PRINT?-1.5*(musicCylinderR+addendum):0,FOR_PRINT?(crankDirection ? -1 : 1)*-((musicCylinderR+addendum)+gearBoxW):0, FOR_PRINT?gearH/2-gear_gap:0])
	rotate([FOR_PRINT?180:-90,0,0])
		translate([0,0,-(gear_gap)])
		difference()
		{
			union()
			{
				MyGear(n=musicCylinderTeeth, hPos = gearH/2, hNeg=gearH/2+gear_gap);
				translate([0,0,-gearH/2-gear_gap/2]) cylinder(h=gear_gap+epsilonCSG, r2=musicCylinderR-addendum, r1=musicCylinderR-addendum+gear_gap);
				rotate([0, 180,0]) 
translate([0,0,teethGap+gearH/2]) 
{
rotate([0,0,27]) MusicCylinder(extra=teethGap+epsilonCSG);
}
				// PINS :)
			}
			union()
			{
				MyAxisSnapCutout(h=musicAxisHolderH, z=-(gearH/2)-songH, mirr=0);
				MyAxisSnapCutout(h=musicAxisHolderH, z=gearH/2, mirr=1);
	
				// text
				if (PERFORMANCE_MODE == 0) {
					translate([0,0,MusicCylinderNamePosition == 1 ? gearH/2+1: -(songH+gearH/2-MusicCylinderNameDepth)]) 
						scale([1,1,MusicCylinderNameDepth+1])
							writecylinder(text=MusicCylinderName, where=[0,0,0], radius=musicCylinderR, height=1, face="bottom", space=1.3, center=true, h=MusicCylinderNameFontSize, font=MusicCylinderNameFont);
				}
			}
		}
}

// midGear
color([1,0,0])
if (GENERATE_MID_GEAR)
{
	translate([FOR_PRINT?1.5*(musicCylinderR+addendum):0,FOR_PRINT?(crankDirection ? -1 : 1)*-((musicCylinderR+addendum)+gearBoxW):0, FOR_PRINT?1.5*gearH:0])

	translate([FOR_PRINT?0:midGearXPos,0,FOR_PRINT?0:midGearZPos])
		rotate([FOR_PRINT?180:-90,0,0])
			difference()
			{
			union() {
				translate([0,0,gearH]) 
				{
					difference(){
						MyGear(n=midBigTeeth, hPos = gearH/2, hNeg=gearH/2,mirr=1);
						
					}
				}
				translate([0,0,-gear_gap])
				difference()
				{
					MyGear(n=midSmallTeeth, hPos = gearH/2+gear_gap+epsilonCSG, hNeg=gearH/2, mirr=1);
				}
				
			}
			translate([0,0,-gear_gap])			
					MyAxisSnapCutout(h=midAxisHolderH, z=-(gearH/2), mirr=0);
			translate([0,0,gearH]) MyAxisSnapCutout(h=midAxisHolderH, z=(gearH/2), mirr=1);
			}
}



if (GENERATE_CRANK_GEAR)
{
	// crank gear
	translate([FOR_PRINT?0:crankGearXPos, FOR_PRINT?(crankDirection ? -1 : 1)*-(gearBoxW/2+wall/2+gearH+crankR+addendum):0, FOR_PRINT?(0.5*gearH+gear_gap):crankGearZPos])


	//translate([crankGearXPos,0,crankGearZPos])
		rotate([FOR_PRINT?0:-90,0,0])
		union() {
			translate([0,0,gearH]) 
			difference()
			{
				union() {
					difference() {
						cylinder(h=gearH/2+wall+2*gear_gap+2*crankAxisCutAwayH, r=crankAxisR, center=false);
						translate([0,50+crankAxisR-crankAxisCutAway,gearH/2+wall+gear_gap+2*crankAxisCutAwayH])cube([100,100,crankAxisCutAwayH*2], center=true);
					}
					cylinder(h=gearH/2+gear_gap-gear_min_gap, r=crankR-addendum, center=false);
					MyGear(n=crankTeeth, hPos = gearH/2, hNeg=1.5*gearH+gear_gap, mirr=0);	
				}
				MyAxisSnapCutout(h=crankAxisHolderH, z=-1.5*gearH-gear_gap);
			}
		}
}

// crank
color([0,1,0])
if (GENERATE_CRANK)
{
	translate([FOR_PRINT?-2*wall:crankGearXPos, FOR_PRINT?(crankDirection ? -1 : 1)*musicH/2+gearH:1.5*gearH+2*gear_gap+wall+crankH, FOR_PRINT?0:crankGearZPos])

	rotate([FOR_PRINT?0:-90,0,0])
	mirror([0,0,FOR_PRINT?0:1])
	{
		// to gear snapping
		difference() {
			cylinder(h=crankH, r=crankAxisR+crankSlack+wall,center=false);
			translate([0,0,crankH-gear_gap])  difference() {
				cylinder(h=4*crankAxisCutAwayH, r=crankAxisR+crankSlack,center=true);
				translate([0,50+crankAxisR+crankSlack-crankAxisCutAway,-2*crankAxisCutAwayH])cube([100,100,crankAxisCutAwayH*2], center=true);
			}
		}
		
		translate([crankLength,0,0]) 
			difference() {
				union() {
					// crank long piece
					translate([-crankLength/2,0,wall/2])
						cube([crankLength,2*(crankAxisR),wall],center=true);
					translate([-crankLength/2,0,crankExtraH/2])
							cube([crankLength,wall,crankExtraH],center=true);
					// where puley snaps/axis
					cylinder(h=crankExtraH, r=crankAxisR+pulleySlack+wall,center=false);
				}
				cylinder(h=3*crankExtraH, r=crankAxisR+pulleySlack,center=true);
				translate([50,0,0]) cube([100, 2*crankAxisR-2*pulleySnapL, 100], center=true);
			}
				
	}
}

if (GENERATE_PULLEY)
{
	translate([FOR_PRINT?(musicCylinderR+maxMusicAddendum):crankGearXPos, FOR_PRINT?(crankDirection ? -1 : 1)*gearBoxW+pulleyR:1.5*gearH+2*gear_gap+wall+crankH-crankExtraH, FOR_PRINT?crankExtraH+pulleyH+2*gear_gap:crankGearZPos])	
	rotate([FOR_PRINT?180:-90,0,0])
	translate([crankLength,0,0]) 
	{
		// delta shaped end
		translate([0,0,-wall-gear_gap]) cylinder(h=crankAxisR+wall+gear_gap, r2=0, r1=crankAxisR+wall,center=false);
		// axis
		translate([0,0,-wall/2]) cylinder(h=crankExtraH+pulleyH+wall/2, r=crankAxisR,center=false);
		// handle
		translate([0,0,crankExtraH+gear_gap]) cylinder(h=pulleyH+gear_gap, r=pulleyR,center=false);
	}
}










`
    },
    {
        id: 'bbb_case_v1',
        title: 'BeagleBone Black Board',
        description: 'A detailed 3D model of the BeagleBone Black board (Requires external libraries for full detail).',
        ui_parameters: [
            { key: 'show_components', label: 'Show Components', type: 'boolean', default: true },
        ],
        source: `
// Basic Polyfills for standalone testing
function in2mm(i) = i / 1000 * 25.4;
module extrude_plate(h, hp, hd, ro) { linear_extrude(h) children(); }
module set_components(bd, ci) { children(); }
module button(dim, type) { color("grey") cube(dim); }
module ethernet(dim) { color("silver") cube(dim); }
module female_header_pitch254(dim, n, m) { color("black") cube(dim); }
module microhdmi(dim) { color("gold") cube(dim); }
module microsdcard(dim) { color("blue") cube(dim); }
module microsdslot(dim) { color("black") cube(dim); }
module miniusb(dim) { color("silver") cube(dim); }
module pin_header_pitch254(dim, n, m) { color("black") cube(dim); }
module power_bbb(dim) { color("black") cube(dim); }
module rt_bbb(dim) { color("black") cube(dim); }
module usb(dim) { color("silver") cube(dim); }
module demo_board(bd) { children(); }
function button_info() = [];
function ethernet_info() = [];
function female_header_info() = [];
function microhdmi_info() = [];
function microsdcard_info() = [];
function microsdslot_info() = [];
function miniusb_info() = [];
function pin_header_info() = [];
function power_bbb_info() = [];
function rt_bbb_info() = [];
function usb_info() = [];

// Original Source (Modified for standalone)
board_dim = [in2mm(3400), in2mm(2150), 1.75];
hole_d = in2mm(125);
hole_orig = [board_dim[0], board_dim[1]] * -.5;
ring_off = 1;
holes_pos = [
    hole_orig + [in2mm( 575), in2mm(2025)],
    hole_orig + [in2mm( 575), in2mm( 125)],
    hole_orig + [in2mm(3175), in2mm( 250)],
    hole_orig + [in2mm(3175), in2mm(1900)],
];

button_dim      = [  4,                3,    2];
ethernet_dim    = [ 21,               16, 13.5];
gpio_dim        = [ 59,                5,  8.5];
microhdmi_dim   = [7.5, in2mm(1110- 850),    3];
microsdcard_dim = [ 15,               11,    1];
microsdslot_dim = [ 15, in2mm(1755-1205),    2];
miniusb_dim     = [7.1, in2mm(1880-1575),    4];
power_dim       = [ 14,                9,   11];
rt1_dim         = [3.5,                8, 10.5];
serial_dim      = [ 15,              2.5,  8.5];
usb_dim         = [ 14,             14.5,    8];

module beaglebone_black_plate_2d() {
    l = board_dim[0];
    w = board_dim[1];
    ledgesz = in2mm(250);
    redgesz = in2mm(500);
    difference() {
        square([l, w], center=true);
        difference() {
            union() {
                translate([-l/2,           -w/2        ]) square(ledgesz);
                translate([-l/2,            w/2-ledgesz]) square(ledgesz);
                translate([ l/2 - redgesz,  w/2-redgesz]) square(redgesz);
                translate([ l/2 - redgesz, -w/2        ]) square(redgesz);
            }
            translate([-l/2 + ledgesz, -w/2 + ledgesz]) circle(ledgesz);
            translate([-l/2 + ledgesz,  w/2 - ledgesz]) circle(ledgesz);
            translate([ l/2 - redgesz,  w/2 - redgesz]) circle(redgesz);
            translate([ l/2 - redgesz, -w/2 + redgesz]) circle(redgesz);
        }
    }
}

comp_info = [
    [button_info(),         button_dim,      [-1,-1,-1], [0,0,0], [-1,-1, 1], [ 74, 41.5, 0]],
    [button_info(),         button_dim,      [-1,-1,-1], [0,0,0], [-1,-1, 1], [5.5,   40, 0]],
    [button_info(),         button_dim,      [-1,-1,-1], [0,0,0], [-1,-1, 1], [5.5, 49.5, 0]],
    [ethernet_info(),       ethernet_dim,    [ 1, 1,-1], [0,0,2], [-1,-1, 1], [-in2mm(100), in2mm(855), 0]],
    [female_header_info(),  gpio_dim,        [-1, 1,-1], [0,0,0], [-1, 1, 1], [18, -0.5, 0]],
    [female_header_info(),  gpio_dim,        [-1,-1,-1], [0,0,0], [-1,-1, 1], [18,  0.5, 0]],
    [microhdmi_info(),      microhdmi_dim,   [ 1,-1, 1], [0,0,0], [ 1,-1,-1], [ in2mm(25), in2mm(850),  0]],
    [microsdcard_info(),    microsdcard_dim, [ 1,-1, 1], [0,0,0], [ 1,-1,-1], [in2mm(110), in2mm(1205)+.5, 0]],
    [microsdslot_info(),    microsdslot_dim, [ 1,-1, 1], [0,0,0], [ 1,-1,-1], [0, in2mm(1205), 0]],
    [miniusb_info(),        miniusb_dim,     [ 1, 1, 1], [0,0,2], [-1,-1,-1], [-in2mm(25), in2mm(1575), 0]],
    [pin_header_info(),     serial_dim,      [-1,-1,-1], [0,0,0], [-1,-1, 1], [41, 6, 0]],
    [power_bbb_info(),      power_dim,       [ 1, 1,-1], [0,0,2], [-1,-1, 1], [-in2mm(100), in2mm(215), 0]],
    [rt_bbb_info(),         rt1_dim,         [-1,-1,-1], [0,0,0], [-1,-1, 1], [68, 6.5, 0]],
    [usb_info(),            usb_dim,         [ 1,-1,-1], [0,0,0], [ 1,-1, 1], [0, in2mm(405) - .6, 0]],
];

module beaglebone_black() {
    extrude_plate(board_dim[2], holes_pos, hole_d, ring_off)
        beaglebone_black_plate_2d();

    if (show_components) {
        // Mock components
        translate([10,10,0]) ethernet(ethernet_dim);
        translate([-10,-10,0]) usb(usb_dim);
        translate([20,-10,0]) power_bbb(power_dim);
    }
}

demo_board(board_dim) {
   beaglebone_black();
}
`
    },
    {
        id: 'rpi3_case_v1',
        title: 'Raspberry Pi 3 Case',
        description: 'A parametric case for the Raspberry Pi 3 (Requires external libraries for full detail).',
        ui_parameters: [
            { key: 'show_board', label: 'Show Board', type: 'boolean', default: true },
        ],
        source: `
// Basic Polyfills for standalone testing
function map_get(map, key) = (key == "board_dim") ? [85, 56, 1.5] : undef;
function raspberry_pi_3_info() = [["board_dim", [85, 56, 1.5]]];
function default_bottom_vents(bd) = [];
module case(name, cfg, mode) {
    board_dim = [85, 56, 1.5];
    color("green") cube(board_dim);
    // Mock case
    %difference() {
        translate([-5,-5,-5]) cube([95, 66, 25]);
        translate([-2,-2,-2]) cube([89, 60, 25]);
    }
}

// Original Source (Modified for standalone)
board_dim = map_get(raspberry_pi_3_info(), "board_dim");

vents = [
    [
        "bottom", default_bottom_vents(board_dim),
    ],[
        "top", [
            ["dim", [board_dim[0] * .3, board_dim[1] * .7]],
            ["pos", [-18, -4.5]],
        ]
    ]
];

cfg = [
    ["min_z", 3],
    ["max_z", 9],
    ["vents", vents],
];

mode = "demo";
case("rpi3", cfg, mode);
`
    }
];


// --- ROUTING SYSTEM ---
const routes = {
    '/': 'view-landing',
    '/explore': 'view-explore',
    '/create': 'view-create',
    '/auth': 'view-auth'
};

function getProjectTitle() {
    return currentState.projectTitle?.trim() || currentState.template?.title?.trim() || 'Untitled Project';
}

function syncProjectTitleUI() {
    const nextTitle = getProjectTitle();
    const titleInput = document.getElementById('nav-project-title');
    if (titleInput && titleInput.value !== nextTitle) {
        titleInput.value = nextTitle;
    }
}

function bindProjectTitleInput() {
    const titleInput = document.getElementById('nav-project-title');
    if (!titleInput) return;

    titleInput.oninput = () => {
        currentState.projectTitle = titleInput.value;
        if (currentState.template) currentState.template.title = titleInput.value;
    };

    titleInput.onblur = () => {
        const normalizedTitle = titleInput.value.trim() || 'Untitled Project';
        currentState.projectTitle = normalizedTitle;
        if (currentState.template) currentState.template.title = normalizedTitle;
        titleInput.value = normalizedTitle;
    };
}

let closeEditorMenusHandler = null;

function handleRouting() {
    let hash = window.location.hash.slice(1) || '/';
    if (hash !== '/' && !hash.startsWith('/')) hash = '/' + hash;
    
    if (hash === '/auth') {
        window.location.hash = '#/';
        return;
    }

    const viewId = routes[hash] || 'view-landing';

    // Hide all views
    document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
    
    // Show active view
    const activeView = document.getElementById(viewId);
    if (activeView) {
        activeView.classList.remove('hidden');
        currentState.view = hash;
        onViewChange(hash);
    }
}


// --- SUPABASE & AUTH ---
async function initApp() {
    console.log('ParaForm: Initializing App...');
    
    // 1. Initialize Auth
    try {
        if (supabase && supabase.auth) {
            const { data: { session } } = await supabase.auth.getSession();
            updateUser(session?.user ?? null);
            supabase.auth.onAuthStateChange((_event, session) => updateUser(session?.user ?? null));
        }
    } catch (e) {
        console.warn('Supabase Auth skipped:', e.message);
        updateUser(null);
    }

    // 2. Fetch Templates (bucket catalog → DEFAULT_TEMPLATES fallback)
    try {
        await fetchTemplates();
    } catch (e) {
        console.warn('[ParaForm] Template fetch failed, using defaults:', e.message);
        currentState.templates = DEFAULT_TEMPLATES;
    }
    
    // Load local storage custom thumbnails and default 3D product renders
    loadTemplateThumbnails();
    renderTemplateGrid();
    
    // 3. Routing System
    const handleRoute = () => {
        let hash = window.location.hash.slice(1) || '/';
        if (hash === '/auth') {
            window.location.hash = '#/';
            return;
        }
        currentState.view = hash;
        
        // Hide all views
        document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
        
        // Show target view
        const viewId = `view-${hash === '/' ? 'landing' : hash.slice(1)}`;
        const targetView = document.getElementById(viewId);
        if (targetView) targetView.classList.remove('hidden');
        
        // Global Editor Class
        const isEditor = hash === '/create';
        document.body.classList.toggle('in-editor', isEditor);
        
        // Context-Based Navbar Rendering
        const editorBadge = document.getElementById('editor-badge');
        const navLinks = document.querySelector('.nav-links');
        const navActions = document.querySelector('.nav-actions');

        if (closeEditorMenusHandler) {
            document.removeEventListener('click', closeEditorMenusHandler);
            closeEditorMenusHandler = null;
        }

        if (isEditor) {
            // --- STUDIO NAVBAR VARIANT ---
            if (editorBadge) {
                editorBadge.innerText = 'Studio';
                editorBadge.className = 'badge mini success'; // green success badge
                editorBadge.classList.remove('hidden');
            }

            if (navLinks) {
                navLinks.classList.remove('hidden');
                navLinks.innerHTML = `
                    <div class="editor-nav-composer">
                        <input id="nav-project-title" class="editor-project-name" type="text" placeholder="Untitled Project">
                        <div class="menu-bar">
                        <div class="menu-item">
                            <button class="menu-trigger">File ▾</button>
                            <div class="dropdown-content">
                                <a href="#" id="menu-open-model">📁 Open Model</a>
                                <a href="#" id="menu-save-design">💾 Save Design</a>
                                <a href="#" id="menu-export-stl">📤 Export…</a>
                                <hr class="menu-divider">
                                <a href="#/explore">🚪 Exit Studio</a>
                            </div>
                        </div>
                        <div class="menu-item">
                            <button class="menu-trigger">View ▾</button>
                            <div class="dropdown-content">
                                <a href="#" id="menu-reset-camera">🎥 Reset Camera</a>
                                <a href="#" id="menu-toggle-wireframe">🕸️ Toggle Wireframe</a>
                            </div>
                        </div>
                        <div class="menu-item">
                            <button class="menu-trigger">Settings ▾</button>
                            <div class="dropdown-content">
                                <a href="#" id="menu-perf-mode">🚀 Performance Mode</a>
                                <a href="#" id="menu-show-diags">📋 Show Diagnostics</a>
                                <a href="#" id="menu-ai-settings">🤖 AI Settings</a>
                            </div>
                        </div>
                        </div>
                    </div>
                `;
                syncProjectTitleUI();
                bindProjectTitleInput();

                // Bind Dropdown Toggle for Tap / Click (Desktop and Mobile)
                const menuTriggers = navLinks.querySelectorAll('.menu-trigger');
                menuTriggers.forEach(trig => {
                    trig.onclick = (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        const pItem = trig.parentElement;
                        const wasOpen = pItem.classList.contains('open');
                        
                        // Close all open dropdowns
                        navLinks.querySelectorAll('.menu-item').forEach(item => item.classList.remove('open'));
                        
                        if (!wasOpen) {
                            pItem.classList.add('open');
                        }
                    };
                });

                // Global document click closes open dropdown menus
                const closeAllMenus = () => {
                    navLinks.querySelectorAll('.menu-item').forEach(item => item.classList.remove('open'));
                };
                closeEditorMenusHandler = closeAllMenus;
                document.addEventListener('click', closeEditorMenusHandler);

                // Bind Dropdown items click handlers
                const openModelBtn = document.getElementById('menu-open-model');
                if (openModelBtn) {
                    openModelBtn.onclick = (e) => {
                        e.preventDefault();
                        closeAllMenus();
                        openStudioLibrary();
                    };
                }

                const saveDesignBtn = document.getElementById('menu-save-design');
                if (saveDesignBtn) {
                    saveDesignBtn.onclick = (e) => {
                        e.preventDefault();
                        closeAllMenus();
                        if (!currentState.template) return;
                        const source = document.getElementById('code-editor')?.value
                            || currentState.template.source || '';
                        const project = saveProject({
                            id: currentState.template.id,
                            title: currentState.projectTitle || currentState.template.title,
                            templateId: currentState.template.id,
                            source,
                            params: { ...currentState.params }
                        });
                        const ts = new Date(project.savedAt).toLocaleTimeString();
                        alert(`💾 "${project.title}" saved locally at ${ts}.`);
                    };
                }

                const exportStlBtn = document.getElementById('menu-export-stl');
                if (exportStlBtn) {
                    exportStlBtn.onclick = (e) => {
                        e.preventDefault();
                        closeAllMenus();
                        openExportModal();
                    };
                }

                const resetCamBtn = document.getElementById('menu-reset-camera');
                if (resetCamBtn) {
                    resetCamBtn.onclick = (e) => {
                        e.preventDefault();
                        closeAllMenus();
                        const resetBtn = document.getElementById('view-reset');
                        if (resetBtn) resetBtn.click();
                    };
                }

                const toggleWireBtn = document.getElementById('menu-toggle-wireframe');
                if (toggleWireBtn) {
                    toggleWireBtn.onclick = (e) => {
                        e.preventDefault();
                        closeAllMenus();
                        const wireBtn = document.getElementById('view-wireframe');
                        if (wireBtn) wireBtn.click();
                    };
                }

                const perfModeBtn = document.getElementById('menu-perf-mode');
                if (perfModeBtn) {
                    perfModeBtn.onclick = (e) => {
                        e.preventDefault();
                        closeAllMenus();
                        
                        // Toggle Performance Mode
                        const current = currentState.params.PERFORMANCE_MODE !== false;
                        currentState.params.PERFORMANCE_MODE = !current;
                        
                        const checkbox = document.getElementById('param-PERFORMANCE_MODE');
                        if (checkbox) {
                            checkbox.checked = !current;
                        }
                        
                        triggerRender();
                    };
                }

                const showDiagsBtn = document.getElementById('menu-show-diags');
                if (showDiagsBtn) {
                    showDiagsBtn.onclick = (e) => {
                        e.preventDefault();
                        closeAllMenus();
                        
                        const rightPanel = document.getElementById('info-panel');
                        if (rightPanel) {
                            rightPanel.scrollIntoView({ behavior: 'smooth' });
                            rightPanel.style.borderColor = 'var(--accent-color)';
                            setTimeout(() => {
                                rightPanel.style.borderColor = 'var(--border-color)';
                            }, 1000);
                        }
                    };
                }

                const aiSettingsBtn = document.getElementById('menu-ai-settings');
                if (aiSettingsBtn) {
                    aiSettingsBtn.onclick = (e) => {
                        e.preventDefault();
                        closeAllMenus();
                        openAISettingsModal();
                    };
                }
            }

            if (navActions) {
                navActions.innerHTML = `
                    <button id="studio-browse-btn" class="secondary-btn">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
                        Library
                    </button>
                    <button id="export-stl" class="primary-btn">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                        Export
                    </button>
                    <button id="mobile-menu-toggle" class="icon-btn mobile-only">
                        <span></span>
                        <span></span>
                        <span></span>
                    </button>
                `;

                const studioBrowseBtn = document.getElementById('studio-browse-btn');
                if (studioBrowseBtn) studioBrowseBtn.onclick = openStudioLibrary;

                const exportBtn = document.getElementById('export-stl');
                if (exportBtn) exportBtn.onclick = openExportModal;

                // Re-bind mobile menu toggle
                const mobileToggle = document.getElementById('mobile-menu-toggle');
                if (mobileToggle) {
                    mobileToggle.onclick = () => {
                        navLinks.classList.toggle('mobile-active');
                        mobileToggle.classList.toggle('active');
                    };
                }
            }

        } else {
            // --- WEBSITE NAVBAR VARIANT ---
            if (editorBadge) {
                editorBadge.classList.add('hidden');
            }

            if (navLinks) {
                navLinks.classList.remove('hidden');
                const manageLinkHtml = currentState.user ? `<a href="#/manage" id="manage-link" class="nav-link">Manage</a>` : '';
                navLinks.innerHTML = `
                    <a href="#/" class="nav-link">Home</a>
                    <a href="#/explore" class="nav-link">Explore</a>
                    ${manageLinkHtml}
                `;
            }

            if (navActions) {
                navActions.innerHTML = `
                    <a href="#/create" class="primary-btn">Launch Studio</a>
                    <button id="mobile-menu-toggle" class="icon-btn mobile-only">
                        <span></span>
                        <span></span>
                        <span></span>
                    </button>
                `;

                // Re-bind mobile menu toggle
                const mobileToggle = document.getElementById('mobile-menu-toggle');
                if (mobileToggle) {
                    mobileToggle.onclick = () => {
                        navLinks.classList.toggle('mobile-active');
                        mobileToggle.classList.toggle('active');
                    };
                }
            }

            // Update active nav link class
            document.querySelectorAll('.nav-link').forEach(link => {
                const linkHash = link.getAttribute('href').replace('#', '');
                if (linkHash === hash || (linkHash === '#/' && hash === '/')) {
                    link.classList.add('active');
                } else {
                    link.classList.remove('active');
                }
            });
        }

        // Close mobile active menu on routing change
        if (navLinks) navLinks.classList.remove('mobile-active');
        const mobileToggle = document.getElementById('mobile-menu-toggle');
        if (mobileToggle) mobileToggle.classList.remove('active');

        // Re-bind link click mobile close
        if (navLinks) {
            navLinks.querySelectorAll('a').forEach(link => {
                link.addEventListener('click', () => navLinks.classList.remove('mobile-active'));
            });
        }

        onViewChange(hash);
    };

    window.addEventListener('hashchange', handleRoute);
    handleRoute(); // Initial call

    // 4. Mobile Menu Toggle
    const mobileToggle = document.getElementById('mobile-menu-toggle');
    const navLinks = document.querySelector('.nav-links');
    if (mobileToggle) {
        mobileToggle.onclick = () => {
            navLinks.classList.toggle('mobile-active');
            mobileToggle.classList.toggle('active');
        };
        // Close menu on link click
        navLinks.querySelectorAll('a').forEach(link => {
            link.onclick = () => navLinks.classList.remove('mobile-active');
        });
    }
    
    // Initialize High Fidelity Right Panel controls
    initRightPanelControls();
    initViewportToolbar();
}


async function login() {
    const { error } = await supabase.auth.signInWithOAuth({
        provider: 'github',
        options: { redirectTo: window.location.origin }
    });
    if (error) alert('Login error: ' + error.message);
}

async function loginWithMagicLink() {
    const email = document.getElementById('magic-link-email').value;
    if (!email) return alert('Please enter your email');
    
    const { error } = await supabase.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: window.location.origin }
    });
    
    if (error) alert('Error: ' + error.message);
    else alert('Check your email for the magic link!');
}

async function fetchTemplates() {
    // Try the public bucket catalog first
    const remote = await fetchCatalog();
    if (remote.length > 0) {
        // Merge: bucket templates come first, then any DEFAULT_TEMPLATES not already present
        const remoteIds = new Set(remote.map(t => t.id));
        const extras = DEFAULT_TEMPLATES.filter(t => !remoteIds.has(t.id));
        currentState.templates = [...remote, ...extras];
    } else {
        currentState.templates = DEFAULT_TEMPLATES;
    }
}

// --- RENDERERS ---
let mainViewport = null;
let heroViewport = null;

function createRenderer(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return null;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(75, container.clientWidth / container.clientHeight, 0.1, 1000);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.innerHTML = '';
    container.appendChild(renderer.domElement);

    // Lighting Setup
    const hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 2.0);
    hemiLight.position.set(0, 200, 0);
    scene.add(hemiLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 3.0);
    dirLight.position.set(100, 200, 50);
    scene.add(dirLight);

    const fillLight = new THREE.DirectionalLight(0x90b0d0, 1.5);
    fillLight.position.set(-100, -50, -50);
    scene.add(fillLight);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    camera.position.set(80, 80, 80);

    // Ground Grid
    const grid = new THREE.GridHelper(400, 40, 0x6366f1, 0x334155);
    grid.position.y = -0.1; // Prevent Z-fighting
    grid.material.opacity = 0.2;
    grid.material.transparent = true;
    scene.add(grid);

    // Subtle Axes
    const axes = new THREE.AxesHelper(20);
    axes.material.opacity = 0.5;
    axes.material.transparent = true;
    scene.add(axes);

    // Premium Material
    const material = new THREE.MeshStandardMaterial({ 
        color: 0x6366f1, 
        metalness: 0.2, 
        roughness: 0.3,
        side: THREE.DoubleSide // Ensure inner faces of parametric models are visible
    });
    
    let transformControls = null;
    if (containerId === 'viewport') {
        transformControls = new TransformControls(camera, renderer.domElement);
        transformControls.size = 1.25; // Render 25% larger for optimal interaction bounds
        transformControls.rotationSnap = THREE.MathUtils.degToRad(5); // Enforce default 5-degree snapping!
        scene.add(transformControls.getHelper()); // Add the visual gizmo helper to the scene
        
        transformControls.addEventListener('dragging-changed', (event) => {
            controls.enabled = !event.value;
            if (!event.value) {
                saveHistoryState();
            }
        });
        
        transformControls.addEventListener('change', () => {
            if (transformControls.object && !currentState.isSyncingFromUI) {
                const obj = transformControls.object;
                const state = currentState.viewportState;
                
                // 1. State X and Z map exactly to object position
                state.position.x = parseFloat(obj.position.x.toFixed(2));
                state.position.z = parseFloat(obj.position.z.toFixed(2));
                
                // 2. Find lowest Y point of the rotated/scaled object to compute state.position.y
                const box = new THREE.Box3().setFromObject(obj);
                const lowestY = box.min.y - obj.position.y;
                state.position.y = parseFloat((obj.position.y + lowestY).toFixed(2));
                
                // 3. Sync rotation and scale
                state.rotation.x = Math.round(THREE.MathUtils.radToDeg(obj.rotation.x));
                state.rotation.y = Math.round(THREE.MathUtils.radToDeg(obj.rotation.y));
                state.rotation.z = Math.round(THREE.MathUtils.radToDeg(obj.rotation.z));
                
                state.scale = parseFloat(obj.scale.x.toFixed(2));
                
                // Sync values to UI inputs
                syncViewportStateToUI();
            }
        });

        // --- DIRECT MESH DRAGGING & SELECTION ENGINE ---
        const raycaster = new THREE.Raycaster();
        const mouse = new THREE.Vector2();
        const plane = new THREE.Plane();
        const planeNormal = new THREE.Vector3(0, 1, 0); // Y-up normal
        const intersection = new THREE.Vector3();
        const offset = new THREE.Vector3();
        let mouseDownTime = 0;
        let mouseDownPos = new THREE.Vector2();

        const getMousePos = (e) => {
            const rect = renderer.domElement.getBoundingClientRect();
            mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
            mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        };

        renderer.domElement.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return; // Only trigger for left clicks
            
            // Get current active mesh
            const mesh = mainViewport ? mainViewport.currentMesh : null;
            if (!mesh) return;

            getMousePos(e);
            mouseDownTime = Date.now();
            mouseDownPos.copy(mouse);

            raycaster.setFromCamera(mouse, camera);
            const intersects = raycaster.intersectObject(mesh);
            
            if (intersects.length > 0) {
                // Support Place on Face / Lay Flat tool (align the clicked face to the bed)
                if (currentState.activeGizmoTool === 'layflat') {
                    const hit = intersects[0];
                    if (hit.face) {
                        const localNormal = hit.face.normal.clone();
                        const targetNormal = new THREE.Vector3(0, -1, 0); // Outward face normal points down into bed
                        
                        // Compute quaternion to rotate the clicked face parallel to the bed
                        const targetQuat = new THREE.Quaternion().setFromUnitVectors(localNormal, targetNormal);
                        
                        // Decompose to Euler rotation angles (in degrees)
                        const euler = new THREE.Euler().setFromQuaternion(targetQuat, 'XYZ');
                        
                        const state = currentState.viewportState;
                        state.rotation.x = Math.round(THREE.MathUtils.radToDeg(euler.x));
                        state.rotation.y = Math.round(THREE.MathUtils.radToDeg(euler.y));
                        state.rotation.z = Math.round(THREE.MathUtils.radToDeg(euler.z));
                        
                        // Reset manual offset elevation Y so it sits flat
                        state.position.y = 0;
                        
                        // Update transformations and UI
                        syncViewportStateToUI();
                        
                        // Return to Select mode and remove visual targets
                        setGizmoToolMode('select');
                    }
                    return;
                }

                // If model is clicked: Select it!
                if (!currentState.isSelected) {
                    currentState.isSelected = true;
                    updateSelectionHighlight();
                }
            }
        });

        renderer.domElement.addEventListener('mousemove', (e) => {
            const mesh = mainViewport ? mainViewport.currentMesh : null;
            if (!mesh) return;
            
            getMousePos(e);
            raycaster.setFromCamera(mouse, camera);
            
            // 1. Support real-time face highlighting in Lay Flat / Place on Face mode
            if (currentState.activeGizmoTool === 'layflat' && !currentState.isDraggingMesh) {
                const intersects = raycaster.intersectObject(mesh);
                if (intersects.length > 0) {
                    const hit = intersects[0];
                    if (hit.face) {
                        const geom = mesh.geometry;
                        const positionAttr = geom.attributes.position;
                        
                        if (positionAttr) {
                            const face = hit.face;
                            
                            // Retrieve vertex coordinates (local)
                            const vA = new THREE.Vector3().fromBufferAttribute(positionAttr, face.a);
                            const vB = new THREE.Vector3().fromBufferAttribute(positionAttr, face.b);
                            const vC = new THREE.Vector3().fromBufferAttribute(positionAttr, face.c);
                            
                            // Convert to world space
                            vA.applyMatrix4(mesh.matrixWorld);
                            vB.applyMatrix4(mesh.matrixWorld);
                            vC.applyMatrix4(mesh.matrixWorld);
                            
                            // Apply tiny offset along world normal to eliminate z-fighting
                            const localNormal = face.normal.clone();
                            const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
                            const worldNormal = localNormal.applyMatrix3(normalMatrix).normalize();
                            const shift = worldNormal.multiplyScalar(0.04); // 0.04 units hover offset
                            
                            vA.add(shift);
                            vB.add(shift);
                            vC.add(shift);
                            
                            // Create face highlighter on demand
                            if (!mainViewport.faceHighlighter) {
                                const highlightGeom = new THREE.BufferGeometry();
                                highlightGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
                                const highlightMat = new THREE.MeshBasicMaterial({
                                    color: 0x6366f1, // Bright glowing indigo
                                    transparent: true,
                                    opacity: 0.65,
                                    side: THREE.DoubleSide,
                                    depthWrite: false,
                                    depthTest: true
                                });
                                mainViewport.faceHighlighter = new THREE.Mesh(highlightGeom, highlightMat);
                                
                                const edgesGeom = new THREE.BufferGeometry();
                                edgesGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
                                const edgesMat = new THREE.LineBasicMaterial({
                                    color: 0x818cf8, // Lighter neon indigo border
                                    linewidth: 2,
                                    depthWrite: false,
                                    depthTest: true
                                });
                                mainViewport.faceHighlighterOutline = new THREE.LineLoop(edgesGeom, edgesMat);
                                
                                scene.add(mainViewport.faceHighlighter);
                                scene.add(mainViewport.faceHighlighterOutline);
                            }
                            
                            // Update highlighter mesh geometries
                            const posArray = mainViewport.faceHighlighter.geometry.attributes.position.array;
                            posArray[0] = vA.x; posArray[1] = vA.y; posArray[2] = vA.z;
                            posArray[3] = vB.x; posArray[4] = vB.y; posArray[5] = vB.z;
                            posArray[6] = vC.x; posArray[7] = vC.y; posArray[8] = vC.z;
                            mainViewport.faceHighlighter.geometry.attributes.position.needsUpdate = true;
                            mainViewport.faceHighlighter.geometry.computeBoundingSphere();
                            
                            const edgeArray = mainViewport.faceHighlighterOutline.geometry.attributes.position.array;
                            edgeArray[0] = vA.x; edgeArray[1] = vA.y; edgeArray[2] = vA.z;
                            edgeArray[3] = vB.x; edgeArray[4] = vB.y; edgeArray[5] = vB.z;
                            edgeArray[6] = vC.x; edgeArray[7] = vC.y; edgeArray[8] = vC.z;
                            mainViewport.faceHighlighterOutline.geometry.attributes.position.needsUpdate = true;
                            mainViewport.faceHighlighterOutline.geometry.computeBoundingSphere();
                            
                            mainViewport.faceHighlighter.visible = true;
                            mainViewport.faceHighlighterOutline.visible = true;
                        }
                    }
                } else {
                    // Hide if mouse wanders outside the model
                    if (mainViewport.faceHighlighter) {
                        mainViewport.faceHighlighter.visible = false;
                        mainViewport.faceHighlighterOutline.visible = false;
                    }
                }
                return;
            }
        });

        renderer.domElement.addEventListener('mouseup', (e) => {
            
            // Check for empty space single click to DE-SELECT model
            getMousePos(e);
            const moveDist = mouse.distanceTo(mouseDownPos);
            const clickDuration = Date.now() - mouseDownTime;
            
            // A quick tap/click with minimal mouse shift represents a deliberate select/deselect tap!
            if (clickDuration < 200 && moveDist < 0.015) {
                const mesh = mainViewport ? mainViewport.currentMesh : null;
                if (mesh) {
                    raycaster.setFromCamera(mouse, camera);
                    const intersects = raycaster.intersectObject(mesh);
                    // Clicked empty space on grid/canvas (neither mesh nor transform controls active)
                    if (intersects.length === 0 && !transformControls.dragging) {
                        currentState.isSelected = false;
                        updateSelectionHighlight();
                    }
                }
            }
        });
    }
    
    return { scene, camera, renderer, controls, material, container, hemiLight, dirLight, fillLight, grid, transformControls };
}

function initHeroPreview() {
    if (heroViewport) return;
    heroViewport = createRenderer('hero-viewport');
    if (!heroViewport) return;

    // Simple cube for demo
    const geometry = new THREE.BoxGeometry(50, 50, 50);
    const mesh = new THREE.Mesh(geometry, heroViewport.material);
    heroViewport.scene.add(mesh);

    document.getElementById('hero-slider').oninput = (e) => {
        const val = e.target.value;
        mesh.scale.setScalar(val / 80);
    };

    function animate() {
        if (currentState.view !== '/') return;
        requestAnimationFrame(animate);
        heroViewport.controls.update();
        heroViewport.renderer.render(heroViewport.scene, heroViewport.camera);
    }
    animate();
}

// --- EXPLORE GRID & SEARCH ---
function renderTemplateGrid(filterText = '') {
    const grid = document.getElementById('template-grid');
    if (!grid) return;
    grid.innerHTML = '';

    const filtered = currentState.templates.filter(t => 
        t.title.toLowerCase().includes(filterText.toLowerCase()) ||
        t.description?.toLowerCase().includes(filterText.toLowerCase())
    );

    filtered.forEach(t => {
        const card = document.createElement('div');
        card.className = 'template-card glass';
        card.innerHTML = `
            <div class="card-thumb">
                <img src="${t.thumbnail_url || ''}" alt="${t.title}" style="display:${t.thumbnail_url ? 'block' : 'none'}">
            </div>
            <div class="card-info">
                <h4>${t.title}</h4>
                <p>${t.description || 'Parametric Gadget'}</p>
            </div>
        `;
        card.onclick = async () => {
            await selectTemplate(t);
            window.location.hash = '#/create';
        };
        const img = card.querySelector('img');
        if (!t.thumbnail_url) {
            img.style.display = 'none';
            const fallback = document.createElement('div');
            fallback.className = 'thumbnail-fallback';
            fallback.innerHTML = '<span>CAD</span>';
            img.parentNode.insertBefore(fallback, img);
        } else {
            img.onerror = () => {
                img.style.display = 'none';
                const fallback = document.createElement('div');
                fallback.className = 'thumbnail-fallback';
                fallback.innerHTML = '<span>3D</span>';
                img.parentNode.insertBefore(fallback, img);
            };
        }
        
        grid.appendChild(card);
    });
}

document.getElementById('template-search').oninput = (e) => {
    renderTemplateGrid(e.target.value);
};

// --- CONFIGURATOR LOGIC ---
// --- CAD WORKER POOL ---
class CADWorkerPool {
    constructor(maxWorkers = 1) { // Reduced to 1 for absolute memory stability
        this.maxWorkers = maxWorkers;
        this.workers = []; 
        this.jobQueue = [];
        this.callbacks = new Map(); // jobId -> callback
        console.log(`[CADPool] Initialized with ${maxWorkers} workers.`);
    }


    _createWorker() {
        const id = Math.random().toString(36).substr(2, 9);
        const worker = new Worker(new URL('./cad.worker.js', import.meta.url), { type: 'module' });
        const workerEntry = { id, worker, status: 'initializing', jobId: null, startTime: 0 };
        
        worker.onmessage = (e) => {
            const data = e.data;
            if (data.type === 'ready') {
                workerEntry.status = 'idle';
                this._processQueue();
                
                // Track initialization for loader
                window.dispatchEvent(new CustomEvent('worker-ready', { detail: { id } }));
            } else if (data.type === 'result') {
                workerEntry.status = 'idle';
                const cb = this.callbacks.get(data.jobId);
                if (cb) {
                    cb(data);
                    this.callbacks.delete(data.jobId);
                }
                this._processQueue();
            }
        };

        worker.onerror = (err) => {
            this._terminateWorker(workerEntry);
        };

        worker.postMessage({ type: 'init' });
        this.workers.push(workerEntry);
        return workerEntry;
    }

    _terminateWorker(entry) {
        if (!entry) return;
        try {
            entry.worker.terminate();
        } catch (e) {}
        
        this.workers = this.workers.filter(w => w.id !== entry.id);
        const cb = this.callbacks.get(entry.jobId);
        if (cb) {
            cb({ jobId: entry.jobId, ok: false, error: 'Worker Terminated (Crash or Stale)' });
            this.callbacks.delete(entry.jobId);
        }
        // Force queue processing to replace the lost worker
        setTimeout(() => this._processQueue(), 50);
    }

    _processQueue() {
        if (this.jobQueue.length === 0) return;

        // Discard stale non-final jobs from queue
        this.jobQueue = this.jobQueue.filter(j => j.isFinal || j.jobId >= currentState.jobId - 1);
        if (this.jobQueue.length === 0) return;

        this.jobQueue.sort((a, b) => b.jobId - a.jobId);
        
        let idleWorker = this.workers.find(w => w.status === 'idle');
        
        if (!idleWorker && this.workers.length < this.maxWorkers) {
            idleWorker = this._createWorker();
            return;
        }

        if (idleWorker) {
            const job = this.jobQueue.shift();
            idleWorker.status = 'busy';
            idleWorker.jobId = job.jobId;
            idleWorker.startTime = performance.now();
            idleWorker.worker.postMessage(job);
        } else {
            // ALL BUSY: Kill the oldest non-final worker if we have a new job
            const oldestNonFinal = this.workers
                .filter(w => w.status === 'busy' && !this.jobQueue.find(j => j.jobId === w.jobId)?.isFinal)
                .sort((a, b) => a.startTime - b.startTime)[0];

            if (oldestNonFinal && this.jobQueue[0].jobId > oldestNonFinal.jobId + 2) {
                console.log(`[CADPool] Killing stale worker ${oldestNonFinal.jobId} for new job ${this.jobQueue[0].jobId}`);
                this._terminateWorker(oldestNonFinal);
                this._processQueue();
            }
        }
    }

    requestRender(job, callback) {
        this.callbacks.set(job.jobId, callback);
        this.jobQueue.push(job);
        this._processQueue();
    }
}

const pool = new CADWorkerPool();



async function selectTemplate(template, autoExtract = false) {
    // Fetch SCAD source from bucket (or cache) if not already inline
    if (!template.source) {
        const loaderOverlay = document.getElementById('loader-overlay');
        const loaderText = loaderOverlay?.querySelector('p');
        if (loaderOverlay) {
            loaderOverlay.classList.remove('hidden');
            if (loaderText) loaderText.textContent = 'Loading model…';
        }
        try {
            const source = await fetchScadSource(template);
            template = { ...template, source };
        } catch (e) {
            if (loaderOverlay) loaderOverlay.classList.add('hidden');
            console.error('[ParaForm] Failed to load model source:', e);
            alert(`Could not load model: ${e.message}`);
            return;
        }
        if (loaderOverlay) loaderOverlay.classList.add('hidden');
    }

    currentState.template = template;
    currentState.projectTitle = template.title || 'Untitled Project';
    currentState.params = {};

    // Auto-extract parameters for custom code
    if (autoExtract && template.source) {
        template.ui_parameters = parseParametersFromSource(template.source);
    }

    // Support custom templates or templates with no params
    if (template.ui_parameters) {
        template.ui_parameters.forEach(p => currentState.params[p.key] = p.default);
    }

    syncProjectTitleUI();
    const descEl = document.getElementById('active-template-desc');
    if (descEl) descEl.innerText = template.description || '';

    // Sync code editor
    const editor = document.getElementById('code-editor');
    if (editor) editor.value = template.source || '';

    showConfigurator();
    renderParameters();

    if (!mainViewport) mainViewport = createRenderer('viewport');
    syncViewportStateToUI();
    drawBuildPlate();
    updateLightingSettings();

    // Clear and initialize parametric history stack
    undoHistory = [];
    redoHistory = [];
    saveHistoryState();

    triggerGeneration();
}

function initModal() {
    const modal = document.getElementById('custom-model-modal');
    if (!modal || modal.dataset.initialized) return;
    modal.dataset.initialized = 'true';
    
    const addBtn = document.getElementById('add-custom-model-btn');
    const closeBtn = modal.querySelector('.close-modal');
    const cancelBtn = document.getElementById('modal-cancel-btn');
    const createBtn = document.getElementById('modal-create-btn');
    const dropZone = document.getElementById('modal-drop-zone');
    const fileInput = document.getElementById('modal-file-input');
    
    const show = () => modal.classList.remove('hidden');
    const hide = () => {
        modal.classList.add('hidden');
        document.getElementById('modal-code-input').value = '';
    };

    addBtn.onclick = show;
    closeBtn.onclick = hide;
    cancelBtn.onclick = hide;
    
    dropZone.onclick = () => fileInput.click();
    fileInput.onchange = (e) => {
        const file = e.target.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = (re) => {
                document.getElementById('modal-code-input').value = re.target.result;
            };
            reader.readAsText(file);
        }
    };

    createBtn.onclick = async () => {
        const source = document.getElementById('modal-code-input').value;
        if (!source.trim()) return alert('Please enter code or upload a file.');
        
        const customTemplate = {
            id: 'custom_' + Date.now(),
            title: 'Custom Model',
            description: 'Imported from Library.',
            source: source,
            ui_parameters: []
        };
        
        hide();
        await selectTemplate(customTemplate, true);
        window.location.hash = '#/create';
    };
}

function showCreateChoice() {
    currentState.template = null;
    currentState.projectTitle = 'Untitled Project';
    document.getElementById('create-selection').classList.remove('hidden');
    
    // Ensure viewport is ready in background
    if (!mainViewport) mainViewport = createRenderer('viewport');
    syncViewportStateToUI();
    drawBuildPlate();
    updateLightingSettings();
    
    // Init choice listeners
    document.getElementById('choice-existing').onclick = () => {
        openStudioLibrary();
        // If they pick something, openStudioLibrary calls selectTemplate -> showConfigurator
    };
    document.getElementById('choice-custom').onclick = () => startCustomCode();
}

function showConfigurator() {
    document.getElementById('create-selection').classList.add('hidden');
    
    // Back button removed from HTML — no-op

    const browseBtn = document.getElementById('studio-browse-btn');
    if (browseBtn) browseBtn.onclick = openStudioLibrary;
    
    initTabs();
}

function openStudioLibrary() {
    const modal = document.getElementById('studio-library-modal');
    const grid = document.getElementById('studio-library-grid');
    const searchInput = document.getElementById('studio-library-search');
    
    modal.classList.remove('hidden');
    
    const renderItems = (filter = '') => {
        grid.innerHTML = '';
        const items = currentState.templates.filter(t => 
            t.title.toLowerCase().includes(filter.toLowerCase()) || 
            t.description?.toLowerCase().includes(filter.toLowerCase())
        );
        
        items.forEach(template => {
            const card = document.createElement('div');
            card.className = 'template-card glass mini-card';
            const paramCount = template.ui_parameters ? template.ui_parameters.length : 0;
            card.innerHTML = `
                <div class="card-thumb-mini">
                    ${template.thumbnail_url ? `<img src="${template.thumbnail_url}" alt="${template.title}">` : '<div class="thumb-placeholder">⬢</div>'}
                    <span class="card-param-badge">${paramCount} PARAMS</span>
                </div>
                <div class="card-info-mini">
                    <span class="card-meta">ID: ${template.id.toUpperCase()}</span>
                    <h5>${template.title}</h5>
                    <p class="card-desc">${template.description || 'Custom parametric script'}</p>
                </div>
            `;
            card.onclick = async () => {
                modal.classList.add('hidden');
                await selectTemplate(template);
            };
            grid.appendChild(card);
        });
    };
    
    renderItems();
    searchInput.oninput = (e) => renderItems(e.target.value);
}

async function startCustomCode() {
    const customTemplate = {
        id: 'custom_' + Date.now(),
        title: 'New Custom Model',
        description: 'Your own OpenSCAD creation.',
        ui_parameters: [],
        source: `// New Custom Model\n\ndifference() {\n    cube(40, center=true);\n    sphere(25);\n}`
    };
    
    await selectTemplate(customTemplate);
    switchTab('code');
}

function initTabs() {
    const tabs = document.querySelectorAll('.tab-btn');
    tabs.forEach(tab => {
        tab.onclick = () => switchTab(tab.dataset.tab);
    });
    
    // Run code button
    const runBtn = document.getElementById('run-code-btn');
    if (runBtn) {
        runBtn.onclick = () => {
            if (currentState.template) {
                const newSource = document.getElementById('code-editor').value;
                currentState.template.source = newSource;
                
                // Re-extract parameters if source changed
                const newParams = parseParametersFromSource(newSource);
                currentState.template.ui_parameters = newParams;
                
                // Update params state while preserving existing values where possible
                const oldParams = { ...currentState.params };
                currentState.params = {};
                newParams.forEach(p => {
                    currentState.params[p.key] = oldParams[p.key] ?? p.default;
                });

                renderParameters();
                triggerGeneration(true);
            }
        };
    }

    // Ctrl+S to run
    document.getElementById('code-editor').onkeydown = (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 's') {
            e.preventDefault();
            runBtn.click();
        }
    };
}

function switchTab(tabId) {
    currentState.editMode = tabId;
    
    // Update UI
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tabId);
    });
    
    document.getElementById('tab-content-params').classList.toggle('hidden', tabId !== 'params');
    document.getElementById('tab-content-code').classList.toggle('hidden', tabId !== 'code');
    document.getElementById('tab-content-ai').classList.toggle('hidden', tabId !== 'ai');
}

function renderParameters() {
    const container = document.getElementById('parameters-container');
    container.innerHTML = '';
    
    currentState.template.ui_parameters.forEach(param => {
        const group = document.createElement('div');
        group.className = `parameter-group type-${param.type}`;
        
        let inputHtml = '';
        
        if (param.type === 'number' || param.type === 'integer') {
            const unit = param.unit ? `<span class="param-unit">${param.unit}</span>` : '';
            inputHtml = `
                <div class="param-label">
                    <span>${param.label}</span>
                    <div class="param-value-wrap">
                        <input type="number" class="manual-input" value="${currentState.params[param.key]}" step="${param.step}">
                        ${unit}
                    </div>
                </div>
                <input type="range" min="${param.min}" max="${param.max}" step="${param.step}" value="${currentState.params[param.key]}">
            `;
        } else if (param.type === 'enum') {
            const options = param.options.map(opt => `<option value="${opt}" ${currentState.params[param.key] === opt ? 'selected' : ''}>${opt}</option>`).join('');
            inputHtml = `
                <div class="param-label"><span>${param.label}</span></div>
                <select class="glass-select">${options}</select>
            `;
        } else if (param.type === 'boolean') {
            inputHtml = `
                <div class="param-label">
                    <span>${param.label}</span>
                    <label class="switch">
                        <input type="checkbox" ${currentState.params[param.key] ? 'checked' : ''}>
                        <span class="slider-round"></span>
                    </label>
                </div>
            `;
        }

        group.innerHTML = inputHtml;
        
        // Event Listeners
        if (param.type === 'number' || param.type === 'integer') {
            const range = group.querySelector('input[type="range"]');
            const manual = group.querySelector('input[type="number"]');
            
            const update = (val, isFinal = false) => {
                const numericVal = parseFloat(val);
                currentState.params[param.key] = numericVal;
                range.value = numericVal;
                manual.value = numericVal;
                debouncedGenerate(isFinal);
            };

            range.oninput = (e) => {
                currentState.isMovingSlider = true;
                update(e.target.value, false);
            };
            range.onchange = (e) => {
                currentState.isMovingSlider = false;
                update(e.target.value, true);
            };
            manual.onchange = (e) => update(e.target.value, true);
            
        } else if (param.type === 'enum') {
            const select = group.querySelector('select');
            select.onchange = (e) => {
                currentState.params[param.key] = e.target.value;
                debouncedGenerate(true);
            };
        } else if (param.type === 'boolean') {
            const checkbox = group.querySelector('input');
            checkbox.onchange = (e) => {
                currentState.params[param.key] = e.target.checked;
                debouncedGenerate(true);
            };
        }

        container.appendChild(group);
    });
}

let debounceTimeout;
function debouncedGenerate(isFinal = false) {
    clearTimeout(debounceTimeout);
    // Preview renders (isFinal=false) are faster (50ms)
    // Final renders (isFinal=true) wait longer (400ms) to ensure user finished moving
    const delay = isFinal ? 400 : 50;
    debounceTimeout = setTimeout(() => triggerGeneration(isFinal), delay);
}

function triggerGeneration(isFinalRequested = null) {
    currentState.jobId++;
    currentState.isGenerating = true;
    
    const badge = document.getElementById('status-badge');
    badge.innerText = 'Rendering...';
    badge.className = 'loading';
    
    const startTime = performance.now();
    const isTurbo = currentState.params.PERFORMANCE_MODE !== false;
    
    // Respect requested finality, otherwise use state
    const isFinal = isFinalRequested !== null ? isFinalRequested : !currentState.isMovingSlider;

    // LOCAL PREVIEW ENGINE (Polysolid style)
    if (!isFinal && currentState.template.localPreview) {
        try {
            const geometry = currentState.template.localPreview(currentState.params, mainViewport.material);
            updateViewportMesh(geometry);
            document.getElementById('render-time').innerText = `Instant (CSG)`;
            document.getElementById('loader-overlay').classList.add('hidden');
            const badge = document.getElementById('status-badge');
            badge.innerText = 'Real-time';
            badge.className = 'success';
            
            // Dispatch render completion for loader
            window.dispatchEvent(new CustomEvent('render-complete', { detail: { isFinal: true } }));
            
            return; // Skip worker
        } catch (e) {
            console.warn('Local preview failed, falling back to worker:', e);
        }
    }

    // Inject Performance Overrides
    let performanceOverrides = "";
    if (isTurbo && !isFinal) {
        performanceOverrides = `
$fn = 8;
$preview = true;
render_quality = "low";
`;
    } else {
        performanceOverrides = `
$fn = 12; // Ultra-stable for WASM
$preview = false;
render_quality = "high";
`;
    }

    const declarations = currentState.template.ui_parameters
        .map(p => {
            const val = currentState.params[p.key] ?? p.default;
            if (p.type === 'boolean') {
                return `${p.key} = ${val ? 1 : 0};`; // Revert to 1/0 for SCAD template compatibility
            } else if (p.type === 'enum' && p.key === 'FOR_PRINT') {

                return `FOR_PRINT = ${val === 'PrintPlate' ? 1 : 0};`;
            } else if (typeof val === 'string') {
                return `${p.key} = "${val}";`;
            } else {
                return `${p.key} = ${val ?? 0};`;
            }
        }).join('\n');

    // Define parts for modular rendering
    let parts = ['full'];
    if (currentState.template.id === 'music_box_v1' && isFinal) {
        // gears_main/gears_crank temporarily disabled for stability
        parts = ['case', 'cylinder']; 
    }

    console.log(`[ParaForm] Rendering ${currentState.template.id} in ${parts.length} parts. Final: ${isFinal}`);

    const baseSource = currentState.template.source;
    let pendingParts = parts.length;
    const partGeometries = new Map();

    parts.forEach(part => {
        let partOverrides = "";
        if (part === 'case') {
            partOverrides = "GENERATE_CASE=1; GENERATE_MUSIC_CYLINDER=0; GENERATE_MID_GEAR=0; GENERATE_CRANK_GEAR=0; GENERATE_CRANK=0; GENERATE_PULLEY=0;";
        } else if (part === 'cylinder') {
            partOverrides = "GENERATE_CASE=0; GENERATE_MUSIC_CYLINDER=1; GENERATE_MID_GEAR=0; GENERATE_CRANK_GEAR=0; GENERATE_CRANK=0; GENERATE_PULLEY=0;";
        } else if (part === 'gears_main') {
            partOverrides = "GENERATE_CASE=0; GENERATE_MUSIC_CYLINDER=0; GENERATE_MID_GEAR=1; GENERATE_CRANK_GEAR=0; GENERATE_CRANK=0; GENERATE_PULLEY=1;";
        } else if (part === 'gears_crank') {
            partOverrides = "GENERATE_CASE=0; GENERATE_MUSIC_CYLINDER=0; GENERATE_MID_GEAR=0; GENERATE_CRANK_GEAR=1; GENERATE_CRANK=1; GENERATE_PULLEY=0;";
        }

        // Declarations go AFTER baseSource so they override any existing
        // variable declarations in the file (OpenSCAD: last assignment wins).
        const source = `// ParaForm Modular: ${part}
${baseSource}
// -- ParaForm parameter overrides --
${declarations}
TURBO_MODE = ${isFinal ? 0 : 1};
${partOverrides}
${performanceOverrides}`;

        pool.requestRender({ 
            jobId: currentState.jobId, 
            partId: part,
            sourceCode: source, 
            format: 'stl', 
            isFinal,
            context: 'main'
        }, (data) => {
            if (data.jobId !== currentState.jobId) return;
            
            if (data.ok) {
                const loader = new STLLoader();
                const geom = loader.parse(data.buffer);
                partGeometries.set(part, geom);
            } else if (data.error && !data.error.includes('Terminated')) {
                console.error(`Part ${part} failed:`, data.error);
            }

            pendingParts--;
            if (pendingParts === 0) {
                finalizeModularRender(partGeometries, startTime, isFinal);
            }
        });
    });
}

function finalizeModularRender(geometries, startTime, isFinal) {
    document.getElementById('loader-overlay').classList.add('hidden');
    const badge = document.getElementById('status-badge');
    
    if (geometries.size === 0) {
        badge.innerText = 'Render Failed';
        badge.className = 'error';
        return;
    }

    const mergedGeom = BufferGeometryUtils.mergeGeometries(Array.from(geometries.values()));
    updateViewportMesh(mergedGeom);
    
    badge.innerText = isFinal ? 'Render Ready' : 'Turbo Preview';
    badge.className = isFinal ? 'success' : 'info';
    document.getElementById('render-time').innerText = `${Math.round(performance.now() - startTime)}ms`;
    currentState.isGenerating = false;

    // Dispatch render completion for loader
    window.dispatchEvent(new CustomEvent('render-complete', { detail: { isFinal } }));
    
    if (isFinal) {
        saveHistoryState();
        // Wait 500ms for final render loop updates and position settles, then capture thumbnail
        setTimeout(generateActiveThumbnail, 500);
    }
}

function updateViewportMesh(data) {
    if (!mainViewport) return;
    
    let geometry;
    if (data instanceof THREE.BufferGeometry) {
        geometry = data;
    } else {
        const loader = new STLLoader();
        const buffer = data.buffer ? data.buffer : data;
        geometry = loader.parse(buffer);
    }
    
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    
    const center = new THREE.Vector3();
    geometry.boundingBox.getCenter(center);
    const minY = geometry.boundingBox.min.y;
    
    // Shift geometry locally so its pivot point is perfectly centered at X/Z and resting flat on Y=0
    geometry.translate(-center.x, -minY, -center.z);
    
    // Recalculate bounding box and normals after the local shift
    geometry.computeBoundingBox();
    geometry.computeVertexNormals();

    // Detach gizmo before removing old mesh
    if (mainViewport.transformControls) {
        mainViewport.transformControls.detach();
    }

    if (mainViewport.currentMesh) mainViewport.scene.remove(mainViewport.currentMesh);
    mainViewport.currentMesh = new THREE.Mesh(geometry, mainViewport.material);
    
    // Apply dynamic custom transforms, scale, material finish, buildplates, and lighting
    applyObjectTransform();
    updateMaterialSettings();
    drawBuildPlate();
    updateLightingSettings();
    
    mainViewport.scene.add(mainViewport.currentMesh);

    // Update selection outline box helper and attach active gizmo controls
    updateSelectionHighlight();

    document.getElementById('stats-poly').innerText = `Polys: ${Math.round(geometry.attributes.position.count / 3).toLocaleString()}`;
}

// --- HIGH FIDELITY 3D EDITOR FEATURE FUNCTIONS ---

function applyObjectTransform() {
    if (!mainViewport || !mainViewport.currentMesh) return;
    
    const mesh = mainViewport.currentMesh;
    const state = currentState.viewportState;
    
    // 1. Apply scale and rotation
    mesh.scale.setScalar(state.scale);
    mesh.rotation.set(
        THREE.MathUtils.degToRad(state.rotation.x),
        THREE.MathUtils.degToRad(state.rotation.y),
        THREE.MathUtils.degToRad(state.rotation.z)
    );
    
    // 2. Set X and Z directly from state! (No rotated offset required since local center is 0,0,0)
    mesh.position.x = state.position.x;
    mesh.position.z = state.position.z;
    
    // 3. Compute lowest Y of rotated mesh to rest flat
    mesh.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(mesh);
    const lowestY = box.min.y - mesh.position.y; // Find lowest Y relative to mesh.position.y
    
    mesh.position.y = state.position.y - lowestY;
}

function updateMaterialSettings() {
    if (!mainViewport || !mainViewport.material) return;
    
    const mat = mainViewport.material;
    const state = currentState.viewportState;
    
    // Set color
    mat.color.set(state.materialColor);
    
    // Apply finish preset properties
    if (state.materialFinish === 'semi-gloss') {
        mat.roughness = 0.35;
        mat.metalness = 0.15;
        mat.transparent = false;
        mat.opacity = 1.0;
    } else if (state.materialFinish === 'matte') {
        mat.roughness = 0.85;
        mat.metalness = 0.05;
        mat.transparent = false;
        mat.opacity = 1.0;
    } else if (state.materialFinish === 'silk') {
        mat.roughness = 0.15;
        mat.metalness = 0.85;
        mat.transparent = false;
        mat.opacity = 1.0;
    } else if (state.materialFinish === 'translucent') {
        mat.roughness = 0.2;
        mat.metalness = 0.1;
        mat.transparent = true;
        mat.opacity = 0.65;
    }
    
    mat.needsUpdate = true;
}

function drawBuildPlate() {
    if (!mainViewport || !mainViewport.scene) return;
    
    const scene = mainViewport.scene;
    const state = currentState.viewportState;
    
    // Remove existing custom plate group
    if (mainViewport.buildPlateGroup) {
        scene.remove(mainViewport.buildPlateGroup);
    }
    
    // Toggle default grid visibility
    if (mainViewport.grid) {
        mainViewport.grid.visible = (state.buildPlate === 'none');
    }
    
    if (state.buildPlate === 'none') {
        mainViewport.buildPlateGroup = null;
        return;
    }
    
    // Create new custom printer build plate group
    const group = new THREE.Group();
    mainViewport.buildPlateGroup = group;
    
    let w = 220, l = 220, color = 0x6366f1, name = "Build Plate";
    
    if (state.buildPlate === 'bambu') {
        w = 256; l = 256; color = 0x00ff66; name = "Bambu Lab Grid (256x256)";
    } else if (state.buildPlate === 'prusa') {
        w = 250; l = 210; color = 0xff5500; name = "Prusa i3 Bed (250x210)";
    } else if (state.buildPlate === 'ender') {
        w = 220; l = 220; color = 0x00aaff; name = "Ender 3 Bed (220x220)";
    } else if (state.buildPlate === 'voron') {
        w = 120; l = 120; color = 0xff1493; name = "Voron v0.2 Grid (120x120)";
    } else if (state.buildPlate === 'large') {
        w = 400; l = 400; color = 0xffaa00; name = "Industrial Bed (400x400)";
    }
    
    // 1. Semi-transparent dark bed plate surface
    const plateGeom = new THREE.PlaneGeometry(w, l);
    const plateMat = new THREE.MeshStandardMaterial({
        color: 0x0a0a0a,
        roughness: 0.7,
        metalness: 0.2,
        transparent: true,
        opacity: 0.75,
        side: THREE.DoubleSide,
        depthWrite: false
    });
    const plateMesh = new THREE.Mesh(plateGeom, plateMat);
    plateMesh.rotation.x = -Math.PI / 2;
    plateMesh.position.y = -0.05;
    group.add(plateMesh);
    
    // 2. High-contrast manufacturer colored grid
    const gridColor = new THREE.Color(color).multiplyScalar(0.2);
    const gridHelper = new THREE.GridHelper(Math.max(w, l), Math.round(Math.max(w, l) / 10), color, gridColor);
    gridHelper.position.y = -0.04;
    gridHelper.material.transparent = true;
    gridHelper.material.opacity = 0.45;
    group.add(gridHelper);
    
    // 3. Glowing manufacturer colored border lines
    const borderGeom = new THREE.EdgesGeometry(plateGeom);
    const borderMat = new THREE.LineBasicMaterial({ color: color, linewidth: 2 });
    const border = new THREE.LineSegments(borderGeom, borderMat);
    border.rotation.x = -Math.PI / 2;
    border.position.y = -0.03;
    group.add(border);
    
    scene.add(group);
}

function updateLightingSettings() {
    if (!mainViewport || !mainViewport.scene) return;
    
    const state = currentState.viewportState;
    const hemi = mainViewport.hemiLight;
    const dir = mainViewport.dirLight;
    const fill = mainViewport.fillLight;
    
    if (!hemi || !dir || !fill) return;
    
    // Apply Lighting presets
    if (state.lightPreset === 'standard') {
        hemi.color.setHex(0xffffff);
        hemi.groundColor.setHex(0x444444);
        dir.color.setHex(0xffffff);
        dir.position.set(100, 200, 50);
        fill.color.setHex(0x90b0d0);
        fill.position.set(-100, -50, -50);
    } else if (state.lightPreset === 'bright') {
        hemi.color.setHex(0xffffff);
        hemi.groundColor.setHex(0x888888);
        dir.color.setHex(0xffffff);
        dir.position.set(100, 200, 50);
        fill.color.setHex(0xffffff);
        fill.position.set(-100, 100, -50);
    } else if (state.lightPreset === 'neon') {
        hemi.color.setHex(0xff00ff); // Purple/pink neon
        hemi.groundColor.setHex(0x00ffff); // Cyan neon
        dir.color.setHex(0xff00ff);
        dir.position.set(80, 150, 40);
        fill.color.setHex(0x00ffff);
        fill.position.set(-80, -50, -40);
    } else if (state.lightPreset === 'shadowy') {
        hemi.color.setHex(0xffaa66); // Warm dusk
        hemi.groundColor.setHex(0x111122); // Deep night shadows
        dir.color.setHex(0xffffff);
        dir.position.set(200, 150, 100);
        fill.color.setHex(0x000000);
        fill.position.set(0, 0, 0);
    }
    
    // Apply intensity multiplier
    hemi.intensity = state.lightIntensity * 0.6;
    dir.intensity = state.lightIntensity * 1.0;
    fill.intensity = state.lightIntensity * 0.5;
}

function initRightPanelControls() {
    // 1. Right panel tabs switching
    const rightTabs = document.querySelectorAll('.right-tab-btn');
    rightTabs.forEach(tab => {
        tab.onclick = () => {
            rightTabs.forEach(btn => btn.classList.remove('active'));
            tab.classList.add('active');
            
            document.getElementById('right-tab-transform').classList.add('hidden');
            document.getElementById('right-tab-env-mat').classList.add('hidden');
            
            const targetEl = document.getElementById(`right-tab-${tab.dataset.rightTab}`);
            if (targetEl) targetEl.classList.remove('hidden');
        };
    });
    
    // 2. Position offset sliders
    const moveX = document.getElementById('trans-move-x');
    const moveY = document.getElementById('trans-move-y');
    const moveZ = document.getElementById('trans-move-z');
    const lblX = document.getElementById('lbl-move-x');
    const lblY = document.getElementById('lbl-move-y');
    const lblZ = document.getElementById('lbl-move-z');
    
    const updateMove = () => {
        if (!moveX || !moveY || !moveZ) return;
        currentState.viewportState.position.x = parseFloat(moveX.value);
        currentState.viewportState.position.y = parseFloat(moveY.value);
        currentState.viewportState.position.z = parseFloat(moveZ.value);
        
        if (lblX) lblX.innerText = moveX.value;
        if (lblY) lblY.innerText = moveY.value;
        if (lblZ) lblZ.innerText = moveZ.value;
        
        applyObjectTransform();
    };
    
    if (moveX) moveX.oninput = updateMove;
    if (moveY) moveY.oninput = updateMove;
    if (moveZ) moveZ.oninput = updateMove;
    
    // 3. Rotation sliders
    const rotX = document.getElementById('trans-rot-x');
    const rotY = document.getElementById('trans-rot-y');
    const rotZ = document.getElementById('trans-rot-z');
    const lblRotX = document.getElementById('lbl-rot-x');
    const lblRotY = document.getElementById('lbl-rot-y');
    const lblRotZ = document.getElementById('lbl-rot-z');
    
    const updateRot = () => {
        if (!rotX || !rotY || !rotZ) return;
        currentState.viewportState.rotation.x = parseFloat(rotX.value);
        currentState.viewportState.rotation.y = parseFloat(rotY.value);
        currentState.viewportState.rotation.z = parseFloat(rotZ.value);
        
        if (lblRotX) lblRotX.innerText = `${rotX.value}°`;
        if (lblRotY) lblRotY.innerText = `${rotY.value}°`;
        if (lblRotZ) lblRotZ.innerText = `${rotZ.value}°`;
        
        applyObjectTransform();
    };
    
    if (rotX) rotX.oninput = updateRot;
    if (rotY) rotY.oninput = updateRot;
    if (rotZ) rotZ.oninput = updateRot;
    
    // 4. Scale slider
    const scaleRange = document.getElementById('trans-scale');
    const lblScale = document.getElementById('lbl-scale');
    if (scaleRange) {
        scaleRange.oninput = () => {
            currentState.viewportState.scale = parseFloat(scaleRange.value);
            if (lblScale) lblScale.innerText = `${scaleRange.value}x`;
            applyObjectTransform();
        };
    }
    
    // 5. Reset Transform button
    const btnReset = document.getElementById('btn-reset-transform');
    if (btnReset) {
        btnReset.onclick = () => {
            if (moveX) moveX.value = 0;
            if (moveY) moveY.value = 0;
            if (moveZ) moveZ.value = 0;
            if (rotX) rotX.value = 0;
            if (rotY) rotY.value = 0;
            if (rotZ) rotZ.value = 0;
            if (scaleRange) scaleRange.value = 1.0;
            
            updateMove();
            updateRot();
            currentState.viewportState.scale = 1.0;
            if (lblScale) lblScale.innerText = "1.0x";
            applyObjectTransform();
        };
    }
    
    // 6. Material colors swatches
    const swatches = document.querySelectorAll('.color-swatches .swatch');
    swatches.forEach(sw => {
        sw.onclick = () => {
            swatches.forEach(s => s.classList.remove('active'));
            sw.classList.add('active');
            
            currentState.viewportState.materialColor = sw.dataset.color;
            updateMaterialSettings();
        };
    });
    
    const finishSelect = document.getElementById('material-finish');
    if (finishSelect) {
        finishSelect.onchange = () => {
            currentState.viewportState.materialFinish = finishSelect.value;
            updateMaterialSettings();
        };
    }
    
    // 7. Build Plate selector
    const plateSelect = document.getElementById('build-plate-select');
    if (plateSelect) {
        plateSelect.onchange = () => {
            currentState.viewportState.buildPlate = plateSelect.value;
            drawBuildPlate();
        };
    }
    
    // 8. Lighting presets and intensity
    const presetBtns = document.querySelectorAll('.light-presets .light-preset-btn');
    presetBtns.forEach(btn => {
        btn.onclick = () => {
            presetBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            
            currentState.viewportState.lightPreset = btn.dataset.preset;
            updateLightingSettings();
        };
    });
    
    const intensityRange = document.getElementById('light-intensity');
    const lblIntensity = document.getElementById('lbl-light-intensity');
    if (intensityRange) {
        intensityRange.oninput = () => {
            currentState.viewportState.lightIntensity = parseFloat(intensityRange.value);
            if (lblIntensity) lblIntensity.innerText = `${intensityRange.value}x`;
            updateLightingSettings();
        };
    }
}

// --- VIEWPORT WORKSPACE GIZMOS & TOOLBAR ---

function syncViewportStateToUI() {
    currentState.isSyncingFromUI = true;
    const state = currentState.viewportState;

    // 1. Sync right side panel controls
    const moveX = document.getElementById('trans-move-x');
    const moveY = document.getElementById('trans-move-y');
    const moveZ = document.getElementById('trans-move-z');
    const lblX = document.getElementById('lbl-move-x');
    const lblY = document.getElementById('lbl-move-y');
    const lblZ = document.getElementById('lbl-move-z');

    if (moveX) moveX.value = state.position.x;
    if (moveY) moveY.value = state.position.y;
    if (moveZ) moveZ.value = state.position.z;
    if (lblX) lblX.innerText = state.position.x;
    if (lblY) lblY.innerText = state.position.y;
    if (lblZ) lblZ.innerText = state.position.z;

    const rotX = document.getElementById('trans-rot-x');
    const rotY = document.getElementById('trans-rot-y');
    const rotZ = document.getElementById('trans-rot-z');
    const lblRotX = document.getElementById('lbl-rot-x');
    const lblRotY = document.getElementById('lbl-rot-y');
    const lblRotZ = document.getElementById('lbl-rot-z');

    if (rotX) rotX.value = state.rotation.x;
    if (rotY) rotY.value = state.rotation.y;
    if (rotZ) rotZ.value = state.rotation.z;
    if (lblRotX) lblRotX.innerText = `${state.rotation.x}°`;
    if (lblRotY) lblRotY.innerText = `${state.rotation.y}°`;
    if (lblRotZ) lblRotZ.innerText = `${state.rotation.z}°`;

    const scaleRange = document.getElementById('trans-scale');
    const lblScale = document.getElementById('lbl-scale');
    if (scaleRange) scaleRange.value = state.scale;
    if (lblScale) lblScale.innerText = `${state.scale}x`;

    const finishSelect = document.getElementById('material-finish');
    if (finishSelect) finishSelect.value = state.materialFinish;

    const plateSelect = document.getElementById('build-plate-select');
    if (plateSelect) plateSelect.value = state.buildPlate;

    const intensityRange = document.getElementById('light-intensity');
    const lblIntensity = document.getElementById('lbl-light-intensity');
    if (intensityRange) intensityRange.value = state.lightIntensity;
    if (lblIntensity) lblIntensity.innerText = `${state.lightIntensity}x`;

    const presetBtns = document.querySelectorAll('.light-presets .light-preset-btn');
    presetBtns.forEach(btn => {
        btn.classList.toggle('active', btn.dataset.preset === state.lightPreset);
    });

    // 2. Sync mini details floating panel inputs
    const gizInputX = document.getElementById('gizmo-input-x');
    const gizInputY = document.getElementById('gizmo-input-y');
    const gizInputZ = document.getElementById('gizmo-input-z');
    if (gizInputX) gizInputX.value = state.position.x.toFixed(2);
    if (gizInputY) gizInputY.value = state.position.y.toFixed(2);
    if (gizInputZ) gizInputZ.value = state.position.z.toFixed(2);

    const gizInputRotX = document.getElementById('gizmo-input-rot-x');
    const gizInputRotY = document.getElementById('gizmo-input-rot-y');
    const gizInputRotZ = document.getElementById('gizmo-input-rot-z');
    if (gizInputRotX) gizInputRotX.value = state.rotation.x;
    if (gizInputRotY) gizInputRotY.value = state.rotation.y;
    if (gizInputRotZ) gizInputRotZ.value = state.rotation.z;

    const gizInputScale = document.getElementById('gizmo-input-scale');
    if (gizInputScale) gizInputScale.value = state.scale.toFixed(2);

    // 3. Align THREE.TransformControls to the mesh
    if (mainViewport && mainViewport.transformControls && mainViewport.currentMesh) {
        // Skip mutating the 3D mesh if the user is actively dragging it with mouse or gizmos!
        if (!mainViewport.transformControls.dragging && !currentState.isDraggingMesh) {
            applyObjectTransform();
        }
    }

    currentState.isSyncingFromUI = false;
}

function updateSelectionHighlight() {
    if (!mainViewport) return;
    
    // Remove existing selection helper bounding box
    if (mainViewport.selectionHelper) {
        mainViewport.scene.remove(mainViewport.selectionHelper);
        mainViewport.selectionHelper.dispose();
        mainViewport.selectionHelper = null;
    }
    
    const isSelected = currentState.isSelected;
    const mesh = mainViewport.currentMesh;
    const gizmo = mainViewport.transformControls;
    const tool = currentState.activeGizmoTool;
    
    if (isSelected && mesh) {
        // Create bounding box helper with a glowing accent color
        mainViewport.selectionHelper = new THREE.BoxHelper(mesh, 0x6366f1);
        mainViewport.scene.add(mainViewport.selectionHelper);
        
        // Show active transform controls based on selected tool (only for valid Three.js modes)
        if (gizmo && (tool === 'translate' || tool === 'rotate' || tool === 'scale')) {
            gizmo.attach(mesh);
            gizmo.setMode(tool);
        } else if (gizmo) {
            gizmo.detach();
        }
        
        // Show floating card if tool is a transform tool
        const panel = document.getElementById('gizmo-details-panel');
        if (panel && (tool === 'translate' || tool === 'rotate' || tool === 'scale')) {
            panel.classList.remove('hidden');
        } else if (panel) {
            panel.classList.add('hidden');
        }
    } else {
        // Detach gizmo and hide outline box
        if (gizmo) {
            gizmo.detach();
        }
        
        // Hide panel
        const panel = document.getElementById('gizmo-details-panel');
        if (panel) {
            panel.classList.add('hidden');
        }
    }
}

function setGizmoToolMode(tool) {
    currentState.activeGizmoTool = tool;
    
    // Toggle active classes on toolbar buttons
    const btns = document.querySelectorAll('#viewport-toolbar .tool-btn');
    btns.forEach(btn => {
        btn.classList.toggle('active', btn.id === `tool-${tool}`);
    });
    
    // Toggle interactive cursor class for Lay Flat / Place on Face
    const viewportContainer = document.getElementById('viewport');
    if (viewportContainer) {
        viewportContainer.classList.toggle('layflat-active', tool === 'layflat');
    }
    
    // Hide layflat face highlighter helpers
    if (mainViewport && mainViewport.faceHighlighter) {
        mainViewport.faceHighlighter.visible = false;
        mainViewport.faceHighlighterOutline.visible = false;
    }
    
    // Auto-select model if they click any transform tool!
    if (tool !== 'select' && tool !== 'layflat' && tool !== 'reset') {
        currentState.isSelected = true;
    }
    
    updateSelectionHighlight();
    
    const panel = document.getElementById('gizmo-details-panel');
    if (currentState.isSelected && tool !== 'select' && tool !== 'layflat' && tool !== 'reset') {
        // Render and show floating panel
        if (panel) {
            panel.classList.remove('hidden');
            const titleEl = document.getElementById('gizmo-panel-title');
            const bodyEl = document.getElementById('gizmo-panel-body');
            
            let toolTitle = "Transform";
            let bodyHtml = "";
            
            const state = currentState.viewportState;
            
            if (tool === 'translate') {
                toolTitle = "Move Model";
                bodyHtml = `
                    <div class="gizmo-control-row">
                        <button class="gizmo-adjust-btn" data-axis="x" data-dir="minus">-10</button>
                        <span class="axis-badge x">X</span>
                        <input type="number" id="gizmo-input-x" class="gizmo-num-input" value="${state.position.x.toFixed(2)}" step="1">
                        <button class="gizmo-adjust-btn" data-axis="x" data-dir="plus">+10</button>
                    </div>
                    <div class="gizmo-control-row">
                        <button class="gizmo-adjust-btn" data-axis="y" data-dir="minus">-10</button>
                        <span class="axis-badge y">Y</span>
                        <input type="number" id="gizmo-input-y" class="gizmo-num-input" value="${state.position.y.toFixed(2)}" step="1">
                        <button class="gizmo-adjust-btn" data-axis="y" data-dir="plus">+10</button>
                    </div>
                    <div class="gizmo-control-row">
                        <button class="gizmo-adjust-btn" data-axis="z" data-dir="minus">-10</button>
                        <span class="axis-badge z">Z</span>
                        <input type="number" id="gizmo-input-z" class="gizmo-num-input" value="${state.position.z.toFixed(2)}" step="1">
                        <button class="gizmo-adjust-btn" data-axis="z" data-dir="plus">+10</button>
                    </div>
                    <button class="secondary-btn full-width" style="margin-top: 4px;" id="gizmo-btn-reset">Reset</button>
                `;
            } else if (tool === 'rotate') {
                toolTitle = "Rotate Model";
                bodyHtml = `
                    <div class="gizmo-control-row">
                        <button class="gizmo-adjust-btn" data-axis="rot-x" data-val="-45">-45°</button>
                        <span class="axis-badge x">X</span>
                        <input type="number" id="gizmo-input-rot-x" class="gizmo-num-input" value="${state.rotation.x}" step="5">
                        <button class="gizmo-adjust-btn" data-axis="rot-x" data-val="45">+45°</button>
                    </div>
                    <div class="gizmo-control-row">
                        <button class="gizmo-adjust-btn" data-axis="rot-y" data-val="-45">-45°</button>
                        <span class="axis-badge y">Y</span>
                        <input type="number" id="gizmo-input-rot-y" class="gizmo-num-input" value="${state.rotation.y}" step="5">
                        <button class="gizmo-adjust-btn" data-axis="rot-y" data-val="45">+45°</button>
                    </div>
                    <div class="gizmo-control-row">
                        <button class="gizmo-adjust-btn" data-axis="rot-z" data-val="-45">-45°</button>
                        <span class="axis-badge z">Z</span>
                        <input type="number" id="gizmo-input-rot-z" class="gizmo-num-input" value="${state.rotation.z}" step="5">
                        <button class="gizmo-adjust-btn" data-axis="rot-z" data-val="45">+45°</button>
                    </div>
                    <button class="secondary-btn full-width" style="margin-top: 4px;" id="gizmo-btn-reset">Reset</button>
                `;
            } else if (tool === 'scale') {
                toolTitle = "Scale Model";
                bodyHtml = `
                    <div class="gizmo-control-row">
                        <button class="gizmo-adjust-btn" data-axis="scale" data-dir="minus">-0.1</button>
                        <span class="axis-badge scale">S</span>
                        <input type="number" id="gizmo-input-scale" class="gizmo-num-input" value="${state.scale.toFixed(2)}" step="0.05">
                        <button class="gizmo-adjust-btn" data-axis="scale" data-dir="plus">+0.1</button>
                    </div>
                    <div class="gizmo-checkbox-row">
                        <input type="checkbox" id="gizmo-uniform-scale" checked disabled>
                        <label for="gizmo-uniform-scale">Uniform Scaling</label>
                    </div>
                    <button class="secondary-btn full-width" style="margin-top: 4px;" id="gizmo-btn-reset">Reset</button>
                `;
            }
            
            if (titleEl) titleEl.innerText = toolTitle;
            if (bodyEl) {
                bodyEl.innerHTML = bodyHtml;
                bindGizmoInputsHandlers();
            }
        }
    }
}

function bindGizmoInputsHandlers() {
    const state = currentState.viewportState;
    
    // Position inputs
    const gizInputX = document.getElementById('gizmo-input-x');
    const gizInputY = document.getElementById('gizmo-input-y');
    const gizInputZ = document.getElementById('gizmo-input-z');
    
    const updateFromGizPos = () => {
        if (!gizInputX || !gizInputY || !gizInputZ) return;
        state.position.x = parseFloat(gizInputX.value) || 0;
        state.position.y = parseFloat(gizInputY.value) || 0;
        state.position.z = parseFloat(gizInputZ.value) || 0;
        syncViewportStateToUI();
    };
    
    if (gizInputX) gizInputX.onchange = updateFromGizPos;
    if (gizInputY) gizInputY.onchange = updateFromGizPos;
    if (gizInputZ) gizInputZ.onchange = updateFromGizPos;
    
    // Rotation inputs
    const gizInputRotX = document.getElementById('gizmo-input-rot-x');
    const gizInputRotY = document.getElementById('gizmo-input-rot-y');
    const gizInputRotZ = document.getElementById('gizmo-input-rot-z');
    
    const updateFromGizRot = () => {
        if (!gizInputRotX || !gizInputRotY || !gizInputRotZ) return;
        state.rotation.x = parseInt(gizInputRotX.value) || 0;
        state.rotation.y = parseInt(gizInputRotY.value) || 0;
        state.rotation.z = parseInt(gizInputRotZ.value) || 0;
        syncViewportStateToUI();
    };
    
    if (gizInputRotX) gizInputRotX.onchange = updateFromGizRot;
    if (gizInputRotY) gizInputRotY.onchange = updateFromGizRot;
    if (gizInputRotZ) gizInputRotZ.onchange = updateFromGizRot;
    
    // Scale input
    const gizInputScale = document.getElementById('gizmo-input-scale');
    if (gizInputScale) {
        gizInputScale.onchange = () => {
            state.scale = parseFloat(gizInputScale.value) || 1.0;
            syncViewportStateToUI();
        };
    }
    
    // Adjust plus/minus/angle buttons
    const adjustBtns = document.querySelectorAll('.gizmo-adjust-btn');
    adjustBtns.forEach(btn => {
        btn.onclick = () => {
            const axis = btn.dataset.axis;
            
            if (axis === 'x') {
                const diff = btn.dataset.dir === 'plus' ? 10 : -10;
                state.position.x += diff;
            } else if (axis === 'y') {
                const diff = btn.dataset.dir === 'plus' ? 10 : -10;
                state.position.y += diff;
            } else if (axis === 'z') {
                const diff = btn.dataset.dir === 'plus' ? 10 : -10;
                state.position.z += diff;
            } else if (axis === 'rot-x') {
                const angle = parseInt(btn.dataset.val);
                state.rotation.x = (state.rotation.x + angle) % 360;
            } else if (axis === 'rot-y') {
                const angle = parseInt(btn.dataset.val);
                state.rotation.y = (state.rotation.y + angle) % 360;
            } else if (axis === 'rot-z') {
                const angle = parseInt(btn.dataset.val);
                state.rotation.z = (state.rotation.z + angle) % 360;
            } else if (axis === 'scale') {
                const diff = btn.dataset.dir === 'plus' ? 0.1 : -0.1;
                state.scale = Math.max(0.1, state.scale + diff);
            }
            
            syncViewportStateToUI();
        };
    });
    
    // Inner reset button
    const innerReset = document.getElementById('gizmo-btn-reset');
    if (innerReset) {
        innerReset.onclick = () => {
            const resetBtn = document.getElementById('btn-reset-transform');
            if (resetBtn) resetBtn.click();
        };
    }
}

// --- THUMBNAIL MANAGEMENT SYSTEM ---

function generateMeshThumbnail(template) {
    if (!template.localPreview) return null;
    
    try {
        const canvas = document.createElement('canvas');
        canvas.width = 250;
        canvas.height = 180;
        
        const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
        renderer.setSize(250, 180);
        renderer.setClearColor(0x0a0f1d, 1.0); // Slate-950 dark background for luxury contrast
        
        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(45, 250 / 180, 0.1, 1000);
        
        // Premium CAD lighting setup
        const hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 1.8);
        scene.add(hemiLight);
        
        const dirLight = new THREE.DirectionalLight(0xffffff, 2.5);
        dirLight.position.set(100, 150, 50);
        scene.add(dirLight);
        
        const fillLight = new THREE.DirectionalLight(0x818cf8, 1.0); // Subtle blue fill light
        fillLight.position.set(-100, -50, -50);
        scene.add(fillLight);
        
        // Add subtle background grid for standard CAD layout look
        const grid = new THREE.GridHelper(120, 24, 0x4f46e5, 0x1e293b);
        grid.position.y = -0.1;
        grid.material.opacity = 0.45;
        grid.material.transparent = true;
        scene.add(grid);
        
        // Collect default parameters
        const defaultParams = {};
        if (template.ui_parameters) {
            template.ui_parameters.forEach(p => {
                defaultParams[p.key] = p.default;
            });
        }
        
        const dummyMat = new THREE.MeshStandardMaterial({ color: 0x6366f1 });
        const geom = template.localPreview(defaultParams, dummyMat);
        if (!geom) {
            dummyMat.dispose();
            renderer.dispose();
            return null;
        }
        
        // Clone and shift geometry locally so it's perfectly centered on the thumbnail grid
        geom.computeBoundingBox();
        const center = new THREE.Vector3();
        geom.boundingBox.getCenter(center);
        const minY = geom.boundingBox.min.y;
        
        const tempGeom = geom.clone();
        tempGeom.translate(-center.x, -minY, -center.z);
        
        const material = new THREE.MeshStandardMaterial({
            color: 0x4f46e5, // Deep Indigo Filament color
            roughness: 0.4,
            metalness: 0.1,
            flatShading: true // Gives a lovely structural faceted CAD mesh look
        });
        
        const mesh = new THREE.Mesh(tempGeom, material);
        scene.add(mesh);
        
        // Camera auto-positioning based on geometry dimensions
        tempGeom.computeBoundingSphere();
        const radius = tempGeom.boundingSphere.radius || 40;
        
        camera.position.set(radius * 1.5, radius * 1.4, radius * 1.5);
        camera.lookAt(0, radius * 0.4, 0);
        
        renderer.render(scene, camera);
        const dataUrl = renderer.domElement.toDataURL('image/png');
        
        // Free resources immediately
        tempGeom.dispose();
        material.dispose();
        dummyMat.dispose();
        renderer.dispose();
        
        return dataUrl;
    } catch (e) {
        console.warn('[ParaForm] Local thumbnail generation failed:', e);
        return null;
    }
}

function loadTemplateThumbnails() {
    const list = currentState.templates || DEFAULT_TEMPLATES;
    list.forEach(t => {
        // 1. Check local storage first (user-customized dynamic capture)
        const customThumb = localStorage.getItem(`thumbnail_${t.id}`);
        if (customThumb) {
            t.thumbnail_url = customThumb;
        } else {
            // 2. Generate on-the-fly from actual local 3D model geometry!
            const generated = generateMeshThumbnail(t);
            if (generated) {
                t.thumbnail_url = generated;
                localStorage.setItem(`thumbnail_${t.id}`, generated);
            } else {
                // Return empty string to trigger modern CSS grid placeholder
                t.thumbnail_url = '';
            }
        }
    });
}

function generateActiveThumbnail() {
    if (!mainViewport || !mainViewport.renderer || !currentState.template) return;
    
    try {
        const id = currentState.template.id;
        
        // Take canvas capture of current model in editor
        const dataUrl = mainViewport.renderer.domElement.toDataURL('image/png');
        if (!dataUrl || dataUrl === 'data:,') return; // Skip empty capture
        
        // Save to localStorage
        localStorage.setItem(`thumbnail_${id}`, dataUrl);
        
        // Update template local state in memory
        currentState.template.thumbnail_url = dataUrl;
        
        // Update in DEFAULT_TEMPLATES
        const defaultT = DEFAULT_TEMPLATES.find(t => t.id === id);
        if (defaultT) defaultT.thumbnail_url = dataUrl;
        
        // Update templates in currentState
        if (currentState.templates) {
            const currentT = currentState.templates.find(t => t.id === id);
            if (currentT) currentT.thumbnail_url = dataUrl;
        }
    } catch (e) {
        console.warn('[ParaForm] Failed to generate active thumbnail:', e);
    }
}

// --- UNDO / REDO PARAMETRIC HISTORY ---

function saveHistoryState() {
    if (isUndoingRedoing) return;
    
    if (currentState.template) {
        currentState.source = currentState.template.source;
    }
    
    const snapshot = JSON.stringify({
        params: currentState.params,
        viewportState: currentState.viewportState,
        source: currentState.source
    });
    
    // Only push if different from the last state in the undoHistory
    if (undoHistory.length === 0 || undoHistory[undoHistory.length - 1] !== snapshot) {
        undoHistory.push(snapshot);
        if (undoHistory.length > 50) undoHistory.shift(); // Keep last 50 steps
        redoHistory = []; // Clear redo stack on new action
        updateUndoRedoButtonsState();
    }
}

function updateUndoRedoButtonsState() {
    const btnUndo = document.getElementById('tool-undo');
    const btnRedo = document.getElementById('tool-redo');
    if (btnUndo) {
        btnUndo.disabled = undoHistory.length <= 1;
        btnUndo.classList.toggle('disabled', undoHistory.length <= 1);
    }
    if (btnRedo) {
        btnRedo.disabled = redoHistory.length === 0;
        btnRedo.classList.toggle('disabled', redoHistory.length === 0);
    }
}

function undoAction() {
    if (undoHistory.length <= 1) return;
    
    isUndoingRedoing = true;
    const currentStateSnapshot = undoHistory.pop();
    redoHistory.push(currentStateSnapshot);
    
    const targetStateSnapshot = undoHistory[undoHistory.length - 1];
    restoreStateFromSnapshot(targetStateSnapshot);
    isUndoingRedoing = false;
    
    updateUndoRedoButtonsState();
}

function redoAction() {
    if (redoHistory.length === 0) return;
    
    isUndoingRedoing = true;
    const nextStateSnapshot = redoHistory.pop();
    undoHistory.push(nextStateSnapshot);
    
    restoreStateFromSnapshot(nextStateSnapshot);
    isUndoingRedoing = false;
    
    updateUndoRedoButtonsState();
}

function restoreStateFromSnapshot(snapshotString) {
    const snapshot = JSON.parse(snapshotString);
    
    // Deep copy parameter states
    currentState.params = JSON.parse(JSON.stringify(snapshot.params));
    currentState.viewportState = JSON.parse(JSON.stringify(snapshot.viewportState));
    if (snapshot.source !== undefined) {
        currentState.source = snapshot.source;
        if (currentState.template) {
            currentState.template.source = snapshot.source;
            const codeEditor = document.getElementById('code-editor');
            if (codeEditor) {
                codeEditor.value = snapshot.source;
            }
            currentState.template.ui_parameters = parseParametersFromSource(snapshot.source);
        }
    }
    
    // Re-render parameters panel
    renderParameters();
    
    // Sync viewport state to UI
    syncViewportStateToUI();
    
    // Recalculate mesh 3D bounds and properties
    applyObjectTransform();
    updateMaterialSettings();
    
    // Trigger generation (instant CSG preview if available)
    triggerGeneration(true);
}

function initViewportToolbar() {
    // 1. Tool selection buttons click
    const tools = ['select', 'translate', 'rotate', 'scale'];
    tools.forEach(t => {
        const btn = document.getElementById(`tool-${t}`);
        if (btn) {
            btn.onclick = () => setGizmoToolMode(t);
        }
    });
    
    // 2. Lay flat on bed (Place on Face tool)
    const layflatBtn = document.getElementById('tool-layflat');
    if (layflatBtn) {
        layflatBtn.onclick = () => {
            setGizmoToolMode('layflat');
        };
    }
    
    // 3. Reset transform
    const resetBtn = document.getElementById('tool-reset');
    if (resetBtn) {
        resetBtn.onclick = () => {
            const mainReset = document.getElementById('btn-reset-transform');
            if (mainReset) mainReset.click();
        };
    }
    
    // 5. Undo and Redo actions
    const undoBtn = document.getElementById('tool-undo');
    if (undoBtn) {
        undoBtn.onclick = () => undoAction();
    }
    const redoBtn = document.getElementById('tool-redo');
    if (redoBtn) {
        redoBtn.onclick = () => redoAction();
    }
    updateUndoRedoButtonsState();
    
    // 4. Close mini details floating panel
    const closePanelBtn = document.getElementById('gizmo-panel-close');
    if (closePanelBtn) {
        closePanelBtn.onclick = () => {
            setGizmoToolMode('select');
        };
    }
}

// Event Handlers
// ── Export Format Catalog ────────────────────────────────────────────────────
// Add new formats here — the modal renders them automatically.
const EXPORT_FORMATS = [
    {
        id: 'stl',
        label: 'STL',
        ext: 'stl',
        mime: 'model/stl',
        name: 'Stereolithography',
        desc: 'Universal slicer format. Compatible with Bambu, Prusa, Ender, and every major slicer.',
        tags: ['3D Printing', 'Manifold'],
        engine: 'worker',   // recompiles via OpenSCAD WASM at full quality
    },
    {
        id: '3mf',
        label: '3MF',
        ext: '3mf',
        mime: 'model/3mf',
        name: '3D Manufacturing Format',
        desc: 'Modern format with rich metadata. Native to Bambu Studio and Orca Slicer.',
        tags: ['3D Printing', 'Modern'],
        engine: 'worker',
    },
    {
        id: 'obj',
        label: 'OBJ',
        ext: 'obj',
        mime: 'model/obj',
        name: 'Wavefront Object',
        desc: 'Widely supported in Blender, Maya, Cinema 4D and general 3D applications.',
        tags: ['3D Modeling', 'Instant'],
        engine: 'threejs-obj',   // exported from current Three.js scene
    },
    {
        id: 'gltf',
        label: 'glTF',
        ext: 'gltf',
        mime: 'model/gltf+json',
        name: 'GL Transmission Format',
        desc: 'Web-standard format for AR, VR, and real-time 3D previews.',
        tags: ['Web / AR', 'Instant'],
        engine: 'threejs-gltf',
    },
];

// ── Download Helper ──────────────────────────────────────────────────────────
function triggerDownload(data, filename, mimeType) {
    const blob = new Blob([data], { type: mimeType });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// ── Export Modal ─────────────────────────────────────────────────────────────
function openExportModal() {
    if (!currentState.template) return;

    const modal    = document.getElementById('export-modal');
    const list     = document.getElementById('export-format-list');
    const closeBtn = document.getElementById('export-modal-close');
    const subtitle = document.getElementById('export-modal-subtitle');

    subtitle.textContent = currentState.projectTitle || currentState.template.title || 'Untitled';

    // Build format rows
    list.innerHTML = '';
    EXPORT_FORMATS.forEach(fmt => {
        const row = document.createElement('button');
        row.className = 'export-format-row';
        row.dataset.fmt = fmt.id;
        row.innerHTML = `
            <div class="export-format-badge">
                <span class="fmt-label">${fmt.label}</span>
                <span class="fmt-ext">.${fmt.ext}</span>
            </div>
            <div class="export-format-info">
                <span class="fmt-name">${fmt.name}</span>
                <span class="fmt-desc">${fmt.desc}</span>
                <div class="export-format-tags">
                    ${fmt.tags.map(t => `<span class="export-format-tag">${t}</span>`).join('')}
                </div>
            </div>
            <div class="export-format-action" aria-hidden="true">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                    <polyline points="7 10 12 15 17 10"/>
                    <line x1="12" y1="15" x2="12" y2="3"/>
                </svg>
            </div>`;

        row.onclick = () => runExport(fmt, row);
        list.appendChild(row);
    });

    modal.classList.remove('hidden');
    closeBtn.onclick = () => modal.classList.add('hidden');
    modal.onclick = (e) => { if (e.target === modal) modal.classList.add('hidden'); };
}

// ── Run a single format export ───────────────────────────────────────────────
function runExport(fmt, rowEl) {
    const filename = `${(currentState.projectTitle || 'paraform_model').replace(/\s+/g, '_')}.${fmt.ext}`;

    // Mark row as busy
    rowEl.classList.add('exporting');
    rowEl.querySelector('.export-format-action').innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/>
            <line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/>
            <line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/>
            <line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/>
        </svg>`;

    const markDone = () => {
        rowEl.classList.remove('exporting');
        rowEl.classList.add('done');
        rowEl.querySelector('.export-format-action').innerHTML = `
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <polyline points="20 6 9 17 4 12"/>
            </svg>`;
    };

    const markError = (msg) => {
        rowEl.classList.remove('exporting');
        console.error('[Export] Failed:', msg);
        alert(`Export failed: ${msg}`);
    };

    if (fmt.engine === 'worker') {
        // Recompile at full quality via OpenSCAD WASM
        const declarations = (currentState.template.ui_parameters || [])
            .map(p => {
                const val = currentState.params[p.key] ?? p.default;
                if (p.type === 'boolean') {
                    return `${p.key} = ${val ? 1 : 0};`;
                } else if (p.type === 'enum' && p.key === 'FOR_PRINT') {
                    return `FOR_PRINT = ${val === 'PrintPlate' ? 1 : 0};`;
                } else if (typeof val === 'string') {
                    return `${p.key} = "${val}";`;
                } else {
                    return `${p.key} = ${val ?? 0};`;
                }
            }).join('\n');

        const source = `${currentState.template.source}
// ParaForm Export — full quality
${declarations}
$fn = 64;
$preview = false;`;

        pool.requestRender({
            jobId: Date.now(),
            sourceCode: source,
            format: fmt.ext,
            isFinal: true,
            context: 'export'
        }, (data) => {
            if (data.ok) {
                triggerDownload(data.buffer, filename, fmt.mime);
                markDone();
            } else {
                markError(data.error || 'Unknown error');
                rowEl.classList.remove('exporting');
            }
        });

    } else if (fmt.engine === 'threejs-obj') {
        if (!mainViewport?.mesh) return markError('No model loaded in viewport.');
        try {
            const exporter = new OBJExporter();
            const obj = exporter.parse(mainViewport.mesh);
            triggerDownload(obj, filename, fmt.mime);
            markDone();
        } catch (e) { markError(e.message); }

    } else if (fmt.engine === 'threejs-gltf') {
        if (!mainViewport?.mesh) return markError('No model loaded in viewport.');
        const exporter = new GLTFExporter();
        exporter.parse(mainViewport.mesh, (gltf) => {
            const json = JSON.stringify(gltf, null, 2);
            triggerDownload(json, filename, fmt.mime);
            markDone();
        }, (err) => markError(err.message));
    }
}


document.getElementById('view-reset').onclick = () => mainViewport?.controls.reset();
document.getElementById('view-wireframe').onclick = () => {
    if (mainViewport) mainViewport.material.wireframe = !mainViewport.material.wireframe;
};
let uploadViewport = null;
let currentUploadSource = '';

function initManagePage() {
    if (uploadViewport) return;
    uploadViewport = createRenderer('upload-viewport');
    
    const dropZone = document.getElementById('drop-zone');
    const fileInput = document.getElementById('scad-file-input');
    
    dropZone.onclick = () => fileInput.click();
    
    dropZone.ondragover = (e) => {
        e.preventDefault();
        dropZone.classList.add('active');
    };
    
    dropZone.ondragleave = () => dropZone.classList.remove('active');
    
    dropZone.ondrop = (e) => {
        e.preventDefault();
        dropZone.classList.remove('active');
        const file = e.dataTransfer.files[0];
        if (file) handleUploadFile(file);
    };
    
    fileInput.onchange = (e) => {
        const file = e.target.files[0];
        if (file) handleUploadFile(file);
    };

    document.getElementById('extract-params-btn').onclick = extractParameters;
    document.getElementById('publish-btn').onclick = publishTemplate;
}

function handleUploadFile(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
        currentUploadSource = e.target.result;
        document.getElementById('preview-status').innerText = file.name;
        document.getElementById('preview-status').className = 'badge success';
        document.getElementById('upload-title').value = file.name.replace('.scad', '');
        
        // Render preview
        triggerUploadPreview();
    };
    reader.readAsText(file);
}

function triggerUploadPreview() {
    if (!currentUploadSource || !uploadViewport) return;
    
    const startTime = performance.now();
    pool.requestRender({ 
        jobId: 8888, 
        sourceCode: currentUploadSource, 
        format: 'stl',
        isFinal: true,
        context: 'upload'
    }, (data) => {
        if (data.jobId === 8888) {
            if (data.ok) {
                updateUploadViewport(data.buffer);
                document.getElementById('upload-render-time').innerText = `${Math.round(performance.now() - startTime)}ms`;
            } else {
                alert('Preview Error: ' + data.error);
            }
        }
    });
}


function updateUploadViewport(data) {
    const loader = new STLLoader();
    const buffer = data.buffer ? data.buffer : data;
    const geometry = loader.parse(buffer);
    geometry.computeVertexNormals();

    if (uploadViewport.currentMesh) uploadViewport.scene.remove(uploadViewport.currentMesh);
    uploadViewport.currentMesh = new THREE.Mesh(geometry, uploadViewport.material);
    
    geometry.computeBoundingBox();
    const center = new THREE.Vector3();
    geometry.boundingBox.getCenter(center);
    uploadViewport.currentMesh.position.x = -center.x;
    uploadViewport.currentMesh.position.z = -center.z;
    uploadViewport.currentMesh.position.y = -geometry.boundingBox.min.y;
    
    uploadViewport.scene.add(uploadViewport.currentMesh);
}

function extractParameters() {
    if (!currentUploadSource) return alert('Load a .scad file first');
    const params = parseParametersFromSource(currentUploadSource);
    console.log('Extracted Params:', params);
    alert(`Found ${params.length} parameters. Check console for details.`);
    currentState.lastExtractedParams = params;
}

function parseParametersFromSource(source) {
    // Understands both ParaForm syntax and standard OpenSCAD Customizer syntax:
    //
    //   key = value;                          → inferred type, auto label + range
    //   key = value;  // Plain comment        → comment used as label
    //   key = value;  // [type, Label, min, max, step]  → full ParaForm config
    //   /* [Group Name] */                    → section header (ignored)
    //   /* [Hidden] */                        → all vars until next section are skipped

    const lines = source.split('\n');
    const params = [];
    let inHiddenSection = false;

    for (const line of lines) {
        const trimmed = line.trim();

        // ── Section headers ────────────────────────────────────────────────
        const sectionMatch = trimmed.match(/^\/\*\s*\[(.+?)\]\s*\*\//);
        if (sectionMatch) {
            inHiddenSection = /^hidden$/i.test(sectionMatch[1].trim());
            continue;
        }

        // Skip everything in a [Hidden] section
        if (inHiddenSection) continue;

        // ── Parameter line ─────────────────────────────────────────────────
        // Matches:  key = value;          (optional trailing // comment)
        const match = line.match(/^(\w+)\s*=\s*([^;]+);(?:\s*\/\/\s*(.*))?/);
        if (!match) continue;

        const [, key, rawVal, comment] = match;

        // Skip OpenSCAD special variables ($fn, $fs, $fa, $preview …)
        if (key.startsWith('$')) continue;

        const defaultVal = parseSCADValue(rawVal.trim());

        const param = {
            key,
            default: defaultVal,
            label: scadKeyToLabel(key),   // snake_case → "Title Case"
            type: 'number',
        };

        // ── Decode trailing comment ────────────────────────────────────────
        if (comment) {
            const configMatch = comment.trim().match(/^\[([^\]]*)\]$/);
            if (configMatch) {
                // ParaForm format: [type, Label, min, max, step]
                const parts = configMatch[1].split(',').map(s => s.trim());
                param.type  = parts[0] || 'number';
                if (parts[1]) param.label = parts[1];
                if (param.type === 'number' || param.type === 'integer') {
                    if (parts[2]) param.min  = parseFloat(parts[2]);
                    if (parts[3]) param.max  = parseFloat(parts[3]);
                    if (parts[4]) param.step = parseFloat(parts[4]);
                }
            } else {
                // Plain comment → use as the human-readable label
                const clean = comment.trim();
                if (clean) param.label = clean.replace(/^\w/, c => c.toUpperCase());
            }
        }

        // ── Infer type from default value ──────────────────────────────────
        if (param.type === 'number') {
            if (typeof defaultVal === 'boolean') {
                param.type = 'boolean';
            } else if (typeof defaultVal === 'string') {
                param.type = 'string';
            } else {
                const n = Number(defaultVal);
                if (!isNaN(n) && Number.isInteger(n)) param.type = 'integer';
            }
        }

        // ── Infer min / max / step if not already set ──────────────────────
        if ((param.type === 'number' || param.type === 'integer') &&
            param.min === undefined && param.max === undefined) {
            const v = Number(defaultVal);
            if (!isNaN(v)) {
                param.min  = 0;
                // Give a generous ceiling: 3× default, at least 20
                param.max  = Math.max(Math.ceil(v * 3 / 5) * 5, 20);
                param.step = (param.type === 'integer' || Number.isInteger(v)) ? 1 : 0.1;
            }
        }

        params.push(param);
    }

    return params;
}

/** Convert snake_case / camelCase variable names to "Title Case" labels */
function scadKeyToLabel(key) {
    return key
        .replace(/_/g, ' ')                        // underscores → spaces
        .replace(/([a-z])([A-Z])/g, '$1 $2')       // camelCase → spaces
        .replace(/\b\w/g, c => c.toUpperCase())    // capitalise each word
        .trim();
}

function parseSCADValue(val) {
    val = val.trim();
    if (val === 'true') return true;
    if (val === 'false') return false;
    if (val.startsWith('"')) return val.replace(/"/g, '');
    if (!isNaN(parseFloat(val))) return parseFloat(val);
    return val;
}

async function publishTemplate() {
    const title = document.getElementById('upload-title').value;
    const desc = document.getElementById('upload-desc').value;
    const category = document.getElementById('upload-category').value;
    const tags = document.getElementById('upload-tags').value.split(',').map(t => t.trim());
    const thumb = document.getElementById('upload-thumb').value;

    if (!title || !currentUploadSource) return alert('Title and SCAD file are required');

    const templateData = {
        title,
        slug: title.toLowerCase().replace(/\s+/g, '-'),
        is_published: true,
        category,
        tags,
        thumbnail_url: thumb,
        config_payload: {
            description: desc,
            ui_parameters: currentState.lastExtractedParams || [],
            source: currentUploadSource
        }
    };

    console.log('Publishing Template:', templateData);
    
    try {
        const { data, error } = await supabase.from('base_templates').insert([templateData]);
        if (error) throw error;
        alert('Template Published Successfully!');
        window.location.hash = '#/explore';
    } catch (e) {
        console.error('Publish Failed:', e);
        // Fallback for local testing
        currentState.templates.push({ id: templateData.slug, ...templateData, ...templateData.config_payload });
        alert('Saved locally (DB error/not configured).');
        window.location.hash = '#/explore';
    }
}

window.addEventListener('resize', () => {
    if (mainViewport) {
        mainViewport.camera.aspect = mainViewport.container.clientWidth / mainViewport.container.clientHeight;
        mainViewport.camera.updateProjectionMatrix();
        mainViewport.renderer.setSize(mainViewport.container.clientWidth, mainViewport.container.clientHeight);
    }
    if (heroViewport) {
        heroViewport.camera.aspect = heroViewport.container.clientWidth / heroViewport.container.clientHeight;
        heroViewport.camera.updateProjectionMatrix();
        heroViewport.renderer.setSize(heroViewport.container.clientWidth, heroViewport.container.clientHeight);
    }
    if (uploadViewport) {
        uploadViewport.camera.aspect = uploadViewport.container.clientWidth / uploadViewport.container.clientHeight;
        uploadViewport.camera.updateProjectionMatrix();
        uploadViewport.renderer.setSize(uploadViewport.container.clientWidth, uploadViewport.container.clientHeight);
    }
});

window.addEventListener('keydown', (e) => {
    const isEditingText = e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA';
    
    if (e.key === 'Control') {
        currentState.isCtrlPressed = true;
        updateRotationSnap();
    }
    
    // Ctrl + Z for Undo
    if (e.ctrlKey && e.key.toLowerCase() === 'z' && !isEditingText) {
        e.preventDefault();
        undoAction();
    }
    
    // Ctrl + Y for Redo
    if (e.ctrlKey && e.key.toLowerCase() === 'y' && !isEditingText) {
        e.preventDefault();
        redoAction();
    }
});

window.addEventListener('keyup', (e) => {
    if (e.key === 'Control') {
        currentState.isCtrlPressed = false;
        updateRotationSnap();
    }
});

window.addEventListener('blur', () => {
    currentState.isCtrlPressed = false;
    updateRotationSnap();
});

function updateRotationSnap() {
    if (mainViewport && mainViewport.transformControls) {
        const snapDeg = currentState.isCtrlPressed ? 1 : 5;
        mainViewport.transformControls.rotationSnap = THREE.MathUtils.degToRad(snapDeg);
    }
}

function onViewChange(hash) {
    if (hash === '/explore') {
        renderTemplateGrid();
        initModal();
    } else if (hash === '/create') {
        if (!mainViewport) mainViewport = createRenderer('viewport');
        if (!currentState.template) {
            showCreateChoice();
        } else {
            showConfigurator();
        }
    } else if (hash === '/manage') {
        initManagePage();
    } else if (hash === '/') {
        initHeroPreview();
    }
}

function updateUser(user) {
    currentState.user = user;
    
    // Dispatch hashchange to force global handleRoute() to redraw the correct context-based navbar instantly
    window.dispatchEvent(new HashChangeEvent('hashchange'));

    // Hide unfinished auth route
    if (window.location.hash === '#/auth') {
        window.location.hash = '#/';
    }
}

// Start
globalAnimate();

function globalAnimate() {
    requestAnimationFrame(globalAnimate);
    if (currentState.view === '/create' && mainViewport) {
        mainViewport.controls.update();
        
        // Ensure TransformControls always render on top of the solid model (like Bambu Studio)
        if (mainViewport.transformControls) {
            mainViewport.transformControls.getHelper().traverse((child) => {
                // Surgically hide the outer white circle (E) and trackball free rotation (XYZE)
                if (child.name === 'E' || child.name === 'XYZE') {
                    child.visible = false;
                }
                
                if (child.material) {
                    const materials = Array.isArray(child.material) ? child.material : [child.material];
                    materials.forEach(mat => {
                        mat.depthTest = false;
                        mat.depthWrite = false;
                    });
                }
            });
        }
        
        mainViewport.renderer.render(mainViewport.scene, mainViewport.camera);
    }
    if (currentState.view === '/manage' && uploadViewport) {
        uploadViewport.controls.update();
        uploadViewport.renderer.render(uploadViewport.scene, uploadViewport.camera);
    }
}
// --- APP INITIALIZATION & LOADER ---
let readyWorkers = 0;
function updateLoader(progress, text) {
    const bar = document.getElementById('loader-progress');
    const label = document.getElementById('loader-text');
    if (bar) bar.style.width = `${progress}%`;
    if (label) label.innerText = text;
}

window.addEventListener('worker-ready', () => {
    readyWorkers++;
    if (readyWorkers === 1) updateLoader(40, 'Loading Templates...');
    if (readyWorkers === pool.maxWorkers) {
        updateLoader(60, 'Optimizing Environment...');
    }
});

async function startApp() {
    const startTime = Date.now();
    
    // 1. Start Workers immediately
    updateLoader(10, 'Initializing CAD Workers...');
    for (let i = 0; i < pool.maxWorkers; i++) {
        pool._createWorker();
    }

    // 2. Init App Logic (Supabase, Routing)
    await initApp();
    
    // 3. Init AI Assistant Controllers
    initAIAssistant();
    
    // 4. Complete Loading (No pre-render to save memory)
    updateLoader(100, 'Ready.');
    const elapsed = Date.now() - startTime;
    const wait = Math.max(0, 1500 - elapsed);
    
    setTimeout(() => {
        document.getElementById('app-loader').classList.add('fade-out');
    }, wait);
}

// Start the sequence
startApp();

// ── Universal AI Assistant Controllers & Pipeline ────────────────

// Helper sleep
const sleep = ms => new Promise(r => setTimeout(r, ms));

let aiChatHistory = [];

function loadChatHistory() {
    try {
        const stored = localStorage.getItem('paraform_ai_chat_history');
        if (stored) {
            aiChatHistory = JSON.parse(stored);
        }
    } catch (e) {
        console.error('Failed to load chat history', e);
    }
}

function saveChatHistory() {
    localStorage.setItem('paraform_ai_chat_history', JSON.stringify(aiChatHistory));
}

function renderChatHistory() {
    const container = document.getElementById('ai-chat-history');
    if (!container) return;
    
    container.innerHTML = '';
    
    if (aiChatHistory.length === 0) {
        container.innerHTML = `
            <div class="chat-bubble system">
                <div class="bubble-icon">✨</div>
                <div class="bubble-text">Hi! I'm your ParaForm AI Assistant. Describe what you'd like to build or modify.</div>
            </div>
        `;
        return;
    }
    
    aiChatHistory.forEach((msg, msgIndex) => {
        const bubble = document.createElement('div');
        bubble.className = `chat-bubble ${msg.role === 'user' ? 'user' : (msg.role === 'system' ? 'system' : 'assistant')}`;
        
        let formattedText = msg.content;
        
        if (msg.role === 'assistant') {
            // Simple markdown-ish bolding for changes
            formattedText = formattedText.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
        }
        
        bubble.innerHTML = `<div class="bubble-text">${formattedText}</div>`;
        
        if (msg.role === 'assistant' && msg.previousState) {
            const undoBtn = document.createElement('button');
            undoBtn.className = 'chat-undo-btn glass';
            undoBtn.style.cssText = 'display: inline-flex; align-items: center; justify-content: center; gap: 4px; margin-top: 8px; padding: 4px 10px; border-radius: var(--radius); font-size: 11px; font-family: var(--font-main); color: var(--text-secondary); cursor: pointer; border: 1px solid var(--border-color); background: rgba(255,255,255,0.03); transition: all 150ms ease;';
            undoBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="transform: scaleX(-1);"><path d="M3 7v6h6M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/></svg> Undo Edit`;
            undoBtn.onclick = () => window.revertToMessageState(msgIndex);
            
            // Hover effect
            undoBtn.onmouseenter = () => {
                undoBtn.style.color = 'var(--text-primary)';
                undoBtn.style.borderColor = 'var(--accent-bright)';
                undoBtn.style.background = 'var(--accent-subtle)';
            };
            undoBtn.onmouseleave = () => {
                undoBtn.style.color = 'var(--text-secondary)';
                undoBtn.style.borderColor = 'var(--border-color)';
                undoBtn.style.background = 'rgba(255,255,255,0.03)';
            };
            bubble.appendChild(undoBtn);
        }
        
        container.appendChild(bubble);
    });
    
    container.scrollTop = container.scrollHeight;
}

function appendChatMessage(role, content, previousState = null) {
    aiChatHistory.push({ role, content, previousState });
    saveChatHistory();
    renderChatHistory();
}

window.revertToMessageState = function(index) {
    const msg = aiChatHistory[index];
    if (!msg || !msg.previousState) return;
    
    const state = msg.previousState;
    if (!currentState.template) return;
    
    // Restore source code
    currentState.template.source = state.source;
    currentState.source = state.source;
    
    // Disable/Delete localPreview if it existed to ensure correct Worker re-rendering
    delete currentState.template.localPreview;
    
    const editor = document.getElementById('code-editor');
    if (editor) editor.value = state.source;
    
    // Restore parameters
    currentState.template.ui_parameters = JSON.parse(JSON.stringify(state.ui_parameters));
    currentState.params = JSON.parse(JSON.stringify(state.params));
    
    // Re-render parameters and trigger compilation
    renderParameters();
    triggerGeneration(true);
    
    // Append a friendly system message to the chat
    appendChatMessage('system', `Reverted changes to state before prompt: "${aiChatHistory[index - 1]?.content || 'previous edit'}"`);
};

function initAIAssistant() {
    const generateBtn = document.getElementById('ai-generate-btn');
    const promptInput = document.getElementById('ai-prompt-input');
    
    if (!generateBtn || !promptInput) return;
    
    loadChatHistory();
    renderChatHistory();
    
    // Bind "New Conversation" clear button
    const clearBtn = document.getElementById('ai-clear-chat-btn');
    if (clearBtn) {
        clearBtn.onclick = () => {
            if (aiChatHistory.length === 0) return;
            aiChatHistory = [];
            saveChatHistory();
            renderChatHistory();
        };
    }
    
    // Bind quick action chips
    const chips = document.querySelectorAll('.ai-chip');
    chips.forEach(chip => {
        chip.onclick = () => {
            promptInput.value = chip.dataset.prompt;
            generateBtn.click();
        };
    });
    
    // Enter key to send
    promptInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            generateBtn.click();
        }
    });
    
    // Bind Generate button
    generateBtn.onclick = async () => {
        const prompt = promptInput.value.trim();
        if (!prompt) return;
        
        promptInput.value = '';
        generateBtn.disabled = true;
        
        const prePromptState = currentState.template ? {
            source: currentState.template.source,
            params: JSON.parse(JSON.stringify(currentState.params)),
            ui_parameters: currentState.template.ui_parameters ? JSON.parse(JSON.stringify(currentState.template.ui_parameters)) : []
        } : null;
        
        appendChatMessage('user', prompt);
        
        // Show loading bubble
        const container = document.getElementById('ai-chat-history');
        if (container) {
            const loadingBubble = document.createElement('div');
            loadingBubble.id = 'ai-loading-bubble';
            loadingBubble.className = 'chat-bubble system';
            loadingBubble.innerHTML = '<div class="bubble-text">Thinking... ⚙️</div>';
            container.appendChild(loadingBubble);
            container.scrollTop = container.scrollHeight;
        }
        
        try {
            await runAIGenerationPipeline(prompt, prePromptState);
        } catch (err) {
            appendChatMessage('system', `❌ ERROR: ${err.message}`);
            console.error('AI pipeline error:', err);
        } finally {
            generateBtn.disabled = false;
            const loadingBubble = document.getElementById('ai-loading-bubble');
            if (loadingBubble) loadingBubble.remove();
        }
    };

    // Initialize AI Settings UI controls
    initAISettingsControls();
}

async function runAIGenerationPipeline(prompt, prePromptState = null) {
    const provider = localStorage.getItem('paraform_ai_provider') || 'local';
    const apiKey = localStorage.getItem('paraform_ai_key') || '';
    const customUrl = localStorage.getItem('paraform_custom_url') || '';
    const customModel = localStorage.getItem('paraform_custom_model') || '';

    // Filter chat history for API payloads (excluding system status messages)
    const apiMessages = aiChatHistory.filter(m => m.role === 'user' || m.role === 'assistant');

    // Handle Local Agent Mode (Zero external API dependencies)
    if (provider === 'local') {
        await sleep(500);
        
        const currentSource = currentState.template ? currentState.template.source : '';
        let updatedSource = currentSource;
        
        const lowerPrompt = prompt.toLowerCase();
        let changesSummary = '';
        
        if (lowerPrompt.includes('hole') || lowerPrompt.includes('mounting')) {
            changesSummary = 'Injected standard clearance mounting hole modules at the four corners.';
            await sleep(400);
            if (currentSource.includes('difference()')) {
                updatedSource = currentSource.replace('difference() {', `difference() {\n    // AI Added mounting holes\n    hole_offset = 6;  // [number, Mounting Hole Offset, 3, 15, 0.5]\n    hole_diameter = 4; // [number, Mounting Hole Diameter, 2, 8, 0.5]\n    \n    // Subtract cylinders at four corners\n    translate([box_width/2 - hole_offset, box_depth/2 - hole_offset, -box_height/2 - 1]) cylinder(d=hole_diameter, h=box_height+2, $fn=32);\n    translate([-box_width/2 + hole_offset, box_depth/2 - hole_offset, -box_height/2 - 1]) cylinder(d=hole_diameter, h=box_height+2, $fn=32);\n    translate([box_width/2 - hole_offset, -box_depth/2 + hole_offset, -box_height/2 - 1]) cylinder(d=hole_diameter, h=box_height+2, $fn=32);\n    translate([-box_width/2 + hole_offset, -box_depth/2 + hole_offset, -box_height/2 - 1]) cylinder(d=hole_diameter, h=box_height+2, $fn=32);\n`);
            } else {
                updatedSource = `// Wrapped with AI Mounting Holes\ndifference() {\n    union() {\n        ${currentSource}\n    }\n    \n    hole_offset = 6;  // [number, Mounting Hole Offset, 3, 15, 0.5]\n    hole_diameter = 4; // [number, Mounting Hole Diameter, 2, 8, 0.5]\n    \n    // Corner mounting holes\n    translate([35, 25, -50]) cylinder(d=hole_diameter, h=100, $fn=32);\n    translate([-35, 25, -50]) cylinder(d=hole_diameter, h=100, $fn=32);\n    translate([35, -25, -50]) cylinder(d=hole_diameter, h=100, $fn=32);\n    translate([-35, -25, -50]) cylinder(d=hole_diameter, h=100, $fn=32);\n}`;
            }
        } else if (lowerPrompt.includes('fillet') || lowerPrompt.includes('round') || lowerPrompt.includes('bevel')) {
            changesSummary = 'Applied edge fillet modules using Minkowski rounding.';
            await sleep(400);
            if (currentSource.includes('cube([box_width, box_depth, box_height], center=true);')) {
                const helperModule = `\nmodule rounded_cube(x, y, z, r) {\n    translate([-x/2, -y/2, -z/2])\n    minkowski() {\n        translate([r, r, r]) cube([x - 2*r, y - 2*r, z - 2*r]);\n        sphere(r, $fn=16);\n    }\n}\n`;
                updatedSource = helperModule + "\n" + currentSource.replace('cube([box_width, box_depth, box_height], center=true);', `rounded_cube(box_width, box_depth, box_height, fillet_radius);\n    fillet_radius = 3; // [number, Fillet Radius, 1, 8, 0.5]`);
            } else {
                updatedSource = `\nfillet_radius = 2; // [number, Fillet Radius, 0.5, 5, 0.1]\nminkowski() {\n    union() {\n        ${currentSource}\n    }\n    sphere(fillet_radius, $fn=12);\n}`;
            }
        } else if (lowerPrompt.includes('vent') || lowerPrompt.includes('slot') || lowerPrompt.includes('grill')) {
            changesSummary = 'Injected a linear ventilation slots grid.';
            await sleep(400);
            if (currentSource.includes('difference()')) {
                updatedSource = currentSource.replace('difference() {', `difference() {\n    // AI Added ventilation slots\n    vent_width = 3.5;   // [number, Vent Slot Width, 1, 8, 0.5]\n    vent_length = 35;  // [number, Vent Slot Length, 10, 80, 1]\n    vent_spacing = 8; // [number, Vent Spacing, 4, 15, 0.5]\n    \n    // Linear slot arrays\n    for (x = [-3:3]) {\n        translate([x * vent_spacing, 0, -box_height/2 - 1])\n            cube([vent_width, vent_length, box_height+2], center=true);\n    }\n`);
            } else {
                updatedSource = `\ndifference() {\n    union() {\n        ${currentSource}\n    }\n    \n    vent_width = 3;   // [number, Vent Slot Width, 1, 8, 0.5]\n    vent_spacing = 6; // [number, Vent Spacing, 4, 15, 0.5]\n    \n    for (x = [-4:4]) {\n        translate([x * vent_spacing, 0, -50])\n            cube([vent_width, 40, 100], center=true);\n    }\n}`;
            }
        } else if (lowerPrompt.includes('emboss') || lowerPrompt.includes('text') || lowerPrompt.includes('engrave')) {
            changesSummary = 'Added linear extruded text branding module on the surface.';
            await sleep(400);
            const textModule = `\n// AI Extruded Text\nemboss_text = "ParaForm"; // [string, Embossed Text]\ntext_size = 8;            // [number, Text Size, 4, 20, 1]\ntext_depth = 1.5;         // [number, Text Depth, 0.5, 4, 0.1]\n\ntranslate([0, 0, box_height/2 - text_depth])\n    linear_extrude(height=text_depth + 1)\n        text(emboss_text, size=text_size, font="Liberation Sans:style=Bold", halign="center", valign="center");\n`;
            updatedSource = currentSource + "\n" + textModule;
        } else {
            changesSummary = 'Created a new default parametric rugged utility organizer box.';
            await sleep(400);
            updatedSource = `// Parametric Box generated by Local AI Agent\nbox_width = 90;       // [number, Box Width, 40, 150, 1]\nbox_depth = 70;       // [number, Box Depth, 40, 150, 1]\nbox_height = 40;      // [number, Box Height, 15, 100, 1]\nwall_thickness = 2;   // [number, Wall Thickness, 1.2, 4, 0.1]\n\ndifference() {\n    cube([box_width, box_depth, box_height], center=true);\n    translate([0, 0, wall_thickness]) \n        cube([box_width - wall_thickness*2, box_depth - wall_thickness*2, box_height], center=true);\n}\n`;
        }
        
        appendChatMessage('assistant', `**Success.** ${changesSummary}`, prePromptState);
        applyNewOpenSCADSource(updatedSource);
        return;
    }

    // ── Universal API Direct Pipeline ────────────────
    if (!apiKey) {
        throw new Error(`API Key for ${provider.toUpperCase()} is required. Please set it in AI Settings.`);
    }

    const currentSource = currentState.template ? currentState.template.source : '';
    const customSystemPrompt = localStorage.getItem('paraform_ai_system_prompt') || '';

    let systemPrompt = `You are ParaForm AI, an expert parametric 3D CAD designer specialized in producing clean, functional OpenSCAD model files.
Your task is to take the user's natural language request and modify the provided OpenSCAD source code accordingly.

RULES:
1. Always retain or enhance existing parametric parameters at the top of the file.
2. If the user asks for a new parameter, define it using the customizer format:
   key = value; // [type, Label, min, max, step]
   Supported types: 'number', 'integer', 'string', 'boolean', 'enum'.
3. Maintain clean geometry. Make sure subtracted shapes (holes, slots) extend slightly past the surfaces they cut through to avoid zero-thickness rendering artifacts.
4. Keep the orientation Z-up, millimeter scale.
5. Return ONLY valid OpenSCAD code. Do not wrap it in markdown codeblocks. Specifically, you must output a JSON object containing two fields:
   - "changes": "A short 1-sentence summary of what geometric features were changed/added."
   - "openscad_code": "The complete, revised, working OpenSCAD script, with no markdown styling around it."
6. Ensure no compile errors will occur. No external font imports or unsupported OpenSCAD features.`;

    if (customSystemPrompt.trim()) {
        systemPrompt += `\n\nUSER CUSTOM INSTRUCTIONS & BEST PRACTICES:\n${customSystemPrompt.trim()}`;
    }

    systemPrompt += `\n\nCurrent OpenSCAD Source Code:\n-------------------------------------------\n${currentSource}\n-------------------------------------------`;

    let responseText = '';

    // Route request to appropriate API
    if (provider === 'gemini') {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
        
        const contents = [];
        // Optional system instruction
        const systemInstruction = { role: 'system', parts: [{text: systemPrompt}] };
        
        apiMessages.forEach(msg => {
            contents.push({
                role: msg.role === 'assistant' ? 'model' : 'user',
                parts: [{ text: msg.content }]
            });
        });
        
        const payload = {
            systemInstruction,
            contents,
            generationConfig: {
                responseMimeType: 'application/json'
            }
        };
        
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        
        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error?.message || 'Gemini API call failed');
        }
        
        const result = await response.json();
        responseText = result.candidates[0].content.parts[0].text;

    } else if (provider === 'openai') {
        const url = 'https://api.openai.com/v1/chat/completions';
        
        const messages = [{ role: 'system', content: systemPrompt }];
        apiMessages.forEach(msg => {
            messages.push({ role: msg.role, content: msg.content });
        });
        
        const payload = {
            model: 'gpt-4o-mini',
            messages: messages,
            response_format: { type: 'json_object' }
        };
        
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify(payload)
        });
        
        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error?.message || 'OpenAI API call failed');
        }
        
        const result = await response.json();
        responseText = result.choices[0].message.content;

    } else if (provider === 'anthropic') {
        const url = 'https://api.anthropic.com/v1/messages';
        
        const messages = [];
        apiMessages.forEach(msg => {
            messages.push({ role: msg.role, content: msg.content });
        });
        
        const payload = {
            model: 'claude-3-5-sonnet-20241022',
            max_tokens: 4000,
            system: systemPrompt,
            messages: messages
        };
        
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
                'anthropic-danger-out-of-band-requests-enabled': 'true'
            },
            body: JSON.stringify(payload)
        });
        
        if (!response.ok) {
            throw new Error('Claude API call failed (CORS blocked. Please use OpenRouter/Custom instead)');
        }
        
        const result = await response.json();
        responseText = result.content[0].text;

    } else if (provider === 'custom') {
        const targetUrl = customUrl ? (customUrl.endsWith('/') ? customUrl + 'chat/completions' : customUrl + '/chat/completions') : '';
        if (!targetUrl) {
            throw new Error('Custom Base URL must be configured in Settings.');
        }
        const targetModel = customModel || 'deepseek-chat';
        
        const messages = [{ role: 'system', content: systemPrompt }];
        apiMessages.forEach(msg => {
            messages.push({ role: msg.role, content: msg.content });
        });
        
        const payload = {
            model: targetModel,
            messages: messages
        };
        
        const response = await fetch(targetUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify(payload)
        });
        
        if (!response.ok) {
            throw new Error(`Custom API call failed with status ${response.status}`);
        }
        
        const result = await response.json();
        responseText = result.choices[0].message.content;
    }

    let data;
    try {
        data = JSON.parse(responseText);
    } catch (e) {
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            data = JSON.parse(jsonMatch[0]);
        } else {
            throw new Error('Could not extract JSON content from AI response.');
        }
    }

    if (!data.openscad_code) {
        throw new Error('AI response did not contain openscad_code.');
    }

    appendChatMessage('assistant', `**Success.** ${data.changes || 'Geometry updated.'}`, prePromptState);
    applyNewOpenSCADSource(data.openscad_code);
}

function applyNewOpenSCADSource(newSource) {
    if (!currentState.template) return;
    
    // Disable obsolete local preview to ensure slider changes compile via worker
    delete currentState.template.localPreview;
    
    // 1. Write to code editor textarea
    const codeEditor = document.getElementById('code-editor');
    if (codeEditor) codeEditor.value = newSource;
    
    currentState.template.source = newSource;
    
    // 2. Extract new parameters
    const newParams = parseParametersFromSource(newSource);
    currentState.template.ui_parameters = newParams;
    
    // 3. Preserve variable values where keys match
    const oldParams = { ...currentState.params };
    currentState.params = {};
    newParams.forEach(p => {
        currentState.params[p.key] = oldParams[p.key] ?? p.default;
    });
    
    // 4. Update configurator UI sliders
    renderParameters();
    
    // 5. Trigger WebWorker background compilation
    triggerGeneration(true);
    
    console.log('WASM compilation and WebGL viewport re-rendering triggered.');
}

// ── AI Settings Modal Management ────────────────

function initAISettingsControls() {
    const modal = document.getElementById('ai-settings-modal');
    const closeBtn = document.getElementById('ai-settings-close');
    const saveBtn = document.getElementById('ai-settings-save');
    const providerSelect = document.getElementById('ai-provider-select');
    const customFields = document.getElementById('ai-custom-fields');
    const keyFieldRow = document.getElementById('ai-key-field-row');
    const keyInput = document.getElementById('ai-key-input');
    const keyToggle = document.getElementById('ai-key-toggle-visibility');
    
    if (!modal || !closeBtn || !saveBtn || !providerSelect) return;
    
    // Handle provider selection visibility toggling
    providerSelect.onchange = () => {
        const val = providerSelect.value;
        
        // Toggle Custom Base URL / Model ID fields
        customFields.classList.toggle('hidden', val !== 'custom');
        
        // Toggle API Key field row
        keyFieldRow.classList.toggle('hidden', val === 'local');
        
        // Label dynamic adjustment
        const keyLabel = document.getElementById('ai-key-label');
        if (keyLabel) {
            if (val === 'gemini') keyLabel.innerText = 'Gemini API Key';
            else if (val === 'openai') keyLabel.innerText = 'OpenAI API Key';
            else if (val === 'anthropic') keyLabel.innerText = 'Anthropic API Key';
            else keyLabel.innerText = 'API Key';
        }
    };
    
    // Handle password eye toggling
    if (keyToggle && keyInput) {
        keyToggle.onclick = () => {
            const isPassword = keyInput.type === 'password';
            keyInput.type = isPassword ? 'text' : 'password';
            keyToggle.innerText = isPassword ? '🔒' : '👁️';
        };
    }
    
    // Save button click
    saveBtn.onclick = () => {
        localStorage.setItem('paraform_ai_provider', providerSelect.value);
        localStorage.setItem('paraform_ai_key', keyInput.value.trim());
        
        const urlInput = document.getElementById('ai-custom-url-input');
        const modelInput = document.getElementById('ai-custom-model-input');
        const systemPromptInput = document.getElementById('ai-system-prompt-input');
        if (urlInput) localStorage.setItem('paraform_custom_url', urlInput.value.trim());
        if (modelInput) localStorage.setItem('paraform_custom_model', modelInput.value.trim());
        if (systemPromptInput) localStorage.setItem('paraform_ai_system_prompt', systemPromptInput.value.trim());
        
        modal.classList.add('hidden');
        appendChatMessage('system', `AI Settings updated. Active Provider: ${providerSelect.value.toUpperCase()}`);
    };
    
    // Close button click
    closeBtn.onclick = () => {
        modal.classList.add('hidden');
    };
}

function openAISettingsModal() {
    const modal = document.getElementById('ai-settings-modal');
    const providerSelect = document.getElementById('ai-provider-select');
    const customFields = document.getElementById('ai-custom-fields');
    const keyFieldRow = document.getElementById('ai-key-field-row');
    const keyInput = document.getElementById('ai-key-input');
    const urlInput = document.getElementById('ai-custom-url-input');
    const modelInput = document.getElementById('ai-custom-model-input');
    const systemPromptInput = document.getElementById('ai-system-prompt-input');
    
    if (!modal) return;
    
    // Load persisted configurations
    const provider = localStorage.getItem('paraform_ai_provider') || 'local';
    const key = localStorage.getItem('paraform_ai_key') || '';
    const customUrl = localStorage.getItem('paraform_custom_url') || '';
    const customModel = localStorage.getItem('paraform_custom_model') || '';
    const customSystemPrompt = localStorage.getItem('paraform_ai_system_prompt') || '';
    
    if (providerSelect) providerSelect.value = provider;
    if (keyInput) keyInput.value = key;
    if (urlInput) urlInput.value = customUrl;
    if (modelInput) modelInput.value = customModel;
    if (systemPromptInput) systemPromptInput.value = customSystemPrompt;
    
    // Toggle field visibility matching loaded configuration
    if (customFields) customFields.classList.toggle('hidden', provider !== 'custom');
    if (keyFieldRow) keyFieldRow.classList.toggle('hidden', provider === 'local');
    
    const keyLabel = document.getElementById('ai-key-label');
    if (keyLabel && providerSelect) {
        if (provider === 'gemini') keyLabel.innerText = 'Gemini API Key';
        else if (provider === 'openai') keyLabel.innerText = 'OpenAI API Key';
        else if (provider === 'anthropic') keyLabel.innerText = 'Anthropic API Key';
        else keyLabel.innerText = 'API Key';
    }
    
    // Display Modal overlay
    modal.classList.remove('hidden');
}

