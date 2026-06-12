<script>
  import { onMount } from 'svelte';
  import { getDocumentStore, setFeatureParams } from '../../../../lib/document/index.js';
  import Input from '$lib/components/ui/input.svelte';
  import TransformPanel from './inspector/TransformPanel.svelte';
  import PropertiesPanel from './inspector/PropertiesPanel.svelte';
  import RelationshipsPanel from './inspector/RelationshipsPanel.svelte';
  import DfmPanel from './inspector/DfmPanel.svelte';
  import InvariantsPanel from './inspector/InvariantsPanel.svelte';
  import AssumptionsManifestPanel from './inspector/AssumptionsManifestPanel.svelte';
  import ScenePanel from './inspector/ScenePanel.svelte';
  import ConnectorsPanel from './inspector/ConnectorsPanel.svelte';
  import KinematicsPanel from './KinematicsPanel.svelte';
  import { togglePanel } from '$lib/studio/panels.svelte.js';
  import { V1 } from '$lib/flags.js';

  let feature = $state(null);

  function readFromStore(store) {
    feature = store.selectedFeature();
  }

  onMount(() => {
    const store = getDocumentStore();
    readFromStore(store);
    const unsub = store.subscribe((_doc, _evt, s) => readFromStore(s));
    return unsub;
  });

  function paramEntries(f) {
    if (!f || !f.params) return [];
    return Object.entries(f.params).map(([key, value]) => ({ key, value }));
  }

  function onParamChange(key, raw) {
    if (!feature) return;
    const current = feature.params[key];
    let next = raw;
    if (typeof current === 'number') {
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) return;
      next = parsed;
    } else if (typeof current === 'boolean') {
      next = raw === 'true' || raw === true;
    }
    setFeatureParams(feature.id, { [key]: next });
  }
</script>

<aside class="flex w-72 shrink-0 flex-col overflow-y-auto border-l border-border bg-card">
  <div class="border-b border-border px-3 py-2">
    <div class="flex items-center justify-between">
      <div class="text-xs font-medium uppercase tracking-wider text-muted-foreground">Inspector</div>
      <button
        class="rounded px-1.5 py-0.5 text-sm leading-none text-muted-foreground hover:bg-accent hover:text-foreground"
        onclick={() => togglePanel('inspector')}
        title="Collapse panel"
        aria-label="Collapse inspector panel"
      >»</button>
    </div>
    {#if feature}
      <div class="mt-0.5 truncate text-sm font-medium text-foreground">{feature.name || feature.type}</div>
    {/if}
  </div>

  {#if !feature}
    <div class="p-3 text-xs text-muted-foreground/60">Select a feature to inspect.</div>
    {#if !V1}
    <!-- Doc-wide assumptions panel — still useful when nothing is selected. -->
    <details open>
      <summary class="flex w-full cursor-pointer items-center justify-between border-b border-border bg-secondary/40 px-3 py-2 text-xs font-medium uppercase tracking-wider text-muted-foreground hover:bg-accent">
        Assumptions
        <span class="ml-auto">▾</span>
      </summary>
      <div class="px-3 py-2">
        <AssumptionsManifestPanel />
      </div>
    </details>
    {/if}
    <!-- Kinematics — assembly-wide articulation + DOF (Phase 6). -->
    <details>
      <summary class="flex w-full cursor-pointer items-center justify-between border-b border-border bg-secondary/40 px-3 py-2 text-xs font-medium uppercase tracking-wider text-muted-foreground hover:bg-accent">
        Kinematics
        <span class="ml-auto">▾</span>
      </summary>
      <div class="px-3 py-2">
        <KinematicsPanel />
      </div>
    </details>
  {:else}
    <!-- Parameters -->
    <details open>
      <summary class="flex w-full cursor-pointer items-center justify-between border-b border-border bg-secondary/40 px-3 py-2 text-xs font-medium uppercase tracking-wider text-muted-foreground hover:bg-accent">
        Parameters
        <span class="ml-auto">▾</span>
      </summary>
      <div class="px-3 py-2 space-y-2">
        {#each paramEntries(feature) as { key, value } (key)}
          <div>
            <label for={`prop-${key}`} class="mb-1 block text-xs text-muted-foreground">{key}</label>
            {#if typeof value === 'boolean'}
              <select
                id={`prop-${key}`}
                class="h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm"
                value={String(value)}
                onchange={(e) => onParamChange(key, e.currentTarget.value)}
              >
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            {:else}
              <Input
                id={`prop-${key}`}
                type={typeof value === 'number' ? 'number' : 'text'}
                value={String(value ?? '')}
                onchange={(e) => onParamChange(key, e.currentTarget.value)}
              />
            {/if}
          </div>
        {:else}
          <div class="text-xs text-muted-foreground/60">No parameters.</div>
        {/each}
      </div>
    </details>

    <!-- Transform -->
    <details open>
      <summary class="flex w-full cursor-pointer items-center justify-between border-b border-border bg-secondary/40 px-3 py-2 text-xs font-medium uppercase tracking-wider text-muted-foreground hover:bg-accent">
        Transform
        <span class="ml-auto">▾</span>
      </summary>
      <div class="px-3 py-2 space-y-2">
        <TransformPanel />
      </div>
    </details>

    <!-- Properties -->
    <details>
      <summary class="flex w-full cursor-pointer items-center justify-between border-b border-border bg-secondary/40 px-3 py-2 text-xs font-medium uppercase tracking-wider text-muted-foreground hover:bg-accent">
        Properties
        <span class="ml-auto">▾</span>
      </summary>
      <div class="px-3 py-2 space-y-2">
        <PropertiesPanel />
      </div>
    </details>

    <!-- Relationships -->
    <details>
      <summary class="flex w-full cursor-pointer items-center justify-between border-b border-border bg-secondary/40 px-3 py-2 text-xs font-medium uppercase tracking-wider text-muted-foreground hover:bg-accent">
        Relationships
        <span class="ml-auto">▾</span>
      </summary>
      <div class="px-3 py-2 space-y-2">
        <RelationshipsPanel />
      </div>
    </details>

    {#if !V1}
    <!-- Manufacturability -->
    <details>
      <summary class="flex w-full cursor-pointer items-center justify-between border-b border-border bg-secondary/40 px-3 py-2 text-xs font-medium uppercase tracking-wider text-muted-foreground hover:bg-accent">
        Manufacturability
        <span class="ml-auto">▾</span>
      </summary>
      <div class="px-3 py-2">
        <DfmPanel />
      </div>
    </details>

    <!-- Invariants -->
    <details>
      <summary class="flex w-full cursor-pointer items-center justify-between border-b border-border bg-secondary/40 px-3 py-2 text-xs font-medium uppercase tracking-wider text-muted-foreground hover:bg-accent">
        Invariants
        <span class="ml-auto">▾</span>
      </summary>
      <div class="px-3 py-2">
        <InvariantsPanel />
      </div>
    </details>

    <!-- Assumptions manifest (spec 09) -->
    <details>
      <summary class="flex w-full cursor-pointer items-center justify-between border-b border-border bg-secondary/40 px-3 py-2 text-xs font-medium uppercase tracking-wider text-muted-foreground hover:bg-accent">
        Assumptions
        <span class="ml-auto">▾</span>
      </summary>
      <div class="px-3 py-2">
        <AssumptionsManifestPanel />
      </div>
    </details>

    <!-- Connectors (spec 18) -->
    <details>
      <summary class="flex w-full cursor-pointer items-center justify-between border-b border-border bg-secondary/40 px-3 py-2 text-xs font-medium uppercase tracking-wider text-muted-foreground hover:bg-accent">
        Connectors
        <span class="ml-auto">▾</span>
      </summary>
      <div class="px-3 py-2">
        <ConnectorsPanel />
      </div>
    </details>
    {/if}

    <!-- Kinematics — assembly-wide articulation + DOF (Phase 6). -->
    <details>
      <summary class="flex w-full cursor-pointer items-center justify-between border-b border-border bg-secondary/40 px-3 py-2 text-xs font-medium uppercase tracking-wider text-muted-foreground hover:bg-accent">
        Kinematics
        <span class="ml-auto">▾</span>
      </summary>
      <div class="px-3 py-2">
        <KinematicsPanel />
      </div>
    </details>

    <!-- Scene & Material -->
    <details>
      <summary class="flex w-full cursor-pointer items-center justify-between border-b border-border bg-secondary/40 px-3 py-2 text-xs font-medium uppercase tracking-wider text-muted-foreground hover:bg-accent">
        Scene &amp; Material
        <span class="ml-auto">▾</span>
      </summary>
      <div class="px-3 py-2 space-y-2">
        <ScenePanel />
      </div>
    </details>
  {/if}
</aside>
