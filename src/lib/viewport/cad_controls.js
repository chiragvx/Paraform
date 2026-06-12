import * as THREE from 'three';
import { CADCameraControls, makeScenePickProvider } from '../../../lib/viewport/camera_controls.js';
import { loadAllSettings } from '../settings/schema.js';

/**
 * Push a partial camera-settings object onto a live CADCameraControls.
 *
 * Settings shape: `{ orbitSpeed, zoomSpeed, panSpeed, damping, invertY, autoFit }`
 * — matches the `camera` panel in `lib/settings/schema.js`. Missing keys are
 * ignored, so this is safe to call with either the full panel snapshot or a
 * single-field patch.
 *
 * Notes:
 *  - `orbitSpeed`, `zoomSpeed`, `panSpeed` go through `setSpeeds`; orbit is
 *    rescaled internally to multiply the rad/px constant, the others are
 *    used as direct multipliers.
 *  - `damping` flips `enableDamping` on/off based on whether the user picked
 *    a non-zero value and stores `dampingFactor`. `dampingFactor` scales the
 *    orbit inertial-coast duration (schema default 0.08 ≈ the stock feel;
 *    higher coasts longer). See CADCameraControls `_startCoast`.
 *  - `invertY` calls the `setInvertY(bool)` method on the controls (added
 *    alongside this wiring).
 *  - `autoFit` is NOT applied here — it gates first-render framing in
 *    Viewport.svelte, which we don't own. The value is still persisted by
 *    the settings store; live application is a downstream task.
 */
export function applyCameraSettings(controls, settings) {
  if (!controls || !settings) return;
  const speeds = {};
  if (Number.isFinite(settings.orbitSpeed)) speeds.orbit = settings.orbitSpeed;
  if (Number.isFinite(settings.zoomSpeed))  speeds.zoom  = settings.zoomSpeed;
  if (Number.isFinite(settings.panSpeed))   speeds.pan   = settings.panSpeed;
  if (Object.keys(speeds).length && typeof controls.setSpeeds === 'function') {
    controls.setSpeeds(speeds);
  }
  if (Number.isFinite(settings.damping)) {
    controls.dampingFactor = settings.damping;
    controls.enableDamping = settings.damping > 0;
  }
  if (typeof settings.invertY === 'boolean') {
    if (typeof controls.setInvertY === 'function') {
      controls.setInvertY(settings.invertY);
    } else {
      console.warn('[cad_controls] invertY requested but controls.setInvertY is missing');
    }
  }
  // autoFit: intentionally not applied here — see jsdoc above.
}

/**
 * Swaps the viewport's OrbitControls for CADCameraControls — the project's
 * SolidWorks-style ray-pivot orbit, cursor-glued pan, horizon-locked rotate.
 *
 * Requires a bridge so the controls' pick-provider can ray-cast against the
 * live body group; the AABB provider gives a fallback pivot when the
 * raycast misses geometry.
 *
 * Returns a `dispose()` that restores OrbitControls would be excessive — on
 * unmount the viewport's own dispose tears the controls down. Caller can
 * still call this dispose to release event listeners independently.
 */
export function attachCadControls(viewport, { bridge, preset = 'solidworks' } = {}) {
  if (!viewport) throw new Error('attachCadControls: viewport required');
  if (!bridge) throw new Error('attachCadControls: bridge required');

  const { camera, renderer } = viewport;

  const pickProvider = makeScenePickProvider(camera, () =>
    bridge.bodyTransform ? [bridge.bodyTransform] : []
  );

  const aabb = new THREE.Box3();
  const bodyAabbProvider = () => {
    if (!bridge.bodyTransform) return null;
    aabb.setFromObject(bridge.bodyTransform);
    return aabb.isEmpty() ? null : aabb;
  };

  const controls = new CADCameraControls(camera, renderer.domElement, {
    preset,
    pickProvider,
    bodyAabbProvider,
    worldUp: [0, 0, 1],
    horizonLock: true,
  });

  viewport.setControls(controls);

  // Pick up persisted camera-panel values so a fresh page-load matches
  // what the user last chose in Settings. Safe to call even if nothing
  // is persisted (defaults flow through `loadAllSettings`).
  try {
    const cameraSettings = loadAllSettings()?.camera;
    if (cameraSettings) applyCameraSettings(controls, cameraSettings);
  } catch (err) {
    console.warn('[attachCadControls] failed to apply persisted camera settings', err);
  }

  // Re-anchor "home" / save state after the first real body lands so reset
  // returns to a useful framing, mirroring the legacy main.js behaviour.
  const offRender = bridge.onRender(() => {
    try { controls.saveState?.(); } catch {}
  });

  return {
    controls,
    dispose() {
      offRender?.();
      // viewport.setControls(null) would leave the loop without a controls.
      // Leave the controls in place — viewport.dispose() will release it.
    },
  };
}
