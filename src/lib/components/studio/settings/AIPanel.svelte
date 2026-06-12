<script>
  /**
   * AI Assistant settings panel.
   *
   * The ONLY UI for switching the AI provider (Gemini / Anthropic / mock) and
   * the per-provider model. Values persist through the shared settings store
   * (`settings.ai.*`) exactly like the other panels — agent.js + ChatPanel read
   * them back via `readSettings()`.
   *
   * Only the model picker for the *currently selected* provider is shown, so
   * the user isn't faced with two model dropdowns that don't both apply.
   */
  import Select from '$lib/components/ui/select.svelte';
  import Input from '$lib/components/ui/input.svelte';
  import { SETTINGS_SCHEMA, saveSetting } from '$lib/settings/schema.js';

  let { values = $bindable({}) } = $props();

  const panel = SETTINGS_SCHEMA.find((p) => p.id === 'ai');

  // The model field whose key matches the selected provider; the other model
  // dropdown is hidden. 'mock' has no model knob.
  const provider = $derived(values.provider ?? 'gemini');

  function fieldVisible(field) {
    if (field.key === 'geminiModel') return provider === 'gemini';
    if (field.key === 'anthropicModel') return provider === 'anthropic';
    return true; // provider, maxTokens
  }

  function update(key, v) {
    values[key] = v;
    saveSetting('ai', key, v);
  }
</script>

<div class="space-y-0.5">
  {#each panel.fields as field (field.key)}
    {#if fieldVisible(field)}
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
    {/if}
  {/each}

  <p class="pt-2 text-[11px] leading-relaxed text-muted-foreground/70">
    The provider's API key lives on the kernel server (set
    <code>GEMINI_API_KEY</code> or <code>ANTHROPIC_API_KEY</code> and restart the
    kernel). The chat panel shows which providers are configured.
  </p>
</div>
