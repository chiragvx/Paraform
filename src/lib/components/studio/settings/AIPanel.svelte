<script>
  /**
   * AI Assistant settings panel.
   *
   * The ONLY UI for switching the AI provider (OpenRouter / Gemini) and
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
  // dropdown is hidden. Stale/removed providers (anthropic, mock) coerce to the
  // default so the panel always renders a valid set of fields.
  const VALID_PROVIDERS = ['openai', 'gemini'];
  const provider = $derived(
    VALID_PROVIDERS.includes(values.provider) ? values.provider : 'openai'
  );

  // OpenRouter is now locked to a single supported model. Self-heal any stale
  // value left in localStorage from the old multi-option dropdown (e.g. the
  // paid `openai/gpt-oss-120b`) so the <select> and the value agent.js sends
  // stay in sync with the one offered option.
  const OPENAI_MODEL = 'openai/gpt-oss-120b:free';
  $effect(() => {
    if (values.openaiModel !== OPENAI_MODEL) update('openaiModel', OPENAI_MODEL);
  });

  // Only show the model + key fields for the currently selected provider.
  const FIELD_PROVIDER = {
    openaiModel: 'openai', openaiApiKey: 'openai', openaiBaseUrl: 'openai',
    geminiModel: 'gemini', geminiApiKey: 'gemini',
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
    {#if provider === 'gemini'}
      Connect Gemini directly with a Google AI Studio key:
      <a class="underline" href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener">aistudio.google.com/app/apikey</a>.
    {:else}
      Recommended path: get an <strong>OpenRouter</strong> key at
      <a class="underline" href="https://openrouter.ai/keys" target="_blank" rel="noopener">openrouter.ai/keys</a>
      — one key, every model (GPT-OSS, Gemini, and more). Leave "Host base URL"
      blank to use OpenRouter, or set it to your own host (Groq, Together,
      Fireworks, Ollama, …).
    {/if}
    Keys are held in <strong>session storage</strong> only — they live in this
    tab while it's open and are cleared when you close it. They're never written
    to localStorage and never persisted server-side. v1 is bring-your-own-key:
    you must add a key to use the assistant.
  </p>
</div>
