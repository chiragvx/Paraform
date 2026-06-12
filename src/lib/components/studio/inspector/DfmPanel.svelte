<script module>
  /**
   * Shared DFM signal — read by StatusBar to render the warning chip.
   *
   * Lives here (not in a dedicated store file) because DfmPanel is the only
   * writer and the coupling is intentionally minimal. Svelte 5 $state in a
   * <script module> block gives us a singleton reactive object that any
   * importer can subscribe to via $effect.
   */
  export const dfmStatus = $state({
    warningCount: 0,
    errorCount: 0,
    profileId: null,
  });
</script>

<script>
  import { onMount } from 'svelte';
  import { studio } from '$lib/studio/runtime.svelte.js';
  import { getDocumentStore } from '../../../../../lib/document/index.js';
  import { loadAllSettings, saveSetting } from '$lib/settings/schema.js';
  import { runChecks } from '$lib/dfm/runner.js';
  import { listProfiles, getProfile } from '$lib/dfm/profiles.js';

  import CheckCircle2 from '@lucide/svelte/icons/circle-check';
  import AlertTriangle from '@lucide/svelte/icons/triangle-alert';
  import AlertCircle from '@lucide/svelte/icons/circle-alert';

  // ── Selection wiring ────────────────────────────────────────────────────────
  let selectedFeatureId = $state(null);

  onMount(() => {
    const store = getDocumentStore();
    const sync = () => {
      selectedFeatureId = store.selectedFeatureId() ?? null;
    };
    sync();
    return store.subscribe(() => sync());
  });

  // ── Profile (sourced from settings; persisted on change) ────────────────────
  function loadProfile() {
    try {
      const s = loadAllSettings();
      return s?.manufacturing?.profile || '3d-print';
    } catch {
      return '3d-print';
    }
  }
  let profileId = $state(loadProfile());

  let profileOptions = $state([]);
  try {
    profileOptions = (listProfiles?.() ?? []).map((p) =>
      typeof p === 'string' ? { id: p, label: p } : { id: p.id, label: p.label ?? p.id },
    );
  } catch {
    profileOptions = [
      { id: '3d-print', label: '3D Print' },
      { id: 'cnc-mill', label: 'CNC Mill' },
      { id: 'injection-mold', label: 'Injection Mold' },
    ];
  }

  const profileLabel = $derived(
    profileOptions.find((p) => p.id === profileId)?.label ?? profileId,
  );

  function onProfileChange(e) {
    const next = e.currentTarget.value;
    profileId = next;
    try { saveSetting('manufacturing', 'profile', next); } catch {}
  }

  // ── Runner state ────────────────────────────────────────────────────────────
  let loading = $state(false);
  let result = $state(null);
  let runtimeError = $state(null);

  // Re-run on selection change, profile change, or any new compile.
  $effect(() => {
    const fid = selectedFeatureId;
    const pid = profileId;
    const compileMs = studio.bridge?.lastCompileMs;
    void compileMs;

    if (!fid) {
      result = null;
      runtimeError = null;
      loading = false;
      dfmStatus.warningCount = 0;
      dfmStatus.errorCount = 0;
      dfmStatus.profileId = pid;
      return;
    }

    let cancelled = false;
    loading = true;
    runtimeError = null;

    (async () => {
      try {
        const r = await runChecks(fid, pid);
        if (cancelled) return;
        result = r ?? null;
        const errs = Array.isArray(r?.errors) ? r.errors.length : 0;
        const warns = Array.isArray(r?.warnings) ? r.warnings.length : 0;
        dfmStatus.errorCount = errs;
        dfmStatus.warningCount = warns;
        dfmStatus.profileId = pid;
      } catch (err) {
        if (cancelled) return;
        result = null;
        runtimeError = String(err?.message || err);
        dfmStatus.warningCount = 0;
        dfmStatus.errorCount = 0;
        dfmStatus.profileId = pid;
      } finally {
        if (!cancelled) loading = false;
      }
    })();

    return () => { cancelled = true; };
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
</script>

<div class="space-y-2 text-xs">
  <!-- Profile picker -->
  <div class="flex items-center justify-between">
    <span class="text-[10px] uppercase tracking-wider text-muted-foreground">Process</span>
    <select
      class="h-7 rounded-md border border-input bg-transparent px-2 text-xs focus:outline-none focus:border-border"
      value={profileId}
      onchange={onProfileChange}
    >
      {#each profileOptions as opt (opt.id)}
        <option value={opt.id}>{opt.label}</option>
      {/each}
    </select>
  </div>

  {#if !selectedFeatureId}
    <div class="text-center text-muted-foreground">Select a feature to run DFM checks.</div>
  {:else if loading}
    <div class="text-center text-muted-foreground">Running DFM checks…</div>
  {:else if runtimeError}
    <div class="rounded border border-border bg-card/40 p-2 text-muted-foreground">
      Measurements unavailable; check kernel connection.
    </div>
  {:else if result}
    <!-- Summary row -->
    <div class="flex items-center justify-between">
      {#if result.pass}
        <span class="text-emerald-500">✓ Passes {profileLabel}</span>
      {:else}
        <span class="text-destructive">
          ⚠ {result.errors?.length ?? 0} issues, {result.warnings?.length ?? 0} warnings
        </span>
      {/if}
    </div>

    <!-- Per-check rows -->
    {#if result.checks && Object.keys(result.checks).length > 0}
      <div class="space-y-1">
        {#each Object.entries(result.checks) as [name, check] (name)}
          {@const Icon = iconFor(check.severity ?? (check.ok ? 'ok' : 'warning'))}
          <div class="flex items-start gap-2 rounded border border-border bg-card/40 p-2">
            <Icon class={`mt-0.5 h-3.5 w-3.5 shrink-0 ${colorFor(check.severity ?? (check.ok ? 'ok' : 'warning'))}`} />
            <div class="flex-1 min-w-0">
              <div class="font-mono text-[11px]">{name}</div>
              {#if check.message}
                <div class="text-[10px] text-muted-foreground">{check.message}</div>
              {/if}
              {#if check.suggestedFix}
                <div class="text-[10px] text-primary mt-0.5">Fix: {check.suggestedFix}</div>
              {/if}
            </div>
          </div>
        {/each}
      </div>
    {/if}
  {/if}
</div>
