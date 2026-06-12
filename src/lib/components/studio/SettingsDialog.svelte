<script>
  import Dialog from '$lib/components/ui/dialog.svelte';
  import Button from '$lib/components/ui/button.svelte';
  import { dialogs } from '$lib/dialogs/dialogs.svelte.js';
  import { SETTINGS_SCHEMA, loadAllSettings } from '$lib/settings/schema.js';
  import { cn } from '$lib/utils.js';

  import Settings from '@lucide/svelte/icons/settings';
  import Keyboard from '@lucide/svelte/icons/keyboard';
  import Monitor from '@lucide/svelte/icons/monitor';
  import Camera from '@lucide/svelte/icons/camera';
  import Cpu from '@lucide/svelte/icons/cpu';
  import Sparkles from '@lucide/svelte/icons/sparkles';
  import Ruler from '@lucide/svelte/icons/ruler';
  import Download from '@lucide/svelte/icons/download';
  import Bookmark from '@lucide/svelte/icons/bookmark';
  import Factory from '@lucide/svelte/icons/factory';

  import GeneralPanel from './settings/GeneralPanel.svelte';
  import ShortcutsPanel from './settings/ShortcutsPanel.svelte';
  import MarkingMenuPanel from './settings/MarkingMenuPanel.svelte';
  import ViewportPanel from './settings/ViewportPanel.svelte';
  import CameraPanel from './settings/CameraPanel.svelte';
  import PerformancePanel from './settings/PerformancePanel.svelte';
  import GraphicsPanel from './settings/GraphicsPanel.svelte';
  import MeasurementPanel from './settings/MeasurementPanel.svelte';
  import ExportPanel from './settings/ExportPanel.svelte';
  import AIPanel from './settings/AIPanel.svelte';
  import PresetsPanel from './settings/PresetsPanel.svelte';
  import ManufacturingPanel from './settings/ManufacturingPanel.svelte';

  const ICONS = {
    Settings, Keyboard, Monitor, Camera, Cpu, Sparkles, Ruler, Download, Bookmark, Factory,
  };

  const PANELS = {
    general: GeneralPanel,
    shortcuts: ShortcutsPanel,
    markingMenu: MarkingMenuPanel,
    viewport: ViewportPanel,
    camera: CameraPanel,
    performance: PerformancePanel,
    graphics: GraphicsPanel,
    measurement: MeasurementPanel,
    export: ExportPanel,
    ai: AIPanel,
    manufacturing: ManufacturingPanel,
    presets: PresetsPanel,
  };

  let activePanel = $state('general');
  let values = $state(loadAllSettings());

  // Re-hydrate from storage whenever the dialog (re-)opens so changes made
  // through other surfaces or via a reset are reflected.
  $effect(() => {
    if (dialogs.settings) {
      values = loadAllSettings();
    }
  });

  function close() {
    dialogs.close('settings');
  }

  const ActiveComponent = $derived(PANELS[activePanel]);
</script>

<Dialog
  bind:open={dialogs.settings}
  title="Settings"
  class="max-w-3xl"
  onclose={close}
>
  {#snippet children()}
    <div class="flex h-[24rem] min-h-0 -mx-4">
      <!-- Left nav rail -->
      <nav class="w-44 shrink-0 border-r border-border px-2 overflow-y-auto">
        <ul class="space-y-0.5">
          {#each SETTINGS_SCHEMA as panel (panel.id)}
            {@const Icon = ICONS[panel.icon]}
            <li>
              <button
                type="button"
                class={cn(
                  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors',
                  activePanel === panel.id
                    ? 'bg-accent text-foreground'
                    : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                )}
                onclick={() => (activePanel = panel.id)}
              >
                {#if Icon}<Icon class="h-3.5 w-3.5 shrink-0" />{/if}
                <span class="truncate">{panel.label}</span>
              </button>
            </li>
          {/each}
        </ul>
      </nav>

      <!-- Right content -->
      <section class="flex-1 min-h-0 overflow-y-auto px-4">
        {#if activePanel === 'shortcuts' || activePanel === 'presets' || activePanel === 'markingMenu'}
          <ActiveComponent />
        {:else}
          <ActiveComponent bind:values={values[activePanel]} />
        {/if}
      </section>
    </div>
  {/snippet}

  {#snippet footer()}
    <Button size="sm" variant="ghost" onclick={close}>
      {#snippet children()}Close{/snippet}
    </Button>
  {/snippet}
</Dialog>
