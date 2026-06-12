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
      title: 'Describe it, build it',
      body: 'A plain-English brief becomes a parametric assembly — parts that mate and snap-fit connectors that line up.',
    },
    {
      icon: Layers,
      title: 'A case that fits',
      body: 'ParaForm sizes an enclosure around your assembly automatically, then lets you tune any dimension and watch it reflow.',
    },
    {
      icon: FileDown,
      title: 'STL + STEP + BREP export',
      body: 'Ship to slicers, CAM, or downstream CAD with the formats that matter.',
    },
  ];

  const steps = [
    { n: 1, t: 'Describe your machine', d: 'Tell the assistant what you want to build, in plain English.' },
    { n: 2, t: 'Get an assembly', d: 'ParaForm builds the parts, mates them, and fits a case around them.' },
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
        Describe a machine. <span class="text-muted-foreground">Get a</span>
        <span class="text-primary">printable assembly with a fitted case.</span>
      </h1>
      <p class="mt-6 text-lg sm:text-xl text-muted-foreground max-w-2xl mx-auto">
        ParaForm turns a plain-English brief into a real parametric assembly —
        parts that mate, snap-fit connectors, and an enclosure sized to fit. Tune
        any dimension and export STL or STEP straight to your printer.
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
        From brief to buildable
      </h2>
      <p class="mt-3 text-center text-muted-foreground max-w-xl mx-auto">
        AI does the first pass; the parametric kernel keeps it editable and exportable.
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
