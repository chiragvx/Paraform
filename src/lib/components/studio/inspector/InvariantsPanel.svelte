<script module>
  /**
   * Shared invariant signal — read by StatusBar to render the chip.
   *
   * Mirrors the pattern used by DfmPanel's `dfmStatus`: a singleton reactive
   * object exported from a <script module> block. The panel writes; the
   * StatusBar subscribes via $effect.
   *
   * lastRunAt: ms timestamp of the latest successful runner invocation.
   * 0 means "never ran" or "last run errored / library not available."
   */
  export const invariantStatus = $state({
    warningCount: 0,
    errorCount: 0,
    lastRunAt: 0,
  });
</script>

<script>
  import { onMount } from 'svelte';
  import { studio } from '$lib/studio/runtime.svelte.js';
  import { getDocumentStore } from '../../../../../lib/document/index.js';
  import { loadAllSettings, saveSetting } from '$lib/settings/schema.js';

  import CheckCircle2 from '@lucide/svelte/icons/circle-check';
  import AlertTriangle from '@lucide/svelte/icons/triangle-alert';
  import AlertCircle from '@lucide/svelte/icons/circle-alert';

  // ── Sibling library (lazy-loaded; may not have shipped yet) ────────────────
  // The runner + library live in $lib/invariants — owned by a parallel agent.
  // We dynamic-import on first use so this file builds even if the modules
  // haven't landed yet, and so a runtime throw inside the library doesn't
  // crash the Inspector. The result is a tagged union: { ok, mod } | { ok:false, err }.
  let libPromise = null;
  function loadLib() {
    if (libPromise) return libPromise;
    libPromise = (async () => {
      try {
        const [runner, library] = await Promise.all([
          import('$lib/invariants/runner.js'),
          import('$lib/invariants/library.js'),
        ]);
        if (typeof runner.runInvariants !== 'function') {
          return { ok: false, err: 'runInvariants export missing' };
        }
        return {
          ok: true,
          runInvariants: runner.runInvariants,
          INVARIANTS: library.INVARIANTS || [],
        };
      } catch (e) {
        return { ok: false, err: e?.message || String(e) };
      }
    })();
    return libPromise;
  }

  // ── Selection wiring ───────────────────────────────────────────────────────
  let selectedFeatureId = $state(null);

  onMount(() => {
    const store = getDocumentStore();
    const sync = () => {
      selectedFeatureId = store.selectedFeatureId?.() ?? null;
    };
    sync();
    return store.subscribe(() => sync());
  });

  // ── Settings: "show passes" toggle ─────────────────────────────────────────
  function loadShowPasses() {
    try {
      const s = loadAllSettings();
      return Boolean(s?.manufacturing?.invariantShowPasses);
    } catch {
      return false;
    }
  }
  let showPasses = $state(loadShowPasses());
  function onShowPassesChange(e) {
    const next = Boolean(e.currentTarget.checked);
    showPasses = next;
    try { saveSetting('manufacturing', 'invariantShowPasses', next); } catch {}
  }

  // ── Runner state ───────────────────────────────────────────────────────────
  let featureResult = $state(null);    // result of per-feature run
  let documentResult = $state(null);   // result of per-document run
  let libraryEntries = $state([]);     // INVARIANTS array for metadata lookup
  let loading = $state(false);
  let runtimeError = $state(null);

  let activeCategory = $state('all');
  const CATEGORIES = ['all', 'geometric', 'material', 'standard-parts', 'mechanical', 'assembly', 'parametric'];

  function buildCtx() {
    return {
      bridge: studio.bridge,
      measure: (q) => studio.measure(q),
      activeComponentId: studio.activeComponentId,
    };
  }

  // Per-feature: re-run on selection change or compile bump.
  $effect(() => {
    const fid = selectedFeatureId;
    const compileMs = studio.bridge?.lastCompileMs;
    void compileMs;

    if (!fid) {
      featureResult = null;
      // Don't clobber chip — documentResult may still contribute. Recompute below.
      return;
    }

    let cancelled = false;
    loading = true;
    runtimeError = null;

    (async () => {
      const lib = await loadLib();
      if (cancelled) return;
      if (!lib.ok) {
        runtimeError = lib.err;
        featureResult = null;
        loading = false;
        return;
      }
      libraryEntries = lib.INVARIANTS;
      try {
        const r = await lib.runInvariants('per-feature', fid, buildCtx());
        if (cancelled) return;
        featureResult = r ?? null;
      } catch (e) {
        if (cancelled) return;
        runtimeError = e?.message || String(e);
        featureResult = null;
      } finally {
        if (!cancelled) loading = false;
      }
    })();

    return () => { cancelled = true; };
  });

  // Per-document: also re-run on compile.
  $effect(() => {
    const compileMs = studio.bridge?.lastCompileMs;
    void compileMs;

    let cancelled = false;
    (async () => {
      const lib = await loadLib();
      if (cancelled || !lib.ok) return;
      libraryEntries = lib.INVARIANTS;
      try {
        const r = await lib.runInvariants('per-document', null, buildCtx());
        if (cancelled) return;
        documentResult = r ?? null;
      } catch (e) {
        if (cancelled) return;
        // Per-document errors shouldn't override a per-feature error message,
        // but if there's no other error, surface it.
        if (!runtimeError) runtimeError = e?.message || String(e);
      }
    })();

    return () => { cancelled = true; };
  });

  // ── Aggregate for chip / summary ───────────────────────────────────────────
  // We merge per-feature and per-document; both contribute to the chip count.
  const aggregate = $derived.by(() => {
    const errs = [];
    const warns = [];
    const all = [];
    for (const r of [featureResult, documentResult]) {
      if (!r || !r.results) continue;
      for (const [id, res] of Object.entries(r.results)) {
        if (!res) continue;
        all.push({ id, ...res });
        if (res.severity === 'error' && !res.ok) errs.push(id);
        else if (res.severity === 'warning' && !res.ok) warns.push(id);
      }
    }
    return { errs, warns, all };
  });

  // Push to status singleton whenever aggregate changes.
  $effect(() => {
    invariantStatus.errorCount = aggregate.errs.length;
    invariantStatus.warningCount = aggregate.warns.length;
    if (!runtimeError && (featureResult || documentResult)) {
      invariantStatus.lastRunAt = Date.now();
    }
  });

  // ── Per-row metadata join ──────────────────────────────────────────────────
  // INVARIANTS gives us name/category/rationale/citation; results gives ok /
  // severity / message / suggestedFix / measured. Join on id.
  const libById = $derived.by(() => {
    const m = new Map();
    for (const inv of libraryEntries || []) m.set(inv.id, inv);
    return m;
  });

  const filteredRows = $derived.by(() => {
    return aggregate.all
      .map((r) => {
        const meta = libById.get(r.id) || {};
        return {
          id: r.id,
          name: meta.name || r.id,
          category: meta.category || 'unknown',
          rationale: meta.rationale || '',
          citation: meta.citation || '',
          severity: r.severity || (r.ok ? 'pass' : 'warning'),
          ok: r.ok,
          message: r.message || '',
          suggestedFix: r.suggestedFix || '',
        };
      })
      .filter((row) => {
        if (!showPasses && row.ok) return false;
        if (activeCategory !== 'all' && row.category !== activeCategory) return false;
        return true;
      });
  });

  function iconFor(severity) {
    if (severity === 'error') return AlertCircle;
    if (severity === 'warning') return AlertTriangle;
    return CheckCircle2;
  }
  function colorFor(severity) {
    if (severity === 'error') return 'text-destructive';
    if (severity === 'warning') return 'text-amber-500';
    return 'text-emerald-500';
  }

  const allPass = $derived(aggregate.errs.length === 0 && aggregate.warns.length === 0);
</script>

<div class="space-y-2 text-xs">
  <!-- Header: title + summary -->
  <div class="flex items-center justify-between">
    <span class="text-[10px] uppercase tracking-wider text-muted-foreground">Engineering invariants</span>
    {#if runtimeError}
      <span class="text-[10px] text-muted-foreground">unavailable</span>
    {:else if loading}
      <span class="text-[10px] text-muted-foreground">running…</span>
    {:else if allPass}
      <span class="text-[10px] text-emerald-500">✓ All pass</span>
    {:else}
      <span class="text-[10px] text-amber-600 dark:text-amber-400">
        ⚠ {aggregate.errs.length} errors, {aggregate.warns.length} warnings
      </span>
    {/if}
  </div>

  <!-- Show-passes toggle -->
  <label class="flex items-center gap-1.5 text-[10px] text-muted-foreground">
    <input
      type="checkbox"
      class="h-3 w-3 rounded border-input"
      checked={showPasses}
      onchange={onShowPassesChange}
    />
    Show passes
  </label>

  <!-- Category filter -->
  <div class="flex flex-wrap gap-1 text-[10px]">
    {#each CATEGORIES as cat (cat)}
      <button
        type="button"
        class="rounded border border-border px-1.5 py-0.5 hover:bg-accent/40"
        class:bg-accent={activeCategory === cat}
        class:text-foreground={activeCategory === cat}
        onclick={() => (activeCategory = cat)}
      >{cat}</button>
    {/each}
  </div>

  {#if runtimeError}
    <div class="rounded border border-border bg-card/40 p-2 text-muted-foreground">
      Invariants unavailable; check kernel connection.
    </div>
  {:else if filteredRows.length === 0}
    <div class="text-center text-muted-foreground/60">
      {showPasses ? 'No invariants in this category.' : 'No violations.'}
    </div>
  {:else}
    {#each filteredRows as row (row.id)}
      {@const Icon = iconFor(row.severity)}
      <div class="rounded border border-border bg-card/40 p-2">
        <div class="flex items-start gap-2">
          <Icon class={`mt-0.5 size-3.5 shrink-0 ${colorFor(row.severity)}`} />
          <div class="min-w-0 flex-1">
            <div class="flex items-center justify-between gap-2">
              <span class="truncate">{row.name}</span>
              <span class="shrink-0 text-[10px] text-muted-foreground">{row.category}</span>
            </div>
            {#if row.message}
              <div class="mt-0.5 text-[10px] text-muted-foreground">{row.message}</div>
            {/if}
            {#if row.suggestedFix}
              <div class="mt-0.5 text-[10px] text-primary">Fix: {row.suggestedFix}</div>
            {/if}
            {#if row.rationale}
              <details class="mt-1 text-[10px] text-muted-foreground/60">
                <summary class="cursor-pointer">why</summary>
                <div class="mt-1 leading-relaxed">
                  {row.rationale}
                  {#if row.citation}
                    <span class="mt-0.5 block italic">— {row.citation}</span>
                  {/if}
                </div>
              </details>
            {/if}
          </div>
        </div>
      </div>
    {/each}
  {/if}
</div>
