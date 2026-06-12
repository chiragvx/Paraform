<script>
  import Hexagon from '@lucide/svelte/icons/hexagon';
  import { studio } from '$lib/studio/runtime.svelte.js';

  let dismissed = $state(false);
  let hidden = $state(false);
  let status = $state('Initializing CAD engine…');

  // Status copy progression — three beats so the loader feels alive even when
  // the kernel is the slow link. The 3s fallback below ensures we never sit
  // here forever even if the bridge never delivers its first render.
  $effect(() => {
    const t1 = setTimeout(() => { if (!dismissed) status = 'Restoring document…'; }, 600);
    const t2 = setTimeout(() => { if (!dismissed) status = 'Loading viewport…'; }, 1200);
    const fallback = setTimeout(() => { dismissed = true; }, 3000);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(fallback);
    };
  });

  // Watch for the bridge to come online, then subscribe to its first render.
  $effect(() => {
    const bridge = studio.bridge;
    if (!bridge || typeof bridge.onRender !== 'function') return;
    let unsub = null;
    unsub = bridge.onRender(() => {
      dismissed = true;
      if (unsub) { unsub(); unsub = null; }
    });
    return () => { if (unsub) unsub(); };
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
