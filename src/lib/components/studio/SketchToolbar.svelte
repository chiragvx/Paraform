<script>
  /**
   * Onshape-style icon ribbon for the active sketch.
   *
   * Single source of truth for sketch UI — replaces both the previous
   * mixed icon/text top row AND the floating bottom ribbon that the
   * legacy sketcher (app/sketch_3d/controller.js) used to inject.
   *
   * Layout (left → right):
   *   [Plane chip]  |  [Primitives]  [Rect group▾]  [Arc group▾]  [Pattern▾]
   *                 |  [Modify tools] [Derive] [Extrude] [Revolve] [Delete]
   *                 |  [Show toggles]                                 [✓] [✗]
   *
   * The constraint chips row appears CONDITIONALLY underneath when
   * `selCount >= 1`. The polygon-sides input appears CONDITIONALLY when
   * the polygon tool is active.
   *
   * Reactivity: the legacy sketcher doesn't publish into the Svelte
   * store on every tool/selection change, so we poll a single rAF tick
   * while the sketch is active. Store subscription still catches
   * enter/exit transitions cheaply.
   */
  import { onMount } from 'svelte';
  import { studio } from '$lib/studio/runtime.svelte.js';
  import { getDocumentStore } from '../../../../lib/document/index.js';
  import { cancelSketch, isSketchActive } from '$lib/sketch/boot.js';
  import { getActiveSketchController } from '../../../../app/sketch_3d/index.js';
  import { COMMANDS } from '$lib/commands/registry.js';
  import { dialogs } from '$lib/dialogs/dialogs.svelte.js';

  // ── Icons (lucide) ────────────────────────────────────────────────
  import X from '@lucide/svelte/icons/x';
  import Check from '@lucide/svelte/icons/check';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import Minus from '@lucide/svelte/icons/minus';
  import Circle from '@lucide/svelte/icons/circle';
  import Square from '@lucide/svelte/icons/square';
  import RectangleHorizontal from '@lucide/svelte/icons/rectangle-horizontal';
  import Hexagon from '@lucide/svelte/icons/hexagon';
  import Spline from '@lucide/svelte/icons/spline';
  import PenTool from '@lucide/svelte/icons/pen-tool';
  import Type from '@lucide/svelte/icons/type';
  import MousePointer2 from '@lucide/svelte/icons/mouse-pointer-2';
  import Orbit from '@lucide/svelte/icons/orbit';                 // arc-3point (close enough)
  import CornerDownRight from '@lucide/svelte/icons/corner-down-right'; // corner rect
  import CornerLeftUp from '@lucide/svelte/icons/corner-left-up';
  import Target from '@lucide/svelte/icons/target';               // center arc / center rect
  import Crop from '@lucide/svelte/icons/crop';                   // fillet (closest)
  import Scissors from '@lucide/svelte/icons/scissors';           // trim
  import Slash from '@lucide/svelte/icons/slash';                 // chamfer (angled cut)
  import Combine from '@lucide/svelte/icons/combine';             // extend
  import Copy from '@lucide/svelte/icons/copy';                   // offset
  import FlipHorizontal from '@lucide/svelte/icons/flip-horizontal'; // mirror
  import Grid3x3 from '@lucide/svelte/icons/grid-3x3';            // linear array
  import RotateCcw from '@lucide/svelte/icons/rotate-ccw';        // revolve / circular array
  import Box from '@lucide/svelte/icons/box';                     // extrude
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import Anchor from '@lucide/svelte/icons/anchor';
  import MoveHorizontal from '@lucide/svelte/icons/move-horizontal';
  import MoveVertical from '@lucide/svelte/icons/move-vertical';
  import Equal from '@lucide/svelte/icons/equal';
  import Lock from '@lucide/svelte/icons/lock';
  import Diff from '@lucide/svelte/icons/diff';                    // intersect
  import Share2 from '@lucide/svelte/icons/share-2';               // project
  import Ruler from '@lucide/svelte/icons/ruler';                  // dim

  // Derive from the reactive studio state (set by enterSketch / cleared by
  // Viewport.svelte on sketch exit). Polling `isSketchActive()` via rAF can
  // miss the first render — derive guarantees reactivity.
  const active = $derived(!!studio.activeSketchFeatureId || isSketchActive());
  let plane = $state('—');
  let activeTool = $state(null);
  let selCount = $state(0);
  let drivenDimMode = $state(false);
  let polygonSides = $state(6);

  // Dropdown popovers (Rect/Arc/Pattern groups).
  let openMenu = $state(null);   // 'rect' | 'arc' | 'pattern' | null
  let rootEl;                    // outer host — used for click-outside

  function readState() {
    const c = getActiveSketchController?.();
    plane = c?.planeName || c?.plane || '—';
    activeTool = c?.activeTool || null;
    selCount = c?.selectionSize ?? 0;
    drivenDimMode = !!c?._drivenDimMode;
    if (c && Number.isFinite(c.polygonSides)) polygonSides = c.polygonSides;
  }

  onMount(() => {
    readState();
    const store = getDocumentStore();
    const unsub = store.subscribe(() => readState());
    let raf = 0;
    let stopped = false;
    const tick = () => {
      if (stopped) return;
      readState();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    const onDocClick = (ev) => {
      if (!openMenu) return;
      if (rootEl && rootEl.contains(ev.target)) return;
      openMenu = null;
    };
    window.addEventListener('mousedown', onDocClick, true);

    return () => {
      stopped = true;
      if (raf) cancelAnimationFrame(raf);
      unsub();
      window.removeEventListener('mousedown', onDocClick, true);
    };
  });

  function ctrl() { return getActiveSketchController?.(); }

  function setTool(tool) {
    ctrl()?.setTool(tool);
    openMenu = null;
    readState();
  }

  function applyConstraint(kind) {
    ctrl()?.applyConstraint(kind);
    readState();
  }

  function toggleDrivenDim() {
    ctrl()?.toggleDrivenDimMode();
    readState();
  }

  function cyclePlane() {
    const c = ctrl();
    if (!c) return;
    const order = ['XY', 'XZ', 'YZ'];
    const i = order.indexOf(c.planeName);
    const next = order[(i + 1) % order.length] || 'XY';
    c.setPlane(next);
    readState();
  }

  function commitFinish()  { ctrl()?.finish(); }
  function commitCancel()  { cancelSketch(); readState(); }

  function deleteSelected() { ctrl()?.deleteSelected(); readState(); }

  function openCommandForm(id) {
    const cmd = COMMANDS.find((c) => c.id === id);
    if (!cmd) return;
    dialogs.openForm(cmd);
  }

  function setPolygonSides(n) {
    const v = Math.max(3, Math.min(64, parseInt(n, 10) || 6));
    polygonSides = v;
    const c = ctrl();
    if (c) c.polygonSides = v;
  }

  // ── Project / Intersect (sketcher hook may be pending) ──────────
  let pendingHookNotice = $state(null);
  let pendingHookTimer = null;
  function flashPending(msg) {
    pendingHookNotice = msg;
    if (pendingHookTimer) clearTimeout(pendingHookTimer);
    pendingHookTimer = setTimeout(() => { pendingHookNotice = null; }, 4000);
  }
  function startProject() {
    studio.startFacePick({
      purpose: 'project',
      accept: ['face', 'edge'],
      onPick: (desc) => {
        const c = ctrl();
        if (c && typeof c.addProjectedEdge === 'function') c.addProjectedEdge(desc);
        else flashPending('Project Geometry: pick stored — projection lands when the sketcher hook ships.');
      },
      onCancel: () => {},
    });
  }
  function startIntersect() {
    studio.startFacePick({
      purpose: 'intersect',
      accept: ['face'],
      onPick: (desc) => {
        const c = ctrl();
        if (c && typeof c.addIntersectionCurve === 'function') c.addIntersectionCurve(desc);
        else flashPending('Intersect Geometry: pick stored — intersection lands when the sketcher hook ships.');
      },
      onCancel: () => {},
    });
  }

  // ── Styling tokens — match the rest of the viewport HUD ──────────
  // size-8 (32px) icon buttons. backdrop-blur + bg-card border.
  const BTN     = 'inline-flex size-8 items-center justify-center rounded border border-transparent text-muted-foreground hover:bg-accent hover:text-foreground transition-colors';
  const BTN_ON  = 'inline-flex size-8 items-center justify-center rounded border border-border bg-accent text-foreground transition-colors';
  const SPLIT_WRAP_OFF = 'inline-flex items-center rounded border border-transparent hover:bg-accent transition-colors';
  const SPLIT_WRAP_ON  = 'inline-flex items-center rounded border border-border bg-accent text-foreground transition-colors';
  const ICON    = 'size-4';
  const SMALL_ICON = 'size-3';
  const CHIP    = 'inline-flex items-center gap-1 rounded border border-border bg-background/40 px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed transition-colors';
  const CHIP_ON = 'inline-flex items-center gap-1 rounded border border-border bg-accent px-2 py-1 text-[11px] text-foreground transition-colors';

  const CONSTRAINT_MIN_SEL = {
    coincident: 2, horizontal: 1, vertical: 1,
    parallel: 2, perpendicular: 2, equal: 2, fix: 0,
  };

  // Group activeness for split-button styling.
  const isRectActive = $derived(activeTool === 'rect');
  const isArcActive = $derived(
    activeTool === 'arc-tangent' || activeTool === 'arc-3point' || activeTool === 'arc-center'
  );
  const isPatternActive = $derived(
    activeTool === 'pattern-linear' || activeTool === 'pattern-circular'
  );

  // Per-group "current" tool (the icon shown on the main split button).
  let rectCurrent = $state('rect');         // 'rect' only for now (center-rect not in TOOL_LIST)
  let arcCurrent = $state('arc-tangent');
  let patternCurrent = $state('pattern-linear');

  function pickRect(k) { rectCurrent = k; setTool(k); }
  function pickArc(k)  { arcCurrent = k;  setTool(k); }
  function pickPat(k)  { patternCurrent = k; setTool(k); }
</script>

{#if active}
  <div
    bind:this={rootEl}
    class="flex shrink-0 flex-col gap-1 border-b border-border bg-card/80 px-2 py-1 backdrop-blur-sm"
  >
    <!-- ── Main ribbon row ──────────────────────────────────────── -->
    <div class="flex h-9 items-center gap-1">
      <!-- Plane chip (left) -->
      <button
        type="button"
        class="inline-flex h-7 items-center gap-1 rounded border border-border bg-background/40 px-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
        onclick={cyclePlane}
        title="Sketch plane — click to cycle XY → XZ → YZ"
      >
        <span>Plane:</span>
        <span class="text-foreground">{plane}</span>
      </button>

      <div class="mx-1 h-5 w-px bg-border"></div>

      <!-- Select tool -->
      <button type="button" class={activeTool === 'select' || activeTool === null ? BTN_ON : BTN}
        onclick={() => setTool('select')} title="Select (V)" aria-label="Select">
        <MousePointer2 class={ICON} />
      </button>

      <!-- Line -->
      <button type="button" class={activeTool === 'line' ? BTN_ON : BTN}
        onclick={() => setTool('line')} title="Line (L)" aria-label="Line">
        <Minus class={ICON} />
      </button>

      <!-- Rectangle group (single split-button — only one variant available today) -->
      <div class={isRectActive ? SPLIT_WRAP_ON : SPLIT_WRAP_OFF}>
        <button type="button"
          class="inline-flex size-8 items-center justify-center text-muted-foreground hover:text-foreground"
          class:text-foreground={isRectActive}
          onclick={() => setTool(rectCurrent)}
          title="Rectangle (R)" aria-label="Rectangle">
          <RectangleHorizontal class={ICON} />
        </button>
        <button type="button"
          class="inline-flex h-8 w-4 items-center justify-center text-muted-foreground hover:text-foreground"
          onclick={(e) => { e.stopPropagation(); openMenu = openMenu === 'rect' ? null : 'rect'; }}
          title="Rectangle variants" aria-label="Rectangle variants" aria-expanded={openMenu === 'rect'}>
          <ChevronDown class={SMALL_ICON} />
        </button>
      </div>

      <!-- Circle -->
      <button type="button" class={activeTool === 'circle' ? BTN_ON : BTN}
        onclick={() => setTool('circle')} title="Circle (C)" aria-label="Circle">
        <Circle class={ICON} />
      </button>

      <!-- Polygon -->
      <button type="button" class={activeTool === 'polygon' ? BTN_ON : BTN}
        onclick={() => setTool('polygon')} title="Polygon (P)" aria-label="Polygon">
        <Hexagon class={ICON} />
      </button>

      <!-- Slot -->
      <button type="button" class={activeTool === 'slot' ? BTN_ON : BTN}
        onclick={() => setTool('slot')} title="Slot (S)" aria-label="Slot">
        <RectangleHorizontal class={ICON} />
      </button>

      <!-- Spline -->
      <button type="button" class={activeTool === 'spline' ? BTN_ON : BTN}
        onclick={() => setTool('spline')} title="Spline (N)" aria-label="Spline">
        <Spline class={ICON} />
      </button>

      <!-- Arc group (split-button + caret) -->
      <div class={isArcActive ? SPLIT_WRAP_ON : SPLIT_WRAP_OFF}>
        <button type="button"
          class="inline-flex size-8 items-center justify-center text-muted-foreground hover:text-foreground"
          class:text-foreground={isArcActive}
          onclick={() => setTool(arcCurrent)}
          title={arcCurrent === 'arc-3point' ? '3-Point Arc (H)' : arcCurrent === 'arc-center' ? 'Center Arc (J)' : 'Tangent Arc (G)'}
          aria-label="Arc">
          {#if arcCurrent === 'arc-3point'}
            <Orbit class={ICON} />
          {:else if arcCurrent === 'arc-center'}
            <Target class={ICON} />
          {:else}
            <PenTool class={ICON} />
          {/if}
        </button>
        <button type="button"
          class="inline-flex h-8 w-4 items-center justify-center text-muted-foreground hover:text-foreground"
          onclick={(e) => { e.stopPropagation(); openMenu = openMenu === 'arc' ? null : 'arc'; }}
          title="Arc variants" aria-label="Arc variants" aria-expanded={openMenu === 'arc'}>
          <ChevronDown class={SMALL_ICON} />
        </button>
      </div>

      <!-- Text -->
      <button type="button" class={activeTool === 'text' ? BTN_ON : BTN}
        onclick={() => setTool('text')} title="Text (Y)" aria-label="Text">
        <Type class={ICON} />
      </button>

      <div class="mx-1 h-5 w-px bg-border"></div>

      <!-- Dim -->
      <button type="button" class={activeTool === 'dim' ? BTN_ON : BTN}
        onclick={() => setTool('dim')} title="Dimension (D)" aria-label="Dimension">
        <Ruler class={ICON} />
      </button>

      <!-- Fillet -->
      <button type="button" class={activeTool === 'fillet' ? BTN_ON : BTN}
        onclick={() => setTool('fillet')} title="Fillet (F)" aria-label="Fillet">
        <CornerLeftUp class={ICON} />
      </button>

      <!-- Chamfer -->
      <button type="button" class={activeTool === 'chamfer' ? BTN_ON : BTN}
        onclick={() => setTool('chamfer')} title="Chamfer (K)" aria-label="Chamfer">
        <Slash class={ICON} />
      </button>

      <!-- Offset -->
      <button type="button" class={activeTool === 'offset' ? BTN_ON : BTN}
        onclick={() => setTool('offset')} title="Offset (O)" aria-label="Offset">
        <Copy class={ICON} />
      </button>

      <!-- Trim -->
      <button type="button" class={activeTool === 'trim' ? BTN_ON : BTN}
        onclick={() => setTool('trim')} title="Trim (T)" aria-label="Trim">
        <Scissors class={ICON} />
      </button>

      <!-- Extend -->
      <button type="button" class={activeTool === 'extend' ? BTN_ON : BTN}
        onclick={() => setTool('extend')} title="Extend (E)" aria-label="Extend">
        <Combine class={ICON} />
      </button>

      <!-- Mirror -->
      <button type="button" class={activeTool === 'mirror' ? BTN_ON : BTN}
        onclick={() => setTool('mirror')} title="Mirror (M)" aria-label="Mirror">
        <FlipHorizontal class={ICON} />
      </button>

      <!-- Pattern group (split-button + caret) -->
      <div class={isPatternActive ? SPLIT_WRAP_ON : SPLIT_WRAP_OFF}>
        <button type="button"
          class="inline-flex size-8 items-center justify-center text-muted-foreground hover:text-foreground"
          class:text-foreground={isPatternActive}
          onclick={() => setTool(patternCurrent)}
          title={patternCurrent === 'pattern-circular' ? 'Circular Pattern (X)' : 'Linear Pattern (A)'}
          aria-label="Pattern">
          {#if patternCurrent === 'pattern-circular'}
            <RotateCcw class={ICON} />
          {:else}
            <Grid3x3 class={ICON} />
          {/if}
        </button>
        <button type="button"
          class="inline-flex h-8 w-4 items-center justify-center text-muted-foreground hover:text-foreground"
          onclick={(e) => { e.stopPropagation(); openMenu = openMenu === 'pattern' ? null : 'pattern'; }}
          title="Pattern variants" aria-label="Pattern variants" aria-expanded={openMenu === 'pattern'}>
          <ChevronDown class={SMALL_ICON} />
        </button>
      </div>

      <div class="mx-1 h-5 w-px bg-border"></div>

      <!-- Project / Intersect — disabled: the sketcher hook that turns the
           picked face/edge into projected/intersection geometry hasn't shipped,
           so these would no-op. Disabled (not hidden) to keep the slot. -->
      <button type="button" class={`${BTN} opacity-40 cursor-not-allowed`} disabled onclick={startProject}
        title="Project geometry — coming soon" aria-label="Project geometry (coming soon)">
        <Share2 class={ICON} />
      </button>
      <button type="button" class={`${BTN} opacity-40 cursor-not-allowed`} disabled onclick={startIntersect}
        title="Intersect geometry — coming soon" aria-label="Intersect geometry (coming soon)">
        <Diff class={ICON} />
      </button>

      <div class="mx-1 h-5 w-px bg-border"></div>

      <!-- Extrude / Revolve / Delete -->
      <button type="button" class={BTN} onclick={() => openCommandForm('sketch.extrude')}
        title="Extrude sketch" aria-label="Extrude">
        <Box class={ICON} />
      </button>
      <button type="button" class={BTN} onclick={() => openCommandForm('sketch.revolve')}
        title="Revolve sketch" aria-label="Revolve">
        <RotateCcw class={ICON} />
      </button>
      <button type="button" class={BTN} disabled={selCount === 0}
        onclick={deleteSelected} title="Delete selected (Del)" aria-label="Delete selected">
        <Trash2 class={ICON} />
      </button>

      <!-- spacer pushes the right cluster to the edge -->
      <div class="ml-auto flex items-center gap-1">
        <!-- Polygon-sides contextual input (only when polygon active) -->
        {#if activeTool === 'polygon'}
          <label class="inline-flex items-center gap-1 rounded border border-border bg-background/40 px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground">
            Sides
            <input
              type="number" min="3" max="64"
              class="w-12 rounded bg-transparent text-foreground outline-none"
              value={polygonSides}
              oninput={(e) => setPolygonSides(e.currentTarget.value)}
            />
          </label>
        {/if}

        {#if pendingHookNotice}
          <span class="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[10px] text-amber-700 dark:text-amber-300">
            {pendingHookNotice}
          </span>
        {/if}

        <!-- Show-constraints / expressions / errors toggles were removed:
             the sketch renderer has no visibility gate to drive, so they only
             flipped local state. Re-add when the controller hooks exist. -->

        <!-- Done / Cancel (primary actions) -->
        <button
          type="button"
          class="inline-flex size-8 items-center justify-center rounded border border-emerald-500/40 bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/20 dark:text-emerald-300 transition-colors"
          onclick={commitFinish}
          title="Finish sketch (Enter)" aria-label="Finish sketch"
        >
          <Check class={ICON} />
        </button>
        <button
          type="button"
          class="inline-flex size-8 items-center justify-center rounded border border-red-500/40 bg-red-500/10 text-red-700 hover:bg-red-500/20 dark:text-red-300 transition-colors"
          onclick={commitCancel}
          title="Cancel sketch (Esc)" aria-label="Cancel sketch"
        >
          <X class={ICON} />
        </button>
      </div>
    </div>

    <!-- ── Contextual constraint chips row ────────────────────────── -->
    {#if selCount >= 1}
      <div class="flex h-7 items-center gap-1">
        <span class="mr-1 text-[10px] uppercase tracking-wider text-muted-foreground">
          Constraints · {selCount} sel
        </span>
        <button type="button" class={CHIP} disabled={selCount < CONSTRAINT_MIN_SEL.coincident}
          onclick={() => applyConstraint('coincident')} title="Coincident">
          <Anchor class={SMALL_ICON} />
          <span>Coincident</span>
        </button>
        <button type="button" class={CHIP} disabled={selCount < CONSTRAINT_MIN_SEL.horizontal}
          onclick={() => applyConstraint('horizontal')} title="Horizontal">
          <MoveHorizontal class={SMALL_ICON} />
          <span>Horizontal</span>
        </button>
        <button type="button" class={CHIP} disabled={selCount < CONSTRAINT_MIN_SEL.vertical}
          onclick={() => applyConstraint('vertical')} title="Vertical">
          <MoveVertical class={SMALL_ICON} />
          <span>Vertical</span>
        </button>
        <button type="button" class={CHIP} disabled={selCount < CONSTRAINT_MIN_SEL.parallel}
          onclick={() => applyConstraint('parallel')} title="Parallel">
          <span class="font-mono">∥</span><span>Parallel</span>
        </button>
        <button type="button" class={CHIP} disabled={selCount < CONSTRAINT_MIN_SEL.perpendicular}
          onclick={() => applyConstraint('perpendicular')} title="Perpendicular">
          <span class="font-mono">⊥</span><span>Perpendicular</span>
        </button>
        <button type="button" class={CHIP} disabled={selCount < CONSTRAINT_MIN_SEL.equal}
          onclick={() => applyConstraint('equal')} title="Equal">
          <Equal class={SMALL_ICON} />
          <span>Equal</span>
        </button>
        <button type="button" class={activeTool === 'dim' ? CHIP_ON : CHIP}
          onclick={() => applyConstraint('fix')} title="Fix dimension (switches to Dim tool)">
          <Lock class={SMALL_ICON} />
          <span>Fix</span>
        </button>
        <button type="button" class={drivenDimMode ? CHIP_ON : CHIP}
          onclick={toggleDrivenDim} title="Driven (reference) dim — next dim is display-only">
          <Ruler class={SMALL_ICON} />
          <span>Driven</span>
        </button>
      </div>
    {/if}

    <!-- ── Dropdown popovers ────────────────────────────────────── -->
    {#if openMenu === 'rect'}
      <div class="absolute z-30 mt-9 flex flex-col rounded border border-border bg-popover p-1 shadow-md">
        <button type="button"
          class="flex items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-foreground hover:bg-accent"
          onclick={() => pickRect('rect')}>
          <CornerDownRight class={ICON} />
          <span>Corner Rectangle</span>
          <span class="ml-auto font-mono text-[10px] text-muted-foreground">R</span>
        </button>
      </div>
    {/if}

    {#if openMenu === 'arc'}
      <div class="absolute z-30 mt-9 flex flex-col rounded border border-border bg-popover p-1 shadow-md">
        <button type="button"
          class="flex items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-foreground hover:bg-accent"
          onclick={() => pickArc('arc-tangent')}>
          <PenTool class={ICON} />
          <span>Tangent Arc</span>
          <span class="ml-auto font-mono text-[10px] text-muted-foreground">G</span>
        </button>
        <button type="button"
          class="flex items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-foreground hover:bg-accent"
          onclick={() => pickArc('arc-3point')}>
          <Orbit class={ICON} />
          <span>3-Point Arc</span>
          <span class="ml-auto font-mono text-[10px] text-muted-foreground">H</span>
        </button>
        <button type="button"
          class="flex items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-foreground hover:bg-accent"
          onclick={() => pickArc('arc-center')}>
          <Target class={ICON} />
          <span>Center Arc</span>
          <span class="ml-auto font-mono text-[10px] text-muted-foreground">J</span>
        </button>
      </div>
    {/if}

    {#if openMenu === 'pattern'}
      <div class="absolute z-30 mt-9 flex flex-col rounded border border-border bg-popover p-1 shadow-md">
        <button type="button"
          class="flex items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-foreground hover:bg-accent"
          onclick={() => pickPat('pattern-linear')}>
          <Grid3x3 class={ICON} />
          <span>Linear Pattern</span>
          <span class="ml-auto font-mono text-[10px] text-muted-foreground">A</span>
        </button>
        <button type="button"
          class="flex items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-foreground hover:bg-accent"
          onclick={() => pickPat('pattern-circular')}>
          <RotateCcw class={ICON} />
          <span>Circular Pattern</span>
          <span class="ml-auto font-mono text-[10px] text-muted-foreground">X</span>
        </button>
      </div>
    {/if}
  </div>
{/if}
