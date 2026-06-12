<script>
  /**
   * ViewportHudMount — wraps the imperative ViewportHud (live cursor XYZ,
   * units, FPS, selection count) and installs it into the viewport host.
   *
   * Distinct from the existing bottom-bar `ViewportHud.svelte` which sits
   * across the viewport floor and tracks tri/render/compile metrics. The
   * imperative HUD here is a compact corner overlay; the two are
   * complementary.
   *
   * Anchored bottom-right of the viewport, lifted above the zoom cluster
   * so they don't overlap.
   */
  import { onMount } from 'svelte';
  import { studio } from '$lib/studio/runtime.svelte.js';
  import { getPickingSelection } from '../../../../lib/picking/selection.js';
  import { ViewportHud } from '../../../../app/viewport/viewport_hud.js';
  import { units } from '$lib/units/units.svelte.js';

  let host;
  let hud = null;

  onMount(() => {
    let cancelled = false;
    const start = performance.now();
    let pollId = 0;

    function attach() {
      const viewport = studio.viewport;
      if (!viewport || !viewport.renderer || !viewport.camera) return false;
      const selection = getPickingSelection();
      const pickProxies = studio.viewport.pickProxies || null;
      hud = new ViewportHud({
        host,
        viewport,
        pickProxies,
        selection,
        getUnitLabel: () => units.unit,
      });
      return true;
    }

    function tick() {
      if (cancelled) return;
      if (attach()) return;
      if (performance.now() - start > 3000) return;
      pollId = requestAnimationFrame(tick);
    }
    pollId = requestAnimationFrame(tick);

    return () => {
      cancelled = true;
      cancelAnimationFrame(pollId);
      try { hud?.dispose(); } catch {}
      hud = null;
    };
  });
</script>

<div bind:this={host} class="pointer-events-none absolute inset-0"></div>
