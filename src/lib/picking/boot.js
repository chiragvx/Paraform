import { PickProxyLayer } from '../../../lib/picking/pick_proxies.js';
import { getPickingSelection } from '../../../lib/picking/selection.js';
import { PickingOverlay } from '../../../app/picking/overlay.js';
import { FaceHighlightOverlay } from '../../../app/picking/face_overlay.js';
import { attachPicking } from '../../../app/picking/wiring.js';
import { stringify as descriptorKey } from '../../../lib/document/descriptor.js';

/**
 * Boots the picking stack against an already-running viewport + bridge.
 *
 * Layers:
 *   - PickProxyLayer:  invisible per-face / fat-tube per-edge meshes; the
 *     raycaster targets these for exact, kernel-true descriptor hits. Lives
 *     at scene identity (NOT under bridge's GLB wrap — see CLAUDE.md).
 *   - PickingOverlay:  visible hover disc/bar at the picked centre.
 *   - PickingSelection: app-wide singleton selection state.
 *
 * The wiring also relays each pick through `onPick` so the caller can sync
 * to the DocumentStore (e.g. select the owning feature in the sidebar).
 */
export function bootPicking({
  scene,
  camera,
  renderer,
  controls,
  bridge,
  isPickingActive = () => true,
  onHoverChange = null,
  onPick = null,
  onComponentPick = null,
} = {}) {
  if (!scene || !camera || !renderer) throw new Error('bootPicking: scene/camera/renderer required');
  if (!bridge) throw new Error('bootPicking: bridge required');

  const pickProxies = new PickProxyLayer({ scene });
  const overlay = new PickingOverlay({ scene, bodyGroup: bridge.bodyTransform });
  // Face-conforming hover/select tint + hover dimension tooltip. The tint
  // (showHover) is driven via onHoverChange below; the tooltip near the
  // cursor is driven by a pointermove listener so we have access to the
  // raw clientX/clientY without re-routing through the picker.
  const faceOverlay = new FaceHighlightOverlay({ scene, bodyGroup: bridge.bodyTransform, renderer });
  const selection = getPickingSelection();

  // ── Screen-space edge pick radius ────────────────────────────────────
  // Recompute the world-space tube radius from the current camera zoom /
  // distance so the effective pick width stays ~6 px on screen at any
  // zoom level. The pick-proxy layer debounces internally so this is
  // cheap to call on every 'change' event from CADCameraControls.
  function syncEdgePickRadius() {
    if (!pickProxies || typeof pickProxies.updateScreenSpaceRadius !== 'function') return;
    const h = renderer?.domElement?.clientHeight || 1;
    const target = controls?.target;
    try { pickProxies.updateScreenSpaceRadius(camera, h, target); } catch {}
  }

  // Bridge's geometry blob lands on every successful kernel regen. Rebuild
  // proxies + tell the overlay where to sit relative to the body group.
  const offRender = bridge.onRender(() => {
    pickProxies.setGeometry(bridge.geometry);
    overlay.setBodyGroup?.(bridge.bodyTransform);
    faceOverlay.setBodyGroup?.(bridge.bodyTransform);
    faceOverlay.setGeometry?.(bridge.geometry);
    // Apply current camera state to freshly built tubes.
    syncEdgePickRadius();
  });
  // Initial seed in case geometry already landed before we hooked up.
  if (bridge.geometry) {
    pickProxies.setGeometry(bridge.geometry);
    faceOverlay.setGeometry(bridge.geometry);
  }
  syncEdgePickRadius();

  // Optimistic proxy prune — the bridge removes the VISIBLE mesh of a deleted
  // feature synchronously (`_pruneOrphanMeshes`), but the invisible pick
  // proxies otherwise survive until the next kernel regen fires `onRender`
  // above. On a no-kernel / empty-doc / debounce-window delete that left the
  // raycaster still hitting "ghost" faces of geometry the user already
  // deleted. Mirror the mesh prune here so picking stays 1:1 with the doc.
  let offStore = null;
  try {
    if (bridge.store && typeof bridge.store.subscribe === 'function') {
      offStore = bridge.store.subscribe((doc, eventLabel) => {
        if (eventLabel === 'select' || eventLabel === 'refs') return;
        try {
          const ids = new Set(Object.keys((doc && doc.features) || {}));
          if (pickProxies.pruneOrphans(ids) > 0) faceOverlay.clearHover?.();
        } catch { /* prune must never break the picking stack */ }
      });
    }
  } catch { /* no store — headless/test */ }

  // Subscribe to controls 'change' (CADCameraControls emits this on every
  // orbit/pan/zoom step). updateScreenSpaceRadius is internally debounced
  // by a fractional-change threshold, so we don't need to throttle here.
  let offControlsChange = null;
  try {
    if (controls && typeof controls.addEventListener === 'function') {
      controls.addEventListener('change', syncEdgePickRadius);
      offControlsChange = () => {
        try { controls.removeEventListener('change', syncEdgePickRadius); } catch {}
      };
    }
  } catch {}

  // Tooltip + face/edge tint follow the picker's onHoverChange. We compose
  // with the caller's own onHoverChange so existing wiring (hoverInfo in
  // Viewport.svelte) still receives the pick.
  const userHover = typeof onHoverChange === 'function' ? onHoverChange : null;
  const composedHover = (pick) => {
    if (!pick || !pick.descriptor) {
      faceOverlay.clearHover();
    } else if (pick.descriptor.kind === 'face' || pick.descriptor.kind === 'edge') {
      try {
        const key = descriptorKey(pick.descriptor);
        faceOverlay.showHover(key, pick.descriptor.kind);
      } catch { faceOverlay.clearHover(); }
    } else {
      faceOverlay.clearHover();
    }
    if (userHover) try { userHover(pick); } catch {}
  };

  // Tooltip-near-cursor follows the pointer. The overlay reads its own
  // _hoverKey/_hoverKind set above by showHover().
  const canvas = renderer.domElement;
  const onTooltipMove = (ev) => {
    try { faceOverlay.updateTooltipAt({ clientX: ev.clientX, clientY: ev.clientY }); } catch {}
  };
  const onTooltipLeave = () => {
    try { faceOverlay.updateTooltipAt(null); } catch {}
  };
  canvas.addEventListener('pointermove', onTooltipMove);
  canvas.addEventListener('pointerleave', onTooltipLeave);

  // attachPicking installs pointer listeners on renderer.domElement and
  // returns its own detach.
  const detach = attachPicking({
    viewport: { renderer, camera, scene, controls },
    bridge,
    selection,
    overlay,
    pickProxies,
    isPickingActive,
    onHoverChange: composedHover,
    onComponentPick,
  });

  // Bridge selection events back to caller. Selection emits on add/remove/clear.
  const offSelection = onPick
    ? selection.subscribe((evt) => onPick(evt))
    : null;

  return {
    pickProxies,
    overlay,
    faceOverlay,
    selection,
    dispose() {
      detach?.();
      offRender?.();
      offSelection?.();
      offStore?.();
      offControlsChange?.();
      try { canvas.removeEventListener('pointermove', onTooltipMove); } catch {}
      try { canvas.removeEventListener('pointerleave', onTooltipLeave); } catch {}
      pickProxies.dispose?.();
      overlay.dispose?.();
      faceOverlay.dispose?.();
    },
  };
}
