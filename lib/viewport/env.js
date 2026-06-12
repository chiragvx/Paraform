// Visual upgrade pack helpers: IBL environment, gradient background, and
// contact shadow. Used by the main viewport in main.js to give a Fusion
// 360 / Onshape look.
//
// For Z-up scene primitives (cameras, lights, ground grid, ground plane),
// see `./conventions.js` — that module re-exports `addContactShadow` from
// here so callers can import everything viewport-related from one place.

import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

/**
 * Build a PMREM-prefiltered RoomEnvironment cube map suitable for `scene.environment`.
 * Produces matte materials with soft omnidirectional shading without needing an HDR asset.
 *
 * Caller owns disposal of the returned texture; the PMREMGenerator is disposed here.
 * @param {THREE.WebGLRenderer} renderer
 * @returns {THREE.Texture}
 */
export function createRoomEnvironmentTexture(renderer) {
    const pmrem = new THREE.PMREMGenerator(renderer);
    pmrem.compileEquirectangularShader();
    const envScene = new RoomEnvironment();
    const envTexture = pmrem.fromScene(envScene, 0.04).texture;
    pmrem.dispose();
    return envTexture;
}

/**
 * Build a vertical-gradient CanvasTexture suitable for `scene.background`.
 * Defaults to a cool steel-blue Fusion-ish palette.
 * @param {string} topHex   e.g. '#2a3340'
 * @param {string} bottomHex e.g. '#4a5663'
 * @returns {THREE.CanvasTexture}
 */
export function createGradientBackgroundTexture(topHex = '#2a3340', bottomHex = '#4a5663') {
    const canvas = document.createElement('canvas');
    canvas.width = 2;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    // Top of canvas = top of viewport once mapped onto background.
    const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
    gradient.addColorStop(0, topHex);
    gradient.addColorStop(1, bottomHex);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    return tex;
}

/**
 * Add a soft contact shadow: a horizontal ShadowMaterial plane + a high overhead
 * DirectionalLight that casts onto it. Returns the plane and light so the caller
 * can move them (e.g. to track the body's min-Y) and re-tune intensity if needed.
 *
 * @param {THREE.Scene} scene
 * @param {object} [opts]
 * @param {number} [opts.size=400]          Plane size (world units)
 * @param {number} [opts.opacity=0.28]      Shadow darkness
 * @param {number} [opts.frustumHalfSize=200] Half-extent of the shadow cam ortho frustum
 * @param {number} [opts.lightHeight=300]   Y position of the shadow-casting light
 * @returns {{ plane: THREE.Mesh, light: THREE.DirectionalLight }}
 */
export function addContactShadow(scene, opts = {}) {
    const {
        size = 400,
        opacity = 0.28,
        frustumHalfSize = 200,
        lightHeight = 300,
    } = opts;

    // Z-up world (ParaForm convention): PlaneGeometry lies in XY by default
    // with normal +Z — no rotation. Caller positions it at the body's min-Z
    // each regen via `plane.position.set(cx, cy, minZ - epsilon)`.
    const plane = new THREE.Mesh(
        new THREE.PlaneGeometry(size, size),
        new THREE.ShadowMaterial({ opacity })
    );
    plane.receiveShadow = true;
    plane.renderOrder = -1;
    scene.add(plane);

    // Z-up: light is high in +Z with slight X/Y offset so its shadow camera
    // looks down at the body and produces a slightly non-axis-aligned shadow.
    const light = new THREE.DirectionalLight(0xffffff, 1.0);
    light.position.set(60, 80, lightHeight);
    light.castShadow = true;
    light.shadow.mapSize.set(2048, 2048);
    light.shadow.camera.left   = -frustumHalfSize;
    light.shadow.camera.right  =  frustumHalfSize;
    light.shadow.camera.top    =  frustumHalfSize;
    light.shadow.camera.bottom = -frustumHalfSize;
    light.shadow.camera.near   = 0.5;
    light.shadow.camera.far    = lightHeight * 2 + frustumHalfSize;
    light.shadow.bias = -0.0005;
    light.shadow.normalBias = 0.02;
    light.shadow.radius = 4;
    scene.add(light);

    return { plane, light };
}
