<script>
  /**
   * E6.5 — Timeline scrub / rollback head marker.
   *
   * Horizontal slider whose stops are the doc.featureOrder positions; dragging
   * the thumb sets studio.rollbackHead to the feature id at that position
   * (non-destructive — emit + render hide everything past it). Drag to the
   * far right to clear (no rollback).
   */
  import { onMount } from 'svelte';
  import { getDocumentStore } from '../../../../lib/document/index.js';
  import { studio } from '$lib/studio/runtime.svelte.js';
  import { clampRollbackHead } from '$lib/document/rollback.js';

  let order = $state([]);
  let head = $state(null);
  let store = null;

  // Slider index. Range: 0..N (N = no rollback / all features visible).
  // value === order.length means rollbackHead = null.
  let idx = $state(0);

  function refresh() {
    if (!store) return;
    const doc = store.doc;
    order = doc?.featureOrder ? [...doc.featureOrder] : [];
    head = clampRollbackHead(doc, studio.rollbackHead);
    if (head) {
      const i = order.indexOf(head);
      idx = i >= 0 ? i + 1 : order.length; // +1 = features 0..i visible
    } else {
      idx = order.length;
    }
  }

  onMount(() => {
    store = getDocumentStore();
    refresh();
    const off = store.subscribe(() => refresh());
    return off;
  });

  $effect(() => {
    const _ = studio.rollbackHead;
    refresh();
  });

  function onInput(ev) {
    const n = Number(ev.target.value);
    idx = n;
    if (n >= order.length) {
      studio.rollbackHead = null;
    } else {
      studio.rollbackHead = order[n] || null;
    }
    try { studio.applyRollback?.(); } catch {}
  }

  function clear() {
    studio.rollbackHead = null;
    idx = order.length;
    try { studio.applyRollback?.(); } catch {}
  }
</script>

{#if order.length > 0}
  <div class="flex items-center gap-2 border-b border-border bg-card/40 px-3 py-1.5 text-[11px]">
    <span class="shrink-0 text-muted-foreground" title="Drag to roll back the model history non-destructively">
      Roll:
    </span>
    <input
      type="range"
      min="0"
      max={order.length}
      step="1"
      bind:value={idx}
      oninput={onInput}
      class="flex-1 accent-primary"
      title={head ? `Rolled back to: ${head}` : 'No rollback (all features visible)'}
    />
    <span class="w-12 shrink-0 text-right font-mono text-muted-foreground">
      {idx}/{order.length}
    </span>
    {#if head}
      <button
        type="button"
        onclick={clear}
        class="shrink-0 rounded border border-border bg-background px-1.5 py-0.5 text-[10px] hover:bg-accent"
        title="Clear rollback (show all)"
      >Clear</button>
    {/if}
  </div>
{/if}
