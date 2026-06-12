<script>
  /**
   * Studio left panel — unified document tree.
   *
   *   ┌────────────────────────────────┐
   *   │ [filter…]                      │
   *   ├────────────────────────────────┤
   *   │ DOCUMENT (N)   [+comp][+][⌚]  │
   *   │ ▾ ▣ root            (active)   │
   *   │     ▾ Default geometry         │
   *   │       ◎ Origin  ▢ Top …        │
   *   │     • Sketch 1                 │
   *   │     ▤ 2020 extrusion           │   ← raw part: ONE row, no folder
   *   │   ▾ ⧉ Frame group              │   ← created when a part gains a child
   *   │       ▤ 2020 extrusion         │
   *   │       ▾ ▤ Corner bracket       │   ← cascading levels inside a group
   *   │           ▤ M5 t-nut           │
   *   │ Parameters (N)                 │
   *   ├────────────────────────────────┤
   *   │ Library ▾                      │
   *   ├────────────────────────────────┤
   *   │ [DocName] [CAD Imports] [+]    │
   *   └────────────────────────────────┘
   *
   * Three row kinds:
   *   component — root, user folders, and groups (kind:'group'). Groups are
   *               auto-created the first time a raw part is made a parent.
   *   part      — a component whose payload is a single body feature
   *               (library drops). Rendered MERGED as one selectable row —
   *               never a folder wrapping its own extrusion.
   *   feature   — everything else (sketches, extrudes, scripts …), nested
   *               under its owning component.
   *
   * Grouping rules (drag a part row onto another):
   *   • onto a bare part            → new group wraps both (target first).
   *   • onto a part inside a group,
   *     or one that already has kids → nests under it (cascading level).
   *   • onto a group / folder / root → joins it.
   * Deleting a parent orphans its children — the first child is promoted
   * into its place (removeComponentPromote). Groups offer right-click
   * "Ungroup…" (confirm) to dissolve; deleting a group deletes its contents.
   */
  import { onMount } from 'svelte';
  import {
    getDocumentStore,
    componentChildren,
    addComponent,
    removeComponent,
    removeComponentPromote,
    ungroupComponent,
    groupComponents,
    renameComponent,
    setComponentParent,
    setFeatureEnabled,
    deleteFeature,
    setFeatureComponent,
    renameFeatureChange,
  } from '../../../../lib/document/index.js';
  import { canReparentFeature, canReparentComponent } from '$lib/document/reparent.js';
  import { studio } from '$lib/studio/runtime.svelte.js';
  import { togglePanel } from '$lib/studio/panels.svelte.js';
  import { dialogs } from '$lib/dialogs/dialogs.svelte.js';
  import { palette } from '$lib/commands/palette.svelte.js';
  import { enterSketch } from '$lib/sketch/boot.js';
  import LibraryPalette from './LibraryPalette.svelte';
  import TreeContextMenu from './TreeContextMenu.svelte';
  import TimelineScrub from './TimelineScrub.svelte';
  import { V1 } from '$lib/flags.js';

  import Search from '@lucide/svelte/icons/search';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import Plus from '@lucide/svelte/icons/plus';
  import Timer from '@lucide/svelte/icons/timer';
  import Eye from '@lucide/svelte/icons/eye';
  import EyeOff from '@lucide/svelte/icons/eye-off';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import Crosshair from '@lucide/svelte/icons/crosshair';
  import Square from '@lucide/svelte/icons/square';
  import Box from '@lucide/svelte/icons/box';
  import Boxes from '@lucide/svelte/icons/boxes';
  import Cylinder from '@lucide/svelte/icons/cylinder';
  import Circle from '@lucide/svelte/icons/circle';
  import Layers from '@lucide/svelte/icons/layers';
  import Spline from '@lucide/svelte/icons/spline';
  import RotateCw from '@lucide/svelte/icons/rotate-cw';
  import Move from '@lucide/svelte/icons/move';
  import Maximize2 from '@lucide/svelte/icons/maximize-2';
  import Grid3x3 from '@lucide/svelte/icons/grid-3x3';
  import FlipHorizontal from '@lucide/svelte/icons/flip-horizontal';
  import Combine from '@lucide/svelte/icons/combine';
  import Scissors from '@lucide/svelte/icons/scissors';
  import Donut from '@lucide/svelte/icons/donut';
  import Brick from '@lucide/svelte/icons/brick-wall';
  import FileBox from '@lucide/svelte/icons/file-box';
  import FileCode from '@lucide/svelte/icons/file-code';

  // ── Feature-type → icon ────────────────────────────────────────────────
  const ICONS = {
    Box, Cylinder, Sphere: Circle, Torus: Donut,
    Sketch: Layers, SketchOnFace: Layers, ProjectEdges: Layers,
    Extrude: Box, Revolve: Cylinder, Sweep: Spline, Loft: Layers, Helix: Spline,
    ImportSTEP: FileBox,
    BuildScript: FileCode,
    StandardPart: Brick,
    Fillet: Circle, Chamfer: Circle, Shell: Circle, Draft: Circle,
    Hole: Circle, Thread: Circle, Offset3D: Circle,
    LinearPattern: Grid3x3, CircularPattern: Grid3x3, PathPattern: Grid3x3,
    Mirror: FlipHorizontal,
    Union: Combine, Cut: Scissors, Intersect: Combine, Split: Scissors,
    Move, Rotate: RotateCw, Scale: Maximize2, Align: Move,
    Plane: Square, Axis: Spline, Point: Crosshair,
  };

  // ── Reactive view-model, rebuilt on every store tick ───────────────────
  let tick = $state(0);
  let filter = $state('');
  let store = $state(null);

  onMount(() => {
    store = getDocumentStore();
    tick++;
    const unsub = store.subscribe(() => { tick++; });
    return unsub;
  });

  // `tick` bumps on every store commit/select (see subscribe above). Because
  // `store.commit()` mutates `store.doc` IN PLACE (same object reference), a
  // `$derived` that only reads `doc` never re-runs — its tracked value never
  // changes identity. So every list/value derived below must also read
  // `_bump` to recompute on commits.
  const _bump = $derived(tick);

  const doc = $derived(store?.doc);
  const activeCid = $derived(studio.activeComponentId);
  const selectedId = $derived.by(() => { void _bump; return store?.selectedFeatureId() ?? null; });

  // Per-component collapsed state. Default open; a filter forces everything
  // open so matches are never hidden inside a collapsed subtree.
  let collapsed = $state({});
  function toggleOpen(id) {
    collapsed = { ...collapsed, [id]: !collapsed[id] };
  }

  /**
   * Unified tree, flattened to rows for a trivial {#each}:
   *   { kind: 'component', id, name, depth, open, isGroup, count, hasChildren }
   *   { kind: 'part', id, name, depth, open, feature, hasChildren }
   *   { kind: 'feature', feature, depth, componentId, componentName, isBody }
   * A component owning a single body feature collapses into one 'part' row
   * (the merged raw-part row); any extra features it holds nest below it.
   * With a filter, a row survives if its name (or its body's name) matches
   * or any descendant matches; a matched node keeps all its features.
   */
  const rows = $derived.by(() => {
    void _bump; // recompute on every commit (doc mutates in place)
    if (!doc?.components) return [];
    const q = filter.trim().toLowerCase();

    const featsByComp = Object.create(null);
    for (const id of doc.featureOrder || []) {
      const f = doc.features?.[id];
      if (!f) continue;
      const cid = f.componentId || 'root';
      (featsByComp[cid] ??= []).push(f);
    }

    const isBodyFeat = (f) => Array.isArray(f.outputs?.bodies) && f.outputs.bodies.length > 0;

    const visit = (cid, depth) => {
      const node = doc.components[cid];
      if (!node) return null;
      const isGroup = node.kind === 'group';
      const name = node.name || cid;
      const feats = featsByComp[cid] || [];
      // Raw part: merge the component with its single body feature into one
      // row. Only when the body is the component's whole payload — extra
      // features keep it a part row but nest below it.
      const primary = (cid !== 'root' && !isGroup) ? (feats.find(isBodyFeat) || null) : null;
      const restFeats = primary ? feats.filter((f) => f !== primary) : feats;

      const selfMatch = !q
        || name.toLowerCase().includes(q)
        || (primary ? (primary.name || primary.type || '').toLowerCase().includes(q) : false);
      const shownFeats = (!q || selfMatch)
        ? restFeats
        : restFeats.filter((f) => (f.name || f.type || '').toLowerCase().includes(q));

      const kidRows = [];
      let kidCount = 0;
      for (const c of componentChildren(doc, cid) || []) {
        kidCount++;
        const sub = visit(c.id, depth + 1);
        if (sub) kidRows.push(...sub);
      }

      if (q && !selfMatch && shownFeats.length === 0 && kidRows.length === 0) return null;

      const open = q ? true : !collapsed[cid];
      const hasChildren = restFeats.length > 0 || kidCount > 0;
      const head = primary
        ? { kind: 'part', id: cid, name, depth, open, feature: primary, hasChildren }
        : {
            kind: 'component', id: cid, name, depth, open, isGroup,
            count: isGroup ? kidCount : feats.length, hasChildren,
          };
      const out = [head];
      if (open) {
        for (const f of shownFeats) {
          out.push({
            kind: 'feature',
            feature: f,
            depth: depth + 1,
            componentId: cid,
            componentName: name,
            isBody: isBodyFeat(f),
          });
        }
        out.push(...kidRows);
      }
      return out;
    };
    return visit('root', 0) || [];
  });

  const featureTotal = $derived.by(() => { void _bump; return (doc?.featureOrder || []).length; });
  const paramCount = $derived.by(() => { void _bump; return Object.keys(doc?.parameters ?? {}).length; });
  const docName = $derived.by(() => { void _bump; return doc?.metadata?.name || 'Document'; });

  const activePathLabel = $derived.by(() => {
    void _bump;
    if (!doc) return '';
    const path = studio.getActiveComponentPath?.() || [];
    return path.map((id) => doc.components?.[id]?.name || id).join(' / ');
  });

  // When a filter is active, force default-geometry group open. We bind to
  // a writable `let` and clobber it whenever the filter flips.
  let geomOpen = $state(true);
  $effect(() => {
    if (filter.trim()) geomOpen = true;
  });

  // ── Feature actions ─────────────────────────────────────────────────────
  function selectFeature(id) {
    store?.selectFeature(id);
  }

  function toggleVisible(e, feature) {
    e.stopPropagation();
    setFeatureEnabled(feature.id, !(feature.enabled !== false));
  }

  function onDeleteFeature(e, feature) {
    e.stopPropagation();
    deleteFeature(feature.id);
  }

  function openAddPalette() {
    palette.query = 'Add ';
    palette.open = true;
  }

  // ── Component / part / group actions ────────────────────────────────────
  function activate(id) {
    studio.setActiveComponent(id);
  }

  function addComponentPrompt() {
    const name = window.prompt('Component name?', 'Component');
    if (!name) return;
    addComponent({ name: name.trim(), parentId: studio.activeComponentId || 'root' });
  }

  function promptRenameComponent(row) {
    const name = window.prompt('Rename', row.name);
    if (!name) return;
    const trimmed = name.trim();
    if (!trimmed || trimmed === row.name) return;
    renameComponent(row.id, trimmed);
  }

  /** Delete a part/component, promoting its first child into its place. */
  async function deletePromoting(row) {
    if (row.id === 'root') return;
    const kids = componentChildren(store?.doc, row.id) || [];
    const ok = await dialogs.askConfirm({
      title: `Delete "${row.name}"?`,
      message: kids.length
        ? 'Its body will be removed. Children are kept — the first child takes its place in the tree.'
        : (row.kind === 'part'
            ? 'Its body will be removed from the viewport.'
            : 'Features inside it will move to its parent.'),
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
      danger: true,
    });
    if (!ok) return;
    if (studio.activeComponentId === row.id) studio.setActiveComponent('root');
    removeComponentPromote(row.id);
  }

  /** Delete a group AND everything inside it. */
  async function deleteGroup(row) {
    const ok = await dialogs.askConfirm({
      title: `Delete group "${row.name}"?`,
      message: 'Everything inside the group will be deleted. Use "Ungroup" instead to keep the members.',
      confirmLabel: 'Delete all',
      cancelLabel: 'Cancel',
      danger: true,
    });
    if (!ok) return;
    if (studio.activeComponentId === row.id) studio.setActiveComponent('root');
    removeComponent(row.id);
  }

  /** Dissolve a group; members move up one level. */
  async function ungroupRow(row) {
    const ok = await dialogs.askConfirm({
      title: `Ungroup "${row.name}"?`,
      message: 'The group is removed and its members move up one level. Bodies are kept.',
      confirmLabel: 'Ungroup',
      cancelLabel: 'Cancel',
    });
    if (!ok) return;
    if (studio.activeComponentId === row.id) studio.setActiveComponent('root');
    ungroupComponent(row.id);
  }

  function onDeleteNode(e, row) {
    e.stopPropagation();
    if (row.kind === 'component' && row.isGroup) deleteGroup(row);
    else deletePromoting(row);
  }

  // Timeline scrub visibility toggle. Roll-marker icon button flips the
  // inline TimelineScrub component on/off.
  let scrubOpen = $state(false);
  function rollMarker() {
    scrubOpen = !scrubOpen;
  }

  // ── Context menus (one generic menu, items per row kind) ─────────────────
  // ctxMenu = { x, y, items, row } | null
  let ctxMenu = $state(null);
  function closeContextMenu() { ctxMenu = null; }

  function openContextMenu(e, row) {
    e.preventDefault();
    e.stopPropagation();
    let items;
    if (row.kind === 'feature') {
      items = [
        { id: 'rename', label: 'Rename' },
        { id: 'toggleSuppress', label: row.feature.enabled === false ? 'Unsuppress' : 'Suppress' },
        { id: 'rollbackTo', label: 'Roll back to here' },
        { id: 'edit', label: 'Edit…' },
        { divider: true },
        { id: 'delete', label: 'Delete', danger: true },
      ];
    } else if (row.kind === 'part') {
      items = [
        { id: 'rename', label: 'Rename' },
        { id: 'activate', label: 'Activate' },
        { id: 'toggleSuppress', label: row.feature.enabled === false ? 'Unsuppress' : 'Suppress' },
        { id: 'rollbackTo', label: 'Roll back to here' },
        { divider: true },
        { id: 'delete', label: 'Delete', danger: true },
      ];
    } else if (row.isGroup) {
      items = [
        { id: 'rename', label: 'Rename' },
        { id: 'activate', label: 'Activate' },
        { id: 'ungroup', label: 'Ungroup…' },
        { divider: true },
        { id: 'delete', label: 'Delete group…', danger: true },
      ];
    } else {
      items = [
        { id: 'rename', label: 'Rename' },
        { id: 'activate', label: 'Activate' },
        ...(row.id !== 'root' ? [{ divider: true }, { id: 'delete', label: 'Delete', danger: true }] : []),
      ];
    }
    ctxMenu = { x: e.clientX, y: e.clientY, items, row };
  }

  function handleCtxAction(action) {
    const row = ctxMenu?.row;
    if (!row) return;
    const feature = row.feature || null;

    if (action === 'rename') {
      if (row.kind === 'feature') {
        const next = window.prompt('Rename feature', feature.name || feature.type);
        if (next && next.trim()) store?.commit(renameFeatureChange(feature.id, next.trim()));
      } else {
        promptRenameComponent(row);
      }
    } else if (action === 'activate') {
      activate(row.id);
    } else if (action === 'toggleSuppress') {
      setFeatureEnabled(feature.id, feature.enabled === false);
    } else if (action === 'rollbackTo') {
      studio.rollbackHead = feature.id;
      try { studio.applyRollback?.(); } catch {}
      scrubOpen = true;
    } else if (action === 'ungroup') {
      ungroupRow(row);
    } else if (action === 'delete') {
      if (row.kind === 'feature') deleteFeature(feature.id);
      else if (row.kind === 'component' && row.isGroup) deleteGroup(row);
      else deletePromoting(row);
    } else if (action === 'edit') {
      // Dispatch to the BuildScript dialog for scripts, palette for others.
      if (feature?.type === 'BuildScript') {
        try { dialogs.openScript(feature.id); } catch {}
      } else if (feature) {
        store?.selectFeature(feature.id);
        palette.query = (feature.type || '') + ' ';
        palette.open = true;
      }
    }
  }

  // ── Drag-to-reparent / auto-grouping ──────────────────────────────────────
  // Feature rows drag a feature id; part/component rows drag a component id.
  // Part and component rows are drop surfaces for both payload kinds.
  let dropTargetId = $state(null);

  function onFeatureDragStart(ev, feature) {
    try {
      ev.dataTransfer.effectAllowed = 'move';
      ev.dataTransfer.setData('text/x-paraform-feature-id', feature.id);
      ev.dataTransfer.setData('text/plain', feature.id);
    } catch {}
  }

  function onComponentDragStart(e, row) {
    if (row.id === 'root') { e.preventDefault(); return; }
    try {
      e.dataTransfer.setData('text/x-paraform-component-id', row.id);
      e.dataTransfer.effectAllowed = 'move';
    } catch {}
  }

  function onDragOver(e, row) {
    const types = e.dataTransfer?.types || [];
    if (![...types].some((t) => t.startsWith('text/x-paraform-'))) return;
    e.preventDefault();
    // Chrome blocks getData during dragover; we gate on the coarse type check
    // so the visual indicator only shows for payloads we recognise.
    e.dataTransfer.dropEffect = 'move';
    dropTargetId = row.id;
  }
  function onDragLeave() {
    dropTargetId = null;
  }
  function onDrop(e, row) {
    e.preventDefault();
    dropTargetId = null;
    if (!store) return;
    const cid = e.dataTransfer?.getData('text/x-paraform-component-id');
    if (cid) {
      const r = canReparentComponent(store.doc, cid, row.id);
      if (!r.ok) {
        console.info('[sidebar] component reparent rejected:', r.reason);
        return;
      }
      if (row.kind === 'part') {
        // Dropping onto a raw part. If the part is already living inside a
        // group, or already has children (it's a parent), just nest — that's
        // the cascading level. Otherwise this is the FIRST parent-child link
        // on a bare part: wrap both in a fresh group.
        const target = store.doc.components?.[row.id];
        const parentIsGroup = store.doc.components?.[target?.parentId]?.kind === 'group';
        const hasKids = (componentChildren(store.doc, row.id) || []).length > 0;
        if (parentIsGroup || hasKids) setComponentParent(cid, row.id);
        else groupComponents(row.id, cid);
      } else {
        // Groups, folders, and root simply absorb the dragged component.
        setComponentParent(cid, row.id);
      }
      return;
    }
    const fid = e.dataTransfer?.getData('text/x-paraform-feature-id');
    if (!fid) return;
    const r = canReparentFeature(store.doc, fid, row.id);
    if (!r.ok) {
      console.info('[sidebar] reparent rejected:', r.reason);
      return;
    }
    setFeatureComponent(fid, row.id);
  }

  function onPlaneSketch(plane) {
    enterSketch(plane);
  }

  function onOriginClick() {
    // Visual hint only — flash a console line. Could later select all 3
    // stock planes when reference-plane features land.
    console.info('[sidebar] origin clicked (stock planes)');
  }

  function openParameters() {
    dialogs.open('parameters');
  }

  function openCadImports() {
    console.info('[sidebar] CAD imports tab placeholder');
  }
</script>

<aside class="flex w-72 shrink-0 flex-col border-r border-border bg-card text-xs">
  <!-- ── Filter ───────────────────────────────────────────────────────── -->
  <div class="flex items-center gap-1 border-b border-border p-2">
    <label class="relative flex h-7 flex-1 items-center">
      <Search class="pointer-events-none absolute left-2 size-3.5 text-muted-foreground/60" />
      <input
        type="text"
        bind:value={filter}
        placeholder="Filter"
        class="h-7 w-full rounded border border-border bg-background pl-7 pr-2 text-xs outline-none placeholder:text-muted-foreground/60 focus:border-ring"
      />
    </label>
    <button
      class="shrink-0 rounded px-1.5 py-1 text-sm leading-none text-muted-foreground hover:bg-accent hover:text-foreground"
      onclick={() => togglePanel('left')}
      title="Collapse panel"
      aria-label="Collapse browser panel"
    >«</button>
  </div>

  <!-- ── Document tree header ─────────────────────────────────────────── -->
  <div
    class="flex items-center justify-between border-b border-border px-3 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground"
  >
    <span>Document ({featureTotal})</span>
    <span class="flex items-center gap-1">
      <button
        type="button"
        class="rounded p-0.5 hover:bg-accent hover:text-foreground"
        onclick={addComponentPrompt}
        title="New component (child of active)"
        aria-label="New component"
      >
        <Boxes class="size-3.5" />
      </button>
      <button
        type="button"
        class="rounded p-0.5 hover:bg-accent hover:text-foreground"
        onclick={openAddPalette}
        title="Add feature"
        aria-label="Add feature"
      >
        <Plus class="size-3.5" />
      </button>
      {#if !V1}
      <button
        type="button"
        class="rounded p-0.5 text-muted-foreground hover:text-foreground hover:bg-accent"
        onclick={() => dialogs.openScript(null)}
        title="New script (build123d Python)"
        aria-label="New script"
      >
        <FileCode class="size-3.5" />
      </button>
      {/if}
      <button
        type="button"
        class="rounded p-0.5 hover:bg-accent hover:text-foreground"
        onclick={rollMarker}
        title="Roll marker"
        aria-label="Roll marker"
      >
        <Timer class="size-3.5" />
      </button>
    </span>
  </div>

  {#if scrubOpen}
    <TimelineScrub />
  {/if}

  <!-- Active-component breadcrumb -->
  <div class="border-b border-border px-3 py-1 text-[10px] text-muted-foreground/70 truncate" title={activePathLabel}>
    {activePathLabel}
  </div>

  <!-- ── Scrollable unified tree ──────────────────────────────────────── -->
  <div class="flex-1 overflow-y-auto py-1">
    {#each rows as row (row.kind === 'feature' ? 'f:' + row.feature.id : 'c:' + row.id)}
      {#if row.kind === 'component' || row.kind === 'part'}
        {@const isPart = row.kind === 'part'}
        {@const feature = isPart ? row.feature : null}
        {@const enabled = !isPart || feature.enabled !== false}
        {@const isSel = isPart && selectedId === feature.id}
        <div
          class={[
            'group relative flex w-full items-center',
            dropTargetId === row.id && 'ring-1 ring-primary bg-primary/10',
            !enabled && 'opacity-50',
          ]}
          ondragover={(e) => onDragOver(e, row)}
          ondragleave={onDragLeave}
          ondrop={(e) => onDrop(e, row)}
          oncontextmenu={(e) => openContextMenu(e, row)}
        >
          <!--
            HTML disallows nested interactive elements (button-in-button), which
            triggers an SSR/A11y warning. We model the row as a <div role="button">
            so the inner chevron/eye/Trash <button>s can legally sit inside.
          -->
          <div
            role="button"
            tabindex="0"
            draggable={row.id !== 'root'}
            ondragstart={(e) => onComponentDragStart(e, row)}
            class:bg-accent={row.id === activeCid || isSel}
            class:text-foreground={row.id === activeCid || isSel}
            style="padding-left: {12 + row.depth * 14}px"
            class="flex w-full cursor-pointer items-center justify-between py-1 pr-2 text-xs text-muted-foreground hover:bg-accent/40"
            onclick={() => (isPart ? selectFeature(feature.id) : activate(row.id))}
            ondblclick={() => promptRenameComponent(row)}
            onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); isPart ? selectFeature(feature.id) : activate(row.id); } }}
            title={isPart
              ? `${row.name} — click to select · double-click to rename · drag onto another part to group/nest`
              : 'Click to activate · double-click to rename · drop a part here to move it inside'}
          >
            <span class="flex items-center gap-1 truncate">
              {#if row.hasChildren}
                <button
                  type="button"
                  class="rounded p-0.5 text-muted-foreground/60 hover:bg-accent hover:text-foreground"
                  onclick={(e) => { e.stopPropagation(); toggleOpen(row.id); }}
                  title={row.open ? 'Collapse' : 'Expand'}
                  aria-label={row.open ? 'Collapse' : 'Expand'}
                >
                  {#if row.open}
                    <ChevronDown class="size-3 opacity-60" />
                  {:else}
                    <ChevronRight class="size-3 opacity-60" />
                  {/if}
                </button>
              {:else}
                <span class="inline-block size-4 shrink-0"></span>
              {/if}
              {#if isPart}
                {@const Icon = ICONS[feature.type] || Brick}
                {#if !enabled}
                  <span class="inline-block size-1.5 shrink-0 rounded-full bg-red-500" aria-hidden="true"></span>
                {/if}
                <Icon class="size-3.5 shrink-0" />
                <span class={['truncate', !enabled && 'line-through']}>{row.name}</span>
              {:else if row.isGroup}
                <Boxes class="size-3.5 shrink-0" />
                <span class="truncate font-medium">{row.name}</span>
              {:else}
                <Box class="size-3 shrink-0" />
                <span class="truncate font-medium">{row.name}</span>
              {/if}
            </span>
            <span class="flex items-center gap-1.5 shrink-0">
              {#if !isPart}
                <span class="text-[10px] opacity-60">{row.count}</span>
              {/if}
              {#if isPart}
                <button
                  type="button"
                  onclick={(e) => toggleVisible(e, feature)}
                  class="rounded p-0.5 text-muted-foreground/60 opacity-0 hover:bg-accent hover:text-foreground group-hover:opacity-100 data-[on=true]:opacity-100"
                  data-on={!enabled}
                  title={enabled ? 'Suppress' : 'Unsuppress'}
                  aria-label={enabled ? 'Suppress part' : 'Unsuppress part'}
                >
                  {#if enabled}
                    <Eye class="size-3.5" />
                  {:else}
                    <EyeOff class="size-3.5" />
                  {/if}
                </button>
              {/if}
              {#if row.id !== 'root'}
                <button
                  type="button"
                  class="rounded p-0.5 text-muted-foreground/60 opacity-0 hover:bg-accent hover:text-foreground group-hover:opacity-100"
                  onclick={(e) => onDeleteNode(e, row)}
                  title={row.isGroup ? 'Delete group and contents' : 'Delete'}
                  aria-label="Delete"
                >
                  <Trash2 class="size-3" />
                </button>
              {/if}
            </span>
          </div>
        </div>

        {#if row.id === 'root' && row.open && !filter.trim()}
          <!-- Default geometry group (visuals-only, hardcoded 4 entries) -->
          <details bind:open={geomOpen} class="group/details">
            <summary
              class="group flex cursor-pointer list-none items-center gap-1 py-1 pr-3 text-[11px] text-muted-foreground hover:bg-accent/40"
              style="padding-left: 26px"
            >
              {#if geomOpen}
                <ChevronDown class="size-3 opacity-60" />
              {:else}
                <ChevronRight class="size-3 opacity-60" />
              {/if}
              <span class="truncate flex-1">Default geometry</span>
              <button
                type="button"
                onclick={(e) => { e.preventDefault(); e.stopPropagation(); studio.referencePlanesVisible = !studio.referencePlanesVisible; }}
                class="rounded p-0.5 text-muted-foreground/60 hover:bg-accent hover:text-foreground"
                title={studio.referencePlanesVisible ? 'Hide all reference planes' : 'Show all reference planes'}
                aria-label="Toggle reference planes visibility"
              >
                {#if studio.referencePlanesVisible}
                  <Eye class="size-3" />
                {:else}
                  <EyeOff class="size-3" />
                {/if}
              </button>
            </summary>

            <button
              type="button"
              onclick={onOriginClick}
              class="flex w-full items-center gap-2 py-1 pr-3 text-left text-muted-foreground hover:bg-accent/50 hover:text-foreground"
              style="padding-left: 44px"
            >
              <Crosshair class="size-3.5 shrink-0" />
              <span class="truncate">Origin</span>
            </button>

            {#each [{ id: 'XY', label: 'Top' }, { id: 'XZ', label: 'Front' }, { id: 'YZ', label: 'Right' }] as p (p.id)}
              <div class="group flex items-center gap-2 pr-3 hover:bg-accent/50" style="padding-left: 44px">
                <button
                  type="button"
                  onclick={() => onPlaneSketch(p.id)}
                  class="flex flex-1 items-center gap-2 py-1 text-left text-muted-foreground hover:text-foreground"
                >
                  <Square class="size-3.5 shrink-0 opacity-60" />
                  <span class="truncate">{p.label}</span>
                </button>
                <button
                  type="button"
                  onclick={() => {
                    const m = studio.referencePlaneIndividual;
                    studio.referencePlaneIndividual = { ...m, [p.id]: !(m?.[p.id] !== false) };
                  }}
                  class="rounded p-0.5 text-muted-foreground/60 opacity-0 hover:bg-accent hover:text-foreground group-hover:opacity-100 data-[on=true]:opacity-100"
                  data-on={studio.referencePlaneIndividual?.[p.id] === false}
                  title={studio.referencePlaneIndividual?.[p.id] !== false ? `Hide ${p.label} plane` : `Show ${p.label} plane`}
                  aria-label="Toggle plane visibility"
                >
                  {#if studio.referencePlaneIndividual?.[p.id] !== false}
                    <Eye class="size-3" />
                  {:else}
                    <EyeOff class="size-3" />
                  {/if}
                </button>
              </div>
            {/each}
          </details>
        {/if}
      {:else}
        {@const feature = row.feature}
        {@const Icon = ICONS[feature.type] || Box}
        {@const enabled = feature.enabled !== false}
        {@const isSel = selectedId === feature.id}
        <div
          class={[
            'group flex w-full items-center gap-1 pr-3 py-1 transition-colors',
            isSel
              ? 'bg-accent text-foreground'
              : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
            !enabled && 'opacity-50',
          ]}
          style="padding-left: {12 + row.depth * 14}px"
          draggable="true"
          ondragstart={(e) => onFeatureDragStart(e, feature)}
          oncontextmenu={(e) => openContextMenu(e, row)}
        >
          <button
            type="button"
            onclick={() => selectFeature(feature.id)}
            ondblclick={feature.type === 'BuildScript'
              ? () => dialogs.openScript(feature.id)
              : (row.componentId !== activeCid ? () => studio.setActiveComponent(row.componentId) : null)}
            title={row.componentId !== activeCid
              ? `${feature.name || feature.type} (in ${row.componentName}) — double-click to enter that component`
              : (feature.name || feature.type)}
            class="flex flex-1 items-center gap-2 truncate text-left"
          >
            {#if !enabled}
              <span
                class="inline-block size-1.5 shrink-0 rounded-full bg-red-500"
                aria-hidden="true"
              ></span>
            {/if}
            <Icon class="size-3.5 shrink-0" />
            <span class={['truncate', !enabled && 'line-through']}>
              {feature.name || feature.type}
            </span>
            {#if row.isBody}
              <span
                class="ml-auto shrink-0 rounded bg-muted/50 p-0.5 text-muted-foreground/70"
                title="Emits a solid body"
              >
                <Brick class="size-3" />
              </span>
            {/if}
          </button>
          <button
            type="button"
            onclick={(e) => toggleVisible(e, feature)}
            class="rounded p-0.5 text-muted-foreground/60 opacity-0 hover:bg-accent hover:text-foreground group-hover:opacity-100 data-[on=true]:opacity-100"
            data-on={!enabled}
            title={enabled ? 'Suppress feature' : 'Unsuppress feature'}
            aria-label={enabled ? 'Suppress feature' : 'Unsuppress feature'}
          >
            {#if enabled}
              <Eye class="size-3.5" />
            {:else}
              <EyeOff class="size-3.5" />
            {/if}
          </button>
          <button
            type="button"
            onclick={(e) => onDeleteFeature(e, feature)}
            class="rounded p-0.5 text-muted-foreground/60 opacity-0 hover:bg-accent hover:text-foreground group-hover:opacity-100"
            title="Delete feature"
            aria-label="Delete feature"
          >
            <Trash2 class="size-3.5" />
          </button>
        </div>
      {/if}
    {:else}
      {#if filter.trim()}
        <div class="px-3 py-2 text-muted-foreground/60">No matches.</div>
      {:else}
        <div class="px-3 py-2 text-muted-foreground/60">Empty document.</div>
      {/if}
    {/each}

    <!-- Parameters link (Onshape-style secondary affordance) -->
    {#if !V1}
      <button
        type="button"
        onclick={openParameters}
        class="mt-1 flex w-full items-center gap-2 px-3 py-1 text-left text-muted-foreground hover:bg-accent/50 hover:text-foreground"
      >
        <Layers class="size-3.5 shrink-0 opacity-60" />
        <span class="truncate">Parameters ({paramCount})</span>
      </button>
    {/if}
  </div>

  <!-- ── Library palette (spec 18) — collapsible, docked below the tree ── -->
  <details class="border-t border-border">
    <summary class="flex w-full cursor-pointer items-center justify-between bg-secondary/40 px-3 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground hover:bg-accent">
      Library
      <span class="ml-auto">▾</span>
    </summary>
    <div class="h-72">
      <LibraryPalette />
    </div>
  </details>

  <!-- ── Bottom tab strip ─────────────────────────────────────────────── -->
  <div
    class="flex items-center gap-1 border-t border-border px-2 py-1 text-[10px] text-muted-foreground"
  >
    <button
      type="button"
      class="rounded bg-accent px-2 py-0.5 text-foreground"
      title={docName}
    >
      <span class="truncate">{docName}</span>
    </button>
    {#if !V1}
    <button
      type="button"
      onclick={openCadImports}
      class="rounded px-2 py-0.5 hover:bg-accent/50 hover:text-foreground"
      title="CAD Imports"
    >
      CAD Imports
    </button>
    {/if}
    <button
      type="button"
      onclick={addComponentPrompt}
      class="ml-auto rounded p-0.5 hover:bg-accent hover:text-foreground"
      title="New component"
      aria-label="New component"
    >
      <Plus class="size-3.5" />
    </button>
  </div>

  <TreeContextMenu
    menu={ctxMenu}
    onclose={closeContextMenu}
    onaction={handleCtxAction}
  />
</aside>
