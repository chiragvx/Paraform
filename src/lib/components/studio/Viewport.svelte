<script>
  /*
   * Viewport HUD z-index scale (keep this in sync with the markup below):
   *   z-10  — persistent HUD cards: ViewCube + Save/Bookmarks, quick-tools
   *           row (Section + Measure), display-mode column, zoom cluster,
   *           selection-filter toolbar (when nested in the banner stack
   *           it inherits the stack's z-30).
   *   z-30  — transient banners + modal overlays: banner stack (kernel
   *           error, face-pick cue, isolation, interference) and any
   *           face-pick / modal layer that must sit over everything.
   * No z-20 random values. Anything new should reach for z-10 or z-30.
   */
  import { onMount } from 'svelte';
  import * as THREE from 'three';
  import { bootViewport } from '$lib/viewport/boot.js';
  import { attachCadControls } from '$lib/viewport/cad_controls.js';
  import { bootDocument } from '$lib/document/boot.js';
  import { bootPicking } from '$lib/picking/boot.js';
  import { bootBodyHighlight } from '$lib/picking/body_highlight.js';
  import { isSketchActive, cancelSketch } from '$lib/sketch/boot.js';
  import { makeViewController } from '$lib/viewport/views.js';
  import { applyDisplayMode, isTechnicalMode } from '$lib/viewport/display_mode.js';
  import { createGradientBackgroundTexture } from '../../../../lib/viewport/env.js';
  import { theme } from '$lib/theme/theme.svelte.js';
  import { featuresSuppressedByRollback } from '$lib/document/rollback.js';
  import { studio } from '$lib/studio/runtime.svelte.js';
  import { persistence } from '$lib/document/persistence.svelte.js';
  import { mountAxisTriad } from '../../../../app/viewport/axis_triad.js';
  import { RubberBand } from '../../../../app/viewport/rubber_band.js';
  import { LassoPaintSelect } from '../../../../app/viewport/lasso_paint_select.js';
  import { MarkingMenu } from '../../../../app/viewport/marking_menu.js';
  import { mountSnapIndicators, buildSnapCandidates } from '../../../../app/viewport/snap_indicators.js';
  import { getDocumentStore } from '../../../../lib/document/index.js';
  import { getPickingSelection } from '../../../../lib/picking/selection.js';
  import { COMMANDS, MARKING_MENU_ACTIONS } from '$lib/commands/registry.js';
  import { loadMarkingMenuBindings, MARKING_MENU_SECTORS } from '$lib/viewport/shortcuts.js';
  import { dialogs } from '$lib/dialogs/dialogs.svelte.js';
  // E3 v2 — Press-Pull drag-handle gizmo. The math is in this module;
  // the Viewport wires it to pointermove/up when a face is selected and
  // the press-pull tool is active. See press_pull_gizmo.js for the
  // detailed lifecycle (beginDrag / updateDrag / endDrag).
  import { PressPullGizmo, buildMoveFaceFrame, moveFaceParamsFromDrag } from '$lib/viewport/press_pull_gizmo.js';
  import ViewCubeMount from './ViewCubeMount.svelte';
  import SectionPlaneMount from './SectionPlaneMount.svelte';
  import ViewportHudMount from './ViewportHudMount.svelte';
  import MeasureToolMount from './MeasureToolMount.svelte';
  import { libraryDrag } from './LibraryPalette.svelte';
  import { placeLibraryPart } from '$lib/library/place.js';
  import { computeRolledOrigin, computeSlidPlacement, findSlidableComponent } from '$lib/library/orient.js';
  import { insertEntry as insertStandardEntry } from '$lib/library/standard.js';
  import * as v4 from '../../../../lib/document/index.js';
  import { ConnectorOverlay } from '../../../../app/viewport/connector_overlay.js';
  import { TransformGizmo } from '../../../../app/viewport/transform_gizmo.js';
  import { SnapDragController } from '../../../../app/viewport/snap_drag.js';
  import { composeMatrix, localForWorldPose } from '../../../../app/viewport/snap_frames.js';
  import { DragGhost, cursorOnGroundPlane } from '../../../../app/viewport/drag_ghost.js';
  import { snapGroundPosition, closestParamOnLine, clamp, normalize3 } from '../../../../app/viewport/snap_math.js';
  import { solveMateTransform, connectorsCompatible } from '$lib/library/mate_solver.js';
  import { ReferencePlanes } from '../../../../app/viewport/reference_planes.js';
  import { SketchOverlay } from '../../../../app/viewport/sketch_overlay.js';
  import { syncReferenceImages } from '$lib/reference/image_canvas.js';
  import { enterSketch } from '$lib/sketch/boot.js';
  import SelectionFilterToolbarMount from './SelectionFilterToolbarMount.svelte';
  import Maximize2 from '@lucide/svelte/icons/maximize-2';

  let root;
  let kernelError = $state(null);
  // True when the current kernelError is a "kernel server unreachable" network
  // failure rather than a CAD compile error — drives friendlier banner copy.
  let kernelOffline = $state(false);
  let hasBodies = $state(false);
  // Platform-aware modifier glyph for keyboard hints. ⌘ on macOS, "Ctrl+"
  // everywhere else (Windows/Linux). Detected from the UA/platform string.
  const _isMac = typeof navigator !== 'undefined'
    && /mac/i.test(navigator.platform || navigator.userAgent || '');
  const modKeyLabel = _isMac ? '⌘' : 'Ctrl+';
  // Transient hint surfaced from the marking menu (e.g. a disabled wedge's
  // reason). Auto-clears after a few seconds; also dismissible.
  let markingToast = $state(null);
  let _markingToastTimer = 0;
  function showMarkingToast(msg) {
    if (!msg) return;
    markingToast = String(msg);
    if (_markingToastTimer) clearTimeout(_markingToastTimer);
    _markingToastTimer = setTimeout(() => { markingToast = null; }, 3200);
  }

  // ── E4 — Viewport-owned state machines ──────────────────────────────────
  // Measure tool + section plane state are now owned by MeasureToolMount /
  // SectionPlaneMount respectively; they expose studio.measureTool /
  // studio.toggleSection / studio.sectionPlane hooks for palette dispatch.
  // interferenceResults: { pairs:number, totalVolume:number }
  let interferenceResults = $state(null);

  // Spec 18 v1 — drag-drop snap state.
  let ghostHover = $state(null); // { connectorId, partId } | null

  // Rotate-to-fit — the component the keyboard rotate keys ([ / ]) will spin.
  // Drives the discoverability hint; resolved from the picking selection.
  let selectedComponentId = $state(null);

  /**
   * First non-root component owning a selected feature; falls back to the
   * sidebar tree's active component when the 3D picking selection is empty.
   *
   * Without the fallback, a placed part that's too small or occluded to click
   * reliably (e.g. an M5 t-nut inside a 2020 channel) is unreachable from the
   * keyboard shortcuts — `,` / `.` and `[` / `]` no-op because no body feature
   * was hit by a raycast. With the fallback, clicking the part's row in the
   * Sidebar tree (which sets `studio.activeComponentId`) is enough.
   */
  function resolveSelectedComponentId(sel, doc) {
    if (sel && typeof sel.toArray === 'function') {
      const features = (doc && doc.features) || {};
      for (const e of sel.toArray()) {
        const d = e && e.descriptor;
        const fid = d && (d.featureId || d.feature);
        if (!fid) continue;
        const f = features[fid];
        const cid = f && f.componentId;
        if (cid && cid !== 'root') return cid;
      }
    }
    const active = studio && studio.activeComponentId;
    if (active && active !== 'root' && doc && doc.components && doc.components[active]) {
      return active;
    }
    return null;
  }

  /** World pick ray for a pointer/drag event (Z-up world, mm). */
  function cursorRayFromEvent(ev, rect) {
    const camera = studio.viewport?.camera;
    if (!camera) return null;
    const ndc = new THREE.Vector2(
      ((ev.clientX - rect.left) / rect.width) * 2 - 1,
      -((ev.clientY - rect.top) / rect.height) * 2 + 1,
    );
    const rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, camera);
    return rc.ray;
  }

  /**
   * Resolve where a dragged library part would snap right now:
   *   - the compatible host connector under the cursor (magnet radius 48 px;
   *     channel hosts magnetize along their whole rendered segment),
   *   - the part-side connector chosen with the SAME rule placeLibraryPart
   *     uses (connectorsCompatible against the host's WORLD frame — the old
   *     ghost used `host.mates_with.includes(kind)` and could preview a
   *     different mate than the drop committed),
   *   - for channel hosts (t-slot rails): the slide along the run at the
   *     cursor's projection, clamped to the channel extent, so the part
   *     lands where you point — not teleported to the channel midpoint,
   *   - the solved world pose.
   * Shared by the drag ghost AND the drop commit: one code path, so the
   * preview is exactly what lands.
   */
  function resolveLibrarySnap(ev, part, rect) {
    const camera = studio.viewport?.camera;
    if (!camera || !connectorOverlay || !part) return null;
    const cursor = { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
    const hit = connectorOverlay.pickCompatibleAtCursor?.(
      cursor, camera, { width: rect.width, height: rect.height }, 48,
    );
    if (!hit?.connector) return null;
    const hostWorld = connectorOverlay.getWorldConnector?.(hit.connector.id);
    if (!hostWorld) return null;
    const partConnectors = Array.isArray(part.connectors) ? part.connectors : [];
    const partConnector = partConnectors.find((c) => connectorsCompatible(hostWorld, c));
    if (!partConnector) return null;
    let slide;
    if ((hostWorld.topology === 'line' || hostWorld.kind === 'slot') && Array.isArray(hostWorld.axis)) {
      const ray = cursorRayFromEvent(ev, rect);
      if (ray) {
        const s = closestParamOnLine(
          [ray.origin.x, ray.origin.y, ray.origin.z],
          [ray.direction.x, ray.direction.y, ray.direction.z],
          hostWorld.origin, normalize3(hostWorld.axis),
        );
        if (s !== null) {
          slide = hostWorld.extent ? clamp(s, hostWorld.extent.from, hostWorld.extent.to) : s;
        }
      }
    }
    const solved = solveMateTransform(hostWorld, partConnector, { slide });
    return {
      hostConnectorId: hit.connector.id,
      partConnectorId: partConnector.id,
      slide,
      solved,
    };
  }

  let _dragLoggedThisSession = false;
  function onLibraryDragOver(ev) {
    // Only react when a library drag is in flight (any kind).
    if (!libraryDrag.part && !libraryDrag.quickstartItem && !libraryDrag.standardEntry) return;
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy';
    if (!_dragLoggedThisSession) {
      _dragLoggedThisSession = true;
      console.log('[drag] first dragover in session', {
        partId: libraryDrag.part?.id || null,
        target: ev.target?.tagName,
        targetClass: ev.target?.className?.toString?.().slice?.(0, 80) || null,
      });
    }
    // Connector overlay + ghost preview only matter for PartRecord (Spec 18) drags.
    if (libraryDrag.part) {
      try {
        connectorOverlay && connectorOverlay.setVisible(true);
        // Show live compatibility: green rings = mateable with this part,
        // dim = no compatible connector. The probe is the part's connector
        // list (each is what placeLibraryPart would try as the part side).
        const partConnectors = Array.isArray(libraryDrag.part.connectors)
          ? libraryDrag.part.connectors
          : [];
        connectorOverlay && connectorOverlay.setCompatibilityProbe(partConnectors);
      } catch {}
      // ── Translucent placement ghost ──────────────────────────────────
      // The ghost lives at scene identity and previews where the part will
      // land. Two pose paths:
      //   (a) cursor is within magnet range of a compatible host connector
      //       → solve the mate transform and snap the ghost there. The
      //         user sees the exact final pose before letting go.
      //   (b) no snap target → drop the ghost onto the world XY ground
      //       plane under the cursor as a free-placement preview.
      try {
        if (dragGhost && studio.viewport?.camera && studio.viewport?.renderer) {
          dragGhost.setPart(libraryDrag.part);
          const rect = root?.getBoundingClientRect?.();
          if (rect) {
            const snap = resolveLibrarySnap(ev, libraryDrag.part, rect);
            if (snap) {
              // KSP lock-on: brighten the host node the part will mate.
              connectorOverlay?.setHighlighted?.(snap.hostConnectorId);
              dragGhost.setSnapping(true);
              dragGhost.setPose({ position: snap.solved.position, rotation: snap.solved.euler });
            } else {
              connectorOverlay?.setHighlighted?.(null);
              dragGhost.setSnapping(false);
              let pos = cursorOnGroundPlane(ev, {
                camera: studio.viewport.camera,
                renderer: studio.viewport.renderer,
              });
              // Origin lock (always) + grid lock (hold Ctrl). Ghost preview
              // shows exactly where the drop will land.
              if (pos) pos = snapGroundPosition(pos, { ctrl: ev.ctrlKey || ev.metaKey });
              if (pos) dragGhost.setPose({ position: pos, rotation: [0, 0, 0] });
            }
          }
        }
      } catch (err) { console.warn('[viewport] ghost preview failed:', err); }
    }
  }
  let connectorOverlay; // captured from onMount scope below
  let transformGizmo;   // spec 18 v2 — translate/rotate/scale handles
  let snapDrag;         // spec 18 v2 — snap-on-drag controller
  let dragGhost;        // spec 18 v2 — translucent placement preview during library drag

  function onLibraryDrop(ev) {
    console.log('[drag] onLibraryDrop fired', {
      hasPart: !!libraryDrag.part,
      partId: libraryDrag.part?.id || null,
      hasQuickstart: !!libraryDrag.quickstartItem,
      hasStandardEntry: !!libraryDrag.standardEntry,
      clientX: ev.clientX, clientY: ev.clientY,
      target: ev.target?.tagName,
    });
    // Quickstart (catalog.js) — synchronous v4 build call.
    if (libraryDrag.quickstartItem) {
      ev.preventDefault();
      const item = libraryDrag.quickstartItem;
      try {
        item.build(v4);
      } catch (err) {
        console.error('[viewport] quickstart drop failed:', err);
      }
      libraryDrag.quickstartItem = null;
      libraryDrag.startedAt = 0;
      return;
    }
    // Standard part (kernel /library) — async GLB fetch + insert.
    if (libraryDrag.standardEntry) {
      ev.preventDefault();
      const entry = libraryDrag.standardEntry;
      libraryDrag.standardEntry = null;
      libraryDrag.startedAt = 0;
      (async () => {
        try {
          const res = await insertStandardEntry(entry.id);
          if (!res?.ok) console.error('[viewport] standard drop failed:', res?.error);
        } catch (err) {
          console.error('[viewport] standard drop threw:', err);
        }
      })();
      return;
    }
    // Spec 18 PartRecord — connector-snap path.
    const part = libraryDrag.part;
    if (!part) return;
    ev.preventDefault();
    // Find the closest existing connector to the cursor for the snap.
    const rect = root?.getBoundingClientRect?.();
    // Only accept a compatible host connector (an incompatible mate solve
    // dumps the body somewhere weird). resolveLibrarySnap is the SAME
    // resolver the drag ghost used a frame ago — host pick, part-connector
    // choice, and channel slide all match, so where the ghost was is
    // exactly where the body lands.
    let snap = null;
    if (connectorOverlay && studio.viewport?.camera && rect) {
      snap = resolveLibrarySnap(ev, part, rect);
    }
    const hostConnectorId = snap ? snap.hostConnectorId : null;
    // Compute the free-placement world origin from the cursor's projection
    // onto the Z=0 ground plane — the same math the ghost preview used, so
    // "where the ghost was = where the body lands." Previously the drop
    // hard-coded [0, 0, 0] which dumped every part at world origin
    // regardless of where the user dropped, defeating cursor placement.
    let groundPos = null;
    if (!hostConnectorId && studio.viewport?.camera && studio.viewport?.renderer) {
      try {
        groundPos = cursorOnGroundPlane(ev, {
          camera: studio.viewport.camera,
          renderer: studio.viewport.renderer,
        });
        // Match the ghost: origin lock + Ctrl grid lock so the body lands
        // exactly where the preview showed.
        if (groundPos) groundPos = snapGroundPosition(groundPos, { ctrl: ev.ctrlKey || ev.metaKey });
      } catch {}
    }
    try {
      const placeRes = placeLibraryPart({
        partId: part.id,
        mate: snap
          ? {
              hostConnectorRef: { connectorId: snap.hostConnectorId },
              partConnectorId: snap.partConnectorId,
              slide: snap.slide,
            }
          : { hostConnectorRef: { world: {
              kind: 'planar', axis: [0, 0, 1],
              origin: groundPos || [0, 0, 0],
            } } },
      });
      console.log('[viewport] placeLibraryPart →', {
        partId: part.id,
        host: hostConnectorId || 'free@' + JSON.stringify(groundPos || [0, 0, 0]),
        ok: placeRes?.ok,
        componentId: placeRes?.componentId,
        error: placeRes?.error || null,
      });
      // Frame the camera onto the bridge's body AABB after the next kernel
      // render — by then the new body's geometry is in the scene. Without
      // this, dropping a part far from the current camera target (e.g.
      // user orbited away) places the body off-screen and "nothing shows
      // up." The fit is a soft tween via the view controller so it doesn't
      // surprise users who already had a careful camera setup.
      if (placeRes && placeRes.ok && placeRes.componentId) {
        // Auto-select the dropped component so the move gizmo + rotate-to-fit
        // ([ / ]) engage immediately — no extra click to start assembling.
        // Selecting by the component's StandardPart feature drives both the
        // picking selection (gizmo/rotate) and the doc selection (highlight).
        try {
          const sel = getPickingSelection();
          // NB: the onMount-scoped `store` is not visible here — resolve the
          // singleton directly (referencing `store` threw a ReferenceError,
          // which silently disabled auto-select for every drop).
          const docStore = getDocumentStore();
          const f = Object.values(docStore.doc.features || {}).find(
            (ff) => ff && ff.componentId === placeRes.componentId,
          );
          if (f) {
            sel.clear();
            sel.add({ kind: 'body', featureId: f.id }, { featureId: f.id });
          }
        } catch (err) { console.warn('[viewport] auto-select after drop failed:', err); }
      }
      if (placeRes && placeRes.ok && studio.bridge) {
        const once = studio.bridge.onRender(() => {
          console.log('[viewport] post-drop render arrived; framing to fit');
          try { studio.views?.fit?.(); }
          catch (err) { console.warn('[viewport] auto-fit after drop failed:', err); }
          // The dropped component's subgroup now exists — let the move gizmo
          // grab it so the user can immediately drag/rotate without clicking.
          try { snapDrag?.refreshAttachment?.(); }
          catch (err) { console.warn('[viewport] post-drop gizmo attach failed:', err); }
          once?.();
        });
      }
    } catch (err) {
      console.error('[viewport] placeLibraryPart failed:', err);
    }
    libraryDrag.part = null;
    libraryDrag.startedAt = 0;
    _dragLoggedThisSession = false;
    try {
      connectorOverlay && connectorOverlay.setCompatibilityProbe(null);
      connectorOverlay?.setHighlighted?.(null);
      connectorOverlay && connectorOverlay.setVisible(false);
      dragGhost && dragGhost.hide();
    } catch {}
    ghostHover = null;
  }

  function onLibraryDragLeave(ev) {
    console.log('[drag] onLibraryDragLeave', {
      target: ev?.target?.tagName,
      relatedTarget: ev?.relatedTarget?.tagName || null,
    });
    try {
      connectorOverlay && connectorOverlay.setCompatibilityProbe(null);
      connectorOverlay?.setHighlighted?.(null);
      connectorOverlay && connectorOverlay.setVisible(false);
      dragGhost && dragGhost.hide();
    } catch {}
  }

  // True when the kernel error is the harness's "no bodies" complaint —
  // a sketch-only or empty doc, not a real failure. We render an info hint
  // instead of the destructive chip.
  function isEmptyResultError(raw) {
    return /no bodies in __paraform_result__/i.test(String(raw ?? ''));
  }

  function refreshDocStats(store) {
    const features = store.doc.features || {};
    // "hasBodies" is misleading — we really mean "doc has something worth
    // showing." A sketch with no extrude yet still counts; hint is only for
    // truly empty docs. Names kept for back-compat with the markup below.
    hasBodies = Object.values(features).some((f) => f.enabled !== false);
  }

  // Right-edge column button classes (Onshape-style icon toggles).
  const BTN_BASE = 'inline-flex size-8 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground transition-colors aria-pressed:bg-accent aria-pressed:text-foreground';
  const BTN_DISABLED = 'inline-flex size-8 items-center justify-center rounded text-muted-foreground/30 cursor-not-allowed';

  // ── Body isolation (visual fade of non-isolated bodies) ────────────────
  // Walks bridge.bodyTransform; meshes belonging to a featureId NOT in
  // studio.isolatedFeatureIds get opacity 0.08 + depthWrite=false; the
  // rest are restored. Materials stash their original transparent/opacity/
  // depthWrite under userData.__pf4_isolate_orig__ so we restore cleanly.
  function applyIsolation() {
    const root = studio.bridge?.bodyTransform;
    if (!root) return;
    const set = studio.isolatedFeatureIds;
    const isolating = set instanceof Set && set.size > 0;
    root.traverse((obj) => {
      if (!obj.isMesh) return;
      if (obj.userData?.__pf4_edge_overlay__) return;
      if (obj.userData?.__pf4_hidden_edges__) return;
      if (obj.userData?.__pf4_technical_edges__) return;
      if (obj.userData?.__pf4_section_cap_mirror__) return;
      // Resolve the owning featureId — walk up parents (bodies are wrapped).
      let n = obj;
      let fid = null;
      while (n && n !== root) {
        if (n.userData?.featureId) { fid = n.userData.featureId; break; }
        n = n.parent;
      }
      const fade = isolating && fid && !set.has(fid);
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const m of mats) {
        if (!m) continue;
        if (fade) {
          if (m.userData?.__pf4_isolate_orig__ == null) {
            m.userData = m.userData || {};
            m.userData.__pf4_isolate_orig__ = {
              opacity: m.opacity, transparent: m.transparent, depthWrite: m.depthWrite,
            };
          }
          m.opacity = 0.08;
          m.transparent = true;
          m.depthWrite = false;
          m.needsUpdate = true;
        } else if (m.userData?.__pf4_isolate_orig__) {
          const o = m.userData.__pf4_isolate_orig__;
          m.opacity = o.opacity ?? 1;
          m.transparent = o.transparent ?? false;
          m.depthWrite = o.depthWrite ?? true;
          delete m.userData.__pf4_isolate_orig__;
          m.needsUpdate = true;
        }
      }
    });
  }
  $effect(() => {
    // Track the isolation set + bridge so we re-apply after each regen.
    const _ = studio.isolatedFeatureIds;
    const __ = studio.bridge;
    applyIsolation();
  });

  // Show snap indicators while a snap-aware gesture is active (face-pick
  // mode armed by another tool, or measure tool active via the
  // MeasureToolMount).
  $effect(() => {
    const want = !!studio.measureToolActive
              || !!studio.facePickMode
              || !!studio.faceEditGizmo;
    try { studio.viewport?.snapIndicators?.setVisible?.(want); } catch {}
  });

  // Reapply display mode whenever the selection changes.
  // Stash the original scene.background/environment so we can flip into a
  // "technical / blueprint" white-background line-art view and back.
  let _stashedBg = undefined;
  let _stashedEnv = undefined;
  $effect(() => {
    const mode = studio.displayMode;
    const hiddenEdges = studio.hiddenEdges;
    const xray = studio.xray;
    const appTheme = theme.value; // re-run when light/dark flips
    // viewport-v3 #9 — when a section plane is active, push it through to
    // the edge materials so silhouette/crease lines get clipped by the same
    // plane as the body (no more lines bleeding through the cut surface).
    const sectionPlane = studio.sectionPlane;
    const cps = sectionPlane && sectionPlane.isEnabled?.() ? [sectionPlane.plane] : null;
    if (studio.bridge) applyDisplayMode(studio.bridge, mode, { hiddenEdges, xray, clippingPlanes: cps });

    const scene = studio.viewport?.scene;
    if (!scene) return;

    const wantTechnical = isTechnicalMode(mode);
    const wantLight = wantTechnical || appTheme === 'light';

    // Stash original env on first override so we can restore it later.
    if ((wantTechnical || wantLight) && _stashedEnv === undefined) {
      _stashedEnv = scene.environment ?? null;
    }

    // Pick the background:
    //   technical          → flat white
    //   light app theme    → light gradient
    //   dark app theme     → dark gradient (default)
    if (wantTechnical) {
      try { scene.background = new THREE.Color(0xffffff); } catch {}
      scene.environment = null;
    } else if (appTheme === 'light') {
      try { scene.background = createGradientBackgroundTexture('#eef1f5', '#dfe4eb'); } catch {}
      // Keep IBL — light bodies still need lighting.
      if (_stashedEnv !== undefined) scene.environment = _stashedEnv;
    } else {
      try { scene.background = createGradientBackgroundTexture('#1a1d22', '#2a2f36'); } catch {}
      if (_stashedEnv !== undefined) scene.environment = _stashedEnv;
    }

    // Toggle scene helpers to match.
    scene.traverse?.((o) => {
      // Contact shadow: hide in technical mode only (light theme keeps it).
      if (o?.userData?.__pf4_contact_shadow__ || o?.name === '__pf4_contact_shadow__') {
        if (wantTechnical) {
          if (o.userData.__pf4_tech_was_visible__ == null) {
            o.userData.__pf4_tech_was_visible__ = o.visible !== false;
          }
          o.visible = false;
        } else if (o.userData.__pf4_tech_was_visible__ != null) {
          o.visible = !!o.userData.__pf4_tech_was_visible__;
          delete o.userData.__pf4_tech_was_visible__;
        }
      }
      // Infinite grid: light palette whenever bg is light (technical OR light app theme).
      if (o?.userData?.__pf4_infinite_grid__ && typeof o.setTheme === 'function') {
        o.setTheme(wantLight ? 'light' : 'dark');
      }
    });
  });

  // Extract a single readable line from kernel HTTP/Python error blobs. The
  // raw error often contains `HTTP 400: { "error": "...", "traceback": "..." }`
  // — we want the inner `error` field, falling back to the first line.
  function summariseError(raw) {
    const s = String(raw ?? '');
    // Network / fetch failures mean the kernel HTTP server isn't reachable —
    // not a CAD compile error. Map them to an actionable hint instead of the
    // raw "TypeError: Failed to fetch".
    if (isKernelOfflineError(s)) {
      return '3D engine offline — start it with: npm run kernel';
    }
    const m = s.match(/"error"\s*:\s*"([^"]+)"/);
    if (m) return m[1];
    return s.split('\n')[0].slice(0, 200);
  }

  // True for browser fetch/network failures (kernel server down / unreachable),
  // as opposed to a real kernel compile error returned over HTTP.
  function isKernelOfflineError(raw) {
    return /failed to fetch|networkerror|load failed|err_connection|fetch failed|econnrefused|connection refused|net::|aborted|abort|timed out|timeout|signal is aborted/i.test(
      String(raw ?? ''),
    );
  }

  onMount(() => {
    const viewport = bootViewport(root);
    // Don't reseed a fresh box if main.js already restored a document — even
    // an empty restored doc means the user just cleared / has an in-progress
    // sketch-only state; autosave would otherwise overwrite it with the box.
    const documentBoot = bootDocument({ scene: viewport.scene, seedIfEmpty: !persistence.restored });
    const store = getDocumentStore();
    const cadControls = attachCadControls(viewport, { bridge: documentBoot.bridge });
    const views = makeViewController({
      camera: viewport.camera,
      controls: viewport.controls,
      bridge: documentBoot.bridge,
    });

    // Populate runtime BEFORE subscribing to render events — palette commands
    // and the App.svelte keymap read studio.bridge / studio.views immediately,
    // and the first kernel run can fire before the next microtask.
    studio.setBoot({ viewport, bridge: documentBoot.bridge, views });
    // Expose the handles some consumers resolve via globals:
    // KinematicsPanel reads `window.__paraformViewport` for the scene, and
    // the measure/DFM runners read `globalThis.__paraformBridge`. Neither
    // was ever assigned in the studio, so both fell back to "not configured".
    if (typeof window !== 'undefined') {
      window.__paraformViewport = viewport;
      window.__paraformBridge = documentBoot.bridge;
    }

    // Axis triad is now embedded inside the ViewCube widget (see
    // ViewCubeMount.svelte). The standalone bottom-left mount has been
    // retired — the in-widget triad covers the same orientation cue with
    // less screen clutter.
    const triad = null;

    // KSP-style connector overlay (attach nodes + glowing slot channels).
    // Off by default; auto-on while a library-palette drag or a gizmo
    // snap-drag is in flight. This is the rich overlay from
    // app/viewport/connector_overlay.js — slot ports render as a channel
    // line the cursor magnetizes to ANYWHERE along (not just the midpoint),
    // and it supports the lock-on highlight + self-snap filter +
    // node-proximity snap that SnapDragController probes for (the previous
    // makeConnectorOverlay lacked all three, so gizmo drags could snap a
    // part to its own connectors and slot picking only worked near the
    // channel's midpoint ball).
    connectorOverlay = new ConnectorOverlay({
      scene: viewport.scene,
      camera: viewport.camera,
      docProvider: () => store.doc,
    });
    // Refresh whenever the doc changes (cheap — connector counts stay small).
    // Two guards:
    //   1. Skip selection-only events ('select'/'refs') — selecting a part
    //      doesn't move any connector, but the rebuild walks every
    //      doc.connectors entry and reallocates scene meshes. Without this
    //      filter, every click stalls for ~tens of ms in heavy docs.
    //   2. Skip when invisible — the overlay is hidden except during a
    //      library palette drag or a gizmo snap-drag. Mirrors the sibling
    //      subscriber in app/viewport/index.js:500.
    const offConnectors = store.subscribe((_doc, eventLabel) => {
      if (eventLabel === 'select' || eventLabel === 'refs') return;
      if (!connectorOverlay.isVisible()) {
        connectorOverlay.markDirty();
        return;
      }
      connectorOverlay.refresh();
    });

    // Spec 18 v2 — translucent placement ghost for library drags. Lives at
    // scene identity; the drag handlers above call setPart / setPose /
    // setSnapping / hide. Reused across drags — setPart is cached by part id.
    // Wrapped in try/catch so a construction failure in any Spec 18 v2
    // sub-system (ghost / gizmo / snap-drag) can never break the kernel
    // pipeline — viewport rendering takes priority over snap UX.
    try {
      dragGhost = new DragGhost({ scene: viewport.scene });
    } catch (err) {
      console.error('[viewport] DragGhost construction failed:', err);
      dragGhost = null;
    }

    // Spec 18 v2 — TransformGizmo + SnapDragController. The gizmo gives
    // the user a W/E/R manipulator on the selected body; SnapDragController
    // hooks its drag events, queries the overlay for compatible connectors
    // each frame, and clamps the drag to a solved mate transform when in
    // range. On release, commitMove persists the new pose: for kernel-
    // baked StandardPart features we route through `updateStandardPart`
    // (so the next kernel run produces geometry at the new pose); for any
    // other component we fall back to `setComponentOrigin`. The bridge's
    // componentSubgroup picks up component.origin on the next render
    // either way.
    // We pass `selection: null` — the gizmo's default attach heuristic
    // walks to `__v4_glb_wrap__`, which for the component-subgroup tree
    // used here lands on the whole-body root and moves every body at once.
    // SnapDragController owns attachment instead: it watches the picking
    // selection, resolves to the right `__v4_component_<id>__` subgroup
    // (so the gizmo moves just that component), and calls `gizmo.attach`
    // directly.
    try {
      transformGizmo = new TransformGizmo({
        camera: viewport.camera,
        renderer: viewport.renderer,
        scene: viewport.scene,
        cameraControls: viewport.controls,
        selection: null,
        bodyRoot: () => documentBoot.bridge?.bodyTransform || null,
        onChange: () => { try { viewport.controls?.dispatchEvent?.({ type: 'change' }); } catch {} },
        initialMode: 'translate',
        // Translate only: rotate (E) / scale (R) drags are not yet committed to
        // the document, so they'd silently revert on the next kernel regen.
        // Restrict the gizmo until the rotate/scale commit path exists.
        allowedModes: ['translate'],
        installHotkeys: true,
      });
    } catch (err) {
      console.error('[viewport] TransformGizmo construction failed:', err);
      transformGizmo = null;
    }
    // Auto-prune the picking selection when its target feature/component
    // gets deleted. Without this, selection entries linger after a delete
    // → TransformGizmo holds onto a removed Object3D → its handles ghost
    // over the spot where the body used to be. Faster than diffing each
    // entry: track ids we've seen and drop ones that are no longer in the
    // doc the next time the store fires.
    let _knownFeatureIds = new Set(Object.keys(store.doc.features || {}));
    let _knownComponentIds = new Set(Object.keys(store.doc.components || {}));
    const offSelectionPrune = store.subscribe((d) => {
      const sel = getPickingSelection();
      if (!sel || sel.size === 0) {
        _knownFeatureIds = new Set(Object.keys(d.features || {}));
        _knownComponentIds = new Set(Object.keys(d.components || {}));
        return;
      }
      const liveFeatures   = new Set(Object.keys(d.features   || {}));
      const liveComponents = new Set(Object.keys(d.components || {}));
      // Collect removed feature/component ids.
      const droppedFeatures   = [..._knownFeatureIds].filter((id) => !liveFeatures.has(id));
      const droppedComponents = [..._knownComponentIds].filter((id) => !liveComponents.has(id));
      if (droppedFeatures.length || droppedComponents.length) {
        for (const entry of sel.toArray()) {
          const desc = entry.descriptor || {};
          const fid = desc.featureId || desc.feature || null;
          const cid = desc.componentId || null;
          const fGone = fid && droppedFeatures.includes(fid);
          const cGone = cid && droppedComponents.includes(cid);
          if (fGone || cGone) {
            try { sel.remove(entry.key); } catch {}
          }
        }
      }
      _knownFeatureIds = liveFeatures;
      _knownComponentIds = liveComponents;
    });

    // Shared placement-commit: route a new component pose through the
    // StandardPart `transform` field (so the next kernel compile bakes the
    // geometry at the new pose) AND write component.origin (so the tree +
    // component-aware rendering agree). Used by the snap-drag controller AND
    // the keyboard rotate-to-fit handler below — one path keeps them coherent.
    function commitComponentMove(componentId, originPatch) {
      const doc = store.doc;
      const standardParts = Object.values(doc.features || {}).filter(
        (f) => f && f.type === 'StandardPart' && f.componentId === componentId,
      );
      if (standardParts.length > 0) {
        for (const f of standardParts) {
          try { v4.updateStandardPart(f.id, { transform: originPatch }); }
          catch (err) { console.warn('[placement] updateStandardPart failed:', err); }
        }
      }
      try { v4.setComponentOrigin(componentId, originPatch); }
      catch (err) { console.warn('[placement] setComponentOrigin failed:', err); }
    }

    try { if (transformGizmo) snapDrag = new SnapDragController({
      transformGizmo,
      connectorOverlay,
      camera: viewport.camera,
      renderer: viewport.renderer,
      docProvider: () => store.doc,
      selection: getPickingSelection(),
      bodyRoot: () => documentBoot.bridge?.bodyTransform || null,
      geometryProvider: () => documentBoot.bridge?.geometry || null,
      commitMove: commitComponentMove,
      onChange: () => { try { viewport.controls?.dispatchEvent?.({ type: 'change' }); } catch {} },
    }); } catch (err) {
      console.error('[viewport] SnapDragController construction failed:', err);
      snapDrag = null;
    }

    // Persistent sketch overlay — keeps every committed Sketch feature
    // visible as line geometry on its plane (Fusion-style). Subscribes to
    // the store internally; the rAF poll below feeds it the active sketch
    // id so the live Sketch3DRenderer doesn't double up.
    const sketchOverlay = new SketchOverlay({ scene: viewport.scene, store });

    // Onshape-style interactive reference planes (XY/XZ/YZ). The module owns
    // its own raycast / hover tooltip / click → enterSketch wiring; we feed
    // it scene bounds on each kernel render and toggle visibility based on
    // sketch / selection / drag state below.
    const referencePlanes = new ReferencePlanes({
      scene: viewport.scene,
      camera: viewport.camera,
      renderer: viewport.renderer,
      onSketchOnPlane: ({ planeId }) => {
        // The legacy string-plane path on enterSketch maps 'XY'|'XZ'|'YZ'
        // → stock world planes, which is exactly what the default refs are.
        try { enterSketch(planeId); } catch (err) {
          console.error('[reference_planes] enterSketch failed:', err);
        }
      },
    });
    // Expose imperative refs + user-toggleable visibility flags through
    // studio so palette commands and external tooling can drive them.
    studio.referencePlanes = referencePlanes;
    studio.sketchOverlay   = sketchOverlay;
    $effect(() => {
      const v = studio.referencePlanesVisible;
      try { studio.referencePlanes?.setVisible?.(!!v); } catch {}
    });
    $effect(() => {
      const m = studio.referencePlaneIndividual;
      try {
        studio.referencePlanes?.setPlaneVisible?.('XY', m?.XY !== false);
        studio.referencePlanes?.setPlaneVisible?.('XZ', m?.XZ !== false);
        studio.referencePlanes?.setPlaneVisible?.('YZ', m?.YZ !== false);
      } catch {}
    });
    $effect(() => {
      const v = studio.sketchOverlayVisible;
      try { studio.sketchOverlay?.setVisible?.(!!v); } catch {}
    });

    // ── Phase A1 — Reference-image planes ──────────────────────────────────
    // Mount/update/remove a textured plane for every ReferenceImage feature.
    // The sync helper is idempotent and content-hashed, so it's cheap to run
    // on every store tick; skip selection-only events (they never add/remove
    // a ReferenceImage or change its placement). Initial pass mounts any
    // planes a restored document already carries.
    function syncRefImages() {
      try { syncReferenceImages(store.doc, viewport.scene); }
      catch (err) { console.warn('[viewport] syncReferenceImages failed:', err); }
    }
    syncRefImages();
    const offRefImages = store.subscribe((_doc, eventLabel) => {
      if (eventLabel === 'select' || eventLabel === 'refs') return;
      syncRefImages();
    });

    // ── E3.5 — Cosmetic-thread overlay ────────────────────────────────────
    // A scene group that, on every successful kernel render, rebuilds a set
    // of hatched line segments on each face tagged by a CosmeticThread
    // feature. The kernel's `bridge.geometry.faces` map provides per-face
    // triangulations keyed by descriptor; we fall back gracefully when the
    // descriptor / geometry isn't yet resolvable.
    const cosmeticThreadOverlay = new THREE.Group();
    cosmeticThreadOverlay.name = '__pf4_cosmetic_thread_overlay__';
    cosmeticThreadOverlay.renderOrder = 2;
    viewport.scene.add(cosmeticThreadOverlay);

    function disposeThreadOverlay() {
      while (cosmeticThreadOverlay.children.length) {
        const child = cosmeticThreadOverlay.children.pop();
        child.geometry?.dispose?.();
        child.material?.dispose?.();
      }
    }

    function rebuildThreadOverlay() {
      disposeThreadOverlay();
      const doc = store.doc;
      if (!doc || !doc.features) return;
      const feats = Object.values(doc.features).filter(
        (f) => f && f.enabled !== false && f.type === 'CosmeticThread',
      );
      if (feats.length === 0) return;
      // bridge.geometry shape (per face_overlay.js): a map keyed by stringified
      // descriptor → { positions: Float32Array, ... }. We accept either that
      // or any object exposing `.faces` similarly. Be defensive on absence.
      const faceGeoms = documentBoot.bridge?.geometry?.faces || null;
      const mat = new THREE.LineBasicMaterial({
        color: 0xe5a04a,
        transparent: true,
        opacity: 0.85,
        depthTest: true,
      });
      for (const feat of feats) {
        const face = feat.params?.face;
        if (!face) continue;
        // Resolve face geometry: try keyed lookup, then fall back to a small
        // marker line at the body origin (kernel may not yet expose this
        // particular descriptor).
        let positions = null;
        try {
          if (faceGeoms && typeof faceGeoms === 'object') {
            const key = (face.canonical || face.key || JSON.stringify(face));
            const entry = faceGeoms[key] || faceGeoms.get?.(key);
            if (entry && entry.positions) positions = entry.positions;
          }
        } catch { /* fall through */ }
        if (!positions) {
          // No geometry resolution — drop a single short hatch at the world
          // origin so the user still sees a visual indicator on the feature.
          const geom = new THREE.BufferGeometry();
          geom.setAttribute('position', new THREE.Float32BufferAttribute([
            0, 0, 0,  5, 0, 0,
          ], 3));
          cosmeticThreadOverlay.add(new THREE.LineSegments(geom, mat));
          continue;
        }
        // Generate 3-5 parallel hatch lines across the face by sampling
        // positions at evenly-spaced t in [0,1] along the position buffer's
        // bounding box. Cheap & defensive — exact hatch direction is a v2.
        const bb = new THREE.Box3();
        const v = new THREE.Vector3();
        for (let i = 0; i < positions.length; i += 3) {
          v.set(positions[i], positions[i+1], positions[i+2]);
          bb.expandByPoint(v);
        }
        if (bb.isEmpty()) continue;
        const size = new THREE.Vector3();
        bb.getSize(size);
        const hatchCount = 4;
        const pts = [];
        for (let h = 1; h <= hatchCount; h++) {
          const t = h / (hatchCount + 1);
          const y = bb.min.y + t * size.y;
          pts.push(bb.min.x, y, bb.min.z, bb.max.x, y, bb.max.z);
        }
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
        cosmeticThreadOverlay.add(new THREE.LineSegments(geom, mat));
      }
    }
    // Rebuild on every successful kernel render — bridge.lastRenderMs is set
    // there. Also rebuild on store commits so toggling enabled / adding /
    // removing a CosmeticThread feature is reflected without waiting for
    // the next kernel cycle.
    const offThreadRender = documentBoot.bridge.onRender(rebuildThreadOverlay);
    // Skip selection-only events — they can't change which CosmeticThread
    // features exist. The rebuild walks every feature, resolves a face
    // descriptor against bridge.geometry, builds a Box3 by iterating the
    // face's vertex buffer, then allocates fresh LineSegments per thread —
    // too expensive to run on every part click.
    const offThreadDoc = store.subscribe((_doc, eventLabel) => {
      if (eventLabel === 'select' || eventLabel === 'refs') return;
      rebuildThreadOverlay();
    });

    // ── Reference-plane visibility & sizing ────────────────────────────────
    // Hide planes when: a sketch is active, a body is selected (the user is
    // working on geometry, Onshape-style), a face-pick gesture is armed, or
    // the measure tool is live. Stay visible during orbit/pan/zoom —
    // hiding them on every drag makes them flicker constantly.
    let refPlanesPickingSel = null; // assigned below once pickingSel is built
    function recomputeRefPlanesVisible() {
      const hidden = !studio.referencePlanesVisible
                  || isSketchActive()
                  || !!studio.facePickMode
                  || !!studio.measureToolActive
                  || !!store.selectedFeatureId?.()
                  || !!(refPlanesPickingSel && refPlanesPickingSel.size > 0);
      referencePlanes.setVisible(!hidden);
    }

    // Hide/show whenever doc selection changes or a body lands.
    const offRefPlanesDoc = store.subscribe(() => recomputeRefPlanesVisible());

    // Resize planes to scene bounds on every kernel render, then recompute
    // visibility (sketch enter/exit lands as a doc commit but also clears
    // selection — both flow through `offRefPlanesDoc` above).
    const offRefPlanesSize = documentBoot.bridge.onRender(() => {
      try {
        const root = documentBoot.bridge?.bodyTransform;
        referencePlanes.setSceneBoundsFromObject(root);
      } catch {}
      recomputeRefPlanesVisible();
    });
    // Initial pass.
    recomputeRefPlanesVisible();

    // Sketch enter/exit doesn't flow through the doc store, so poll the
    // sketch-active state on a cheap rAF and recompute on transition.
    let _lastSketchActive = isSketchActive();
    let _lastActiveSketchId = studio.activeSketchFeatureId;
    let _refPlanesRaf = 0;
    const _refPlanesPollLoop = () => {
      const now = isSketchActive();
      if (now !== _lastSketchActive) {
        _lastSketchActive = now;
        recomputeRefPlanesVisible();
        // Sketch session ended → drop the active-sketch suppression so the
        // overlay can render the just-committed feature on its next refresh.
        if (!now && studio.activeSketchFeatureId) {
          studio.activeSketchFeatureId = null;
        }
      }
      // Push active-sketch id transitions into the overlay so the live
      // editor's feature is suppressed (enter) / re-shown (exit).
      const aid = studio.activeSketchFeatureId;
      if (aid !== _lastActiveSketchId) {
        _lastActiveSketchId = aid;
        try { sketchOverlay.setActiveSketchId(aid); } catch {}
      }
      // Keep connector attach-nodes a constant on-screen size (no-op while
      // the overlay is hidden — it early-returns on !visible).
      try { connectorOverlay?.updateScreenSpaceSize?.(root?.clientHeight || 600); } catch {}
      _refPlanesRaf = requestAnimationFrame(_refPlanesPollLoop);
    };
    _refPlanesRaf = requestAnimationFrame(_refPlanesPollLoop);

    // Double-MMB tap in CADCameraControls fires 'fit' — wire to viewController.
    try { viewport.controls.addEventListener?.('fit', () => views.fit()); } catch {}

    // ── Auto-frame the scene ──────────────────────────────────────────────
    // The studio boots empty (no seed box) with the camera at its default
    // pose — content the AI builds can land off-screen. We frame the camera:
    //   (a) once, the first time geometry actually appears (empty→non-empty),
    //   (b) whenever a NEW top-level body shows up (a placement or AI tool
    //       result), so freshly added features aren't invisible.
    // We DON'T refit on every recompute — that would fight a user who's
    // carefully framed their own view while editing existing geometry.
    //
    // "Body count" = direct children of the kernel root (one GLB wrap per
    // emitted body group). Empty == 0.
    function topLevelBodyCount() {
      const r = documentBoot.bridge?._root;
      return r ? r.children.length : 0;
    }
    let firstFitDone = false;
    let _lastBodyCount = 0;
    const offFirstFit = documentBoot.bridge.onRender(() => {
      const count = topLevelBodyCount();
      // Don't frame an empty scene — wait for the first real geometry.
      if (count === 0) { _lastBodyCount = 0; return; }
      const isFirstContent = !firstFitDone;
      const grew = count > _lastBodyCount;
      _lastBodyCount = count;
      if (isFirstContent) firstFitDone = true;
      // Frame on first content, or when a new top-level body appears. The
      // tween runs a tick later so the just-rendered geometry's AABB is live.
      if (isFirstContent || grew) {
        setTimeout(() => { try { views.fit(); } catch (err) { console.warn('[viewport] auto-fit failed:', err); } }, 50);
      }
    });

    // Reapply display mode after each kernel render (meshes get replaced).
    const offDisplay = documentBoot.bridge.onRender(() => {
      const sp = studio.sectionPlane;
      const cps = sp && sp.isEnabled?.() ? [sp.plane] : null;
      applyDisplayMode(documentBoot.bridge, studio.displayMode, {
        hiddenEdges: studio.hiddenEdges,
        xray: studio.xray,
        clippingPlanes: cps,
      });
      applyRollback();
      try { applyIsolation(); } catch {}
    });

    // ── E6.5 — Rollback head: hide every body mesh past the marker. The
    // bridge's bodyTransform parents one group per emitted body keyed on
    // userData.featureId; we walk it and flip .visible.
    function applyRollback() {
      const root = documentBoot.bridge?.bodyTransform;
      const head = studio.rollbackHead;
      if (!root) return;
      const suppressed = head ? featuresSuppressedByRollback(store.doc, head) : null;
      root.traverse((obj) => {
        if (obj === root) return;
        const fid = obj.userData?.featureId;
        if (!fid) return;
        obj.visible = suppressed ? !suppressed.has(fid) : true;
      });
    }
    // Also re-apply when the rollback head flips. The studio runtime exposes
    // a $state rune; we poll on each store tick + provide a window-level event
    // (studio.rollbackHead = x dispatches no event by itself). For v1 it's
    // sufficient that the next render / commit refreshes; the timeline scrub
    // UI fires applyRollback directly via the exposed hook below.

    const offError = documentBoot.onKernelError(({ error }) => {
      if (isEmptyResultError(error)) {
        kernelError = null;
        kernelOffline = false;
        return;
      }
      kernelOffline = isKernelOfflineError(error);
      kernelError = summariseError(error);
    });

    // Clear the error chip on the next successful render.
    const offRenderClear = documentBoot.bridge.onRender(() => {
      if (kernelError) kernelError = null;
      if (kernelOffline) kernelOffline = false;
    });

    // Track body-source presence so the empty hint can suggest a next step.
    refreshDocStats(store);
    const offDoc = store.subscribe((_doc, _evt, s) => refreshDocStats(s));

    const bodyHighlight = bootBodyHighlight({ store, bridge: documentBoot.bridge });

    const picking = bootPicking({
      scene: viewport.scene,
      camera: viewport.camera,
      renderer: viewport.renderer,
      controls: viewport.controls,
      bridge: documentBoot.bridge,
      isPickingActive: () => !isSketchActive(),
      // Body-fallback path (placed StandardParts whose faces don't reach the
      // proxy layer):
      //   - setActiveComponent → sidebar tree highlights the row
      //   - selectFeature → 3D wireframe highlight on the body (the body
      //     highlight layer subscribes only to store.selectedFeatureId)
      //   - both together let the user see what's selected, and the slide /
      //     rotate keyboard handlers can act on it.
      onComponentPick: ({ componentId, featureId }) => {
        try { studio.setActiveComponent(componentId); } catch (err) {
          console.warn('[picking] setActiveComponent failed', err);
        }
        if (featureId) {
          try { store.selectFeature(featureId); } catch (err) {
            console.warn('[picking] selectFeature failed', err);
          }
        }
      },
      onPick: (evt) => {
        // ── Face-pick gesture interception (E2.1 / E2.4) ────────────────
        // When the studio runtime has armed `facePickMode`, the next valid
        // descriptor click is consumed by that gesture instead of feeding
        // the regular selection.
        const mode = studio.facePickMode;
        if (mode && evt.kind === 'add' && evt.descriptor) {
          const kind = evt.descriptor.kind;
          if (mode.accept?.has(kind)) {
            const desc = evt.descriptor;
            const payload = evt.payload || null;
            // Clear before invoking so the picked face isn't left selected.
            try { store.selectFeature(null); } catch {}
            studio.facePickMode = null;
            try { mode.onPick(desc, payload); } catch (err) { console.error('[face-pick] onPick threw', err); }
            return;
          }
          // Wrong kind — ignore the click (banner still up).
          return;
        }
        if (evt.kind === 'clear') {
          store.selectFeature(null);
          return;
        }
        if (evt.kind === 'add') {
          const fid = evt.payload?.featureId || evt.descriptor?.featureId || null;
          if (fid) store.selectFeature(fid);
        }
      },
    });

    // Surface picking sub-layers on studio.viewport so HUD mounts (measure,
    // viewport-hud) can reach them without re-instantiating their own.
    try {
      if (studio.viewport) {
        studio.viewport.pickProxies = picking.pickProxies;
        studio.viewport.faceOverlay = picking.faceOverlay;
        studio.viewport.pickingSelection = picking.selection;
      }
    } catch {}

    // ── E4.1 — Rubber-band (box / crossing) selection ──────────────────────
    // Drags in empty space turn into a window/crossing marquee; on commit,
    // every body whose AABB satisfies the membership test gets stamped into
    // the picking selection so booleans / transforms can chain off it.
    const pickingSel = getPickingSelection();
    // Wire ref-plane visibility into pick-selection changes.
    refPlanesPickingSel = pickingSel;
    const offRefPlanesPickSel = pickingSel.subscribe?.(() => recomputeRefPlanesVisible()) || (() => {});
    recomputeRefPlanesVisible();
    const rubber = new RubberBand({
      container: root,
      canvas: viewport.renderer.domElement,
      camera: viewport.camera,
      pickablesProvider: () => {
        // bridge._root holds every body group emitted by the kernel.
        const r = documentBoot.bridge?._root;
        return r ? [...r.children] : [];
      },
      isEnabled: () => !isSketchActive() && !studio.facePickMode && !studio.measureToolActive,
      onCommit: (picks, _mode, additive) => {
        if (!additive) pickingSel.clear();
        for (const obj of picks) {
          const desc = obj.userData?.descriptor;
          const payload = obj.userData?.pickPayload || {};
          if (desc) {
            try { pickingSel.add(desc, payload); } catch {}
            continue;
          }
          // Fallback: every body group carries a featureId on userData.
          const fid = obj.userData?.featureId;
          if (fid) {
            try { pickingSel.add({ kind: 'body', featureId: fid }, { featureId: fid }); } catch {}
          }
        }
      },
    });

    // ── Snap indicators ────────────────────────────────────────────────────
    // Ghost markers near the cursor showing vertex / edge-midpoint / face-
    // center candidates whenever a snapping-aware tool is active (measure /
    // face-pick / gizmo drag). The markers are pure UI — the actual pick
    // still goes through PickProxyLayer which is already exact.
    const snapIndicators = mountSnapIndicators({
      host: root,
      camera: viewport.camera,
      renderer: viewport.renderer,
    });
    const refreshSnapCandidates = () => {
      try {
        snapIndicators.setCandidates(buildSnapCandidates(documentBoot.bridge?.geometry));
      } catch {}
    };
    refreshSnapCandidates();
    const offSnapRender = documentBoot.bridge.onRender(refreshSnapCandidates);
    const onSnapPointerMove = (ev) => {
      try { snapIndicators.update({ clientX: ev.clientX, clientY: ev.clientY }); } catch {}
    };
    viewport.renderer.domElement.addEventListener('pointermove', onSnapPointerMove);
    try { if (studio.viewport) studio.viewport.snapIndicators = snapIndicators; } catch {}

    // ── Lasso + Paint select (viewport-v3 #8) ──────────────────────────────
    // Shift+drag-from-empty → freehand lasso (point-in-polygon on AABB
    // centre); P+drag → paint-select (anything brushed by the cursor disc).
    // Both are additive on top of the existing selection.
    const lassoPaint = new LassoPaintSelect({
      container: root,
      canvas: viewport.renderer.domElement,
      camera: viewport.camera,
      pickablesProvider: () => {
        const r = documentBoot.bridge?._root;
        return r ? [...r.children] : [];
      },
      isEnabled: () => !isSketchActive() && !studio.facePickMode && !studio.measureToolActive,
      onCommit: (picks, _mode /* 'lasso'|'paint' */, _additive) => {
        for (const obj of picks) {
          const desc = obj.userData?.descriptor;
          const payload = obj.userData?.pickPayload || {};
          if (desc) { try { pickingSel.add(desc, payload); } catch {} continue; }
          const fid = obj.userData?.featureId;
          if (fid) { try { pickingSel.add({ kind: 'body', featureId: fid }, { featureId: fid }); } catch {} }
        }
      },
    });

    // ── E4.2 — Marking menu (right-click radial) ───────────────────────────
    // The restored module expects a registry-like object with `.get(id)`,
    // `.run(id, ctx)`, `.reasonDisabled(id, ctx)`. Our COMMANDS array shape
    // is different; build a thin shim that adapts.
    const cmdById = Object.fromEntries(COMMANDS.map((c) => [c.id, c]));
    const markingRegistry = {
      get(id) {
        const c = cmdById[id];
        if (!c) return null;
        return {
          id: c.id,
          label: c.title.replace(/…$/, '').replace(/\s+Selected$/, ''),
          isEnabled: (ctx) => {
            if (typeof c.enabled !== 'function') return true;
            try { return !!c.enabled(ctx); } catch { return false; }
          },
        };
      },
      reasonDisabled(id, ctx) {
        const c = cmdById[id];
        if (!c) return 'Command not available';
        if (typeof c.enabled !== 'function') return null;
        try { return c.enabled(ctx) ? null : 'Requires a selection'; } catch { return 'Unavailable'; }
      },
      run(id, ctx) {
        const c = cmdById[id];
        if (!c) return false;
        if (c.form) {
          // Form-driven commands open via the dialog system — same path the
          // command palette / Toolbar use. Route the wedge straight to it so
          // the menu actually fires the command instead of silently bailing.
          try { dialogs.openForm(c); return true; }
          catch (err) { console.error('[marking-menu] openForm failed', err); return false; }
        }
        try { c.run(ctx); return true; } catch (err) { console.error('[marking-menu]', err); return false; }
      },
    };

    let marking = null;
    try {
      marking = new MarkingMenu({
        canvas: viewport.renderer.domElement,
        registry: markingRegistry,
        getContext: () => ({ store }),
        getActions: () => {
          // E4 v2 — read bindings on every open so Settings edits apply
          // without a viewport rebuild. Falls back to MARKING_MENU_ACTIONS
          // for any sector the user has cleared / not overridden.
          const b = loadMarkingMenuBindings();
          return MARKING_MENU_SECTORS.map((s) => b[s] || MARKING_MENU_ACTIONS[s] || null);
        },
        toast: (msg) => { console.info('[marking-menu]', msg); showMarkingToast(msg); },
      });
    } catch (err) {
      console.warn('[viewport] marking menu disabled:', err?.message || err);
    }

    // Measure tool + section plane are owned by MeasureToolMount /
    // SectionPlaneMount; they install studio.measureTool / studio.toggleSection
    // hooks for palette dispatch. The legacy `startMeasure` / `startSection`
    // functions and their state were removed in the viewport-cleanup pass.

    // ── E4.5 — Interference detection ──────────────────────────────────────
    // Highlight is a translucent red overlay group; for v1 we render a small
    // ring marker at the centroid of each interfering pair instead of the
    // true intersection volume (kernel `interference` query returns volume
    // scalar, not the body — true overlap-volume meshing is a v2).
    const interferenceOverlay = new THREE.Group();
    interferenceOverlay.name = '__pf4_interference_overlay__';
    viewport.scene.add(interferenceOverlay);

    function clearInterference() {
      while (interferenceOverlay.children.length) {
        const c = interferenceOverlay.children.pop();
        c.geometry?.dispose?.(); c.material?.dispose?.();
      }
      interferenceResults = null;
    }

    async function runInterference(bodyIds) {
      if (!Array.isArray(bodyIds) || bodyIds.length < 2) return;
      clearInterference();
      const pairs = [];
      for (let i = 0; i < bodyIds.length; i++) {
        for (let j = i + 1; j < bodyIds.length; j++) {
          pairs.push([bodyIds[i], bodyIds[j]]);
        }
      }
      let intersects = 0;
      let totalVolume = 0;
      const queries = pairs.map(([a, b]) => ({
        type: 'interference', a: { featureId: a }, b: { featureId: b },
      }));
      try {
        const results = await studio.measure(queries);
        const rs = Array.isArray(results) ? results : [results];
        for (let k = 0; k < rs.length; k++) {
          const r = rs[k];
          if (r && r.ok && r.intersects) {
            intersects++;
            if (typeof r.volume === 'number') totalVolume += r.volume;
            // Drop a marker at the midpoint of the two body centroids.
            const [a, b] = pairs[k];
            const aFeat = store.doc.features?.[a];
            const bFeat = store.doc.features?.[b];
            const ac = aFeat?.outputs?.bodies?.[0]?.centroid || [0,0,0];
            const bc = bFeat?.outputs?.bodies?.[0]?.centroid || [0,0,0];
            const mid = [(ac[0]+bc[0])/2, (ac[1]+bc[1])/2, (ac[2]+bc[2])/2];
            const geom = new THREE.SphereGeometry(3, 12, 12);
            const mat = new THREE.MeshBasicMaterial({
              color: 0xff3344, transparent: true, opacity: 0.55, depthTest: false,
            });
            const mesh = new THREE.Mesh(geom, mat);
            mesh.position.set(mid[0], mid[1], mid[2]);
            mesh.renderOrder = 999;
            interferenceOverlay.add(mesh);
          }
        }
      } catch (err) {
        console.warn('[interference] measure failed', err);
      }
      interferenceResults = { pairs: intersects, totalVolume };
    }

    // Register the action hooks with the runtime so palette commands can
    // dispatch into this viewport instance. (startMeasure / startSection
    // are installed by MeasureToolMount / SectionPlaneMount.)
    studio.runInterference = runInterference;
    studio.applyRollback = applyRollback;

    // Keep the rotate-to-fit hint in sync with the selection.
    selectedComponentId = resolveSelectedComponentId(pickingSel, store.doc);
    const offRotateSel = pickingSel.subscribe?.(() => {
      selectedComponentId = resolveSelectedComponentId(pickingSel, store.doc);
    }) || (() => {});

    // ── Rotate-to-fit ──────────────────────────────────────────────────────
    // `]` / `[` spin the selected component ±90° (Shift = ±15° fine) so the
    // user can orient a placed part to fit. When the part is mated, we
    // re-solve the mate about its axis (the part stays seated, only its spin
    // changes) and persist the accumulated roll on the Mate so a later swap
    // keeps the orientation. Free placements spin in place about world +Z.
    const ROTATE_STEP = Math.PI / 2;     // 90°
    const ROTATE_FINE = Math.PI / 12;    // 15°
    function rotateSelected(ev, dir) {
      const cid = resolveSelectedComponentId(pickingSel, store.doc);
      if (!cid) return false;
      const mag = ev.shiftKey ? ROTATE_FINE : ROTATE_STEP;
      const res = computeRolledOrigin(store.doc, cid, dir * mag);
      if (!res) return false;
      commitComponentMove(cid, res.origin);
      if (res.mateId && Number.isFinite(res.roll)) {
        // Persist slide alongside roll — updateMate replaces the offset
        // object, and dropping the slide would teleport a channel-seated
        // part back to the channel origin on the next re-solve.
        const offset = Number.isFinite(res.slide)
          ? { roll: res.roll, slide: res.slide }
          : { roll: res.roll };
        try { v4.updateMate(res.mateId, { offset }); }
        catch (err) { console.warn('[rotate-to-fit] updateMate failed:', err); }
      }
      try { viewport.controls?.dispatchEvent?.({ type: 'change' }); } catch {}
      return true;
    }

    // ── Slide-along-channel (live preview + debounced commit) ────────────────
    // `,` / `.` nudge a channel-mated component (e.g. a t-nut) along its slot
    // run. Two key UX requirements: (1) instant visual feedback per press,
    // and (2) no kernel re-bake per press (each commit triggers a Python
    // recompile that's ~200ms+).
    //
    // The pattern (same as snap_drag's live drag):
    //   - First press captures the component subgroup + the matrices needed
    //     to translate "desired component world pose" into "local subgroup
    //     transform that puts the baked mesh there." All math via
    //     snap_frames.localForWorldPose.
    //   - Each subsequent press accumulates `baseSlide` locally (so we don't
    //     have to commit + read back from doc), re-solves the mate transform,
    //     and pushes the new pose into the subgroup directly. Visually
    //     instant.
    //   - SLIDE_COMMIT_MS after the last press, we flush the commit:
    //     updateMate(offset.slide) + commitComponentMove. The kernel re-bakes;
    //     bridge resets the subgroup to identity (per its placement-baked
    //     contract); the new GLB has the part at the new position. No flicker
    //     because the re-baked mesh lands at the same world spot we were
    //     previewing.
    const SLIDE_STEP = 10;       // mm — default coarse step
    const SLIDE_FINE = 1;        // mm — Shift = fine
    const SLIDE_COMMIT_MS = 350; // debounce before the kernel re-bake fires
    let _slideLive = null;       // { componentId, subgroup, Pinv, objStart, W0inv, slide, lastRes, commitTimer }

    function _captureSlideLive(componentId) {
      const bridge = documentBoot.bridge;
      const subgroup = bridge && bridge.componentSubgroup && bridge.componentSubgroup(componentId);
      const parent = subgroup && subgroup.parent;
      if (!subgroup || !parent) return null;
      parent.updateMatrixWorld(true);
      subgroup.updateMatrixWorld(true);
      const Pinv     = parent.matrixWorld.clone().invert();
      const objStart = subgroup.matrixWorld.clone();
      const comp = store.doc?.components?.[componentId];
      const origin = (comp && comp.origin) || { position: [0,0,0], rotation: [0,0,0] };
      const W0     = composeMatrix(origin.position, origin.rotation);
      const W0inv  = W0.clone().invert();
      // Initial slide baseline — persisted offset, else 0.
      let slide = 0;
      const mates = store.doc?.mates || {};
      for (const m of Object.values(mates)) {
        if (m && m.componentId === componentId && m.offset && Number.isFinite(m.offset.slide)) {
          slide = m.offset.slide;
          break;
        }
      }
      return { componentId, subgroup, Pinv, objStart, W0inv, slide, lastRes: null, commitTimer: null };
    }

    function _flushSlideCommit() {
      if (!_slideLive || !_slideLive.lastRes) {
        if (_slideLive) _slideLive.commitTimer = null;
        return;
      }
      const cid = _slideLive.componentId;
      const res = _slideLive.lastRes;
      if (res.mateId && Number.isFinite(res.slide)) {
        const offset = Number.isFinite(res.roll)
          ? { roll: res.roll, slide: res.slide }
          : { slide: res.slide };
        try { v4.updateMate(res.mateId, { offset }); }
        catch (err) { console.warn('[slide-nudge] updateMate failed:', err); }
      }
      try { commitComponentMove(cid, res.origin); }
      catch (err) { console.warn('[slide-nudge] commitComponentMove failed:', err); }
      // Clear lastRes so we don't re-commit on a stale timer; keep the live
      // state so subsequent keys keep editing the same part smoothly.
      _slideLive.lastRes = null;
      _slideLive.commitTimer = null;
    }

    function slideSelected(ev, dir) {
      const preferred = resolveSelectedComponentId(pickingSel, store.doc);
      const found = findSlidableComponent(store.doc, preferred);
      if (!found.componentId) {
        if (found.reason === 'ambiguous') {
          showMarkingToast('Multiple sliding parts — click the one you want in the left sidebar tree first.');
        } else {
          showMarkingToast('Nothing to slide. Place a t-nut on a slot first, or click a channel-mated part.');
        }
        return true;
      }
      const cid = found.componentId;
      if (studio.activeComponentId !== cid) {
        try { studio.setActiveComponent(cid); } catch {}
      }

      // (Re-)capture live state when we change components or the bridge has
      // replaced the subgroup beneath us (re-bake invalidates the cache).
      const bridge = documentBoot.bridge;
      const currentSubgroup = bridge && bridge.componentSubgroup && bridge.componentSubgroup(cid);
      if (!_slideLive
          || _slideLive.componentId !== cid
          || _slideLive.subgroup !== currentSubgroup) {
        // If we have a pending commit on a different component, flush it now.
        if (_slideLive && _slideLive.commitTimer) {
          clearTimeout(_slideLive.commitTimer);
          _flushSlideCommit();
        }
        _slideLive = _captureSlideLive(cid);
        if (!_slideLive) return false;
      }

      const mag = ev.shiftKey ? SLIDE_FINE : SLIDE_STEP;
      const res = computeSlidPlacement(store.doc, cid, dir * mag, { baseSlide: _slideLive.slide });
      if (!res) {
        showMarkingToast('Selection has no channel mate.');
        return true;
      }

      // Drive the subgroup directly. Mesh visually lands at the new pose with
      // zero kernel involvement — instant feedback.
      const Wnew = composeMatrix(res.origin.position, res.origin.rotation);
      const local = localForWorldPose(_slideLive.Pinv, _slideLive.objStart, _slideLive.W0inv, Wnew);
      local.decompose(_slideLive.subgroup.position, _slideLive.subgroup.quaternion, _slideLive.subgroup.scale);
      _slideLive.subgroup.updateMatrixWorld(true);

      _slideLive.slide   = res.slide;
      _slideLive.lastRes = res;

      // Debounce the commit (re-bake) until the user settles.
      if (_slideLive.commitTimer) clearTimeout(_slideLive.commitTimer);
      _slideLive.commitTimer = setTimeout(_flushSlideCommit, SLIDE_COMMIT_MS);

      const compName = store.doc?.components?.[cid]?.name || 'part';
      showMarkingToast(`${compName} · slide ${res.slide.toFixed(1)} mm`);
      try { viewport.controls?.dispatchEvent?.({ type: 'change' }); } catch {}
      return true;
    }

    // ── Face-pick: Esc cancels the gesture; window-level so it fires even
    // when the pointer isn't over the canvas. ──────────────────────────────
    const onKeyDown = (ev) => {
      if (ev.key === 'Escape') {
        if (studio.facePickMode) { studio.cancelFacePick(); ev.stopPropagation(); return; }
        if (interferenceResults) { clearInterference(); ev.stopPropagation(); return; }
      }
      // Rotate-to-fit — skip while typing or with modifiers reserved for nav.
      if (ev.key === '[' || ev.key === ']') {
        const t = ev.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
        if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
        if (rotateSelected(ev, ev.key === ']' ? 1 : -1)) {
          ev.preventDefault();
          ev.stopPropagation();
        }
      }
      // Slide-along-channel — `,` and `.` (use ev.code so Shift+`,` (which the
      // browser reports as `<`) doesn't slip through). Same input-blocker /
      // nav-modifier rules as rotate-to-fit.
      if (ev.code === 'Comma' || ev.code === 'Period') {
        const t = ev.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
        if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
        if (slideSelected(ev, ev.code === 'Period' ? 1 : -1)) {
          ev.preventDefault();
          ev.stopPropagation();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);

    return () => {
      window.removeEventListener('keydown', onKeyDown);
      if (_markingToastTimer) clearTimeout(_markingToastTimer);
      // Flush any pending slide commit so the user doesn't lose unconfirmed
      // nudges when the viewport unmounts (route change, hot reload).
      if (_slideLive && _slideLive.commitTimer) {
        clearTimeout(_slideLive.commitTimer);
        try { _flushSlideCommit(); } catch (err) {
          console.warn('[slide-nudge] flush on dispose failed', err);
        }
        _slideLive = null;
      }
      // E4 — tear down rubber-band + marking menu + section + interference.
      try {
        viewport.renderer.domElement.removeEventListener('pointermove', onSnapPointerMove);
      } catch {}
      try { offSnapRender?.(); } catch {}
      try { snapIndicators.dispose(); } catch {}
      try { offSelectionPrune?.(); } catch {}
      try { offRotateSel?.(); } catch {}
      try { snapDrag?.dispose?.(); } catch {}
      try { transformGizmo?.dispose?.(); } catch {}
      try { dragGhost?.dispose?.(); } catch {}
      try { rubber?.dispose?.(); } catch {}
      try { lassoPaint?.dispose?.(); } catch {}
      try { marking?.dispose?.(); } catch {}
      try { clearInterference(); viewport.scene.remove(interferenceOverlay); } catch {}
      // Null out the runtime hooks so post-unmount palette runs no-op.
      studio.runInterference = null;
      studio.applyRollback = null;
      interferenceResults = null;
      // Drop any in-flight face-pick gesture before teardown.
      try { if (studio.facePickMode) studio.cancelFacePick(); } catch {}
      // Cancel any in-progress sketch first — the sketcher holds references
      // to the scene and DOM we're about to tear down.
      try { if (isSketchActive()) cancelSketch(); } catch {}
      offFirstFit?.();
      offDisplay?.();
      offRenderClear?.();
      offDoc?.();
      offThreadRender?.();
      offThreadDoc?.();
      try {
        viewport.scene.remove(cosmeticThreadOverlay);
        disposeThreadOverlay();
      } catch {}
      offError();
      studio.clearBoot();
      triad?.destroy?.();
      // Tear down interactive reference planes (DOM tooltip + listeners).
      try { offRefPlanesDoc?.(); } catch {}
      try { offRefPlanesSize?.(); } catch {}
      try { if (_refPlanesRaf) cancelAnimationFrame(_refPlanesRaf); } catch {}
      try { offRefPlanesPickSel?.(); } catch {}
      try { referencePlanes.dispose(); } catch {}
      try { sketchOverlay.dispose(); } catch {}
      try { offRefImages?.(); } catch {}
      // Drop every mounted reference-image plane: clear the doc-derived set so
      // the next sync removes them, then run one final sync against the now-
      // empty selection (the registry lives on scene.userData and would
      // otherwise leak across a viewport rebuild / hot reload).
      try {
        const reg = viewport.scene?.userData?.__refImages;
        if (reg && reg.size) {
          syncReferenceImages({ features: {}, featureOrder: [] }, viewport.scene);
        }
      } catch {}
      try { offConnectors(); } catch {}
      try { connectorOverlay.dispose(); } catch {}
      picking.dispose();
      bodyHighlight.dispose();
      cadControls.dispose();
      documentBoot.dispose();
      viewport.dispose();
    };
  });
</script>

<section
  class="relative flex-1 bg-background"
  style:cursor={studio.facePickMode ? 'crosshair' : null}
  ondragover={onLibraryDragOver}
  ondragleave={onLibraryDragLeave}
  ondrop={onLibraryDrop}
>
  <div bind:this={root} class="absolute inset-0"></div>

  <!--
    Top-center banner stack. All transient banners (kernel error, face-pick
    cue, isolation chip, interference chip) flow as siblings in a single
    vertical stack so they never collide. The always-visible kind-filter
    toolbar is the last visual child of the stack, so it pushes down
    naturally as banners appear above it.
  -->
  <div class="pointer-events-none absolute left-1/2 top-3 z-30 flex -translate-x-1/2 flex-col items-center gap-1.5">
    {#if kernelError}
      <div class={`pointer-events-auto max-w-sm rounded border px-3 py-2 text-xs text-foreground shadow-sm backdrop-blur-sm ${kernelOffline ? 'border-amber-500/40 bg-amber-500/15' : 'border-destructive/40 bg-destructive/15'}`}>
        <div class="flex items-center justify-between gap-3">
          <span class="font-medium">{kernelOffline ? '3D engine offline' : 'Kernel error'}</span>
          <button
            onclick={() => { kernelError = null; kernelOffline = false; }}
            class="text-foreground/60 hover:text-foreground"
            aria-label="Dismiss"
          >✕</button>
        </div>
        <div class="mt-0.5 break-words opacity-80">{kernelError}</div>
        <div class="mt-1 text-[10px] opacity-60">
          {kernelOffline ? 'Run the kernel server, then your edits will compile.' : 'Undo (Ctrl+Z) to revert the bad feature.'}
        </div>
      </div>
    {/if}

    {#if markingToast}
      <div class="pointer-events-auto max-w-sm rounded border border-border bg-card/95 px-3 py-1.5 text-xs text-foreground shadow-sm backdrop-blur-sm">
        {markingToast}
      </div>
    {/if}

    {#if studio.facePickMode}
      <div class="pointer-events-auto rounded border border-primary/40 bg-primary/15 px-3 py-1.5 text-xs text-foreground shadow-sm backdrop-blur-sm">
        <span class="font-medium">Click a face</span>
        <span class="opacity-70"> to {studio.facePickMode.purpose}. </span>
        <button
          type="button"
          class="ml-1 rounded border border-border bg-background/60 px-1.5 py-0.5 font-mono text-[10px] hover:bg-accent"
          onclick={() => studio.cancelFacePick()}
        >Esc</button>
      </div>
    {/if}

    {#if studio.isolatedFeatureIds && studio.isolatedFeatureIds.size > 0}
      <button
        type="button"
        class="pointer-events-auto rounded border border-primary/40 bg-primary/15 px-3 py-1 text-xs text-foreground shadow-sm backdrop-blur-sm hover:bg-primary/25"
        onclick={() => studio.clearIsolation()}
        title="Show all bodies (Ctrl+I to toggle)"
      >
        <span class="font-medium">Isolating:</span>
        <span class="font-mono"> {studio.isolatedFeatureIds.size} {studio.isolatedFeatureIds.size === 1 ? 'body' : 'bodies'}</span>
        <span class="ml-2 opacity-70">— Show all</span>
      </button>
    {/if}

    {#if interferenceResults}
      <button
        type="button"
        class="pointer-events-auto rounded border border-destructive/40 bg-destructive/15 px-3 py-1.5 text-xs text-foreground shadow-sm backdrop-blur-sm hover:bg-destructive/25"
        onclick={() => { interferenceResults = null; }}
        title="Click to clear interference highlight"
      >
        <span class="font-medium">Interference:</span>
        <span class="font-mono"> {interferenceResults.pairs} pairs</span>
        {#if interferenceResults.totalVolume > 0}
          <span class="opacity-70"> · {interferenceResults.totalVolume.toFixed(2)} mm³</span>
        {/if}
      </button>
    {/if}

    <!-- Always-visible kind-filter toolbar (Face/Edge/Vertex/Body/Sketch +
         All). Last visual child of the banner stack so any banners above
         push it down naturally. -->
    <div class="pointer-events-auto">
      <SelectionFilterToolbarMount {hasBodies} />
    </div>
  </div>

  {#if !kernelError && !hasBodies && !isSketchActive()}
    <div class="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded border border-border bg-card/90 px-4 py-3 text-center text-xs text-muted-foreground shadow-sm backdrop-blur-sm">
      <div class="font-medium text-foreground">Nothing here yet</div>
      <div class="mt-1 opacity-70">
        Describe what to build in the AI panel
        <span aria-hidden="true">→</span>
      </div>
      <div class="mt-1 text-[10px] opacity-50">
        or press <kbd class="rounded border border-border bg-muted px-1 py-0.5 font-mono text-[10px]">{modKeyLabel}K</kbd>
        for the command palette.
      </div>
    </div>
  {/if}

  <ViewCubeMount />
  <ViewportHudMount />
  <MeasureToolMount />

  <!-- Section view (Fusion-style "Section Analysis"). Sits between the
       ViewCube and the display-mode column at right-3. -->
  <SectionPlaneMount />

  <!-- Rotate-to-fit hint. Shows when a placed component is selected so the
       keyboard orientation gesture is discoverable. -->
  {#if selectedComponentId}
    <div class="pointer-events-none absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded border border-border bg-card/90 px-3 py-1 text-[11px] text-muted-foreground shadow-sm backdrop-blur-sm">
      Rotate to fit:
      <kbd class="mx-0.5 rounded border border-border bg-muted px-1 py-0.5 font-mono text-[10px]">[</kbd>
      <kbd class="mr-0.5 rounded border border-border bg-muted px-1 py-0.5 font-mono text-[10px]">]</kbd>
      <span class="opacity-70">90° · Shift = 15°</span>
    </div>
  {/if}

  <!-- Bottom-right: Fit-to-body only. Zoom in/out are dropped — scroll wheel
       (with zoom-to-cursor) handles dolly. -->
  <div class="absolute bottom-3 right-3 z-10 rounded border border-border bg-card/90 p-1 shadow-sm backdrop-blur-sm">
    <button title="Fit to body [F]" aria-label="Fit to body" onclick={() => studio.views?.fit()} class={BTN_BASE}>
      <Maximize2 class="size-4" />
    </button>
  </div>
</section>
