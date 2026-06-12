<script module>
  /**
   * Shared assumption count signal — consumed by StatusBar to render
   * the chip. Same pattern as dfmStatus / invariantStatus.
   */
  export const assumptionStatus = $state({
    total: 0,
    unacknowledged: 0,
    maxSeverity: 'info',  // 'info' | 'warning'
  });
</script>

<script>
  import { onMount } from 'svelte';
  import {
    getDocumentStore,
    acknowledgeAssumption,
    removeAssumption,
    clearAssumptions,
  } from '../../../../../lib/document/index.js';
  import {
    exportAssumptionsManifest,
    defaultManifestFilename,
    ASSUMPTION_SOURCES,
  } from '$lib/document/assumptions_manifest.js';

  import Funnel from '@lucide/svelte/icons/funnel';
  import CircleCheck from '@lucide/svelte/icons/circle-check';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import CloudUpload from '@lucide/svelte/icons/cloud-upload';
  import FileCode from '@lucide/svelte/icons/file-code';
  import Ellipsis from '@lucide/svelte/icons/ellipsis';

  let assumptions = $state([]);
  let activeSource = $state('all');

  function readFromStore(store) {
    assumptions = Array.isArray(store.doc.assumptions) ? store.doc.assumptions.slice() : [];
  }

  onMount(() => {
    const store = getDocumentStore();
    readFromStore(store);
    return store.subscribe((_doc, _evt, s) => readFromStore(s));
  });

  // Push aggregate counts into the status singleton.
  $effect(() => {
    const total = assumptions.length;
    const unacked = assumptions.filter(a => !a.acknowledged).length;
    const hasWarn = assumptions.some(a => !a.acknowledged && a.severity === 'warning');
    assumptionStatus.total = total;
    assumptionStatus.unacknowledged = unacked;
    assumptionStatus.maxSeverity = hasWarn ? 'warning' : 'info';
  });

  const filtered = $derived.by(() => {
    if (activeSource === 'all') return assumptions;
    return assumptions.filter(a => a.source === activeSource);
  });

  const sourceCounts = $derived.by(() => {
    const m = { all: assumptions.length };
    for (const s of ASSUMPTION_SOURCES) m[s] = 0;
    for (const a of assumptions) {
      const s = a.source || 'user';
      m[s] = (m[s] || 0) + 1;
    }
    return m;
  });

  function onAcknowledge(id) { acknowledgeAssumption(id, true); }
  function onUnacknowledge(id) { acknowledgeAssumption(id, false); }
  function onRemove(id) { removeAssumption(id); }

  function onAcknowledgeAll() {
    for (const a of filtered) {
      if (!a.acknowledged) acknowledgeAssumption(a.id, true);
    }
  }

  function onJumpTo(featureId) {
    if (!featureId) return;
    const store = getDocumentStore();
    if (typeof store.selectFeature === 'function') store.selectFeature(featureId);
  }

  function onExport() {
    const store = getDocumentStore();
    const md = exportAssumptionsManifest(assumptions, {
      title: `${store.doc.metadata?.title || 'Document'} — Assumptions manifest`,
    });
    if (typeof document === 'undefined' || typeof Blob === 'undefined') return;
    const blob = new Blob([md], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = defaultManifestFilename(store.doc.metadata?.title || 'document');
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function sourceLabel(s) {
    if (s === 'standard-parts') return 'parts';
    return s;
  }

  function chipColor(a) {
    if (a.acknowledged) return 'text-emerald-500';
    if (a.severity === 'warning') return 'text-amber-500';
    return 'text-muted-foreground';
  }
</script>

<div class="space-y-2 text-xs">
  <div class="flex items-center justify-between">
    <span class="text-[10px] uppercase tracking-wider text-muted-foreground">Assumptions manifest</span>
    {#if assumptionStatus.unacknowledged > 0}
      <span class="text-[10px] text-amber-600 dark:text-amber-400">
        {assumptionStatus.unacknowledged} pending
      </span>
    {:else if assumptionStatus.total > 0}
      <span class="text-[10px] text-emerald-500">All acknowledged</span>
    {:else}
      <span class="text-[10px] text-muted-foreground">No assumptions</span>
    {/if}
  </div>

  <!-- Source filter -->
  <div class="flex flex-wrap items-center gap-1 text-[10px]">
    <Funnel class="size-3 text-muted-foreground" />
    {#each ['all', ...ASSUMPTION_SOURCES] as src (src)}
      <button
        type="button"
        class="rounded border border-border px-1.5 py-0.5 hover:bg-accent/40"
        class:bg-accent={activeSource === src}
        class:text-foreground={activeSource === src}
        onclick={() => (activeSource = src)}
      >
        {sourceLabel(src)} <span class="opacity-60">{sourceCounts[src] || 0}</span>
      </button>
    {/each}
  </div>

  <!-- Bulk actions -->
  <div class="flex gap-1">
    <button
      type="button"
      class="flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10px] hover:bg-accent/40"
      disabled={filtered.length === 0}
      onclick={onAcknowledgeAll}
      title="Acknowledge all visible assumptions"
    >
      <CircleCheck class="size-3" /> Acknowledge all
    </button>
    <button
      type="button"
      class="flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10px] hover:bg-accent/40"
      disabled={assumptions.length === 0}
      onclick={onExport}
      title="Download a markdown manifest of every assumption"
    >
      <CloudUpload class="size-3" /> Export manifest
    </button>
  </div>

  {#if filtered.length === 0}
    <div class="text-center text-muted-foreground/60">
      {activeSource === 'all'
        ? 'No assumptions recorded yet.'
        : 'No assumptions from this source.'}
    </div>
  {:else}
    {#each filtered as a (a.id)}
      <div class="rounded border border-border bg-card/40 p-2">
        <div class="flex items-start gap-2">
          {#if a.severity === 'warning' && !a.acknowledged}
            <TriangleAlert class={`mt-0.5 size-3.5 shrink-0 ${chipColor(a)}`} />
          {:else if a.acknowledged}
            <CircleCheck class={`mt-0.5 size-3.5 shrink-0 ${chipColor(a)}`} />
          {:else}
            <Ellipsis class={`mt-0.5 size-3.5 shrink-0 ${chipColor(a)}`} />
          {/if}
          <div class="min-w-0 flex-1">
            <div class="flex items-center justify-between gap-2">
              <span class="truncate font-medium">{a.kind}</span>
              <span class="shrink-0 rounded bg-muted/40 px-1 text-[10px] text-muted-foreground">{sourceLabel(a.source)}</span>
            </div>
            {#if a.detail}
              <div class="mt-0.5 text-[10px] text-muted-foreground">{a.detail}</div>
            {/if}
            {#if a.defaultUsed != null}
              <div class="mt-0.5 text-[10px] text-primary">
                Default: <span class="font-mono">{String(a.defaultUsed)}</span>
                {#if Array.isArray(a.alternatives) && a.alternatives.length}
                  <span class="opacity-60"> (alts: {a.alternatives.join(', ')})</span>
                {/if}
              </div>
            {/if}
            {#if a.citation}
              <div class="mt-0.5 text-[10px] italic text-muted-foreground/60">— {a.citation}</div>
            {/if}
            <div class="mt-1 flex flex-wrap items-center gap-1">
              {#if a.acknowledged}
                <button
                  type="button"
                  class="rounded border border-border px-1.5 py-0.5 text-[10px] hover:bg-accent/40"
                  onclick={() => onUnacknowledge(a.id)}
                >Un-acknowledge</button>
              {:else}
                <button
                  type="button"
                  class="rounded border border-border bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-700 hover:bg-emerald-500/20 dark:text-emerald-300"
                  onclick={() => onAcknowledge(a.id)}
                >Acknowledge</button>
              {/if}
              {#if a.relatedFeatureId}
                <button
                  type="button"
                  class="flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10px] hover:bg-accent/40"
                  onclick={() => onJumpTo(a.relatedFeatureId)}
                  title="Select related feature"
                >
                  <FileCode class="size-3" /> Jump
                </button>
              {/if}
              <button
                type="button"
                class="ml-auto rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                onclick={() => onRemove(a.id)}
              >Remove</button>
            </div>
          </div>
        </div>
      </div>
    {/each}
  {/if}
</div>
