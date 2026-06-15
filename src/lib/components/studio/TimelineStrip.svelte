<script>
  /**
   * Phase B3 — horizontal timeline strip.
   *
   * A compact left-to-right row of feature glyphs in `doc.featureOrder` order
   * (the same order the kernel emits them). Each chip:
   *   • shows the feature's category glyph + accent color,
   *   • highlights the currently-selected feature,
   *   • dims features that fall past the rollback marker (`studio.rollbackHead`),
   *   • selects the feature on click,
   *   • exposes a tiny "roll here" affordance that sets the rollback head.
   *
   * Lives behind the Sidebar's strip toggle next to the timeline-scrub UI.
   */
  import { onMount } from 'svelte';
  import { getDocumentStore } from '../../../../lib/document/index.js';
  import { studio } from '$lib/studio/runtime.svelte.js';
  import { isFeatureRolledOut } from '$lib/document/rollback.js';
  import { iconForType, categoryForType } from '../../../../app/timeline/icons.js';
  import { colorForType } from '../../../../app/v4_panel/feature_visuals.js';

  import Timer from '@lucide/svelte/icons/timer';

  let tick = $state(0);
  let store = $state(null);

  onMount(() => {
    store = getDocumentStore();
    tick++;
    const unsub = store.subscribe(() => { tick++; });
    return unsub;
  });

  const _bump = $derived(tick);
  const doc = $derived(store?.doc);
  const selectedId = $derived.by(() => { void _bump; return store?.selectedFeatureId() ?? null; });

  // Flatten featureOrder into renderable chips. Reads `_bump` so it recomputes
  // on every store commit (doc mutates in place — see Sidebar.svelte rationale).
  const chips = $derived.by(() => {
    void _bump;
    if (!doc?.features) return [];
    const head = studio.rollbackHead;
    const out = [];
    for (const id of doc.featureOrder || []) {
      const f = doc.features[id];
      if (!f) continue;
      out.push({
        id,
        type: f.type,
        name: f.name || f.type,
        category: categoryForType(f.type),
        color: colorForType(f.type),
        icon: iconForType(f.type),
        rolledOut: isFeatureRolledOut(doc, head, id),
        enabled: f.enabled !== false,
      });
    }
    return out;
  });

  function select(id) {
    store?.selectFeature(id);
  }

  function rollHere(e, id) {
    e.stopPropagation();
    studio.rollbackHead = id;
    try { studio.applyRollback?.(); } catch {}
  }
</script>

{#if chips.length > 0}
  <div class="flex items-center gap-1 overflow-x-auto border-b border-border bg-card/40 px-3 py-2">
    {#each chips as c (c.id)}
      {@const isSel = selectedId === c.id}
      <div
        class={[
          'group relative flex shrink-0 flex-col items-center',
          c.rolledOut && 'opacity-35',
          !c.enabled && 'opacity-40',
        ]}
      >
        <button
          type="button"
          onclick={() => select(c.id)}
          title={`${c.name} (${c.category})${c.rolledOut ? ' — rolled out' : ''}`}
          aria-label={`Select ${c.name}`}
          style={`color:${c.color}`}
          class={[
            'flex size-7 items-center justify-center rounded border transition-colors',
            isSel
              ? 'border-primary bg-primary/15 ring-1 ring-primary'
              : 'border-border bg-background hover:bg-accent',
          ]}
        >
          <span class="[&_svg]:size-4">{@html c.icon}</span>
        </button>
        <button
          type="button"
          onclick={(e) => rollHere(e, c.id)}
          title="Roll back to here"
          aria-label={`Roll back to ${c.name}`}
          class="mt-0.5 rounded p-0.5 text-muted-foreground/50 opacity-0 hover:bg-accent hover:text-foreground group-hover:opacity-100"
        >
          <Timer class="size-3" />
        </button>
      </div>
    {/each}
  </div>
{/if}
