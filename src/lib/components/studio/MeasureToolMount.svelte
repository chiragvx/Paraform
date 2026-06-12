<script>
  /**
   * MeasureToolMount — wraps the imperative MeasureTool (two-click distance /
   * single-pick length-area-bbox measurement) and wires it into the studio
   * runtime.
   *
   * Installs:
   *   - studio.startMeasure  — toggles the tool on/off. Fired by the Ruler
   *     toolbar button, the `M` key, the marking-menu N wedge (tools.measure),
   *     and the command palette.
   *   - studio.measureToolActive — true while armed. Viewport.svelte reads it
   *     to suppress rubber-band / lasso / paint selection and to show snap
   *     indicators.
   *
   * Anchored as a full-bleed overlay; the MeasureTool builds its own floating
   * result panel inside this host. Pointer wiring + scene overlays are owned
   * by the MeasureTool itself.
   */
  import { onMount } from 'svelte';
  import { studio } from '$lib/studio/runtime.svelte.js';
  import { MeasureTool } from '../../../../app/viewport/measure_tool.js';
  import { isSketchActive } from '$lib/sketch/boot.js';

  let host;
  let tool = null;

  onMount(() => {
    let cancelled = false;
    const start = performance.now();
    let pollId = 0;

    function attach() {
      const viewport = studio.viewport;
      if (!viewport || !viewport.renderer || !viewport.camera || !viewport.scene) return false;
      try {
        tool = new MeasureTool({
          scene: viewport.scene,
          camera: viewport.camera,
          renderer: viewport.renderer,
          pickProxies: viewport.pickProxies || null,
          host,
          // Don't measure while a sketch is being edited or a face-pick
          // gesture is armed — those gestures own the canvas clicks.
          suppressWhile: () => isSketchActive() || !!studio.facePickMode,
        });
      } catch (err) {
        console.error('[measure] MeasureTool construction failed:', err);
        return true; // stop polling — construction won't succeed on retry
      }

      // Install the activator hook. Toggles the tool and keeps the reactive
      // `measureToolActive` flag in lock-step so Viewport.svelte's effects fire.
      studio.startMeasure = () => {
        if (!tool) return;
        const next = !tool.enabled;
        tool.setEnabled(next);
        studio.measureToolActive = next;
      };
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
      if (studio.startMeasure) studio.startMeasure = null;
      studio.measureToolActive = false;
      try { tool?.dispose(); } catch {}
      tool = null;
    };
  });
</script>

<div bind:this={host} class="pointer-events-none absolute inset-0"></div>
