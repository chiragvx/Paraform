/**
 * Studio runtime singleton. Viewport.svelte populates it during its boot;
 * everything else (keymap, palette commands, toolbar) reads from it.
 *
 * Using a Svelte 5 class with $state so reads inside effects/$derived stay
 * reactive — e.g. a command can be enabled only when `runtime.bridge` is set.
 */

import { setActiveComponentProvider, getDocumentStore } from '../../../lib/document/index.js';
import { componentPathFor as _componentPathFor } from '../../../lib/document/types.js';
import { measure as measureClient } from '../measure/api.js';

const SURFACE_FINISH_PRESETS = {
  'semi-gloss':   { roughness: 0.45, metalness: 0.25, opaque: true },
  'matte':        { roughness: 0.85, metalness: 0.05, opaque: true },
  'silk':         { roughness: 0.3,  metalness: 0.4,  opaque: true },
  'translucent':  { roughness: 0.2,  metalness: 0.0,  opaque: false, opacity: 0.7 },
};

// Material defaults — match boot.js's MeshStandardMaterial construction so we
// can revert opacity/transparent cleanly when leaving the translucent finish.
const MATERIAL_DEFAULT_OPACITY = 1.0;
const MATERIAL_DEFAULT_TRANSPARENT = false;

class StudioRuntime {
  viewport = $state(null);   // { scene, camera, renderer, controls, ... } from bootViewport
  bridge = $state(null);     // DocumentViewportBridge from bootDocument
  views = $state(null);      // makeViewController(...)
  displayMode = $state('shaded');  // 'shaded' | 'shaded-edges' | 'wireframe' | 'wireframe-edges'
  // E6.1 — overlay toggles on top of displayMode.
  hiddenEdges = $state(false);
  xray = $state(false);
  // E6.5 — rollback head for non-destructive timeline scrub. featureId | null.
  rollbackHead = $state(null);

  // ── Body isolation (visual only — non-destructive) ─────────────────────
  // Set of featureIds to keep at full opacity; everything else under
  // bridge.bodyTransform fades to ~0.08 + depthWrite=false. Empty Set or
  // null means "no isolation; all bodies fully visible." Toggle via
  // `studio.isolate(ids)` / `studio.clearIsolation()` or the palette
  // commands. Cmd/Ctrl+I cycles isolation on the current picked bodies.
  isolatedFeatureIds = $state(null);

  isolate(ids) {
    if (!ids || (Array.isArray(ids) && ids.length === 0)) {
      this.isolatedFeatureIds = null;
      return;
    }
    this.isolatedFeatureIds = new Set(ids);
  }
  clearIsolation() { this.isolatedFeatureIds = null; }

  // Scene / material / lighting controls (driven by ScenePanel)
  materialColor = $state('#8c9aaa');
  surfaceFinish = $state('semi-gloss');
  buildPlate = $state('bambu');
  lightingPreset = $state('default');
  lightingIntensity = $state(1.0);

  // Captured the first time we scale legacy lights so we don't compound the
  // multiplier on every slider tick. Keyed by light.uuid → original intensity.
  _lightBaseline = null;

  // ── Face-pick mode (E2 — Editor Readiness §E2.1 / §E2.4) ─────────────────
  // When non-null, Viewport.svelte switches into a single-shot pick gesture:
  // crosshair cursor + top-of-viewport banner, hover overlay stays live, the
  // next valid face/edge click resolves through onPick. Esc cancels.
  //   facePickMode = {
  //     purpose: 'sketch' | 'project' | 'intersect',
  //     accept:  Set<'face'|'edge'>,   // kinds the picker should accept
  //     onPick:  (descriptor, payload) => void,
  //     onCancel: () => void,
  //   }
  facePickMode = $state(null);

  // E3 v2 — active press-pull / move-face gizmo for the selected face.
  // Shape: { kind: 'pressPull'|'moveFace', faceDescriptor, controller, frame }
  // Viewport.svelte reads this to render the arrow(s) and route drag events.
  // Null when no face-edit tool is armed.
  faceEditGizmo = $state(null);

  /**
   * Begin a single-shot face/edge pick. Callers pass a purpose label (drives
   * the banner copy), an optional `accept` set (defaults to face-only), and
   * the two callbacks. Returns true if the gesture was armed, false if the
   * viewport isn't ready yet.
   */
  startFacePick({ purpose = 'sketch', accept = ['face'], onPick = () => {}, onCancel = () => {} } = {}) {
    if (!this.viewport) {
      console.warn('[face-pick] viewport not ready');
      return false;
    }
    // If an existing gesture is in flight, cancel it cleanly before swapping.
    if (this.facePickMode) {
      try { this.facePickMode.onCancel?.(); } catch {}
    }
    this.facePickMode = {
      purpose,
      accept: new Set(accept),
      onPick,
      onCancel,
    };
    return true;
  }

  /** Cancel any in-flight face pick (Esc / programmatic). Safe to call when idle. */
  cancelFacePick() {
    const mode = this.facePickMode;
    this.facePickMode = null;
    if (mode) {
      try { mode.onCancel?.(); } catch {}
    }
  }

  // ── E4 — Viewport-owned action hooks. Viewport.svelte registers these
  // when it mounts; palette commands fire them via studio.startMeasure?.(),
  // studio.startSection?.(), studio.runInterference?.(ids). Each hook is a
  // plain function reference so the viewport's `onMount` cleanup nulls it
  // and palette commands silently no-op when the viewport is unmounted.
  startMeasure = $state(null);     // () => void
  startSection = $state(null);     // () => void
  runInterference = $state(null);  // (bodyIds: string[]) => void
  applyRollback = $state(null);    // () => void — E6.5 timeline scrub
  // Spec-17/18 v3 — Fusion-style section-plane manipulator. SectionPlaneMount
  // installs `toggleSection` (flip on/off) and `sectionPlane` (the
  // SectionPlane instance) so palette commands and external tooling can
  // drive the new gizmo without poking at the renderer directly.
  toggleSection = $state(null);    // () => void
  sectionPlane  = $state(null);    // SectionPlane | null
  sectionFlip   = $state(null);    // () => void
  sectionReset  = $state(null);    // () => void
  sectionAlignToSelectedFace = $state(null); // () => void

  // ── Active component (Foundation 6 / commit 2) ───────────────────────────
  // Every feature created via operations.js while this is set picks it up as
  // its `componentId`. v0 always 'root'; commit 3 wires the browser UI.
  activeComponentId = $state('root');

  // ── Active sketch (Fusion-style persistent sketch overlay) ───────────────
  // featureId of the sketch the user is currently editing in-viewport.
  // SketchOverlay reads this and skips that feature on its rebuilds so the
  // live `Sketch3DRenderer` (which draws the same sketch with grid + selection
  // + halos) isn't doubled-up by the overlay's line geometry. Set from
  // src/lib/sketch/boot.js on enter; cleared by Viewport.svelte's rAF poll
  // when `isSketchActive()` flips false (covers Finish + Cancel + Esc-Esc).
  activeSketchFeatureId = $state(null);

  // ── Scene helpers visibility (XY/XZ/YZ planes + persistent sketch overlay) ─
  // True by default. Palette commands view.referencePlanes.toggle and
  // view.sketches.toggle flip these; Viewport.svelte effects push the
  // changes into the imperative classes.
  referencePlanesVisible = $state(true);
  // Per-plane visibility (independent toggles). Master `referencePlanesVisible`
  // still wins — when off, none render regardless of these.
  referencePlaneIndividual = $state({ XY: true, XZ: true, YZ: true });
  sketchOverlayVisible   = $state(true);

  // Refs to the imperative classes — assigned by Viewport.svelte after boot.
  referencePlanes = $state(null);
  sketchOverlay   = $state(null);

  setBoot({ viewport, bridge, views }) {
    this.viewport = viewport;
    this.bridge = bridge;
    this.views = views;
    // Wire the active-component provider into operations.js so addBox /
    // addCylinder / … stamp the right componentId. We can't import the
    // runtime from operations.js (circular dep), so the runtime pushes
    // a getter in at boot.
    setActiveComponentProvider(() => this.activeComponentId);
  }
  clearBoot() {
    this.viewport = null;
    this.bridge = null;
    this.views = null;
    this._lightBaseline = null;
    setActiveComponentProvider(null);
  }

  /** No-validation setter; commit 3 (browser UI) will gate this on existence. */
  setActiveComponent(id) {
    this.activeComponentId = id || 'root';
  }

  /**
   * Phase 2.1 — typed kernel measurement shorthand. Components write
   *   studio.measure({type: 'bbox', featureId: 'box_x'})
   * or pass an array of queries to batch them in a single round-trip.
   * Pass-through to src/lib/measure/api.js; cache + error semantics live
   * there.
   */
  async measure(queryOrList) {
    return measureClient(queryOrList);
  }

  /**
   * @returns {string[]}  Component-id path from 'root' down to the active
   *                      component. Always at least `['root']`.
   */
  getActiveComponentPath() {
    const doc = getDocumentStore().doc;
    return _componentPathFor(doc, this.activeComponentId);
  }

  applyMaterialToViewport() {
    const mat = this.viewport?.material;
    if (!mat) return;
    mat.color.set(this.materialColor);
    const preset = SURFACE_FINISH_PRESETS[this.surfaceFinish] ?? SURFACE_FINISH_PRESETS['semi-gloss'];
    mat.roughness = preset.roughness;
    mat.metalness = preset.metalness;
    if (preset.opaque) {
      mat.opacity = MATERIAL_DEFAULT_OPACITY;
      mat.transparent = MATERIAL_DEFAULT_TRANSPARENT;
    } else {
      mat.opacity = preset.opacity ?? 0.7;
      mat.transparent = true;
    }
    mat.needsUpdate = true;
  }

  applyLightingToViewport() {
    const scene = this.viewport?.scene;
    if (!scene) return;
    const intensity = this.lightingIntensity;

    // THREE r163+ exposes scene.environmentIntensity directly. Preferred path.
    if ('environmentIntensity' in scene) {
      scene.environmentIntensity = intensity;
    }

    // Also scale ambient/directional lights so the slider has a visible effect
    // when the IBL isn't doing all the work. Capture baseline once.
    if (!this._lightBaseline) {
      this._lightBaseline = new Map();
      scene.traverse((obj) => {
        if (obj.isLight && typeof obj.intensity === 'number') {
          this._lightBaseline.set(obj.uuid, obj.intensity);
        }
      });
    }
    for (const [uuid, base] of this._lightBaseline) {
      const light = scene.getObjectByProperty('uuid', uuid);
      if (light) light.intensity = base * intensity;
    }
  }
}

export const studio = new StudioRuntime();
