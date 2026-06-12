<script>
  /**
   * Thin collapsed-panel rail. Rendered by App.svelte in place of a docked
   * panel when that panel is collapsed. Clicking it expands the panel back.
   * `side` controls the border + chevron direction.
   *
   * @prop {'left'|'right'} side
   * @prop {string} label   — vertical caption (e.g. "Browser", "AI")
   * @prop {() => void} onexpand
   */
  let { side = 'left', label = '', onexpand = () => {} } = $props();
</script>

<button
  type="button"
  class="flex w-9 shrink-0 flex-col items-center gap-2 bg-card py-2 text-muted-foreground hover:bg-accent/40 hover:text-foreground {side === 'left' ? 'border-r' : 'border-l'} border-border"
  title={`Expand ${label} panel`}
  aria-label={`Expand ${label} panel`}
  onclick={onexpand}
>
  <span class="text-sm leading-none" aria-hidden="true">
    {side === 'left' ? '»' : '«'}
  </span>
  {#if label}
    <span class="select-none text-[10px] font-medium uppercase tracking-wider [writing-mode:vertical-rl]">
      {label}
    </span>
  {/if}
</button>
