<script>
  import Select from '$lib/components/ui/select.svelte';
  import Input from '$lib/components/ui/input.svelte';
  import { SETTINGS_SCHEMA, saveSetting } from '$lib/settings/schema.js';
  import { applyCameraSettings } from '../../../viewport/cad_controls.js';
  import { studio } from '$lib/studio/runtime.svelte.js';

  let { values = $bindable({}) } = $props();

  const panel = SETTINGS_SCHEMA.find((p) => p.id === 'camera');

  function update(key, v) {
    values[key] = v;
    saveSetting('camera', key, v);
    // Live-apply onto the viewport's CADCameraControls so slider changes are
    // felt immediately — no reload required. `autoFit` is persisted but not
    // applied here (gating logic lives in Viewport.svelte, which we don't own).
    const controls = studio.viewport?.controls;
    if (controls) applyCameraSettings(controls, { [key]: v });
  }
</script>

<div class="space-y-0.5">
  {#each panel.fields as field (field.key)}
    <label class="flex items-center justify-between gap-3 py-1.5">
      <span class="text-xs text-muted-foreground">{field.label}</span>
      <div class="w-44">
        {#if field.kind === 'select'}
          <Select
            value={values[field.key]}
            options={field.options}
            onchange={(e) => update(field.key, e.currentTarget.value)}
          />
        {:else if field.kind === 'boolean'}
          <input
            type="checkbox"
            class="h-4 w-4 rounded border-input bg-transparent accent-primary"
            checked={!!values[field.key]}
            onchange={(e) => update(field.key, e.currentTarget.checked)}
          />
        {:else if field.kind === 'number'}
          <Input
            type="number"
            value={values[field.key]}
            min={field.min}
            max={field.max}
            step={field.step}
            oninput={(e) => update(field.key, Number(e.currentTarget.value))}
          />
        {:else}
          <Input
            value={values[field.key]}
            oninput={(e) => update(field.key, e.currentTarget.value)}
          />
        {/if}
      </div>
    </label>
  {/each}
</div>
