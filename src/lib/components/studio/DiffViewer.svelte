<script>
  import Dialog from '$lib/components/ui/dialog.svelte';
  import Button from '$lib/components/ui/button.svelte';
  import { getDocumentStore } from '../../../../lib/document/index.js';
  import { extras, closeDiff } from '$lib/dialogs/extras.svelte.js';

  const STORAGE_KEY = 'paraform_v4_document';

  /**
   * Reduce a folded document into a flat ordered list of
   * `{ id, name, type }` rows. Tolerates the raw JSON shape used by
   * persistence (which only carries the changelog + head) by skipping
   * gracefully when `features` is absent.
   */
  function listFeatures(docLike) {
    if (!docLike) return [];
    const order = docLike.featureOrder || [];
    const features = docLike.features || {};
    const rows = [];
    for (const id of order) {
      const f = features[id];
      if (!f) continue;
      rows.push({ id, name: f.name || f.type || id, type: f.type || 'Feature' });
    }
    return rows;
  }

  /**
   * Read the last-saved document from localStorage. Returns null when no
   * snapshot exists, parsing fails, or the schema version doesn't match.
   *
   * The persisted shape stores `changelog + head` rather than the folded
   * `features` map. We only need feature identity here, so we synthesize
   * a minimal "what folded features would look like" by walking the
   * changelog's add-feature entries — same identity, just stripped down.
   */
  function readSaved() {
    if (typeof localStorage === 'undefined') return null;
    let raw;
    try { raw = localStorage.getItem(STORAGE_KEY); }
    catch { return null; }
    if (!raw) return null;
    try {
      const json = JSON.parse(raw);
      if (!json || (json.version !== 4 && json.version !== 5)) return null;
      // Best-effort: pull features straight off the JSON if the store
      // happened to serialize them; otherwise reconstruct from changelog.
      if (json.features && json.featureOrder) {
        return { features: json.features, featureOrder: json.featureOrder };
      }
      const features = {};
      const featureOrder = [];
      for (const entry of json.changelog || []) {
        if (entry?.kind === 'addFeature' && entry.feature?.id) {
          const f = entry.feature;
          features[f.id] = f;
          featureOrder.push(f.id);
        }
      }
      return { features, featureOrder };
    } catch (e) {
      console.warn('[diff] failed to read saved document:', e);
      return null;
    }
  }

  // Recompute on every open so the user always sees a fresh diff.
  let current = $state([]);
  let saved = $state([]);

  $effect(() => {
    if (!extras.diff) return;
    current = listFeatures(getDocumentStore().doc);
    const savedDoc = readSaved();
    saved = listFeatures(savedDoc);
  });

  const savedIds = $derived(new Set(saved.map((r) => r.id)));
  const currentIds = $derived(new Set(current.map((r) => r.id)));

  const added = $derived(current.filter((r) => !savedIds.has(r.id)));
  const removed = $derived(saved.filter((r) => !currentIds.has(r.id)));
  const unchanged = $derived(current.filter((r) => savedIds.has(r.id)));

  function classForCurrent(row) {
    return savedIds.has(row.id)
      ? 'text-muted-foreground'
      : 'text-primary';
  }
  function classForSaved(row) {
    return currentIds.has(row.id)
      ? 'text-muted-foreground'
      : 'text-destructive';
  }
  function prefixForCurrent(row) {
    return savedIds.has(row.id) ? ' ' : '+';
  }
  function prefixForSaved(row) {
    return currentIds.has(row.id) ? ' ' : '−';
  }
</script>

<Dialog
  bind:open={extras.diff}
  onclose={closeDiff}
  title="Document Diff"
  description="Compare the current document with the last saved snapshot."
  class="max-w-3xl"
>
  {#snippet children()}
    <div class="space-y-3">
      <div class="rounded border border-border bg-muted/40 px-2.5 py-1.5 text-xs text-muted-foreground">
        {added.length} added, {removed.length} removed, {unchanged.length} unchanged
      </div>

      <div class="grid grid-cols-2 gap-3">
        <div class="rounded border border-border bg-card p-2.5">
          <div class="mb-1.5 text-xs font-semibold">Current</div>
          {#if current.length === 0}
            <div class="text-xs text-muted-foreground">No features.</div>
          {:else}
            <ul class="space-y-0.5 font-mono text-xs">
              {#each current as row (row.id)}
                <li class={classForCurrent(row)}>
                  <span class="inline-block w-3">{prefixForCurrent(row)}</span>
                  <span>{row.name}</span>
                  <span class="ml-1 text-[10px] opacity-70">({row.type})</span>
                </li>
              {/each}
            </ul>
          {/if}
        </div>

        <div class="rounded border border-border bg-card p-2.5">
          <div class="mb-1.5 text-xs font-semibold">Last Saved</div>
          {#if saved.length === 0}
            <div class="text-xs text-muted-foreground">No saved snapshot.</div>
          {:else}
            <ul class="space-y-0.5 font-mono text-xs">
              {#each saved as row (row.id)}
                <li class={classForSaved(row)}>
                  <span class="inline-block w-3">{prefixForSaved(row)}</span>
                  <span>{row.name}</span>
                  <span class="ml-1 text-[10px] opacity-70">({row.type})</span>
                </li>
              {/each}
            </ul>
          {/if}
        </div>
      </div>
    </div>
  {/snippet}

  {#snippet footer()}
    <Button variant="ghost" size="sm" onclick={closeDiff}>
      {#snippet children()}Close{/snippet}
    </Button>
  {/snippet}
</Dialog>
