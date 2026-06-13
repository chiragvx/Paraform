<script>
  import { onMount } from 'svelte';
  import { getDocumentStore, getDocumentExecutor } from '../../../../lib/document/index.js';
  import { persistence } from '$lib/document/persistence.svelte.js';
  import { studio } from '$lib/studio/runtime.svelte.js';
  import { dfmStatus } from './inspector/DfmPanel.svelte';
  import { invariantStatus } from './inspector/InvariantsPanel.svelte';
  import { assumptionStatus } from './inspector/AssumptionsManifestPanel.svelte';

  let featureCount = $state(0);
  // True while one or more kernel compiles are in flight. Driven by the
  // executor's start/terminal events (executed/failed/stale/cancelled).
  let compiling = $state(false);

  function readFromStore(store) {
    featureCount = Object.keys(store.doc.features || {}).length;
  }

  onMount(() => {
    const store = getDocumentStore();
    readFromStore(store);
    const unsub = store.subscribe((_doc, _evt, s) => readFromStore(s));

    // Track in-flight kernel compiles. The executor fires a `start` event per
    // run and exactly one terminal event (executed/failed/stale/cancelled).
    const executor = getDocumentExecutor();
    let inFlight = 0;
    const offExec = executor.subscribe((evt) => {
      if (evt.type === 'start') inFlight++;
      else if (evt.type === 'executed' || evt.type === 'failed'
            || evt.type === 'stale' || evt.type === 'cancelled') {
        inFlight = Math.max(0, inFlight - 1);
      }
      compiling = inFlight > 0;
    });

    return () => { unsub?.(); offExec?.(); };
  });

  // Show whichever build123d the live kernel reports. Falls back gracefully
  // when bridge isn't booted (e.g. on non-Studio routes).
  let kernelLabel = $derived.by(() => {
    const v = studio.bridge?.lastKernelVersion;
    if (!v) return null;
    const b = v.build123d || 'unknown';
    return `b123d ${b}`;
  });

  let saveLabel = $derived.by(() => {
    switch (persistence.status) {
      case 'saved':   return 'Saved';
      case 'pending': return 'Saving…';
      case 'error':   return 'Save failed';
      default:        return 'Unsaved';
    }
  });

  let saveDotClass = $derived.by(() => {
    switch (persistence.status) {
      case 'saved':   return 'bg-emerald-500';
      case 'pending': return 'bg-amber-400 animate-pulse';
      case 'error':   return 'bg-destructive';
      default:        return 'bg-muted-foreground/40';
    }
  });
</script>

<footer class="flex h-6 shrink-0 items-center gap-3 border-t border-border bg-card px-3 text-xs text-muted-foreground">
  <span class="flex items-center gap-1.5">
    <span class={`size-1.5 rounded-full ${saveDotClass}`}></span>
    {saveLabel}
  </span>
  <span class="opacity-30">|</span>
  <span>{featureCount} feature{featureCount === 1 ? '' : 's'}</span>

  {#if compiling}
    <span class="opacity-30">|</span>
    <span class="flex items-center gap-1.5">
      <span class="size-1.5 rounded-full bg-sky-400 animate-pulse"></span>
      Compiling…
    </span>
  {/if}

  {#if persistence.mismatchWarning}
    <span class="opacity-30">|</span>
    <span
      class="rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-700 dark:text-amber-300"
      title={`Document was saved against build123d ${persistence.mismatchWarning.restored}; current kernel is ${persistence.mismatchWarning.current}. Rebuild may differ.`}
    >
      ⚠ kernel mismatch
    </span>
  {/if}

  {#if dfmStatus.errorCount > 0 || dfmStatus.warningCount > 0}
    <span class="opacity-30">|</span>
    <span
      class="rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-700 dark:text-amber-300"
      title={`${dfmStatus.errorCount} errors, ${dfmStatus.warningCount} warnings (${dfmStatus.profileId ?? ''})`}
    >
      ⚠ {dfmStatus.errorCount + dfmStatus.warningCount} DFM
    </span>
  {/if}

  {#if invariantStatus.errorCount > 0 || invariantStatus.warningCount > 0}
    <span class="opacity-30">|</span>
    <span
      class="rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-700 dark:text-amber-300"
      title={`${invariantStatus.errorCount} errors, ${invariantStatus.warningCount} warnings`}
    >
      ⚠ {invariantStatus.errorCount + invariantStatus.warningCount} INV
    </span>
  {/if}

  {#if assumptionStatus.unacknowledged > 0}
    <span class="opacity-30">|</span>
    <span
      class={`rounded border px-1.5 py-0.5 text-[10px] ${assumptionStatus.maxSeverity === 'warning'
        ? 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300'
        : 'border-border bg-muted/30 text-muted-foreground'}`}
      title={`${assumptionStatus.unacknowledged} unacknowledged assumption${assumptionStatus.unacknowledged === 1 ? '' : 's'}`}
    >
      {assumptionStatus.maxSeverity === 'warning' ? '⚠' : '·'} {assumptionStatus.unacknowledged} ASM
    </span>
  {/if}

  {#if kernelLabel}
    <span class="ml-auto font-mono opacity-70">{kernelLabel}</span>
    <span class="opacity-30">·</span>
    <span class="font-mono">mm · Z-up</span>
  {:else}
    <span class="ml-auto font-mono">mm · Z-up</span>
  {/if}
</footer>
