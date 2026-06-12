<script>
  import { navigate } from '$lib/router.svelte.js';
  import Button from '$lib/components/ui/button.svelte';
  import Input from '$lib/components/ui/input.svelte';
  import Search from '@lucide/svelte/icons/search';
  import Box from '@lucide/svelte/icons/box';

  const categories = ['Mechanical', 'Brackets', 'Enclosures', 'Fixtures', 'Custom'];

  // `thumb` points at a PNG in /thumbnails (served from public/, survives the
  // build into dist/thumbnails). Cards without a real render fall back to the
  // placeholder cube. Only cards backed by an actual rendered template get a
  // thumbnail — no invented mappings.
  const templates = [
    { name: 'Rugged Box', dims: '120 × 80 × 55 mm', category: 'Enclosures', thumb: '/thumbnails/rugged_box_v1.png' },
    { name: 'Raspberry Pi 3 Case', dims: '95 × 65 × 30 mm', category: 'Enclosures', thumb: '/thumbnails/rpi3_case_v1.png' },
    { name: 'BeagleBone Case', dims: '90 × 60 × 28 mm', category: 'Enclosures', thumb: '/thumbnails/bbb_case_v1.png' },
    { name: 'Music Box', dims: '70 × 70 × 50 mm', category: 'Mechanical', thumb: '/thumbnails/music_box_v1.png' },
    { name: 'Wall Hanger', dims: '80 × 30 × 6 mm', category: 'Brackets', thumb: '/thumbnails/hanger_v1.png' },
    { name: 'Test Box', dims: '40 × 40 × 40 mm', category: 'Custom', thumb: '/thumbnails/testbox_v1.png' },
  ];

  // Per-card flag flipped on <img> error so we gracefully drop back to the
  // placeholder cube rather than showing a broken image.
  let imgFailed = $state({});

  let query = $state('');
  let activeCategory = $state('All');

  const filtered = $derived(
    templates.filter((t) => {
      const matchesQuery = t.name.toLowerCase().includes(query.toLowerCase().trim());
      const matchesCat = activeCategory === 'All' || t.category === activeCategory;
      return matchesQuery && matchesCat;
    }),
  );
</script>

<div class="h-full overflow-y-auto bg-background text-foreground">
  <div class="container max-w-6xl mx-auto px-6 py-12">
    <header class="mb-8">
      <h1 class="text-3xl font-semibold tracking-tight">Explore templates</h1>
      <p class="mt-2 text-muted-foreground">
        Start from a parametric blueprint and adapt it to your needs.
      </p>
    </header>

    <!-- Search -->
    <div class="relative max-w-xl">
      <Search class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
      <Input
        bind:value={query}
        placeholder="Search templates..."
        class="pl-9"
      />
    </div>

    <!-- Categories -->
    <div class="mt-6 flex flex-wrap gap-2">
      <button
        class="rounded-full border border-border px-3 py-1 text-xs transition-colors {activeCategory === 'All' ? 'bg-primary text-primary-foreground border-primary' : 'bg-card text-muted-foreground hover:bg-accent hover:text-accent-foreground'}"
        onclick={() => (activeCategory = 'All')}
      >
        All
      </button>
      {#each categories as cat}
        <button
          class="rounded-full border border-border px-3 py-1 text-xs transition-colors {activeCategory === cat ? 'bg-primary text-primary-foreground border-primary' : 'bg-card text-muted-foreground hover:bg-accent hover:text-accent-foreground'}"
          onclick={() => (activeCategory = cat)}
        >
          {cat}
        </button>
      {/each}
    </div>

    <!-- Grid -->
    <div class="mt-8 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
      {#each filtered as t (t.name)}
        <article class="rounded-lg border border-border bg-card overflow-hidden flex flex-col">
          <div class="aspect-[4/3] bg-muted flex items-center justify-center border-b border-border overflow-hidden">
            {#if t.thumb && !imgFailed[t.name]}
              <img
                src={t.thumb}
                alt={t.name}
                loading="lazy"
                class="h-full w-full object-cover"
                onerror={() => (imgFailed = { ...imgFailed, [t.name]: true })}
              />
            {:else}
              <Box class="size-12 text-muted-foreground/60" />
            {/if}
          </div>
          <div class="p-4 flex flex-col gap-3 flex-1">
            <div class="flex items-start justify-between gap-3">
              <h3 class="text-base font-medium text-card-foreground">{t.name}</h3>
              <span class="inline-flex items-center rounded-full border border-border bg-background px-2 py-0.5 text-[10px] font-mono text-muted-foreground whitespace-nowrap">
                {t.dims}
              </span>
            </div>
            <p class="text-xs text-muted-foreground">{t.category}</p>
            <div class="mt-auto pt-2">
              <Button size="sm" class="w-full" onclick={() => navigate('studio')}>
                Open in Studio
              </Button>
            </div>
          </div>
        </article>
      {/each}
    </div>

    {#if filtered.length === 0}
      <div class="mt-12 text-center text-muted-foreground">
        No templates match your search.
      </div>
    {/if}
  </div>
</div>
