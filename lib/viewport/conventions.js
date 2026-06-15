/**
 * Viewport conventions — Z-up scene primitives.
 *
 * THIS PROJECT IS Z-UP. The CAD kernel (build123d/OCCT), the named-views
 * table (`./view_animator.js#NAMED_VIEWS`), and the ViewCube widget
 * (`app/viewport/view_cube.js`) all assume world +Z is "up." three.js'
 * own defaults (GridHelper, PlaneGeometry-on-the-floor, light positions)
 * are Y-up biased — drop one into the scene raw and you'll get a
 * "ground plane stuck on the back wall" or "lighting from the side."
 *
 * RULE: any new scene infrastructure (grids, ground planes, lights,
 * cameras, contact shadows) goes through this module. If you find
 * yourself reaching for `THREE.GridHelper`, `THREE.HemisphereLight`,
 * `new THREE.PerspectiveCamera(...)`, or a PlaneGeometry-on-the-floor
 * anywhere outside this file or `./env.js`, you're about to write a
 * Y-up bug. Add a helper here instead.
 *
 * This module composes with `./env.js`, which owns the IBL/contact-
 * shadow "fancy rendering pack" — `addContactShadow` is Z-up correct
 * and is re-exported here for one-stop access.
 */

import * as THREE from 'three';
import { addContactShadow } from './env.js';

// ── Single source of truth ───────────────────────────────────────────────────
/** The world up axis. Use this anywhere you need to know "which way is up." */
export const WORLD_UP = Object.freeze(new THREE.Vector3(0, 0, 1));

/** The world ground plane's Z coordinate. Primitives are emitted with
 *  Align.MIN on Z so their bottom face sits on this plane. */
export const GROUND_Z = 0;

// ── Camera ───────────────────────────────────────────────────────────────────
/**
 * Perspective camera with Z-up baked in and CAD-appropriate frustum.
 *
 * Defaults:
 *   - fov 60° (matches Fusion/Onshape "feel"; tighter than three's 75)
 *   - near 0.5, far 100000 — wide enough to never clip on zoom-out
 *     for typical mm-scale CAD scenes while keeping depth precision sane.
 *   - positioned at the ISO bisector (front-right, slightly elevated)
 *     so the standard "Home" view is recognisable on first paint.
 */
export function createCadCamera({ aspect = 1, fov = 60, near = 0.5, far = 100000 } = {}) {
    const cam = new THREE.PerspectiveCamera(fov, aspect, near, far);
    cam.up.copy(WORLD_UP);
    cam.position.set(80, -80, 80);
    return cam;
}

// ── Ground grid ──────────────────────────────────────────────────────────────
/**
 * Ground grid lying in the world XY plane.
 *
 * `THREE.GridHelper` is built in the XZ plane (Y-up default) so it must
 * be rotated +90° about X to lie in XY. Colours are tuned to read at
 * grazing angles, where horizontal grids tend to fade against the
 * background.
 *
 * The grid sits a hair below `GROUND_Z` so bodies aligned to Z=MIN don't
 * z-fight with the lines.
 */
/** @deprecated Use {@link createInfiniteGroundGrid} for new code. Kept as a
 *  light fallback for tests / early-boot code paths that need a deterministic
 *  finite grid without the LOD shader. */
export function createGroundGrid({
    size      = 400,
    divisions = 40,
    axisColor = 0x8aa0b8,
    cellColor = 0x55606b,
    opacity   = 0.9,
} = {}) {
    const grid = new THREE.GridHelper(size, divisions, axisColor, cellColor);
    grid.rotation.x = Math.PI / 2;
    grid.position.z = GROUND_Z - 0.01;
    grid.material.transparent = true;
    grid.material.opacity = opacity;
    return grid;
}

// ── Infinite ground grid (Fusion-style) ──────────────────────────────────────
/**
 * Shader-based infinite ground grid lying in world XY (normal +Z).
 *
 * Technique is the "Best Darn Grid" family popularised by Ben Golus —
 * a screen-anchored quad in the XY plane whose fragment shader derives
 * the grid line intensity from `fwidth()` of the world-space XY coords,
 * blends two power-of-10 LODs based on `log10(distance to camera)`, and
 * fades to transparent past a radial falloff so the world doesn't read
 * as a hard square edge.
 *
 * The mesh is parented at scene identity (NOT under the GLB wrap) — the
 * shader does its own world-XY math and the elevation comes from
 * `GROUND_Z`. The grid is excluded from raycasts (`raycast = noop`) so
 * pickers can't lock onto it.
 *
 * Returned mesh exposes `setTheme('light' | 'dark')` to swap colour
 * uniforms when display mode flips between the dark steel viewport and
 * technical/blueprint white.
 *
 * LOD blend:
 *   - `level = log10(dist) - 1` gives a continuous "spacing power."
 *     At ~10 mm distance: spacing = 1 mm. At ~1 m: 10 mm. At ~10 m: 100 mm.
 *   - We render the nearest two integer LODs (`floor(level)` and +1) and
 *     cross-fade by `fract(level)`. No popping.
 *
 * AA:
 *   - line intensity = `1 - smoothstep(0, lineWidth, abs(coord - round(coord)) / fwidth(coord))`
 *     keeps lines at a fixed ~1.5 device-pixel width regardless of zoom.
 */
export function createInfiniteGroundGrid({
    extent       = 100_000,         // mm — large enough to feel endless at any zoom typical for CAD
    fadeDistance = 8000,            // mm — radial falloff start (lines fully transparent past ~1.7×)
    theme        = 'dark',
} = {}) {
    const geom = new THREE.PlaneGeometry(extent, extent, 1, 1);

    // Dark-theme palette (default — matches the Fusion-blue gradient bg).
    const DARK = {
        minor: new THREE.Color(0x9098a2),
        major: new THREE.Color(0xc8cdd4),
        axisX: new THREE.Color(0xf09898),
        axisY: new THREE.Color(0x9adea0),
    };
    // Light-theme palette (technical / blueprint white bg).
    const LIGHT = {
        minor: new THREE.Color(0xc8ccd2),
        major: new THREE.Color(0x8a929c),
        axisX: new THREE.Color(0xb83a3a),
        axisY: new THREE.Color(0x2f8a3e),
    };

    const initial = theme === 'light' ? LIGHT : DARK;

    const material = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        // additive-friendly default blending; standard NormalBlending reads
        // cleanly over both gradient bg and white bg without going washed-out.
        blending: THREE.NormalBlending,
        uniforms: {
            uMinor:        { value: initial.minor.clone() },
            uMajor:        { value: initial.major.clone() },
            uAxisX:        { value: initial.axisX.clone() },
            uAxisY:        { value: initial.axisY.clone() },
            uBaseSpacing:  { value: 1.0 },         // mm — smallest LOD step
            uFadeDistance: { value: fadeDistance },
            uCameraPos:    { value: new THREE.Vector3() },
            uOpacity:      { value: 1.0 },
        },
        vertexShader: /* glsl */ `
            varying vec3 vWorldPos;
            void main() {
                vec4 wp = modelMatrix * vec4(position, 1.0);
                vWorldPos = wp.xyz;
                gl_Position = projectionMatrix * viewMatrix * wp;
            }
        `,
        fragmentShader: /* glsl */ `
            precision highp float;
            varying vec3 vWorldPos;

            uniform vec3  uMinor;
            uniform vec3  uMajor;
            uniform vec3  uAxisX;
            uniform vec3  uAxisY;
            uniform float uBaseSpacing;
            uniform float uFadeDistance;
            uniform vec3  uCameraPos;
            uniform float uOpacity;

            // Anti-aliased grid line intensity for a given spacing.
            // Returns ~1 on a line, ~0 between.
            float gridLine(vec2 p, float spacing) {
                vec2 coord = p / spacing;
                vec2 deriv = fwidth(coord);
                // distance from nearest integer line, normalised by pixel width
                vec2 grid  = abs(fract(coord - 0.5) - 0.5) / max(deriv, vec2(1e-6));
                float line = min(grid.x, grid.y);
                return 1.0 - min(line, 1.0);
            }

            // Per-axis line for highlighting world X / Y axes (lines through 0).
            float axisLine(float v, float pxScale) {
                float d = abs(v);
                float w = fwidth(v) * 1.5;
                return 1.0 - smoothstep(w * 0.5, w * 1.5, d);
            }

            void main() {
                vec2 P = vWorldPos.xy;

                // Continuous LOD level: spacing = uBaseSpacing * 10^floor(level).
                // Uniform across the whole grid — must NOT use per-fragment
                // distance or each LOD transition forms a visible ring (the
                // intersection of a fixed-distance sphere and the XY plane).
                // Use camera height instead so the entire grid steps LODs in
                // sync as the user zooms.
                float dist = max(abs(uCameraPos.z), 1.0);
                float level = log(dist) / log(10.0) - 1.0;
                float lo    = floor(level);
                float blend = level - lo;                 // 0..1 fraction between LODs

                float spacingMinor0 = uBaseSpacing * pow(10.0, lo);
                float spacingMinor1 = spacingMinor0 * 10.0;
                float spacingMajor0 = spacingMinor0 * 10.0;
                float spacingMajor1 = spacingMinor1 * 10.0;

                float minor = mix(gridLine(P, spacingMinor0),
                                  gridLine(P, spacingMinor1),
                                  blend);
                float major = mix(gridLine(P, spacingMajor0),
                                  gridLine(P, spacingMajor1),
                                  blend);

                // Composite: major lines win over minor; axes win over major.
                vec3  col = uMinor;
                float a   = minor * 0.55;

                col = mix(col, uMajor, major);
                a   = max(a, major * 0.85);

                // World axes (X axis is the line Y=0; Y axis is the line X=0).
                float ax = axisLine(P.y, 1.0);
                float ay = axisLine(P.x, 1.0);
                if (ax > 0.0) { col = mix(col, uAxisX, ax); a = max(a, ax); }
                if (ay > 0.0) { col = mix(col, uAxisY, ay); a = max(a, ay); }

                // Radial horizon fade — kills the hard quad edge.
                vec2 camXY = uCameraPos.xy;
                float r = length(P - camXY);
                float fade = 1.0 - smoothstep(uFadeDistance * 0.4, uFadeDistance, r);
                a *= fade;

                // Soft angle-fade — only kick in at *true* grazing (< ~3°);
                // any wider band shows up as a visible ring artifact when
                // the user zooms out. AA + fwidth() already handle moiré
                // at moderate angles so this only catches the extreme case.
                vec3 viewDir = normalize(uCameraPos - vWorldPos);
                float angle = clamp(abs(viewDir.z), 0.0, 1.0);
                a *= smoothstep(0.005, 0.05, angle);

                if (a <= 0.001) discard;
                gl_FragColor = vec4(col, a * uOpacity);
            }
        `,
    });

    const mesh = new THREE.Mesh(geom, material);
    // PlaneGeometry default normal is +Z (correct for Z-up — no rotation).
    mesh.position.z = GROUND_Z - 0.01;       // dodge z-fight with Z=MIN-aligned bodies
    mesh.frustumCulled = false;              // we *want* it everywhere on screen
    mesh.renderOrder = -10;                  // draw before opaque bodies / overlays
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.raycast = () => {};                 // invisible to pickers
    mesh.userData.__pf4_infinite_grid__ = true;
    mesh.name = '__pf4_infinite_grid__';

    /** Per-frame: push the live camera position into the shader. Also scales
     *  the radial fade so the boundary always sits off-screen — without this,
     *  when the user zooms out the fixed fade radius appears as a visible
     *  circular edge ("UFO halo") around the camera. Fade tracks 30× the
     *  camera's vertical distance from the ground, clamped to a sane min. */
    mesh.updateForCamera = (camera) => {
        if (!camera) return;
        material.uniforms.uCameraPos.value.copy(camera.position);
        const heightAboveGround = Math.max(Math.abs(camera.position.z - GROUND_Z), 1);
        const scaled = Math.max(fadeDistance, heightAboveGround * 30);
        material.uniforms.uFadeDistance.value = scaled;
    };

    /** Toggle the colour palette between dark (steel viewport) and light
     *  (technical / blueprint). Cheap — just copies four colour uniforms. */
    mesh.setTheme = (name) => {
        const pal = name === 'light' ? LIGHT : DARK;
        material.uniforms.uMinor.value.copy(pal.minor);
        material.uniforms.uMajor.value.copy(pal.major);
        material.uniforms.uAxisX.value.copy(pal.axisX);
        material.uniforms.uAxisY.value.copy(pal.axisY);
        mesh.userData.__pf4_grid_theme__ = name === 'light' ? 'light' : 'dark';
    };
    mesh.userData.__pf4_grid_theme__ = theme === 'light' ? 'light' : 'dark';

    return mesh;
}

/**
 * Wrap a `PlaneGeometry` into a mesh sitting on the world XY ground.
 * `PlaneGeometry` is already in XY with +Z normal, so no rotation —
 * this helper exists so callers don't need to remember that, and to
 * funnel all ground-plane creation through one place.
 */
export function createGroundPlaneMesh(geometry, material, { z = GROUND_Z } = {}) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.z = z;
    return mesh;
}

// ── Reference image plane (Phase A1) ───────────────────────────────────────────
/**
 * Build a textured plane for a reference-image underlay the user traces
 * against. Z-up correct: `PlaneGeometry` is already in XY with a +Z normal, so
 * the default (lying flat on the ground, facing up) needs NO rotation — copying
 * a Y-up tutorial's `rotation.x = -PI/2` here would stand it up as a wall.
 *
 * Callers orient/position the returned mesh from the feature's Z-up
 * `origin` / `normal` / `up`. `opacity` dims the underlay; `displayThrough`
 * draws it in front of geometry (no depth test) the way Fusion's "display
 * through" canvas option does.
 *
 * The texture is loaded async from a data-URL; the mesh is returned
 * immediately and its map populates on load. Caller owns disposal
 * (geometry + material + map).
 *
 * @param {object} opts
 * @param {string} opts.dataUrl
 * @param {number} [opts.width_mm]
 * @param {number} [opts.height_mm]
 * @param {number} [opts.opacity]
 * @param {boolean}[opts.displayThrough]
 * @returns {THREE.Mesh}
 */
export function createReferenceImagePlane({
    dataUrl,
    width_mm = 100,
    height_mm = 100,
    opacity = 0.65,
    displayThrough = false,
} = {}) {
    const geometry = new THREE.PlaneGeometry(width_mm, height_mm);
    const material = new THREE.MeshBasicMaterial({
        transparent: true,
        opacity,
        depthWrite: false,
        depthTest: !displayThrough,
        side: THREE.DoubleSide,
        toneMapped: false,
        color: 0xffffff,
    });
    const mesh = new THREE.Mesh(geometry, material);
    // Underlays render before geometry (or on top when displayThrough).
    mesh.renderOrder = displayThrough ? 999 : -1;
    mesh.userData.__pf4_reference_image__ = true;
    if (dataUrl) {
        new THREE.TextureLoader().load(dataUrl, (tex) => {
            tex.colorSpace = THREE.SRGBColorSpace;
            material.map = tex;
            material.needsUpdate = true;
        });
    }
    return mesh;
}

// ── Lighting ─────────────────────────────────────────────────────────────────
/**
 * Standard CAD 3-point lighting: sky hemisphere overhead, key rim light
 * from upper-front-right, cool fill from lower-back-left. All positions
 * have their "up" component in +Z because the world is Z-up.
 *
 * Returns the lights so callers can re-tune intensities, attach helpers,
 * or dispose. The scene takes ownership of the actual `Light` objects.
 */
export function addStandardLighting(scene, {
    hemiSky       = 0xe8edf2,
    hemiGround    = 0x10131a,
    hemiIntensity = 0.4,
    keyColor      = 0xffffff,
    keyIntensity  = 1.2,
    fillColor     = 0x90b4d0,
    fillIntensity = 0.5,
} = {}) {
    const hemi = new THREE.HemisphereLight(hemiSky, hemiGround, hemiIntensity);
    hemi.position.set(0, 0, 200);
    scene.add(hemi);

    const key = new THREE.DirectionalLight(keyColor, keyIntensity);
    key.position.set(100, 80, 200);
    scene.add(key);

    const fill = new THREE.DirectionalLight(fillColor, fillIntensity);
    fill.position.set(-80, -100, 40);
    scene.add(fill);

    return { hemi, key, fill };
}

// ── Origin triad ─────────────────────────────────────────────────────────────
/**
 * Origin axes. `THREE.AxesHelper` draws X=red, Y=green, Z=blue and is
 * orientation-agnostic — no flip needed. Included here so callers reach
 * for this module instead of `THREE` directly.
 */
export function createOriginAxes(size = 20, opacity = 0.5) {
    const axes = new THREE.AxesHelper(size);
    axes.material.transparent = true;
    axes.material.opacity = opacity;
    return axes;
}

// ── Re-exports ───────────────────────────────────────────────────────────────
/** Re-exported from `./env.js` so the contact shadow lives behind the
 *  same import as the rest of the Z-up scene primitives. */
export { addContactShadow };
