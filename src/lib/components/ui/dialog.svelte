<script>
  import { cn } from '$lib/utils.js';

  let {
    open = $bindable(false),
    onclose = null,
    title = '',
    description = '',
    class: className = '',
    children,
    footer,
  } = $props();

  // Generated per-instance so the dialog's aria-labelledby can point to its
  // <h2 id> without callers having to thread an id through.
  const titleId = `dlg-title-${Math.random().toString(36).slice(2, 9)}`;

  function close() {
    open = false;
    onclose?.();
  }

  function onBackdrop(e) {
    if (e.target === e.currentTarget) close();
  }

  // Window-level Escape so the dialog closes regardless of focus location.
  // The on:keydown on the backdrop alone only fires when focus is inside the
  // dialog, but the backdrop is tabindex=-1 and not auto-focused on open.
  $effect(() => {
    if (!open) return;
    const handler = (e) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  });
</script>

{#if open}
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-foreground/20 dark:bg-black/40 px-4"
    role="dialog"
    aria-modal="true"
    aria-labelledby={title ? titleId : undefined}
    aria-label={title ? undefined : 'Dialog'}
    onclick={onBackdrop}
    onkeydown={(e) => { if (e.key === 'Escape') close(); }}
    tabindex="-1"
  >
    <div class={cn('w-full max-w-md rounded-lg border border-border bg-popover p-4 shadow-xl', className)}>
      {#if title}
        <div class="mb-3">
          <h2 id={titleId} class="text-sm font-semibold">{title}</h2>
          {#if description}<p class="mt-0.5 text-xs text-muted-foreground">{description}</p>{/if}
        </div>
      {/if}

      <div>{@render children?.()}</div>

      {#if footer}
        <div class="mt-4 flex items-center justify-end gap-2">
          {@render footer()}
        </div>
      {/if}
    </div>
  </div>
{/if}
