<script>
  import { onMount } from 'svelte';
  import { COMMANDS } from '$lib/commands/registry.js';
  import { dialogs } from '$lib/dialogs/dialogs.svelte.js';
  import { palette } from '$lib/commands/palette.svelte.js';
  import { getDocumentStore } from '../../../../lib/document/index.js';
  import { studio } from '$lib/studio/runtime.svelte.js';
  import { isSketchActive, enterSketch } from '$lib/sketch/boot.js';
  import { addSketchOnFace } from '../../../../lib/document/index.js';
  import { importCadFile, addImportedToScene } from '$lib/import/cad.js';
  import { V1 } from '$lib/flags.js';

  // ── Lucide icons ────────────────────────────────────────────────────────
  // History
  import Undo2 from '@lucide/svelte/icons/undo-2';
  import Redo2 from '@lucide/svelte/icons/redo-2';
  // Sketch
  import Pencil from '@lucide/svelte/icons/pencil';
  // Primitives
  import Box from '@lucide/svelte/icons/box';
  import Cylinder from '@lucide/svelte/icons/cylinder';
  import Circle from '@lucide/svelte/icons/circle';
  import Donut from '@lucide/svelte/icons/donut';
  // Sketch → Solid
  import ArrowUp from '@lucide/svelte/icons/arrow-up'; // Extrude — "pull up" feel reads better than reusing Box.
  import RotateCcw from '@lucide/svelte/icons/rotate-ccw'; // Revolve (also reused for Circular Pattern below).
  import Hammer from '@lucide/svelte/icons/hammer'; // Sweep substitute — no dedicated "sweep" icon in lucide.
  import Disc from '@lucide/svelte/icons/disc'; // Loft substitute — stacked-rings reading.
  // Modify
  import CircleDashed from '@lucide/svelte/icons/circle-dashed'; // Fillet — rounded-edge reading.
  import Triangle from '@lucide/svelte/icons/triangle'; // Chamfer — angled-cut reading; closest available shape.
  import Container from '@lucide/svelte/icons/container'; // Shell — hollow-box reading.
  import Drill from '@lucide/svelte/icons/drill'; // Hole
  import Slash from '@lucide/svelte/icons/slash'; // Draft — angle reading; reused for Axis.
  import MoveDiagonal from '@lucide/svelte/icons/move-diagonal'; // Press-Pull — face-along-normal reading.
  import MoveDiagonal2 from '@lucide/svelte/icons/move-diagonal-2'; // Move Face — distinct from Press-Pull.
  import Eraser from '@lucide/svelte/icons/eraser'; // Delete Face — remove-and-heal reading.
  import BoxSelect from '@lucide/svelte/icons/box-select'; // Offset Face — face-thicken reading.
  // Boolean
  import Plus from '@lucide/svelte/icons/plus';
  import Minus from '@lucide/svelte/icons/minus';
  import X from '@lucide/svelte/icons/x';
  // Reference geometry
  import Square from '@lucide/svelte/icons/square';
  import Dot from '@lucide/svelte/icons/dot';
  // Pattern
  import AlignHorizontalDistributeCenter from '@lucide/svelte/icons/align-horizontal-distribute-center';
  import FlipHorizontal2 from '@lucide/svelte/icons/flip-horizontal-2';
  // Transform
  import Move from '@lucide/svelte/icons/move';
  import RotateCw from '@lucide/svelte/icons/rotate-cw';
  import Maximize2 from '@lucide/svelte/icons/maximize-2';
  import AlignCenter from '@lucide/svelte/icons/align-center'; // Align — closest available
  // Insert
  import Upload from '@lucide/svelte/icons/upload';
  import Boxes from '@lucide/svelte/icons/boxes';
  import FileCode from '@lucide/svelte/icons/file-code';
  // Tools (E4 — Selection + measurement + section)
  import Ruler from '@lucide/svelte/icons/ruler';
  import Scissors from '@lucide/svelte/icons/scissors'; // Section view — Slice is not in lucide; Scissors reads as "cut through".
  import Layers from '@lucide/svelte/icons/layers'; // Interference — overlapping bodies
  // Right cluster
  import Search from '@lucide/svelte/icons/search';

  const store = getDocumentStore();
  const cmdById = Object.fromEntries(COMMANDS.map((c) => [c.id, c]));

  // Bump on every store commit so derived `enabled()` re-runs.
  let tick = $state(0);
  let fileInput;
  let searchValue = $state('');

  onMount(() => store.subscribe(() => { tick++; }));

  /** Look up a command and return a click handler. Defensive on missing ids. */
  function tool(id) {
    return () => {
      const cmd = cmdById[id];
      if (!cmd) { console.warn('[ribbon] missing command:', id); return; }
      if (cmd.form) dialogs.openForm(cmd);
      else cmd.run({ store });
    };
  }

  /** True when the command exists AND its enabled() (if any) returns true. */
  function enabled(id) {
    void tick;
    const cmd = cmdById[id];
    if (!cmd) return false;
    if (typeof cmd.enabled !== 'function') return true;
    try { return !!cmd.enabled({ store }); } catch { return false; }
  }

  /** Does the command exist at all? (For "Coming soon" disable states.) */
  function exists(id) { return !!cmdById[id]; }

  const sketchActive = $derived.by(() => { void tick; return isSketchActive(); });

  // E2.1 — Sketch on face: arms a face-pick gesture, then creates the
  // SketchOnFace feature and drops into the sketcher on commit.
  function startSketchOnFace() {
    const ok = studio.startFacePick({
      purpose: 'sketch',
      accept: ['face'],
      onPick: async (descriptor) => {
        try {
          const feat = addSketchOnFace(descriptor);
          await enterSketch({ faceDescriptor: descriptor, featureId: feat.id });
        } catch (err) {
          console.error('[ribbon] Sketch on face failed', err);
        }
      },
      onCancel: () => { /* user dismissed */ },
    });
    if (!ok) console.warn('[ribbon] Sketch on face: viewport not ready');
  }

  // ── CAD Import (preserved from previous Toolbar) ────────────────────────
  async function onPickFile(e) {
    const file = e.target?.files?.[0];
    if (file) {
      try {
        const group = await importCadFile(file);
        addImportedToScene(group, file.name);
        console.info('[ribbon] imported: ' + file.name);
      } catch (err) {
        console.error('[ribbon] import failed for ' + file.name, err);
      }
    }
    if (fileInput) fileInput.value = '';
  }

  // ── Search input behaviour ──────────────────────────────────────────────
  function onSearchFocus() { palette.show(); }
  function onSearchKey(e) {
    if (e.key === 'Enter') {
      palette.query = searchValue;
      // CommandPalette listens to palette.query / palette.open and runs first match on Enter.
      // We just sync the query and let it handle dispatch.
    }
  }

  // ── Style tokens ────────────────────────────────────────────────────────
  const toolBtn =
    'inline-flex h-8 w-8 items-center justify-center rounded text-muted-foreground ' +
    'hover:bg-accent hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed transition-colors';
  const primaryBtn =
    'inline-flex h-8 items-center gap-1.5 rounded px-2.5 text-xs font-medium ' +
    'bg-primary text-primary-foreground hover:bg-primary/90 ' +
    'disabled:opacity-40 disabled:cursor-not-allowed transition-colors';
</script>

<div class="flex h-11 items-center gap-0.5 border-b border-border bg-card px-2">
  <!-- ── 1. History ─────────────────────────────────────────────────── -->
  <div class="flex items-center gap-0.5">
    <button
      type="button"
      class={toolBtn}
      title="Undo (Ctrl+Z)"
      disabled={!enabled('edit.undo')}
      onclick={tool('edit.undo')}
    >
      <Undo2 class="size-4" />
    </button>
    <button
      type="button"
      class={toolBtn}
      title="Redo (Ctrl+Y)"
      disabled={!enabled('edit.redo')}
      onclick={tool('edit.redo')}
    >
      <Redo2 class="size-4" />
    </button>
  </div>

  {#if !V1}
  <div class="mx-1 h-6 w-px bg-border"></div>

  <!-- ── 2. Primary — Sketch ─────────────────────────────────────────── -->
  <details class="relative">
    <summary
      class="{primaryBtn} list-none cursor-pointer select-none"
      style:opacity={sketchActive ? '0.4' : null}
      style:pointer-events={sketchActive ? 'none' : null}
      title="New sketch on a plane"
    >
      <Pencil class="size-4" />
      <span>Sketch</span>
    </summary>
    <div class="absolute left-0 top-full z-30 mt-1 w-44 rounded-md border border-border bg-popover p-1 shadow-md">
      <button
        type="button"
        class="flex w-full items-center rounded px-2 py-1.5 text-left text-xs text-foreground hover:bg-accent disabled:opacity-40"
        disabled={!enabled('sketch.enter.xy')}
        onclick={tool('sketch.enter.xy')}
      >Sketch on XY</button>
      <button
        type="button"
        class="flex w-full items-center rounded px-2 py-1.5 text-left text-xs text-foreground hover:bg-accent disabled:opacity-40"
        disabled={!enabled('sketch.enter.xz')}
        onclick={tool('sketch.enter.xz')}
      >Sketch on XZ</button>
      <button
        type="button"
        class="flex w-full items-center rounded px-2 py-1.5 text-left text-xs text-foreground hover:bg-accent disabled:opacity-40"
        disabled={!enabled('sketch.enter.yz')}
        onclick={tool('sketch.enter.yz')}
      >Sketch on YZ</button>
      <div class="my-1 h-px bg-border"></div>
      <button
        type="button"
        class="flex w-full items-center rounded px-2 py-1.5 text-left text-xs text-foreground hover:bg-accent disabled:opacity-40"
        disabled={sketchActive}
        onclick={startSketchOnFace}
      >Sketch on face…</button>
    </div>
  </details>
  {/if}

  <div class="mx-1 h-6 w-px bg-border"></div>

  <!-- ── 3. Primitives ──────────────────────────────────────────────── -->
  <div class="flex items-center gap-0.5">
    <button type="button" class={toolBtn} title="Add Box…" onclick={tool('primitive.box.form')}>
      <Box class="size-4" />
    </button>
    <button type="button" class={toolBtn} title="Add Cylinder…" onclick={tool('primitive.cylinder.form')}>
      <Cylinder class="size-4" />
    </button>
    <button type="button" class={toolBtn} title="Add Sphere…" onclick={tool('primitive.sphere.form')}>
      <Circle class="size-4" />
    </button>
    <button type="button" class={toolBtn} title="Add Torus…" onclick={tool('primitive.torus.form')}>
      <Donut class="size-4" />
    </button>
  </div>

  <div class="mx-1 h-6 w-px bg-border"></div>

  <!-- ── 4. Sketch → Solid ──────────────────────────────────────────── -->
  <div class="flex items-center gap-0.5">
    {#if !V1}
    <button
      type="button"
      class={toolBtn}
      title="Extrude selected sketch"
      disabled={!enabled('sketch.extrude')}
      onclick={tool('sketch.extrude')}
    >
      <ArrowUp class="size-4" />
    </button>
    <button
      type="button"
      class={toolBtn}
      title="Revolve selected sketch"
      disabled={!enabled('sketch.revolve')}
      onclick={tool('sketch.revolve')}
    >
      <RotateCcw class="size-4" />
    </button>
    <button
      type="button"
      class={toolBtn}
      title="Sweep profile sketch along path"
      onclick={tool('sketch.sweep')}
    >
      <Hammer class="size-4" />
    </button>
    <button
      type="button"
      class={toolBtn}
      title="Loft between sketches"
      onclick={tool('sketch.loft')}
    >
      <Disc class="size-4" />
    </button>
    {/if}
  </div>

  <div class="mx-1 h-6 w-px bg-border"></div>

  <!-- ── 5. Modify ──────────────────────────────────────────────────── -->
  <div class="flex items-center gap-0.5">
    <button
      type="button"
      class={toolBtn}
      title="Fillet selected body"
      disabled={!enabled('modifier.fillet')}
      onclick={tool('modifier.fillet')}
    >
      <CircleDashed class="size-4" />
    </button>
    <button
      type="button"
      class={toolBtn}
      title="Chamfer selected body"
      disabled={!enabled('modifier.chamfer')}
      onclick={tool('modifier.chamfer')}
    >
      <Triangle class="size-4" />
    </button>
    <button
      type="button"
      class={toolBtn}
      title="Shell selected body"
      disabled={!enabled('modifier.shell')}
      onclick={tool('modifier.shell')}
    >
      <Container class="size-4" />
    </button>
    <button
      type="button"
      class={toolBtn}
      title="Hole on selected body"
      disabled={!enabled('modifier.hole')}
      onclick={tool('modifier.hole')}
    >
      <Drill class="size-4" />
    </button>
    <button
      type="button"
      class={toolBtn}
      title="Press-Pull a face (pick a face → enter distance)"
      onclick={tool('modifier.pressPull')}
    >
      <MoveDiagonal class="size-4" />
    </button>
    {#if !V1}
    <button
      type="button"
      class={toolBtn}
      title="Move Face (pick a face → enter vector)"
      onclick={tool('modifier.moveFace')}
    >
      <MoveDiagonal2 class="size-4" />
    </button>
    <button
      type="button"
      class={toolBtn}
      title="Delete Face (pick a face → kernel heals)"
      onclick={tool('modifier.deleteFace')}
    >
      <Eraser class="size-4" />
    </button>
    <button
      type="button"
      class={toolBtn}
      title="Offset Face (pick a face → enter distance)"
      onclick={tool('modifier.offsetFace')}
    >
      <BoxSelect class="size-4" />
    </button>
    <button
      type="button"
      class={toolBtn}
      title="Draft selected body"
      disabled={!enabled('modifier.draft')}
      onclick={tool('modifier.draft')}
    >
      <Slash class="size-4" />
    </button>
    {/if}
  </div>

  <div class="mx-1 h-6 w-px bg-border"></div>

  <!-- ── 6. Boolean ─────────────────────────────────────────────────── -->
  <div class="flex items-center gap-0.5">
    <button
      type="button"
      class={toolBtn}
      title="Union picked bodies"
      disabled={!enabled('bool.union')}
      onclick={tool('bool.union')}
    >
      <Plus class="size-4" />
    </button>
    <button
      type="button"
      class={toolBtn}
      title="Cut (first − rest)"
      disabled={!enabled('bool.cut')}
      onclick={tool('bool.cut')}
    >
      <Minus class="size-4" />
    </button>
    <button
      type="button"
      class={toolBtn}
      title="Intersect picked bodies"
      disabled={!enabled('bool.intersect')}
      onclick={tool('bool.intersect')}
    >
      <X class="size-4" />
    </button>
  </div>

  {#if !V1}
  <div class="mx-1 h-6 w-px bg-border"></div>

  <!-- ── 7. Reference geometry ──────────────────────────────────────── -->
  <div class="flex items-center gap-0.5">
    <button type="button" class={toolBtn} title="New reference plane" onclick={tool('ref.plane')}>
      <Square class="size-4" />
    </button>
    <button type="button" class={toolBtn} title="New reference axis" onclick={tool('ref.axis')}>
      <Slash class="size-4" />
    </button>
    <button type="button" class={toolBtn} title="New reference point" onclick={tool('ref.point')}>
      <Dot class="size-4" />
    </button>
  </div>

  <div class="mx-1 h-6 w-px bg-border"></div>

  <!-- ── 8. Pattern (no registry commands yet) ──────────────────────── -->
  <div class="flex items-center gap-0.5">
    <button
      type="button"
      class={toolBtn}
      title={exists('pattern.linear') ? 'Linear Pattern' : 'Linear Pattern — Coming soon'}
      disabled={!enabled('pattern.linear')}
      onclick={tool('pattern.linear')}
    >
      <AlignHorizontalDistributeCenter class="size-4" />
    </button>
    <button
      type="button"
      class={toolBtn}
      title={exists('pattern.circular') ? 'Circular Pattern' : 'Circular Pattern — Coming soon'}
      disabled={!enabled('pattern.circular')}
      onclick={tool('pattern.circular')}
    >
      <RotateCcw class="size-4" />
    </button>
    <button
      type="button"
      class={toolBtn}
      title={exists('pattern.mirror') ? 'Mirror' : 'Mirror — Coming soon'}
      disabled={!enabled('pattern.mirror')}
      onclick={tool('pattern.mirror')}
    >
      <FlipHorizontal2 class="size-4" />
    </button>
  </div>
  {/if}

  <div class="mx-1 h-6 w-px bg-border"></div>

  <!-- ── 9. Transform ───────────────────────────────────────────────── -->
  <div class="flex items-center gap-0.5">
    <button
      type="button"
      class={toolBtn}
      title="Move selected body"
      disabled={!enabled('xform.move')}
      onclick={tool('xform.move')}
    >
      <Move class="size-4" />
    </button>
    <button
      type="button"
      class={toolBtn}
      title="Rotate selected body"
      disabled={!enabled('xform.rotate')}
      onclick={tool('xform.rotate')}
    >
      <RotateCw class="size-4" />
    </button>
    <button
      type="button"
      class={toolBtn}
      title="Scale selected body"
      disabled={!enabled('xform.scale')}
      onclick={tool('xform.scale')}
    >
      <Maximize2 class="size-4" />
    </button>
    {#if !V1}
    <button
      type="button"
      class={toolBtn}
      title="Align bodies by named datums"
      disabled={!enabled('xform.align')}
      onclick={tool('xform.align')}
    >
      <AlignCenter class="size-4" />
    </button>
    {/if}
  </div>

  <div class="mx-1 h-6 w-px bg-border"></div>

  <!-- ── 9b. Tools (E4) — Measure / Section / Interference ────────── -->
  <div class="flex items-center gap-0.5">
    <button
      type="button"
      class={toolBtn}
      title="Measure (M) — pick two entities to measure distance, length, or area"
      disabled={!enabled('tools.measure')}
      onclick={tool('tools.measure')}
    >
      <Ruler class="size-4" />
    </button>
    <button
      type="button"
      class={toolBtn}
      title="Section view — show a cross-section through the model"
      disabled={!enabled('view.section.activate')}
      onclick={tool('view.section.activate')}
    >
      <Scissors class="size-4" />
    </button>
    {#if !V1}
    <button
      type="button"
      class={toolBtn}
      title="Check interference between picked bodies (need ≥2 picked)"
      disabled={!enabled('analyze.interference')}
      onclick={tool('analyze.interference')}
    >
      <Layers class="size-4" />
    </button>
    {/if}
  </div>

  <div class="mx-1 h-6 w-px bg-border"></div>

  <!-- ── 10. Insert / Import ────────────────────────────────────────── -->
  <div class="flex items-center gap-0.5">
    {#if !V1}
    <button
      type="button"
      class={toolBtn}
      title="Import CAD file (STEP / IGES / OBJ / GLTF / GLB)"
      onclick={() => fileInput?.click()}
    >
      <Upload class="size-4" />
    </button>
    <input
      bind:this={fileInput}
      type="file"
      accept=".step,.iges,.obj,.gltf,.glb,.stp"
      class="hidden"
      onchange={onPickFile}
    />
    <button
      type="button"
      class={toolBtn}
      title="New Script (build123d Python)"
      onclick={() => dialogs.openScript(null)}
    >
      <FileCode class="size-4" />
    </button>
    {/if}
    <button
      type="button"
      class={toolBtn}
      title="Insert Component"
      onclick={tool('component.create')}
    >
      <Boxes class="size-4" />
    </button>
  </div>

  <!-- ── Right-aligned: search ──────────────────────────────────────── -->
  <div class="ml-auto flex items-center gap-1.5">
    <div class="relative flex items-center">
      <Search class="pointer-events-none absolute left-2 size-3.5 text-muted-foreground" />
      <input
        type="text"
        placeholder="Search tools..."
        bind:value={searchValue}
        onfocus={onSearchFocus}
        onkeydown={onSearchKey}
        class="h-7 w-56 rounded border border-input bg-transparent pl-7 pr-3 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
      />
    </div>
  </div>
</div>
