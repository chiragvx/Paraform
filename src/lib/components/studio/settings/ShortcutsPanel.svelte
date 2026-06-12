<script>
  /**
   * E6.3 — Editable shortcut customization.
   *
   * Click a row → focus the capture cell → press a key combo (any modifiers
   * + a non-modifier key) to bind. Conflicts are surfaced inline. A
   * "reset to default" button on each row reverts; the bottom "Reset all"
   * button drops everything back to DEFAULT_SHORTCUTS.
   *
   * Bindings persist via `saveShortcuts(bindings)` (localStorage). The
   * App.svelte keymap consults `loadShortcuts()` + `matchCombo()` at
   * runtime to dispatch the bound command.
   */
  import {
    DEFAULT_SHORTCUTS,
    loadShortcuts,
    saveShortcuts,
    resetShortcuts,
    eventToCombo,
    formatCombo,
    detectConflicts,
  } from '$lib/viewport/shortcuts.js';

  /** Title overrides for the small subset we expose. */
  const LABELS = {
    'palette.open':            'Command palette',
    'edit.undo':               'Undo',
    'edit.redo':               'Redo',
    'edit.delete':             'Delete',
    'view.fit':                'Fit view',
    'display.toggleWire':      'Toggle wireframe',
    'visibility.hideSelected': 'Hide selection',
    'doc.save':                'Save document',
    'doc.new':                 'New document',
    'tools.measure':           'Measure',
    'sketch.cancel':           'Cancel / Exit',
    'view.front':              'View Front',
    'view.back':               'View Back',
    'view.left':               'View Left',
    'view.right':              'View Right',
    'view.top':                'View Top',
    'view.bottom':             'View Bottom',
    'view.iso':                'View Isometric',
  };

  let bindings = $state(loadShortcuts());
  let capturingId = $state(null);

  const conflicts = $derived(detectConflicts(bindings));
  const conflictIndex = $derived(() => {
    const map = new Map();
    for (const c of conflicts) {
      for (const id of c.commandIds) map.set(id, c.combo);
    }
    return map;
  });

  function onCaptureKey(ev, commandId) {
    ev.preventDefault();
    ev.stopPropagation();
    if (ev.key === 'Escape') { capturingId = null; return; }
    if (ev.key === 'Backspace' || ev.key === 'Delete') {
      bindings = { ...bindings, [commandId]: '' };
      saveShortcuts(bindings);
      capturingId = null;
      return;
    }
    const combo = eventToCombo(ev);
    if (!combo) return; // modifier-only
    const str = formatCombo(combo);
    bindings = { ...bindings, [commandId]: str };
    saveShortcuts(bindings);
    capturingId = null;
  }

  function resetOne(commandId) {
    bindings = { ...bindings, [commandId]: DEFAULT_SHORTCUTS[commandId] || '' };
    saveShortcuts(bindings);
  }

  function resetAll() {
    resetShortcuts();
    bindings = { ...DEFAULT_SHORTCUTS };
  }

  const allIds = $derived([
    ...Object.keys(DEFAULT_SHORTCUTS),
    ...Object.keys(bindings).filter((id) => !DEFAULT_SHORTCUTS[id]),
  ]);
</script>

<div class="space-y-3">
  <div class="flex items-center justify-between">
    <p class="text-xs text-muted-foreground">
      Click a row's keys cell, then press the new combination. Backspace clears.
    </p>
    <button
      type="button"
      onclick={resetAll}
      class="rounded border border-border bg-background px-2 py-1 text-[11px] hover:bg-accent"
    >Reset all</button>
  </div>

  {#if conflicts.length > 0}
    <div class="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] text-foreground">
      <span class="font-medium">Conflicts:</span>
      {#each conflicts as c (c.combo)}
        <div class="mt-0.5"><span class="font-mono">{c.combo}</span> bound to: {c.commandIds.join(', ')}</div>
      {/each}
    </div>
  {/if}

  <div class="overflow-hidden rounded-md border border-border">
    <table class="w-full text-xs">
      <thead class="bg-muted/40 text-muted-foreground">
        <tr>
          <th class="px-3 py-1.5 text-left font-medium">Action</th>
          <th class="px-3 py-1.5 text-left font-medium">Shortcut</th>
          <th class="px-3 py-1.5"></th>
        </tr>
      </thead>
      <tbody>
        {#each allIds as cmdId (cmdId)}
          {@const isCapturing = capturingId === cmdId}
          {@const isConflict = conflictIndex().has(cmdId)}
          <tr class="border-t border-border hover:bg-accent/30">
            <td class="px-3 py-1.5 text-muted-foreground">{LABELS[cmdId] || cmdId}</td>
            <td class="px-3 py-1.5">
              <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
              <button
                type="button"
                class={[
                  'inline-block min-w-[6rem] rounded border px-2 py-0.5 font-mono text-[11px] text-left',
                  isCapturing ? 'border-primary bg-primary/10 text-foreground' : 'border-border bg-background text-foreground',
                  isConflict && 'border-amber-500/60',
                ]}
                onclick={() => (capturingId = cmdId)}
                onkeydown={(e) => isCapturing && onCaptureKey(e, cmdId)}
                title={isCapturing ? 'Press a key combination… (Esc to cancel, Del to clear)' : 'Click to rebind'}
              >
                {isCapturing ? 'Press a key…' : (bindings[cmdId] || '—')}
              </button>
            </td>
            <td class="px-3 py-1.5 text-right">
              <button
                type="button"
                onclick={() => resetOne(cmdId)}
                class="rounded p-1 text-muted-foreground/70 hover:bg-accent hover:text-foreground"
                title="Reset to default"
              >↺</button>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
</div>
