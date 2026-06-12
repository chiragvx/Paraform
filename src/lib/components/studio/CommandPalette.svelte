<script>
  import { tick } from 'svelte';
  import { palette } from '$lib/commands/palette.svelte.js';
  import { dialogs } from '$lib/dialogs/dialogs.svelte.js';
  import { filterCommands } from '$lib/commands/registry.js';
  import { getDocumentStore } from '../../../../lib/document/index.js';
  import Search from '@lucide/svelte/icons/search';

  const store = getDocumentStore();

  let inputEl = $state(null);
  let activeIndex = $state(0);

  // Re-subscribe so the `enabled()` predicates re-evaluate on every commit
  // (otherwise Undo would stay enabled even after head moves).
  let storeTick = $state(0);
  $effect(() => {
    const unsub = store.subscribe(() => { storeTick++; });
    return unsub;
  });

  const filtered = $derived.by(() => {
    // Read storeTick so $derived re-runs when the store commits.
    void storeTick;
    return filterCommands(palette.query, { store });
  });

  // Bundle each command with its index in `filtered` here, so the template
  // doesn't need indexOf inside the inner each (O(n²) per render).
  const groups = $derived.by(() => {
    const out = new Map();
    filtered.forEach((cmd, idx) => {
      if (!out.has(cmd.group)) out.set(cmd.group, []);
      out.get(cmd.group).push({ cmd, idx });
    });
    return [...out.entries()].map(([name, items]) => ({ name, items }));
  });

  $effect(() => {
    if (palette.open) {
      activeIndex = 0;
      tick().then(() => inputEl?.focus());
    }
  });

  $effect(() => {
    void palette.query;
    activeIndex = 0;
  });

  function run(cmd) {
    palette.hide();
    if (cmd.form) {
      dialogs.openForm(cmd);
      return;
    }
    try {
      cmd.run({ store });
    } catch (err) {
      console.error('[command]', cmd.id, err);
    }
  }

  function onKey(e) {
    if (e.key === 'Escape') {
      palette.hide();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIndex = Math.min(activeIndex + 1, filtered.length - 1);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIndex = Math.max(activeIndex - 1, 0);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const cmd = filtered[activeIndex];
      if (cmd) run(cmd);
      return;
    }
  }
</script>

{#if palette.open}
  <div
    class="fixed inset-0 z-50 flex items-start justify-center bg-foreground/20 dark:bg-black/40 px-4 pt-[15vh]"
    role="dialog"
    aria-modal="true"
    aria-label="Command palette"
    onclick={(e) => { if (e.target === e.currentTarget) palette.hide(); }}
    onkeydown={onKey}
    tabindex="-1"
  >
    <div class="w-full max-w-xl overflow-hidden rounded-lg border border-border bg-popover shadow-xl">
      <div class="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <Search class="size-4 text-muted-foreground" />
        <input
          bind:this={inputEl}
          bind:value={palette.query}
          type="text"
          placeholder="Type a command…"
          class="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          autocomplete="off"
          spellcheck="false"
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-listbox"
          aria-activedescendant={filtered[activeIndex] ? `palette-opt-${filtered[activeIndex].id}` : undefined}
        />
        <kbd class="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">ESC</kbd>
      </div>

      <div id="palette-listbox" role="listbox" class="max-h-[50vh] overflow-y-auto py-1">
        {#if filtered.length === 0}
          <div class="px-3 py-6 text-center text-sm text-muted-foreground">No commands match.</div>
        {:else}
          {#each groups as group (group.name)}
            <div class="px-3 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
              {group.name}
            </div>
            {#each group.items as { cmd, idx } (cmd.id)}
              <button
                id="palette-opt-{cmd.id}"
                role="option"
                aria-selected={activeIndex === idx}
                onclick={() => run(cmd)}
                onmousemove={() => (activeIndex = idx)}
                class={[
                  'flex w-full items-center justify-between px-3 py-1.5 text-left text-sm transition-colors',
                  activeIndex === idx ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50',
                ]}
              >
                <span>{cmd.title}</span>
                {#if cmd.hint}
                  <span class="font-mono text-[10px] text-muted-foreground/60">{cmd.hint}</span>
                {/if}
              </button>
            {/each}
          {/each}
        {/if}
      </div>
    </div>
  </div>
{/if}
