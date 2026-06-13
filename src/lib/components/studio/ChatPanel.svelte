<script>
  /**
   * AI chat panel — the prompt-to-CAD surface (PLAN.md Phase 1).
   *
   * The user types a request; runAgentTurn drives a tool-using Claude turn over
   * the typed document ops. Each completed turn mutates the document via those
   * ops (which commit to the store), so the viewport updates itself — we do NOT
   * refresh it here.
   *
   * Renders:
   *   - a scrolling message list (user / assistant bubbles)
   *   - tool-call chips ("🔧 placeLibraryPart {…}") and result chips
   *   - a textarea + Send, with a Stop button (AbortController) while running
   *   - a "not configured" state when /ai/health reports no key
   */
  import { onMount } from 'svelte';
  import { runAgentTurn } from '$lib/ai/agent.js';
  import { checkAiHealth } from '$lib/ai/provider.js';
  import { readSettings } from '../../../../app/settings/index.js';
  import { togglePanel } from '$lib/studio/panels.svelte.js';
  import ClaudeConnect from './ClaudeConnect.svelte';

  // Visible transcript — a flat list of rendered items (not the raw Anthropic
  // history, which we keep separately for multi-turn context).
  let items = $state([]);        // [{ role:'user'|'assistant'|'tool', ... }]
  let history = $state([]);      // Anthropic messages array, passed turn-to-turn
  let input = $state('');
  let running = $state(false);
  let health = $state(undefined); // undefined=loading, null=unreachable, obj=known
  let provider = $state('openai'); // selected provider from settings
  let localKey = $state(false);    // user entered their own key for this provider
  let controller = null;
  let listEl = null;

  // The selected provider is ready when /ai/health reports its env key
  // configured, OR the user has pasted their own key in Settings (sent straight
  // to the proxy). 'mock' has no key requirement (offline repair rules), so
  // treat it as ready whenever the proxy is reachable.
  const configured = $derived(
    provider === 'mock'
      ? !!health
      : localKey || !!(health && health[provider] && health[provider].configured === true)
  );

  // Friendly label + env var for the "not configured" banner.
  const providerLabel = $derived(
    provider === 'anthropic' ? 'Anthropic'
      : provider === 'gemini' ? 'Gemini'
      : 'GPT-OSS'
  );
  const providerEnvVar = $derived(
    provider === 'anthropic' ? 'ANTHROPIC_API_KEY'
      : provider === 'gemini' ? 'GEMINI_API_KEY'
      : 'OPENAI_API_KEY'
  );

  onMount(async () => {
    try {
      const s = readSettings();
      const ai = (s && s.ai) || {};
      if (typeof ai.provider === 'string') provider = ai.provider;
      const keyField = provider === 'anthropic' ? 'anthropicApiKey'
        : provider === 'gemini' ? 'geminiApiKey'
        : 'openaiApiKey';
      localKey = !!(typeof ai[keyField] === 'string' && ai[keyField].trim());
    } catch { /* defaults to openai */ }
    health = await checkAiHealth();
  });

  function scrollToEnd() {
    queueMicrotask(() => { if (listEl) listEl.scrollTop = listEl.scrollHeight; });
  }

  function pushItem(item) {
    items = [...items, item];
    scrollToEnd();
  }

  /** Append text to the current streaming assistant bubble (create if needed). */
  function appendAssistantText(text) {
    const last = items[items.length - 1];
    if (last && last.role === 'assistant' && last.streaming) {
      last.text += text;
      items = [...items];
    } else {
      pushItem({ role: 'assistant', text, streaming: true });
    }
    scrollToEnd();
  }

  function finalizeAssistant() {
    const last = items[items.length - 1];
    if (last && last.role === 'assistant' && last.streaming) {
      last.streaming = false;
      items = [...items];
    }
  }

  async function send() {
    const text = input.trim();
    if (!text || running) return;
    input = '';
    pushItem({ role: 'user', text });
    running = true;
    controller = new AbortController();

    const onEvent = (ev) => {
      switch (ev.type) {
        case 'text':
          appendAssistantText(ev.text);
          break;
        case 'tool_call':
          finalizeAssistant();
          pushItem({ role: 'tool', kind: 'call', name: ev.name, input: ev.input });
          break;
        case 'tool_result':
          pushItem({
            role: 'tool', kind: 'result', name: ev.name,
            ok: !(ev.result && ev.result.ok === false),
            result: ev.result,
          });
          break;
        case 'error':
          finalizeAssistant();
          pushItem({ role: 'assistant', error: true, text: ev.error });
          break;
        case 'done':
          finalizeAssistant();
          break;
        // 'usage' — ignored in the UI for now.
      }
    };

    try {
      const res = await runAgentTurn({
        userMessage: text,
        history,
        onEvent,
        signal: controller.signal,
      });
      history = res.history || history;
    } finally {
      finalizeAssistant();
      running = false;
      controller = null;
    }
  }

  function stop() {
    if (controller) controller.abort();
  }

  function onKeydown(e) {
    // Enter sends; Shift+Enter inserts a newline.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  function summarizeResult(r) {
    if (!r) return '';
    if (r.ok === false) return r.error || 'failed';
    if (r.summary) return r.summary;
    if (r.featureId) return r.featureId;
    if (r.componentId) return r.componentId;
    if (r.count !== undefined) return `${r.count} hit(s)`;
    if (r.pass !== undefined) return r.pass ? 'invariants pass' : 'invariants failing';
    return 'ok';
  }

  function compactInput(obj) {
    try {
      const s = JSON.stringify(obj);
      return s.length > 120 ? s.slice(0, 120) + '…' : s;
    } catch { return ''; }
  }

  function clearChat() {
    items = [];
    history = [];
  }
</script>

<aside class="flex w-72 shrink-0 flex-col overflow-hidden border-l border-border bg-card">
  <div class="flex items-center justify-between border-b border-border px-3 py-2">
    <div class="text-xs font-medium uppercase tracking-wider text-muted-foreground">AI Assistant</div>
    <div class="flex items-center gap-1">
      <ClaudeConnect />
      <button
        class="rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent disabled:opacity-40"
        onclick={clearChat}
        disabled={running || items.length === 0}
        title="Clear conversation"
      >Clear</button>
      <button
        class="rounded px-1.5 py-0.5 text-sm leading-none text-muted-foreground hover:bg-accent hover:text-foreground"
        onclick={() => togglePanel('chat')}
        title="Collapse panel"
        aria-label="Collapse AI panel"
      >»</button>
    </div>
  </div>

  {#if health === undefined}
    <div class="p-3 text-xs text-muted-foreground/60">Checking AI availability…</div>
  {:else if !configured}
    <div class="m-3 rounded-md border border-border bg-secondary/40 p-3 text-xs text-muted-foreground">
      <div class="mb-1 font-medium text-foreground">{providerLabel} not configured</div>
      {#if health === null}
        Could not reach the AI proxy. Start the kernel server (<code>npm run kernel</code>).
      {:else}
        Set <code>{providerEnvVar}</code> in the server environment and restart the kernel
        (<code>npm run kernel</code>) to enable the {providerLabel} assistant.
        {#if health.gemini && health.gemini.configured}<br/>Gemini is ready.{/if}
        {#if health.anthropic && health.anthropic.configured}<br/>Anthropic is ready — switch provider in Settings → AI Assistant.{/if}
      {/if}
    </div>
  {:else}
    <!-- Message list -->
    <div bind:this={listEl} class="flex-1 space-y-2 overflow-y-auto px-3 py-3">
      {#each items as item (item)}
        {#if item.role === 'user'}
          <div class="ml-6 rounded-md bg-primary/15 px-3 py-2 text-sm text-foreground">{item.text}</div>
        {:else if item.role === 'assistant'}
          <div class="mr-6 rounded-md bg-secondary/40 px-3 py-2 text-sm {item.error ? 'text-destructive' : 'text-foreground'} whitespace-pre-wrap">
            {item.text}{#if item.streaming}<span class="opacity-50">▋</span>{/if}
          </div>
        {:else if item.role === 'tool' && item.kind === 'call'}
          <div class="ml-3 rounded border border-border bg-background/60 px-2 py-1 text-xs text-muted-foreground">
            🔧 <span class="font-medium text-foreground">{item.name}</span>
            <span class="opacity-70">{compactInput(item.input)}</span>
          </div>
        {:else if item.role === 'tool' && item.kind === 'result'}
          <div class="ml-3 rounded border border-border px-2 py-1 text-xs {item.ok ? 'text-muted-foreground' : 'text-destructive'}">
            {item.ok ? '✓' : '✗'} <span class="font-medium">{item.name}</span>
            <span class="opacity-70">{summarizeResult(item.result)}</span>
          </div>
        {/if}
      {:else}
        <div class="px-1 py-2 text-xs text-muted-foreground/60">
          Describe what to build. e.g. "Make a 40×40×10 mm plate with an M3 clearance hole in each corner."
        </div>
      {/each}
    </div>

    <!-- Composer -->
    <div class="border-t border-border p-2">
      <textarea
        bind:value={input}
        onkeydown={onKeydown}
        rows="3"
        placeholder="Describe a part or assembly…"
        disabled={running}
        class="w-full resize-none rounded-md border border-input bg-transparent px-2 py-1.5 text-sm outline-none focus:border-ring disabled:opacity-50"
      ></textarea>
      <div class="mt-2 flex justify-end gap-2">
        {#if running}
          <button
            class="rounded-md bg-destructive px-3 py-1.5 text-sm font-medium text-destructive-foreground hover:opacity-90"
            onclick={stop}
          >Stop</button>
        {:else}
          <button
            class="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-40"
            onclick={send}
            disabled={!input.trim()}
          >Send</button>
        {/if}
      </div>
    </div>
  {/if}
</aside>
