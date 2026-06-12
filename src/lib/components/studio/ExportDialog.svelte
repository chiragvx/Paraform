<script>
  import Dialog from '$lib/components/ui/dialog.svelte';
  import Button from '$lib/components/ui/button.svelte';
  import Check from '@lucide/svelte/icons/check';
  import { dialogs } from '$lib/dialogs/dialogs.svelte.js';
  import { downloadDocumentAs } from '../../../../lib/document/exporter.js';
  import { units } from '$lib/units/units.svelte.js';
  import { loadAllSettings } from '$lib/settings/schema.js';
  import { V1 } from '$lib/flags.js';

  // The kernel exporter only handles stl / step / brep today (see
  // lib/document/exporter.js FILE_EXTENSIONS). The cards for 3MF / OBJ / glTF
  // are surfaced so the UI hints at the roadmap, but selecting one falls
  // back to STL with an inline warning instead of failing silently.
  const SUPPORTED = new Set(['stl', 'step', 'brep']);

  const ALL_FORMATS = [
    { value: 'stl',       label: 'STL (binary)', description: 'Triangle mesh — 3D printing' },
    { value: '3mf',       label: '3MF',          description: 'Modern printable bundle' },
    { value: 'obj',       label: 'OBJ',          description: 'Mesh interchange' },
    { value: 'gltf',      label: 'glTF',         description: 'Web 3D / preview' },
    { value: 'step',      label: 'STEP',         description: 'Parametric CAD interchange' },
    { value: 'brep',      label: 'BREP',         description: 'OCCT native B-Rep' },
  ];

  // v1 launch: only the hero formats. glTF/GLB export is not implemented in
  // the kernel exporter, so the visible set is STL (binary) + STEP.
  // 3MF / OBJ / BREP cards are hidden (not deleted) behind the flag.
  const V1_FORMATS = new Set(['stl', 'step']);
  const formats = V1 ? ALL_FORMATS.filter((f) => V1_FORMATS.has(f.value)) : ALL_FORMATS;
  const visibleValues = new Set(formats.map((f) => f.value));

  function todayStamp() {
    const d = new Date();
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  }

  // Settings pattern uses {name}/{date}; substitute and strip any unknown
  // tokens so we don't ship literal "{foo}" to the OS file dialog.
  function applyPattern(pattern, name = 'model') {
    const p = pattern && typeof pattern === 'string' ? pattern : '{name}_{date}';
    return p
      .replaceAll('{date}', todayStamp())
      .replaceAll('{name}', name)
      .replace(/\{[^}]*\}/g, '')
      .trim() || `${name}_${todayStamp()}`;
  }

  function defaultFilename(pattern) {
    return applyPattern(pattern);
  }

  // Resolve initial defaults from settings once at script init; the $effect
  // below re-applies them whenever the user re-opens the dialog so a settings
  // change between sessions is picked up without a refresh.
  const initialSettings = loadAllSettings()?.export ?? {};
  const initialFormat = initialSettings.defaultFormat ?? 'stl';
  // The settings panel offers 'glb', but the format cards key on 'gltf'.
  const FORMAT_ALIAS = { glb: 'gltf' };
  function normalizeFormat(value) {
    if (!value) return 'stl';
    const fmt = FORMAT_ALIAS[value] || value;
    // A persisted default for a format whose card is hidden (v1 gating)
    // falls back to STL — the stored setting itself is left untouched.
    return visibleValues.has(fmt) ? fmt : 'stl';
  }

  let selected = $state(normalizeFormat(initialFormat));
  let filename = $state(defaultFilename(initialSettings.filenamePattern));
  let busy = $state(false);
  let error = $state(null);
  let warn = $state(null);

  // Re-seed defaults each time the dialog transitions from closed to open so a
  // setting changed in another tab/session shows up on the next export click.
  let wasOpen = false;
  $effect(() => {
    const isOpen = dialogs.export;
    if (isOpen && !wasOpen) {
      const s = loadAllSettings()?.export ?? {};
      const fmt = normalizeFormat(s.defaultFormat ?? 'stl');
      selected = fmt;
      // If the format is unsupported, mirror the warn behavior of chooseFormat.
      if (!SUPPORTED.has(fmt)) {
        warn = `${formats.find(f => f.value === fmt)?.label || fmt} export is not yet implemented — STL will be exported instead.`;
      } else {
        warn = null;
      }
      filename = defaultFilename(s.filenamePattern);
      error = null;
    }
    wasOpen = isOpen;
  });

  function chooseFormat(value) {
    selected = value;
    if (!SUPPORTED.has(value)) {
      warn = `${formats.find(f => f.value === value)?.label || value} export is not yet implemented — STL will be exported instead.`;
    } else {
      warn = null;
    }
  }

  async function onExport() {
    busy = true;
    error = null;
    try {
      // Map UI value → exporter format. Unsupported entries collapse to 'stl'
      // with the warning already showing above the footer.
      let fmt = selected;
      if (!SUPPORTED.has(fmt)) fmt = 'stl';

      const ext = fmt;
      const name = (filename || defaultFilename()).replace(/\.[a-z0-9]+$/i, '');
      const result = await downloadDocumentAs(fmt, { filename: `${name}.${ext}` });

      if (result?.ok === false) {
        error = result.error || 'Export failed.';
      } else {
        dialogs.close('export');
      }
    } catch (e) {
      error = String(e?.message || e);
    } finally {
      busy = false;
    }
  }
</script>

<Dialog bind:open={dialogs.export} title="Export" class="max-w-lg">
  {#snippet children()}
    <div class="space-y-3">
      <div class="flex items-center justify-between rounded border border-border bg-muted/40 px-2 py-1 text-[11px] text-muted-foreground">
        <span>Units: {units.unit}</span>
        <span class="font-mono">{units.decimals} decimals</span>
      </div>
      <div class="grid grid-cols-2 gap-2">
        {#each formats as fmt (fmt.value)}
          {@const isSelected = selected === fmt.value}
          <button
            type="button"
            class="flex flex-col items-start gap-1 rounded-lg border border-border bg-card p-3 text-left hover:border-primary/60 hover:bg-accent transition-colors aria-pressed:border-primary aria-pressed:bg-accent"
            aria-pressed={isSelected}
            onclick={() => chooseFormat(fmt.value)}
            disabled={busy}
          >
            <div class="flex w-full items-center justify-between">
              <span class="font-semibold text-sm">{fmt.label}</span>
              {#if isSelected}<Check class="size-4 text-primary" />{/if}
            </div>
            <span class="text-[10px] text-muted-foreground">{fmt.description}</span>
          </button>
        {/each}
      </div>

      <div class="space-y-2 pt-1">
        <label class="block text-xs text-muted-foreground" for="export-filename">Filename</label>
        <input
          id="export-filename"
          type="text"
          bind:value={filename}
          disabled={busy}
          class="flex h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
        />
      </div>

      {#if warn}
        <div class="rounded border border-border bg-muted/50 px-2 py-1.5 text-xs text-muted-foreground">
          {warn}
        </div>
      {/if}
      {#if error}
        <div class="rounded border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive-foreground">
          {error}
        </div>
      {/if}
    </div>
  {/snippet}

  {#snippet footer()}
    <Button variant="ghost" size="sm" onclick={() => dialogs.close('export')} disabled={busy}>
      {#snippet children()}Cancel{/snippet}
    </Button>
    <Button size="sm" onclick={onExport} disabled={busy}>
      {#snippet children()}{busy ? 'Exporting…' : 'Export'}{/snippet}
    </Button>
  {/snippet}
</Dialog>
