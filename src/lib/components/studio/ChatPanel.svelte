<script>
  /**
   * AI chat panel — the prompt-to-CAD surface.
   *
   * The conversation itself (transcript, provider history, run loop, saved
   * sessions) lives in the persistent chat store (src/lib/ai/chat_store.svelte.js)
   * so it SURVIVES this panel being closed/reopened and page reloads, and the
   * user can revisit old chats. This component is just the view + composer.
   */
  import { onMount, untrack } from 'svelte';
  import { checkAiHealth } from '$lib/ai/provider.js';
  import { readSettings } from '../../../../app/settings/index.js';
  import { togglePanel } from '$lib/studio/panels.svelte.js';
  import {
    chat, submit as submitChat, stop as stopChat, setAutoMode,
    newSession, loadSession, deleteSession, sessionList, ensureHydrated, syncCloud,
  } from '$lib/ai/chat_store.svelte.js';
  import PlanMap from './PlanMap.svelte';
  import ClarifyQuestions from './ClarifyQuestions.svelte';
  import { refreshPlan } from '$lib/ai/plan/plan_store.svelte.js';
  import { parseAskBlock, stripPartialAsk } from '$lib/ai/clarify.js';

  let input = $state('');
  let health = $state(undefined); // undefined=loading, null=unreachable, obj=known
  let provider = $state('openai');
  let localKey = $state(false);
  let listEl = null;
  let showHistory = $state(false);

  // Images attached to the next message (references / sketches to trace).
  let attachments = $state([]); // [{ mediaType, dataBase64, dataUrl, name }]
  let fileInput = null;
  const MAX_ATTACHMENTS = 4;

  const sessions = $derived(sessionList());

  const configured = $derived(
    localKey || !!(health && health[provider] && health[provider].configured === true)
  );
  const providerLabel = $derived(provider === 'gemini' ? 'Gemini' : 'GPT-OSS');
  const providerEnvVar = $derived(provider === 'gemini' ? 'GEMINI_API_KEY' : 'OPENAI_API_KEY');

  onMount(async () => {
    ensureHydrated();
    syncCloud();
    try {
      const s = readSettings();
      const ai = (s && s.ai) || {};
      if (typeof ai.provider === 'string') provider = ai.provider;
      if (provider !== 'gemini' && provider !== 'openai') provider = 'openai';
      const keyField = provider === 'gemini' ? 'geminiApiKey' : 'openaiApiKey';
      localKey = !!(typeof ai[keyField] === 'string' && ai[keyField].trim());
    } catch { /* defaults to openai */ }
    health = await checkAiHealth();
  });

  function scrollToEnd() {
    queueMicrotask(() => { if (listEl) listEl.scrollTop = listEl.scrollHeight; });
  }
  // Re-scroll whenever the transcript grows or a stream tick lands.
  $effect(() => { void chat.items.length; void chat.running; scrollToEnd(); });
  // Refresh the plan-map after each turn (the AI may have edited the plan-graph).
  // refreshPlan WRITES planState; call it untracked so this effect depends only
  // on the chat signals above, never on what refreshPlan touches (no feedback loop).
  $effect(() => { void chat.items.length; void chat.running; untrack(() => refreshPlan()); });

  // ── Attachments ──────────────────────────────────────────────────────────
  function fileToImage(file) {
    return new Promise((resolve) => {
      if (!file || !file.type || !file.type.startsWith('image/')) { resolve(null); return; }
      const reader = new FileReader();
      reader.onload = () => {
        const url = String(reader.result || '');
        const m = /^data:([^;]+);base64,(.*)$/s.exec(url);
        if (!m) { resolve(null); return; }
        resolve({ mediaType: m[1], dataBase64: m[2], dataUrl: url, name: file.name || 'image' });
      };
      reader.onerror = () => resolve(null);
      try { reader.readAsDataURL(file); } catch { resolve(null); }
    });
  }
  async function addFiles(fileList) {
    for (const f of Array.from(fileList || [])) {
      if (attachments.length >= MAX_ATTACHMENTS) break;
      const img = await fileToImage(f);
      if (img) attachments = [...attachments, img];
    }
  }
  function onPickFiles(e) { addFiles(e.target.files); if (fileInput) fileInput.value = ''; }
  function onPaste(e) { const f = (e.clipboardData && e.clipboardData.files) || []; if (f.length) addFiles(f); }
  function onDrop(e) { if (e.dataTransfer?.files?.length) { e.preventDefault(); addFiles(e.dataTransfer.files); } }
  function removeAttachment(idx) { attachments = attachments.filter((_, i) => i !== idx); }

  // ── Composer ─────────────────────────────────────────────────────────────
  function submit() {
    const text = input;
    const atts = attachments;
    if (!text.trim() && atts.length === 0) return;
    input = '';
    attachments = [];
    submitChat({ text, attachments: atts });
  }
  function onKeydown(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
  }

  // Click a part in the plan map → prefill the composer with an isolated-edit
  // reference to that node, so a follow-up like "make it 2mm thicker" lands on
  // just that part (the AI maps the id → its bound featureIds).
  let composerEl = $state(null);
  function editPart(node) {
    if (!node) return;
    const ref = `In part ${node.id} ("${node.label}"): `;
    // Replace any prior leading reference; otherwise keep what the user typed.
    input = /^In part n\d+ \(".*?"\):\s/.test(input) ? input.replace(/^In part n\d+ \(".*?"\):\s/, ref) : ref + input;
    if (composerEl) { composerEl.focus(); const end = input.length; queueMicrotask(() => { try { composerEl.setSelectionRange(end, end); } catch { /* noop */ } }); }
  }

  function startNewChat() { newSession(); showHistory = false; }
  function openSession(id) { loadSession(id); showHistory = false; }

  function ago(ts) {
    const d = Date.now() - (ts || 0);
    const m = Math.floor(d / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
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
    try { const s = JSON.stringify(obj); return s.length > 120 ? s.slice(0, 120) + '…' : s; }
    catch { return ''; }
  }
</script>

<aside class="flex w-96 shrink-0 flex-col overflow-hidden border-l border-border bg-card">
  <div class="relative flex items-center justify-between border-b border-border px-3 py-2">
    <div class="text-xs font-medium uppercase tracking-wider text-muted-foreground">AI Assistant</div>
    <div class="flex items-center gap-1">
      <button
        class="rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent disabled:opacity-40"
        onclick={startNewChat}
        disabled={chat.running}
        title="Start a new chat (your current chat is saved)"
      >+ New</button>
      <button
        class="rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent"
        onclick={() => (showHistory = !showHistory)}
        title="Past chats"
        aria-label="Past chats"
      >🕘</button>
      <button
        class="rounded px-1.5 py-0.5 text-sm leading-none text-muted-foreground hover:bg-accent hover:text-foreground"
        onclick={() => togglePanel('chat')}
        title="Collapse panel"
        aria-label="Collapse AI panel"
      >»</button>
    </div>

    {#if showHistory}
      <div class="absolute right-2 top-9 z-10 max-h-80 w-64 overflow-y-auto rounded-md border border-border bg-popover shadow-lg">
        <div class="border-b border-border px-3 py-1.5 text-xs font-medium text-muted-foreground">Past chats</div>
        {#each sessions as s (s.id)}
          <div class="group flex items-center gap-1 px-2 py-1.5 hover:bg-accent {s.id === chat.currentId ? 'bg-accent/50' : ''}">
            <button class="min-w-0 flex-1 text-left" onclick={() => openSession(s.id)}>
              <div class="truncate text-xs text-foreground">{s.title}</div>
              <div class="text-[10px] text-muted-foreground/70">{ago(s.updatedAt)} · {s.count} msg{s.count === 1 ? '' : 's'}</div>
            </button>
            <button
              class="rounded px-1 text-xs text-muted-foreground/50 opacity-0 hover:text-destructive group-hover:opacity-100"
              onclick={() => deleteSession(s.id)}
              title="Delete chat" aria-label="Delete chat"
            >×</button>
          </div>
        {:else}
          <div class="px-3 py-2 text-xs text-muted-foreground/60">No past chats yet.</div>
        {/each}
      </div>
    {/if}
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
        {#if health.gemini && health.gemini.configured}<br/>Gemini is ready — switch provider in Settings → AI Assistant.{/if}
      {/if}
    </div>
  {:else}
    <!-- Plan-graph map (design intent — shown when a plan exists) -->
    <PlanMap onEditPart={editPart} />
    <!-- Message list -->
    <div bind:this={listEl} class="flex-1 space-y-2 overflow-y-auto px-3 py-3">
      {#each chat.items as item (item)}
        {#if item.role === 'user'}
          <div class="ml-6 rounded-md bg-primary/15 px-3 py-2 text-sm text-foreground">
            {#if item.images && item.images.length}
              <div class="mb-1 flex flex-wrap gap-1">
                {#each item.images as src}
                  <img {src} alt="attachment" class="h-12 w-12 rounded border border-border object-cover" />
                {/each}
              </div>
            {/if}
            {#if item.text}<div class="whitespace-pre-wrap">{item.text}</div>{/if}
          </div>
        {:else if item.role === 'assistant'}
          {@const ask = item.streaming ? null : parseAskBlock(item.text)}
          <div class="mr-6 rounded-md bg-secondary/40 px-3 py-2 text-sm {item.error ? 'text-destructive' : 'text-foreground'}">
            {#if ask}
              {#if ask.before}<div class="whitespace-pre-wrap">{ask.before}</div>{/if}
              <ClarifyQuestions questions={ask.questions} disabled={chat.running} onSubmit={(text) => submitChat({ text, attachments: [] })} />
              {#if ask.after}<div class="mt-2 whitespace-pre-wrap">{ask.after}</div>{/if}
            {:else}
              <span class="whitespace-pre-wrap">{item.streaming ? stripPartialAsk(item.text) : item.text}</span>{#if item.streaming}<span class="opacity-50">▋</span>{/if}
            {/if}
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
    <div class="border-t border-border p-2" ondrop={onDrop} ondragover={(e) => e.preventDefault()} role="group">
      {#if attachments.length}
        <div class="mb-2 flex flex-wrap gap-1.5">
          {#each attachments as a, i}
            <div class="relative">
              <img src={a.dataUrl} alt={a.name} class="h-12 w-12 rounded border border-border object-cover" />
              <button
                class="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-destructive text-[10px] leading-none text-destructive-foreground"
                onclick={() => removeAttachment(i)}
                title="Remove" aria-label="Remove attachment"
              >×</button>
            </div>
          {/each}
        </div>
      {/if}
      <textarea
        bind:this={composerEl}
        bind:value={input}
        onkeydown={onKeydown}
        onpaste={onPaste}
        rows="3"
        placeholder={chat.running ? 'Working… type to steer mid-response, or Stop' : 'Describe a part, or attach/paste an image to trace…'}
        class="w-full resize-none rounded-md border border-input bg-transparent px-2 py-1.5 text-sm outline-none focus:border-ring"
      ></textarea>
      <input bind:this={fileInput} type="file" accept="image/*" multiple class="hidden" onchange={onPickFiles} />
      <div class="mt-2 flex items-center gap-2">
        <button
          class="rounded-md border border-border px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
          onclick={() => fileInput && fileInput.click()}
          disabled={attachments.length >= MAX_ATTACHMENTS}
          title="Attach an image (reference, or a sketch to trace)"
          aria-label="Attach image"
        >📎</button>
        <button
          class="rounded-md border px-2 py-1.5 text-xs font-medium {chat.autoMode ? 'border-primary bg-primary/15 text-primary' : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground'}"
          onclick={() => setAutoMode(!chat.autoMode)}
          title="Auto mode: keep working until the whole request is complete instead of stopping early"
          aria-pressed={chat.autoMode}
        >{chat.autoMode ? '⚡ Auto' : 'Auto'}</button>
        {#if chat.running}
          <span class="text-xs text-muted-foreground/70">{chat.pendingCount ? `${chat.pendingCount} queued · ` : ''}working…</span>
        {/if}
        <div class="ml-auto flex gap-2">
          {#if chat.running}
            <button
              class="rounded-md bg-destructive px-3 py-1.5 text-sm font-medium text-destructive-foreground hover:opacity-90"
              onclick={stopChat}
            >Stop</button>
            <button
              class="rounded-md border border-primary px-3 py-1.5 text-sm font-medium text-primary hover:bg-primary/10 disabled:opacity-40"
              onclick={submit}
              disabled={!input.trim() && attachments.length === 0}
              title="Send this now — interrupts the current response to follow your new instruction"
            >Steer</button>
          {:else}
            <button
              class="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-40"
              onclick={submit}
              disabled={!input.trim() && attachments.length === 0}
            >Send</button>
          {/if}
        </div>
      </div>
    </div>
  {/if}
</aside>
