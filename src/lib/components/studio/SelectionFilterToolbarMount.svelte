<script>
  /**
   * Collapsed selection-filter pill. Replaces the 6-chip always-visible
   * toolbar with a single pill "Filter: {label}" at top-center; click opens
   * a popover with the chip toggles inside. Hidden entirely when no bodies
   * are present in the scene (driven by the `hasBodies` prop).
   *
   * Reads/writes `selection.setKindFilter` directly so the underlying API
   * is unchanged. Persists the user's active set under the same key the
   * legacy imperative toolbar used so prior settings round-trip.
   */
  import { getPickingSelection } from '../../../../lib/picking/selection.js';
  import Filter from '@lucide/svelte/icons/filter';

  let { hasBodies = false } = $props();

  const KINDS = [
    { id: 'face',   label: 'Face' },
    { id: 'edge',   label: 'Edge' },
    { id: 'vertex', label: 'Vertex' },
    { id: 'body',   label: 'Body' },
    { id: 'sketch', label: 'Sketch' },
  ];
  const ALL_IDS = KINDS.map((k) => k.id);
  const STORAGE_KEY = 'paraform.selectionFilterToolbar';

  function restore() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return new Set();
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return new Set();
      return new Set(arr.filter((id) => ALL_IDS.includes(id)));
    } catch { return new Set(); }
  }

  let active = $state(restore());
  let open = $state(false);
  let pillEl;
  let panelEl;
  let selection = null;
  try { selection = getPickingSelection(); } catch {}

  function apply() {
    if (!selection) return;
    try {
      if (active.size === 0 || active.size === ALL_IDS.length) {
        selection.setKindFilter(null);
      } else {
        selection.setKindFilter([...active]);
      }
    } catch {}
  }
  function persist() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify([...active])); } catch {}
  }
  function toggle(id) {
    if (active.has(id)) active.delete(id);
    else active.add(id);
    active = new Set(active); // re-trigger reactivity
    apply();
    persist();
  }
  function reset() {
    active = new Set();
    apply();
    persist();
  }
  // Sync underlying singleton on mount.
  apply();

  function label() {
    if (active.size === 0 || active.size === ALL_IDS.length) return 'All';
    const names = KINDS.filter((k) => active.has(k.id)).map((k) => k.label);
    return names.join(', ');
  }

  function onDocPointerDown(ev) {
    if (!open) return;
    const t = ev.target;
    if (pillEl && pillEl.contains(t)) return;
    if (panelEl && panelEl.contains(t)) return;
    open = false;
  }
  $effect(() => {
    if (open) {
      document.addEventListener('pointerdown', onDocPointerDown, true);
      return () => document.removeEventListener('pointerdown', onDocPointerDown, true);
    }
  });
</script>

{#if hasBodies}
  <div class="relative inline-flex">
    <button
      bind:this={pillEl}
      type="button"
      onclick={() => (open = !open)}
      aria-pressed={open}
      title="Selection filter"
      class="inline-flex items-center gap-1.5 rounded-full border border-border bg-card/90 px-2.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground backdrop-blur-sm shadow-sm aria-pressed:bg-accent aria-pressed:text-foreground"
    >
      <Filter class="size-3" />
      <span>Filter: <span class="text-foreground">{label()}</span></span>
    </button>
    {#if open}
      <div
        bind:this={panelEl}
        class="absolute left-1/2 top-full z-30 mt-1.5 flex -translate-x-1/2 items-center gap-1 rounded border border-border bg-card/95 p-1 shadow-sm backdrop-blur-sm"
      >
        <button
          type="button"
          onclick={reset}
          aria-pressed={active.size === 0}
          class="rounded px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground aria-pressed:bg-accent aria-pressed:text-foreground"
          title="Clear the filter (accept every kind)"
        >All</button>
        <div class="h-4 w-px bg-border"></div>
        {#each KINDS as k (k.id)}
          <button
            type="button"
            onclick={() => toggle(k.id)}
            aria-pressed={active.has(k.id)}
            class="rounded px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground aria-pressed:bg-primary aria-pressed:text-primary-foreground"
            title={`Toggle ${k.label} picking`}
          >{k.label}</button>
        {/each}
      </div>
    {/if}
  </div>
{/if}
