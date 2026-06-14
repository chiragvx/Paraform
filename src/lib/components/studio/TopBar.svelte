<script>
  import { onMount } from 'svelte';
  import { palette } from '$lib/commands/palette.svelte.js';
  import { dialogs } from '$lib/dialogs/dialogs.svelte.js';
  import { navigate } from '$lib/router.svelte.js';
  import {
    persistence,
    saveDocumentToFile,
    saveDocumentAs,
    openDocumentFromFile,
    shareDocumentBundle,
    hasUnsavedChanges,
  } from '$lib/document/persistence.svelte.js';
  import { getDocumentStore } from '../../../../lib/document/index.js';
  import { setMetadataChange, resetDocument } from '../../../../lib/document/index.js';
  import { library, saveCurrent as saveToLibrary } from '$lib/document/library.svelte.js';
  import { importCadFileAsFeature } from '$lib/import/cad.js';
  import { V1 } from '$lib/flags.js';

  // ── Lucide icons ────────────────────────────────────────────────────────
  import Hexagon from '@lucide/svelte/icons/hexagon';
  import Menu from '@lucide/svelte/icons/menu';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import Undo2 from '@lucide/svelte/icons/undo-2';
  import Redo2 from '@lucide/svelte/icons/redo-2';
  import Search from '@lucide/svelte/icons/search';
  import Variable from '@lucide/svelte/icons/variable';
  import Settings from '@lucide/svelte/icons/settings';
  import Download from '@lucide/svelte/icons/download';
  import CircleHelp from '@lucide/svelte/icons/circle-help';

  const store = getDocumentStore();

  // Platform-aware modifier glyph: ⌘ on macOS, "Ctrl" everywhere else.
  // navigator.userAgentData?.platform is the modern hook; fall back to the
  // legacy navigator.platform string.
  const isMac =
    typeof navigator !== 'undefined' &&
    /mac/i.test(navigator.userAgentData?.platform ?? navigator.platform ?? '');
  const modKey = isMac ? '⌘' : 'Ctrl';
  const modLabel = isMac ? '⌘K' : 'Ctrl+K';

  // Bump on every store commit so derived getters re-evaluate.
  let tick = $state(0);

  function readFromStore() {
    tick++;
  }

  onMount(() => {
    readFromStore();
    return store.subscribe(readFromStore);
  });

  let docName = $derived.by(() => {
    void tick;
    const meta = store.doc.metadata || {};
    return meta.name || meta.title || 'Untitled';
  });

  let canUndo = $derived.by(() => { void tick; return store.canUndo(); });
  let canRedo = $derived.by(() => { void tick; return store.canRedo(); });

  let saveLabel = $derived.by(() => {
    switch (persistence.status) {
      case 'saved':   return 'Saved';
      case 'pending': return 'Saving…';
      case 'error':   return 'Save failed';
      default:        return 'Unsaved';
    }
  });

  let saveDotClass = $derived.by(() => {
    switch (persistence.status) {
      case 'saved':   return 'bg-emerald-500';
      case 'pending': return 'bg-amber-400 animate-pulse';
      case 'error':   return 'bg-destructive';
      default:        return 'bg-muted-foreground/40';
    }
  });

  function renameDoc() {
    const next = window.prompt('Document name', docName);
    if (next == null) return;
    const name = next.trim();
    if (!name || name === docName) return;
    try {
      // changelog.js exports setMetadataChange — we commit a SET_METADATA
      // patch through the store so persistence/undo behave normally.
      store.commit(setMetadataChange({ name, title: name }));
    } catch (err) {
      console.warn('[topbar] rename failed:', err);
    }
  }

  function newDocument() {
    // Route through the proper confirm-dialog when there are unsaved changes;
    // otherwise reset directly. Both paths surface through the same UI.
    if (hasUnsavedChanges()) {
      dialogs.open('newDocConfirm');
    } else {
      try { resetDocument(); }
      catch (err) { console.warn('[topbar] new doc failed:', err); }
    }
  }

  function openDoc() {
    openDocumentFromFile().catch((err) => {
      if (err && err.message !== 'no file selected') {
        console.warn('[topbar] open failed:', err);
      }
    });
  }

  // Import a CAD file (STEP / STL / GLB) into the CURRENT document as geometry —
  // distinct from "Open document", which replaces the whole document.
  function importCad() {
    if (typeof document === 'undefined') return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.step,.stp,.stl,.glb,.gltf,.iges,.igs';
    input.onchange = async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      try { await importCadFileAsFeature(file); }
      catch (e) { console.warn('[topbar] import failed:', e); }
    };
    input.click();
  }

  async function saveToLibraryAction() {
    try {
      // First save of a fresh doc → name it; later saves update the same entry.
      let name;
      if (!library.currentId) {
        const n = window.prompt('Save to library as…', docName);
        if (n == null) return;
        name = n.trim() || docName;
      }
      await saveToLibrary(name ? { name } : {});
    } catch (e) { console.warn('[topbar] save to library failed:', e); }
  }

  function saveDoc()      { try { saveDocumentToFile(); }  catch (e) { console.warn('[topbar] save failed:',     e); } }
  function saveDocAs()    { try { saveDocumentAs(); }      catch (e) { console.warn('[topbar] save-as failed:',  e); } }
  function shareDoc()     { try { shareDocumentBundle(); } catch (e) { console.warn('[topbar] share failed:',    e); } }

  function goLanding() { navigate('landing'); }
  function goLibrary() { navigate('library'); }

  // ── Style tokens ────────────────────────────────────────────────────────
  const ghostBtn =
    'inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground ' +
    'hover:bg-accent hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed transition-colors';
  const menuItem =
    'flex w-full items-center rounded px-2 py-1.5 text-left text-xs text-foreground ' +
    'hover:bg-accent disabled:opacity-40 disabled:cursor-not-allowed';
</script>

<header class="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-card px-3 text-sm">
  <!-- ── Left cluster ──────────────────────────────────────────────── -->
  <div class="flex items-center gap-2">
    <!-- Logo → landing -->
    <button
      type="button"
      class="inline-flex items-center justify-center rounded p-1 hover:bg-accent"
      title="ParaForm — Home"
      onclick={goLanding}
    >
      <Hexagon class="size-5 text-primary" />
    </button>

    <!-- Hamburger menu (placeholder) -->
    <details class="relative">
      <summary class="{ghostBtn} list-none cursor-pointer select-none" title="Menu">
        <Menu class="size-4" />
      </summary>
      <div class="absolute left-0 top-full z-30 mt-1 w-44 rounded-md border border-border bg-popover p-1 shadow-md">
        <button type="button" class={menuItem} onclick={newDocument}>New Document</button>
        <button type="button" class={menuItem} onclick={openDoc}>Open document…</button>
        <button type="button" class={menuItem} onclick={importCad}>Import CAD file…</button>
        <div class="my-1 border-t border-border"></div>
        <button type="button" class={menuItem} onclick={saveToLibraryAction}>Save to Library</button>
        <button type="button" class={menuItem} onclick={saveDoc}>Save to file</button>
        <button type="button" class={menuItem} onclick={saveDocAs}>Save to file as…</button>
        <button type="button" class={menuItem} onclick={shareDoc}>Share…</button>
        <button type="button" class={menuItem} onclick={() => dialogs.open('export')}>Export…</button>
        <div class="my-1 border-t border-border"></div>
        <button type="button" class={menuItem} onclick={goLibrary}>My Library</button>
        <button type="button" class={menuItem} onclick={() => dialogs.open('settings')}>Settings…</button>
      </div>
    </details>

    <!-- Document title + branch chip -->
    <button
      type="button"
      class="flex items-center gap-1.5 rounded px-2 py-1 hover:bg-accent"
      title="Rename document"
      onclick={renameDoc}
    >
      <span class="text-sm font-medium text-foreground">{docName}</span>
      <span class="rounded bg-secondary px-1.5 py-0.5 text-[10px] text-secondary-foreground">Main</span>
      <ChevronDown class="size-3 text-muted-foreground" />
    </button>

    <!-- Save status pill (mirrors StatusBar) -->
    <span class="flex items-center gap-1 text-[10px] text-muted-foreground">
      <span class={`size-1.5 rounded-full ${saveDotClass}`}></span>
      {saveLabel}
    </span>
  </div>

  <!-- ── Center spacer ────────────────────────────────────────────── -->
  <div class="flex-1"></div>

  <!-- ── Right cluster ───────────────────────────────────────────── -->
  <div class="flex items-center gap-1">
    <!-- Undo / Redo -->
    <button
      type="button"
      class={ghostBtn}
      title="Undo (Ctrl+Z)"
      disabled={!canUndo}
      onclick={() => store.undo()}
    >
      <Undo2 class="size-4" />
    </button>
    <button
      type="button"
      class={ghostBtn}
      title="Redo (Ctrl+Y)"
      disabled={!canRedo}
      onclick={() => store.redo()}
    >
      <Redo2 class="size-4" />
    </button>

    <div class="mx-1 h-5 w-px bg-border"></div>

    <!-- Command palette launcher (stands in for Onshape's full-width search) -->
    <button
      type="button"
      class="inline-flex h-7 items-center gap-1.5 rounded border border-border bg-transparent px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
      title="Open command palette ({modLabel})"
      onclick={() => palette.toggle()}
    >
      <Search class="size-3" />
      <span>Search</span>
      <kbd class="ml-1 rounded border border-border bg-muted px-1 py-0.5 font-mono text-[10px] text-muted-foreground">{modKey}K</kbd>
    </button>

    <div class="mx-1 h-5 w-px bg-border"></div>

    <!-- Parameters -->
    {#if !V1}
    <button
      type="button"
      class={ghostBtn}
      title="Parameters"
      onclick={() => dialogs.open('parameters')}
    >
      <Variable class="size-4" />
    </button>
    {/if}

    <!-- Settings (Onshape highlights this in orange; we use the standard
         ghost style — the design system's "selected" state is reserved
         for active modes, not perpetual emphasis on this control.) -->
    <button
      type="button"
      class={ghostBtn}
      title="Settings"
      onclick={() => dialogs.open('settings')}
    >
      <Settings class="size-4" />
    </button>

    <!-- Export — primary-styled, doubles as "Share" in our context -->
    <button
      type="button"
      class="ml-1 inline-flex h-7 items-center gap-1.5 rounded bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
      title="Export model"
      onclick={() => dialogs.open('export')}
    >
      <Download class="size-3.5" />
      Export
    </button>

    <!-- Help (CircleHelp ≈ Onshape's "?") -->
    <details class="relative">
      <summary class="{ghostBtn} list-none cursor-pointer select-none ml-1" title="Help">
        <CircleHelp class="size-4" />
      </summary>
      <div class="absolute right-0 top-full z-30 mt-1 w-52 rounded-md border border-border bg-popover p-1 shadow-md">
        <button
          type="button"
          class={menuItem}
          onclick={() => dialogs.open('settings')}
          title="Settings has the shortcut reference"
        >Keyboard shortcuts</button>
        <button
          type="button"
          class={menuItem}
          onclick={() => window.alert('ParaForm — parametric CAD prototype.')}
        >About ParaForm</button>
      </div>
    </details>

    <!-- Avatar placeholder (no auth wired) -->
    <div
      class="ml-1 inline-flex size-7 items-center justify-center rounded-full bg-secondary text-[10px] text-secondary-foreground"
      title="User"
    >U</div>
  </div>
</header>
