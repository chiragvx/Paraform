<script>
  import Dialog from '$lib/components/ui/dialog.svelte';
  import Button from '$lib/components/ui/button.svelte';
  import Input from '$lib/components/ui/input.svelte';
  import { extras, closeCustomModel } from '$lib/dialogs/extras.svelte.js';
  import { importCadFile, addImportedToScene } from '$lib/import/cad.js';

  /** @type {File | null} */
  let file = $state(null);
  let displayName = $state('');
  let description = $state('');
  let errorMsg = $state('');
  let busy = $state(false);

  /** Auto-fill display name from the picked file (without extension) once. */
  function onFileChange(e) {
    const picked = e.currentTarget?.files?.[0] || null;
    file = picked;
    if (picked && !displayName) {
      const dot = picked.name.lastIndexOf('.');
      displayName = dot > 0 ? picked.name.slice(0, dot) : picked.name;
    }
  }

  function reset() {
    file = null;
    displayName = '';
    description = '';
    errorMsg = '';
    busy = false;
  }

  function onCancel() {
    reset();
    closeCustomModel();
  }

  async function onAdd() {
    if (!file || busy) return;
    errorMsg = '';
    busy = true;
    try {
      const group = await importCadFile(file);
      const name = (displayName && displayName.trim()) || file.name;
      addImportedToScene(group, name);
      console.info('[customModel] imported: ' + name);
      reset();
      closeCustomModel();
    } catch (err) {
      busy = false;
      errorMsg = err?.message || String(err);
      console.error('[customModel] import failed', err);
    }
  }
</script>

<Dialog
  bind:open={extras.customModel}
  onclose={closeCustomModel}
  title="Add Custom Model"
  description="Import a mesh or CAD file as a new document feature."
  class="max-w-md"
>
  {#snippet children()}
    <div class="space-y-3">
      {#if errorMsg}
        <div class="bg-destructive/10 text-destructive-foreground border border-destructive/40 rounded p-2 text-xs">
          {errorMsg}
        </div>
      {/if}
      <label class="flex cursor-pointer flex-col items-center justify-center gap-1 rounded-md border-2 border-dashed border-border bg-muted/30 px-3 py-6 text-center transition-colors hover:border-ring hover:bg-muted/50">
        <div class="text-xs font-medium">
          {file ? file.name : 'Click to choose a file'}
        </div>
        <div class="text-[10px] text-muted-foreground">
          STEP, IGES, OBJ, GLTF, GLB
        </div>
        <input
          type="file"
          accept=".step,.iges,.obj,.gltf,.glb,.stp"
          class="hidden"
          onchange={onFileChange}
        />
      </label>

      <div>
        <label for="custom-model-name" class="mb-1 block text-xs text-muted-foreground">Display name</label>
        <Input
          id="custom-model-name"
          type="text"
          placeholder="e.g. Motor mount"
          bind:value={displayName}
        />
      </div>

      <div>
        <label for="custom-model-desc" class="mb-1 block text-xs text-muted-foreground">Description (optional)</label>
        <textarea
          id="custom-model-desc"
          rows="3"
          placeholder="Notes about this part…"
          bind:value={description}
          class="flex w-full rounded-md border border-input bg-transparent px-2.5 py-1.5 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        ></textarea>
      </div>
    </div>
  {/snippet}

  {#snippet footer()}
    <Button variant="ghost" size="sm" onclick={onCancel}>
      {#snippet children()}Cancel{/snippet}
    </Button>
    <Button size="sm" onclick={onAdd} disabled={!file || busy}>
      {#snippet children()}{busy ? 'Importing…' : 'Add'}{/snippet}
    </Button>
  {/snippet}
</Dialog>
