<script>
  import { onMount } from 'svelte';
  import * as v4 from '../../../../../lib/document/index.js';

  let feature = $state(null);

  // Move state
  let posX = $state(0);
  let posY = $state(0);
  let posZ = $state(0);

  // Rotate state — single-axis per the spec
  let rotAxis = $state('Z');
  let rotAngle = $state(0);

  // Scale state
  let scaleFactor = $state(1);

  function readFromStore(store) {
    feature = store.selectedFeature();
  }

  onMount(() => {
    const store = v4.getDocumentStore();
    readFromStore(store);
    const unsub = store.subscribe((_doc, _evt, s) => readFromStore(s));
    return unsub;
  });

  function num(v, fallback = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  function hasBody(f) {
    return !!f && Array.isArray(f.outputs?.bodies) && f.outputs.bodies.length > 0;
  }

  function applyMove() {
    if (!feature) return;
    v4.addMove(feature.id, [num(posX), num(posY), num(posZ)]);
    posX = 0;
    posY = 0;
    posZ = 0;
  }

  function applyRotate() {
    if (!feature) return;
    const a = num(rotAngle);
    if (a === 0) return;
    v4.addRotate(feature.id, rotAxis, a);
    rotAngle = 0;
  }

  function applyScale() {
    if (!feature) return;
    const f = num(scaleFactor, 1);
    if (f === 1 || f === 0) {
      scaleFactor = 1;
      return;
    }
    v4.addScale(feature.id, f);
    scaleFactor = 1;
  }
</script>

{#if !hasBody(feature)}
  <div class="text-xs text-muted-foreground/60">Select a body to transform.</div>
{:else}
  <!-- Position -->
  <div>
    <div class="mb-1 text-xs font-medium text-muted-foreground">Position</div>
    <div class="grid grid-cols-3 gap-1.5">
      <div>
        <label for="xform-pos-x" class="mb-0.5 block text-[10px] uppercase tracking-wider text-muted-foreground/70">X</label>
        <input
          id="xform-pos-x"
          type="number"
          step="0.1"
          bind:value={posX}
          class="h-7 w-full rounded border border-input bg-transparent px-2 text-xs"
        />
      </div>
      <div>
        <label for="xform-pos-y" class="mb-0.5 block text-[10px] uppercase tracking-wider text-muted-foreground/70">Y</label>
        <input
          id="xform-pos-y"
          type="number"
          step="0.1"
          bind:value={posY}
          class="h-7 w-full rounded border border-input bg-transparent px-2 text-xs"
        />
      </div>
      <div>
        <label for="xform-pos-z" class="mb-0.5 block text-[10px] uppercase tracking-wider text-muted-foreground/70">Z</label>
        <input
          id="xform-pos-z"
          type="number"
          step="0.1"
          bind:value={posZ}
          class="h-7 w-full rounded border border-input bg-transparent px-2 text-xs"
        />
      </div>
    </div>
    <div class="mt-1.5 flex justify-end">
      <button
        type="button"
        onclick={applyMove}
        class="inline-flex items-center gap-1 rounded bg-primary px-2 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
      >
        Apply Move
      </button>
    </div>
  </div>

  <!-- Rotation -->
  <div>
    <div class="mb-1 text-xs font-medium text-muted-foreground">Rotation</div>
    <div class="grid grid-cols-3 gap-1.5">
      <div>
        <label for="xform-rot-axis" class="mb-0.5 block text-[10px] uppercase tracking-wider text-muted-foreground/70">Axis</label>
        <select
          id="xform-rot-axis"
          bind:value={rotAxis}
          class="h-7 w-full rounded border border-input bg-transparent px-2 text-xs"
        >
          <option value="X">X</option>
          <option value="Y">Y</option>
          <option value="Z">Z</option>
        </select>
      </div>
      <div class="col-span-2">
        <label for="xform-rot-angle" class="mb-0.5 block text-[10px] uppercase tracking-wider text-muted-foreground/70">Angle (deg)</label>
        <input
          id="xform-rot-angle"
          type="number"
          step="0.1"
          bind:value={rotAngle}
          class="h-7 w-full rounded border border-input bg-transparent px-2 text-xs"
        />
      </div>
    </div>
    <div class="mt-1.5 flex justify-end">
      <button
        type="button"
        onclick={applyRotate}
        class="inline-flex items-center gap-1 rounded bg-primary px-2 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
      >
        Apply Rotate
      </button>
    </div>
  </div>

  <!-- Scale -->
  <div>
    <div class="mb-1 text-xs font-medium text-muted-foreground">Scale</div>
    <div class="grid grid-cols-3 gap-1.5">
      <div class="col-span-3">
        <label for="xform-scale-factor" class="mb-0.5 block text-[10px] uppercase tracking-wider text-muted-foreground/70">Factor</label>
        <input
          id="xform-scale-factor"
          type="number"
          step="0.1"
          bind:value={scaleFactor}
          class="h-7 w-full rounded border border-input bg-transparent px-2 text-xs"
        />
      </div>
    </div>
    <div class="mt-1.5 flex justify-end">
      <button
        type="button"
        onclick={applyScale}
        class="inline-flex items-center gap-1 rounded bg-primary px-2 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
      >
        Apply Scale
      </button>
    </div>
  </div>
{/if}
