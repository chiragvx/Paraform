<script module>
  /**
   * Shared library-palette signal — the Viewport reads the in-flight
   * dragged part record from this rune so its drop handler can build
   * the placeLibraryPart op.
   */
  export const libraryDrag = $state({
    /** @type {object|null} */ part: null,
    /** Quickstart entry from src/lib/library/catalog.js — has .build(v4). */
    /** @type {object|null} */ quickstartItem: null,
    /** Standard-parts entry from kernel /library — fetched via insertEntry. */
    /** @type {object|null} */ standardEntry: null,
    /** @type {number} */      startedAt: 0,
  });
</script>

<script>
  /**
   * Spec 18 v1 — Library palette.
   *
   * Sidebar panel exposing every PartRecord in the library, grouped by
   * category, searchable, and draggable into the viewport. The actual
   * snap-to-connector UX lives in Viewport.svelte; this panel just owns
   * the search / filter / drag-start surface.
   *
   * v1 thumbnails are category icons + size badges (real preview render
   * deferred to v2).
   */
  import { onMount } from 'svelte';
  import { loadLibrary, findPart, listByCategory, listVisible, listVisibleCategories, isVerifiedPart } from '$lib/library/index.js';
  import Search from '@lucide/svelte/icons/search';
  import Bolt   from '@lucide/svelte/icons/bolt';        // fastener
  import Circle from '@lucide/svelte/icons/circle';      // nut / washer / bearing / pulley
  import Hexagon from '@lucide/svelte/icons/hexagon';    // nut
  import RectangleHorizontal from '@lucide/svelte/icons/rectangle-horizontal'; // bracket / rail
  import Spline from '@lucide/svelte/icons/spline';      // misc
  import Cylinder from '@lucide/svelte/icons/cylinder';  // standoff
  import Boxes from '@lucide/svelte/icons/boxes';        // composite
  import GripVertical from '@lucide/svelte/icons/grip-vertical'; // drag affordance

  const CATEGORY_ICON = {
    fastener:  Bolt,
    nut:       Hexagon,
    washer:    Circle,
    standoff:  Cylinder,
    bracket:   RectangleHorizontal,
    bearing:   Circle,
    pulley:    Circle,
    rail:      RectangleHorizontal,
    extrusion: Boxes,
    misc:      Spline,
  };

  let allParts = $state([]);
  let categories = $state([]);
  let selectedCategory = $state(null);
  let query = $state('');
  let loaded = $state(false);

  onMount(async () => {
    await loadLibrary();
    allParts = listVisible();
    categories = listVisibleCategories();
    loaded = true;
  });

  const filtered = $derived.by(() => {
    if (!loaded) return [];
    let pool;
    if (query && query.trim().length > 0) {
      pool = findPart(query).map((h) => h.part);
    } else if (selectedCategory) {
      pool = listByCategory(selectedCategory);
    } else {
      pool = allParts;
    }
    // Show only parts that build to real geometry (allParts is already
    // verified-only; this also gates the search / category branches).
    return pool.filter(isVerifiedPart).slice(0, 200);
  });

  function onDragStart(ev, part) {
    libraryDrag.part = part;
    libraryDrag.startedAt = Date.now();
    if (ev.dataTransfer) {
      ev.dataTransfer.setData('application/x-paraform-library-part', part.id);
      ev.dataTransfer.effectAllowed = 'copy';
    }
  }

  function onDragEnd() {
    libraryDrag.part = null;
    libraryDrag.startedAt = 0;
  }

  function pickIcon(cat) {
    return CATEGORY_ICON[cat] || Spline;
  }

  function sizeBadge(part) {
    if (!part || !Array.isArray(part.connectors) || part.connectors.length === 0) return '';
    const c = part.connectors[0];
    const sz = c.size && c.size.nominal;
    if (sz == null) return '';
    // Fasteners/nuts size in metric thread (M-prefix); anything else just
    // shows the nominal millimetre value with a unit.
    const cat = part.category;
    if (cat === 'fastener' || cat === 'nut' || cat === 'washer' || cat === 'standoff') {
      return `M${sz}`;
    }
    return `${sz} mm`;
  }

  function prettyCategory(cat) {
    if (!cat) return '';
    return cat.charAt(0).toUpperCase() + cat.slice(1);
  }
</script>

<div class="flex h-full flex-col gap-2 bg-card p-2 text-xs text-foreground">
  <div class="flex items-center gap-2 rounded border border-border bg-background px-2 py-1">
    <Search class="size-3 text-muted-foreground" />
    <input
      class="w-full bg-transparent text-xs text-foreground outline-none"
      placeholder="Search library…"
      bind:value={query}
    />
  </div>

  <div class="flex flex-wrap gap-1">
    <button
      class={'rounded border px-2 py-0.5 text-[10px] uppercase tracking-wide ' + (selectedCategory === null ? 'border-foreground bg-foreground text-background' : 'border-border bg-card text-muted-foreground hover:text-foreground')}
      onclick={() => (selectedCategory = null)}
      type="button"
    >
      all
    </button>
    {#each categories as cat (cat)}
      <button
        class={'rounded border px-2 py-0.5 text-[10px] uppercase tracking-wide ' + (selectedCategory === cat ? 'border-foreground bg-foreground text-background' : 'border-border bg-card text-muted-foreground hover:text-foreground')}
        onclick={() => (selectedCategory = cat)}
        type="button"
      >
        {cat}
      </button>
    {/each}
  </div>

  {#if !loaded}
    <div class="px-2 py-3 text-muted-foreground">Loading library…</div>
  {:else if filtered.length === 0}
    <div class="px-2 py-3 text-muted-foreground">No parts match.</div>
  {:else}
    <div class="-mx-2 flex-1 overflow-y-auto px-2">
      <ul class="flex flex-col gap-1">
        {#each filtered as part (part.id)}
          {@const Icon = pickIcon(part.category)}
          <li
            class="group flex cursor-grab items-center gap-2 rounded border border-border bg-background/40 px-2 py-1.5 hover:border-foreground/40 hover:bg-background"
            draggable="true"
            ondragstart={(e) => onDragStart(e, part)}
            ondragend={onDragEnd}
            title={`${part.name} — drag into the viewport to place`}
          >
            <div class="flex size-6 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground">
              {#if part.source === 'composite'}
                <Boxes class="size-3.5" />
              {:else}
                <Icon class="size-3.5" />
              {/if}
            </div>
            <div class="flex-1 truncate">
              <div class="truncate text-xs font-medium text-foreground">{part.name}</div>
              <div class="truncate text-[10px] text-muted-foreground">
                {prettyCategory(part.category)}{#if sizeBadge(part)} · {sizeBadge(part)}{/if}
              </div>
            </div>
            {#if part.source === 'composite'}
              <span class="rounded bg-accent px-1.5 py-0.5 text-[9px] uppercase text-foreground/70">comp</span>
            {/if}
            <!-- Drag affordance: appears on hover to signal the row is draggable -->
            <GripVertical
              class="size-3.5 shrink-0 text-muted-foreground/40 opacity-0 transition-opacity group-hover:opacity-100"
              aria-hidden="true"
            />
          </li>
        {/each}
      </ul>
    </div>
  {/if}
</div>
