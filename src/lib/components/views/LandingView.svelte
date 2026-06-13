<script>
  import { navigate } from '$lib/router.svelte.js';
  import Button from '$lib/components/ui/button.svelte';
  import Rocket from '@lucide/svelte/icons/rocket';
  import ArrowRight from '@lucide/svelte/icons/arrow-right';
  import PencilRuler from '@lucide/svelte/icons/pencil-ruler';
  import WandSparkles from '@lucide/svelte/icons/wand-sparkles';
  import Sliders from '@lucide/svelte/icons/sliders-horizontal';
  import Gauge from '@lucide/svelte/icons/gauge';
  import FileDown from '@lucide/svelte/icons/file-down';
  import MousePointer2 from '@lucide/svelte/icons/mouse-pointer-2';
  import Box from '@lucide/svelte/icons/box';
  import Send from '@lucide/svelte/icons/send';
  import Sparkles from '@lucide/svelte/icons/sparkles';
  import Check from '@lucide/svelte/icons/check';

  // Inline trust chips beside the hero CTAs — both pillars, above the fold.
  const chips = [
    { icon: Gauge, label: 'Live rebuild' },
    { icon: FileDown, label: 'STEP · STL · BREP' },
    { icon: Sparkles, label: 'Powered by Claude' },
  ];

  // Feature tree rows for the studio mockup (left panel).
  const tree = [
    { label: 'Pi Hinged Case', depth: 0, kind: 'asm' },
    { label: 'Base Shell', depth: 1, kind: 'part' },
    { label: 'Lid', depth: 1, kind: 'part', sel: true },
    { label: 'Hinge Pin', depth: 1, kind: 'part' },
    { label: 'M3 Standoff ×4', depth: 1, kind: 'part' },
  ];

  // Named parameters shown reflowing the model (mockup left rail).
  const params = [
    { name: 'wall', value: '2.4', unit: 'mm' },
    { name: 'clearance', value: '0.30', unit: 'mm' },
    { name: 'fillet', value: '3.0', unit: 'mm' },
  ];

  // The AI build itemization (right panel) — primary-token chips only.
  const built = ['base + lid', 'hinge (revolute)', '4× M3 standoffs'];

  // Editor mini-mockup: the live parameter table.
  const editorParams = [
    { name: 'wall_t', value: '2.4', unit: 'mm' },
    { name: 'bolt_d', value: '3.0', unit: 'mm' },
    { name: 'fillet', value: '1.5', unit: 'mm' },
    { name: 'count', value: '4', unit: '' },
  ];

  // Two capability beats — the Editor and the AI. Nothing else.
  const editor = {
    kicker: 'The editor',
    body: 'build123d on OCCT, live in the browser. Change a dimension and the whole assembly reflows in milliseconds — exact picking, mates, snap-fit connectors, then export to a printer or CAM.',
    points: [
      { icon: MousePointer2, text: 'Exact face & edge picking — no fuzzy heuristics' },
      { icon: Box, text: 'Live-rebuild viewport, Z-up, CAD-grade orbit' },
      { icon: FileDown, text: 'Export STL, STEP & BREP to printer or CAM' },
    ],
  };
  const ai = {
    kicker: 'The AI',
    body: 'Describe a machine and Claude returns a genuine parametric assembly — not a static mesh. Parts that mate, connectors that line up, an enclosure auto-sized to fit. The kernel keeps every dimension yours.',
    points: [
      { icon: Sparkles, text: 'Powered by Claude — bring your own key' },
      { icon: WandSparkles, text: 'Or drive it from Claude Desktop via the MCP connector' },
      { icon: Check, text: 'Output is fully parametric & hand-editable' },
    ],
  };
</script>

<div class="landing relative h-full overflow-y-auto bg-background text-foreground">
  <!-- ambient dual-radial glow anchored to the page top -->
  <div
    class="pointer-events-none absolute inset-x-0 top-0 z-0 h-[820px]"
    style="background: radial-gradient(55% 45% at 50% 12%, color-mix(in oklab, var(--primary) 18%, transparent), transparent 70%), radial-gradient(38% 38% at 88% 4%, color-mix(in oklab, var(--primary) 8%, transparent), transparent 70%);"
    aria-hidden="true"
  ></div>

  <div class="relative z-10 mx-auto max-w-6xl px-6">
    <!-- ───────────────────────── Hero ───────────────────────── -->
    <section class="relative pt-16 text-center sm:pt-24">
      <div class="reveal inline-flex items-center gap-2 rounded-full border border-border bg-card/60 px-3 py-1 text-xs text-muted-foreground backdrop-blur">
        <span class="relative flex h-1.5 w-1.5">
          <span class="ping absolute inline-flex h-full w-full rounded-full bg-primary/70"></span>
          <span class="relative inline-flex h-1.5 w-1.5 rounded-full bg-primary"></span>
        </span>
        AI-native parametric CAD · early preview
      </div>

      <h1 class="reveal reveal-1 mx-auto mt-6 max-w-4xl text-balance text-5xl font-bold leading-[0.98] tracking-tight sm:text-6xl lg:text-7xl">
        Describe a machine.
        <br class="hidden sm:block" />
        <span class="text-primary">Edit the real thing.</span>
      </h1>

      <p class="reveal reveal-2 mx-auto mt-6 max-w-2xl text-lg text-muted-foreground sm:text-xl">
        A parametric CAD studio that speaks plain English — and exports STEP.
        The AI drafts a working assembly; the kernel keeps every part, mate, and
        dimension exact and yours to drive.
      </p>

      <div class="reveal reveal-3 mt-9 flex items-center justify-center gap-3">
        <Button size="lg" class="group h-11 px-6 text-base" onclick={() => navigate('studio')}>
          <Rocket class="size-4 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
          Launch Studio
        </Button>
        <Button size="lg" variant="outline" class="h-11 px-6 text-base" onclick={() => navigate('pricing')}>
          See pricing
          <ArrowRight class="size-4" />
        </Button>
      </div>

      <div class="reveal reveal-3 mt-8 flex flex-wrap items-center justify-center gap-2.5">
        {#each chips as chip}
          {@const Icon = chip.icon}
          <span class="inline-flex items-center gap-1.5 rounded-full border border-border bg-card/50 px-3 py-1.5 text-xs font-medium text-muted-foreground backdrop-blur">
            <Icon class="size-3.5 text-primary" />
            {chip.label}
          </span>
        {/each}
      </div>
    </section>

    <!-- ──────────────── Centerpiece: studio mockup ──────────────── -->
    <section class="reveal reveal-4 relative mt-14 pb-4 sm:mt-20">
      <!-- soft primary glow behind the window -->
      <div
        class="pointer-events-none absolute -inset-x-24 -top-16 bottom-0 -z-10 blur-2xl"
        style="background: radial-gradient(60% 55% at 50% 28%, color-mix(in oklab, var(--primary) 22%, transparent), transparent 70%);"
        aria-hidden="true"
      ></div>

      <div class="studio-window mx-auto max-w-5xl overflow-hidden rounded-2xl border border-border bg-card shadow-2xl ring-1 ring-primary/10">
        <!-- Title bar -->
        <div class="flex items-center gap-3 border-b border-border bg-muted/40 px-4 py-2.5">
          <div class="flex items-center gap-1.5">
            <span class="h-3 w-3 rounded-full bg-destructive/70"></span>
            <span class="h-3 w-3 rounded-full bg-primary/70"></span>
            <span class="h-3 w-3 rounded-full bg-muted-foreground/40"></span>
          </div>
          <div class="ml-1 flex items-center gap-1.5 text-sm font-semibold tracking-tight">
            <Box class="size-4 text-primary" />
            ParaForm <span class="font-normal text-muted-foreground">Studio</span>
          </div>
          <div class="ml-auto hidden items-center gap-1.5 sm:flex">
            <span class="rounded-md bg-background/60 px-2 py-1 text-[11px] font-medium text-muted-foreground ring-1 ring-border">Sketch</span>
            <span class="rounded-md bg-primary/15 px-2 py-1 text-[11px] font-medium text-primary ring-1 ring-primary/30">Mate</span>
            <span class="rounded-md bg-background/60 px-2 py-1 text-[11px] font-medium text-muted-foreground ring-1 ring-border">Export</span>
          </div>
        </div>

        <!-- Three-column body -->
        <div class="grid grid-cols-12 divide-x divide-border">
          <!-- LEFT: feature tree + parameters -->
          <aside class="col-span-3 hidden flex-col bg-card/60 md:flex">
            <div class="flex items-center justify-between px-3 py-2.5">
              <span class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Assembly</span>
              <span class="font-mono text-[10px] text-muted-foreground">bracket.paraform</span>
            </div>
            <div class="space-y-0.5 px-1.5 pb-3">
              {#each tree as row}
                <div
                  class="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[12px] {row.kind === 'asm' ? 'font-medium text-card-foreground' : 'text-muted-foreground'} {row.sel ? 'bg-primary/10 ring-1 ring-primary/20' : ''}"
                  style="padding-left: {0.5 + row.depth * 0.85}rem"
                >
                  {#if row.kind === 'asm'}
                    <Box class="size-3.5 shrink-0 text-primary" />
                  {:else}
                    <span class="h-1.5 w-1.5 shrink-0 rounded-[2px] border border-muted-foreground/50"></span>
                  {/if}
                  <span class="truncate">{row.label}</span>
                </div>
              {/each}
            </div>

            <div class="mt-auto border-t border-border px-3 py-2.5">
              <div class="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                <Sliders class="size-3" /> Parameters
              </div>
              <div class="mt-2 space-y-1.5">
                {#each params as p}
                  <div class="flex items-center justify-between font-mono text-[11px]">
                    <span class="text-muted-foreground">{p.name}</span>
                    <span class="rounded bg-background/70 px-1.5 py-0.5 text-card-foreground ring-1 ring-border">
                      {p.value}<span class="text-muted-foreground"> {p.unit}</span>
                    </span>
                  </div>
                {/each}
              </div>
            </div>
          </aside>

          <!-- CENTER: 3D viewport -->
          <div class="relative col-span-12 md:col-span-6">
            <div class="viewport relative aspect-[4/3] w-full overflow-hidden bg-[hsl(240_8%_6%)]">
              <!-- grid floor + part -->
              <svg class="absolute inset-0 h-full w-full" viewBox="0 0 400 300" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
                <defs>
                  <linearGradient id="pf-top" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stop-color="hsl(22 90% 62%)" />
                    <stop offset="100%" stop-color="hsl(22 90% 50%)" />
                  </linearGradient>
                  <linearGradient id="pf-left" x1="0" y1="0" x2="1" y2="0.4">
                    <stop offset="0%" stop-color="hsl(22 45% 26%)" />
                    <stop offset="100%" stop-color="hsl(22 50% 32%)" />
                  </linearGradient>
                  <linearGradient id="pf-right" x1="0" y1="0" x2="1" y2="0.5">
                    <stop offset="0%" stop-color="hsl(22 55% 40%)" />
                    <stop offset="100%" stop-color="hsl(22 60% 46%)" />
                  </linearGradient>
                  <radialGradient id="pf-vign" cx="50%" cy="42%" r="65%">
                    <stop offset="0%" stop-color="transparent" />
                    <stop offset="100%" stop-color="hsl(240 10% 3% / 0.55)" />
                  </radialGradient>
                </defs>

                <!-- isometric grid -->
                <g stroke="hsl(0 0% 100% / 0.06)" stroke-width="1">
                  {#each [0, 1, 2, 3, 4, 5, 6, 7, 8] as i}
                    {@const x = i * 50}
                    <line x1={x} y1="150" x2={x - 120} y2="300" />
                    <line x1={x} y1="150" x2={x + 120} y2="300" />
                  {/each}
                  {#each [0, 1, 2, 3] as r}
                    {@const y = 150 + r * 38}
                    <line x1={-40 + r * 30} y1={y} x2={440 - r * 30} y2={y} opacity={0.7 - r * 0.15} />
                  {/each}
                </g>

                <!-- contact shadow -->
                <ellipse cx="206" cy="206" rx="118" ry="34" fill="hsl(240 10% 2% / 0.55)" />

                <!-- ── parametric enclosure (faux isometric, three lit faces) ── -->
                <g>
                  <!-- right face -->
                  <polygon points="200,118 296,166 296,214 200,166" fill="url(#pf-right)" stroke="hsl(22 90% 70% / 0.35)" stroke-width="1" />
                  <!-- left face -->
                  <polygon points="200,118 104,166 104,214 200,166" fill="url(#pf-left)" stroke="hsl(22 90% 70% / 0.25)" stroke-width="1" />
                  <!-- top face -->
                  <polygon points="200,118 296,166 200,214 104,166" fill="url(#pf-top)" stroke="hsl(22 90% 80% / 0.5)" stroke-width="1" />

                  <!-- bolt holes on top face (parametric pattern) -->
                  <g fill="hsl(240 10% 6%)" stroke="hsl(22 90% 30%)" stroke-width="1">
                    <ellipse cx="168" cy="155" rx="7" ry="3.6" />
                    <ellipse cx="232" cy="155" rx="7" ry="3.6" />
                    <ellipse cx="168" cy="177" rx="7" ry="3.6" />
                    <ellipse cx="232" cy="177" rx="7" ry="3.6" />
                  </g>

                  <!-- dashed filleted-pocket hint on top -->
                  <polygon points="200,148 236,166 200,184 164,166" fill="none" stroke="hsl(22 90% 85% / 0.45)" stroke-width="1" stroke-dasharray="3 3" />

                  <!-- highlighted (selected) front edge -->
                  <line x1="104" y1="166" x2="200" y2="214" stroke="hsl(22 90% 60%)" stroke-width="2.5" />
                </g>

                <!-- dimension callout -->
                <g font-family="ui-monospace, monospace" font-size="10" fill="hsl(0 0% 100% / 0.7)">
                  <line x1="104" y1="230" x2="200" y2="278" stroke="hsl(0 0% 100% / 0.3)" stroke-width="1" />
                  <text x="138" y="266" fill="hsl(22 90% 70%)">84.0</text>
                </g>

                <rect width="400" height="300" fill="url(#pf-vign)" />
              </svg>

              <!-- axis triad (Z-up) -->
              <svg class="absolute bottom-3 left-3 size-12 opacity-90" viewBox="0 0 60 60" aria-hidden="true">
                <line x1="30" y1="42" x2="30" y2="14" stroke="hsl(140 70% 55%)" stroke-width="2.5" />
                <line x1="30" y1="42" x2="8" y2="52" stroke="hsl(0 80% 60%)" stroke-width="2.5" />
                <line x1="30" y1="42" x2="52" y2="52" stroke="hsl(210 90% 60%)" stroke-width="2.5" />
                <text x="30" y="11" font-size="9" fill="hsl(140 70% 60%)" text-anchor="middle" font-family="monospace">Z</text>
              </svg>

              <!-- ViewCube -->
              <div class="absolute right-3 top-3 grid h-9 w-9 place-items-center rounded-md border border-border bg-background/70 text-[9px] font-semibold text-muted-foreground backdrop-blur">
                ISO
              </div>

              <!-- live-rebuild status -->
              <div class="absolute bottom-3 right-3 flex items-center gap-1.5 rounded-md bg-background/70 px-2 py-1 font-mono text-[10px] font-medium text-muted-foreground ring-1 ring-border backdrop-blur">
                <span class="h-1.5 w-1.5 rounded-full bg-primary"></span>
                rebuilt · 38 ms
              </div>
            </div>
          </div>

          <!-- RIGHT: AI chat panel -->
          <aside class="col-span-12 flex flex-col bg-card/60 md:col-span-3">
            <div class="flex items-center gap-1.5 border-b border-border px-3 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              <Sparkles class="size-3 text-primary" /> Assistant
            </div>

            <div class="flex-1 space-y-3 p-3">
              <div class="flex justify-end">
                <div class="max-w-[92%] rounded-lg rounded-tr-sm bg-primary px-2.5 py-1.5 text-[12px] leading-snug text-primary-foreground">
                  a hinged case for a Raspberry Pi
                </div>
              </div>
              <div class="flex flex-col gap-1.5">
                <div class="max-w-[95%] rounded-lg rounded-tl-sm bg-muted px-2.5 py-1.5 text-[12px] leading-snug text-card-foreground ring-1 ring-border">
                  Built <span class="font-medium text-primary">4 parts</span> · mated · case auto-fitted.
                  <ul class="mt-1.5 space-y-1 font-mono text-[11px] text-muted-foreground">
                    {#each built as line}
                      <li class="flex items-center gap-1.5">
                        <Check class="size-3 text-primary" /> {line}
                      </li>
                    {/each}
                  </ul>
                </div>
                <div class="flex flex-wrap gap-1">
                  <span class="inline-flex items-center gap-1 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary ring-1 ring-primary/20">
                    <Check class="size-2.5" /> mated
                  </span>
                  <span class="inline-flex items-center gap-1 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary ring-1 ring-primary/20">
                    <Check class="size-2.5" /> case fitted
                  </span>
                </div>
              </div>
            </div>

            <!-- prompt input -->
            <div class="border-t border-border p-2.5">
              <div class="flex items-center gap-2 rounded-lg border border-border bg-background/60 px-2.5 py-1.5">
                <span class="flex-1 truncate text-[12px] text-muted-foreground">add a snap-fit lid latch</span>
                <span class="grid size-6 shrink-0 place-items-center rounded-md bg-primary text-primary-foreground">
                  <Send class="size-3" />
                </span>
              </div>
            </div>
          </aside>
        </div>
      </div>
    </section>

    <!-- ──────────────── The Editor ──────────────── -->
    <section class="reveal mt-24 grid items-center gap-10 sm:mt-32 lg:grid-cols-2 lg:gap-16">
      <div class="order-2 lg:order-1">
        <div class="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-primary">
          <PencilRuler class="size-4" /> {editor.kicker}
        </div>
        <h2 class="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">
          Named parameters that<br class="hidden sm:block" />
          reflow the <span class="text-primary">whole model.</span>
        </h2>
        <p class="mt-4 max-w-md text-base leading-relaxed text-muted-foreground">{editor.body}</p>
        <ul class="mt-6 space-y-2.5 text-sm text-card-foreground">
          {#each editor.points as point}
            {@const Icon = point.icon}
            <li class="flex items-center gap-2.5">
              <Icon class="size-4 shrink-0 text-primary" />
              {point.text}
            </li>
          {/each}
        </ul>
      </div>

      <!-- mini-mockup: live parameter table + drag→rebuild slider -->
      <div class="order-1 lg:order-2">
        <div class="overflow-hidden rounded-xl border border-border bg-card shadow-lg">
          <div class="flex items-center justify-between border-b border-border bg-muted/40 px-4 py-2 text-[12px] font-medium text-muted-foreground">
            <span>Parameters</span>
            <span class="flex items-center gap-1.5 font-mono text-[11px] text-primary">
              <span class="h-1.5 w-1.5 rounded-full bg-primary"></span> live
            </span>
          </div>
          <table class="w-full font-mono text-[13px]">
            <tbody>
              {#each editorParams as p, i}
                <tr class="border-b border-border/60 {i === 0 ? 'bg-primary/5' : ''}">
                  <td class="px-4 py-2.5 text-muted-foreground">{p.name}</td>
                  <td class="px-2 py-2.5 text-right">
                    <span class="rounded border border-border bg-background px-2 py-0.5 text-primary">{p.value}</span>
                  </td>
                  <td class="w-10 px-3 py-2.5 text-left text-muted-foreground">{p.unit}</td>
                </tr>
              {/each}
            </tbody>
          </table>
          <div class="flex items-center gap-3 bg-muted/20 px-4 py-3">
            <div class="relative h-1.5 flex-1 rounded-full bg-border">
              <div class="absolute inset-y-0 left-0 w-[62%] rounded-full bg-primary"></div>
              <div class="absolute -top-1 left-[62%] size-3.5 -translate-x-1/2 rounded-full border-2 border-primary bg-card"></div>
            </div>
            <span class="font-mono text-[11px] text-muted-foreground">drag&nbsp;→&nbsp;rebuild</span>
          </div>
        </div>
      </div>
    </section>

    <!-- ──────────────── The AI ──────────────── -->
    <section class="reveal mt-20 grid items-center gap-10 border-t border-border pt-20 lg:grid-cols-2 lg:gap-16">
      <!-- mini-mockup: a second prompt → real, mated parts -->
      <div>
        <div class="overflow-hidden rounded-xl border border-border bg-card shadow-lg">
          <div class="flex items-center gap-2 border-b border-border bg-muted/40 px-4 py-2 text-[12px] font-medium text-muted-foreground">
            <WandSparkles class="size-3.5 text-primary" /> Plain English → real parts
          </div>
          <div class="space-y-3 p-4">
            <div class="ml-auto w-fit max-w-[85%] rounded-lg rounded-tr-sm bg-primary px-3 py-2 text-[13px] leading-snug text-primary-foreground">
              a NEMA-17 motor mount with a belt-tensioner slot
            </div>
            <div class="max-w-[90%] rounded-lg rounded-tl-sm border border-border bg-background px-3 py-2.5 text-[13px] leading-snug text-card-foreground">
              Drafted a parametric mount. Connectors placed, slot is prismatic.
              <div class="mt-2 grid grid-cols-2 gap-1.5 font-mono text-[11px]">
                <span class="flex items-center gap-1.5 rounded border border-border bg-muted/30 px-2 py-1"><Check class="size-3 text-primary" /> face_plate</span>
                <span class="flex items-center gap-1.5 rounded border border-border bg-muted/30 px-2 py-1"><Check class="size-3 text-primary" /> 4× bolt holes</span>
                <span class="flex items-center gap-1.5 rounded border border-border bg-muted/30 px-2 py-1"><Check class="size-3 text-primary" /> tension slot</span>
                <span class="flex items-center gap-1.5 rounded border border-primary/40 bg-primary/10 px-2 py-1 text-primary"><Check class="size-3" /> mated</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div>
        <div class="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-primary">
          <WandSparkles class="size-4" /> {ai.kicker}
        </div>
        <h2 class="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">
          AI drafts it. The kernel<br class="hidden sm:block" />
          makes it <span class="text-primary">real.</span>
        </h2>
        <p class="mt-4 max-w-md text-base leading-relaxed text-muted-foreground">{ai.body}</p>
        <ul class="mt-6 space-y-2.5 text-sm text-card-foreground">
          {#each ai.points as point}
            {@const Icon = point.icon}
            <li class="flex items-center gap-2.5">
              <Icon class="size-4 shrink-0 text-primary" />
              {point.text}
            </li>
          {/each}
        </ul>
      </div>
    </section>

    <!-- ──────────────── Pricing teaser ──────────────── -->
    <section class="mt-20">
      <div class="relative overflow-hidden rounded-2xl border border-primary/30 bg-card px-6 py-9 ring-1 ring-primary/10 sm:px-12">
        <div
          class="pointer-events-none absolute inset-0 z-0"
          style="background: radial-gradient(70% 120% at 88% 0%, color-mix(in oklab, var(--primary) 14%, transparent), transparent 65%);"
          aria-hidden="true"
        ></div>
        <div class="relative z-10 flex flex-col items-center justify-between gap-6 text-center sm:flex-row sm:text-left">
          <div>
            <h2 class="text-2xl font-bold tracking-tight text-card-foreground sm:text-3xl">
              Free to start <span class="font-normal text-muted-foreground">·</span> Pro <span class="text-primary">$9.99/mo</span>
            </h2>
            <p class="mt-2 max-w-md text-sm text-muted-foreground">
              Design and export for free. Upgrade for more AI generations and
              priority compiles when you're shipping daily — cancel anytime.
            </p>
          </div>
          <div class="flex flex-shrink-0 flex-wrap items-center justify-center gap-3">
            <Button size="lg" class="h-11 px-6 text-base" onclick={() => navigate('studio')}>
              <Rocket class="size-4" />
              Launch Studio
            </Button>
            <Button size="lg" variant="outline" class="h-11 px-6 text-base" onclick={() => navigate('pricing')}>
              See pricing
            </Button>
          </div>
        </div>
      </div>
    </section>

    <!-- ──────────────── Footer ──────────────── -->
    <footer class="mt-16 flex flex-col items-center justify-between gap-3 border-t border-border py-8 sm:flex-row">
      <div class="flex items-center gap-2 text-sm font-semibold tracking-tight">
        <Box class="size-4 text-primary" />
        ParaForm
      </div>
      <p class="font-mono text-xs text-muted-foreground">build123d · OCCT · three.js · Z-up</p>
      <p class="text-xs text-muted-foreground">© ParaForm</p>
    </footer>
  </div>
</div>

<style>
  /* Entrance — staggered fade-up + the hero ping, all gated on reduced-motion. */
  @media (prefers-reduced-motion: no-preference) {
    .reveal {
      opacity: 0;
      transform: translateY(14px);
      animation: pf-reveal 0.6s cubic-bezier(0.22, 1, 0.36, 1) forwards;
    }
    .reveal-1 { animation-delay: 0.06s; }
    .reveal-2 { animation-delay: 0.12s; }
    .reveal-3 { animation-delay: 0.18s; }
    .reveal-4 { animation-delay: 0.26s; }

    .studio-window {
      transition: transform 0.4s cubic-bezier(0.22, 1, 0.36, 1), box-shadow 0.4s ease;
    }
    .studio-window:hover {
      transform: translateY(-4px);
    }

    .ping {
      animation: pf-ping 2s cubic-bezier(0, 0, 0.2, 1) infinite;
    }
    @keyframes pf-ping {
      75%, 100% {
        transform: scale(2.2);
        opacity: 0;
      }
    }
  }

  @keyframes pf-reveal {
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
</style>
