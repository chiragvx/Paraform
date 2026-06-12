<script>
  import { studio } from '$lib/studio/runtime.svelte.js';
  import Select from '$lib/components/ui/select.svelte';

  const COLORS = [
    '#8c9aaa', '#e8e8e8', '#1a1a1a', '#ff8c28',
    '#3aa6ff', '#7fdc52', '#ff5a7f', '#b07fd9',
  ];

  const FINISH_OPTIONS = [
    { value: 'semi-gloss', label: 'Semi-gloss' },
    { value: 'matte',      label: 'Matte' },
    { value: 'silk',       label: 'Silk' },
    { value: 'translucent',label: 'Translucent' },
  ];

  function pickColor(c) {
    studio.materialColor = c;
    studio.applyMaterialToViewport();
  }

  function onFinishChange() {
    studio.applyMaterialToViewport();
  }

  function onIntensityInput() {
    studio.applyLightingToViewport();
  }
</script>

<div class="space-y-3 text-xs">
  <!-- Section 1: Color -->
  <div>
    <div class="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">Color</div>
    <div class="grid grid-cols-4 gap-2">
      {#each COLORS as c (c)}
        <button
          type="button"
          class="size-7 rounded-full border-2 hover:border-foreground/30 {studio.materialColor === c ? 'border-foreground' : 'border-transparent'}"
          style="background:{c}"
          aria-label="Color {c}"
          onclick={() => pickColor(c)}
        ></button>
      {/each}
    </div>
  </div>

  <!-- Section 2: Surface finish -->
  <div>
    <div class="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">Surface Finish</div>
    <Select
      bind:value={studio.surfaceFinish}
      options={FINISH_OPTIONS}
      onchange={onFinishChange}
    />
  </div>

  <!-- Section 3: Intensity -->
  <div>
    <div class="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">Intensity</div>
    <input
      type="range"
      min="0"
      max="2"
      step="0.05"
      bind:value={studio.lightingIntensity}
      oninput={onIntensityInput}
      class="w-full accent-ring"
      aria-label="Lighting intensity"
    />
    <div class="mt-1 text-right text-[10px] text-muted-foreground">{studio.lightingIntensity.toFixed(2)}</div>
  </div>
</div>
