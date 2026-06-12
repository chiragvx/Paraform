<script>
  /**
   * E4 v2 — Marking menu customization.
   *
   * The 8-sector radial RMB menu (app/viewport/marking_menu.js) defaults to
   * a hardcoded action map (MARKING_MENU_ACTIONS). This panel lets the user
   * rebind each octant to any registered direct-run command. Persistence is
   * a separate localStorage key; the viewport reads bindings at open-time
   * so changes apply on the next RMB press without reload.
   */
  import {
    MARKING_MENU_SECTORS,
    DEFAULT_MARKING_MENU,
    loadMarkingMenuBindings,
    saveMarkingMenuBindings,
    resetMarkingMenuBindings,
  } from '$lib/viewport/shortcuts.js';
  import { COMMANDS } from '$lib/commands/registry.js';

  const SECTOR_LABELS = {
    n:  'North',
    ne: 'North-east',
    e:  'East',
    se: 'South-east',
    s:  'South',
    sw: 'South-west',
    w:  'West',
    nw: 'North-west',
  };

  // Direct-run commands only — form-driven ones bail in the marking-menu
  // registry shim, so showing them in the picker would be misleading.
  const CHOICES = COMMANDS
    .filter((c) => !c.form)
    .map((c) => ({ id: c.id, title: c.title || c.id, group: c.group || '' }))
    .sort((a, b) => (a.group + a.title).localeCompare(b.group + b.title));

  let bindings = $state(loadMarkingMenuBindings());

  function setBinding(sector, value) {
    bindings = { ...bindings, [sector]: value || null };
    saveMarkingMenuBindings(bindings);
  }

  function resetOne(sector) {
    bindings = { ...bindings, [sector]: DEFAULT_MARKING_MENU[sector] || null };
    saveMarkingMenuBindings(bindings);
  }

  function resetAll() {
    resetMarkingMenuBindings();
    bindings = { ...DEFAULT_MARKING_MENU };
  }
</script>

<div class="space-y-3">
  <div class="flex items-center justify-between">
    <p class="text-xs text-muted-foreground">
      Hold right-mouse to reveal the radial menu. Pick a command for each sector.
    </p>
    <button
      type="button"
      onclick={resetAll}
      class="rounded border border-border bg-background px-2 py-1 text-[11px] hover:bg-accent"
    >Reset all</button>
  </div>

  <div class="overflow-hidden rounded-md border border-border">
    <table class="w-full text-xs">
      <thead class="bg-muted/40 text-muted-foreground">
        <tr>
          <th class="px-3 py-1.5 text-left font-medium">Sector</th>
          <th class="px-3 py-1.5 text-left font-medium">Command</th>
          <th class="px-3 py-1.5"></th>
        </tr>
      </thead>
      <tbody>
        {#each MARKING_MENU_SECTORS as sec (sec)}
          <tr class="border-t border-border hover:bg-accent/30">
            <td class="px-3 py-1.5 text-muted-foreground">
              <span class="font-mono uppercase">{sec}</span>
              <span class="ml-2 opacity-70">{SECTOR_LABELS[sec]}</span>
            </td>
            <td class="px-3 py-1.5">
              <select
                class="w-full rounded border border-border bg-background px-1.5 py-0.5 text-[11px] text-foreground"
                value={bindings[sec] || ''}
                onchange={(e) => setBinding(sec, e.currentTarget.value)}
              >
                <option value="">(none)</option>
                {#each CHOICES as opt (opt.id)}
                  <option value={opt.id}>{opt.group ? `${opt.group} — ` : ''}{opt.title}</option>
                {/each}
              </select>
            </td>
            <td class="px-3 py-1.5 text-right">
              <button
                type="button"
                onclick={() => resetOne(sec)}
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
