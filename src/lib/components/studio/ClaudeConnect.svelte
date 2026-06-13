<script>
  /**
   * "Connect Claude" — pairs a Claude conversation with THIS live studio tab.
   *
   * What it does end-to-end:
   *   1. User clicks Connect → POSTs /studio/pair to the hosted MCP gateway.
   *      Gateway mints a 6-letter code and returns {eventsUrl, resultsUrl}.
   *   2. We open an EventSource on eventsUrl. The button shows the code +
   *      one-line phrase the user pastes into their Claude chat.
   *   3. Once the user reads the code to Claude, Claude calls paraform_attach.
   *      The gateway adds the Claude session to this pairing.
   *   4. Every subsequent tools/call from Claude arrives as an SSE
   *      `tool_call` event here. We dispatch it through the SAME dispatchTool
   *      the in-app chat agent uses — mutating the live document store the
   *      viewport renders — and POST the result back to /studio/results.
   *
   * Result: Claude builds, the studio's viewport updates in real time.
   *
   * Endpoint resolution: tries (in order) VITE_MCP_REMOTE_URL, a window-level
   * override, and the engine URL's :8080 sibling for dev. In production this
   * MUST be set to your hosted gateway's HTTPS URL.
   */
  import Button from '$lib/components/ui/button.svelte';
  import Dialog from '$lib/components/ui/dialog.svelte';
  import Plug from '@lucide/svelte/icons/plug';
  import Copy from '@lucide/svelte/icons/copy';
  import { dispatchTool } from '$lib/ai/tools.js';

  // ── Endpoint resolution ────────────────────────────────────────────────────
  function resolveBase() {
    const fromEnv = (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_MCP_REMOTE_URL) || '';
    if (fromEnv) return String(fromEnv).replace(/\/+$/, '');
    if (typeof window !== 'undefined') {
      if (window.__PARAFORM_MCP_REMOTE_URL__) return String(window.__PARAFORM_MCP_REMOTE_URL__).replace(/\/+$/, '');
      const host = (window.location && window.location.hostname) || '';
      if (host === 'localhost' || host === '127.0.0.1') return 'http://localhost:8080';
    }
    return '';
  }

  // ── State machine ──────────────────────────────────────────────────────────
  // idle → opening → waiting (code shown) → attached (live) → disconnected
  let state = $state('idle');
  let open = $state(false);
  let code = $state('');
  let attachPhrase = $state('');
  let mcpUrl = $state('');
  let attachedCount = $state(0);
  let errorMessage = $state('');
  let copiedKey = $state('');

  let _eventSource = null;
  let _resultsUrl = '';
  let _activeRuns = 0;
  let _attemptedBase = ''; // remember the URL we tried so the error UI can show it

  function copyToClipboard(text, key) {
    try {
      navigator.clipboard.writeText(text);
      copiedKey = key;
      setTimeout(() => { if (copiedKey === key) copiedKey = ''; }, 1500);
    } catch { /* ignore */ }
  }

  async function startPairing() {
    const base = resolveBase();
    _attemptedBase = base;
    if (!base) {
      state = 'error';
      errorMessage = 'No MCP gateway URL configured. Set VITE_MCP_REMOTE_URL in your .env (or window.__PARAFORM_MCP_REMOTE_URL__).';
      open = true;
      return;
    }
    open = true;
    state = 'opening';
    errorMessage = '';
    code = '';
    try {
      const res = await fetch(`${base}/studio/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ua: typeof navigator !== 'undefined' ? navigator.userAgent : '' }),
      });
      if (!res.ok) {
        const errBody = await res.text();
        throw new Error(`pair request failed: ${res.status} ${errBody.slice(0, 200)}`);
      }
      const body = await res.json();
      code = body.code;
      attachPhrase = body.attachPhrase;
      mcpUrl = body.mcpUrl;
      _resultsUrl = body.resultsUrl;
      _connectStream(body.eventsUrl);
      state = 'waiting';
    } catch (e) {
      state = 'error';
      // The most common cause by far is "the gateway isn't running" — fetch
      // throws TypeError("Failed to fetch") in browsers for that. Surface a
      // diagnostic the user can act on, not the raw error.
      const raw = (e && e.message) || String(e);
      const looksLikeNetwork = /failed to fetch|networkerror|ECONNREFUSED|ERR_CONNECTION|load failed/i.test(raw);
      if (looksLikeNetwork) {
        errorMessage = `Can't reach the MCP gateway at ${base}.`;
      } else {
        errorMessage = raw;
      }
    }
  }

  function _connectStream(url) {
    if (_eventSource) try { _eventSource.close(); } catch { /* ignore */ }
    const es = new EventSource(url);
    _eventSource = es;
    es.addEventListener('hello', (ev) => {
      try {
        const data = JSON.parse(ev.data);
        attachedCount = Number(data.attached) || 0;
      } catch { /* ignore */ }
    });
    es.onmessage = (ev) => _onToolCall(ev.data);
    es.onerror = () => {
      // The stream may legitimately end (close()), or the server may be down.
      // If we're not deliberately disconnecting, surface it.
      if (state !== 'idle' && state !== 'disconnected') {
        state = 'disconnected';
      }
    };
  }

  async function _onToolCall(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || msg.type !== 'tool_call' || !msg.callId) return;

    // Once any tool_call lands, an MCP session has attached — Claude is live.
    if (state === 'waiting') state = 'attached';
    attachedCount = Math.max(attachedCount, 1);

    _activeRuns++;
    let result;
    try {
      result = await dispatchTool(msg.name, msg.arguments || {});
    } catch (e) {
      result = { ok: false, error: `dispatch threw: ${(e && e.message) || String(e)}` };
    } finally {
      _activeRuns = Math.max(0, _activeRuns - 1);
    }
    try {
      await fetch(_resultsUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callId: msg.callId, result }),
      });
    } catch {
      // If the gateway can't be reached, the call simply times out from
      // Claude's side. Nothing we can do client-side.
    }
  }

  function disconnect() {
    if (_eventSource) try { _eventSource.close(); } catch { /* ignore */ }
    _eventSource = null;
    state = 'idle';
    code = '';
    attachedCount = 0;
    open = false;
  }
</script>

<Button
  variant="outline"
  size="sm"
  class="gap-1.5"
  onclick={() => { if (state === 'idle' || state === 'error' || state === 'disconnected') startPairing(); else open = true; }}
  aria-label="Connect Claude"
>
  <Plug class="size-3.5" />
  {#if state === 'attached'}
    <span class="text-xs">Claude live</span>
  {:else if state === 'waiting'}
    <span class="text-xs">Waiting…</span>
  {:else}
    <span class="text-xs">Connect Claude</span>
  {/if}
</Button>

<Dialog bind:open title="Connect Claude" description="Drive ParaForm directly from your Claude chat — your build updates here live.">
  {#if state === 'opening'}
    <p class="text-sm text-muted-foreground">Opening pairing…</p>
  {:else if state === 'error'}
    <div class="space-y-3">
      <div class="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
        <div class="font-medium">Couldn't open a pairing</div>
        <div class="mt-1 text-xs">{errorMessage}</div>
      </div>
      <div class="rounded-md border border-border bg-background p-3 text-xs text-muted-foreground space-y-2">
        <div class="font-medium text-foreground">Most likely fix</div>
        <ol class="list-decimal space-y-1 pl-4">
          <li>Start the MCP gateway in a terminal:
            <code class="ml-1 rounded bg-accent px-1.5 py-0.5">node mcp/remote_server.mjs</code>
          </li>
          <li>It should log <code class="rounded bg-accent px-1.5 py-0.5">listening on port 8080</code>.</li>
          <li>Click <strong>Reconnect</strong> below.</li>
        </ol>
        <div class="pt-1">
          For Claude.ai to actually connect (not just this studio), the gateway needs a public HTTPS URL.
          Use <code class="rounded bg-accent px-1.5 py-0.5">cloudflared tunnel --url http://localhost:8080</code>
          and set <code class="rounded bg-accent px-1.5 py-0.5">VITE_MCP_REMOTE_URL</code> +
          <code class="rounded bg-accent px-1.5 py-0.5">PARAFORM_MCP_PUBLIC_URL</code> to the tunnel URL.
        </div>
        {#if _attemptedBase}
          <div class="pt-1 text-[10px] text-muted-foreground/70">Tried: <code>{_attemptedBase}/studio/pair</code></div>
        {/if}
      </div>
    </div>
  {:else if state === 'waiting' || state === 'attached'}
    <ol class="space-y-3 text-sm">
      <li>
        <div class="text-muted-foreground text-xs">Step 1 — one-time setup in Claude.ai</div>
        <div class="mt-1">Open Claude → Settings → <strong>Connectors</strong> → <strong>Add custom connector</strong>. Use this URL:</div>
        <div class="mt-1.5 flex items-center gap-2">
          <code class="flex-1 truncate rounded-md border border-border bg-background px-2 py-1 text-xs">{mcpUrl}</code>
          <button
            class="rounded-md border border-border bg-background p-1.5 hover:bg-accent"
            onclick={() => copyToClipboard(mcpUrl, 'mcpUrl')}
            aria-label="Copy MCP URL"
          >
            <Copy class="size-3.5" />
          </button>
        </div>
        {#if copiedKey === 'mcpUrl'}<div class="mt-0.5 text-[11px] text-primary">Copied!</div>{/if}
      </li>

      <li>
        <div class="text-muted-foreground text-xs">Step 2 — attach this studio to your Claude chat</div>
        <div class="mt-1">Paste this line into your Claude chat:</div>
        <div class="mt-1.5 flex items-center gap-2">
          <code class="flex-1 truncate rounded-md border border-border bg-background px-2 py-1 text-xs">{attachPhrase}</code>
          <button
            class="rounded-md border border-border bg-background p-1.5 hover:bg-accent"
            onclick={() => copyToClipboard(attachPhrase, 'phrase')}
            aria-label="Copy phrase"
          >
            <Copy class="size-3.5" />
          </button>
        </div>
        {#if copiedKey === 'phrase'}<div class="mt-0.5 text-[11px] text-primary">Copied!</div>{/if}
        <div class="mt-2 flex items-baseline gap-2">
          <span class="text-xs text-muted-foreground">Code:</span>
          <span class="font-mono text-2xl tracking-widest font-semibold">{code}</span>
        </div>
      </li>

      <li>
        <div class="text-muted-foreground text-xs">Step 3 — status</div>
        {#if state === 'attached'}
          <div class="mt-1 flex items-center gap-2 text-sm">
            <span class="inline-block size-2 rounded-full bg-emerald-500"></span>
            <span><strong>Claude is connected.</strong> Build prompts in Claude will mutate this studio live.</span>
          </div>
        {:else}
          <div class="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
            <span class="inline-block size-2 animate-pulse rounded-full bg-amber-500"></span>
            <span>Waiting for Claude to attach…</span>
          </div>
        {/if}
        {#if _activeRuns > 0}
          <div class="mt-1 text-[11px] text-muted-foreground">Running {_activeRuns} tool{_activeRuns === 1 ? '' : 's'}…</div>
        {/if}
      </li>
    </ol>
  {:else if state === 'disconnected'}
    <div class="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
      The connection to the MCP gateway dropped. Click Reconnect to get a fresh code.
    </div>
  {/if}

  {#snippet footer()}
    {#if state === 'attached' || state === 'waiting'}
      <Button variant="ghost" size="sm" onclick={disconnect}>Disconnect</Button>
      <Button variant="outline" size="sm" onclick={() => open = false}>Close</Button>
    {:else if state === 'disconnected' || state === 'error'}
      <Button variant="outline" size="sm" onclick={() => open = false}>Close</Button>
      <Button size="sm" onclick={startPairing}>Reconnect</Button>
    {:else}
      <Button variant="outline" size="sm" onclick={() => open = false}>Close</Button>
    {/if}
  {/snippet}
</Dialog>
