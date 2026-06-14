import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
import {
  createCadCamera,
  createGroundGrid,
  createInfiniteGroundGrid,
  createOriginAxes,
  addStandardLighting,
  addContactShadow,
} from '../../../lib/viewport/conventions.js';
import {
  createGradientBackgroundTexture,
  createRoomEnvironmentTexture,
} from '../../../lib/viewport/env.js';
import { loadAllSettings } from '../settings/schema.js';
import {
  BG_COLORS,
  TESSELLATION_DEFLECTION_MM,
} from '../../../app/settings/index.js';
import { getDocumentExecutor } from '../../../lib/document/index.js';
import { NAMED_VIEWS } from '../../../lib/viewport/view_animator.js';
import { setSnapshotProvider, clearSnapshotProvider } from '../../../lib/viewport/snapshot.js';

/**
 * Resolve a `background` schema value to a scene.background payload —
 * either a CanvasTexture (gradient) or a flat THREE.Color (named palette).
 * Unknown values fall back to the gradient.
 */
function resolveBackground(name) {
  if (!name || name === 'gradient') {
    return createGradientBackgroundTexture('#1a1d22', '#2a2f36');
  }
  const hex = BG_COLORS[name];
  if (typeof hex === 'number') return new THREE.Color(hex);
  return createGradientBackgroundTexture('#1a1d22', '#2a2f36');
}

/** Parse a devicePixelRatio schema value ('auto' | '1' | '2' | '3'). */
function resolvePixelRatio(value) {
  if (value === undefined || value === null || value === 'auto') {
    return Math.min(window.devicePixelRatio || 1, 2);
  }
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : Math.min(window.devicePixelRatio || 1, 2);
}

/**
 * Boots a Z-up CAD viewport into `container`. Returns the scene handles plus
 * a `dispose()` to tear down the canvas + RAF + observers cleanly.
 *
 * The controls slot is mutable — call `setControls(newControls)` to swap in
 * `CADCameraControls` (or anything else) after construction. The render loop
 * reads the current controls each frame through the holder.
 *
 * Persisted Viewport + Graphics settings are read at boot and applied to the
 * fresh scene/camera/renderer. The returned object exposes
 * `applyViewportSettings` and `applyGraphicsSettings` so the SettingsDialog
 * panels can push live changes back without a reload.
 */
export function bootViewport(container) {
  const w = Math.max(container.clientWidth, 1);
  const h = Math.max(container.clientHeight, 1);

  // Read persisted settings up front so renderer construction (which can't be
  // mutated post-creation for AA) and grid/axes/background defaults reflect
  // the user's saved preferences.
  const all = loadAllSettings();
  const vp = all.viewport || {};
  const gfx = all.graphics || {};

  const scene = new THREE.Scene();
  const camera = createCadCamera({ aspect: w / h, fov: vp.fov ?? 50 });

  const renderer = new THREE.WebGLRenderer({
    antialias: gfx.antiAliasing !== false,
    alpha: true,
    preserveDrawingBuffer: true,
  });
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.setPixelRatio(resolvePixelRatio(gfx.devicePixelRatio));
  renderer.setSize(w, h);
  container.appendChild(renderer.domElement);

  scene.background = resolveBackground(vp.background);
  scene.environment = createRoomEnvironmentTexture(renderer);
  addStandardLighting(scene);
  // Keep the handle so dispose() can free the shadow map / plane / material —
  // env.js documents that the caller owns disposal of these GPU resources.
  const contactShadow = addContactShadow(scene, { size: 600, opacity: 0.28, lightHeight: 300 });

  // Grid & axes live in mutable holders so the setters can swap them when
  // gridSize changes or toggle their .visible without re-walking the scene.
  // Infinite shader-based grid (Fusion-style): adaptive LOD, AA lines,
  // radial horizon fade. The legacy `gridSize` setting no longer has an
  // effect — the grid auto-scales by zoom — but we keep it accepted so
  // settings panels don't 500.
  let grid = createInfiniteGroundGrid();
  grid.visible = vp.showGrid !== false;
  scene.add(grid);

  let axes = createOriginAxes();
  axes.visible = vp.showAxes !== false;
  scene.add(axes);

  // Push tessellation to the executor on boot in case loadAndApplySettings
  // hasn't run yet (or the executor was recreated after it ran).
  try {
    const mm = TESSELLATION_DEFLECTION_MM[gfx.tessellationQuality];
    if (typeof mm === 'number') getDocumentExecutor().setTessellationDeflection(mm);
  } catch {}

  // Start with OrbitControls. Callers can swap to CADCameraControls (or
  // anything else) via `setControls()` once they have a bridge / pick
  // provider to feed it.
  const holder = { controls: new OrbitControls(camera, renderer.domElement) };
  holder.controls.enableDamping = true;

  const material = new THREE.MeshStandardMaterial({
    color: 0x8c9aaa,
    metalness: 0.25,
    roughness: 0.45,
    side: THREE.DoubleSide,
  });

  const resizeObs = new ResizeObserver(() => {
    const cw = container.clientWidth;
    const ch = container.clientHeight;
    if (!cw || !ch) return;
    camera.aspect = cw / ch;
    camera.updateProjectionMatrix();
    renderer.setSize(cw, ch);
  });
  resizeObs.observe(container);

  let rafId = 0;
  let disposed = false;

  function animate() {
    if (disposed) return;
    rafId = requestAnimationFrame(animate);
    holder.controls?.update?.();
    // Push live camera position to the infinite grid shader so LOD &
    // horizon-fade follow the viewer. Cheap (one vec3 copy).
    grid?.updateForCamera?.(camera);
    renderer.render(scene, camera);
  }
  animate();

  function setControls(next) {
    if (next === holder.controls) return;
    const prev = holder.controls;
    holder.controls = next;
    prev?.dispose?.();
  }

  // Track the AA value the renderer was created with so we can detect a
  // mismatch on later applyGraphicsSettings calls.
  let bootAntiAliasing = gfx.antiAliasing !== false;
  let bootEdgeThickness = gfx.edgeThickness ?? 1;

  /**
   * Live-apply Viewport panel values. Pass the full panel object; any
   * undefined keys are skipped.
   */
  function applyViewportSettings(values = {}) {
    if (!values || typeof values !== 'object') return;

    if (typeof values.fov === 'number' && Number.isFinite(values.fov)) {
      camera.fov = values.fov;
      camera.updateProjectionMatrix();
    }

    if (typeof values.showGrid === 'boolean') {
      grid.visible = values.showGrid;
    }

    if (typeof values.gridSize === 'number' && Number.isFinite(values.gridSize) && values.gridSize > 0) {
      // The infinite shader grid auto-LODs by camera distance — no
      // re-creation needed on gridSize changes. Accept the value silently
      // for back-compat with persisted settings.
    }

    if (typeof values.showAxes === 'boolean') {
      axes.visible = values.showAxes;
    }

    if (typeof values.background === 'string') {
      const next = resolveBackground(values.background);
      // Dispose the prior texture if it was one (Color has no dispose).
      const prev = scene.background;
      scene.background = next;
      if (prev && typeof prev.dispose === 'function') prev.dispose();
    }
  }

  /**
   * Live-apply Graphics panel values. AA and edgeThickness are stored only
   * (with a console warning) — they can't be mutated on an existing
   * WebGLRenderer / EdgesGeometry overlay.
   */
  function applyGraphicsSettings(values = {}) {
    if (!values || typeof values !== 'object') return;

    if (values.devicePixelRatio !== undefined) {
      renderer.setPixelRatio(resolvePixelRatio(values.devicePixelRatio));
    }

    if (typeof values.antiAliasing === 'boolean' && values.antiAliasing !== bootAntiAliasing) {
      console.warn(
        '[viewport] Anti-aliasing change requires a reload to apply — WebGLRenderer AA is fixed at construction.',
      );
      bootAntiAliasing = values.antiAliasing;
    }

    if (typeof values.edgeThickness === 'number' && values.edgeThickness !== bootEdgeThickness) {
      console.warn(
        '[viewport] Edge thickness is informational for now — the EdgesGeometry overlay does not honor a line width.',
      );
      bootEdgeThickness = values.edgeThickness;
    }

    if (typeof values.tessellationQuality === 'string') {
      const mm = TESSELLATION_DEFLECTION_MM[values.tessellationQuality];
      if (typeof mm === 'number') {
        try {
          getDocumentExecutor().setTessellationDeflection(mm);
        } catch {
          console.warn('[viewport] tessellation quality applies on next compile.');
        }
      }
    }
  }

  // ── AI vision: multi-axis snapshots of the current model ───────────────────
  // The AI "cannot see" — capture_views renders the model from named angles and
  // feeds the images to the vision model so it can verify what it built. We
  // reuse the live renderer (preserveDrawingBuffer is on) with a throwaway
  // camera, frame the model's bounds, render each view, and read a downscaled
  // JPEG. Helpers (grid/axes/contact shadow) are excluded from the framing.
  const _snapCam = new THREE.PerspectiveCamera(50, 1, 0.1, 10000);

  function _modelBounds() {
    const box = new THREE.Box3();
    const tmp = new THREE.Box3();
    const size = new THREE.Vector3();
    let has = false;
    scene.traverse((o) => {
      if (!o || !o.isMesh || !o.geometry) return;
      if (o === grid || o === axes) return;
      if (contactShadow && o === contactShadow.plane) return;
      if (o.userData && o.userData.snapshotIgnore) return;
      try { tmp.setFromObject(o); } catch { return; }
      if (tmp.isEmpty()) return;
      tmp.getSize(size);
      const span = size.length();
      if (!Number.isFinite(span) || span > 5e5) return; // skip infinite grid / strays
      box.union(tmp);
      has = true;
    });
    return has ? box : null;
  }

  function _downscaleJpeg() {
    const src = renderer.domElement;
    const sw = src.width, sh = src.height;
    if (!sw || !sh) return null;
    const maxSide = 768;
    const scale = Math.min(1, maxSide / Math.max(sw, sh));
    const ow = Math.max(1, Math.round(sw * scale));
    const oh = Math.max(1, Math.round(sh * scale));
    try {
      const off = document.createElement('canvas');
      off.width = ow; off.height = oh;
      const ctx = off.getContext('2d');
      if (!ctx) return src.toDataURL('image/jpeg', 0.85);
      ctx.drawImage(src, 0, 0, ow, oh);
      return off.toDataURL('image/jpeg', 0.85);
    } catch {
      try { return src.toDataURL('image/jpeg', 0.85); } catch { return null; }
    }
  }

  async function captureViews(requested) {
    const box = _modelBounds();
    if (!box) return [];
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(box.getBoundingSphere(new THREE.Sphere()).radius, 1);
    const names = (Array.isArray(requested) && requested.length ? requested : ['front', 'right', 'top', 'iso'])
      .filter((n) => NAMED_VIEWS[n]);
    if (!names.length) return [];
    const src = renderer.domElement;
    const aspect = (src.width && src.height) ? src.width / src.height : 1;
    const fov = ((camera.fov || 50) * Math.PI) / 180;
    const dist = (radius / Math.sin(Math.min(fov, Math.PI / 2.2) / 2)) * 1.25;
    _snapCam.fov = camera.fov || 50;
    _snapCam.aspect = aspect;
    _snapCam.near = Math.max(0.01, dist - radius * 3);
    _snapCam.far = dist + radius * 4;
    const shots = [];
    const d = new THREE.Vector3();
    for (const name of names) {
      const v = NAMED_VIEWS[name];
      d.set(v.dir[0], v.dir[1], v.dir[2]).normalize();
      _snapCam.position.copy(center).addScaledVector(d, dist);
      _snapCam.up.set(v.up[0], v.up[1], v.up[2]);
      _snapCam.lookAt(center);
      _snapCam.updateProjectionMatrix();
      try {
        renderer.render(scene, _snapCam);
        const dataUrl = _downscaleJpeg();
        if (dataUrl) shots.push({ view: name, dataUrl });
      } catch { /* skip this view */ }
    }
    // Restore the live frame so the user never sees the last snapshot pose.
    try { renderer.render(scene, camera); } catch { /* next RAF restores it */ }
    return shots;
  }
  setSnapshotProvider(captureViews);

  function dispose() {
    if (disposed) return;
    disposed = true;
    clearSnapshotProvider(captureViews);
    cancelAnimationFrame(rafId);
    resizeObs.disconnect();
    holder.controls?.dispose?.();

    // Free the GPU resources this boot allocated. renderer.dispose() does NOT
    // walk the scene graph, so the PMREM environment target, the gradient
    // background texture, the grid/axes geometry+material, and the contact
    // shadow's 2048² shadow map all leak across remounts (route changes, HMR)
    // unless released explicitly here.
    const disposeTexture = (t) => { if (t && typeof t.dispose === 'function') t.dispose(); };
    disposeTexture(scene.environment);
    disposeTexture(scene.background);
    scene.environment = null;
    scene.background = null;
    try { grid?.geometry?.dispose?.(); grid?.material?.dispose?.(); } catch {}
    try { axes?.geometry?.dispose?.(); axes?.material?.dispose?.(); } catch {}
    try {
      contactShadow?.plane?.geometry?.dispose?.();
      contactShadow?.plane?.material?.dispose?.();
      contactShadow?.light?.shadow?.map?.dispose?.();
    } catch {}

    renderer.dispose();
    material.dispose();
    if (renderer.domElement.parentNode === container) {
      container.removeChild(renderer.domElement);
    }
  }

  const out = {
    scene,
    camera,
    renderer,
    get controls() { return holder.controls; },
    setControls,
    material,
    get grid() { return grid; },
    get axes() { return axes; },
    applyViewportSettings,
    applyGraphicsSettings,
    dispose,
  };
  return out;
}
