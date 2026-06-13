<script>
  import Hexagon from '@lucide/svelte/icons/hexagon';
  import { studio } from '$lib/studio/runtime.svelte.js';

  let dismissed = $state(false);
  let hidden = $state(false);
  let status = $state('Initializing CAD engine…');

  // Status copy progression — three beats so the loader feels alive even when
  // the kernel is the slow link. The fallback below ensures we never sit here
  // forever even if the bridge never delivers its first render. The floor is
  // intentionally short: for an empty/fresh doc there's no compile to wait on,
  // and the studio underneath is already interactive — a long splash just
  // masks a ready editor.
  $effect(() => {
    const t1 = setTimeout(() => { if (!dismissed) status = 'Restoring document…'; }, 350);
    const t2 = setTimeout(() => { if (!dismissed) status = 'Loading viewport…'; }, 700);
    const fallback = setTimeout(() => { dismissed = true; }, 1000);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(fallback);
    };
  });

  // Watch for the bridge to come online, then dismiss on whichever lands first:
  // the first render (geometry arrived) OR a kernel error (offline / mock /
  // failed compile). Without the error path the splash would otherwise sit for
  // the full fallback window whenever the kernel is unreachable, even though
  // the studio is interactive and the error banner is already showing.
  $effect(() => {
    const bridge = studio.bridge;
    if (!bridge || typeof bridge.onRender !== 'function') return;
    let offRender = null;
    let offError = null;
    const done = () => {
      dismissed = true;
      if (offRender) { offRender(); offRender = null; }
      if (offError) { offError(); offError = null; }
    };
    offRender = bridge.onRender(done);
    if (typeof bridge.onError === 'function') offError = bridge.onError(done);
    return () => { if (offRender) offRender(); if (offError) offError(); };
  });

  // After the fade transition completes, drop the node out of the tree.
  $effect(() => {
    if (!dismissed) return;
    const t = setTimeout(() => { hidden = true; }, 320);
    return () => clearTimeout(t);
  });
</script>

{#if !hidden}
  <div
    class="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-background transition-opacity duration-300"
    class:opacity-0={dismissed}
    class:pointer-events-none={dismissed}
    aria-hidden={dismissed}
  >
    <Hexagon class="size-12 text-primary" />
    <div class="mt-3 text-2xl font-semibold tracking-tight">ParaForm</div>
    <div class="mt-6 h-1 w-48 overflow-hidden rounded-full bg-muted">
      <div class="h-full w-full animate-pulse bg-primary/70"></div>
    </div>
    <div class="mt-3 text-xs text-muted-foreground">{status}</div>
  </div>
{/if}
