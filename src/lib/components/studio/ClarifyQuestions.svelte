<script>
  /**
   * Clarification card — renders the AI's Stage-0 clarifying questions (parsed
   * from a ```ask block, see clarify.js) as clickable option chips with a
   * sensible default pre-selected and an "Other…" free-text fallback. Collects
   * one answer per question, then sends them back as a single chat message.
   */
  let { questions = [], disabled = false, onSubmit = null } = $props();

  // One slot per question. single → string|null; multi → string[].
  let selected = $state(questions.map((q) => (q.multi ? (q.default ? [q.default] : []) : (q.default || null))));
  let others = $state(questions.map(() => ''));
  let otherOpen = $state(questions.map(() => false));
  let sent = $state(false);

  const locked = $derived(disabled || sent);

  function pick(i, opt) {
    if (locked) return;
    if (questions[i].multi) {
      const cur = Array.isArray(selected[i]) ? [...selected[i]] : [];
      const at = cur.indexOf(opt);
      if (at >= 0) cur.splice(at, 1); else cur.push(opt);
      selected[i] = cur;
    } else {
      selected[i] = selected[i] === opt ? null : opt;
      otherOpen[i] = false;
    }
  }
  function toggleOther(i) {
    if (locked) return;
    otherOpen[i] = !otherOpen[i];
    if (otherOpen[i] && !questions[i].multi) selected[i] = null;
  }
  function isOn(i, opt) {
    return questions[i].multi ? (Array.isArray(selected[i]) && selected[i].includes(opt)) : selected[i] === opt;
  }
  function answerFor(i) {
    const extra = (others[i] || '').trim();
    if (questions[i].multi) {
      const arr = [...(Array.isArray(selected[i]) ? selected[i] : [])];
      if (extra) arr.push(extra);
      return arr.join(', ');
    }
    return extra || (typeof selected[i] === 'string' ? selected[i] : '');
  }
  const ready = $derived(questions.length > 0 && questions.every((_, i) => answerFor(i)));

  function send() {
    if (locked || !ready || typeof onSubmit !== 'function') return;
    const lines = questions.map((q, i) => `• ${q.q} → ${answerFor(i)}`);
    onSubmit(lines.join('\n'));
    sent = true;
  }
</script>

<div class="mt-1.5 space-y-3 rounded-lg border border-primary/30 bg-primary/[0.04] p-3">
  {#each questions as q, i (i)}
    <div class="space-y-1.5">
      <div class="text-[13px] font-medium leading-snug text-foreground">{q.q}</div>
      <div class="flex flex-wrap gap-1.5">
        {#each q.options as opt (opt)}
          <button
            type="button"
            disabled={locked}
            class="rounded-full border px-2.5 py-1 text-xs transition-colors disabled:opacity-50
              {isOn(i, opt) ? 'border-primary bg-primary/20 text-foreground' : 'border-border text-muted-foreground hover:border-primary/50 hover:text-foreground'}"
            onclick={() => pick(i, opt)}
          >{opt}{#if q.default === opt}<span class="ml-1 align-middle text-[8px] uppercase tracking-wide opacity-60">default</span>{/if}</button>
        {/each}
        <button
          type="button"
          disabled={locked}
          class="rounded-full border border-dashed px-2.5 py-1 text-xs transition-colors disabled:opacity-50
            {otherOpen[i] ? 'border-primary bg-primary/20 text-foreground' : 'border-border text-muted-foreground hover:text-foreground'}"
          onclick={() => toggleOther(i)}
        >Other…</button>
      </div>
      {#if otherOpen[i]}
        <input
          bind:value={others[i]}
          disabled={locked}
          placeholder="Type your answer…"
          class="w-full rounded border border-input bg-transparent px-2 py-1 text-xs outline-none focus:border-ring"
        />
      {/if}
    </div>
  {/each}

  <div class="flex items-center justify-between pt-0.5">
    <span class="text-[10px] text-muted-foreground/60">{sent ? 'Answers sent' : 'Pick or type, then send'}</span>
    <button
      type="button"
      disabled={locked || !ready}
      class="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
      onclick={send}
    >{sent ? 'Sent ✓' : 'Send answers'}</button>
  </div>
</div>
