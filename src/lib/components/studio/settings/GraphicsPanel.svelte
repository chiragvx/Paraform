<script>
  import Select from '$lib/components/ui/select.svelte';
  import Input from '$lib/components/ui/input.svelte';
  import { SETTINGS_SCHEMA, saveSetting } from '$lib/settings/schema.js';
  import { studio } from '$lib/studio/runtime.svelte.js';

  let { values = $bindable({}) } = $props();

  const panel = SETTINGS_SCHEMA.find((p) => p.id === 'graphics');

  // Latest panel values, kept reactive so re-hydration from the dialog open
  // path flows through to applyGraphicsSettings.
  const live = $derived(values);

  function update(key, v) {
    values[key] = v;
    saveSetting('graphics', key, v);
    // Push the full panel state to the running renderer. AA changes log a
    // warning (renderer AA is fixed at construction); tessellation forwards
    // to the executor; DPR is applied immediately.
    studio.viewport?.applyGraphicsSettings?.({ ...live });
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
