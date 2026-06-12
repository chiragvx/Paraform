<script>
  /**
   * SectionPlaneMount — HUD wrapper for the SectionPlane manipulator.
   *
   * Mirrors ViewCubeMount.svelte's lifecycle pattern: poll until the
   * viewport is available, instantiate the imperative class, then drive
   * it from a small toolbar. The toolbar lives in the top-right of the
   * viewport, just below the ViewCube row, so it doesn't collide with the
   * 110×110 cube widget at `right-3 top-3`.
   *
   * Buttons:
   *   - Toggle on/off
   *   - Flip normal
   *   - Reset (back to +Z, offset 0)
   *   - Align to selected face (enabled only when a face descriptor is selected
   *     and its payload carries a center + normal)
   *
   * The mount also installs `renderer.localClippingEnabled = true` and
   * pushes the SectionPlane's `THREE.Plane` onto `renderer.clippingPlanes`
   * exactly once — disabling the section reverts the renderer flags.
   */

  import { onMount } from 'svelte';
  import { studio } from '$lib/studio/runtime.svelte.js';
  import { getPickingSelection } from '../../../../lib/picking/selection.js';
  import { SectionPlane } from '../../../../lib/viewport/section_plane.js';
  import Scissors from '@lucide/svelte/icons/scissors';
  import FlipVertical2 from '@lucide/svelte/icons/flip-vertical-2';
  import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
  import AlignVerticalSpaceAround from '@lucide/svelte/icons/align-vertical-space-around';

  let host;
  let enabled = $state(false);
  let canAlign = $state(false);

  let section = null;
  let unsubSel = null;
  let unsubBridge = null;
  let pollId = 0;

  function refreshAlignAvailability() {
    try {
      const sel = getPickingSelection();
      const arr = sel.toArray();
      for (const entry of arr) {
        const d = entry?.descriptor;
        const p = entry?.payload;
        if (d?.kind === 'face' && Array.isArray(p?.center) && Array.isArray(p?.normal)) {
          canAlign = true;
          return;
        }
      }
      canAlign = false;
    } catch {
      canAlign = false;
    }
  }

  function toggle() {
    if (!section) return;
    enabled = !enabled;
    section.setEnabled(enabled);
    syncClipping();
  }

  function flip() {
    if (!section) return;
    section.flipNormal();
  }

  function reset() {
    if (!section) return;
    section.reset();
  }

  function alignToFace() {
    if (!section) return;
    try {
      const sel = getPickingSelection();
      for (const entry of sel.toArray()) {
        const d = entry?.descriptor;
        const p = entry?.payload;
        if (d?.kind === 'face' && Array.isArray(p?.center) && Array.isArray(p?.normal)) {
          section.alignToFace({ point: p.center, normal: p.normal });
          if (!enabled) {
            enabled = true;
            section.setEnabled(true);
            syncClipping();
          }
          return;
        }
      }
    } catch (err) {
      console.warn('[SectionPlaneMount] alignToFace failed', err);
    }
  }

  function syncClipping() {
    const v = studio.viewport;
    if (!v?.renderer || !section) return;
    if (enabled) {
      v.renderer.localClippingEnabled = true;
      // Replace our own entry while preserving anything else the host
      // might have already pushed.
      const others = (v.renderer.clippingPlanes || []).filter((p) => p !== section.plane);
      v.renderer.clippingPlanes = [...others, section.plane];
    } else {
      v.renderer.clippingPlanes = (v.renderer.clippingPlanes || []).filter((p) => p !== section.plane);
      if (v.renderer.clippingPlanes.length === 0) {
        v.renderer.localClippingEnabled = false;
      }
    }
  }

  onMount(() => {
    const startedAt = performance.now();

    function attach() {
      const v = studio.viewport;
      if (!v?.scene || !v?.camera || !v?.renderer) return false;
      try {
        section = new SectionPlane({
          scene: v.scene,
          camera: v.camera,
          renderer: v.renderer,
          cameraControls: v.controls,
          bodyRoot: () => studio.bridge?.bodyTransform || null,
          onChange: () => { /* render loop is rAF-driven; no-op */ },
        });
      } catch (err) {
        console.warn('[SectionPlaneMount] failed to construct SectionPlane:', err);
        return true; // give up
      }
      // Watch the picking selection so the "Align to face" button enables.
      try {
        const sel = getPickingSelection();
        unsubSel = sel.subscribe(() => refreshAlignAvailability());
        refreshAlignAvailability();
      } catch {}
      // Rebuild the back-cap mirror whenever the kernel re-emits bodies
      // (the bodyTransform group's children are swapped wholesale on each
      // regen, so cached mesh refs go stale).
      try {
        const bridge = studio.bridge;
        if (bridge && typeof bridge.onRender === 'function') {
          unsubBridge = bridge.onRender(() => {
            try { section && enabled && section.refreshCap?.(); } catch {}
          });
        }
      } catch {}
      // Expose a hook so palette commands ("Section view…") can flip us on.
      studio.toggleSection = () => toggle();
      // Back-compat alias — palette + tests dispatch through startSection.
      studio.startSection = () => toggle();
      studio.sectionPlane = section;
      studio.sectionFlip = () => flip();
      studio.sectionReset = () => reset();
      studio.sectionAlignToSelectedFace = () => alignToFace();
      return true;
    }

    function tick() {
      if (attach()) return;
      if (performance.now() - startedAt > 1500) return;
      pollId = requestAnimationFrame(tick);
    }
    pollId = requestAnimationFrame(tick);

    return () => {
      if (pollId) cancelAnimationFrame(pollId);
      try { unsubSel?.(); } catch {}
      try { unsubBridge?.(); } catch {}
      try {
        if (section) {
          enabled = false;
          syncClipping();
          section.dispose();
        }
      } catch {}
      section = null;
      try {
        if (studio.toggleSection) studio.toggleSection = null;
        if (studio.startSection) studio.startSection = null;
        if (studio.sectionPlane) studio.sectionPlane = null;
        if (studio.sectionFlip) studio.sectionFlip = null;
        if (studio.sectionReset) studio.sectionReset = null;
        if (studio.sectionAlignToSelectedFace) studio.sectionAlignToSelectedFace = null;
      } catch {}
    };
  });
</script>

<!--
  No HUD chrome — Section is invoked from the main Toolbar / palette
  (view.section.activate, section.flip, section.reset, section.alignToFace).
  This mount exists only to instantiate the 3D SectionPlane gizmo and
  expose studio.toggleSection / studio.sectionPlane / studio.sectionFlip /
  studio.sectionReset / studio.sectionAlignToSelectedFace.
-->
<div bind:this={host} style="display:none" aria-hidden="true"></div>
