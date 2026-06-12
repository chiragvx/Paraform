<script>
  import Dialog from '$lib/components/ui/dialog.svelte';
  import Button from '$lib/components/ui/button.svelte';
  import Input from '$lib/components/ui/input.svelte';
  import { extras, closeLibrary } from '$lib/dialogs/extras.svelte.js';
  import { LIBRARY_ITEMS } from '$lib/library/catalog.js';
  import {
    fetchCatalog,
    insertEntry,
    categoriesOf,
    filterEntries,
  } from '$lib/library/standard.js';
  import * as v4 from '../../../../lib/document/index.js';
  import { libraryDrag } from './LibraryPalette.svelte';

  // ── State ─────────────────────────────────────────────────────────────────
  let query = $state('');
  let activeCategory = $state('Quickstart');

  // Categories whose entries are dimensional metadata only (no real body
  // — the kernel returns a marker placeholder). Hide them from the dialog
  // so users don't drag a "Thread M3" card and get a 0.5 mm cube.
  const DATA_ONLY_CATEGORIES = new Set(['Thread', 'ClearanceHole', 'Fit']);

  /** Fetched standard-parts entries (from kernel /library). */
  let standardEntries = $state([]);
  let loading = $state(false);
  let loadError = $state('');

  /** Per-entry insert in-flight flag (keyed by entry id). */
  let insertingId = $state('');

  // ── Loaders ───────────────────────────────────────────────────────────────

  async function loadCatalog() {
    loading = true;
    loadError = '';
    try {
      const entries = await fetchCatalog();
      standardEntries = Array.isArray(entries)
        ? entries.filter((e) => !DATA_ONLY_CATEGORIES.has(e?.category))
        : [];
    } catch (e) {
      loadError = (e && e.message) ? e.message : String(e);
      standardEntries = [];
    } finally {
      loading = false;
    }
  }

  // Re-fetch every time the dialog opens (cache makes this cheap after the
  // first hit). We don't fetch on module load so the kernel doesn't get
  // hit until the user actually opens the dialog.
  $effect(() => {
    if (extras.library && !loading && standardEntries.length === 0 && !loadError) {
      loadCatalog();
    }
  });

  // ── Derived: categories + filtered list ──────────────────────────────────

  const categories = $derived.by(() => {
    const cats = new Set(['Quickstart']);
    for (const c of categoriesOf(standardEntries)) cats.add(c);
    // Keep Quickstart first, then the rest alphabetical.
    const rest = Array.from(cats).filter((c) => c !== 'Quickstart').sort();
    return ['Quickstart', ...rest];
  });

  const filteredQuickstart = $derived.by(() => {
    const q = query.trim().toLowerCase();
    return LIBRARY_ITEMS.filter((it) => {
      if (activeCategory !== 'Quickstart') return false;
      if (!q) return true;
      const hay = [it.name, it.subCategory, it.description, it.dims, it.id]
        .filter(Boolean).join(' ').toLowerCase();
      return hay.includes(q);
    });
  });

  const filteredStandard = $derived.by(() => {
    if (activeCategory === 'Quickstart') return [];
    return filterEntries(standardEntries, {
      category: activeCategory,
      query,
    });
  });

  // ── Dims summary per category ─────────────────────────────────────────────

  function dimsSummary(entry) {
    const d = entry?.dims || {};
    const cat = entry?.category;
    if (cat === 'Fastener') {
      const thread = d.thread ?? entry.nominalSize ?? '';
      const length = (d.length != null) ? `${d.length} mm` : '';
      const head = (d.headDiameter != null) ? `Ø${d.headDiameter} head` : '';
      return [thread, length, head].filter(Boolean);
    }
    if (cat === 'Extrusion') {
      const series = d.series ? `${d.series}-series` : '';
      const profile = (d.gridX && d.gridY)
        ? `${d.gridX * d.series}×${d.gridY * d.series} mm`
        : '';
      const length = (d.length != null) ? `${d.length} mm long` : '';
      return [series, profile, length].filter(Boolean);
    }
    if (cat === 'Bearing') {
      const id = (d.bore != null) ? `Ø${d.bore} ID` : '';
      const od = (d.outerDiameter != null) ? `Ø${d.outerDiameter} OD` : '';
      const w = (d.width != null) ? `${d.width} W` : '';
      return [id, od, w].filter(Boolean);
    }
    // Generic fallback: stringify up to 3 numeric dims.
    const out = [];
    for (const [k, v] of Object.entries(d)) {
      if (out.length >= 3) break;
      if (typeof v === 'number') out.push(`${k} ${v}`);
      else if (typeof v === 'string') out.push(`${k} ${v}`);
    }
    return out;
  }

  // ── Insert handlers ───────────────────────────────────────────────────────

  function insertQuickstart(item) {
    try {
      item.build(v4);
      closeLibrary();
    } catch (e) {
      console.error('[library] quickstart insert failed', e);
    }
  }

  // ── Drag handlers ─────────────────────────────────────────────────────────
  // Both card types are draggable into the viewport. We close the dialog
  // on dragstart so the user can see where they're dropping; the drag
  // operation itself continues fine even after the source element is
  // unmounted. The viewport reads libraryDrag and routes by which field
  // is populated.

  function onQuickstartDragStart(ev, item) {
    libraryDrag.quickstartItem = item;
    libraryDrag.part = null;
    libraryDrag.standardEntry = null;
    libraryDrag.startedAt = Date.now();
    if (ev.dataTransfer) {
      ev.dataTransfer.setData('application/x-paraform-quickstart', item.id);
      ev.dataTransfer.effectAllowed = 'copy';
    }
    closeLibrary();
  }

  function onStandardDragStart(ev, entry) {
    libraryDrag.standardEntry = entry;
    libraryDrag.part = null;
    libraryDrag.quickstartItem = null;
    libraryDrag.startedAt = Date.now();
    if (ev.dataTransfer) {
      ev.dataTransfer.setData('application/x-paraform-standard', entry.id);
      ev.dataTransfer.effectAllowed = 'copy';
    }
    closeLibrary();
  }

  function onDragEnd() {
    libraryDrag.quickstartItem = null;
    libraryDrag.standardEntry = null;
    libraryDrag.startedAt = 0;
  }

  async function insertStandard(entry) {
    if (insertingId === entry.id) return;
    insertingId = entry.id;
    try {
      const res = await insertEntry(entry.id);
      if (res?.ok) {
        closeLibrary();
      } else {
        console.error('[library] standard insert failed', res?.error);
      }
    } catch (e) {
      console.error('[library] standard insert threw', e);
    } finally {
      insertingId = '';
    }
  }
</script>

<Dialog
  bind:open={extras.library}
  onclose={closeLibrary}
  title="Library"
  description="Browse Quickstart blocks and ISO-standard parts. Click Insert to drop one into the document."
  class="max-w-3xl"
>
  {#snippet children()}
    <div class="space-y-3">
      <!-- Search -->
      <Input
        type="search"
        placeholder="Search library…"
        bind:value={query}
        class="h-7"
      />

      <!-- Category chips -->
      <div class="flex flex-wrap gap-1.5">
        {#each categories as cat (cat)}
          <button
            type="button"
            class="rounded-full border border-border px-2.5 py-0.5 text-[11px] transition-colors {activeCategory === cat ? 'bg-accent text-foreground' : 'bg-muted text-muted-foreground hover:bg-accent/40'}"
            onclick={() => (activeCategory = cat)}
          >
            {cat}
          </button>
        {/each}
        {#if loading}
          <span class="ml-1 inline-flex items-center px-2 py-0.5 text-[11px] text-muted-foreground">
            Loading library…
          </span>
        {/if}
        {#if loadError && !loading}
          <span class="ml-1 inline-flex items-center px-2 py-0.5 text-[11px] text-destructive">
            Library unreachable — Quickstart only
          </span>
        {/if}
      </div>

      <!-- Body -->
      {#if activeCategory === 'Quickstart'}
        {#if filteredQuickstart.length === 0}
          <div class="rounded border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
            No Quickstart items match "{query}".
          </div>
        {:else}
          <div class="grid grid-cols-3 gap-3 max-h-[60vh] overflow-y-auto pr-1">
            {#each filteredQuickstart as item (item.id)}
              <div
                class="flex flex-col gap-2 rounded-md border border-border bg-card p-2.5 cursor-grab active:cursor-grabbing"
                draggable="true"
                ondragstart={(e) => onQuickstartDragStart(e, item)}
                ondragend={onDragEnd}
                title="Drag into the viewport or click Insert"
              >
                <div class="text-xs font-medium leading-tight">{item.name}</div>
                <div class="text-[10px] text-muted-foreground">{item.subCategory}</div>
                <div class="inline-flex w-fit rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  {item.dims}
                </div>
                <div class="text-[11px] leading-snug text-muted-foreground">
                  {item.description}
                </div>
                <div class="mt-auto pt-1">
                  <Button size="sm" class="w-full" onclick={() => insertQuickstart(item)}>
                    {#snippet children()}Insert{/snippet}
                  </Button>
                </div>
              </div>
            {/each}
          </div>
        {/if}
      {:else if loading}
        <div class="grid grid-cols-3 gap-3 max-h-[60vh] overflow-y-auto pr-1" aria-busy="true">
          {#each Array(6) as _, i (i)}
            <div class="flex flex-col gap-2 rounded-md border border-border bg-card p-2.5 animate-pulse">
              <div class="h-3 w-2/3 rounded bg-muted"></div>
              <div class="h-2 w-1/2 rounded bg-muted"></div>
              <div class="h-2 w-3/4 rounded bg-muted"></div>
              <div class="mt-auto h-7 w-full rounded bg-muted"></div>
            </div>
          {/each}
        </div>
      {:else if filteredStandard.length === 0}
        <div class="rounded border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
          No {activeCategory} entries match "{query}".
        </div>
      {:else}
        <div class="grid grid-cols-3 gap-3 max-h-[60vh] overflow-y-auto pr-1">
          {#each filteredStandard as entry (entry.id)}
            <div
              class="flex flex-col gap-2 rounded-md border border-border bg-card p-2.5 cursor-grab active:cursor-grabbing"
              draggable="true"
              ondragstart={(e) => onStandardDragStart(e, entry)}
              ondragend={onDragEnd}
              title="Drag into the viewport or click Insert"
            >
              <div class="text-xs font-medium leading-tight">{entry.name}</div>
              <div class="text-[10px] text-muted-foreground">{entry.standard}</div>
              <div class="flex flex-wrap gap-1">
                {#each dimsSummary(entry) as chip (chip)}
                  <span class="inline-flex rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    {chip}
                  </span>
                {/each}
              </div>
              <div class="mt-auto pt-1">
                <Button
                  size="sm"
                  class="w-full"
                  disabled={insertingId === entry.id}
                  onclick={() => insertStandard(entry)}
                >
                  {#snippet children()}{insertingId === entry.id ? 'Inserting…' : 'Insert'}{/snippet}
                </Button>
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/snippet}

  {#snippet footer()}
    <Button variant="ghost" size="sm" onclick={closeLibrary}>
      {#snippet children()}Close{/snippet}
    </Button>
  {/snippet}
</Dialog>
