<script>
  import Button from '$lib/components/ui/button.svelte';
  import UploadCloud from '@lucide/svelte/icons/cloud-upload';
  import File from '@lucide/svelte/icons/file';
  import MoreHorizontal from '@lucide/svelte/icons/ellipsis';
  import { V1 } from '$lib/flags.js';

  const recent = [
    { name: 'gearbox_housing.step', size: '1.4 MB', when: '2 minutes ago' },
    { name: 'bracket_v3.glb', size: '320 KB', when: 'Yesterday' },
    { name: 'enclosure_top.step', size: '2.1 MB', when: '3 days ago' },
  ];

  let dragOver = $state(false);

  function onDragOver(e) {
    e.preventDefault();
    dragOver = true;
  }
  function onDragLeave() {
    dragOver = false;
  }
  function onDrop(e) {
    e.preventDefault();
    dragOver = false;
    console.log('drop (stub):', e.dataTransfer?.files);
  }
</script>

{#if V1}
  <!-- Launch build: the upload pipeline is not wired yet (the UI below is a
       stub). Show a simple placeholder until it ships. The full stub stays
       available under VITE_FULL_UI for dev. -->
  <div class="h-full overflow-y-auto bg-background text-foreground">
    <div class="container max-w-6xl mx-auto px-6 py-12">
      <header class="mb-8">
        <h1 class="text-3xl font-semibold tracking-tight">Manage uploads</h1>
        <p class="mt-2 text-muted-foreground">
          Upload reference geometry and parametric templates.
        </p>
      </header>
      <div class="rounded-lg border border-dashed border-border bg-card px-6 py-20 flex flex-col items-center justify-center text-center">
        <div class="flex h-14 w-14 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <UploadCloud class="size-7" />
        </div>
        <h2 class="mt-4 text-lg font-medium text-card-foreground">Coming soon</h2>
        <p class="mt-1 max-w-md text-sm text-muted-foreground">
          Uploading your own reference geometry and templates is on the way.
          For now, start from a built-in template or describe your machine in Studio.
        </p>
      </div>
    </div>
  </div>
{:else}
<div class="h-full overflow-y-auto bg-background text-foreground">
  <div class="container max-w-6xl mx-auto px-6 py-12">
    <header class="mb-8">
      <h1 class="text-3xl font-semibold tracking-tight">Manage uploads</h1>
      <p class="mt-2 text-muted-foreground">
        Upload reference geometry and parametric templates.
      </p>
    </header>

    <!-- Drop zone -->
    <div
      role="button"
      tabindex="0"
      ondragover={onDragOver}
      ondragleave={onDragLeave}
      ondrop={onDrop}
      class="rounded-lg border-2 border-dashed {dragOver ? 'border-primary bg-primary/5' : 'border-border bg-card'} px-6 py-16 flex flex-col items-center justify-center text-center transition-colors"
    >
      <div class="flex h-14 w-14 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <UploadCloud class="size-7" />
      </div>
      <h2 class="mt-4 text-lg font-medium text-card-foreground">
        Drop .step / .glb here
      </h2>
      <p class="mt-1 text-sm text-muted-foreground">
        Or click to browse. Files are processed locally — nothing leaves your browser.
      </p>
      <div class="mt-6">
        <Button variant="outline" onclick={() => console.log('browse (stub)')}>
          Browse files
        </Button>
      </div>
    </div>

    <!-- Recent uploads -->
    <section class="mt-12">
      <h2 class="text-lg font-medium">Recent uploads</h2>
      <div class="mt-4 rounded-lg border border-border bg-card overflow-hidden">
        {#each recent as r, i}
          <div class="flex items-center gap-4 px-4 py-3 {i < recent.length - 1 ? 'border-b border-border' : ''}">
            <div class="flex h-9 w-9 items-center justify-center rounded-md bg-muted text-muted-foreground">
              <File class="size-4" />
            </div>
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm font-medium text-card-foreground">{r.name}</p>
              <p class="text-xs text-muted-foreground">{r.size} &middot; {r.when}</p>
            </div>
            <button
              class="rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
              aria-label="More actions"
            >
              <MoreHorizontal class="size-4" />
            </button>
          </div>
        {/each}
      </div>
    </section>
  </div>
</div>
{/if}
