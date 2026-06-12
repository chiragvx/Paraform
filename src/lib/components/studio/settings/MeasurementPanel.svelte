<script>
  import Select from '$lib/components/ui/select.svelte';
  import Input from '$lib/components/ui/input.svelte';
  import { SETTINGS_SCHEMA, saveSetting } from '$lib/settings/schema.js';
  import { setUnits, setDecimals } from '$lib/units/units.svelte.js';

  let { values = $bindable({}) } = $props();

  const panel = SETTINGS_SCHEMA.find((p) => p.id === 'measurement');

  function update(key, v) {
    values[key] = v;
    // Route the well-known fields through the shared units module so every
    // consumer (HUD, inspector, export dialog) reacts immediately. Other
    // measurement keys fall back to direct persistence.
    if (key === 'units') {
      setUnits(v);
    } else if (key === 'decimals') {
      setDecimals(v);
    } else {
      saveSetting('measurement', key, v);
    }
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
