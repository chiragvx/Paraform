import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader';
import { OBJExporter } from 'three/examples/jsm/exporters/OBJExporter';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils';
import { supabase } from './lib/supabase';
import { fetchCatalog, fetchScadSource, saveProject, listProjects,
         getAssetManifest, getAssetSource, resolveDependencies, buildWorkerFiles } from './lib/catalog.js';
import { SKILLS, getAllSkillScad, buildSkillContext, BOARD_FOOTPRINTS } from './lib/skills.js';
import { lint, formatErrorsForLLM } from './lib/validators/linter.js';
import { categorizeWasmError, buildRepairMessages, MAX_COMPILE_RETRIES } from './lib/repair.js';
import { buildDesignBrief } from './lib/context.js';
import { validateGeometry, formatGeometryWarnings } from './lib/validators/geometry.js';
import { runBenchmarks } from './lib/benchmarks.js';
import { scoreboard, SCORE_ORDER, SCORE_WEIGHTS } from './lib/validators/scoreboard.js';
import { runExactClashTests } from './lib/validators/clash.js';
import { runToolAccessTests } from './lib/validators/tool_access.js';
import { Evaluator, Operation, Brush, ADDITION, SUBTRACTION } from 'three-bvh-csg';

const csgEvaluator = new Evaluator();

// ============================================================
// SETTINGS STORE
// ============================================================
const SETTINGS_KEY = 'paraform_app_settings';

const DEFAULT_KEYBINDINGS = {
    undo:            { key: 'z', ctrl: true,  shift: false, alt: false, label: 'Undo' },
    redo:            { key: 'y', ctrl: true,  shift: false, alt: false, label: 'Redo' },
    compile:         { key: 's', ctrl: true,  shift: false, alt: false, label: 'Compile & Run' },
    resetCamera:     { key: 'f', ctrl: false, shift: false, alt: false, label: 'Reset Camera' },
    toolSelect:      { key: 'v', ctrl: false, shift: false, alt: false, label: 'Tool: Select' },
    toolMove:        { key: 'g', ctrl: false, shift: false, alt: false, label: 'Tool: Move' },
    toolRotate:      { key: 'r', ctrl: false, shift: false, alt: false, label: 'Tool: Rotate' },
    toolScale:       { key: 's', ctrl: false, shift: false, alt: false, label: 'Tool: Scale' },
    openSettings:    { key: ',', ctrl: true,  shift: false, alt: false, label: 'Open Settings' },
    toggleWireframe: { key: 'w', ctrl: false, shift: false, alt: false, label: 'Toggle Wireframe' },
    exportModel:     { key: 'e', ctrl: true,  shift: false, alt: false, label: 'Export Model' },
};

const DEFAULT_SETTINGS = {
    preferences: { unitSystem: 'mm', autoSave: 'off', startup: 'library' },
    viewport:    { defaultDisplayMode: 'shaded', background: 'default', showGrid: true, gridSize: 10, showAxes: true, fov: 75 },
    camera:      { orbitSpeed: 1.0, zoomSpeed: 1.0, panSpeed: 1.0, dampingFactor: 0.05, invertY: false, autoFitOnCompile: true },
    performance: { compileQuality: 'preview', autoRecompileDelay: 500, workerThreads: 'auto' },
    graphics:    { antialias: true, edgeThickness: 1, pixelRatio: 'device' },
    measurement: { unit: 'mm', decimalPlaces: 2 },
    export:      { defaultFormat: 'stl', stlType: 'binary', exportQuality: 'high', filenamePattern: '{model}' },
    diagnostics: { showFPS: false, showPolygonCount: true, showCompileTime: true },
    keybindings: null, // populated after DEFAULT_KEYBINDINGS is defined
};
DEFAULT_SETTINGS.keybindings = { ...DEFAULT_KEYBINDINGS };

function _deepMerge(target, source) {
    const result = { ...target };
    for (const k of Object.keys(source)) {
        if (source[k] !== null && typeof source[k] === 'object' && !Array.isArray(source[k])) {
            result[k] = _deepMerge(target[k] || {}, source[k]);
        } else {
            result[k] = source[k];
        }
    }
    return result;
}

function getSettings() {
    try {
        const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
        return _deepMerge(DEFAULT_SETTINGS, stored);
    } catch { return { ...DEFAULT_SETTINGS, keybindings: { ...DEFAULT_KEYBINDINGS } }; }
}

function saveSettings(patch) {
    const updated = _deepMerge(getSettings(), patch);
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(updated));
    applySettings(updated);
    return updated;
}

const BG_COLORS = { default: 0x1a1c1e, black: 0x000000, gray: 0x1a1a1a, blue: 0x080d14 };

function applySettings(s) {
    if (mainViewport) {
        const c = mainViewport.controls;
        const cam = mainViewport.camera;
        if (c) {
            c.rotateSpeed   = s.camera.orbitSpeed * (s.camera.invertY ? -1 : 1);
            c.zoomSpeed     = s.camera.zoomSpeed;
            c.panSpeed      = s.camera.panSpeed;
            c.dampingFactor = s.camera.dampingFactor;
        }
        if (cam && cam.fov !== s.viewport.fov) {
            cam.fov = s.viewport.fov;
            cam.updateProjectionMatrix();
        }
        if (mainViewport.grid)  mainViewport.grid.visible  = s.viewport.showGrid;
        if (mainViewport.axes)  mainViewport.axes.visible  = s.viewport.showAxes;
        if (mainViewport.scene) mainViewport.scene.background = new THREE.Color(BG_COLORS[s.viewport.background] ?? 0x0d0b09);
        if (mainViewport.renderer) {
            const dpr = s.graphics.pixelRatio === 'device'
                ? Math.min(window.devicePixelRatio, 2)
                : parseFloat(s.graphics.pixelRatio);
            mainViewport.renderer.setPixelRatio(dpr);
        }
    }
    // Diagnostics visibility
    const polyRow = document.querySelector('.diag-row-secondary');
    if (polyRow) polyRow.style.display = s.diagnostics.showPolygonCount ? '' : 'none';
    const renderTimeEl = document.getElementById('render-time');
    if (renderTimeEl) renderTimeEl.style.display = s.diagnostics.showCompileTime ? '' : 'none';
    // FPS counter
    let fpsEl = document.getElementById('fps-counter');
    if (s.diagnostics.showFPS && !fpsEl) {
        fpsEl = document.createElement('span');
        fpsEl.id = 'fps-counter';
        fpsEl.className = 'mono diag-time';
        fpsEl.style.cssText = 'font-size:10px;color:var(--text-muted);margin-left:8px';
        fpsEl.innerText = '— fps';
        const diagRow = document.querySelector('.diagnostics-bar .diag-row');
        if (diagRow) diagRow.appendChild(fpsEl);
    } else if (!s.diagnostics.showFPS && fpsEl) {
        fpsEl.remove();
    }
    // Rebuild keybindings dispatch
    buildKeyDispatch(s.keybindings);
}

// --- Auto-save timer ---
let _autoSaveTimer = null;
function restartAutoSave() {
    clearInterval(_autoSaveTimer);
    const interval = { '30s': 30000, '1min': 60000, '5min': 300000 }[getSettings().preferences.autoSave];
    if (!interval) return;
    _autoSaveTimer = setInterval(() => {
        if (!currentState.template) return;
        const source = document.getElementById('code-editor')?.value || currentState.template.source || '';
        saveProject({ id: currentState.template.id, title: currentState.projectTitle || currentState.template.title, templateId: currentState.template.id, source, params: { ...currentState.params } });
    }, interval);
}

// --- FPS tracking ---
let _fpsFrames = 0, _fpsLast = performance.now();
function tickFPS() {
    _fpsFrames++;
    const now = performance.now();
    if (now - _fpsLast >= 1000) {
        const el = document.getElementById('fps-counter');
        if (el) el.innerText = `${_fpsFrames} fps`;
        _fpsFrames = 0;
        _fpsLast = now;
    }
}

// --- Key dispatch ---
let keyDispatch = {};
let isCapturingKeybinding = false;

function comboStr(key, ctrl, shift, alt) {
    if (!key) return '';
    const parts = [];
    if (ctrl)  parts.push('ctrl');
    if (shift) parts.push('shift');
    if (alt)   parts.push('alt');
    parts.push(key.toLowerCase());
    return parts.join('+');
}

function buildKeyDispatch(bindings) {
    keyDispatch = {};
    for (const [id, b] of Object.entries(bindings)) {
        if (!b?.key) continue;
        keyDispatch[comboStr(b.key, b.ctrl, b.shift, b.alt)] = id;
    }
}

// Initialise dispatch from saved settings (before mainViewport exists)
buildKeyDispatch(getSettings().keybindings);

// --- Auto-fit camera after compile ---
function fitCameraToMesh() {
    if (!mainViewport?.currentMesh) return;
    const box = new THREE.Box3().setFromObject(mainViewport.currentMesh);
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    const fov = mainViewport.camera.fov * (Math.PI / 180);
    const dist = (maxDim / 2) / Math.tan(fov / 2) * 1.6;
    const dir = mainViewport.camera.position.clone().sub(center).normalize();
    mainViewport.camera.position.copy(center.clone().add(dir.multiplyScalar(dist)));
    mainViewport.controls.target.copy(center);
    mainViewport.controls.update();
}

window.addEventListener('render-complete', ({ detail }) => {
    if (detail.isFinal && getSettings().camera.autoFitOnCompile) fitCameraToMesh();
});

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
    editMode: 'layers', // 'layers' or 'code' (left panel); ai lives in right panel
    projectTitle: 'Untitled Project',
    activeGizmoTool: 'select', // 'select', 'translate', 'rotate', 'scale'
    isSelected: true, // If the active model is highlighted / selected
    isCtrlPressed: false, // Tracks if control key is pressed for rotation snapping override
    isDraggingMesh: false, // Tracks if the user is actively dragging the mesh directly with mouse
    viewportState: {
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: 1.0,
        materialColor: '#c8bdb2',
        materialFinish: 'semi-gloss',
        buildPlate: 'ender',
        lightPreset: 'standard',
        lightIntensity: 2.0
    },
    // Multi-part fields (populated when template has parts[])
    activePart: null,       // string | null — null = model-level view
    globalParams: {},       // { [key]: value } for global_parameters
    partParams: {},         // { [partId]: { [key]: value } }
    partVisibility: {},     // { [partId]: boolean }
    partMeshes: {},         // { [partId]: THREE.Mesh } inside the partGroup
    partCollisions: new Set(), // partIds that overlap ≥1 other part after last render
    // Scene components — imported assets as independent first-class scene objects
    sceneComponents: [],      // [{ id, assetId, mode, name, color, source }]
    componentVisible: {},     // { [componentId]: boolean }
};

let undoHistory = [];
let redoHistory = [];
let isUndoingRedoing = false;

function isMultiPart() {
    return !!(currentState.template?.parts?.length);
}

function updateSliderFill(range) {
    const min = parseFloat(range.min) || 0;
    const max = parseFloat(range.max) || 100;
    const pct = ((parseFloat(range.value) - min) / (max - min)) * 100;
    range.style.setProperty('--slider-fill', pct.toFixed(1) + '%');
}

// Format a single parameter as an OpenSCAD variable declaration
function formatParamDecl(param, value) {
    if (param.type === 'boolean') return `${param.key} = ${value ? 1 : 0};`;
    if (param.type === 'enum' && param.key === 'FOR_PRINT') return `FOR_PRINT = ${value === 'PrintPlate' ? 1 : 0};`;
    if (typeof value === 'string') return `${param.key} = "${value}";`;
    return `${param.key} = ${value ?? 0};`;
}


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
    },
    // ── Multi-Part Demo Template ─────────────────────────────────────────────
    // This template demonstrates the CORRECT pattern for multi-part assemblies:
    //   • Shared dimensions live in global_parameters so all parts reference them.
    //   • Every part except the anchor uses translate() to position itself in the
    //     shared assembly coordinate space (SCAD: X=right, Y=depth, Z=up).
    //   • No two parts overlap at default parameter values.
    {
        id: 'shelf_bracket_v1',
        title: 'Shelf Bracket Assembly',
        description: 'A 3-part wall shelf bracket. Demonstrates multi-part assembly with shared global dimensions and collision-free positioning.',
        global_parameters: [
            { key: 'plate_w',           label: 'Plate Width',         type: 'number', min: 40,  max: 150, step: 1,   default: 80,  unit: 'mm' },
            { key: 'plate_h',           label: 'Plate Height',        type: 'number', min: 60,  max: 200, step: 1,   default: 100, unit: 'mm' },
            { key: 'arm_length',        label: 'Arm Length',          type: 'number', min: 60,  max: 250, step: 5,   default: 120, unit: 'mm' },
            { key: 'material_thickness',label: 'Material Thickness',  type: 'number', min: 3,   max: 10,  step: 0.5, default: 5,   unit: 'mm' },
            { key: 'bolt_hole_d',       label: 'Bolt Hole Diameter',  type: 'number', min: 2,   max: 6,   step: 0.5, default: 4,   unit: 'mm' },
        ],
        parts: [
            // ── Part 1: Wall Plate ───────────────────────────────────────────
            // Anchor part — sits at origin. ALL other parts are translated
            // relative to this part's bounding box edges.
            // Occupies: X=[0..plate_w], Y=[0..material_thickness], Z=[0..plate_h]
            {
                id: 'wall_plate',
                name: 'Wall Plate',
                color: '#3b82f6',
                ui_parameters: [
                    { key: 'screw_count', label: 'Wall Screws', type: 'integer', min: 2, max: 6, step: 1, default: 4 },
                ],
                source: `// Wall Plate — anchor part at origin (no translate needed).
// Assembly space: X=[0..plate_w], Y=[0..material_thickness], Z=[0..plate_h]
// Globals used: plate_w, plate_h, material_thickness, bolt_hole_d
// Locals:  screw_count
difference() {
    cube([plate_w, material_thickness, plate_h]);
    // Wall mounting screws — evenly spaced, upper 60% of plate height
    for (i = [1 : 1 : screw_count]) {
        x = plate_w * i / (screw_count + 1);
        translate([x, -1, plate_h * 0.4 + plate_h * 0.5 * i / (screw_count + 1)])
            rotate([-90,0,0]) cylinder(d=bolt_hole_d, h=material_thickness+2, $fn=16);
    }
    // Arm bolt holes — 2x at Z = material_thickness*2 (lower section)
    translate([plate_w*0.3, -1, material_thickness*2])
        rotate([-90,0,0]) cylinder(d=bolt_hole_d, h=material_thickness+2, $fn=16);
    translate([plate_w*0.7, -1, material_thickness*2])
        rotate([-90,0,0]) cylinder(d=bolt_hole_d, h=material_thickness+2, $fn=16);
}`,
                localPreview: (globalParams, _partParams) => {
                    const { material_thickness = 5, plate_w = 80, plate_h = 100 } = globalParams;
                    const g = new THREE.BoxGeometry(plate_w, material_thickness, plate_h);
                    g.translate(plate_w / 2, material_thickness / 2, plate_h / 2);
                    return g;
                }
            },

            // ── Part 2: Horizontal Arm ───────────────────────────────────────
            // The shelf surface. Translated so it sits on TOP of the wall plate
            // and extends outward in +Y. Touches wall plate at Y=material_thickness
            // and at Z=plate_h; does NOT overlap.
            // Occupies: X=[0..plate_w], Y=[t..t+arm_length], Z=[plate_h-t..plate_h]
            {
                id: 'arm',
                name: 'Horizontal Arm',
                color: '#22c55e',
                ui_parameters: [],  // all dims come from global_parameters
                source: `// Horizontal Arm — shelf surface, positioned at top of wall plate.
// ASSEMBLY TRANSLATE: starts where wall plate ends in Y, at top of plate in Z.
// Touches wall plate edges but does NOT overlap (shared face only).
// Globals used: plate_w, plate_h, arm_length, material_thickness, bolt_hole_d
translate([0, material_thickness, plate_h - material_thickness])
difference() {
    cube([plate_w, arm_length, material_thickness]);
    // Arm-to-plate bolt holes (at the wall-attachment end)
    translate([plate_w*0.3, material_thickness*1.5, -1])
        cylinder(d=bolt_hole_d, h=material_thickness+2, $fn=16);
    translate([plate_w*0.7, material_thickness*1.5, -1])
        cylinder(d=bolt_hole_d, h=material_thickness+2, $fn=16);
}`,
                localPreview: (globalParams, _partParams) => {
                    const { material_thickness = 5, plate_w = 80, plate_h = 100, arm_length = 120 } = globalParams;
                    const g = new THREE.BoxGeometry(plate_w, arm_length, material_thickness);
                    // Centre the BoxGeometry at its SCAD mid-point
                    g.translate(plate_w / 2, material_thickness + arm_length / 2, plate_h - material_thickness / 2);
                    return g;
                }
            },

            // ── Part 3: Diagonal Brace ───────────────────────────────────────
            // Triangular gusset supporting the arm from below.
            // Uses hull() of 3 thin bars — no rotate/polygon complexity.
            // Vertices of triangle (in YZ plane, extruded in X by brace_width):
            //   (Y=t, Z=0)  →  (Y=arm_length-t, Z=0)  →  (Y=t, Z=plate_h-t)
            // Occupies: approx Y=[t..arm_length], Z=[0..plate_h-t]
            // Touches wall plate at Y=t, touches arm at Z=plate_h-t — no overlap.
            {
                id: 'brace',
                name: 'Diagonal Brace',
                color: '#f97316',
                ui_parameters: [
                    { key: 'brace_width', label: 'Brace Thickness (X)', type: 'number', min: 10, max: 60, step: 1, default: 25, unit: 'mm' },
                ],
                source: `// Diagonal Brace — triangular gusset, positioned between wall plate and arm.
// ASSEMBLY TRANSLATE: each corner is placed with explicit coordinates so the
// brace fits exactly in the gap without overlapping wall plate or arm.
// Globals used: plate_w, plate_h, arm_length, material_thickness
// Locals:  brace_width
brace_x = (plate_w - brace_width) / 2;
hull() {
    // Corner A: at wall, ground level  (Y=material_thickness, Z=0)
    translate([brace_x, material_thickness, 0])
        cube([brace_width, 1, 1]);
    // Corner B: at arm tip, ground level  (Y=arm_length-t, Z=0)
    translate([brace_x, arm_length - material_thickness, 0])
        cube([brace_width, 1, 1]);
    // Corner C: at wall, just below arm  (Y=material_thickness, Z=plate_h-t)
    translate([brace_x, material_thickness, plate_h - material_thickness - 1])
        cube([brace_width, 1, 1]);
}`,
                localPreview: (globalParams, partParams) => {
                    const { material_thickness = 5, plate_w = 80, plate_h = 100, arm_length = 120 } = globalParams;
                    const { brace_width = 25 } = partParams;
                    // Approximate bounding box of the triangular brace
                    const brace_x = (plate_w - brace_width) / 2;
                    const g = new THREE.BoxGeometry(brace_width, arm_length - material_thickness, (plate_h - material_thickness) * 0.6);
                    g.translate(brace_x + brace_width / 2,
                                material_thickness + (arm_length - material_thickness) / 2,
                                (plate_h - material_thickness) * 0.3);
                    return g;
                }
            }
        ]
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
        // Ribbon targets (used in editor mode instead of nav-links/nav-actions)
        const ribbonMenus = document.querySelector('.ribbon-nav-menus');
        const ribbonTitle = document.querySelector('.ribbon-nav-title');
        const ribbonActions = document.querySelector('.ribbon-nav-actions');

        if (closeEditorMenusHandler) {
            document.removeEventListener('click', closeEditorMenusHandler);
            closeEditorMenusHandler = null;
        }

        if (isEditor) {
            // --- STUDIO NAVBAR VARIANT (renders into ribbon) ---

            // Inject menus into ribbon nav menus container
            const menuTarget = ribbonMenus || navLinks;
            if (menuTarget) {
                if (ribbonMenus) ribbonMenus.classList.remove('hidden');
                else { navLinks.classList.remove('hidden'); }

                const menuHTML = `
                    <div class="menu-bar">
                    <div class="menu-item">
                        <button class="menu-trigger">File ▾</button>
                        <div class="dropdown-content">
                            <a href="#" id="menu-open-model"><span class="material-symbols-outlined">folder_open</span> Open Model</a>
                            <a href="#" id="menu-save-design"><span class="material-symbols-outlined">save</span> Save Design</a>
                            <a href="#" id="menu-export-stl"><span class="material-symbols-outlined">upload_file</span> Export…</a>
                            <hr class="menu-divider">
                            <a href="#/explore"><span class="material-symbols-outlined">exit_to_app</span> Exit Studio</a>
                        </div>
                    </div>
                    <div class="menu-item">
                        <button class="menu-trigger">View ▾</button>
                        <div class="dropdown-content">
                            <a href="#" id="menu-reset-camera"><span class="material-symbols-outlined">center_focus_strong</span> Reset Camera</a>
                            <a href="#" id="menu-toggle-wireframe"><span class="material-symbols-outlined">grid_on</span> Toggle Wireframe</a>
                        </div>
                    </div>
                    <div class="menu-item">
                        <button class="menu-trigger">Settings ▾</button>
                        <div class="dropdown-content">
                            <a href="#" id="menu-app-settings"><span class="material-symbols-outlined">settings</span> App Settings…</a>
                            <hr class="menu-divider">
                            <a href="#" id="menu-perf-mode"><span class="material-symbols-outlined">bolt</span> Performance Mode</a>
                            <a href="#" id="menu-show-diags"><span class="material-symbols-outlined">analytics</span> Show Diagnostics</a>
                            <a href="#" id="menu-ai-settings"><span class="material-symbols-outlined">smart_toy</span> AI Settings</a>
                        </div>
                    </div>
                    </div>
                `;
                menuTarget.innerHTML = menuHTML;

                // Inject project title into ribbon center
                if (ribbonTitle) {
                    ribbonTitle.innerHTML = `<input id="nav-project-title" class="editor-project-name" type="text" placeholder="Untitled Project" style="width:100%" autocomplete="new-password" autocorrect="off" autocapitalize="off" spellcheck="false">`;
                }

                syncProjectTitleUI();
                bindProjectTitleInput();

                // Bind Dropdown Toggle
                const menuTriggers = menuTarget.querySelectorAll('.menu-trigger');
                menuTriggers.forEach(trig => {
                    trig.onclick = (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        const pItem = trig.parentElement;
                        const wasOpen = pItem.classList.contains('open');
                        menuTarget.querySelectorAll('.menu-item').forEach(item => item.classList.remove('open'));
                        if (!wasOpen) pItem.classList.add('open');
                    };
                });

                // Global document click closes open dropdown menus
                const closeAllMenus = () => {
                    menuTarget.querySelectorAll('.menu-item').forEach(item => item.classList.remove('open'));
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
                        alert(`"${project.title}" saved locally at ${ts}.`);
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
                        const next = displayMode === 'shaded' ? 'wireframe' : 'shaded';
                        applyDisplayMode(next);
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

                const appSettingsBtn = document.getElementById('menu-app-settings');
                if (appSettingsBtn) {
                    appSettingsBtn.onclick = (e) => {
                        e.preventDefault();
                        closeAllMenus();
                        openAppSettingsModal();
                    };
                }
            }

            // Apply persisted settings to viewport/camera as soon as Studio is entered
            applySettings(getSettings());
            restartAutoSave();

            const actionsTarget = ribbonActions || navActions;
            if (actionsTarget) {
                actionsTarget.innerHTML = `
                    <button id="studio-browse-btn" class="secondary-btn">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
                        Library
                    </button>
                    <button id="export-stl" class="primary-btn">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                        Export
                    </button>
                    ${!ribbonActions ? `<button id="mobile-menu-toggle" class="icon-btn mobile-only">
                        <span></span>
                        <span></span>
                        <span></span>
                    </button>` : ''}
                `;

                const studioBrowseBtn = document.getElementById('studio-browse-btn');
                if (studioBrowseBtn) studioBrowseBtn.onclick = openStudioLibrary;

                const exportBtn = document.getElementById('export-stl');
                if (exportBtn) exportBtn.onclick = openExportModal;

                if (!ribbonActions) {
                    const mobileToggle = document.getElementById('mobile-menu-toggle');
                    if (mobileToggle) {
                        mobileToggle.onclick = () => {
                            navLinks.classList.toggle('mobile-active');
                            mobileToggle.classList.toggle('active');
                        };
                    }
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
    initPanelResize();
    initPipelineLogOverlay();
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
let displayMode = 'shaded'; // 'shaded' | 'shaded-edges' | 'wireframe' | 'wireframe-edges'

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

    // Professional cool-grey scene (Fusion 360-style)
    scene.background = new THREE.Color(0x1a1c1e);

    const hemiLight = new THREE.HemisphereLight(0xe8edf2, 0x10131a, 1.2);
    hemiLight.position.set(0, 200, 0);
    scene.add(hemiLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 2.4);
    dirLight.position.set(100, 200, 80);
    scene.add(dirLight);

    const fillLight = new THREE.DirectionalLight(0x90b4d0, 1.0);
    fillLight.position.set(-80, 40, -100);
    scene.add(fillLight);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    camera.position.set(80, 80, 80);

    // Ground Grid — cool steel tones
    const grid = new THREE.GridHelper(400, 40, 0x2e3136, 0x232629);
    grid.position.y = -0.1;
    grid.material.opacity = 0.7;
    grid.material.transparent = true;
    scene.add(grid);

    // Subtle Axes
    const axes = new THREE.AxesHelper(20);
    axes.material.opacity = 0.5;
    axes.material.transparent = true;
    scene.add(axes);

    // Professional CAD material — warm clay/stone neutral
    const material = new THREE.MeshStandardMaterial({
        color: 0x8c9aaa,   // Steel-grey
        metalness: 0.25,
        roughness: 0.45,
        side: THREE.DoubleSide
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
    
    return { scene, camera, renderer, controls, material, container, hemiLight, dirLight, fillLight, grid, axes, transformControls };
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
        // G2 — auto-attach the dependency closure (semantic API, fasteners,
        // referenced asset files) to every compile job so `use <…>` resolves
        // inside the worker's Emscripten VFS. Caller-supplied `files` are
        // merged on top (caller wins for any path collision).
        if (job.sourceCode) {
            // Prepend skill module definitions so AI-generated SCAD can call skill_* without use <>
            job.sourceCode = `${getAllSkillScad()}\n${job.sourceCode}`;
            const auto = buildWorkerFiles(job.sourceCode);
            job.files = job.files ? { ...auto, ...job.files } : auto;
        }
        // M2 — scoreboard: every main-context compile gates the +40% compile weight.
        // Wrap the caller's callback so we observe data.assertMessages and data.ok.
        const wrapped = (data) => {
            if (job.context === 'main') {
                if (data.ok && (!data.assertMessages || data.assertMessages.length === 0)) {
                    scoreboard.mark('compile', true);
                } else {
                    scoreboard.mark('compile', false, data.assertMessages || (data.error ? [data.error] : []));
                }
            }
            callback(data);
        };
        this.callbacks.set(job.jobId, wrapped);
        this.jobQueue.push(job);
        this._processQueue();
    }
}

const pool = new CADWorkerPool();
// Per-task counter for multi-part renders — ensures each part gets a unique pool key
// (starting high so it never collides with the small integers in currentState.jobId)
let _multiPartTaskCounter = 999999;

// ─── PipelineLog ────────────────────────────────────────────────────────────
// Structured per-run diagnostic log.  Each call to startRun() returns an
// independent run object so concurrent async completions don't clobber a
// shared "current" pointer.
const PipelineLog = (() => {
    const runs = [];
    return {
        startRun(label) {
            const run = { label, stages: [], t0: performance.now(), ok: null };
            runs.push(run);
            if (runs.length > 200) runs.shift();
            return {
                stage(name, status, detail = '') {
                    run.stages.push({ name, status, detail, dt: +(performance.now() - run.t0).toFixed(1) });
                    if (status === 'error') {
                        run.ok = false;
                        console.warn(`[Pipeline:${label}] ${name} FAIL —`, detail);
                    } else if (status === 'ok' && run.ok !== false) {
                        run.ok = true;
                    }
                },
                finish() {
                    run.total = +(performance.now() - run.t0).toFixed(1);
                    console.debug(`[Pipeline:${label}] done in ${run.total}ms`, run.ok ? '✓' : '✗');
                },
            };
        },
        getRuns() { return runs; },
        last(n = 10) { return runs.slice(-n); },
    };
})();
window.PipelineLog = PipelineLog;
window.runBenchmarks = runBenchmarks;
// ────────────────────────────────────────────────────────────────────────────

async function selectTemplate(template, autoExtract = false) {
    // Fetch SCAD source from bucket (or cache) if not already inline.
    // Multi-part templates store source inside parts[], not template.source — skip fetch.
    if (!template.source && !template.parts?.length) {
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

    // Clear any scene components from the previous session
    currentState.sceneComponents = [];
    currentState.componentVisible = {};
    if (mainViewport?.componentGroup) {
        mainViewport.scene.remove(mainViewport.componentGroup);
        mainViewport.componentGroup = null;
        mainViewport.componentMeshes = {};
    }

    if (template.parts?.length) {
        // ── Multi-part mode ─────────────────────────────────
        initMultiPartState(template);
    } else {
        // ── Single-part mode ─────────────────────────────────
        // Auto-extract parameters for custom code
        if (autoExtract && template.source) {
            template.ui_parameters = parseParametersFromSource(template.source);
        }
        // Support custom templates or templates with no params
        if (template.ui_parameters) {
            template.ui_parameters.forEach(p => currentState.params[p.key] = p.default);
        }
        const editor = document.getElementById('code-editor');
        if (editor) {
            editor.value = template.source || '';
            editor.removeAttribute('readonly');
            editor.style.opacity = '1';
        }
    }

    syncProjectTitleUI();
    const descEl = document.getElementById('active-template-desc');
    if (descEl) descEl.innerText = template.description || '';

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
                    ${template.thumbnail_url ? `<img src="${template.thumbnail_url}" alt="${template.title}">` : '<div class="thumb-placeholder"><span class="material-symbols-outlined">hexagon</span></div>'}
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
            if (!currentState.template) return;

            if (isMultiPart() && currentState.activePart) {
                // Multi-part: save to the active part's source
                const part = currentState.template.parts.find(p => p.id === currentState.activePart);
                if (part) {
                    part.source = document.getElementById('code-editor').value;
                    triggerGeneration(true);
                }
            } else if (!isMultiPart()) {
                // Single-part: existing behavior
                const newSource = document.getElementById('code-editor').value;
                currentState.template.source = newSource;
                const newParams = parseParametersFromSource(newSource);
                currentState.template.ui_parameters = newParams;
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

    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tabId);
    });

    document.getElementById('tab-content-layers').classList.toggle('hidden', tabId !== 'layers');
    document.getElementById('tab-content-code').classList.toggle('hidden', tabId !== 'code');

    if (tabId === 'layers') renderLayersTab();
    if (tabId === 'code' && isMultiPart()) syncCodeEditorToActivePart();
}

function renderParameters() {
    if (isMultiPart()) { renderParametersMultiPart(); return; }

    const container = document.getElementById('parameters-container');
    container.innerHTML = '';

    if (!currentState.template?.ui_parameters?.length) {
        container.innerHTML = '<div style="padding:20px 16px;font-size:12px;color:var(--text-muted);text-align:center">No parameters defined.<br>Switch to Script tab to add some.</div>';
        return;
    }

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
            const options = (param.options || []).map(opt => `<option value="${opt}" ${currentState.params[param.key] === opt ? 'selected' : ''}>${opt}</option>`).join('');
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
                updateSliderFill(range);
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
            updateSliderFill(range);
            
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

// ── Multi-Part: Layers Tab ───────────────────────────────────────────────────

function renderLayersTab() {
    const container = document.getElementById('tab-content-layers');
    if (!container) return;

    if (!currentState.treeCollapse) {
        currentState.treeCollapse = { globals: false, parts: false, components: false };
    }

    const template = currentState.template;
    const globalCount = template?.global_parameters?.length || 0;
    const partsCount = template?.parts?.length || 0;
    const componentsCount = currentState.sceneComponents?.length || 0;

    container.innerHTML = `
        <div class="cad-browser-tree">
            <!-- Root node: Active Design -->
            <div class="tree-node root-node">
                <span class="material-symbols-outlined font-icon">hexagon</span>
                <span class="node-label">${getProjectTitle()}</span>
            </div>
            
            <!-- Group 1: Global Parameters -->
            ${globalCount > 0 ? `
            <div class="tree-group-header" id="tg-globals-toggle">
                <span class="material-symbols-outlined chevron-icon ${currentState.treeCollapse.globals ? '' : 'expanded'}">chevron_right</span>
                <span class="material-symbols-outlined group-icon">tune</span>
                <span class="group-label">Global Parameters</span>
                <span class="group-count">${globalCount}</span>
            </div>
            <div class="tree-group-body ${currentState.treeCollapse.globals ? 'collapsed' : ''}" id="tg-globals-body">
            </div>
            ` : ''}

            <!-- Group 2: Solid Parts -->
            <div class="tree-group-header" id="tg-parts-toggle">
                <span class="material-symbols-outlined chevron-icon ${currentState.treeCollapse.parts ? '' : 'expanded'}">chevron_right</span>
                <span class="material-symbols-outlined group-icon">layers</span>
                <span class="group-label">Solid Parts</span>
                <span class="group-count">${partsCount}</span>
                <button class="add-part-btn-mini" id="tree-add-part" title="Add New Part">+</button>
            </div>
            <div class="tree-group-body ${currentState.treeCollapse.parts ? 'collapsed' : ''}" id="tg-parts-body">
            </div>

            <!-- Group 3: Mated Components -->
            <div class="tree-group-header" id="tg-components-toggle">
                <span class="material-symbols-outlined chevron-icon ${currentState.treeCollapse.components ? '' : 'expanded'}">chevron_right</span>
                <span class="material-symbols-outlined group-icon">extension</span>
                <span class="group-label">Mated Components</span>
                <span class="group-count">${componentsCount}</span>
            </div>
            <div class="tree-group-body ${currentState.treeCollapse.components ? 'collapsed' : ''}" id="tg-components-body">
            </div>
        </div>
    `;

    // Populate the bodies
    if (globalCount > 0 && !currentState.treeCollapse.globals) {
        renderTreeGlobals();
    }
    if (!currentState.treeCollapse.parts) {
        renderTreeParts();
    }
    if (!currentState.treeCollapse.components) {
        renderTreeComponents();
    }

    bindTreeEvents();
}

function renderTreeGlobals() {
    const body = document.getElementById('tg-globals-body');
    if (!body || !currentState.template?.global_parameters?.length) return;

    body.innerHTML = '';
    currentState.template.global_parameters.forEach(param => {
        const val = currentState.globalParams[param.key] ?? param.default;
        const row = document.createElement('div');
        row.className = `tree-item parameter-tree-row type-${param.type}`;
        
        let controlHtml = '';
        if (param.type === 'number' || param.type === 'integer') {
            controlHtml = `
                <div class="tree-param-header">
                    <span class="tree-param-label">${param.label}</span>
                    <input type="number" class="tree-manual-input" value="${val}" step="${param.step}">
                </div>
                <input type="range" class="tree-range-slider" min="${param.min}" max="${param.max}" step="${param.step}" value="${val}">
            `;
        } else if (param.type === 'enum') {
            const options = (param.options || []).map(opt => `<option value="${opt}" ${val === opt ? 'selected' : ''}>${opt}</option>`).join('');
            controlHtml = `
                <span class="tree-param-label">${param.label}</span>
                <select class="tree-select">${options}</select>
            `;
        } else if (param.type === 'boolean') {
            controlHtml = `
                <span class="tree-param-label">${param.label}</span>
                <label class="switch-mini">
                    <input type="checkbox" ${val ? 'checked' : ''}>
                    <span class="slider-round-mini"></span>
                </label>
            `;
        }

        row.innerHTML = `
            <div class="tree-indent"></div>
            <span class="material-symbols-outlined item-icon" style="opacity:0.5">tune</span>
            <div class="tree-param-body">${controlHtml}</div>
        `;
        
        if (param.type === 'number' || param.type === 'integer') {
            const range = row.querySelector('.tree-range-slider');
            const manual = row.querySelector('.tree-manual-input');
            const update = (newVal, isFinal = false) => {
                const num = parseFloat(newVal);
                currentState.globalParams[param.key] = num;
                range.value = num;
                manual.value = num;
                updateSliderFill(range);
                debouncedGenerate(isFinal);
            };
            range.oninput = (e) => update(e.target.value, false);
            range.onchange = (e) => update(e.target.value, true);
            manual.onchange = (e) => update(e.target.value, true);
            updateSliderFill(range);
        } else if (param.type === 'enum') {
            const select = row.querySelector('.tree-select');
            select.onchange = (e) => {
                currentState.globalParams[param.key] = e.target.value;
                debouncedGenerate(true);
            };
        } else if (param.type === 'boolean') {
            const checkbox = row.querySelector('input[type="checkbox"]');
            checkbox.onchange = (e) => {
                currentState.globalParams[param.key] = e.target.checked;
                debouncedGenerate(true);
            };
        }

        body.appendChild(row);
    });
}

function renderTreeParts() {
    const body = document.getElementById('tg-parts-body');
    if (!body || !currentState.template?.parts) return;

    body.innerHTML = '';
    currentState.template.parts.forEach(part => {
        const isActive = currentState.activePart === part.id;
        const isVisible = currentState.partVisibility[part.id] !== false;
        const hasClip = currentState.partCollisions?.has(part.id) ?? false;
        
        const row = document.createElement('div');
        row.className = `tree-item part-row${isActive ? ' active' : ''}${hasClip ? ' part-clipping' : ''}`;
        row.dataset.partId = part.id;
        
        const clipIcon = hasClip ? `<span class="part-clip-warn" style="color:var(--warning);margin-left:4px;" title="Overlapping parts - clipping detected">⚠</span>` : '';
        
        row.innerHTML = `
            <div class="tree-indent"></div>
            <div class="part-color-dot" style="background:${part.color || '#888'}"></div>
            <span class="material-symbols-outlined item-icon">layers</span>
            <span class="item-label">${part.name || part.id}${clipIcon}</span>
            <div class="item-actions">
                <button class="part-vis-btn${isVisible ? '' : ' hidden-part'}" data-part-id="${part.id}" title="${isVisible ? 'Hide part' : 'Show part'}">
                    ${isVisible 
                        ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>'
                        : '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>'}
                </button>
                <button class="part-delete-btn" data-part-id="${part.id}" title="Remove part">×</button>
            </div>
        `;
        body.appendChild(row);
    });
}

function renderTreeComponents() {
    const body = document.getElementById('tg-components-body');
    if (!body) return;

    const components = currentState.sceneComponents || [];
    if (components.length === 0) {
        body.innerHTML = '<div class="tree-empty-msg">No components inserted</div>';
        return;
    }

    const manifest = getAssetManifest();

    body.innerHTML = '';
    components.forEach(c => {
        const isVis = currentState.componentVisible[c.id] !== false;
        const asset = manifest.find(a => a.id === c.assetId);
        const cps = (c.showConnectionPoints && asset?.connection_points) || [];

        const cpTypeCounts = {};
        cps.forEach(cp => { cpTypeCounts[cp.type] = (cpTypeCounts[cp.type] || 0) + 1; });
        const cpBadges = Object.entries(cpTypeCounts).map(([type, count]) => {
            const hex = '#' + ((CP_TYPE_COLORS[type] ?? CP_TYPE_COLORS.generic) >>> 0).toString(16).padStart(6, '0');
            const label = CP_TYPE_LABEL[type] ?? type;
            return `<span class="cp-badge" style="background:${hex}22;border-color:${hex};color:${hex}" title="${label}">${count > 1 ? count + '×' : ''}${label}</span>`;
        }).join('');

        const row = document.createElement('div');
        row.className = 'tree-item component-row';
        row.dataset.componentId = c.id;

        row.innerHTML = `
            <div class="tree-indent"></div>
            <div class="part-color-dot" style="background:${c.color || '#fff'}"></div>
            <span class="material-symbols-outlined item-icon">extension</span>
            <div class="component-body">
                <span class="item-label">${c.name}</span>
                ${cpBadges ? `<div class="cp-badge-row">${cpBadges}</div>` : ''}
            </div>
            <div class="item-actions">
                <button class="part-vis-btn component-vis-btn${isVis ? '' : ' hidden-part'}" data-component-id="${c.id}" title="${isVis ? 'Hide' : 'Show'}">
                    ${isVis
                        ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>'
                        : '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>'}
                </button>
                <button class="part-delete-btn component-del-btn" data-component-id="${c.id}" title="Remove component">×</button>
            </div>
        `;
        body.appendChild(row);
    });
}

function bindTreeEvents() {
    const globToggle = document.getElementById('tg-globals-toggle');
    if (globToggle) {
        globToggle.onclick = () => {
            currentState.treeCollapse.globals = !currentState.treeCollapse.globals;
            renderLayersTab();
        };
    }

    const partsToggle = document.getElementById('tg-parts-toggle');
    if (partsToggle) {
        partsToggle.onclick = () => {
            currentState.treeCollapse.parts = !currentState.treeCollapse.parts;
            renderLayersTab();
        };
    }

    const compToggle = document.getElementById('tg-components-toggle');
    if (compToggle) {
        compToggle.onclick = () => {
            currentState.treeCollapse.components = !currentState.treeCollapse.components;
            renderLayersTab();
        };
    }

    const miniAddBtn = document.getElementById('tree-add-part');
    if (miniAddBtn) {
        miniAddBtn.onclick = (e) => {
            e.stopPropagation();
            addNewPart();
        };
    }

    document.querySelectorAll('.part-row').forEach(row => {
        row.addEventListener('click', (e) => {
            if (e.target.closest('.part-vis-btn') || e.target.closest('.part-delete-btn')) return;
            setActivePart(row.dataset.partId);
        });
    });

    document.querySelectorAll('.part-row .part-vis-btn').forEach(btn => {
        btn.onclick = (e) => {
            e.stopPropagation();
            togglePartVisibility(btn.dataset.partId);
        };
    });

    document.querySelectorAll('.part-row .part-delete-btn').forEach(btn => {
        btn.onclick = (e) => {
            e.stopPropagation();
            deletePartById(btn.dataset.partId);
        };
    });

    document.querySelectorAll('.component-vis-btn').forEach(btn => {
        btn.onclick = (e) => {
            e.stopPropagation();
            const id = btn.dataset.componentId;
            currentState.componentVisible[id] = !(currentState.componentVisible[id] !== false);
            if (mainViewport?.componentMeshes?.[id]) {
                mainViewport.componentMeshes[id].visible = currentState.componentVisible[id];
            }
            renderTreeComponents();
            bindTreeEvents();
        };
    });

    document.querySelectorAll('.component-del-btn').forEach(btn => {
        btn.onclick = (e) => {
            e.stopPropagation();
            const id = btn.dataset.componentId;
            currentState.sceneComponents = currentState.sceneComponents.filter(c => c.id !== id);
            delete currentState.componentVisible[id];
            triggerComponentRender();
            renderLayersTab();
        };
    });
}

function setActivePart(partId) {
    currentState.activePart = partId;

    // Refresh layers list highlight
    document.querySelectorAll('.part-row').forEach(row => {
        row.classList.toggle('active', row.dataset.partId === partId);
    });

    // Highlight active mesh in viewport
    updatePartHighlight();

    // Re-render Parameters tab (now lives in right panel)
    renderParametersMultiPart();

    // Sync code editor if Script tab is open
    if (currentState.editMode === 'code') syncCodeEditorToActivePart();
}

function togglePartVisibility(partId) {
    const isVisible = currentState.partVisibility[partId] !== false;
    currentState.partVisibility[partId] = !isVisible;

    // Update mesh visibility
    if (mainViewport?.partMeshes?.[partId]) {
        mainViewport.partMeshes[partId].visible = !isVisible;
    }

    // Re-render layers list to update eye icon
    renderPartsList();
    bindLayersTabEvents();
}

function deletePartById(partId) {
    const template = currentState.template;
    if (!template?.parts) return;
    if (template.parts.length <= 1) { alert('A model must have at least one part.'); return; }
    template.parts = template.parts.filter(p => p.id !== partId);
    delete currentState.partParams[partId];
    delete currentState.partVisibility[partId];
    delete currentState.partMeshes[partId];
    if (currentState.activePart === partId) currentState.activePart = template.parts[0]?.id || null;
    renderLayersTab();
    renderParametersMultiPart();
    triggerGeneration(true);
}

function addNewPart() {
    const template = currentState.template;
    if (!template?.parts) return;
    const newId = `part_${Date.now()}`;
    const colors = ['#a78bfa', '#fb923c', '#34d399', '#f472b6', '#38bdf8'];
    const color = colors[template.parts.length % colors.length];
    const newPart = {
        id: newId,
        name: `Part ${template.parts.length + 1}`,
        color,
        ui_parameters: [],
        source: `// ${newId}\ncube([20, 20, 20], center=true);`
    };
    template.parts.push(newPart);
    currentState.partParams[newId] = {};
    currentState.partVisibility[newId] = true;
    renderLayersTab();
    setActivePart(newId);
    switchTab('code');
}

function updatePartHighlight() {
    if (!mainViewport?.partMeshes) return;
    Object.entries(mainViewport.partMeshes).forEach(([partId, mesh]) => {
        if (!mesh?.material) return;
        const part = currentState.template?.parts?.find(p => p.id === partId);
        const baseColor = part?.color || '#c8bdb2';
        if (partId === currentState.activePart) {
            mesh.material.emissive = new THREE.Color(baseColor).multiplyScalar(0.18);
        } else {
            mesh.material.emissive = new THREE.Color(0x000000);
        }
    });
}

function renderParametersMultiPart() {
    const container = document.getElementById('parameters-container');
    if (!container) return;
    container.innerHTML = '';

    const template = currentState.template;
    if (!template) return;

    if (!currentState.activePart) {
        // Model-level view: show global params + hint
        if (template.global_parameters?.length) {
            const label = document.createElement('div');
            label.className = 'params-section-label';
            label.textContent = 'Global Parameters';
            container.appendChild(label);
            template.global_parameters.forEach(param => {
                const val = currentState.globalParams[param.key] ?? param.default;
                container.appendChild(buildParamGroup(param, val, (newVal, isFinal) => {
                    currentState.globalParams[param.key] = newVal;
                    debouncedGenerate(isFinal);
                }));
            });
        }

        const hint = document.createElement('div');
        hint.style.cssText = 'padding:16px;font-size:12px;color:var(--text-muted);text-align:center;border-top:1px solid var(--border-subtle);margin-top:8px';
        hint.textContent = 'Select a part in the Layers tab to edit its parameters.';
        container.appendChild(hint);
        return;
    }

    const part = template.parts?.find(p => p.id === currentState.activePart);
    if (!part) return;

    // Breadcrumb header
    const header = document.createElement('div');
    header.className = 'part-params-header';
    header.innerHTML = `
        <span class="part-params-back" title="Back to model view">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg>
        </span>
        <div class="part-params-color-dot" style="background:${part.color || '#888'}"></div>
        <span class="part-params-name">${part.name}</span>`;
    header.onclick = () => { currentState.activePart = null; renderParametersMultiPart(); renderPartsList(); bindLayersTabEvents(); };
    container.appendChild(header);

    // Part-specific params
    if (part.ui_parameters?.length) {
        const label = document.createElement('div');
        label.className = 'params-section-label';
        label.textContent = 'Part Parameters';
        container.appendChild(label);
        part.ui_parameters.forEach(param => {
            const val = currentState.partParams[part.id]?.[param.key] ?? param.default;
            container.appendChild(buildParamGroup(param, val, (newVal, isFinal) => {
                if (!currentState.partParams[part.id]) currentState.partParams[part.id] = {};
                currentState.partParams[part.id][param.key] = newVal;
                debouncedGenerate(isFinal);
            }));
        });
    } else {
        const noParams = document.createElement('div');
        noParams.style.cssText = 'padding:12px 16px;font-size:12px;color:var(--text-muted)';
        noParams.textContent = 'No part-specific parameters. Switch to Script tab to add some.';
        container.appendChild(noParams);
    }

    // Global params (collapsible)
    if (template.global_parameters?.length) {
        const label = document.createElement('div');
        label.className = 'params-section-label';
        label.textContent = 'Global Parameters';
        container.appendChild(label);
        template.global_parameters.forEach(param => {
            const val = currentState.globalParams[param.key] ?? param.default;
            container.appendChild(buildParamGroup(param, val, (newVal, isFinal) => {
                currentState.globalParams[param.key] = newVal;
                debouncedGenerate(isFinal);
            }));
        });
    }
}

// Reusable parameter group builder (used by both single-part and multi-part)
function buildParamGroup(param, currentValue, onChange) {
    const group = document.createElement('div');
    group.className = `parameter-group type-${param.type}`;

    let inputHtml = '';
    if (param.type === 'number' || param.type === 'integer') {
        const unit = param.unit ? `<span class="param-unit">${param.unit}</span>` : '';
        inputHtml = `
            <div class="param-label">
                <span>${param.label}</span>
                <div class="param-value-wrap">
                    <input type="number" class="manual-input" value="${currentValue}" step="${param.step || 1}">${unit}
                </div>
            </div>
            <input type="range" min="${param.min ?? 0}" max="${param.max ?? 100}" step="${param.step || 1}" value="${currentValue}">`;
    } else if (param.type === 'enum') {
        const opts = (param.options || []).map(o => `<option value="${o}" ${currentValue === o ? 'selected' : ''}>${o}</option>`).join('');
        inputHtml = `<div class="param-label"><span>${param.label}</span></div><select class="glass-select">${opts}</select>`;
    } else if (param.type === 'boolean') {
        inputHtml = `<div class="param-label"><span>${param.label}</span><label class="switch"><input type="checkbox" ${currentValue ? 'checked' : ''}><span class="slider-round"></span></label></div>`;
    } else if (param.type === 'string') {
        inputHtml = `<div class="param-label"><span>${param.label}</span></div><input type="text" class="glass-input" value="${currentValue || ''}">`;
    }

    group.innerHTML = inputHtml;

    if (param.type === 'number' || param.type === 'integer') {
        const range = group.querySelector('input[type="range"]');
        const manual = group.querySelector('input[type="number"]');
        const update = (val, isFinal) => {
            const v = parseFloat(val);
            range.value = v; manual.value = v;
            updateSliderFill(range);
            onChange(v, isFinal);
        };
        range.oninput = e => { currentState.isMovingSlider = true; update(e.target.value, false); };
        range.onchange = e => { currentState.isMovingSlider = false; update(e.target.value, true); };
        manual.onchange = e => update(e.target.value, true);
        updateSliderFill(range);
    } else if (param.type === 'enum') {
        group.querySelector('select').onchange = e => onChange(e.target.value, true);
    } else if (param.type === 'boolean') {
        group.querySelector('input[type="checkbox"]').onchange = e => onChange(e.target.checked, true);
    } else if (param.type === 'string') {
        group.querySelector('input[type="text"]').onchange = e => onChange(e.target.value, true);
    }

    return group;
}

function syncCodeEditorToActivePart() {
    const editor = document.getElementById('code-editor');
    if (!editor || !isMultiPart()) return;

    if (!currentState.activePart) {
        // Read-only combined view
        const template = currentState.template;
        const globalDecls = (template.global_parameters || []).map(p =>
            `// ${p.label}\n${p.key} = ${currentState.globalParams[p.key] ?? p.default};`
        ).join('\n');
        const partsSource = (template.parts || []).map(part =>
            `// ═══ PART: ${part.name} ═══\n${part.source || ''}`
        ).join('\n\n');
        editor.value = `// ═══ GLOBAL PARAMETERS (read-only — select a part to edit) ═══\n${globalDecls}\n\n${partsSource}`;
        editor.setAttribute('readonly', 'true');
        editor.style.opacity = '0.55';
    } else {
        const part = currentState.template.parts?.find(p => p.id === currentState.activePart);
        if (part) {
            editor.value = part.source || '';
            editor.removeAttribute('readonly');
            editor.style.opacity = '1';
        }
    }
}

// ── Multi-Part: State Init ───────────────────────────────────────────────────

function initMultiPartState(template) {
    currentState.activePart = null;
    currentState.globalParams = {};
    currentState.partParams = {};
    currentState.partVisibility = {};
    currentState.partMeshes = {};
    currentState.partCollisions = new Set();

    (template.global_parameters || []).forEach(p => {
        currentState.globalParams[p.key] = p.default;
    });
    (template.parts || []).forEach(part => {
        currentState.partParams[part.id] = {};
        currentState.partVisibility[part.id] = true;
        (part.ui_parameters || []).forEach(p => {
            currentState.partParams[part.id][p.key] = p.default;
        });
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
    const isFinal = isFinalRequested !== null ? isFinalRequested : !currentState.isMovingSlider;

    // Route multi-part templates to separate pipeline
    if (isMultiPart()) {
        triggerGenerationMultiPart(startTime, isFinal);
        return;
    }

    const isTurbo = currentState.params.PERFORMANCE_MODE !== false;

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
                if (window._aiApplyPending) window._aiRenderError = data.error;
            }

            pendingParts--;
            if (pendingParts === 0) {
                finalizeModularRender(partGeometries, startTime, isFinal);
            }
        });
    });
}

/**
 * Shared compile-error repair handler for both single-part and multi-part renders.
 * Categorizes the WASM error, builds a targeted correction prompt, and re-runs
 * the AI pipeline up to MAX_COMPILE_RETRIES times.
 */
function _triggerCompileRepair(compileErr, source) {
    window._aiRepairAttempt = (window._aiRepairAttempt || 0) + 1;
    const attempt = window._aiRepairAttempt;

    window._aiApplyPending = false;
    window._aiRenderError = null;
    const ctx = window._aiCorrectCtx;
    window._aiCorrectCtx = null;

    const provider = localStorage.getItem('paraform_ai_provider') || 'local';

    const log = PipelineLog.startRun(`repair:${source}:attempt${attempt}`);
    const { category, hint } = categorizeWasmError(compileErr);
    log.stage('categorize', 'ok', category);

    if (!ctx || provider === 'local') {
        log.stage('repair', 'error', 'No context or local provider — cannot repair');
        log.finish();
        const shortErr = compileErr.split('\n').filter(l => l.trim()).slice(0, 8).join('\n');
        appendChatMessage('system',
            `<span class="material-symbols-outlined">error_outline</span> <strong>Compile error [${category}]:</strong>` +
            `<pre style="margin:6px 0 0;font-size:11px;white-space:pre-wrap;color:var(--text-secondary)">${escapeHtml(shortErr)}</pre>`);
        return;
    }

    if (attempt > MAX_COMPILE_RETRIES) {
        log.stage('repair', 'error', `Exceeded max retries (${MAX_COMPILE_RETRIES})`);
        log.finish();
        const shortErr = compileErr.split('\n').filter(l => l.trim()).slice(0, 8).join('\n');
        appendChatMessage('system',
            `<span class="material-symbols-outlined">error_outline</span> <strong>Auto-correction gave up after ${MAX_COMPILE_RETRIES} attempts [${category}]:</strong>` +
            `<pre style="margin:6px 0 0;font-size:11px;white-space:pre-wrap;color:var(--text-secondary)">${escapeHtml(shortErr)}</pre>` +
            `<div style="margin-top:6px;font-size:11px;color:var(--text-muted)">Try rephrasing your request or simplifying the geometry.</div>`);
        return;
    }

    const shortErr = compileErr.split('\n').filter(l => l.trim()).slice(0, 6).join('\n');
    appendChatMessage('system',
        `<span class="material-symbols-outlined">autorenew</span> <strong>Compile error [${category}] — auto-correcting (${attempt}/${MAX_COMPILE_RETRIES})...</strong>` +
        `<pre style="margin:6px 0 0;font-size:11px;white-space:pre-wrap;color:var(--text-secondary)">${escapeHtml(shortErr)}</pre>` +
        `<div style="margin-top:4px;font-size:11px;color:var(--text-muted)">Fix: ${escapeHtml(hint)}</div>`);

    createAILoadingBubble(`Auto-correcting (${attempt}/${MAX_COMPILE_RETRIES})`);
    log.stage('repair', 'ok', `dispatching attempt ${attempt}`);
    log.finish();

    const injectedCorrection = buildRepairMessages(category, hint, compileErr, ctx.pendingCode, attempt, MAX_COMPILE_RETRIES);
    runAIGenerationPipeline('', ctx.previousState, injectedCorrection)
        .catch(err => {
            appendChatMessage('system', `<span class="material-symbols-outlined">error_outline</span> Auto-correction failed: ${escapeHtml(err.message)}`);
        })
        .finally(() => { removeAILoadingBubble(); });
}

function finalizeModularRender(geometries, startTime, isFinal) {
    document.getElementById('loader-overlay').classList.add('hidden');
    const badge = document.getElementById('status-badge');
    
    if (geometries.size === 0) {
        badge.innerText = 'Render Failed';
        badge.className = 'error';
        if (window._aiApplyPending && window._aiRenderError) {
            _triggerCompileRepair(window._aiRenderError, 'single-part');
        } else {
            window._aiApplyPending = false;
            window._aiRenderError = null;
        }
        return;
    }
    window._aiApplyPending = false;
    window._aiRenderError = null;
    window._aiCorrectCtx = null;
    window._aiRepairAttempt = 0;

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

// ── Multi-Part Compilation Pipeline ─────────────────────────────────────────

function buildPartSource(partId, isFinal) {
    const template = currentState.template;
    const part = template.parts.find(p => p.id === partId);
    if (!part) return '';

    const globalDecls = (template.global_parameters || []).map(p =>
        formatParamDecl(p, currentState.globalParams[p.key] ?? p.default)
    ).join('\n');

    const partDecls = (part.ui_parameters || []).map(p =>
        formatParamDecl(p, currentState.partParams[partId]?.[p.key] ?? p.default)
    ).join('\n');

    const fnVal = isFinal ? 64 : 12;
    return `// ParaForm — Part: ${part.name}\n$fn = ${fnVal};\n${globalDecls}\n${partDecls}\n${part.source || ''}`;
}

function triggerGenerationMultiPart(startTime, isFinal) {
    const template = currentState.template;
    if (!template?.parts?.length) return;

    // Clear old part group from scene
    if (mainViewport?.currentMesh?.userData?.isPartGroup) {
        if (mainViewport.transformControls) mainViewport.transformControls.detach();
        mainViewport.scene.remove(mainViewport.currentMesh);
        mainViewport.currentMesh = null;
    }
    mainViewport.partMeshes = {};

    const visibleParts = template.parts.filter(p => currentState.partVisibility[p.id] !== false);
    if (visibleParts.length === 0) {
        document.getElementById('status-badge').innerText = 'No visible parts';
        document.getElementById('status-badge').className = '';
        currentState.isGenerating = false;
        return;
    }

    let pending = visibleParts.length;
    const partGeometries = new Map(); // partId → { geom, color }
    // Capture generation ID so stale callbacks can be detected
    const capturedJobId = currentState.jobId;

    visibleParts.forEach(part => {
        // Fast preview via localPreview if dragging slider
        if (!isFinal && part.localPreview) {
            try {
                const geom = part.localPreview(
                    currentState.globalParams,
                    currentState.partParams[part.id] || {},
                    mainViewport?.material
                );
                partGeometries.set(part.id, { geom, color: part.color });
                if (--pending === 0) finalizeMultiPartRender(partGeometries, startTime, isFinal);
                return;
            } catch (e) { /* fall through to WASM */ }
        }

        // Full WASM compilation — each part gets a unique pool task ID so their
        // callbacks don't overwrite each other in the pool's callbacks Map.
        const taskId = ++_multiPartTaskCounter;
        const source = buildPartSource(part.id, isFinal);
        pool.requestRender({
            jobId: taskId,
            partId: part.id,
            sourceCode: source,
            format: 'stl',
            isFinal: true, // always keep in queue; stale check via capturedJobId
            context: 'main'
        }, (data) => {
            if (capturedJobId !== currentState.jobId) return; // stale generation
            if (data.ok) {
                const geom = new STLLoader().parse(data.buffer);
                partGeometries.set(part.id, { geom, color: part.color });
            } else if (data.error && !data.error.includes('Terminated')) {
                console.error(`[Multi-Part] Part "${part.name}" failed:`, data.error);
                if (window._aiApplyPending && !window._aiRenderError) {
                    window._aiRenderError = data.error; // capture first failing part's error
                }
            }
            if (--pending === 0) finalizeMultiPartRender(partGeometries, startTime, isFinal);
        });
    });
}

function finalizeMultiPartRender(partGeometries, startTime, isFinal) {
    document.getElementById('loader-overlay').classList.add('hidden');
    const badge = document.getElementById('status-badge');

    if (partGeometries.size === 0) {
        badge.innerText = 'Render Failed'; badge.className = 'error';
        currentState.isGenerating = false;
        if (window._aiApplyPending && window._aiRenderError) {
            _triggerCompileRepair(window._aiRenderError, 'multi-part');
        } else {
            window._aiApplyPending = false;
            window._aiRenderError = null;
        }
        return;
    }

    // Build a group containing one mesh per part
    const group = new THREE.Group();
    group.userData.isPartGroup = true;
    let totalPolys = 0;

    partGeometries.forEach(({ geom, color }, partId) => {
        geom.computeVertexNormals();
        const mat = new THREE.MeshStandardMaterial({
            color: new THREE.Color(color || '#c8bdb2'),
            roughness: 0.35, metalness: 0.15,
        });
        const mesh = new THREE.Mesh(geom, mat);
        mesh.userData.partId = partId;
        group.add(mesh);
        mainViewport.partMeshes[partId] = mesh;
        totalPolys += geom.attributes.position?.count / 3 || 0;
    });

    // Center the whole assembly on the floor
    const box = new THREE.Box3().setFromObject(group);
    const center = new THREE.Vector3();
    box.getCenter(center);
    const minY = box.min.y;
    group.children.forEach(mesh => {
        mesh.geometry.translate(-center.x, -minY, -center.z);
        mesh.geometry.computeBoundingBox();
        mesh.geometry.computeVertexNormals();
    });

    // ── Bounding-box collision detection ───────────────────────────────────
    // Rebuild per-part boxes after centering (geometry was translated in-place)
    const collisionBoxes = new Map();
    group.children.forEach(mesh => {
        if (mesh.userData.partId) {
            collisionBoxes.set(mesh.userData.partId, new THREE.Box3().setFromObject(mesh));
        }
    });
    const newCollisions = new Set();
    const candidatePairs = []; // pairs surviving broad-phase, passed to exact WASM tests
    const pidList = [...collisionBoxes.keys()];
    for (let i = 0; i < pidList.length; i++) {
        for (let j = i + 1; j < pidList.length; j++) {
            const bA = collisionBoxes.get(pidList[i]);
            const bB = collisionBoxes.get(pidList[j]);
            if (bA.intersectsBox(bB)) {
                // Measure the overlap volume — ignore face-touches (< 1 mm on any axis)
                const isect = bA.clone().intersect(bB);
                const sz = new THREE.Vector3();
                isect.getSize(sz);
                if (sz.x > 1 && sz.y > 1 && sz.z > 1) {
                    newCollisions.add(pidList[i]);
                    newCollisions.add(pidList[j]);
                    candidatePairs.push([pidList[i], pidList[j]]);
                }
            }
        }
    }
    currentState.partCollisions = newCollisions;
    if (newCollisions.size > 0) {
        const partDefs = currentState.template?.parts || [];
        const names = [...newCollisions]
            .map(id => partDefs.find(p => p.id === id)?.name || id)
            .join(', ');
        console.warn(`[Assembly] Clipping detected — overlapping parts: ${names}`);
        // Refresh Layers tab so ⚠ icons appear immediately
        if (currentState.editMode === 'layers') renderLayersTab();
    } else if (currentState.editMode === 'layers') {
        renderLayersTab();   // clear any previous ⚠ icons
    }

    // Detach old gizmo, remove old mesh, add new group
    if (mainViewport.transformControls) mainViewport.transformControls.detach();
    if (mainViewport.currentMesh) mainViewport.scene.remove(mainViewport.currentMesh);
    mainViewport.currentMesh = group;
    mainViewport.edgeMesh = null;

    applyObjectTransform();
    drawBuildPlate();
    updateLightingSettings();
    mainViewport.scene.add(group);
    applyDisplayMode(displayMode);
    updateSelectionHighlight();
    updatePartHighlight();

    document.getElementById('stats-poly').innerText = `Polys: ${Math.round(totalPolys).toLocaleString()}`;
    badge.innerText = isFinal ? 'Render Ready' : 'Turbo Preview';
    badge.className = isFinal ? 'success' : 'info';
    document.getElementById('render-time').innerText = `${Math.round(performance.now() - startTime)}ms`;
    currentState.isGenerating = false;

    window.dispatchEvent(new CustomEvent('render-complete', { detail: { isFinal } }));
    if (isFinal) {
        saveHistoryState();
        setTimeout(generateActiveThumbnail, 500);
        // M3 — kick off exact WASM clash + tool-access validation (non-blocking)
        scheduleValidation(candidatePairs);
    }
}

// M3 — async validation pass that refines the broad-phase collision set and
// checks tool-access corridors. Runs after every final render, non-blocking.
function scheduleValidation(candidatePairs) {
    if (!currentState.template?.parts?.length) return;
    const partSources = new Map(
        currentState.template.parts.map(p => [p.id, buildPartSource(p.id, true)])
    );

    // Exact mesh-intersection clash tests for broad-phase survivors
    runExactClashTests(candidatePairs, partSources, (exactClashers) => {
        currentState.partCollisions = exactClashers;
        if (currentState.editMode === 'layers') renderLayersTab();
        if (exactClashers.size > 0) {
            const names = [...exactClashers]
                .map(id => currentState.template.parts.find(p => p.id === id)?.name || id)
                .join(', ');
            console.warn(`[Clash] Exact overlap confirmed: ${names}`);
        }
    });

    // Tool-access corridor tests for every fastener_m*_cap() call
    runToolAccessTests(partSources, ({ blocked }) => {
        if (blocked.length > 0) {
            const desc = blocked.map(b => `${b.fastener} in "${b.partId}" blocked by "${b.blocker}"`).join('; ');
            console.warn(`[ToolAccess] Blocked corridors: ${desc}`);
        }
    });
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
    mainViewport.edgeMesh = null; // Reset — applyDisplayMode will recreate if needed
    applyDisplayMode(displayMode);

    // Update selection outline box helper and attach active gizmo controls
    updateSelectionHighlight();

    document.getElementById('stats-poly').innerText = `Polys: ${Math.round(geometry.attributes.position.count / 3).toLocaleString()}`;
}

// --- DISPLAY MODE ---

function applyDisplayMode(mode) {
    displayMode = mode;
    if (!mainViewport || !mainViewport.currentMesh) return;

    const isGroup = mainViewport.currentMesh.userData?.isPartGroup;

    if (isGroup) {
        // Multi-part: apply per-child mesh
        mainViewport.currentMesh.children.forEach(mesh => {
            if (!mesh.isMesh) return;
            // Remove old edge overlay from this child
            const oldEdge = mesh.children.find(c => c.userData.isEdgeMesh);
            if (oldEdge) { mesh.remove(oldEdge); oldEdge.geometry.dispose(); oldEdge.material.dispose(); }

            mesh.material.wireframe = (mode === 'wireframe' || mode === 'wireframe-edges');

            if (mode === 'shaded-edges' || mode === 'wireframe-edges') {
                const edgesGeo = new THREE.EdgesGeometry(mesh.geometry, 15);
                const edgesMat = new THREE.LineBasicMaterial({
                    color: mode === 'wireframe-edges' ? 0xc07840 : 0x3a2a18,
                    opacity: mode === 'wireframe-edges' ? 0.85 : 0.5,
                    transparent: true
                });
                const edgeMesh = new THREE.LineSegments(edgesGeo, edgesMat);
                edgeMesh.userData.isEdgeMesh = true;
                mesh.add(edgeMesh);
            }
        });
    } else {
        // Single-part: existing behavior using shared material
        const mat = mainViewport.material;
        if (mainViewport.edgeMesh) {
            mainViewport.currentMesh.remove(mainViewport.edgeMesh);
            mainViewport.edgeMesh.geometry.dispose();
            mainViewport.edgeMesh.material.dispose();
            mainViewport.edgeMesh = null;
        }
        mat.wireframe = (mode === 'wireframe' || mode === 'wireframe-edges');
        if (mode === 'shaded-edges' || mode === 'wireframe-edges') {
            const edgesGeo = new THREE.EdgesGeometry(mainViewport.currentMesh.geometry, 15);
            const edgesMat = new THREE.LineBasicMaterial({
                color: mode === 'wireframe-edges' ? 0xc07840 : 0x3a2a18,
                opacity: mode === 'wireframe-edges' ? 0.85 : 0.5,
                transparent: true
            });
            mainViewport.edgeMesh = new THREE.LineSegments(edgesGeo, edgesMat);
            mainViewport.currentMesh.add(mainViewport.edgeMesh);
        }
    }

    // Sync UI
    const modeLabels = { shaded: 'Shaded', 'shaded-edges': 'Shaded + Edges', wireframe: 'Wireframe', 'wireframe-edges': 'Wire + Edges' };
    const labelEl = document.getElementById('dm-current');
    if (labelEl) labelEl.textContent = modeLabels[mode] || 'Shaded';
    document.querySelectorAll('.dm-opt').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.mode === mode);
    });
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
        hemi.color.setHex(0xfff5e8);
        hemi.groundColor.setHex(0x1a140a);
        dir.color.setHex(0xffffff);
        dir.position.set(100, 200, 80);
        fill.color.setHex(0xb0c8e0);
        fill.position.set(-80, 40, -100);
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

// initScoreboardUI removed — confidence LEDs replaced by task indicators

// ── Assets Drawer (updatex.md §3B — immutable hardware library) ────────────
function renderAssetsDrawer() {
    const list = document.getElementById('assets-drawer-list');
    if (!list) return;
    const assets = getAssetManifest();

    // Group by kind for readability.
    const byKind = assets.reduce((m, a) => {
        (m[a.kind] = m[a.kind] || []).push(a);
        return m;
    }, {});

    const KIND_LABEL = { servo: 'Servos', bearing: 'Bearings', bolt: 'Bolts & Fasteners' };

    list.innerHTML = Object.entries(byKind).map(([kind, items]) => `
        <div class="assets-group">
            <div class="assets-group-title">${KIND_LABEL[kind] || kind}</div>
            ${items.map(a => `
                <div class="assets-row" data-asset-id="${a.id}">
                    <div class="assets-row-main">
                        <div class="assets-row-label">${a.label}</div>
                        <div class="assets-row-sub">${a.anchor_description}</div>
                        <div class="assets-row-envelope">Envelope: ${a.envelope_mm.join(' × ')} mm</div>
                    </div>
                    <div class="assets-row-actions">
                        <button class="assets-insert-btn" data-asset-id="${a.id}" data-mode="mesh"      title="Add as scene component">Add</button>
                        <button class="assets-insert-btn" data-asset-id="${a.id}" data-mode="clearance" title="Add clearance volume as component">Clearance</button>
                    </div>
                </div>
            `).join('')}
        </div>
    `).join('');

    list.querySelectorAll('.assets-insert-btn').forEach(btn => {
        btn.onclick = () => addComponentToScene(btn.dataset.assetId, btn.dataset.mode);
    });
}

// Colour coding for connection-point types — shared by markers and the UI.
const CP_TYPE_COLORS = {
    servo_arm:   0xf97316,   // orange — output shaft
    screw_m2:    0xfacc15,   // yellow — M2 fastener
    screw_m3:    0xfacc15,   // yellow — M3 fastener
    snap_fit:    0x22d3ee,   // cyan   — snap interface
    shaft_bore:  0xa855f7,   // purple — rotary bore
    press_fit:   0x3b82f6,   // blue   — press-fit pocket
    tool_access: 0xef4444,   // red    — tool clearance corridor
    generic:     0xe5e7eb,   // white  — untyped attachment
};

const CP_TYPE_LABEL = {
    servo_arm:   'Servo arm',
    screw_m2:    'M2 screw',
    screw_m3:    'M3 screw',
    snap_fit:    'Snap fit',
    shaft_bore:  'Shaft bore',
    press_fit:   'Press fit',
    tool_access: 'Tool access',
    generic:     'Attachment',
};

// Add an asset from the library as an independent scene component.
// Components are solid, first-class scene objects — not overlays or reference ghosts.
function addComponentToScene(assetId, mode) {
    const asset = getAssetManifest().find(a => a.id === assetId);
    if (!asset) return;

    const moduleName = mode === 'clearance' ? asset.clearance_module : asset.mesh_module;
    const colors = ['#fb923c', '#34d399', '#f472b6', '#38bdf8', '#a78bfa'];
    const id = `component_${assetId}_${mode}_${Date.now()}`;
    const idx = currentState.sceneComponents.length;

    currentState.sceneComponents.push({
        id,
        assetId,
        mode,
        name: `${asset.label}${mode === 'clearance' ? ' (Clearance)' : ''}`,
        color: colors[idx % colors.length],
        source: `// @dependency ${asset.file}\nuse <${asset.file}>\n${moduleName}();\n`,
        // World-space placement — start staggered so nothing overlaps the main model
        position: [60 * (idx + 1), 0, 0],
        rotation: [0, 0, 0],
        // Connection points live in the asset manifest; we reference them by assetId.
        // Only mesh-mode components expose connection points (clearance volumes don't).
        showConnectionPoints: mode === 'mesh',
    });
    currentState.componentVisible[id] = true;

    renderLayersTab();
    triggerComponentRender();
}

// ─── LOCAL_ASSET_GEOMETRIES ──────────────────────────────────────────────────
// Coordinate-exact Three.js generators for known hardware assets.
// Returned geometry origin matches the SCAD model's anchor point documented
// in assets/index.json.  Tried first in triggerComponentRender to avoid
// sending simple known shapes through WASM.
function _lbox(w, d, h, ox = 0, oy = 0, oz = 0) {
    const g = new THREE.BoxGeometry(w, d, h);
    g.translate(ox, oy, oz);
    return g;
}
function _lcyl(r, h, ox = 0, oy = 0, oz = 0, segs = 32) {
    // CylinderGeometry is along Y; rotateX(π/2) makes it Z-up like SCAD.
    const g = new THREE.CylinderGeometry(r, r, h, segs);
    g.rotateX(Math.PI / 2);
    g.translate(ox, oy, oz);
    return g;
}

const LOCAL_ASSET_GEOMETRIES = {
    // ── SG90 micro servo ────────────────────────────────────────────────────
    // Body: 22.5×11.8×19.1 mm, centred at (5.5, 0, -9.55) relative to spline.
    // Tab:  32.5×11.8×2 mm strip at Z = -5 .. -3  (ears protruding ±16.25 on X).
    sg90() {
        const body = _lbox(22.5, 11.8, 19.1,  5.5,  0, -14.55);
        const tab  = _lbox(32.5, 11.8,  2.0,  5.5,  0,  -4.0);
        const cap  = _lcyl(2.3, 3.6,  0, 0, 1.8);
        const knob = _lcyl(1.5, 4.0,  0, 0, 3.6);
        return BufferGeometryUtils.mergeGeometries([body, tab, cap, knob]);
    },

    // ── MG996R standard servo ────────────────────────────────────────────────
    // Body: 40×19.7×36.1 mm, centred at (10, 0, -18.05).
    // Tab:  54×19.7×3 mm strip at Z = -7.6 .. -4.6.
    mg996r() {
        const body = _lbox(40.0, 19.7, 36.1, 10.0, 0, -25.65);
        const tab  = _lbox(54.0, 19.7,  3.0, 10.0, 0,  -6.1);
        const cap  = _lcyl(2.9, 5.2,  0, 0, 2.6);
        const knob = _lcyl(1.8, 5.0,  0, 0, 5.2);
        return BufferGeometryUtils.mergeGeometries([body, tab, cap, knob]);
    },

    // ── 608ZZ bearing ────────────────────────────────────────────────────────
    // Outer ring: Ø22 × 7 mm, inner bore: Ø8. Origin at bore centre.
    bearing_608zz() {
        try {
            const outerB = new Brush(_lcyl(11, 7));
            outerB.updateMatrixWorld();
            const innerB = new Brush(_lcyl(4, 9));
            innerB.updateMatrixWorld();
            const result = csgEvaluator.evaluate(outerB, innerB, SUBTRACTION);
            return result.geometry;
        } catch {
            // Fallback: solid disc if CSG fails (e.g., worker context)
            return _lcyl(11, 7);
        }
    },

    // ── M3×12 socket-cap bolt ────────────────────────────────────────────────
    // Shaft: Ø3 × 12 mm tip at Z=0..12. Head: Ø5.5 × 3 mm at Z=-3..0.
    bolt_m3x12() {
        const shaft = _lcyl(1.5, 12, 0, 0,  6.0);
        const head  = _lcyl(2.75, 3.0, 0, 0, -1.5);
        return BufferGeometryUtils.mergeGeometries([shaft, head]);
    },
};
// ────────────────────────────────────────────────────────────────────────────

// Compile every visible scene component independently into its own solid mesh.
// Each component lives as a separate object in the THREE.js scene — never merged
// into the template mesh — so it can be positioned and manipulated independently.
function triggerComponentRender() {
    if (!mainViewport) return;

    // Remove the previous component group without touching the model mesh.
    if (mainViewport.componentGroup) {
        mainViewport.scene.remove(mainViewport.componentGroup);
        mainViewport.componentGroup = null;
        mainViewport.componentMeshes = {};
    }

    const visible = currentState.sceneComponents.filter(
        c => currentState.componentVisible[c.id] !== false
    );
    if (visible.length === 0) return;

    const componentGroup = new THREE.Group();
    componentGroup.userData.isComponentGroup = true;
    mainViewport.componentGroup  = componentGroup;
    mainViewport.componentMeshes = {};

    let pending = visible.length;
    const addToScene = () => { if (--pending === 0) mainViewport.scene.add(componentGroup); };

    const placeMesh = (component, geom) => {
        geom.computeVertexNormals();
        const mat = new THREE.MeshStandardMaterial({
            color: new THREE.Color(component.color),
            roughness: 0.35, metalness: 0.15,
        });
        const mesh = new THREE.Mesh(geom, mat);
        mesh.userData.componentId = component.id;

        const [px, py, pz] = component.position || [0, 0, 0];
        const [rx, ry, rz] = component.rotation || [0, 0, 0];
        mesh.position.set(px, py, pz);
        mesh.rotation.set(rx * Math.PI / 180, ry * Math.PI / 180, rz * Math.PI / 180);

        if (component.showConnectionPoints) buildConnectionPointMarkers(component, mesh);
        componentGroup.add(mesh);
        mainViewport.componentMeshes[component.id] = mesh;
    };

    visible.forEach(component => {
        const log = PipelineLog.startRun(`component:${component.id}`);

        // ── Fast path: local geometry generator ──────────────────────────────
        const localGen = LOCAL_ASSET_GEOMETRIES[component.assetId];
        if (localGen) {
            try {
                const geom = localGen();
                log.stage('local-geometry', 'ok', component.assetId);
                placeMesh(component, geom);
                log.finish();
                addToScene();
                return;
            } catch (err) {
                log.stage('local-geometry', 'warn', String(err));
                // fall through to WASM
            }
        }

        // ── Slow path: WASM compile ───────────────────────────────────────────
        if (!component.source) {
            log.stage('wasm-compile', 'error', 'No source code for component');
            log.finish();
            addToScene();
            return;
        }
        log.stage('wasm-queued', 'ok');
        const source = `// Component: ${component.name}\n$fn = 64;\n${component.source}`;
        const taskId = ++_multiPartTaskCounter;
        pool.requestRender(
            { jobId: taskId, partId: component.id, sourceCode: source, format: 'stl', isFinal: true, context: 'component' },
            (data) => {
                if (data.ok) {
                    try {
                        const geom = new STLLoader().parse(data.buffer);
                        log.stage('wasm-compile', 'ok', `${(data.buffer.byteLength / 1024).toFixed(1)} KB`);
                        placeMesh(component, geom);
                    } catch (parseErr) {
                        log.stage('stl-parse', 'error', String(parseErr));
                    }
                } else {
                    log.stage('wasm-compile', 'error', data.error || 'WASM returned ok=false');
                }
                log.finish();
                addToScene();
            }
        );
    });
}

// Build small visual markers for every connection point on a component.
// Markers are added as children of the mesh so they transform with it.
function buildConnectionPointMarkers(component, mesh) {
    const asset = getAssetManifest().find(a => a.id === component.assetId);
    if (!asset?.connection_points?.length) return;

    asset.connection_points.forEach(cp => {
        const color = CP_TYPE_COLORS[cp.type] ?? CP_TYPE_COLORS.generic;

        // Sphere at the connection point origin
        const sphere = new THREE.Mesh(
            new THREE.SphereGeometry(1.5, 10, 10),
            new THREE.MeshBasicMaterial({ color, depthTest: false })
        );
        sphere.position.set(...cp.position);
        sphere.renderOrder = 999;
        sphere.userData.isConnectionPoint = true;
        sphere.userData.cpId   = cp.id;
        sphere.userData.cpName = cp.name;
        sphere.userData.cpType = cp.type;
        mesh.add(sphere);

        // Arrow showing the interface normal / direction
        const dir    = new THREE.Vector3(...cp.normal).normalize();
        const origin = new THREE.Vector3(...cp.position);
        const arrow  = new THREE.ArrowHelper(dir, origin, 8, color, 3, 1.8);
        arrow.renderOrder = 999;
        arrow.userData.isConnectionPoint = true;
        mesh.add(arrow);
    });
}

function initRightPanelControls() {
    // 1. Right panel tabs switching
    const rightTabs = document.querySelectorAll('.right-tab-btn');
    const rightTabContents = ['params', 'ai', 'transform', 'env-mat', 'assets'];

    rightTabs.forEach(tab => {
        tab.onclick = () => {
            rightTabs.forEach(btn => btn.classList.remove('active'));
            tab.classList.add('active');

            rightTabContents.forEach(id => {
                const el = document.getElementById(`right-tab-${id}`);
                if (el) el.classList.add('hidden');
            });

            const targetEl = document.getElementById(`right-tab-${tab.dataset.rightTab}`);
            if (targetEl) targetEl.classList.remove('hidden');

            if (tab.dataset.rightTab === 'params') renderParameters();
            if (tab.dataset.rightTab === 'assets') renderAssetsDrawer();
        };
    });

    // Render parameters into right panel on init (params tab is default active)
    renderParameters();

    // 1b. Panel collapse buttons
    document.querySelectorAll('.panel-collapse-btn').forEach(btn => {
        btn.onclick = () => {
            const panel = document.getElementById(btn.dataset.panel);
            if (panel) panel.classList.toggle('collapsed');
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

        updateSliderFill(moveX); updateSliderFill(moveY); updateSliderFill(moveZ);
        applyObjectTransform();
    };

    if (moveX) { moveX.oninput = updateMove; updateSliderFill(moveX); }
    if (moveY) { moveY.oninput = updateMove; updateSliderFill(moveY); }
    if (moveZ) { moveZ.oninput = updateMove; updateSliderFill(moveZ); }
    
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

        updateSliderFill(rotX); updateSliderFill(rotY); updateSliderFill(rotZ);
        applyObjectTransform();
    };

    if (rotX) { rotX.oninput = updateRot; updateSliderFill(rotX); }
    if (rotY) { rotY.oninput = updateRot; updateSliderFill(rotY); }
    if (rotZ) { rotZ.oninput = updateRot; updateSliderFill(rotZ); }
    
    // 4. Scale slider
    const scaleRange = document.getElementById('trans-scale');
    const lblScale = document.getElementById('lbl-scale');
    if (scaleRange) {
        scaleRange.oninput = () => {
            currentState.viewportState.scale = parseFloat(scaleRange.value);
            if (lblScale) lblScale.innerText = `${scaleRange.value}x`;
            updateSliderFill(scaleRange);
            applyObjectTransform();
        };
        updateSliderFill(scaleRange);
    }
    
    // 5. Reset Transform button
    const btnReset = document.getElementById('btn-reset-transform');
    if (btnReset) {
        btnReset.onclick = () => {
            if (moveX) { moveX.value = 0; updateSliderFill(moveX); }
            if (moveY) { moveY.value = 0; updateSliderFill(moveY); }
            if (moveZ) { moveZ.value = 0; updateSliderFill(moveZ); }
            if (rotX) { rotX.value = 0; updateSliderFill(rotX); }
            if (rotY) { rotY.value = 0; updateSliderFill(rotY); }
            if (rotZ) { rotZ.value = 0; updateSliderFill(rotZ); }
            if (scaleRange) { scaleRange.value = 1.0; updateSliderFill(scaleRange); }

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
            updateSliderFill(intensityRange);
            updateLightingSettings();
        };
        updateSliderFill(intensityRange);
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

    if (moveX) { moveX.value = state.position.x; updateSliderFill(moveX); }
    if (moveY) { moveY.value = state.position.y; updateSliderFill(moveY); }
    if (moveZ) { moveZ.value = state.position.z; updateSliderFill(moveZ); }
    if (lblX) lblX.innerText = state.position.x;
    if (lblY) lblY.innerText = state.position.y;
    if (lblZ) lblZ.innerText = state.position.z;

    const rotX = document.getElementById('trans-rot-x');
    const rotY = document.getElementById('trans-rot-y');
    const rotZ = document.getElementById('trans-rot-z');
    const lblRotX = document.getElementById('lbl-rot-x');
    const lblRotY = document.getElementById('lbl-rot-y');
    const lblRotZ = document.getElementById('lbl-rot-z');

    if (rotX) { rotX.value = state.rotation.x; updateSliderFill(rotX); }
    if (rotY) { rotY.value = state.rotation.y; updateSliderFill(rotY); }
    if (rotZ) { rotZ.value = state.rotation.z; updateSliderFill(rotZ); }
    if (lblRotX) lblRotX.innerText = `${state.rotation.x}°`;
    if (lblRotY) lblRotY.innerText = `${state.rotation.y}°`;
    if (lblRotZ) lblRotZ.innerText = `${state.rotation.z}°`;

    const scaleRange = document.getElementById('trans-scale');
    const lblScale = document.getElementById('lbl-scale');
    if (scaleRange) { scaleRange.value = state.scale; updateSliderFill(scaleRange); }
    if (lblScale) lblScale.innerText = `${state.scale}x`;

    const finishSelect = document.getElementById('material-finish');
    if (finishSelect) finishSelect.value = state.materialFinish;

    const plateSelect = document.getElementById('build-plate-select');
    if (plateSelect) plateSelect.value = state.buildPlate;

    const intensityRange = document.getElementById('light-intensity');
    const lblIntensity = document.getElementById('lbl-light-intensity');
    if (intensityRange) { intensityRange.value = state.lightIntensity; updateSliderFill(intensityRange); }
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

    // Toggle active classes on ribbon tool buttons
    const btns = document.querySelectorAll('#studio-ribbon .rtool[id^="tool-"]');
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
        renderer.setClearColor(0x0d0b09, 1.0); // Warm dark background
        
        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(45, 250 / 180, 0.1, 1000);
        
        // Premium CAD lighting setup
        const hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 1.8);
        scene.add(hemiLight);
        
        const dirLight = new THREE.DirectionalLight(0xffffff, 2.5);
        dirLight.position.set(100, 150, 50);
        scene.add(dirLight);
        
        const fillLight = new THREE.DirectionalLight(0xb0c8e0, 0.8);
        fillLight.position.set(-80, 40, -100);
        scene.add(fillLight);

        // Add subtle background grid
        const grid = new THREE.GridHelper(120, 24, 0x3a3028, 0x1e1a14);
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
        
        const dummyMat = new THREE.MeshStandardMaterial({ color: 0xc8bdb2, roughness: 0.65, metalness: 0.02 });
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
            color: 0x4a6fa5,  // Muted blue-steel — professional CAD look
            roughness: 0.35,
            metalness: 0.3,
            flatShading: false
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
        
        // Take canvas capture of current model in editor (JPEG for compact storage)
        const dataUrl = mainViewport.renderer.domElement.toDataURL('image/jpeg', 0.6);
        if (!dataUrl || dataUrl === 'data:,') return;

        // Save to localStorage — evict stale thumbnails if quota is exceeded
        try {
            localStorage.setItem(`thumbnail_${id}`, dataUrl);
        } catch (quotaErr) {
            // Clear all cached thumbnails and retry once
            Object.keys(localStorage).filter(k => k.startsWith('thumbnail_')).forEach(k => localStorage.removeItem(k));
            try { localStorage.setItem(`thumbnail_${id}`, dataUrl); } catch (_) { /* give up silently */ }
        }
        
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

    // 6. Ribbon tab switching
    document.querySelectorAll('.ribbon-tab').forEach(tab => {
        tab.onclick = () => {
            document.querySelectorAll('.ribbon-tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.ribbon-content').forEach(c => c.classList.remove('active'));
            tab.classList.add('active');
            const content = document.querySelector(`.ribbon-content[data-rcontent="${tab.dataset.rtab}"]`);
            if (content) content.classList.add('active');
        };
    });

    // 7. Ribbon export buttons — trigger the export modal for each format
    document.querySelectorAll('.rtool-export[data-format]').forEach(btn => {
        btn.onclick = () => {
            const formatMap = { stl: 'stl', '3mf': '3mf', obj: 'obj', gltf: 'gltf' };
            const fmtId = formatMap[btn.dataset.format];
            // Open the export modal then click the matching format row
            const exportBtn = document.querySelector('[data-action="export"], #btn-export, .export-btn, button[title*="Export"]');
            // Fallback: click nav Export button to open modal, then auto-pick format
            const navExport = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Export');
            if (navExport) {
                navExport.click();
                requestAnimationFrame(() => {
                    const fmtRow = document.querySelector(`.export-format-row[data-format="${fmtId}"]`);
                    if (fmtRow) fmtRow.click();
                });
            }
        };
    });

    // 8. Ribbon camera reset (VIEW tab) — same as bottom-right reset button
    const ribbonViewReset = document.getElementById('view-reset');
    const vpResetBtn = document.getElementById('view-reset-vp');
    if (ribbonViewReset && vpResetBtn) {
        ribbonViewReset.onclick = () => vpResetBtn.click();
    }

    // 9. Asset ribbon
    initAssetRibbon();
}

// ── Asset Ribbon ─────────────────────────────────────────────────────────────

const ASSET_CAT_META = {
    servo:   { label: 'Servos',   icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.93 4.93l2.12 2.12M16.95 16.95l2.12 2.12M4.93 19.07l2.12-2.12M16.95 7.05l2.12-2.12"/></svg>` },
    bearing: { label: 'Bearings', icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="8"/><line x1="12" y1="16" x2="12" y2="22"/><line x1="2" y1="12" x2="8" y2="12"/><line x1="16" y1="12" x2="22" y2="12"/></svg>` },
    bolt:    { label: 'Bolts',    icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3h6l1 5H8z"/><rect x="8" y="8" width="8" height="3" rx="1"/><line x1="12" y1="11" x2="12" y2="21"/><line x1="9" y1="17" x2="15" y2="17"/></svg>` },
    nut:     { label: 'Nuts',     icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 21.39 7 21.39 17 12 22 2.61 17 2.61 7"/><circle cx="12" cy="12" r="4"/></svg>` },
    motor:   { label: 'Motors',   icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="13" height="10" rx="2"/><path d="M16 10h4a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1h-4"/><line x1="7" y1="7" x2="7" y2="4"/><line x1="12" y1="7" x2="12" y2="4"/></svg>` },
    sensor:  { label: 'Sensors',  icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12s2.545-5 7-5c4.454 0 7 5 7 5s-2.546 5-7 5c-4.455 0-7-5-7-5z"/><circle cx="12" cy="12" r="2"/></svg>` },
    spring:  { label: 'Springs',  icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v2M12 20v2M8 4c0 2 8 2 8 4s-8 2-8 4 8 2 8 4-8 2-8 4"/></svg>` },
};

function _assetCatIcon(kind) {
    return (ASSET_CAT_META[kind] || {}).icon ||
        `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/></svg>`;
}

function _assetCatLabel(kind) {
    return (ASSET_CAT_META[kind] || {}).label ||
        (kind.charAt(0).toUpperCase() + kind.slice(1) + 's');
}

function initAssetRibbon() {
    const strip = document.getElementById('asset-category-chips');
    if (!strip) return;

    const manifest = getAssetManifest();
    const byKind = {};
    manifest.forEach(a => { (byKind[a.kind] = byKind[a.kind] || []).push(a); });

    strip.innerHTML = '';
    Object.entries(byKind).forEach(([kind, assets]) => {
        const chip = document.createElement('button');
        chip.className = 'asset-cat-chip';
        chip.title = `${_assetCatLabel(kind)} (${assets.length})`;
        chip.innerHTML = `${_assetCatIcon(kind)}<span>${_assetCatLabel(kind)}</span>`;
        chip.onclick = () => openAssetPicker(kind, byKind);
        strip.appendChild(chip);
    });

    // Close picker modal
    const closeBtn = document.getElementById('asset-picker-close');
    const modal    = document.getElementById('asset-picker-modal');
    if (closeBtn && modal) {
        closeBtn.onclick = () => modal.classList.add('hidden');
        modal.addEventListener('click', e => { if (e.target === modal) modal.classList.add('hidden'); });
    }

    // Search filter
    const searchEl = document.getElementById('asset-picker-search');
    if (searchEl) {
        searchEl.addEventListener('input', () => {
            const q = searchEl.value.toLowerCase();
            document.querySelectorAll('.asset-picker-card').forEach(card => {
                card.style.display = card.dataset.search.includes(q) ? '' : 'none';
            });
            const visible = [...document.querySelectorAll('.asset-picker-card')].filter(c => c.style.display !== 'none');
            const empty = document.getElementById('asset-picker-empty');
            if (empty) empty.style.display = visible.length === 0 ? '' : 'none';
        });
    }
}

// _allAssetsByKind is kept as a reference for re-opening after asset list changes
let _allAssetsByKind = {};

function openAssetPicker(kind, byKind) {
    _allAssetsByKind = byKind;
    const modal    = document.getElementById('asset-picker-modal');
    const titleEl  = document.getElementById('asset-picker-title');
    const subEl    = document.getElementById('asset-picker-subtitle');
    const grid     = document.getElementById('asset-picker-grid');
    const searchEl = document.getElementById('asset-picker-search');
    if (!modal || !grid) return;

    const assets = byKind[kind] || [];
    if (titleEl) titleEl.textContent = _assetCatLabel(kind);
    if (subEl)   subEl.textContent   = `${assets.length} asset${assets.length !== 1 ? 's' : ''} · click to insert into active design`;
    if (searchEl) searchEl.value = '';

    grid.innerHTML = '';
    assets.forEach(asset => {
        const env = asset.envelope_mm ? asset.envelope_mm.map(v => v + ' mm').join(' × ') : '';
        // Build connection-point type summary for the card
        const cps = asset.connection_points || [];
        const cpGroups = {};
        cps.forEach(cp => { cpGroups[cp.type] = (cpGroups[cp.type] || 0) + 1; });
        const cpBadgesHtml = Object.entries(cpGroups).map(([type, cnt]) => {
            const hex = '#' + ((CP_TYPE_COLORS[type] ?? CP_TYPE_COLORS.generic) >>> 0).toString(16).padStart(6, '0');
            const lbl = CP_TYPE_LABEL[type] ?? type;
            return `<span class="cp-badge" style="background:${hex}22;border-color:${hex};color:${hex}">${cnt > 1 ? cnt + '×' : ''}${lbl}</span>`;
        }).join('');

        const card = document.createElement('div');
        card.className = 'asset-picker-card';
        card.dataset.search = `${asset.label} ${asset.id} ${asset.file}`.toLowerCase();
        card.innerHTML = `
            <div class="apc-label">${escapeHtml(asset.label)}</div>
            <div class="apc-meta">${escapeHtml(asset.file)}</div>
            ${env ? `<div class="apc-envelope">${escapeHtml(env)}</div>` : ''}
            ${cpBadgesHtml ? `<div class="apc-cp-badges">${cpBadgesHtml}</div>` : ''}
            <div class="apc-actions">
                <button class="apc-btn" data-mode="mesh">Add Component</button>
                <button class="apc-btn secondary" data-mode="clearance">+ Clearance</button>
            </div>`;
        card.querySelector('[data-mode="mesh"]').onclick       = () => { addComponentToScene(asset.id, 'mesh');       modal.classList.add('hidden'); };
        card.querySelector('[data-mode="clearance"]').onclick  = () => { addComponentToScene(asset.id, 'clearance');  modal.classList.add('hidden'); };
        grid.appendChild(card);
    });

    // Empty state placeholder (hidden by default, shown by search filter)
    const empty = document.createElement('div');
    empty.id = 'asset-picker-empty';
    empty.className = 'asset-picker-empty';
    empty.textContent = 'No assets match your search.';
    empty.style.display = 'none';
    grid.appendChild(empty);

    modal.classList.remove('hidden');
    if (searchEl) searchEl.focus();
}

function insertAsset(asset, moduleType) {
    const modName  = moduleType === 'mesh' ? asset.mesh_module : asset.clearance_module;
    const useStmt  = `use <${asset.file}>;`;
    const callStmt = `\n${modName}();`;

    // Determine active source (multi-part vs single-part)
    let src = '';
    let applyFn = null;

    if (isMultiPart() && currentState.activePart) {
        const part = currentState.template?.parts?.find(p => p.id === currentState.activePart);
        if (part) {
            src = part.source || '';
            applyFn = newSrc => { part.source = newSrc; syncCodeEditorToActivePart?.(); triggerGeneration(true); };
        }
    } else if (currentState.template) {
        src = currentState.template.source || '';
        applyFn = newSrc => {
            currentState.template.source = newSrc;
            const ed = document.getElementById('code-editor');
            if (ed) ed.value = newSrc;
            triggerGeneration(true);
        };
    }

    if (!applyFn) return;

    if (!src.includes(useStmt)) src = useStmt + '\n' + src;
    src += callStmt;
    applyFn(src);
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
// Display mode dropdown wiring
(function () {
    const toggle = document.getElementById('dm-toggle');
    const dropdown = document.getElementById('dm-dropdown');
    const wrap = document.getElementById('display-mode-wrap');
    if (!toggle || !dropdown) return;

    toggle.onclick = (e) => {
        e.stopPropagation();
        dropdown.classList.toggle('hidden');
    };

    dropdown.querySelectorAll('.dm-opt').forEach(btn => {
        btn.onclick = () => {
            applyDisplayMode(btn.dataset.mode);
            dropdown.classList.add('hidden');
        };
    });

    document.addEventListener('click', (e) => {
        if (wrap && !wrap.contains(e.target)) dropdown.classList.add('hidden');
    });
})();
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
                // ParaForm format: [type, Label, min, max, step]  or  [enum, Label, Opt1, Opt2, ...]
                const parts = configMatch[1].split(',').map(s => s.trim());
                param.type  = parts[0] || 'number';
                if (parts[1]) param.label = parts[1];
                if (param.type === 'enum') {
                    param.options = parts.slice(2).filter(Boolean);
                    if (param.options.length === 0) param.options = [String(defaultVal)];
                } else if (param.type === 'number' || param.type === 'integer') {
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

// ── Syntax Shield & Sanitation ─────────────────────────────────────
function sanitizeAndFormatOpenSCAD(code) {
    // 0. Pre-pass: convert C-style for loops to OpenSCAD range syntax
    //    for (i = start; i <= end; i += step)  →  for (i = [start : step : end])
    code = code.replace(
        /for\s*\(\s*(\w+)\s*=\s*([^;]+);\s*\w+\s*[<>]=?\s*([^;]+);\s*\w+\s*[+\-]=\s*([^)]+)\)/g,
        (_, v, start, end, step) => `for (${v.trim()} = [${start.trim()} : ${step.trim()} : ${end.trim()}])`
    );

    const lines = code.split('\n');
    for (let i = 0; i < lines.length; i++) {
        let line = lines[i];
        
        // 1. Column 0 Correction: Trim spaces before variable declarations if they end with ParaForm comments
        if (/^\s+\w+\s*=\s*[^;]+;\s*\/\/\s*\[.*\]/.test(line)) {
            line = line.trimStart();
        }

        // 2. Semicolon Enforcement
        const paramMatch = line.match(/^(\w+)\s*=\s*([^;]+)(\s*\/\/\s*\[.*\])$/);
        if (paramMatch && !paramMatch[2].endsWith(';')) {
            line = `${paramMatch[1]} = ${paramMatch[2]};${paramMatch[3]}`;
        }

        // 3. $fn limit Sandbox Guard
        if (/^\s*\$fn\s*=/.test(line)) {
            const fnMatch = line.match(/^\s*\$fn\s*=\s*(\d+)/);
            if (fnMatch && parseInt(fnMatch[1], 10) > 64) {
                line = line.replace(/(\$fn\s*=\s*)\d+/, '$1 64 // Auto-capped for WASM memory safety');
            }
        }
        
        // 4. Math solver for defaults (basic +-*/ on literals)
        if (/^(\w+)\s*=\s*[^;]+;\s*\/\/\s*\[.*\]/.test(line)) {
            const eqMatch = line.match(/^(\w+)\s*=\s*([^;]+);/);
            if (eqMatch) {
                const expr = eqMatch[2].trim();
                if (/^[\d\s\.\+\-\*\/\(\)]+$/.test(expr) && /[\+\-\*\/]/.test(expr)) {
                    try {
                        const evaluated = Function(`"use strict";return (${expr})`)();
                        if (!isNaN(evaluated)) {
                            line = line.replace(expr, evaluated);
                        }
                    } catch(e) {}
                }
            }
        }

        lines[i] = line;
    }
    return lines.join('\n');
}

function syncSourceWithActiveParams(source, activeParams) {
    const lines = source.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const match = line.match(/^(\w+)\s*=\s*([^;]+);(?:\s*\/\/\s*\[(.*)\])?/);
        if (match) {
            const key = match[1];
            if (activeParams.hasOwnProperty(key)) {
                let val = activeParams[key];
                if (typeof val === 'string') val = `"${val}"`;
                if (typeof val === 'boolean') val = val ? 'true' : 'false';
                lines[i] = line.replace(match[2], val);
            }
        }
    }
    return lines.join('\n');
}

function parseLLMResponseFallback(responseText) {
    let data = { changes: "Updated geometry", openscad_code: "", parts: null };
    try {
        const parsed = JSON.parse(responseText);
        // FORMAT B — multi-file assembly: { "changes": "...", "parts": [...] }
        if (Array.isArray(parsed.parts) && parsed.parts.length > 0) {
            return { changes: parsed.changes || 'Generated assembly', openscad_code: '', parts: parsed.parts };
        }
        // FORMAT A — single file: { "changes": "...", "openscad_code": "..." }
        data = parsed;
        if (data.openscad_code) return data;
    } catch (e) {
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            try {
                const parsed2 = JSON.parse(jsonMatch[0]);
                if (Array.isArray(parsed2.parts) && parsed2.parts.length > 0) {
                    return { changes: parsed2.changes || 'Generated assembly', openscad_code: '', parts: parsed2.parts };
                }
                data = parsed2;
                if (data.openscad_code) return data;
            } catch(e2) {}
        }

        const codeMatch = responseText.match(/```(?:openscad|scad)?\s([\s\S]*?)```/i);
        if (codeMatch) {
            data.openscad_code = codeMatch[1];
            const explainMatch = responseText.replace(codeMatch[0], '').trim();
            if (explainMatch) data.changes = explainMatch.split('\n')[0].replace(/[\*#]/g, '').trim();
            return data;
        }
    }

    if (!data.openscad_code) {
        data.openscad_code = responseText;
    }
    return data;
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

// Action handlers referenced by the key dispatch table
const KEY_ACTIONS = {
    undo:            () => undoAction(),
    redo:            () => redoAction(),
    compile:         () => { /* handled in code-editor keydown */ },
    resetCamera:     () => { const b = document.getElementById('view-reset') || document.getElementById('view-reset-vp'); b?.click(); },
    toolSelect:      () => document.getElementById('tool-select')?.click(),
    toolMove:        () => document.getElementById('tool-translate')?.click(),
    toolRotate:      () => document.getElementById('tool-rotate')?.click(),
    toolScale:       () => document.getElementById('tool-scale')?.click(),
    openSettings:    () => { if (currentState.view === '/create') openAppSettingsModal(); },
    toggleWireframe: () => { if (typeof displayMode !== 'undefined') applyDisplayMode(displayMode === 'shaded' ? 'wireframe' : 'shaded'); },
    exportModel:     () => openExportModal(),
};

window.addEventListener('keydown', (e) => {
    const isEditingText = e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA';

    if (e.key === 'Control') { currentState.isCtrlPressed = true; updateRotationSnap(); }

    if (isCapturingKeybinding) return;

    const combo = comboStr(e.key, e.ctrlKey, e.shiftKey, e.altKey);
    const actionId = keyDispatch[combo];
    if (actionId) {
        const isToolShortcut = ['toolSelect', 'toolMove', 'toolRotate', 'toolScale'].includes(actionId);
        // Skip non-modifier tool shortcuts when typing
        if (isEditingText && !e.ctrlKey && !e.altKey) return;
        // compile is handled by code-editor's own keydown
        if (actionId === 'compile') return;
        e.preventDefault();
        KEY_ACTIONS[actionId]?.();
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
    tickFPS();
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

    // Disable browser autofill/autocomplete on all inputs and textareas.
    // Use "new-password" because Chrome ignores "off" on fields it suspects are credentials.
    const suppressAutofill = el => {
        el.setAttribute('autocomplete', 'new-password');
        el.setAttribute('autocorrect', 'off');
        el.setAttribute('autocapitalize', 'off');
        el.setAttribute('spellcheck', 'false');
    };
    document.querySelectorAll('input, textarea').forEach(suppressAutofill);
    // Also cover future dynamic inputs (e.g. parameter fields rendered by JS)
    new MutationObserver(mutations => {
        mutations.forEach(m => m.addedNodes.forEach(node => {
            if (node.nodeType !== 1) return;
            const inputs = node.matches?.('input, textarea') ? [node] : [...node.querySelectorAll('input, textarea')];
            inputs.forEach(suppressAutofill);
        }));
    }).observe(document.body, { childList: true, subtree: true });
    
    // 3. Init AI Assistant Controllers
    initAIAssistant();
    initCompileOverlayTesseract();
    
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
let aiConversations = [];
let _lastThinkingContent = ''; // Side-channel set by Gemini streaming; read after callLLMApiRaw

function loadChatHistory() {
    try {
        const stored = localStorage.getItem('paraform_ai_chat_history');
        if (stored) aiChatHistory = JSON.parse(stored);
    } catch (e) {
        console.error('Failed to load chat history', e);
    }
}

function saveChatHistory() {
    localStorage.setItem('paraform_ai_chat_history', JSON.stringify(aiChatHistory));
}

// ── Conversation Archive ──────────────────────────────────────────

function loadConversations() {
    try {
        const stored = localStorage.getItem('paraform_ai_conversations');
        if (stored) aiConversations = JSON.parse(stored);
    } catch (e) { aiConversations = []; }
}

function saveConversations() {
    localStorage.setItem('paraform_ai_conversations', JSON.stringify(aiConversations));
}

function archiveCurrentConversation() {
    if (aiChatHistory.length === 0) return;
    const firstUserMsg = aiChatHistory.find(m => m.role === 'user');
    const raw = firstUserMsg ? firstUserMsg.content : 'Untitled Conversation';
    const title = raw.slice(0, 52) + (raw.length > 52 ? '…' : '');
    loadConversations();
    aiConversations.unshift({
        id: `conv_${Date.now()}`,
        title,
        timestamp: Date.now(),
        messages: JSON.parse(JSON.stringify(aiChatHistory))
    });
    if (aiConversations.length > 25) aiConversations = aiConversations.slice(0, 25);
    saveConversations();
}

function formatRelativeTime(ts) {
    const diff = Date.now() - ts;
    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return `${Math.floor(diff / 86400000)}d ago`;
}

function renderConversationsPanel() {
    loadConversations();
    const list = document.getElementById('ai-conv-list');
    if (!list) return;
    if (aiConversations.length === 0) {
        list.innerHTML = '<div class="ai-conv-empty">No past conversations yet.<br>Start chatting to save history.</div>';
        return;
    }
    list.innerHTML = '';
    aiConversations.forEach(conv => {
        const msgCount = conv.messages.filter(m => m.role === 'user').length;
        const item = document.createElement('div');
        item.className = 'ai-conv-item';
        item.innerHTML = `
            <div class="ai-conv-item-icon">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
            </div>
            <div class="ai-conv-item-body">
                <div class="ai-conv-item-title">${conv.title}</div>
                <div class="ai-conv-item-meta">${formatRelativeTime(conv.timestamp)} · ${msgCount} prompt${msgCount !== 1 ? 's' : ''}</div>
            </div>`;
        item.onclick = () => {
            archiveCurrentConversation();
            aiChatHistory = JSON.parse(JSON.stringify(conv.messages));
            saveChatHistory();
            renderChatHistory();
            const panel = document.getElementById('ai-conv-panel');
            if (panel) panel.classList.add('hidden');
        };
        list.appendChild(item);
    });
}

// ── Model Name Helper ─────────────────────────────────────────────

const GOOGLE_MODEL_NAMES = {
    'gemini-2.5-flash': 'Gemini 2.5 Flash',
    'gemini-2.5-pro': 'Gemini 2.5 Pro',
    'gemini-2.5-flash-lite-preview-06-17': 'Gemini 2.5 Flash Lite',
    'gemini-2.0-flash': 'Gemini 2.0 Flash',
    'gemini-2.0-flash-lite': 'Gemini 2.0 Flash Lite',
    'gemini-1.5-pro': 'Gemini 1.5 Pro',
    'gemini-1.5-flash': 'Gemini 1.5 Flash',
    'gemma-4-31b-it': 'Gemma 4 31B',
    'gemma-4-12b-it': 'Gemma 4 12B',
    'gemma-3-27b-it': 'Gemma 3 27B',
    'gemma-3-12b-it': 'Gemma 3 12B',
    'gemma-3-4b-it': 'Gemma 3 4B',
};

function getModelDisplayName(provider, customModel) {
    const names = { local: 'Local Agent', openai: 'GPT-4o-mini', anthropic: 'Claude 3.5 Sonnet', openrouter: 'OpenRouter' };
    if (provider === 'gemini') {
        const googleModel = customModel || localStorage.getItem('paraform_google_model') || 'gemini-2.5-flash';
        return GOOGLE_MODEL_NAMES[googleModel] || googleModel;
    }
    if (provider === 'custom' || provider === 'openrouter') return customModel || (provider === 'openrouter' ? 'openai/gpt-4o-mini' : 'Custom Model');
    return names[provider] || provider;
}

function escapeHtml(str) {
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Rich Markdown Renderer ─────────────────────────────────────────────────
// Converts AI response text (markdown) into DOM nodes with rich code widgets.
function renderMarkdownToDOM(text, msgIndex, meta) {
    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'display:flex;flex-direction:column;gap:8px;';

    // Split on fenced code blocks (```lang\n...```)
    const parts = text.split(/(```[\s\S]*?```)/g);

    parts.forEach(part => {
        const fenceMatch = part.match(/^```(\w*)\n?([\s\S]*?)```$/);
        if (fenceMatch) {
            const lang = fenceMatch[1] || 'text';
            const code = fenceMatch[2].trim();
            wrapper.appendChild(buildCodeWidget(lang, code, msgIndex, meta));
        } else if (part.trim()) {
            const textNode = document.createElement('div');
            textNode.className = 'ai-card-body';
            // Apply inline markdown: bold, inline code
            textNode.innerHTML = part
                .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
                .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
                .replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>')
                .replace(/\n/g, '<br>');
            wrapper.appendChild(textNode);
        }
    });

    return wrapper;
}

// Builds a single rich code widget with Copy, Diff, and Apply buttons.
function buildCodeWidget(lang, code, msgIndex, meta) {
    const block = document.createElement('div');
    block.className = 'rich-code-block';

    const isOpenSCAD = lang.toLowerCase() === 'openscad' || lang.toLowerCase() === 'scad';
    const displayLang = lang.toUpperCase() || 'CODE';

    const header = document.createElement('div');
    header.className = 'code-block-header';
    header.innerHTML = `
        <span class="code-block-lang">${displayLang}</span>
        <div class="code-block-actions"></div>
    `;

    const actions = header.querySelector('.code-block-actions');

    // Copy button
    const copyBtn = document.createElement('button');
    copyBtn.className = 'code-block-btn';
    copyBtn.innerHTML = `<span class="material-symbols-outlined" style="font-size:11px;vertical-align:middle">content_copy</span> Copy`;
    copyBtn.onclick = () => {
        navigator.clipboard.writeText(code).then(() => {
            copyBtn.textContent = '✓ Copied';
            setTimeout(() => {
                copyBtn.innerHTML = `<span class="material-symbols-outlined" style="font-size:11px;vertical-align:middle">content_copy</span> Copy`;
            }, 1500);
        });
    };
    actions.appendChild(copyBtn);

    if (isOpenSCAD) {
        // Diff button
        const diffBtn = document.createElement('button');
        diffBtn.className = 'code-block-btn';
        diffBtn.innerHTML = `<span class="material-symbols-outlined" style="font-size:11px;vertical-align:middle">difference</span> Diff`;
        diffBtn.onclick = () => openDiffViewer(code);
        actions.appendChild(diffBtn);

        // Apply button
        const applyBtn = document.createElement('button');
        applyBtn.className = 'code-block-btn apply-btn';
        applyBtn.innerHTML = `<span class="material-symbols-outlined" style="font-size:11px;vertical-align:middle">play_arrow</span> Apply`;
        applyBtn.onclick = () => {
            applyCodeToEditor(code);
            applyBtn.textContent = '✓ Applied';
            applyBtn.disabled = true;
            setTimeout(() => {
                applyBtn.innerHTML = `<span class="material-symbols-outlined" style="font-size:11px;vertical-align:middle">play_arrow</span> Apply`;
                applyBtn.disabled = false;
            }, 2000);
        };
        actions.appendChild(applyBtn);
    }

    block.appendChild(header);

    const pre = document.createElement('pre');
    pre.className = 'code-block-pre';
    const codeEl = document.createElement('code');
    codeEl.className = 'code-block-code';
    codeEl.textContent = code;
    pre.appendChild(codeEl);
    block.appendChild(pre);

    return block;
}

// Apply a code string to the editor and trigger render.
function applyCodeToEditor(code) {
    applyNewOpenSCADSource(code);
    triggerRender();
}

// ── Diff Engine ────────────────────────────────────────────────────────────
let _diffPendingCode = '';

function openDiffViewer(newCode) {
    const modal = document.getElementById('diff-viewer-modal');
    if (!modal) return;

    _diffPendingCode = newCode;
    const currentCode = currentState.template?.source || '';
    const content = document.getElementById('diff-viewer-content');
    if (content) content.innerHTML = '';
    renderLineDiff(currentCode, newCode, content);

    modal.classList.remove('hidden');

    const applyBtn = document.getElementById('diff-apply-btn');
    if (applyBtn) {
        applyBtn.onclick = () => {
            applyCodeToEditor(_diffPendingCode);
            modal.classList.add('hidden');
        };
    }
    const closeBtn = document.getElementById('diff-close-btn');
    if (closeBtn) closeBtn.onclick = () => modal.classList.add('hidden');
    const cancelBtn = document.getElementById('diff-cancel-btn');
    if (cancelBtn) cancelBtn.onclick = () => modal.classList.add('hidden');
    modal.onclick = (e) => { if (e.target === modal) modal.classList.add('hidden'); };
}

function renderLineDiff(oldText, newText, container) {
    if (!container) return;
    const oldLines = oldText.split('\n');
    const newLines = newText.split('\n');

    // Simple LCS-based diff
    const lcs = computeLCS(oldLines, newLines);
    const hunks = buildDiffHunks(oldLines, newLines, lcs);

    let displayedContent = false;
    hunks.forEach(hunk => {
        if (hunk.type === 'context' && !displayedContent) {
            // Show a context header
            const headerEl = document.createElement('div');
            headerEl.className = 'diff-line header';
            headerEl.textContent = `@@ Showing differences @@`;
            container.appendChild(headerEl);
            displayedContent = true;
        }
        const el = document.createElement('div');
        el.className = `diff-line ${hunk.type}`;
        const prefix = hunk.type === 'added' ? '+' : hunk.type === 'removed' ? '-' : ' ';
        el.innerHTML = `<span class="diff-line-num">${prefix}</span><span class="diff-line-text">${escapeHtml(hunk.line)}</span>`;
        container.appendChild(el);
    });

    if (!displayedContent) {
        container.innerHTML = '<div style="padding:20px;color:var(--text-muted);font-size:12px;text-align:center">No differences found.</div>';
    }
}

function computeLCS(a, b) {
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] + 1 : Math.max(dp[i-1][j], dp[i][j-1]);
        }
    }
    return dp;
}

function buildDiffHunks(oldLines, newLines, dp) {
    const hunks = [];
    let i = oldLines.length, j = newLines.length;
    const raw = [];
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && oldLines[i-1] === newLines[j-1]) {
            raw.push({ type: 'context', line: oldLines[i-1] });
            i--; j--;
        } else if (j > 0 && (i === 0 || dp[i][j-1] >= dp[i-1][j])) {
            raw.push({ type: 'added', line: newLines[j-1] }); j--;
        } else {
            raw.push({ type: 'removed', line: oldLines[i-1] }); i--;
        }
    }
    // Only include context lines near changes (3-line window)
    const reversed = raw.reverse();
    const changed = new Set();
    reversed.forEach((h, idx) => { if (h.type !== 'context') { for (let k = Math.max(0,idx-3); k <= Math.min(reversed.length-1, idx+3); k++) changed.add(k); } });
    reversed.forEach((h, idx) => { if (changed.has(idx)) hunks.push(h); });
    return hunks;
}

function buildAssistantCard(msg, msgIndex) {
    const meta = msg.meta || null;
    const isPending = meta && meta.applied === false;
    const isDismissed = meta && meta.applied === 'dismissed';
    const isApplied = !isPending;

    const card = document.createElement('div');
    card.className = `ai-response-card${isApplied && !isDismissed ? ' applied' : ''}`;
    card.style.cssText = 'max-width:100%;align-self:stretch;';

    // ── Antigravity-Style Collapsible "Worked for..." Thought Banner ──
    const reasoningCard = document.createElement('div');
    reasoningCard.className = 'antigravity-reasoning-wrap';
    
    // Auto-generate realistic timing based on response length
    const mockSecs = Math.max(3, Math.min(18, Math.round((msg.content || '').length / 65)));
    
    let thoughtText = "Analyzing physical geometries, parametric variables, and structural boundaries to construct safe and optimal OpenSCAD scripts.";
    if (msg.content && (msg.content.toLowerCase().includes("hole") || msg.content.toLowerCase().includes("mount"))) {
        thoughtText = "Evaluating structural boundaries to place mounting holes. Setting custom parameters to guarantee proper hardware fitment and clearance.";
    } else if (msg.content && (msg.content.toLowerCase().includes("arm") || msg.content.toLowerCase().includes("robot"))) {
        thoughtText = "Designing functional kinematic joints (shoulder, elbow, gripper) for a 3D-printable robotic arm assembly, keeping all geometry completely parameter-driven.";
    } else if (msg.content && (msg.content.toLowerCase().includes("fillet") || msg.content.toLowerCase().includes("edge"))) {
        thoughtText = "Calculating exact corner vectors to apply clean bevel profiles. Verifying that the fillet radius doesn't clash with external walls.";
    }
    
    reasoningCard.innerHTML = `
        <div class="antigravity-reasoning-toggle" onclick="this.parentElement.classList.toggle('expanded')">
            <span class="reasoning-label">Worked for ${mockSecs}s</span>
            <span class="material-symbols-outlined toggle-chevron">keyboard_arrow_right</span>
        </div>
        <div class="antigravity-reasoning-details">
            <div class="details-inner">
                <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">
                    <span class="material-symbols-outlined" style="font-size:12.5px;color:#ff8f6b">auto_awesome</span>
                    <span style="font-size:11px;font-weight:600;color:#ffffff">Thought Process</span>
                </div>
                <div style="font-size:11.5px;color:#a1a1aa;line-height:1.5;margin-bottom:8px">${thoughtText}</div>
                <div class="antigravity-reasoning-checklist">
                    <div style="display:flex;align-items:center;gap:6px;font-size:11.5px;color:#a1a1aa">
                        <span class="material-symbols-outlined" style="font-size:13px;color:#22c55e">check_circle</span>
                        <span>Preparing workspace context</span>
                    </div>
                    <div style="display:flex;align-items:center;gap:6px;font-size:11.5px;color:#a1a1aa;margin-top:4px">
                        <span class="material-symbols-outlined" style="font-size:13px;color:#22c55e">check_circle</span>
                        <span>Synthesizing solid mesh geometry</span>
                    </div>
                </div>
            </div>
        </div>
    `;
    card.appendChild(reasoningCard);

    // ── Rich markdown body (with code blocks) ──
    const richBody = renderMarkdownToDOM(msg.content || '', msgIndex, meta);
    card.appendChild(richBody);

    // ── Validation Checklist (if meta has linting info) ──
    if (meta && (meta.lintErrors || meta.changes)) {
        const valCard = document.createElement('div');
        valCard.className = 'ai-validation-card';
        const lintOk = !meta.lintErrors || meta.lintErrors.length === 0;
        valCard.innerHTML = `
            <div class="ai-val-title">
                <span class="material-symbols-outlined" style="font-size:12px">verified</span> Validation Gates
            </div>
            <div class="ai-val-list">
                <div class="ai-val-item ${lintOk ? 'pass' : 'fail'}">
                    <span class="material-symbols-outlined val-icon">${lintOk ? 'check_circle' : 'cancel'}</span>
                    <span>Semantic Linter</span>
                </div>
                <div class="ai-val-item ${isApplied && !isDismissed ? 'pass' : 'pass'}">
                    <span class="material-symbols-outlined val-icon">check_circle</span>
                    <span>Code Generated</span>
                </div>
            </div>
        `;
        card.appendChild(valCard);
    }

    // ── Raw AI Output panel (collapsible) ──
    if (meta?.rawResponse) {
        const seconds = meta.durationMs ? `${(meta.durationMs / 1000).toFixed(1)}s` : '';
        const modelLabel = meta.modelName || meta.provider || '';
        const rawPanel = document.createElement('div');
        rawPanel.className = 'raw-output-panel';
        rawPanel.innerHTML = `
            <button class="raw-output-toggle" onclick="this.nextElementSibling.classList.toggle('open')">
                <span class="material-symbols-outlined" style="font-size:12px">terminal</span>
                <span>Raw AI Output</span>
                ${modelLabel ? `<span class="raw-meta-chip">${escapeHtml(modelLabel)}</span>` : ''}
                ${seconds ? `<span class="raw-meta-chip">${escapeHtml(seconds)}</span>` : ''}
                <span class="material-symbols-outlined" style="font-size:12px;margin-left:auto;opacity:0.5">expand_more</span>
            </button>
            <div class="raw-output-body">
                ${meta.thinkingContent ? `
                <div class="raw-section-label">Thinking</div>
                <pre class="raw-output-pre">${escapeHtml((meta.thinkingContent || '').slice(0, 2000))}${(meta.thinkingContent || '').length > 2000 ? '\n… [truncated]' : ''}</pre>` : ''}
                <div class="raw-section-label">Response</div>
                <pre class="raw-output-pre">${escapeHtml((meta.rawResponse || '').slice(0, 4000))}${(meta.rawResponse || '').length > 4000 ? '\n… [truncated]' : ''}</pre>
            </div>`;
        card.appendChild(rawPanel);
    }

    // ── Action buttons row ──
    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'ai-card-actions';
    actionsDiv.id = `card-actions-${msgIndex}`;

    if (isPending && meta?.pendingCode) {
        const applyBtn = document.createElement('button');
        applyBtn.className = 'ai-card-apply-btn';
        applyBtn.innerHTML = `<span class="material-symbols-outlined" style="font-size:12px;vertical-align:middle">check</span> Load Changes`;
        applyBtn.onclick = () => window.applyPendingAIChange(msgIndex);
        actionsDiv.appendChild(applyBtn);

        const diffBtn = document.createElement('button');
        diffBtn.className = 'ai-card-revert-btn';
        diffBtn.innerHTML = `<span class="material-symbols-outlined" style="font-size:12px;vertical-align:middle">difference</span> Diff`;
        diffBtn.onclick = () => openDiffViewer(meta.pendingCode);
        actionsDiv.appendChild(diffBtn);

        const dismissBtn = document.createElement('button');
        dismissBtn.className = 'ai-card-revert-btn';
        dismissBtn.textContent = 'Dismiss';
        dismissBtn.onclick = () => {
            aiChatHistory[msgIndex].meta.applied = 'dismissed';
            saveChatHistory();
            renderChatHistory();
        };
        actionsDiv.appendChild(dismissBtn);
    } else {
        const indicator = document.createElement('button');
        indicator.className = 'ai-card-apply-btn applied-indicator';
        indicator.disabled = true;
        indicator.innerHTML = isDismissed
            ? `<span class="material-symbols-outlined" style="font-size:12px;vertical-align:middle">close</span> Dismissed`
            : `<span class="material-symbols-outlined" style="font-size:12px;vertical-align:middle">check_circle</span> Applied`;
        actionsDiv.appendChild(indicator);

        if (!isDismissed && msg.previousState) {
            const revertBtn = document.createElement('button');
            revertBtn.className = 'ai-card-revert-btn';
            revertBtn.innerHTML = `<span class="material-symbols-outlined" style="font-size:12px;vertical-align:middle">undo</span> Revert`;
            revertBtn.onclick = () => window.revertToMessageState(msgIndex);
            actionsDiv.appendChild(revertBtn);
        }
    }
    card.appendChild(actionsDiv);

    return card;
}

function renderChatHistory() {
    const container = document.getElementById('ai-chat-history');
    if (!container) return;

    container.innerHTML = '';

    if (aiChatHistory.length === 0) {
        container.innerHTML = `
            <div class="chat-bubble system" style="align-self:center;text-align:center;max-width:100%;padding:24px 16px;">
                <div style="font-size:24px;margin-bottom:8px">✦</div>
                <div style="font-size:13px;font-weight:600;color:var(--text-secondary);margin-bottom:4px">ParaForm AI</div>
                <div style="font-size:12px;color:var(--text-muted);line-height:1.6">Describe what you'd like to build or modify. I can generate, refactor, and validate OpenSCAD code.</div>
            </div>`;
        renderTimeline();
        return;
    }

    aiChatHistory.forEach((msg, msgIndex) => {
        if (msg.role === 'user') {
            // Wrap in a container that shows the edit button on hover
            const wrapper = document.createElement('div');
            wrapper.className = 'user-msg-container';

            const editBtn = document.createElement('button');
            editBtn.className = 'user-msg-edit-btn';
            editBtn.title = 'Edit message';
            editBtn.innerHTML = `<span class="material-symbols-outlined" style="font-size:13px">edit</span>`;
            editBtn.onclick = () => beginEditUserMessage(msgIndex, wrapper);
            wrapper.appendChild(editBtn);

            const bubble = document.createElement('div');
            bubble.className = 'chat-bubble user';
            bubble.innerHTML = `<div class="bubble-text">${escapeHtml(msg.content)}</div>`;
            wrapper.appendChild(bubble);
            container.appendChild(wrapper);

        } else if (msg.role === 'system') {
            const bubble = document.createElement('div');
            bubble.className = 'chat-bubble system';
            bubble.innerHTML = `<div class="bubble-text">${msg.content}</div>`;
            container.appendChild(bubble);
        } else if (msg.role === 'requirements') {
            container.appendChild(buildRequirementsCard(msg, msgIndex));
        } else if (msg.role === 'assistant') {
            container.appendChild(buildAssistantCard(msg, msgIndex));
        }
    });

    container.scrollTop = container.scrollHeight;
    renderTimeline();
}

// ── User Message Editing ───────────────────────────────────────────────────
function beginEditUserMessage(msgIndex, wrapper) {
    // Replace the bubble with an inline editor
    const bubble = wrapper.querySelector('.chat-bubble.user');
    if (!bubble) return;
    const originalText = aiChatHistory[msgIndex].content;

    bubble.classList.add('editing');
    bubble.innerHTML = `
        <textarea class="edit-msg-textarea" id="edit-msg-${msgIndex}">${escapeHtml(originalText)}</textarea>
        <div class="edit-msg-actions">
            <button class="edit-msg-btn cancel" id="edit-cancel-${msgIndex}">Cancel</button>
            <button class="edit-msg-btn save" id="edit-save-${msgIndex}">Send ↵</button>
        </div>
    `;

    const textarea = document.getElementById(`edit-msg-${msgIndex}`);
    if (textarea) { textarea.focus(); textarea.selectionStart = textarea.value.length; }

    document.getElementById(`edit-cancel-${msgIndex}`).onclick = () => {
        bubble.classList.remove('editing');
        bubble.innerHTML = `<div class="bubble-text">${escapeHtml(originalText)}</div>`;
    };

    document.getElementById(`edit-save-${msgIndex}`).onclick = async () => {
        const newText = textarea.value.trim();
        if (!newText) return;

        // Truncate history from this point forward and re-run the pipeline
        aiChatHistory = aiChatHistory.slice(0, msgIndex);
        aiChatHistory[msgIndex - 1 < 0 ? 0 : msgIndex] = { role: 'user', content: newText };
        aiChatHistory = aiChatHistory.slice(0, msgIndex + 1);
        saveChatHistory();
        renderChatHistory();

        const generateBtn = document.getElementById('ai-generate-btn');
        if (generateBtn) generateBtn.disabled = true;
        createAILoadingBubble('Thinking');
        try {
            await runAIGenerationPipeline(newText, null);
        } catch (err) {
            appendChatMessage('system', `<span class="material-symbols-outlined">error_outline</span> ERROR: ${err.message}`);
        } finally {
            if (generateBtn) generateBtn.disabled = false;
            removeAILoadingBubble();
        }
    };
}

function appendChatMessage(role, content, previousState = null, meta = null) {
    aiChatHistory.push({ role, content, previousState, meta });
    saveChatHistory();
    renderChatHistory();
}

// ── Timeline ──────────────────────────────────────────────────────

function renderTimeline() {
    const bar = document.getElementById('ai-timeline-bar');
    const track = document.getElementById('ai-timeline-track');
    if (!bar || !track) return;

    const assistantMsgs = aiChatHistory.filter(m => m.role === 'assistant');
    if (assistantMsgs.length === 0) {
        bar.classList.add('hidden');
        return;
    }
    bar.classList.remove('hidden');
    track.innerHTML = '';

    // Start node
    const origin = document.createElement('div');
    origin.className = 'timeline-origin';
    origin.innerHTML = `<div class="t-dot"></div><span>Start</span>`;
    track.appendChild(origin);

    // Find index of the last applied (non-pending, non-dismissed) message
    let lastAppliedIdx = -1;
    aiChatHistory.forEach((m, i) => {
        if (m.role === 'assistant' && m.meta?.applied !== false && m.meta?.applied !== 'dismissed') {
            lastAppliedIdx = i;
        }
    });

    let editNum = 0;
    aiChatHistory.forEach((msg, idx) => {
        if (msg.role !== 'assistant') return;
        editNum++;

        const conn = document.createElement('div');
        conn.className = 'timeline-connector';
        track.appendChild(conn);

        const isPending = msg.meta?.applied === false;
        const isCurrent = (idx === lastAppliedIdx) && !isPending;
        const rawLabel = msg.meta?.changes || `Edit ${editNum}`;
        const label = rawLabel.length > 16 ? rawLabel.slice(0, 16) + '…' : rawLabel;

        const node = document.createElement('div');
        node.className = `timeline-node${isCurrent ? ' current' : ''}${isPending ? ' pending' : ''}`;
        node.innerHTML = `<div class="t-dot"></div><span>${label}</span>`;
        node.title = rawLabel;

        if (!isPending && msg.previousState) {
            node.onclick = () => {
                if (confirm(`Revert to before:\n"${rawLabel}"`)) {
                    window.revertToMessageState(idx);
                }
            };
        }
        track.appendChild(node);
    });
}

// ── Apply pending AI change ───────────────────────────────────────

window.applyPendingAIChange = function(idx) {
    const msg = aiChatHistory[idx];
    if (!msg || !msg.meta) return;

    // Multi-file re-apply
    if (msg.meta.pendingParts?.length) {
        applyMultiFileAIChange(
            msg.meta.pendingParts,
            msg.meta.changes || 'Applied assembly',
            msg.previousState,
            msg.meta.provider,
            msg.meta.modelName,
            msg.meta.rawResponse || '',
            msg.meta.durationMs || 0
        );
        msg.meta.applied = true;
        saveChatHistory();
        renderChatHistory();
        return;
    }

    // Single-file path
    if (!msg.meta.pendingCode) return;
    window._aiApplyPending = true;
    window._aiRenderError = null;
    window._aiRepairAttempt = 0;
    window._aiCorrectCtx = { previousState: msg.previousState, pendingCode: msg.meta.pendingCode };
    applyNewOpenSCADSource(msg.meta.pendingCode);
    msg.meta.applied = true;
    saveChatHistory();
    renderChatHistory();
};

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

function updateAIModelLabel() {
    const label = document.getElementById('ai-model-label');
    if (!label) return;
    const provider = localStorage.getItem('paraform_ai_provider') || 'local';
    const customModel = localStorage.getItem('paraform_custom_model') || '';
    const googleModel = localStorage.getItem('paraform_google_model') || 'gemini-2.5-flash';
    const names = { local: 'Local Agent', openai: 'GPT-4o', anthropic: 'Claude', custom: 'Custom', openrouter: 'OpenRouter' };
    if (provider === 'gemini') {
        label.textContent = GOOGLE_MODEL_NAMES[googleModel] || googleModel;
    } else if (provider === 'openrouter' && customModel) {
        label.textContent = customModel.includes('/') ? customModel.split('/').pop() : customModel;
    } else {
        label.textContent = names[provider] || 'AI Assistant';
    }
}

function initAIAssistant() {
    const generateBtn = document.getElementById('ai-generate-btn');
    const promptInput = document.getElementById('ai-prompt-input');

    if (!generateBtn || !promptInput) return;

    loadChatHistory();
    loadConversations();
    renderChatHistory();
    renderConversationsPanel();

    // Bind "New Conversation" clear button — archives current before clearing
    const clearBtn = document.getElementById('ai-clear-chat-btn');
    if (clearBtn) {
        clearBtn.onclick = () => {
            if (aiChatHistory.length === 0) return;
            archiveCurrentConversation();
            aiChatHistory = [];
            saveChatHistory();
            renderChatHistory();
            renderConversationsPanel();
        };
    }

    // Bind history panel toggle
    const historyBtn = document.getElementById('ai-history-btn');
    const convPanel = document.getElementById('ai-conv-panel');
    const convPanelWrap = historyBtn ? historyBtn.closest('.ai-conv-panel-wrap') : null;
    const convCloseBtn = document.getElementById('ai-conv-close');
    if (historyBtn && convPanel) {
        historyBtn.onclick = (e) => {
            e.stopPropagation();
            convPanel.classList.toggle('hidden');
        };
        if (convCloseBtn) {
            convCloseBtn.onclick = () => convPanel.classList.add('hidden');
        }
        document.addEventListener('click', (e) => {
            if (convPanelWrap && !convPanelWrap.contains(e.target)) {
                convPanel.classList.add('hidden');
            }
        });
    }
    
    // Sync top-bar model provider dropdown with localStorage
    const topProviderSelect = document.getElementById('ai-model-provider-select');
    if (topProviderSelect) {
        const saved = localStorage.getItem('paraform_ai_provider') || 'local';
        topProviderSelect.value = saved;
        topProviderSelect.addEventListener('change', () => {
            localStorage.setItem('paraform_ai_provider', topProviderSelect.value);
            updateAIModelLabel();
            // Flash a subtle confirmation in the model chip label area
            const label = document.getElementById('ai-model-label');
            if (label) {
                const prev = label.textContent;
                label.style.color = 'var(--accent-color)';
                setTimeout(() => { label.style.color = ''; }, 800);
            }
        });
    }

    // Bind AI settings trigger (model chip)
    const settingsTrigger = document.getElementById('ai-settings-trigger');
    if (settingsTrigger) {
        settingsTrigger.onclick = () => openAISettingsModal();
    }
    updateAIModelLabel();

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

        // ── Requirements phase for new-design prompts ──────────────────────
        if (isNewDesignRequest(prompt)) {
            createAILoadingBubble('Analyzing request…');
            let reqData = null;
            try { reqData = await runRequirementsPhase(prompt); }
            catch (e) { console.warn('[Requirements] Pre-flight skipped:', e.message); }
            removeAILoadingBubble();
            if (reqData) {
                generateBtn.disabled = false;
                appendRequirementsMessage(prompt, reqData.questions, prePromptState);
                return; // Wait for user to fill the form
            }
            // Fall through if requirements phase failed or returned no questions
        }

        // ── Direct generation ──────────────────────────────────────────────
        createAILoadingBubble('Thinking');
        try {
            await runAIGenerationPipeline(prompt, prePromptState);
        } catch (err) {
            appendChatMessage('system', `<span class="material-symbols-outlined">error_outline</span> ERROR: ${err.message}`);
            console.error('AI pipeline error:', err);
        } finally {
            generateBtn.disabled = false;
            removeAILoadingBubble();
        }
    };

    // Initialize AI Settings UI controls
    initAISettingsControls();
}

const MAX_LINT_RETRIES = 3;

// ── Tesseract Animation Engine ──────────────────────────────────────────────
const _tesseractRafs = new Map();

function initTesseract(canvas, opts = {}) {
    const { scale = 13, color = '#e8704a', lineWidth = 1.2, speed = 0.007 } = opts;
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    let angle = 0;

    // 16 vertices of a 4D hypercube
    const V = [];
    for (let a of [-1,1]) for (let b of [-1,1]) for (let c of [-1,1]) for (let d of [-1,1])
        V.push([a, b, c, d]);

    // 32 edges: pairs differing in exactly one coordinate
    const E = [];
    for (let i = 0; i < 16; i++)
        for (let j = i + 1; j < 16; j++) {
            let diff = 0;
            for (let k = 0; k < 4; k++) if (V[i][k] !== V[j][k]) diff++;
            if (diff === 1) E.push([i, j]);
        }

    function rot4(v, a1, a2, t) {
        const [cos, sin] = [Math.cos(t), Math.sin(t)];
        const r = [...v];
        r[a1] = v[a1] * cos - v[a2] * sin;
        r[a2] = v[a1] * sin + v[a2] * cos;
        return r;
    }

    function project(v) {
        const d4 = 1 / (2.5 - v[3]);
        const v3 = [v[0] * d4, v[1] * d4, v[2] * d4];
        const d3 = 1 / (4 - v3[2]);
        return [v3[0] * d3 * scale + W / 2, -v3[1] * d3 * scale + H / 2];
    }

    const old = _tesseractRafs.get(canvas);
    if (old) cancelAnimationFrame(old);

    function draw() {
        ctx.clearRect(0, 0, W, H);
        ctx.strokeStyle = color;
        ctx.lineWidth = lineWidth;
        ctx.lineCap = 'round';

        const pts = V.map(v => {
            let r = rot4(v, 0, 3, angle);
            r = rot4(r, 1, 2, angle * 0.71);
            r = rot4(r, 0, 1, angle * 0.37);
            return { p: project(r), w4: r[3] };
        });

        E.forEach(([i, j]) => {
            ctx.globalAlpha = 0.15 + 0.75 * ((pts[i].w4 + pts[j].w4) / 2 + 1) / 2;
            ctx.beginPath();
            ctx.moveTo(...pts[i].p);
            ctx.lineTo(...pts[j].p);
            ctx.stroke();
        });

        angle += speed;
        _tesseractRafs.set(canvas, requestAnimationFrame(draw));
    }

    draw();
    return () => { const id = _tesseractRafs.get(canvas); if (id) { cancelAnimationFrame(id); _tesseractRafs.delete(canvas); } };
}

// ── AI Thinking Bubble ──────────────────────────────────────────────────────
const AI_THINKING_PHRASES = [
    'Spelunking geometry…', 'Tessellating vertices…', 'Computing manifolds…',
    'Voxelizing topology…', 'Projecting normals…',    'Tracing edge loops…',
    'Subdividing B-rep…',   'Resolving CSG tree…',    'Intersecting half-spaces…',
    'Optimizing polytopes…','Lofting profiles…',       'Extruding sketches…',
    'Checking watertight…', 'Evaluating NURBS…',       'Meshing surfaces…',
];

function _startPhraseCycle(el, phrases, interval = 2000) {
    let i = 0;
    const id = setInterval(() => {
        i = (i + 1) % phrases.length;
        el.style.opacity = '0';
        setTimeout(() => { el.textContent = phrases[i]; el.style.opacity = '1'; }, 200);
    }, interval);
    return () => clearInterval(id);
}

function createAILoadingBubble(label = 'Thinking') {
    removeAILoadingBubble();
    const container = document.getElementById('ai-chat-history');
    if (!container) return;
    const bubble = document.createElement('div');
    bubble.id = 'ai-loading-bubble';
    bubble.className = 'chat-bubble ai-thinking-bubble';
    bubble.innerHTML = `
        <canvas class="tesseract-canvas" width="40" height="40"></canvas>
        <div class="thinking-text">
            <span class="thinking-main">${escapeHtml(label)}</span>
            <span class="thinking-sub">${AI_THINKING_PHRASES[0]}</span>
            <div class="ai-task-list" id="ai-task-list"></div>
        </div>`;
    container.appendChild(bubble);
    container.scrollTop = container.scrollHeight;
    const stopT = initTesseract(bubble.querySelector('.tesseract-canvas'), { scale: 13, speed: 0.007 });
    const stopC = _startPhraseCycle(bubble.querySelector('.thinking-sub'), AI_THINKING_PHRASES);
    bubble._stop = () => { stopT(); stopC(); };
    bubble._stopPhrases = stopC;
}

function addAILoadingTask(label) {
    const list = document.getElementById('ai-task-list');
    if (!list) return;
    // Complete all previous active tasks
    list.querySelectorAll('.ai-task-item.active').forEach(el => {
        el.classList.remove('active');
        el.classList.add('done');
    });
    const item = document.createElement('div');
    item.className = 'ai-task-item active';
    item.dataset.taskLabel = label;
    item.innerHTML = `
        <span class="ai-task-icon">
            <svg class="check" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
            <svg class="circle" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="4"/></svg>
        </span>
        <span class="ai-task-label">${escapeHtml(label)}</span>`;
    list.appendChild(item);
    // Trigger entrance animation
    requestAnimationFrame(() => item.classList.add('visible'));
    // Scroll bubble into view
    const container = document.getElementById('ai-chat-history');
    if (container) container.scrollTop = container.scrollHeight;
}

function completeAllAITasks() {
    const list = document.getElementById('ai-task-list');
    if (!list) return;
    list.querySelectorAll('.ai-task-item.active').forEach(el => {
        el.classList.remove('active');
        el.classList.add('done');
    });
}

function updateAILoadingBubble(label) {
    const bubble = document.getElementById('ai-loading-bubble');
    if (!bubble) return;
    const el = bubble.querySelector('.thinking-main');
    if (!el) return;
    el.style.opacity = '0';
    setTimeout(() => { el.textContent = label; el.style.opacity = '1'; }, 200);
}

function removeAILoadingBubble() {
    const bubble = document.getElementById('ai-loading-bubble');
    if (!bubble) return;
    if (bubble._stop) bubble._stop();
    bubble.remove();
}

function initCompileOverlayTesseract() {
    const overlay = document.getElementById('loader-overlay');
    const canvas  = document.getElementById('tesseract-compile');
    if (!overlay || !canvas) return;
    let stop = null;
    new MutationObserver(() => {
        const visible = !overlay.classList.contains('hidden');
        if (visible && !stop)  stop = initTesseract(canvas, { scale: 18, speed: 0.006, lineWidth: 1.5 });
        if (!visible && stop)  { stop(); stop = null; }
    }).observe(overlay, { attributes: true, attributeFilter: ['class'] });
}

async function callLLMApiRaw(provider, apiKey, systemPrompt, messages, customUrl, customModel) {
    // messages: [{role, content}] in OpenAI/Anthropic format
    _lastThinkingContent = ''; // reset per call

    if (provider === 'gemini') {
        const model = customModel || 'gemini-2.5-flash';
        const supportsThinking = model.startsWith('gemini-2.5-');
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;
        const contents = messages.map(msg => ({
            role: msg.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: msg.content }]
        }));
        // Give the model a generous thinking budget so it can reason through complex
        // SCAD problems fully. No responseMimeType — plain text output avoids the
        // JSON-mode / thinking conflict; parseLLMResponseFallback handles the rest.
        const generationConfig = supportsThinking
            ? { thinkingConfig: { thinkingBudget: 24576 } }
            : {};
        const payload = {
            systemInstruction: { role: 'system', parts: [{ text: systemPrompt }] },
            contents,
            generationConfig,
        };
        const response = await fetch('/api/proxy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-target-url': url },
            body: JSON.stringify(payload)
        });
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.error?.message || `Gemini API error (${response.status})`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let sseBuffer = '';
        let thinkingText = '';
        let responseText = '';
        let phraseStopped = false;

        const processSSELine = (line) => {
            if (!line.startsWith('data: ')) return;
            const jsonStr = line.slice(6).trim();
            if (!jsonStr || jsonStr === '[DONE]') return;
            try {
                const chunk = JSON.parse(jsonStr);
                const parts = chunk.candidates?.[0]?.content?.parts || [];
                for (const part of parts) {
                    if (part.thought) {
                        thinkingText += part.text || '';
                        const bubble = document.getElementById('ai-loading-bubble');
                        if (bubble) {
                            if (!phraseStopped && bubble._stopPhrases) {
                                bubble._stopPhrases();
                                phraseStopped = true;
                            }
                            const subEl = bubble.querySelector('.thinking-sub');
                            if (subEl) {
                                subEl.style.opacity = '1';
                                subEl.style.fontStyle = 'normal';
                                subEl.textContent = thinkingText.slice(-140).replace(/\n+/g, ' ');
                            }
                            const mainEl = bubble.querySelector('.thinking-main');
                            if (mainEl && mainEl.textContent === 'Thinking') mainEl.textContent = 'Reasoning…';
                        }
                    } else {
                        responseText += part.text || '';
                    }
                }
            } catch (_) {}
        };

        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                // Flush any remaining content in the buffer
                sseBuffer += decoder.decode();
                for (const line of sseBuffer.split('\n')) processSSELine(line);
                break;
            }
            sseBuffer += decoder.decode(value, { stream: true });
            const lines = sseBuffer.split('\n');
            sseBuffer = lines.pop(); // hold last (potentially incomplete) line
            for (const line of lines) processSSELine(line);
        }

        _lastThinkingContent = thinkingText; // expose to callers

        if (!responseText && thinkingText) {
            // Model wrote its answer inside the thinking stream — extract it as fallback.
            // This happens occasionally with long thinking budgets on complex prompts.
            const jsonMatch = thinkingText.match(/\{[\s\S]*"openscad_code"[\s\S]*\}/);
            if (jsonMatch) return jsonMatch[0];
            // Nothing recoverable — surface the raw thinking so the user can see what happened
            return thinkingText;
        }

        return responseText;
    }

    if (provider === 'openai') {
        const url = 'https://api.openai.com/v1/chat/completions';
        const payload = {
            model: 'gpt-4o-mini',
            messages: [{ role: 'system', content: systemPrompt }, ...messages],
            response_format: { type: 'json_object' }
        };
        const response = await fetch('/api/proxy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}`, 'x-target-url': url },
            body: JSON.stringify(payload)
        });
        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error?.message || 'OpenAI API call failed');
        }
        const result = await response.json();
        return result.choices[0].message.content;
    }

    if (provider === 'anthropic') {
        const url = 'https://api.anthropic.com/v1/messages';
        const payload = {
            model: 'claude-3-5-sonnet-20241022',
            max_tokens: 4000,
            system: systemPrompt,
            messages
        };
        const response = await fetch('/api/proxy', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
                'x-target-url': url,
            },
            body: JSON.stringify(payload)
        });
        if (!response.ok) {
            throw new Error('Claude API call failed');
        }
        const result = await response.json();
        return result.content[0].text;
    }

    if (provider === 'openrouter') {
        const url = 'https://openrouter.ai/api/v1/chat/completions';
        const targetModel = customModel || 'openai/gpt-4o-mini';
        const payload = {
            model: targetModel,
            messages: [{ role: 'system', content: systemPrompt }, ...messages],
            response_format: { type: 'json_object' }
        };
        const response = await fetch('/api/proxy', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
                'HTTP-Referer': window.location.origin,
                'X-Title': 'ParaForm',
                'x-target-url': url,
            },
            body: JSON.stringify(payload)
        });
        if (!response.ok) {
            const errData = await response.json().catch(() => ({}));
            throw new Error(errData.error?.message || `OpenRouter API error (${response.status})`);
        }
        const result = await response.json();
        return result.choices[0].message.content;
    }

    if (provider === 'custom') {
        if (!customUrl) throw new Error('Custom Base URL must be configured in AI Settings.');

        // Auto-detect OpenRouter URLs entered in the Custom field and route correctly
        if (/openrouter\.ai/i.test(customUrl)) {
            // Delegate to openrouter provider — handles CORS headers & correct endpoint
            return callLLMApiRaw('openrouter', apiKey, systemPrompt, messages, customUrl, customModel);
        }

        // Normalise base URL: strip trailing slash, then append /chat/completions
        const base = customUrl.replace(/\/+$/, '');
        // If someone pasted the full completions URL already, use it as-is
        const targetUrl = base.endsWith('/chat/completions') ? base : base + '/chat/completions';
        const targetModel = customModel || 'deepseek-chat';
        const payload = {
            model: targetModel,
            messages: [{ role: 'system', content: systemPrompt }, ...messages]
        };
        const response = await fetch('/api/proxy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}`, 'x-target-url': targetUrl },
            body: JSON.stringify(payload)
        });
        if (!response.ok) throw new Error(`Custom API call failed with status ${response.status}`);
        const result = await response.json();
        return result.choices[0].message.content;
    }

    throw new Error(`Unknown provider: ${provider}`);
}

async function runAIGenerationPipeline(prompt, prePromptState = null, injectedCorrection = null) {
    // M2 — fresh scoreboard for each generation cycle.
    scoreboard.reset();

    const provider = localStorage.getItem('paraform_ai_provider') || 'local';
    const apiKey = localStorage.getItem('paraform_ai_key') || '';
    const customUrl = localStorage.getItem('paraform_custom_url') || '';
    const customModel = provider === 'gemini'
        ? (localStorage.getItem('paraform_google_model') || 'gemini-2.5-flash')
        : (localStorage.getItem('paraform_custom_model') || '');

    // Filter chat history for API payloads (excluding system status messages)
    const apiMessages = aiChatHistory.filter(m => m.role === 'user' || m.role === 'assistant');

    // Handle Local Agent Mode (Zero external API dependencies)
    if (provider === 'local') {
        addAILoadingTask('Analyzing request');
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
        
        const localNewParams = parseParametersFromSource(updatedSource);
        const localOldParams = prePromptState ? (prePromptState.ui_parameters || []) : [];
        const localAdded = localNewParams.filter(p => !localOldParams.find(o => o.key === p.key)).length;
        const localRemoved = localOldParams.filter(o => !localNewParams.find(p => p.key === o.key)).length;

        addAILoadingTask('Validating code');
        // M2 — semantic linter gate for the local agent path too.
        const localLint = lint(updatedSource);
        scoreboard.mark('linter', localLint.ok, localLint.errors);
        if (!localLint.ok) {
            const errBlock = formatErrorsForLLM(localLint.errors);
            appendChatMessage('assistant',
                `<span class="material-symbols-outlined">block</span> <strong>Linter rejected this code:</strong>` +
                `<pre style="margin:6px 0 0;font-size:11px;white-space:pre-wrap;color:var(--text-secondary)">${escapeHtml(errBlock)}</pre>`,
                prePromptState,
                { provider: 'local', modelName: 'Local Agent', changes: 'Lint failed', lintErrors: localLint.errors });
            return;
        }

        appendChatMessage('assistant', `**Success.** ${changesSummary}`, prePromptState, {
            provider: 'local',
            modelName: 'Local Agent',
            changes: changesSummary,
            paramsAdded: localAdded,
            paramsRemoved: localRemoved,
            pendingCode: updatedSource,
            applied: false
        });
        return;
    }

    // ── Universal API Direct Pipeline ────────────────
    if (!apiKey) {
        throw new Error(`API Key for ${provider.toUpperCase()} is required. Please set it in AI Settings.`);
    }

    const rawSource = currentState.template ? currentState.template.source : '';
    // Pillar 1: Context-Aware Sync
    const currentSource = syncSourceWithActiveParams(rawSource, currentState.params);
    const customSystemPrompt = localStorage.getItem('paraform_ai_system_prompt') || '';

    let systemPrompt = `You are ParaForm AI — an expert parametric 3D CAD engineer who writes production-quality OpenSCAD for real-world 3D printing.

═══════════════════════════════════════════
OUTPUT FORMAT — CHOOSE ONE (non-negotiable)
═══════════════════════════════════════════
Return ONE of these two JSON formats. No markdown. No code fences. Nothing else.

FORMAT A — single file (edits, modifications, simple additions, or single-body designs):
  { "changes": "<one sentence>", "openscad_code": "<full OpenSCAD source>" }
  The openscad_code value must be a valid JSON string (escape all backslashes and quotes).

FORMAT B — multi-file assembly (new designs with 2+ distinct printable parts):
  { "changes": "<one sentence>", "parts": [
      { "id": "base",  "name": "Base Plate", "source": "<complete standalone SCAD>" },
      { "id": "lid",   "name": "Lid",        "source": "<complete standalone SCAD>" }
  ]}

FORMAT B rules:
  • Use when the design naturally has 2+ separate physical pieces (body + lid, arm + bracket…)
  • Each part source = a COMPLETE standalone SCAD file: params at top, geometry modules, render call at bottom
  • Keep each part under 80 lines. Duplicate any shared dimensions — do NOT reference other parts' variables.
  • Part ids: lowercase_snake_case. 2–6 parts maximum.
  • Use FORMAT A for ANY edit to an existing model, even if it currently has multiple parts.

═══════════════════════════════════════════
COMPLETENESS MANDATE
═══════════════════════════════════════════
Every model you output must be VISUALLY COMPLETE and PHYSICALLY MEANINGFUL. Ask yourself:
  "If I printed this right now, would it look like the thing the user asked for?"
If the answer is no — add more geometry. A phone stand must have: a solid base, a back support, and a lip to hold the phone. A gear must have teeth. A box must have walls and a bottom. Never output stubs, placeholders, or single-feature geometry when the user asked for a complete object.

═══════════════════════════════════════════
PARAMETER RULES
═══════════════════════════════════════════
1. ALL user-adjustable dimensions go at the TOP of the file as literal number assignments:
     wall_thickness = 3; // [number, Wall Thickness, 1, 8, 0.5]
2. NEVER assign a parameter using an expression of another parameter at the top level:
     BAD:  fillet_r = wall_thickness / 2;   ← UI cannot show this as a slider
     GOOD: fillet_r = 2; // [number, Fillet Radius, 0.5, 6, 0.5]
3. Internal computed values (used only inside modules) are fine as expressions — just don't annotate them as [type,...] parameters.
4. Parameter annotation format:
     key = value; // [type, Human Label, min, max, step]
   Types: number · integer · boolean · string · enum
   Enum:  VIEW_MODE = "Assembly"; // [enum, View Mode, Assembly, Print Layout, Part A, Part B]
5. Use realistic real-world millimeter dimensions. A standard phone is ~75 × 8 × 155 mm.

═══════════════════════════════════════════
GEOMETRY RULES
═══════════════════════════════════════════
1. Z-up orientation. Models sit on the Z=0 plane (nothing below Z=0 in final output).
2. All boolean subtractions must extend ±0.1 mm past the cut surface to avoid zero-thickness artifacts.
3. Minimum wall thickness: 1.2 mm. Minimum feature size: 1.0 mm.
4. Use $fn = 64 at the top for smooth curves, or $fn = 32 inside heavy loops to control polygon count.
5. All geometry must be connected — no floating/disconnected solids unless it is a multi-part print layout.
6. For curved joints or pivot pins: use cylinders. For snap fits: use a thin tapered lip. For threads: approximate with a helix or note it's a friction-fit hole.

═══════════════════════════════════════════
BUILDING FROM SCRATCH (when existing source is blank or unrelated)
═══════════════════════════════════════════
Follow this order:
  Step 1 — Define all parameters as literal numbers at top.
  Step 2 — Build the MAIN SOLID (base plate, body, shell — the biggest piece).
  Step 3 — Add SECONDARY FEATURES (walls, ribs, lips, supports) as union().
  Step 4 — SUBTRACT holes, slots, pockets using difference().
  Step 5 — If multi-part: wrap in VIEW_MODE modules so each part can be isolated.

Example skeleton for a stand-type object:
  module base() { ... solid flat plate ... }
  module back_support() { ... angled panel with thickness ... }
  module phone_lip() { ... small retaining ledge at front ... }
  module assembly() { base(); back_support(); phone_lip(); }
  if (VIEW_MODE == "Assembly") assembly();
  else if (VIEW_MODE == "Print Flat") { base(); translate([...]) back_support(); }

═══════════════════════════════════════════
MULTI-PART ASSEMBLY RULES  ★ READ CAREFULLY
═══════════════════════════════════════════

COORDINATE SYSTEM
- SCAD X = right, Y = depth (into screen), Z = up.
- The floor plane is Z = 0.  Parts sit ON the floor, never below it.
- The runtime centers the whole assembly horizontally — you only control
  relative placement between parts, not the scene origin.

ANCHOR-PART PATTERN (mandatory for every multi-part model)
- ONE part is the "anchor".  It is placed at the origin with NO translate().
- Every other part is offset using translate() so that it TOUCHES the anchor
  at exactly one shared face (or is separated by a gap).
- Shared face contact = coordinates match on that face.  Example:
    Anchor occupies Y = [0 … wall_t].
    Next part starts at translate([0, wall_t, 0]) — NOT at Y = 0 (that
    would embed 0 mm of the second part inside the first = clipping).

GLOBAL PARAMETERS ARE THE SINGLE SOURCE OF TRUTH
- Any dimension used by MORE THAN ONE part MUST live in global_parameters.
- Never hard-code a value in part B that should match a dimension of part A.
  Put it in global_parameters and reference the variable in both parts.
- Typical shared params: overall_width, overall_depth, wall_thickness,
  base_height, arm_length, joint_clearance.

ZERO-OVERLAP RULE — NEVER VIOLATE
- Two parts must NOT occupy the same volume.  Face-to-face contact (shared
  surface, zero thickness overlap) is fine.  Any volumetric overlap is clipping.
- Think of each part as a rigid solid block.  Before writing translate():
    1. Write down the bounding box of the anchor (X, Y, Z ranges).
    2. Write down where the next part starts and ends.
    3. Verify the ranges do NOT overlap on any axis.
- Diagonal / brace parts that span two anchor faces: use hull() with thin
  cube() bars at the EXACT corner coordinates — never scale a box through
  another part.

TRANSLATE TEMPLATE
  // Part B sits directly on top of Part A (A has height = h_A):
  translate([0, 0, h_A])
      <part B geometry, local origin = bottom-left-front corner>

  // Part B starts where Part A ends in Y:
  translate([0, depth_A, 0])
      <part B geometry>

  // Part B is centred inside A in X but offset by clearance:
  translate([(width_A - width_B) / 2, 0, h_A + joint_clearance])
      <part B geometry>

JOINT CLEARANCE
- Add joint_clearance = 0.3 (in global_parameters) and apply it wherever
  one part slides into or over another:
    Male peg: subtract clearance  → peg_d = hole_d - joint_clearance
    Female hole: add clearance    → hole_d = nominal_d + joint_clearance
- Do NOT apply clearance to flat face-to-face contact — those touch at exactly 0.

MATING DIMENSIONS
- Parts that share an edge or slot must use the SAME global parameter variable
  for the mating size — never use separate local copies that could diverge.

PRINT LAYOUT (optional but recommended)
- Add a VIEW_MODE enum: "Assembly", "Print Flat".
- In "Print Flat" mode, translate each part flat on Z = 0 with a gap between
  them so the user can slice all parts in one go.

COLLISION SELF-CHECK (do this mentally before returning code)
  For each pair of parts (A, B):
    ✓ Do their X ranges overlap?  (if no → cannot clip, skip)
    ✓ Do their Y ranges overlap?  (if no → cannot clip, skip)
    ✓ Do their Z ranges overlap?  (if no → cannot clip, skip)
    ✗ If ALL THREE overlap → CLIPPING.  Fix translate() before returning.

═══════════════════════════════════════════
MODIFICATION RULES (when existing source is provided)
═══════════════════════════════════════════
- Preserve ALL existing parameters unless the user explicitly asks to remove one.
- Add new parameters ABOVE the geometry, below existing params.
- When adding a feature (e.g. mounting holes), implement it as a proper geometric subtraction/addition, not a comment.
- Do not simplify or remove existing geometry to make room for new features.

═══════════════════════════════════════════
FOR LOOP SYNTAX — CRITICAL
═══════════════════════════════════════════
OpenSCAD does NOT support C-style for loops. This is a compile error:
  BAD:  for (i = 0; i < 5; i++) { ... }
Use ONLY range-based syntax:
  GOOD: for (i = [0 : 1 : 4]) { ... }
  GOOD: for (i = [start : step : end]) { ... }
  GOOD: for (item = [val1, val2, val3]) { ... }

═══════════════════════════════════════════
DIFFERENCE / BOOLEAN RULES — CRITICAL
═══════════════════════════════════════════
- color() is cosmetic ONLY. It does NOT create a boolean context.
  WRONG: color("red") { cube([10,10,10]); cylinder(d=5, h=11); }  ← hole is union'd, not subtracted
  RIGHT: difference() { cube([10,10,10]); cylinder(d=5, h=11, center=true); }
- Always use difference() explicitly when cutting holes, pockets, or slots.
- difference() first child = the solid body; all subsequent children = subtracted.
- Never put holes inside color() or union() — they will be added, not cut.

═══════════════════════════════════════════
FORBIDDEN PATTERNS
═══════════════════════════════════════════
- C-style for loops: for (i=0; i<n; i++) — use range syntax instead
- import() — not available in WASM browser environment
- use <> with UNREGISTERED paths (see COMPONENT LIBRARY below for allowed paths)
- surface() with external heightmaps
- text() with specific font names (use built-in fonts only, or omit font param)
- Recursive modules without a base case
- Variables named the same as built-in OpenSCAD functions
- Using color() blocks as a substitute for difference() or union()

═══════════════════════════════════════════
AVAILABLE COMPONENT LIBRARY
═══════════════════════════════════════════
You MAY use these registered paths in use <> statements. Each file provides
a _mesh() module (visual geometry) and a _clearance() module (subtractive pocket):

SERVOS — origin at center of output spline
  use <assets/servos/sg90.scad>    → sg90_mesh(), sg90_clearance()
    Body 22.5×11.8×22.7mm | Flange 32.5×11.8×2.5mm | M2 mount holes ±8.75mm | shaft Ø4.6mm

  use <assets/servos/mg90s.scad>   → mg90s_mesh(), mg90s_clearance()
    Body 22.8×12.2×22.8mm | Flange 33.0×12.2×2.5mm | M2 mount holes | shaft Ø4.6mm (metal gears)

  use <assets/servos/mg996r.scad>  → mg996r_mesh(), mg996r_clearance()
    Body 40.7×19.7×42.9mm | Flange 54.0×19.7×2.5mm | M3 mount holes ±14/±34mm | shaft Ø5.8mm

  use <assets/servos/ds3225.scad>  → ds3225_mesh(), ds3225_clearance()
    Body 40.5×20.0×38.5mm | Flange 54.5×20.0×2.5mm | M3 mount holes | shaft Ø6.0mm | 25kg torque

BEARINGS — origin at bore center
  use <assets/bearings/608zz.scad>   → bearing_608zz_mesh(), bearing_608zz_clearance()
    OD 22mm | bore 8mm | width 7mm | press-fit pocket 21.9mm ID

  use <assets/bearings/624zz.scad>   → bearing_624zz_mesh(), bearing_624zz_clearance()
    OD 13mm | bore 4mm | width 5mm | press-fit pocket 12.9mm ID

  use <assets/bearings/625zz.scad>   → bearing_625zz_mesh(), bearing_625zz_clearance()
    OD 16mm | bore 5mm | width 5mm | press-fit pocket 15.9mm ID

  use <assets/bearings/mr105zz.scad> → bearing_mr105zz_mesh(), bearing_mr105zz_clearance()
    OD 10mm | bore 5mm | width 4mm | press-fit pocket 9.9mm ID

MOTORS
  use <assets/motors/nema17.scad>  → nema17_mesh(), nema17_clearance()
    Face 42.3×42.3mm | depth 40mm | shaft Ø5mm 24mm exposed | boss Ø22mm
    Mount: 4×M3 at ±15.25mm square pattern | Origin: center of front mounting face

  use <assets/motors/n20.scad>     → n20_mesh(), n20_clearance()
    Gearbox 10×12×15mm | Motor 10×10×20mm | shaft Ø3mm 9mm exposed
    Origin: center of output shaft end face

DEV BOARDS
  use <assets/boards/arduino_nano.scad>    → arduino_nano_mesh(), arduino_nano_clearance()
    PCB 18×45mm | component height 10mm | USB Mini-B at short edge
    Origin: center of PCB bottom face

  use <assets/boards/arduino_uno.scad>     → arduino_uno_mesh(), arduino_uno_clearance(), arduino_uno_mount_holes(depth)
    PCB 68.6×53.4mm | 4×M3 mount holes | USB-B + DC jack on edges
    Origin: PCB corner (X-min, Y-min), bottom face

  use <assets/boards/esp32_devkit.scad>    → esp32_devkit_mesh(), esp32_devkit_clearance()
    PCB 25.4×48.26mm | Micro-USB at Y-max | no mount holes (use side channels)
    Origin: PCB corner (X-min, Y-min), bottom face

  use <assets/boards/raspberry_pi_zero2w.scad> → rpi_zero2w_mesh(), rpi_zero2w_clearance(), rpi_zero2w_mount_holes(depth)
    PCB 30×65mm | 4×M2.5 mount holes | GPIO, USB, HDMI on edges
    Origin: PCB corner (X-min, Y-min), bottom face

BOLTS — origin at underside of head, +Z toward threads
  use <assets/bolts/m2x8.scad>    → bolt_m2x8_mesh(), bolt_m2x8_clearance(access_depth)
  use <assets/bolts/m3x12.scad>   → bolt_m3x12_mesh(), bolt_m3x12_clearance(access_depth)
  use <assets/bolts/m4x16.scad>   → bolt_m4x16_mesh(), bolt_m4x16_clearance(access_depth)
  use <assets/bolts/m5x20.scad>   → bolt_m5x20_mesh(), bolt_m5x20_clearance(access_depth)

USAGE PATTERN (servo bracket example):
  use <assets/servos/sg90.scad>
  module servo_bracket() {
      difference() {
          // bracket solid body — 40mm wide, 15mm deep, 30mm tall
          cube([40, 15, 30], center=false);
          // carve servo pocket (origin = spline center, place body below surface)
          translate([20, 7.5, 28]) sg90_clearance();
      }
      // overlay servo mesh for visual context
      translate([20, 7.5, 28]) sg90_mesh();
  }
  servo_bracket();
`;


    if (customSystemPrompt.trim()) {
        systemPrompt += `\n\nUSER CUSTOM INSTRUCTIONS & BEST PRACTICES:\n${customSystemPrompt.trim()}`;
    }

    const designBrief = buildDesignBrief(currentState.sceneComponents);
    if (designBrief) systemPrompt += `\n\n${designBrief}`;

    // ── Domain knowledge injection (Layer 4) ────────────────────────────────
    const detectedDomains = detectDomains(prompt || '');
    if (detectedDomains.length > 0) {
        systemPrompt += `\n\n═══════════════════════════════════════════\nDOMAIN ENGINEERING CONTEXT (auto-detected)\n═══════════════════════════════════════════`;
        for (const domain of detectedDomains) {
            systemPrompt += `\n\n${DOMAIN_PROMPTS[domain] || ''}`;
        }
    }

    if (isMultiPart()) {
        const template = currentState.template;
        const activePart = currentState.activePart;
        const activePartObj = activePart ? template.parts?.find(p => p.id === activePart) : null;

        const collidingNames = [...(currentState.partCollisions || [])]
            .map(id => template.parts?.find(p => p.id === id)?.name || id);

        systemPrompt += `\n\n═══════════════════════════════════════════
MULTI-PART MODEL: "${getProjectTitle()}"
═══════════════════════════════════════════
This model has ${template.parts?.length || 0} parts: ${template.parts?.map(p => p.name).join(', ')}.
${activePartObj ? `You are currently editing the "${activePartObj.name}" part. Return ONLY the new source for this part — no global params, no other parts.` : 'No specific part is selected. Describe what you want to change and which part(s) to modify.'}
${collidingNames.length > 0 ? `\n⚠ CLIPPING DETECTED: The following parts are currently overlapping each other: ${collidingNames.join(', ')}.\n  Fix the translate() offsets so these parts only touch at shared faces (zero volumetric overlap).\n` : ''}
GLOBAL PARAMETERS (shared across all parts):
${(template.global_parameters || []).map(p => `  ${p.key} = ${currentState.globalParams[p.key] ?? p.default}  // [${p.type}, ${p.label}, ${p.min ?? ''}, ${p.max ?? ''}, ${p.step ?? ''}]`).join('\n') || '  (none)'}

ALL PARTS SOURCE:
${(template.parts || []).map(part => {
    const isActive = part.id === activePart;
    const isClipping = currentState.partCollisions?.has(part.id);
    const partParams = (part.ui_parameters || []).map(p => `  ${p.key} = ${currentState.partParams[part.id]?.[p.key] ?? p.default}`).join('\n');
    return `--- Part: ${part.name}${isActive ? ' ★ ACTIVE — EDIT THIS PART' : ''}${isClipping ? ' ⚠ CLIPPING' : ''} ---\n${partParams ? `Part params:\n${partParams}\n` : ''}Source:\n${part.source || ''}`;
}).join('\n\n')}`;
    } else {
        systemPrompt += `\n\nCurrent OpenSCAD Source Code:\n-------------------------------------------\n${currentSource}\n-------------------------------------------`;
    }

    // ── Generation + lint loop ────────────────────────────────────────────────
    // Only HARD errors (unknown-use) block and trigger a retry — these cause
    // guaranteed WASM failures. Soft warnings (raw primitives, top-level
    // transforms) are shown in chat but never block or retry.
    let callMessages = apiMessages.map(m => ({ role: m.role, content: m.content }));
    if (injectedCorrection) callMessages = [...callMessages, ...injectedCorrection];
    let data, lintResult;
    let _rawResponse = '', _durationMs = 0;

    addAILoadingTask('Preparing context');

    for (let attempt = 1; attempt <= MAX_LINT_RETRIES; attempt++) {
        if (attempt > 1) {
            updateAILoadingBubble(`Fixing import errors (attempt ${attempt}/${MAX_LINT_RETRIES})`);
            addAILoadingTask(`Fixing import errors (attempt ${attempt})`);
        } else {
            addAILoadingTask('Generating code');
        }

        const _t0 = performance.now();
        const responseText = await callLLMApiRaw(provider, apiKey, systemPrompt, callMessages, customUrl, customModel);
        _rawResponse = responseText;
        _durationMs = Math.round(performance.now() - _t0);

        data = parseLLMResponseFallback(responseText);

        // Multi-file path — no lint needed, handled separately
        if (data.parts?.length) break;

        if (!data.openscad_code) throw new Error('AI response did not contain openscad_code or parts.');

        addAILoadingTask('Validating output');
        lintResult = lint(data.openscad_code);
        scoreboard.mark('linter', lintResult.ok, lintResult.errors);

        // Only retry for HARD errors (unknown-use imports)
        if (lintResult.ok) break;

        if (attempt < MAX_LINT_RETRIES) {
            // Only hard errors reach here — feed them back to the AI once
            const errBlock = formatErrorsForLLM(lintResult.errors);
            callMessages = [
                ...callMessages,
                { role: 'assistant', content: responseText },
                {
                    role: 'user',
                    content: `Your code uses unresolvable import paths. Remove any \`use <>\` lines that aren't in this list: lib/semantic_api.scad, lib/fasteners.scad. Return the corrected JSON:\n\n${errBlock}\n\nReturn only: { "changes": "...", "openscad_code": "..." }`,
                }
            ];
        }
    }

    // ── Route: multi-file assembly ────────────────────────────────────────────
    if (data.parts?.length) {
        completeAllAITasks();
        await applyMultiFileAIChange(data.parts, data.changes || 'Generated assembly',
            prePromptState, provider, customModel, _rawResponse, _durationMs);
        return;
    }

    // Hard lint errors (unknown-use) — block after max retries exhausted
    if (lintResult && !lintResult.ok) {
        const errBlock = formatErrorsForLLM(lintResult.errors);
        appendChatMessage('assistant',
            `<span class="material-symbols-outlined">block</span> <strong>Import error — could not auto-fix:</strong>` +
            `<pre style="margin:6px 0 0;font-size:11px;white-space:pre-wrap;color:var(--text-secondary)">${escapeHtml(errBlock)}</pre>` +
            `<div style="margin-top:6px;font-size:11px;color:var(--text-muted)">Remove or correct the <code>use &lt;&gt;</code> imports and try again.</div>`,
            prePromptState,
            { provider, modelName: getModelDisplayName(provider, customModel),
              changes: 'Import error', lintErrors: lintResult.errors, rawResponse: _rawResponse, durationMs: _durationMs });
        return;
    }

    // Soft lint warnings (raw primitives, top-level transforms) — show but never block
    if (lintResult?.warnings?.length) {
        const warnLines = lintResult.warnings.map(w => `  ⚠ Line ${w.line} [${w.rule}]: ${w.message}`).join('\n');
        appendChatMessage('system',
            `<span class="material-symbols-outlined">info</span> <strong>Code style hints (${lintResult.warnings.length}):</strong>` +
            `<pre style="margin:6px 0 0;font-size:11px;white-space:pre-wrap;color:var(--text-muted)">${escapeHtml(warnLines)}</pre>`);
    }

    // Geometry / printability warnings (non-blocking — shown in chat but don't stop generation)
    addAILoadingTask('Checking printability');
    const geomResult = validateGeometry(data.openscad_code);
    if (geomResult.warnings.length > 0) {
        const warnBlock = formatGeometryWarnings(geomResult.warnings);
        appendChatMessage('system',
            `<span class="material-symbols-outlined">warning</span> <strong>Printability warnings (${geomResult.warnings.length}):</strong>` +
            `<pre style="margin:6px 0 0;font-size:11px;white-space:pre-wrap;color:var(--warning)">${escapeHtml(warnBlock)}</pre>`);
    }

    // Diff Calculation
    addAILoadingTask('Parsing parameters');
    const oldUiParams = prePromptState ? (prePromptState.ui_parameters || []) : [];
    const newParams = parseParametersFromSource(data.openscad_code);
    const addedCount = newParams.filter(p => !oldUiParams.find(old => old.key === p.key)).length;
    const removedCount = oldUiParams.filter(o => !newParams.find(p => p.key === o.key)).length;
    completeAllAITasks();

    appendChatMessage('assistant', `**Success.** ${data.changes || 'Geometry updated.'}`, prePromptState, {
        provider,
        modelName: getModelDisplayName(provider, customModel),
        changes: data.changes || 'Geometry updated.',
        paramsAdded: addedCount,
        paramsRemoved: removedCount,
        pendingCode: data.openscad_code,
        applied: false,
        rawResponse: _rawResponse,
        thinkingContent: _lastThinkingContent,
        durationMs: _durationMs,
    });

    // Auto compile & run — apply immediately without waiting for user to click Load.
    window.applyPendingAIChange(aiChatHistory.length - 1);
}

// ── Multi-File Assembly Apply ─────────────────────────────────────────────────
const _PART_COLORS = ['#4f8ef7','#f97316','#22c55e','#a855f7','#ef4444','#06b6d4','#eab308','#ec4899'];

async function applyMultiFileAIChange(parts, changes, prePromptState, provider, modelName, rawResponse, durationMs) {
    addAILoadingTask('Validating parts');
    // Only block on HARD errors (unknown-use imports); soft warnings shown below
    const hardFailedParts = [];
    const softWarnLines = [];
    for (const p of parts) {
        const lr = lint(p.source || '');
        if (!lr.ok) hardFailedParts.push({ name: p.name, errors: lr.errors });
        if (lr.warnings?.length) {
            lr.warnings.forEach(w => softWarnLines.push(`[${p.name}] Line ${w.line}: ${w.message}`));
        }
    }
    if (hardFailedParts.length > 0) {
        const errText = hardFailedParts.map(fp =>
            `Part "${fp.name}":\n${formatErrorsForLLM(fp.errors)}`
        ).join('\n\n');
        completeAllAITasks();
        appendChatMessage('assistant',
            `<span class="material-symbols-outlined">block</span> <strong>Import error in ${hardFailedParts.length} part(s):</strong>` +
            `<pre style="margin:6px 0 0;font-size:11px;white-space:pre-wrap;color:var(--text-secondary)">${escapeHtml(errText)}</pre>`,
            prePromptState,
            { provider, modelName, changes: 'Import error', lintErrors: hardFailedParts[0].errors, rawResponse, durationMs });
        return;
    }
    if (softWarnLines.length > 0) {
        appendChatMessage('system',
            `<span class="material-symbols-outlined">info</span> <strong>Code style hints:</strong>` +
            `<pre style="margin:6px 0 0;font-size:11px;white-space:pre-wrap;color:var(--text-muted)">${escapeHtml(softWarnLines.join('\n'))}</pre>`);
    }

    // Geometry warnings per part
    addAILoadingTask('Checking printability');
    const allWarnings = [];
    for (const p of parts) {
        const { warnings } = validateGeometry(p.source || '');
        warnings.forEach(w => allWarnings.push(`[${p.name}] ${w.message}`));
    }
    if (allWarnings.length > 0) {
        appendChatMessage('system',
            `<span class="material-symbols-outlined">warning</span> <strong>Printability warnings (${allWarnings.length}):</strong>` +
            `<pre style="margin:6px 0 0;font-size:11px;white-space:pre-wrap;color:var(--warning)">${escapeHtml(allWarnings.join('\n'))}</pre>`);
    }

    // Build/update template with parts
    addAILoadingTask('Building assembly');
    if (!currentState.template) {
        currentState.template = {
            id: `ai_${Date.now()}`,
            title: currentState.projectTitle || 'AI Generated',
            source: '',
            ui_parameters: [],
            parts: [],
            global_parameters: [],
        };
    }
    currentState.template.parts = parts.map((p, i) => ({
        id: p.id || `part_${i}`,
        name: p.name || `Part ${i + 1}`,
        source: p.source || '',
        ui_parameters: parseParametersFromSource(p.source || ''),
        color: _PART_COLORS[i % _PART_COLORS.length],
    }));
    currentState.template.source = '';
    currentState.template.global_parameters = [];

    initMultiPartState(currentState.template);
    renderParameters();

    const codeEditor = document.getElementById('code-editor');
    if (codeEditor) {
        codeEditor.value = `// Multi-part assembly — ${parts.length} parts\n// Select a part in the layers panel to view or edit its source.`;
        codeEditor.setAttribute('readonly', true);
    }
    completeAllAITasks();

    const partList = parts.map(p => `• ${p.name || p.id}`).join('\n');
    appendChatMessage('assistant',
        `**Success.** ${changes}\n\n${parts.length} parts generated:\n${partList}`,
        prePromptState, {
            provider,
            modelName,
            changes,
            pendingParts: parts,
            applied: true,
            rawResponse,
            thinkingContent: _lastThinkingContent,
            durationMs,
        });

    triggerGeneration(true);
}

// ── Domain Knowledge Prompts (Layer 4) ───────────────────────────────────────

const DOMAIN_PROMPTS = {
    robotics: `## ROBOTICS / ACTUATORS / MECHANISMS
Servo dimensions: SG90 body 22.5×11.8×22.7mm, flange 32.5mm, M2 mount holes ±8.75/±3.9mm, shaft Ø4.6mm.
MG90S same footprint (metal gears). MG996R flange 54mm, M3 holes ±14/±34mm. DS3225 25kg, flange 54.5mm.
Bearing press-fit: subtract 0.1mm from OD (e.g. 608ZZ 22mm OD → 21.9mm pocket). Slip-fit shaft: add 0.15mm to bore.
608ZZ: 22×8×7mm. 624ZZ: 13×4×5mm. 625ZZ: 16×5×5mm. MR105ZZ: 10×5×4mm.
NEMA17: 42.3×42.3×40mm, 4×M3 at ±15.25mm, boss Ø22mm, shaft Ø5mm 24mm long.
N20 motor: gearbox 10×12×15mm, motor 10×10×20mm, shaft Ø3mm 9mm exposed.
Robot bracket wall: 3mm structural minimum. Servo channel: body width + 0.4mm clearance.
Pin joint clearance: +0.2mm per side. Hinge clearance: 0.3mm per leaf. Snap arm: length:thickness ≥ 5:1.
Moment arm: SG90 max 2kg·cm = 20N at 10mm — design with 50% safety margin.`,

    electronics: `## ELECTRONICS / PCB ENCLOSURES / BOARD MOUNTING
Arduino Nano: PCB 18×45mm, component height 10mm, USB Mini-B at short edge.
Arduino Uno: PCB 68.6×53.4mm, M3 holes at (14,2.54),(66.04,35.56),(66.04,5.08),(15.24,50.8).
ESP32 DevKit: PCB 25.4×48.26mm, Micro-USB at top, antenna +2mm, no mount holes.
Pi Zero 2W: PCB 30×65mm, M2.5 holes at (3.5,3.5)(26.5,3.5)(3.5,61.5)(26.5,61.5).
M3 standoff: OD 6mm → print 5.8mm. Boss OD = 3× hole OD. PCB gap above standoff: 0.5mm. Below PCB (solder): 3.5mm.
USB-A cutout: 13.5×5.5mm. USB Micro-B: 9.5×4.5mm. USB-C: 10.5×4.3mm. HDMI mini: 12.2×6mm.
DC barrel 5.5/2.1: 10mm hole. RJ45: 17×14mm slot. 40-pin GPIO: 56×7mm strip.
Vent slots: 3mm wide, 6mm pitch, 10%+ open area. Fan mount: 30mm @ ±12.5mm M3, 40mm @ ±16mm.
Cable tie slot: 4×2mm. JST-XH 2-pin: 5.5×8.5mm, 5mm pull clearance.`,

    mechanical: `## MECHANICAL / GEARS / FASTENERS / STRUCTURAL
Clearance holes: M2=2.4mm, M3=3.4mm, M4=4.4mm, M5=5.4mm.
Heat-set M3: print pocket Ø4.3mm × 6.2mm deep. M4: Ø5.4mm × 8.2mm deep.
Hex nut M3: 5.5mm AF → 6.0mm pocket, 2.4mm deep. M4: 7.0mm AF → 7.5mm, 3.2mm.
Socket cap heads: M2 Ø3.8/H2.0, M3 Ø5.5/H3.0, M4 Ø7.0/H4.0, M5 Ø8.5/H5.0.
Min structural wall: 2.4mm (2 perimeters). Load-bearing: 3–4mm + 45° gussets.
Boss wall: ≥ 1.5× hole dia (self-tap), ≥ 1.0× (heat-set). Rib: 60% of wall H, max 3× wall height.
FDM tolerances — press-fit: −0.1mm radius. Sliding: +0.15–0.2mm radius. Loose: +0.3mm.
D-flat shaft: flat at shaft_r − 0.5mm from axis. Set screw M2 or M3.
GT2 belt tension: 3–5N. Pulley bore = shaft + 0.05mm interference. Flanges prevent walkoff.
Gear module 1.5+ for FDM. Center distance = (T1+T2)/2 × module + 0.2mm gap.`,

    printing: `## FDM 3D PRINTING DESIGN RULES
Overhang limit: 45–50° from vertical without support. Bridge span: 30–50mm max (20mm safe).
Use 45° chamfers on horizontal overhangs — they are self-supporting; fillets require support.
Layer height: 0.2mm standard. 0.1mm fine detail, 0.3mm speed (weaker). Perimeters: 3 minimum (1.2mm at 0.4mm nozzle).
Min wall: 1.2mm printable, 2.4mm practical. Min hole: 1.5mm; design +0.2mm for holes < 2mm.
Min pin: 2mm dia, 3mm tall. Min text stroke: 0.6mm, 1mm height embossed; 0.8mm debossed.
Print-in-place gap: 0.3mm minimum between moving parts. Elephant foot: 0.2mm bottom chamfer.
PLA: brittle, 60°C max. PETG: tougher, 80°C, expand clearances +0.05mm. TPU: flexible, 25mm/s.
Infill: 20% gyroid general, 40–60% structural, 100% small critical features. 3 top/bottom layers.
Orient parts: critical load paths in XY (40% weaker in Z). Gusset internal corners.`,

    enclosures: `## ENCLOSURES / BOXES / HOUSINGS
Two-piece box: lid stepped inside base on 1.2mm lip. Lid-to-base clearance: 0.2mm side.
Snap clips: 1.5mm hook, 45° chamfer entry, at 30–40mm intervals per side.
Corner alignment pins: Ø3mm × 4mm tall on base; Ø3.15mm holes in lid.
Wall thickness: display=1.5mm, electronics=2.0–2.5mm, portable=2.5–3.0mm, outdoor=3.0–4.0mm.
M3 standoff: boss OD 9mm, height = standoff + 1.6mm PCB. PCB side clearance: 1mm.
Panel cutout chamfer: 0.5mm all around (improves feel). Group connectors on one face.
Strain relief slot: 5mm × (cable OD + 1mm), 1.5mm wall each side.
Fan mount: 30mm fan = 4×M3 at ±12.5mm. Passive vents: 3mm × 20mm slots, 6mm pitch, 10% open area.
DIN rail: 35mm rail, clip 7.5mm deep, fixed + spring tab 15mm apart.
Label emboss: 0.5mm raise, 1.2mm stroke minimum. Deboss: 1.5mm deep flat bottom pocket.`
};

/**
 * Detect which engineering domains are relevant to the user's prompt.
 * Returns an array of domain keys from DOMAIN_PROMPTS.
 */
function detectDomains(prompt) {
    const p = (prompt || '').toLowerCase();
    const detected = [];
    if (/servo|actuator|robot|arm\b|joint|linkage|motor|gripper|chassis|wheel|bearing|nema|stepper|mechanism/.test(p))
        detected.push('robotics');
    if (/arduino|esp32|raspberry|r\s?pi\b|pcb|circuit board|microcontroller|sensor|gpio|uart|i2c|spi|wifi module|bluetooth module/.test(p))
        detected.push('electronics');
    if (/gear|shaft|pulley|belt|thread|screw|bolt|nut|heat.?set|insert|fastener|coupling|spring|snap fit/.test(p))
        detected.push('mechanical');
    if (/print|fdm|layer|infill|overhang|support|bridge|filament|slicer|tolerance|shrink/.test(p))
        detected.push('printing');
    if (/box|enclosure|case|housing|cover|lid|shell|container|rack|panel|din rail/.test(p))
        detected.push('enclosures');
    return detected;
}

// ── Requirements Dialogue ─────────────────────────────────────────────────────

const REQUIREMENTS_SYSTEM_PROMPT = `You are a requirements analyst for ParaForm — a browser-based parametric 3D CAD tool that generates OpenSCAD designs for 3D printing.

The user wants to design a physical object. Your job: decide if you need clarifying questions before the design is generated, and if so return 3–6 targeted questions about geometry-affecting constraints.

Return ONLY a JSON object. No markdown, no code fences.

If the request is an EDIT (keywords: add, change, fix, adjust, remove, make it, increase, decrease, update) — return:
  { "needs_clarification": false }

If the request is a NEW DESIGN and you need constraints to produce the right geometry — return:
  {
    "needs_clarification": true,
    "questions": [
      {
        "id": "snake_case_id",
        "question": "Specific question?",
        "hint": "Why this matters for the geometry",
        "type": "choice",
        "choices": ["Option A", "Option B", "Option C"]
      }
    ]
  }

Question types:
  "choice"  — user picks one (provide 2–4 options)
  "number"  — numeric value (add "unit": "mm", "default": number)
  "text"    — short free text

Rules:
  • Ask only about things that DIRECTLY change geometry: dimensions, part count, component type, mounting style
  • Do NOT ask about color, material, aesthetics, or anything you can default reasonably
  • Keep questions short and specific
  • If user already provided enough constraints (dimensions, servo type, etc.) return needs_clarification: false
  • Maximum 6 questions`;

function isNewDesignRequest(prompt) {
    const lower = prompt.toLowerCase().trim();
    // Skip requirements for clear edits
    if (/^(add|change|fix|adjust|edit|remove|delete|update|increase|decrease|move|resize|rotate|make it|set the|give it|reduce|enlarge|shrink|put a|put the)/.test(lower)) return false;
    if (/\b(add a|add some|remove the|change the|fix the|edit the|update the)\b/.test(lower)) return false;
    // Trigger for new designs
    return /\b(make|build|create|design|generate|i want|i need|draw|model|produce)\b/.test(lower);
}

async function runRequirementsPhase(prompt) {
    const provider = localStorage.getItem('paraform_ai_provider') || 'local';
    const apiKey   = localStorage.getItem('paraform_ai_key') || '';
    const customUrl   = localStorage.getItem('paraform_custom_url') || '';
    const customModel = provider === 'gemini'
        ? (localStorage.getItem('paraform_google_model') || 'gemini-2.5-flash')
        : (localStorage.getItem('paraform_custom_model') || '');

    if (!apiKey || provider === 'local') return null;

    try {
        const raw = await callLLMApiRaw(provider, apiKey, REQUIREMENTS_SYSTEM_PROMPT,
            [{ role: 'user', content: `Design request: "${prompt}"` }], customUrl, customModel);
        const clean = raw.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
        const parsed = JSON.parse(clean);
        if (!parsed.needs_clarification || !Array.isArray(parsed.questions) || !parsed.questions.length) return null;
        return parsed;
    } catch (e) {
        console.warn('[RequirementsPhase] Skipped:', e.message);
        return null;
    }
}

function appendRequirementsMessage(originalPrompt, questions, prePromptState) {
    aiChatHistory.push({
        role: 'requirements',
        content: '',
        previousState: prePromptState,
        meta: { originalPrompt, questions, answers: {}, submitted: false },
    });
    saveChatHistory();
    renderChatHistory();
}

function buildRequirementsCard(msg, msgIndex) {
    const meta = msg.meta || {};
    const card = document.createElement('div');
    card.className = 'requirements-card';
    card.id = `req-card-${msgIndex}`;

    if (meta.submitted) {
        const summary = Object.entries(meta.answers || {})
            .filter(([,v]) => v !== '' && v != null)
            .map(([k, v]) => `${v}`)
            .join(' · ') || 'defaults used';
        card.innerHTML = `<div class="req-submitted-header">
            <span class="material-symbols-outlined" style="font-size:14px;color:#22c55e">check_circle</span>
            <span style="font-size:12px;color:var(--text-secondary)">Requirements set — ${escapeHtml(summary)}</span>
        </div>`;
        return card;
    }

    // Header
    card.innerHTML = `<div class="req-header">
        <span class="material-symbols-outlined" style="font-size:18px;color:#f97316;flex-shrink:0">psychology</span>
        <div>
            <div class="req-header-title">Before I design your <em>${escapeHtml(meta.originalPrompt || '')}</em></div>
            <div class="req-header-sub">Answer these questions for the most accurate model. All optional — skip to use smart defaults.</div>
        </div>
    </div>`;

    const questionsDiv = document.createElement('div');
    questionsDiv.className = 'req-questions';

    (meta.questions || []).forEach(q => {
        const qRow = document.createElement('div');
        qRow.className = 'req-question';

        const label = document.createElement('div');
        label.className = 'req-question-label';
        label.innerHTML = escapeHtml(q.question) + (q.hint ? ` <span class="req-hint">${escapeHtml(q.hint)}</span>` : '');
        qRow.appendChild(label);

        const inputArea = document.createElement('div');
        inputArea.className = 'req-input-area';

        if (q.type === 'choice') {
            (q.choices || []).forEach(choice => {
                const chip = document.createElement('button');
                chip.className = 'req-choice-chip' + (meta.answers[q.id] === choice ? ' selected' : '');
                chip.textContent = choice;
                chip.onclick = () => {
                    inputArea.querySelectorAll('.req-choice-chip').forEach(c => c.classList.remove('selected'));
                    chip.classList.add('selected');
                    aiChatHistory[msgIndex].meta.answers[q.id] = choice;
                    saveChatHistory();
                };
                inputArea.appendChild(chip);
            });
        } else if (q.type === 'number') {
            const wrap = document.createElement('div');
            wrap.className = 'req-number-wrap';
            const inp = document.createElement('input');
            inp.type = 'number';
            inp.className = 'req-number-input';
            inp.value = meta.answers[q.id] ?? (q.default ?? '');
            inp.placeholder = q.default ?? '';
            if (q.min !== undefined) inp.min = q.min;
            if (q.max !== undefined) inp.max = q.max;
            inp.oninput = () => { aiChatHistory[msgIndex].meta.answers[q.id] = inp.value; saveChatHistory(); };
            wrap.appendChild(inp);
            if (q.unit) { const u = document.createElement('span'); u.className = 'req-unit'; u.textContent = q.unit; wrap.appendChild(u); }
            inputArea.appendChild(wrap);
        } else {
            const inp = document.createElement('input');
            inp.type = 'text';
            inp.className = 'req-text-input';
            inp.placeholder = q.hint || '';
            inp.value = meta.answers[q.id] ?? '';
            inp.oninput = () => { aiChatHistory[msgIndex].meta.answers[q.id] = inp.value; saveChatHistory(); };
            inputArea.appendChild(inp);
        }

        qRow.appendChild(inputArea);
        questionsDiv.appendChild(qRow);
    });

    card.appendChild(questionsDiv);

    const actions = document.createElement('div');
    actions.className = 'req-actions';

    const genBtn = document.createElement('button');
    genBtn.className = 'req-generate-btn';
    genBtn.innerHTML = `<span class="material-symbols-outlined" style="font-size:14px;vertical-align:middle">auto_awesome</span> Generate`;
    genBtn.onclick = () => submitRequirementsForm(msgIndex);

    const skipBtn = document.createElement('button');
    skipBtn.className = 'req-skip-btn';
    skipBtn.textContent = 'Skip / Use defaults';
    skipBtn.onclick = () => submitRequirementsForm(msgIndex, true);

    actions.appendChild(genBtn);
    actions.appendChild(skipBtn);
    card.appendChild(actions);
    return card;
}

async function submitRequirementsForm(msgIndex, skipAnswers = false) {
    const msg = aiChatHistory[msgIndex];
    if (!msg || msg.meta?.submitted) return;

    msg.meta.submitted = true;
    saveChatHistory();
    renderChatHistory();

    const { originalPrompt, questions = [], answers = {} } = msg.meta;

    let enrichedPrompt = originalPrompt;
    if (!skipAnswers) {
        const constraints = questions
            .filter(q => answers[q.id] !== undefined && String(answers[q.id]).trim() !== '')
            .map(q => `${q.question.replace(/\?$/, '')}: ${answers[q.id]}${q.unit ? ' ' + q.unit : ''}`)
            .join('\n');
        if (constraints) enrichedPrompt = `${originalPrompt}\n\nDesign constraints (from user):\n${constraints}`;
    }

    const generateBtn = document.getElementById('ai-generate-btn');
    if (generateBtn) generateBtn.disabled = true;
    createAILoadingBubble('Thinking');
    try {
        await runAIGenerationPipeline(enrichedPrompt, msg.previousState);
    } catch (err) {
        appendChatMessage('system', `<span class="material-symbols-outlined">error_outline</span> ERROR: ${err.message}`);
        console.error('[Requirements] Generation error:', err);
    } finally {
        if (generateBtn) generateBtn.disabled = false;
        removeAILoadingBubble();
    }
}

// ── Pipeline Log Overlay ──────────────────────────────────────────────────────
function initPipelineLogOverlay() {
    // Create the overlay DOM
    const overlay = document.createElement('div');
    overlay.id = 'pipeline-log-overlay';
    overlay.innerHTML = `
        <div class="pl-panel">
            <div class="pl-header">
                <div class="pl-header-title">
                    <span class="material-symbols-outlined sm">monitor_heart</span>
                    Pipeline Log
                </div>
                <span class="pl-header-hint">Shift+L to close &nbsp;·&nbsp; auto-refreshes</span>
            </div>
            <div class="pl-body" id="pl-body"></div>
        </div>`;
    document.body.appendChild(overlay);

    let visible = false;

    function renderLog() {
        const body = document.getElementById('pl-body');
        if (!body) return;
        const runs = PipelineLog.last(30).slice().reverse(); // newest first
        if (!runs.length) {
            body.innerHTML = '<div class="pl-empty">No pipeline runs yet.<br>Generate something to see activity here.</div>';
            return;
        }
        body.innerHTML = runs.map(run => {
            const ok     = run.ok === true ? 'ok' : run.ok === false ? 'fail' : 'warn';
            const badge  = `<span class="pl-badge ${ok}">${ok}</span>`;
            const time   = run.total != null ? `${run.total}ms` : '…';
            const stages = (run.stages || []).map(s => `
                <div class="pl-stage ${s.status}">
                    <span class="pl-stage-name">${escapeHtml(s.name)}</span>
                    <span class="pl-stage-detail">${escapeHtml(s.detail || '')}</span>
                    <span class="pl-stage-dt">${s.dt}ms</span>
                </div>`).join('');
            return `
                <div class="pl-run">
                    <div class="pl-run-header">
                        ${badge}
                        <span class="pl-run-label">${escapeHtml(run.label)}</span>
                        <span class="pl-run-time">${time}</span>
                    </div>
                    <div class="pl-stages">${stages}</div>
                </div>`;
        }).join('');
    }

    function show() {
        visible = true;
        renderLog();
        overlay.classList.add('visible');
    }
    function hide() {
        visible = false;
        overlay.classList.remove('visible');
    }

    // Shift+L toggles
    document.addEventListener('keydown', e => {
        if (e.key === 'L' && e.shiftKey && !e.ctrlKey && !e.metaKey) {
            const tag = document.activeElement?.tagName?.toLowerCase();
            if (tag === 'input' || tag === 'textarea') return;
            visible ? hide() : show();
        }
        if (e.key === 'Escape' && visible) hide();
    });

    // Click outside the panel to close
    overlay.addEventListener('click', e => {
        if (!e.target.closest('.pl-panel')) hide();
    });

    // Re-render when new runs arrive (poll while open)
    setInterval(() => { if (visible) renderLog(); }, 800);
}

// ── Panel Resize ──────────────────────────────────────────────────────────────
function initPanelResize() {
    const STORAGE_KEY = 'paraform_panel_widths';
    const MIN_WIDTH = { 'config-panel': 260, 'info-panel': 240 };
    const MAX_WIDTH = 600;

    function loadWidths() {
        try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch { return {}; }
    }

    function saveWidth(panelId, width) {
        const w = loadWidths();
        w[panelId] = width;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(w));
    }

    function applyStoredWidths() {
        const widths = loadWidths();
        for (const [id, width] of Object.entries(widths)) {
            const el = document.getElementById(id);
            if (el) el.style.setProperty('width', `${width}px`, 'important');
        }
    }

    applyStoredWidths();

    document.querySelectorAll('.panel-resize-handle').forEach(handle => {
        const panelId = handle.dataset.panel;
        const isLeft = handle.classList.contains('panel-resize-handle-left');

        handle.addEventListener('mousedown', e => {
            e.preventDefault();
            const panel = document.getElementById(panelId);
            if (!panel) return;

            handle.classList.add('dragging');
            const startX = e.clientX;
            const startWidth = panel.offsetWidth;

            function onMove(ev) {
                const delta = isLeft ? (startX - ev.clientX) : (ev.clientX - startX);
                const newWidth = Math.max(MIN_WIDTH[panelId] || 240, Math.min(MAX_WIDTH, startWidth + delta));
                panel.style.setProperty('width', `${newWidth}px`, 'important');
            }

            function onUp() {
                handle.classList.remove('dragging');
                const panel = document.getElementById(panelId);
                if (panel) saveWidth(panelId, panel.offsetWidth);
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
            }

            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
    });
}

function applyNewOpenSCADSource(rawSource) {
    if (!currentState.template) return;

    const newSource = sanitizeAndFormatOpenSCAD(rawSource);

    if (isMultiPart() && currentState.activePart) {
        // Multi-part: write to the active part only
        const part = currentState.template.parts?.find(p => p.id === currentState.activePart);
        if (!part) return;

        part.source = newSource;
        delete part.localPreview; // disable fast preview after AI edit

        // Update part params from newly detected parameter annotations
        const newPartParams = parseParametersFromSource(newSource);
        if (newPartParams.length) {
            const oldVals = { ...(currentState.partParams[part.id] || {}) };
            part.ui_parameters = newPartParams;
            currentState.partParams[part.id] = {};
            newPartParams.forEach(p => {
                currentState.partParams[part.id][p.key] = oldVals[p.key] ?? p.default;
            });
        }

        // Sync editor if script tab is visible
        if (currentState.editMode === 'code') syncCodeEditorToActivePart();
        renderParameters();
        triggerGeneration(true);
    } else if (!isMultiPart()) {
        // Single-part: existing behavior
        delete currentState.template.localPreview;

        const codeEditor = document.getElementById('code-editor');
        if (codeEditor) codeEditor.value = newSource;

        currentState.template.source = newSource;

        const newParams = parseParametersFromSource(newSource);
        currentState.template.ui_parameters = newParams;

        const oldParams = { ...currentState.params };
        currentState.params = {};
        newParams.forEach(p => {
            currentState.params[p.key] = oldParams[p.key] ?? p.default;
        });

        renderParameters();
        triggerGeneration(true);
    }

    console.log('[ParaForm] AI code applied and compilation triggered.');
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

        // Show/hide Google model selector
        const googleModelRow = document.getElementById('ai-google-model-row');
        if (googleModelRow) googleModelRow.classList.toggle('hidden', val !== 'gemini');

        // Show custom fields for 'custom' (URL+model) or 'openrouter' (model only)
        customFields.classList.toggle('hidden', val !== 'custom' && val !== 'openrouter');
        const urlRow = document.getElementById('ai-custom-url-row');
        const modelRow = document.getElementById('ai-custom-model-row');
        const modelLabel = document.getElementById('ai-custom-model-label');
        const modelInput = document.getElementById('ai-custom-model-input');
        if (urlRow) urlRow.classList.toggle('hidden', val === 'openrouter');
        if (modelRow) modelRow.classList.remove('hidden');
        if (modelLabel) modelLabel.innerText = val === 'openrouter' ? 'Model ID (e.g. openai/gpt-4o-mini)' : 'Model ID';
        if (modelInput && val === 'openrouter' && !modelInput.value) {
            modelInput.placeholder = 'e.g. openai/gpt-4o-mini or anthropic/claude-3.5-sonnet';
        }

        // Toggle API Key field row
        keyFieldRow.classList.toggle('hidden', val === 'local');

        // Label dynamic adjustment
        const keyLabel = document.getElementById('ai-key-label');
        if (keyLabel) {
            if (val === 'gemini') keyLabel.innerText = 'Google AI API Key';
            else if (val === 'openai') keyLabel.innerText = 'OpenAI API Key';
            else if (val === 'anthropic') keyLabel.innerText = 'Anthropic API Key';
            else if (val === 'openrouter') keyLabel.innerText = 'OpenRouter API Key';
            else keyLabel.innerText = 'API Key';
        }
    };
    
    // Handle password eye toggling
    if (keyToggle && keyInput) {
        keyToggle.onclick = () => {
            const isPassword = keyInput.type === 'password';
            keyInput.type = isPassword ? 'text' : 'password';
            keyToggle.innerHTML = isPassword ? '<span class="material-symbols-outlined">lock</span>' : '<span class="material-symbols-outlined">visibility</span>';
        };
    }
    
    // Save button click
    saveBtn.onclick = () => {
        localStorage.setItem('paraform_ai_provider', providerSelect.value);
        localStorage.setItem('paraform_ai_key', keyInput.value.trim());

        const googleModelSelect = document.getElementById('ai-google-model-select');
        const urlInput = document.getElementById('ai-custom-url-input');
        const modelInput = document.getElementById('ai-custom-model-input');
        const systemPromptInput = document.getElementById('ai-system-prompt-input');
        if (googleModelSelect) localStorage.setItem('paraform_google_model', googleModelSelect.value);
        if (urlInput) localStorage.setItem('paraform_custom_url', urlInput.value.trim());
        if (modelInput) localStorage.setItem('paraform_custom_model', modelInput.value.trim());
        if (systemPromptInput) localStorage.setItem('paraform_ai_system_prompt', systemPromptInput.value.trim());

        modal.classList.add('hidden');
        updateAIModelLabel();
        const modelName = providerSelect.value === 'gemini'
            ? (GOOGLE_MODEL_NAMES[googleModelSelect?.value] || googleModelSelect?.value || 'Gemini')
            : providerSelect.value.toUpperCase();
        appendChatMessage('system', `AI Settings updated. Active Model: ${modelName}`);
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
    const googleModelSelect = document.getElementById('ai-google-model-select');
    const systemPromptInput = document.getElementById('ai-system-prompt-input');

    if (!modal) return;

    // Load persisted configurations
    const provider = localStorage.getItem('paraform_ai_provider') || 'local';
    const key = localStorage.getItem('paraform_ai_key') || '';
    const customUrl = localStorage.getItem('paraform_custom_url') || '';
    const customModel = localStorage.getItem('paraform_custom_model') || '';
    const googleModel = localStorage.getItem('paraform_google_model') || 'gemini-2.5-flash';
    const customSystemPrompt = localStorage.getItem('paraform_ai_system_prompt') || '';

    if (providerSelect) providerSelect.value = provider;
    if (keyInput) keyInput.value = key;
    if (urlInput) urlInput.value = customUrl;
    if (modelInput) modelInput.value = customModel;
    if (googleModelSelect) googleModelSelect.value = googleModel;
    if (systemPromptInput) systemPromptInput.value = customSystemPrompt;

    // Toggle field visibility matching loaded configuration
    const isGemini = provider === 'gemini';
    const isCustom = provider === 'custom';
    const isOpenRouter = provider === 'openrouter';
    const googleModelRow = document.getElementById('ai-google-model-row');
    if (googleModelRow) googleModelRow.classList.toggle('hidden', !isGemini);
    if (customFields) customFields.classList.toggle('hidden', !isCustom && !isOpenRouter);
    const urlRow = document.getElementById('ai-custom-url-row');
    const modelLabel = document.getElementById('ai-custom-model-label');
    if (urlRow) urlRow.classList.toggle('hidden', isOpenRouter);
    if (modelLabel) modelLabel.innerText = isOpenRouter ? 'Model ID (e.g. openai/gpt-4o-mini)' : 'Model ID';
    if (modelInput && isOpenRouter && !modelInput.placeholder.includes('openai/')) {
        modelInput.placeholder = 'e.g. openai/gpt-4o-mini or anthropic/claude-3.5-sonnet';
    }
    if (keyFieldRow) keyFieldRow.classList.toggle('hidden', provider === 'local');

    const keyLabel = document.getElementById('ai-key-label');
    if (keyLabel && providerSelect) {
        if (provider === 'gemini') keyLabel.innerText = 'Google AI API Key';
        else if (provider === 'openai') keyLabel.innerText = 'OpenAI API Key';
        else if (provider === 'anthropic') keyLabel.innerText = 'Anthropic API Key';
        else if (provider === 'openrouter') keyLabel.innerText = 'OpenRouter API Key';
        else keyLabel.innerText = 'API Key';
    }

    // Display Modal overlay
    modal.classList.remove('hidden');
}

// ============================================================
// APP SETTINGS MODAL
// ============================================================
function openAppSettingsModal() {
    const modal = document.getElementById('app-settings-modal');
    if (!modal) return;

    const s = getSettings();

    // ── Panel switching ──────────────────────────────────────
    const navItems = modal.querySelectorAll('.settings-nav-item');
    const panels   = modal.querySelectorAll('.settings-panel');

    function showPanel(panelId) {
        navItems.forEach(b => b.classList.toggle('active', b.dataset.panel === panelId));
        panels.forEach(p  => p.classList.toggle('active',  p.dataset.settingsPanel === panelId));
    }
    navItems.forEach(btn => { btn.onclick = () => showPanel(btn.dataset.panel); });

    // ── Populate all controls ────────────────────────────────
    function setVal(id, val) {
        const el = document.getElementById(id);
        if (!el) return;
        if (el.type === 'checkbox') el.checked = val;
        else el.value = String(val);
    }
    function setSlider(id, val, labelId, fmt) {
        const el = document.getElementById(id);
        if (el) { el.value = String(val); updateSliderFill(el); }
        const lb = document.getElementById(labelId);
        if (lb) lb.innerText = fmt(val);
    }
    function setRadio(name, val) {
        const radios = modal.querySelectorAll(`input[name="${name}"]`);
        radios.forEach(r => { r.checked = (r.value === String(val)); });
    }
    function setBgChip(val) {
        modal.querySelectorAll('.bg-chip').forEach(c => c.classList.toggle('active', c.dataset.bg === val));
    }

    // General
    setVal('s-pref-unit',    s.preferences.unitSystem);
    setVal('s-pref-autosave', s.preferences.autoSave);
    setVal('s-pref-startup',  s.preferences.startup);
    // Viewport
    setVal('s-vp-display',   s.viewport.defaultDisplayMode);
    setBgChip(s.viewport.background);
    setVal('s-vp-grid',      s.viewport.showGrid);
    setSlider('s-vp-gridsize', s.viewport.gridSize,  's-vp-gridsize-val', v => `${v}mm`);
    setVal('s-vp-axes',      s.viewport.showAxes);
    setSlider('s-vp-fov',    s.viewport.fov,         's-vp-fov-val',      v => `${v}°`);
    // Camera
    setSlider('s-cam-orbit', s.camera.orbitSpeed,    's-cam-orbit-val',   v => `${parseFloat(v).toFixed(2)}×`);
    setSlider('s-cam-zoom',  s.camera.zoomSpeed,     's-cam-zoom-val',    v => `${parseFloat(v).toFixed(2)}×`);
    setSlider('s-cam-pan',   s.camera.panSpeed,      's-cam-pan-val',     v => `${parseFloat(v).toFixed(2)}×`);
    setSlider('s-cam-damp',  s.camera.dampingFactor, 's-cam-damp-val',    v => parseFloat(v).toFixed(2));
    setVal('s-cam-invert',   s.camera.invertY);
    setVal('s-cam-autofit',  s.camera.autoFitOnCompile);
    // Performance
    setRadio('s-perf-quality', s.performance.compileQuality);
    setVal('s-perf-delay',   String(s.performance.autoRecompileDelay));
    setVal('s-perf-workers', String(s.performance.workerThreads));
    // Graphics
    setVal('s-gfx-aa',       s.graphics.antialias);
    setSlider('s-gfx-edge',  s.graphics.edgeThickness, 's-gfx-edge-val',  v => `${v}px`);
    setVal('s-gfx-dpr',      String(s.graphics.pixelRatio));
    // Measurement
    setVal('s-meas-unit',    s.measurement.unit);
    setVal('s-meas-decimals', String(s.measurement.decimalPlaces));
    // Export
    setVal('s-exp-format',   s.export.defaultFormat);
    setRadio('s-exp-stltype', s.export.stlType);
    setRadio('s-exp-quality', s.export.exportQuality);
    setVal('s-exp-filename',  s.export.filenamePattern);
    // Presets / Diagnostics
    setVal('s-diag-fps',     s.diagnostics.showFPS);
    setVal('s-diag-poly',    s.diagnostics.showPolygonCount);
    setVal('s-diag-time',    s.diagnostics.showCompileTime);

    // ── Build shortcut table ─────────────────────────────────
    renderShortcutTable(s.keybindings);

    // ── Live-apply on change ─────────────────────────────────
    function wire(id, path, transform) {
        const el = document.getElementById(id);
        if (!el) return;
        el.oninput = el.onchange = () => {
            const raw = el.type === 'checkbox' ? el.checked : el.value;
            const val = transform ? transform(raw) : raw;
            const parts = path.split('.');
            const patch = {};
            let cur = patch;
            parts.forEach((p, i) => { cur[p] = i === parts.length - 1 ? val : {}; cur = cur[p]; });
            saveSettings(patch);
        };
    }
    function wireSlider(id, path, labelId, fmt, transform) {
        const el = document.getElementById(id);
        if (!el) return;
        el.oninput = () => {
            updateSliderFill(el);
            const lb = document.getElementById(labelId);
            if (lb) lb.innerText = fmt(el.value);
            const val = transform ? transform(el.value) : parseFloat(el.value);
            const parts = path.split('.');
            const patch = {};
            let cur = patch;
            parts.forEach((p, i) => { cur[p] = i === parts.length - 1 ? val : {}; cur = cur[p]; });
            saveSettings(patch);
        };
    }
    function wireRadio(name, path, transform) {
        modal.querySelectorAll(`input[name="${name}"]`).forEach(r => {
            r.onchange = () => {
                if (!r.checked) return;
                const val = transform ? transform(r.value) : r.value;
                const parts = path.split('.');
                const patch = {};
                let cur = patch;
                parts.forEach((p, i) => { cur[p] = i === parts.length - 1 ? val : {}; cur = cur[p]; });
                saveSettings(patch);
            };
        });
    }

    // General
    wire('s-pref-unit',    'preferences.unitSystem');
    wire('s-pref-autosave','preferences.autoSave', v => { restartAutoSave(); return v; });
    wire('s-pref-startup', 'preferences.startup');
    // Viewport
    wire('s-vp-display',   'viewport.defaultDisplayMode', v => { applyDisplayMode(v); return v; });
    modal.querySelectorAll('.bg-chip').forEach(chip => {
        chip.onclick = () => {
            modal.querySelectorAll('.bg-chip').forEach(c => c.classList.remove('active'));
            chip.classList.add('active');
            saveSettings({ viewport: { background: chip.dataset.bg } });
        };
    });
    wire('s-vp-grid',      'viewport.showGrid', v => !!v);
    wireSlider('s-vp-gridsize', 'viewport.gridSize', 's-vp-gridsize-val', v => `${v}mm`, v => parseInt(v, 10));
    wire('s-vp-axes',      'viewport.showAxes', v => !!v);
    wireSlider('s-vp-fov', 'viewport.fov', 's-vp-fov-val', v => `${v}°`, v => parseInt(v, 10));
    // Camera
    wireSlider('s-cam-orbit', 'camera.orbitSpeed',    's-cam-orbit-val', v => `${parseFloat(v).toFixed(2)}×`, parseFloat);
    wireSlider('s-cam-zoom',  'camera.zoomSpeed',     's-cam-zoom-val',  v => `${parseFloat(v).toFixed(2)}×`, parseFloat);
    wireSlider('s-cam-pan',   'camera.panSpeed',      's-cam-pan-val',   v => `${parseFloat(v).toFixed(2)}×`, parseFloat);
    wireSlider('s-cam-damp',  'camera.dampingFactor', 's-cam-damp-val',  v => parseFloat(v).toFixed(2),       parseFloat);
    wire('s-cam-invert',   'camera.invertY',         v => !!v);
    wire('s-cam-autofit',  'camera.autoFitOnCompile', v => !!v);
    // Performance
    wireRadio('s-perf-quality', 'performance.compileQuality');
    wire('s-perf-delay',   'performance.autoRecompileDelay', v => parseInt(v, 10));
    wire('s-perf-workers', 'performance.workerThreads',      v => v === 'auto' ? 'auto' : parseInt(v, 10));
    // Graphics
    wire('s-gfx-aa',       'graphics.antialias',    v => !!v);
    wireSlider('s-gfx-edge', 'graphics.edgeThickness', 's-gfx-edge-val', v => `${v}px`, parseFloat);
    wire('s-gfx-dpr',      'graphics.pixelRatio',   v => v === '1' || v === '1.5' || v === '2' ? parseFloat(v) : v);
    // Measurement
    wire('s-meas-unit',    'measurement.unit');
    wire('s-meas-decimals','measurement.decimalPlaces', v => parseInt(v, 10));
    // Export
    wire('s-exp-format',   'export.defaultFormat');
    wireRadio('s-exp-stltype', 'export.stlType');
    wireRadio('s-exp-quality', 'export.exportQuality');
    wire('s-exp-filename', 'export.filenamePattern');
    // Diagnostics
    wire('s-diag-fps',     'diagnostics.showFPS',          v => !!v);
    wire('s-diag-poly',    'diagnostics.showPolygonCount',  v => !!v);
    wire('s-diag-time',    'diagnostics.showCompileTime',   v => !!v);

    // ── Diagnostics actions ──────────────────────────────────
    const clearCacheBtn = document.getElementById('s-diag-clear-cache');
    if (clearCacheBtn) clearCacheBtn.onclick = () => {
        Object.keys(localStorage).filter(k => k.startsWith('thumbnail_')).forEach(k => localStorage.removeItem(k));
        clearCacheBtn.innerText = 'Cleared!';
        setTimeout(() => { clearCacheBtn.innerText = 'Clear'; }, 2000);
    };

    const copyDiagsBtn = document.getElementById('s-diag-copy');
    if (copyDiagsBtn) copyDiagsBtn.onclick = () => {
        const info = {
            version: 'v0.11',
            userAgent: navigator.userAgent,
            webgl: (() => { try { const c = document.createElement('canvas'); return c.getContext('webgl2') ? 'WebGL2' : 'WebGL1'; } catch { return 'none'; } })(),
            settings: getSettings(),
            timestamp: new Date().toISOString(),
        };
        navigator.clipboard?.writeText(JSON.stringify(info, null, 2)).then(() => {
            copyDiagsBtn.innerText = 'Copied!';
            setTimeout(() => { copyDiagsBtn.innerText = 'Copy'; }, 2000);
        });
    };

    // ── Preset cards ─────────────────────────────────────────
    const PRESETS = {
        'cad-draft': {
            viewport:    { defaultDisplayMode: 'shaded', background: 'black', showGrid: true, gridSize: 10 },
            performance: { compileQuality: 'preview', autoRecompileDelay: 200 },
            camera:      { autoFitOnCompile: false },
            diagnostics: { showFPS: false, showPolygonCount: true, showCompileTime: true },
        },
        'presentation': {
            viewport:    { defaultDisplayMode: 'shaded', background: 'default', showGrid: false, fov: 65 },
            performance: { compileQuality: 'high', autoRecompileDelay: 1000 },
            camera:      { autoFitOnCompile: true, dampingFactor: 0.08 },
            graphics:    { pixelRatio: 'device' },
            diagnostics: { showFPS: false, showPolygonCount: false, showCompileTime: false },
        },
        'development': {
            viewport:    { defaultDisplayMode: 'shaded-edges', background: 'default', showGrid: true, showAxes: true },
            performance: { compileQuality: 'balanced', autoRecompileDelay: 500 },
            camera:      { autoFitOnCompile: true },
            diagnostics: { showFPS: true, showPolygonCount: true, showCompileTime: true },
        },
    };
    modal.querySelectorAll('.preset-card').forEach(card => {
        card.onclick = () => {
            const preset = PRESETS[card.dataset.preset];
            if (!preset) return;
            if (!confirm(`Apply "${card.querySelector('.preset-card-name').innerText}" preset? This will overwrite your current settings.`)) return;
            saveSettings(preset);
            modal.classList.add('hidden');
            openAppSettingsModal(); // reopen to reflect new values
        };
    });

    // ── Reset to defaults ────────────────────────────────────
    const resetBtn = document.getElementById('settings-reset-btn');
    if (resetBtn) resetBtn.onclick = () => {
        if (!confirm('Reset all settings to defaults? This cannot be undone.')) return;
        localStorage.removeItem(SETTINGS_KEY);
        applySettings(DEFAULT_SETTINGS);
        modal.classList.add('hidden');
        openAppSettingsModal();
    };

    // ── Restore shortcut defaults ────────────────────────────
    const restoreShortcutsBtn = document.getElementById('shortcuts-restore-defaults');
    if (restoreShortcutsBtn) restoreShortcutsBtn.onclick = () => {
        saveSettings({ keybindings: { ...DEFAULT_KEYBINDINGS } });
        renderShortcutTable(getSettings().keybindings);
    };

    // ── Done / close ─────────────────────────────────────────
    const closeBtn = document.getElementById('settings-close-btn');
    if (closeBtn) closeBtn.onclick = () => modal.classList.add('hidden');
    modal.onclick = e => { if (e.target === modal) modal.classList.add('hidden'); };

    modal.classList.remove('hidden');
}

function renderShortcutTable(bindings) {
    const table = document.getElementById('shortcut-table');
    if (!table) return;
    table.innerHTML = '';

    for (const [actionId, binding] of Object.entries(bindings)) {
        const row = document.createElement('div');
        row.className = 'shortcut-row';
        row.dataset.action = actionId;

        const label = document.createElement('span');
        label.className = 'shortcut-row-label';
        label.innerText = binding.label;

        const badge = document.createElement('span');
        badge.className = 'shortcut-badge';
        badge.innerText = formatCombo(binding);

        const editBtn = document.createElement('button');
        editBtn.className = 'capture-btn';
        editBtn.innerText = 'Edit';

        const resetBtn = document.createElement('button');
        resetBtn.className = 'shortcut-reset-btn';
        resetBtn.title = 'Reset to default';
        resetBtn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>';

        row.append(label, badge, editBtn, resetBtn);
        table.appendChild(row);

        editBtn.onclick = () => startCapture(row, badge, actionId, bindings);
        resetBtn.onclick = () => {
            const def = DEFAULT_KEYBINDINGS[actionId];
            if (!def) return;
            bindings[actionId] = { ...def };
            saveSettings({ keybindings: { ...bindings } });
            badge.innerText = formatCombo(def);
            badge.classList.remove('conflict');
        };
    }
}

function formatCombo(b) {
    if (!b?.key) return '—';
    const parts = [];
    if (b.ctrl)  parts.push('Ctrl');
    if (b.shift) parts.push('Shift');
    if (b.alt)   parts.push('Alt');
    parts.push(b.key === ',' ? ',' : b.key.toUpperCase());
    return parts.join(' + ');
}

function startCapture(row, badge, actionId, bindings) {
    if (isCapturingKeybinding) return;
    isCapturingKeybinding = true;
    row.classList.add('capturing');
    badge.classList.remove('conflict');

    const hint = document.createElement('span');
    hint.className = 'shortcut-capture-hint';
    hint.innerText = 'Press a key…';
    badge.replaceWith(hint);

    function onCapture(e) {
        const modKeys = ['Control', 'Shift', 'Alt', 'Meta'];
        if (modKeys.includes(e.key)) return;
        e.preventDefault();
        e.stopPropagation();

        const newBinding = { key: e.key, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, label: bindings[actionId].label };
        const combo = comboStr(e.key, e.ctrlKey, e.shiftKey, e.altKey);

        // Conflict check
        const conflict = Object.entries(bindings).find(([id, b]) => id !== actionId && comboStr(b.key, b.ctrl, b.shift, b.alt) === combo);

        bindings[actionId] = newBinding;
        saveSettings({ keybindings: { ...bindings } });

        // Restore badge
        const newBadge = document.createElement('span');
        newBadge.className = 'shortcut-badge';
        newBadge.innerText = formatCombo(newBinding);
        if (conflict) {
            newBadge.classList.add('conflict');
            newBadge.title = `Conflicts with "${conflict[1].label}"`;
        }
        hint.replaceWith(newBadge);
        row.classList.remove('capturing');

        // Re-wire edit button to new badge
        row.querySelector('.capture-btn').onclick = () => startCapture(row, newBadge, actionId, bindings);

        document.removeEventListener('keydown', onCapture, true);
        isCapturingKeybinding = false;
    }

    document.addEventListener('keydown', onCapture, true);
}
