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
  const provider = $derived(values.provider ?? 'openai');

  // Only show the model + key fields for the currently selected provider.
  const FIELD_PROVIDER = {
    openaiModel: 'openai', openaiApiKey: 'openai', openaiBaseUrl: 'openai',
    geminiModel: 'gemini', geminiApiKey: 'gemini',
    anthropicModel: 'anthropic', anthropicApiKey: 'anthropic',
  };
  function fieldVisible(field) {
    const owner = FIELD_PROVIDER[field.key];
    if (owner) return provider === owner;
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
          {:else if field.kind === 'secret'}
            <Input
              type="password"
              autocomplete="off"
              placeholder={field.placeholder}
              value={values[field.key]}
              oninput={(e) => update(field.key, e.currentTarget.value)}
            />
          {:else}
            <Input
              placeholder={field.placeholder}
              value={values[field.key]}
              oninput={(e) => update(field.key, e.currentTarget.value)}
            />
          {/if}
        </div>
      </label>
    {/if}
  {/each}

  <p class="pt-2 text-[11px] leading-relaxed text-muted-foreground/70">
    {#if provider === 'openai'}
      Recommended path: get an <strong>OpenRouter</strong> key at
      <a class="underline" href="https://openrouter.ai/keys" target="_blank" rel="noopener">openrouter.ai/keys</a>
      — one key, every model (GPT-OSS, Claude, Gemini). Leave "Host base URL"
      blank to use OpenRouter, or set it to your own host (Groq, Together,
      Fireworks, Ollama, …).
    {:else if provider === 'anthropic'}
      Connect Claude directly by pasting an Anthropic API key. Get one at
      <a class="underline" href="https://console.anthropic.com" target="_blank" rel="noopener">console.anthropic.com</a>.
    {:else if provider === 'gemini'}
      Connect Gemini directly with a Google AI Studio key:
      <a class="underline" href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener">aistudio.google.com/app/apikey</a>.
    {:else}
      Mock mode runs deterministic offline rules — no key needed.
    {/if}
    Keys are held in <strong>session storage</strong> only — they live in this
    tab while it's open and are cleared when you close it. They're never written
    to localStorage and never persisted server-side. v1 is bring-your-own-key:
    you must add a key to use the assistant.
  </p>
</div>
