<script>
  import { onMount } from 'svelte';
  import { getDocumentStore, setFeatureParams, updateBuildScript } from '../../../../lib/document/index.js';
  import { updateReferenceImage } from '$lib/reference/image_canvas.js';
  import { extractScriptParams, setScriptParam } from '../../../../lib/document/script_params.js';
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

  // ── Reference image (Phase A1) ──────────────────────────────────────────
  const isReferenceImage = $derived(feature?.type === 'ReferenceImage');
  function onRefImageChange(patch) {
    if (!feature) return;
    updateReferenceImage(feature.id, patch);
  }

  // ── BuildScript hoisted params (Phase C2) ───────────────────────────────
  const isBuildScript = $derived(feature?.type === 'BuildScript');
  const scriptParams = $derived(
    isBuildScript ? extractScriptParams(feature?.params?.code || '') : [],
  );
  function onScriptParamChange(name, raw) {
    if (!feature) return;
    const value = Number(raw);
    if (!Number.isFinite(value)) return;
    const code = setScriptParam(feature.params?.code || '', name, value);
    updateBuildScript(feature.id, { code });
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
        {#if isReferenceImage}Reference Image{:else if isBuildScript}Script Parameters{:else}Parameters{/if}
        <span class="ml-auto">▾</span>
      </summary>

      {#if isReferenceImage}
        <!-- Reference image display controls (Phase A1) — never expose dataUrl. -->
        <div class="px-3 py-3 space-y-3">
          <div>
            <label for="ref-opacity" class="mb-1 flex items-center justify-between text-xs text-muted-foreground">
              <span>Opacity</span>
              <span class="font-mono">{Number(feature.params?.opacity ?? 0.65).toFixed(2)}</span>
            </label>
            <input
              id="ref-opacity"
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={feature.params?.opacity ?? 0.65}
              oninput={(e) => onRefImageChange({ opacity: Number(e.currentTarget.value) })}
              class="w-full accent-primary"
            />
          </div>

          <label class="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={feature.params?.displayThrough === true}
              onchange={(e) => onRefImageChange({ displayThrough: e.currentTarget.checked })}
              class="accent-primary"
            />
            Display through (always on top)
          </label>

          <div class="grid grid-cols-2 gap-2">
            <div>
              <label for="ref-w" class="mb-1 block text-xs text-muted-foreground">Width (mm)</label>
              <Input
                id="ref-w"
                type="number"
                value={String(feature.params?.width_mm ?? '')}
                onchange={(e) => onRefImageChange({ width_mm: Number(e.currentTarget.value) })}
              />
            </div>
            <div>
              <label for="ref-h" class="mb-1 block text-xs text-muted-foreground">Height (mm)</label>
              <Input
                id="ref-h"
                type="number"
                value={String(feature.params?.height_mm ?? '')}
                onchange={(e) => onRefImageChange({ height_mm: Number(e.currentTarget.value) })}
              />
            </div>
          </div>
        </div>
      {:else if isBuildScript}
        <!-- Hoisted BuildScript params (Phase C2) — sliders for `# param` consts. -->
        <div class="px-3 py-3 space-y-3">
          {#each scriptParams as p (p.name)}
            <div>
              <label for={`sp-${p.name}`} class="mb-1 flex items-center justify-between text-xs text-muted-foreground">
                <span>{p.name}{p.unit ? ` (${p.unit})` : ''}</span>
                <span class="font-mono">{p.value}</span>
              </label>
              {#if p.min !== undefined && p.max !== undefined}
                <input
                  id={`sp-${p.name}`}
                  type="range"
                  min={p.min}
                  max={p.max}
                  step={Number.isInteger(p.min) && Number.isInteger(p.max) ? 1 : 0.01}
                  value={p.value}
                  oninput={(e) => onScriptParamChange(p.name, e.currentTarget.value)}
                  class="w-full accent-primary"
                />
              {:else}
                <Input
                  id={`sp-${p.name}`}
                  type="number"
                  value={String(p.value)}
                  onchange={(e) => onScriptParamChange(p.name, e.currentTarget.value)}
                />
              {/if}
            </div>
          {:else}
            <div class="text-xs text-muted-foreground/60">
              No hoisted parameters. Mark a line with <code class="font-mono">{'# param'}</code> to expose a slider.
            </div>
          {/each}
        </div>
      {:else}
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
      {/if}
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
