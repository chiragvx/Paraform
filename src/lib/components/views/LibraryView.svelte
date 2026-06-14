<script>
  /**
   * Library — the user's documents, organised in folders. Create new documents,
   * open saved ones straight into the studio, import CAD files, and open a
   * .paraform.json from disk. Backed by the persistent document library store.
   */
  import { onMount } from 'svelte';
  import { navigate } from '$lib/router.svelte.js';
  import {
    library, ensureHydrated, docsIn,
    createFolder, renameFolder, deleteFolder,
    openDoc, newDoc, renameDoc, moveDoc, deleteDoc, duplicateDoc,
  } from '$lib/document/library.svelte.js';
  import { openDocumentFromFile } from '$lib/document/persistence.svelte.js';
  import { importCadFileAsFeature } from '$lib/import/cad.js';

  import Plus from '@lucide/svelte/icons/plus';
  import Upload from '@lucide/svelte/icons/upload';
  import FolderOpen from '@lucide/svelte/icons/folder-open';
  import FolderPlus from '@lucide/svelte/icons/folder-plus';
  import Folder from '@lucide/svelte/icons/folder';
  import Layers from '@lucide/svelte/icons/layers';
  import Search from '@lucide/svelte/icons/search';
  import Ellipsis from '@lucide/svelte/icons/ellipsis';
  import Hexagon from '@lucide/svelte/icons/hexagon';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import Pencil from '@lucide/svelte/icons/pencil';
  import Copy from '@lucide/svelte/icons/copy';

  let selectedFolder = $state('all');   // 'all' | null (uncategorised) | folderId
  let query = $state('');
  let menuId = $state(null);            // card whose action menu is open
  let busy = $state('');                // transient status text

  onMount(() => { ensureHydrated(); });

  const visible = $derived(
    docsIn(selectedFolder).filter((d) => !query.trim() || d.name.toLowerCase().includes(query.trim().toLowerCase()))
  );
  const folderName = $derived(
    selectedFolder === 'all' ? 'All documents'
      : selectedFolder === null ? 'Uncategorised'
      : (library.folders.find((f) => f.id === selectedFolder)?.name || 'Folder')
  );
  function countIn(folderId) { return docsIn(folderId).length; }

  function ago(ts) {
    const d = Date.now() - (ts || 0);
    const m = Math.floor(d / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const days = Math.floor(h / 24);
    if (days < 30) return `${days}d ago`;
    return new Date(ts).toLocaleDateString();
  }

  // ── Actions ──────────────────────────────────────────────────────────────
  function onNew() { if (newDoc()) navigate('studio'); }

  function onOpenCard(id) { if (openDoc(id)) navigate('studio'); }

  function onOpenFile() {
    openDocumentFromFile()
      .then(() => navigate('studio'))
      .catch((err) => { if (err && err.message !== 'no file selected') console.warn('[library] open file failed:', err); });
  }

  let importInput = null;
  async function onImportPicked(e) {
    const file = e.target.files && e.target.files[0];
    if (importInput) importInput.value = '';
    if (!file) return;
    busy = `Importing ${file.name}…`;
    try {
      newDoc();                            // import lands in a fresh document
      await importCadFileAsFeature(file);
      navigate('studio');
    } catch (err) {
      console.warn('[library] import failed:', err);
      busy = `Import failed: ${(err && err.message) || err}`;
      setTimeout(() => { busy = ''; }, 4000);
      return;
    }
    busy = '';
  }

  function onNewFolder() {
    const name = window.prompt('Folder name', 'New folder');
    if (name == null) return;
    const f = createFolder(name);
    selectedFolder = f.id;
  }
  function onRenameFolder(id) {
    const f = library.folders.find((x) => x.id === id);
    const name = window.prompt('Rename folder', f ? f.name : '');
    if (name == null) return;
    renameFolder(id, name);
  }
  function onDeleteFolder(id) {
    if (!window.confirm('Delete this folder? Its documents move to Uncategorised.')) return;
    deleteFolder(id);
    if (selectedFolder === id) selectedFolder = 'all';
  }

  function onRenameDoc(id) {
    const d = library.docs.find((x) => x.id === id);
    const name = window.prompt('Rename document', d ? d.name : '');
    if (name == null) return;
    renameDoc(id, name);
    menuId = null;
  }
  function onDeleteDoc(id) {
    if (!window.confirm('Delete this document permanently?')) return;
    deleteDoc(id);
    menuId = null;
  }
  function onDuplicate(id) { duplicateDoc(id); menuId = null; }
  function onMove(id, folderId) { moveDoc(id, folderId === '' ? null : folderId); menuId = null; }
</script>

<div class="h-full overflow-y-auto bg-background text-foreground">
  <!-- Hero -->
  <div
    class="border-b border-border"
    style="background:
      radial-gradient(900px 240px at 12% -40%, color-mix(in srgb, var(--primary) 22%, transparent), transparent 70%),
      radial-gradient(700px 220px at 88% -60%, color-mix(in srgb, var(--primary) 12%, transparent), transparent 70%);"
  >
    <div class="container mx-auto max-w-6xl px-6 py-10">
      <div class="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div class="mb-1 flex items-center gap-2 text-xs font-medium uppercase tracking-widest text-primary">
            <Hexagon class="size-3.5" /> Library
          </div>
          <h1 class="text-3xl font-semibold tracking-tight">Your documents</h1>
          <p class="mt-1 text-sm text-muted-foreground">Create, organise, and open your designs — all saved in this browser.</p>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <button
            class="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm transition-[transform,box-shadow] hover:-translate-y-0.5 hover:shadow-md"
            onclick={onNew}
          >
            <Plus class="size-4" /> New document
          </button>
          <button
            class="inline-flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground hover:bg-accent"
            onclick={() => importInput && importInput.click()}
            title="Import a STEP / STL / GLB file as a new document"
          >
            <Upload class="size-4" /> Import CAD
          </button>
          <button
            class="inline-flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground hover:bg-accent"
            onclick={onOpenFile}
            title="Open a .paraform.json document from disk"
          >
            <FolderOpen class="size-4" /> Open file
          </button>
          <input bind:this={importInput} type="file" accept=".step,.stp,.stl,.glb,.gltf,.iges,.igs" class="hidden" onchange={onImportPicked} />
        </div>
      </div>
      {#if busy}
        <div class="mt-4 inline-flex items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground">{busy}</div>
      {/if}
    </div>
  </div>

  <div class="container mx-auto max-w-6xl px-6 py-8">
    <div class="grid grid-cols-1 gap-6 md:grid-cols-[200px_1fr]">
      <!-- Folder sidebar -->
      <aside class="space-y-1">
        <button
          class="flex w-full items-center justify-between rounded-md px-3 py-2 text-sm transition-colors {selectedFolder === 'all' ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground'}"
          onclick={() => (selectedFolder = 'all')}
        >
          <span class="flex items-center gap-2"><Layers class="size-4" /> All documents</span>
          <span class="text-xs opacity-60">{countIn('all')}</span>
        </button>
        <button
          class="flex w-full items-center justify-between rounded-md px-3 py-2 text-sm transition-colors {selectedFolder === null ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground'}"
          onclick={() => (selectedFolder = null)}
        >
          <span class="flex items-center gap-2"><Folder class="size-4" /> Uncategorised</span>
          <span class="text-xs opacity-60">{countIn(null)}</span>
        </button>

        <div class="!mt-4 mb-1 flex items-center justify-between px-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
          Folders
          <button class="rounded p-0.5 hover:bg-accent hover:text-foreground" onclick={onNewFolder} title="New folder" aria-label="New folder">
            <FolderPlus class="size-3.5" />
          </button>
        </div>
        {#each library.folders as f (f.id)}
          <div class="group flex items-center">
            <button
              class="flex min-w-0 flex-1 items-center justify-between rounded-md px-3 py-2 text-sm transition-colors {selectedFolder === f.id ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground'}"
              onclick={() => (selectedFolder = f.id)}
            >
              <span class="flex min-w-0 items-center gap-2"><Folder class="size-4 shrink-0" /> <span class="truncate">{f.name}</span></span>
              <span class="text-xs opacity-60">{countIn(f.id)}</span>
            </button>
            <button class="ml-0.5 rounded p-1 text-muted-foreground/0 hover:text-foreground group-hover:text-muted-foreground" onclick={() => onRenameFolder(f.id)} title="Rename folder" aria-label="Rename folder"><Pencil class="size-3" /></button>
            <button class="rounded p-1 text-muted-foreground/0 hover:text-destructive group-hover:text-muted-foreground" onclick={() => onDeleteFolder(f.id)} title="Delete folder" aria-label="Delete folder"><Trash2 class="size-3" /></button>
          </div>
        {/each}
      </aside>

      <!-- Documents -->
      <section>
        <div class="mb-4 flex items-center justify-between gap-3">
          <h2 class="text-lg font-medium">{folderName} <span class="ml-1 text-sm text-muted-foreground">({visible.length})</span></h2>
          <div class="relative w-56 max-w-[50%]">
            <Search class="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              bind:value={query}
              placeholder="Search documents…"
              class="w-full rounded-md border border-border bg-card py-1.5 pl-7 pr-2 text-sm outline-none focus:border-ring"
            />
          </div>
        </div>

        {#if visible.length === 0}
          <div class="flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-card px-6 py-20 text-center">
            <div class="flex size-14 items-center justify-center rounded-full bg-muted text-muted-foreground"><Hexagon class="size-7" /></div>
            <h3 class="mt-4 text-base font-medium text-card-foreground">{query ? 'No matches' : 'No documents yet'}</h3>
            <p class="mt-1 max-w-sm text-sm text-muted-foreground">
              {query ? 'Try a different search.' : 'Start a new document, import a CAD file, or open one from disk. Save it in the studio and it shows up here.'}
            </p>
            {#if !query}
              <button class="mt-5 inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90" onclick={onNew}>
                <Plus class="size-4" /> New document
              </button>
            {/if}
          </div>
        {:else}
          <div class="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {#each visible as d (d.id)}
              <div class="group relative overflow-visible rounded-xl border border-border bg-card transition-[transform,box-shadow,border-color] hover:-translate-y-0.5 hover:border-primary/50 hover:shadow-lg">
                <!-- Thumbnail (click to open) -->
                <button class="block w-full text-left" onclick={() => onOpenCard(d.id)} title="Open in studio">
                  <div class="aspect-[4/3] w-full overflow-hidden rounded-t-xl bg-gradient-to-br from-muted to-background">
                    {#if d.thumb}
                      <img src={d.thumb} alt={d.name} class="h-full w-full object-cover" />
                    {:else}
                      <div class="flex h-full w-full items-center justify-center text-muted-foreground/40"><Hexagon class="size-10" /></div>
                    {/if}
                  </div>
                </button>
                <!-- Meta -->
                <div class="flex items-center gap-2 px-3 py-2">
                  <button class="min-w-0 flex-1 text-left" onclick={() => onOpenCard(d.id)}>
                    <div class="truncate text-sm font-medium text-card-foreground">{d.name}</div>
                    <div class="text-[11px] text-muted-foreground">{ago(d.updatedAt)}</div>
                  </button>
                  <button class="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground" onclick={() => (menuId = menuId === d.id ? null : d.id)} title="Actions" aria-label="Actions">
                    <Ellipsis class="size-4" />
                  </button>
                </div>

                {#if menuId === d.id}
                  <div class="absolute right-2 top-full z-20 mt-1 w-44 rounded-md border border-border bg-popover p-1 shadow-lg">
                    <button class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent" onclick={() => onOpenCard(d.id)}><FolderOpen class="size-3.5" /> Open</button>
                    <button class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent" onclick={() => onRenameDoc(d.id)}><Pencil class="size-3.5" /> Rename</button>
                    <button class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent" onclick={() => onDuplicate(d.id)}><Copy class="size-3.5" /> Duplicate</button>
                    <div class="my-1 border-t border-border"></div>
                    <div class="px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground/70">Move to</div>
                    <select
                      class="mx-1 mb-1 w-[calc(100%-0.5rem)] rounded border border-border bg-card px-1.5 py-1 text-xs text-foreground outline-none"
                      value={d.folderId || ''}
                      onchange={(e) => onMove(d.id, e.target.value)}
                    >
                      <option value="">Uncategorised</option>
                      {#each library.folders as f (f.id)}
                        <option value={f.id}>{f.name}</option>
                      {/each}
                    </select>
                    <div class="my-1 border-t border-border"></div>
                    <button class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-destructive hover:bg-destructive/10" onclick={() => onDeleteDoc(d.id)}><Trash2 class="size-3.5" /> Delete</button>
                  </div>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      </section>
    </div>
  </div>
</div>
