<script>
  import { navigate } from '$lib/router.svelte.js';
  import Button from '$lib/components/ui/button.svelte';
  import Cpu from '@lucide/svelte/icons/cpu';
  import Layers from '@lucide/svelte/icons/layers';
  import FileDown from '@lucide/svelte/icons/file-down';
  import Rocket from '@lucide/svelte/icons/rocket';

  const features = [
    {
      icon: Cpu,
      title: 'Real-time CAD kernel',
      body: 'build123d + OCCT compiles your parametric code into solids in milliseconds.',
    },
    {
      icon: Layers,
      title: 'Parametric model history',
      body: 'Every feature is a first-class node — edit any step and the model reflows.',
    },
    {
      icon: FileDown,
      title: 'STL + STEP + BREP export',
      body: 'Ship to slicers, CAM, or downstream CAD with the formats that matter.',
    },
  ];

  const steps = [
    { n: 1, t: 'Sketch or script', d: 'Draw 2D profiles or write parametric build123d code.' },
    { n: 2, t: 'Build features', d: 'Extrude, revolve, fillet — stack operations into a history tree.' },
    { n: 3, t: 'Inspect & iterate', d: 'Tune dimensions, watch the model rebuild live in the viewport.' },
    { n: 4, t: 'Export & make', d: 'Send STL to your printer or STEP to a manufacturer.' },
  ];
</script>

<div class="h-full overflow-y-auto bg-background text-foreground">
  <div class="container max-w-6xl mx-auto px-6 py-12">
    <!-- Hero -->
    <section class="py-16 sm:py-24 text-center">
      <div class="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground mb-6">
        <span class="h-1.5 w-1.5 rounded-full bg-primary"></span>
        Now in early preview
      </div>
      <h1 class="text-4xl sm:text-6xl font-semibold tracking-tight">
        ParaForm <span class="text-muted-foreground">—</span>
        <span class="text-primary">The Parametric 3D Platform</span>
      </h1>
      <p class="mt-6 text-lg sm:text-xl text-muted-foreground max-w-2xl mx-auto">
        Build production-ready 3D parts with code, sketches, and a feature history that
        never breaks. From first principle to final STL.
      </p>
      <div class="mt-10 flex items-center justify-center gap-3">
        <Button size="lg" onclick={() => navigate('studio')}>
          <Rocket class="size-4" />
          Launch Studio
        </Button>
        <Button size="lg" variant="outline" onclick={() => navigate('explore')}>
          Explore templates
        </Button>
      </div>
    </section>

    <!-- Features -->
    <section class="py-16 border-t border-border">
      <h2 class="text-2xl sm:text-3xl font-semibold tracking-tight text-center">
        Built for parametric workflows
      </h2>
      <p class="mt-3 text-center text-muted-foreground max-w-xl mx-auto">
        Every interaction is reversible, scriptable, and exportable.
      </p>
      <div class="mt-12 grid grid-cols-1 md:grid-cols-3 gap-6">
        {#each features as f}
          {@const Icon = f.icon}
          <div class="rounded-lg border border-border bg-card p-6">
            <div class="flex h-10 w-10 items-center justify-center rounded-md bg-primary/10 text-primary">
              <Icon class="size-5" />
            </div>
            <h3 class="mt-4 text-lg font-medium text-card-foreground">{f.title}</h3>
            <p class="mt-2 text-sm text-muted-foreground leading-relaxed">{f.body}</p>
          </div>
        {/each}
      </div>
    </section>

    <!-- How it works -->
    <section class="py-16 border-t border-border">
      <h2 class="text-2xl sm:text-3xl font-semibold tracking-tight text-center">
        How it works
      </h2>
      <ol class="mt-12 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
        {#each steps as s}
          <li class="rounded-lg border border-border bg-card p-6">
            <div class="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-primary-foreground text-sm font-semibold">
              {s.n}
            </div>
            <h3 class="mt-4 text-base font-medium text-card-foreground">{s.t}</h3>
            <p class="mt-2 text-sm text-muted-foreground leading-relaxed">{s.d}</p>
          </li>
        {/each}
      </ol>
    </section>

    <!-- Footer -->
    <footer class="py-12 mt-8 border-t border-border">
      <div class="flex flex-col sm:flex-row items-center justify-between gap-4">
        <p class="text-sm text-muted-foreground">
          Engine: build123d on OCCT &middot; three.js viewport &middot; Z-up world
        </p>
        <p class="text-sm text-muted-foreground">
          &copy; ParaForm. All rights reserved.
        </p>
      </div>
    </footer>
  </div>
</div>
