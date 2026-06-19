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
  const VALID_PROVIDERS = ['openai', 'cerebras', 'nvidia', 'zerog', 'gemini'];
  const provider = $derived(
    VALID_PROVIDERS.includes(values.provider) ? values.provider : 'openai'
  );

  // OpenRouter offers a fixed set of supported free models. Self-heal any stale
  // value left in localStorage from an older dropdown (e.g. the paid
  // `openai/gpt-oss-120b`) back to the default, so the <select> and the value
  // agent.js sends stay in sync with an offered option.
  const OPENAI_MODELS = [
    'google/gemma-4-31b-it:free',
    'nvidia/nemotron-3-ultra-550b-a55b:free',
    'nex-agi/nex-n2-pro:free',
    'qwen/qwen3-coder:free',
    'openai/gpt-oss-120b:free',
  ];
  const DEFAULT_OPENAI_MODEL = OPENAI_MODELS[0];
  $effect(() => {
    if (!OPENAI_MODELS.includes(values.openaiModel)) update('openaiModel', DEFAULT_OPENAI_MODEL);
  });

  // Cerebras' public free-tier models. Self-heal a stale stored value (e.g. an
  // id Cerebras has since rotated out of its catalog) back to the default.
  const CEREBRAS_MODELS = ['gpt-oss-120b', 'zai-glm-4.7'];
  const DEFAULT_CEREBRAS_MODEL = CEREBRAS_MODELS[0];
  $effect(() => {
    if (!CEREBRAS_MODELS.includes(values.cerebrasModel)) update('cerebrasModel', DEFAULT_CEREBRAS_MODEL);
  });

  // NVIDIA NIM's model is free-text (no self-heal effect — any catalog id is
  // valid), so it isn't constrained to a fixed list like openai/cerebras.

  // 0G Compute's tool-capable chat models (from GET /v1/models). Self-heal a
  // stale stored value (e.g. the old `zai-org/GLM-5-FP8` default that never
  // existed on the router, which produced "upstream provider request failed")
  // back to the current default.
  const ZEROG_MODELS = [
    'minimax-m3', 'glm-5', 'glm-5.1',
    'deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v3',
    'qwen3.7-max', 'qwen3.6-plus',
  ];
  const DEFAULT_ZEROG_MODEL = ZEROG_MODELS[0];
  $effect(() => {
    if (!ZEROG_MODELS.includes(values.zerogModel)) update('zerogModel', DEFAULT_ZEROG_MODEL);
  });

  // Only show the model + key fields for the currently selected provider.
  const FIELD_PROVIDER = {
    openaiModel: 'openai', openaiApiKey: 'openai', openaiBaseUrl: 'openai',
    cerebrasModel: 'cerebras', cerebrasApiKey: 'cerebras',
    nvidiaModel: 'nvidia', nvidiaApiKey: 'nvidia',
    zerogModel: 'zerog', zerogApiKey: 'zerog',
    geminiModel: 'gemini', geminiApiKey: 'gemini',
  };
  // The vision-critic fields give a TEXT-ONLY builder a pair of eyes, so they
  // only make sense for the text-only providers — a Gemini builder already sees
  // its own renders. Hide them when the selected provider is Gemini.
  const VISION_CRITIC_FIELDS = new Set(['visionCritic', 'visionCriticModel', 'visionCriticApiKey']);
  function fieldVisible(field) {
    if (VISION_CRITIC_FIELDS.has(field.key)) {
      if (provider === 'gemini') return false;
      // Only reveal the model + key once the critic is toggled on.
      if (field.key !== 'visionCritic') return !!values.visionCritic;
      return true;
    }
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
    {:else if provider === 'cerebras'}
      <strong>Cerebras</strong> runs open models at wafer-scale speed on a free
      tier (~1M tokens/day, no card). Get a key at
      <a class="underline" href="https://cloud.cerebras.ai" target="_blank" rel="noopener">cloud.cerebras.ai</a>.
      Both listed models do native tool calling; they're text-only, so the
      assistant verifies builds numerically rather than from renders.
    {:else if provider === 'nvidia'}
      <strong>NVIDIA NIM</strong> — get an <code>nvapi-…</code> key and browse the
      model catalog at
      <a class="underline" href="https://build.nvidia.com" target="_blank" rel="noopener">build.nvidia.com</a>.
      The model id is free-text: paste any catalog id (e.g.
      <code>meta/llama-3.3-70b-instruct</code>) to test it. Pick a model that
      supports function/tool calling — the assistant drives the build through tools.
    {:else if provider === 'zerog'}
      <strong>0G Compute</strong> — a decentralized inference router with an
      OpenAI-compatible API. Get an <code>sk-…</code> key and browse the model
      catalog at
      <a class="underline" href="https://pc.0g.ai" target="_blank" rel="noopener">pc.0g.ai</a>.
      The listed models are the router's tool-calling chat models — the
      assistant drives the build through tools, so models without function
      calling won't work. A bad model id comes back as "upstream provider
      request failed".
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

  {#if provider !== 'gemini'}
    <p class="pt-2 text-[11px] leading-relaxed text-muted-foreground/70">
      <strong>Vision critic.</strong> Open models like gpt-oss are text-only — they
      build "blind" and can't catch a part that came out as a plain box. Turn this
      on to attach a free multimodal reviewer (<strong>Gemma</strong> via Google AI
      Studio): after each build it looks at the renders and feeds concrete fixes
      back to the builder. Add an AI Studio key at
      <a class="underline" href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener">aistudio.google.com/app/apikey</a>
      (or leave the critic key blank to reuse your Gemini key above).
    </p>
  {/if}
</div>
