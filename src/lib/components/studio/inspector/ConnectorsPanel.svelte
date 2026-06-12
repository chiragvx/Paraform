<script>
  /**
   * Spec 18 v1 — Connectors inspector panel.
   *
   * Lists every Connector on the currently-selected component, with
   * add/edit/remove actions. Lets the user hand-tag connectors on
   * imported COTS geometry. "Export as library part" serialises the
   * current selection's connector list into a downloadable JSON
   * file matching the library schema.
   */
  import { onMount } from 'svelte';
  import * as v4 from '../../../../../lib/document/index.js';
  import Plus from '@lucide/svelte/icons/plus';
  import Trash from '@lucide/svelte/icons/trash-2';
  import Download from '@lucide/svelte/icons/download';

  const KINDS   = ['thread', 'bore', 'planar', 'shaft', 'tab', 'slot', 'rail'];
  const GENDERS = ['male', 'female', 'neutral'];

  let doc = $state(null);
  let selectedComponentId = $state(null);

  onMount(() => {
    const store = v4.getDocumentStore();
    doc = store.doc;
    const unsub = store.subscribe((d) => { doc = d; });
    return unsub;
  });

  const connectors = $derived.by(() => {
    if (!doc || !doc.connectors || !selectedComponentId) return [];
    return Object.values(doc.connectors).filter((c) => c.parent === selectedComponentId);
  });

  const componentOptions = $derived.by(() => {
    if (!doc || !doc.components) return [];
    return Object.values(doc.components).filter((c) => c.id !== 'root');
  });

  function addOne() {
    if (!selectedComponentId) return;
    v4.addConnector({
      parent: selectedComponentId,
      kind: 'planar',
      gender: 'neutral',
      size: { nominal: 'unspecified', unit: 'mm' },
      axis: [0, 0, 1],
      origin: [0, 0, 0],
      mates_with: ['planar'],
      inducedJoint: 'fixed',
    });
  }

  function remove(id) {
    v4.removeConnector(id);
  }

  function patchField(id, key, value) {
    v4.updateConnector(id, { [key]: value });
  }

  function patchSize(id, value) {
    v4.updateConnector(id, { size: { nominal: value, unit: 'mm' } });
  }

  function exportPart() {
    if (!selectedComponentId) return;
    const component = doc.components[selectedComponentId];
    const rec = {
      id: `lib-part-${selectedComponentId}`,
      name: component ? component.name : selectedComponentId,
      category: 'misc',
      source: 'parametric',
      build: { type: 'parametric', snippet: '# TODO: refine geometry — exported from session' },
      connectors: connectors.map((c) => ({
        id: c.id, parent: `lib-part-${selectedComponentId}`,
        kind: c.kind, gender: c.gender, size: c.size,
        axis: c.axis, origin: c.origin, mates_with: c.mates_with,
        inducedJoint: c.inducedJoint, metadata: c.metadata,
      })),
      tags: ['exported'],
      keywords: [component ? component.name.toLowerCase() : 'exported'],
      boundingBox: { min: [0, 0, 0], max: [0, 0, 0] },
    };
    const blob = new Blob([JSON.stringify(rec, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${rec.id}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }
</script>

<div class="flex flex-col gap-2 border-t border-border bg-card p-2 text-xs text-foreground">
  <div class="flex items-center justify-between">
    <div class="font-medium uppercase tracking-wide text-muted-foreground">Connectors</div>
    <div class="flex items-center gap-1">
      <button
        type="button"
        title="Add connector"
        onclick={addOne}
        disabled={!selectedComponentId}
        class="rounded border border-border bg-background px-1.5 py-0.5 hover:bg-accent disabled:opacity-40"
      >
        <Plus class="size-3" />
      </button>
      <button
        type="button"
        title="Export as library part"
        onclick={exportPart}
        disabled={!selectedComponentId || connectors.length === 0}
        class="rounded border border-border bg-background px-1.5 py-0.5 hover:bg-accent disabled:opacity-40"
      >
        <Download class="size-3" />
      </button>
    </div>
  </div>

  <label class="flex items-center gap-2">
    <span class="text-[10px] uppercase text-muted-foreground">Component</span>
    <select
      class="flex-1 rounded border border-border bg-background px-1.5 py-0.5 text-xs"
      bind:value={selectedComponentId}
    >
      <option value={null}>—</option>
      {#each componentOptions as comp (comp.id)}
        <option value={comp.id}>{comp.name}</option>
      {/each}
    </select>
  </label>

  {#if !selectedComponentId}
    <div class="px-2 py-3 text-muted-foreground">Select a component to view its connectors.</div>
  {:else if connectors.length === 0}
    <div class="px-2 py-3 text-muted-foreground">No connectors. Click <Plus class="inline size-3 align-middle" /> to add one.</div>
  {:else}
    <ul class="flex flex-col gap-1">
      {#each connectors as c (c.id)}
        <li class="rounded border border-border bg-background p-2">
          <div class="mb-1 flex items-center justify-between">
            <span class="font-mono text-[10px] text-muted-foreground">{c.id}</span>
            <button
              type="button"
              title="Remove connector"
              onclick={() => remove(c.id)}
              class="rounded p-0.5 text-muted-foreground hover:text-destructive"
            >
              <Trash class="size-3" />
            </button>
          </div>
          <div class="grid grid-cols-2 gap-1.5">
            <label class="flex flex-col gap-0.5">
              <span class="text-[9px] uppercase text-muted-foreground">Kind</span>
              <select
                class="rounded border border-border bg-card px-1 py-0.5 text-xs"
                value={c.kind}
                onchange={(e) => patchField(c.id, 'kind', e.currentTarget.value)}
              >
                {#each KINDS as k}
                  <option value={k}>{k}</option>
                {/each}
              </select>
            </label>
            <label class="flex flex-col gap-0.5">
              <span class="text-[9px] uppercase text-muted-foreground">Gender</span>
              <select
                class="rounded border border-border bg-card px-1 py-0.5 text-xs"
                value={c.gender}
                onchange={(e) => patchField(c.id, 'gender', e.currentTarget.value)}
              >
                {#each GENDERS as g}
                  <option value={g}>{g}</option>
                {/each}
              </select>
            </label>
            <label class="flex flex-col gap-0.5">
              <span class="text-[9px] uppercase text-muted-foreground">Size</span>
              <input
                class="rounded border border-border bg-card px-1 py-0.5 text-xs"
                value={String(c.size?.nominal ?? '')}
                onchange={(e) => patchSize(c.id, e.currentTarget.value)}
              />
            </label>
            <label class="flex flex-col gap-0.5">
              <span class="text-[9px] uppercase text-muted-foreground">Induced</span>
              <select
                class="rounded border border-border bg-card px-1 py-0.5 text-xs"
                value={c.inducedJoint ?? ''}
                onchange={(e) => patchField(c.id, 'inducedJoint', e.currentTarget.value || null)}
              >
                <option value="">none</option>
                <option value="fixed">fixed</option>
                <option value="revolute">revolute</option>
                <option value="prismatic">prismatic</option>
              </select>
            </label>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</div>
