<script>
  /**
   * Custom confirm() replacement. Native window.confirm() blocks the JS
   * thread and looks like a browser pop-up; this one keeps the app's visual
   * language and supports Enter to accept / Esc to cancel.
   *
   * Driven by dialogs.confirm — set via dialogs.askConfirm({...}) which
   * returns a Promise<boolean>.
   */
  import { onMount } from 'svelte';
  import { dialogs } from '$lib/dialogs/dialogs.svelte.js';

  let confirmBtn;

  function accept() { dialogs.resolveConfirm(true); }
  function cancel() { dialogs.resolveConfirm(false); }

  function onKey(e) {
    if (!dialogs.confirm) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      accept();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancel();
    }
  }

  // Auto-focus the confirm button when the dialog opens so Enter "just works"
  // even if the user hasn't tabbed into the dialog yet.
  $effect(() => {
    if (dialogs.confirm && confirmBtn) {
      // setTimeout 0 to push past the same-tick render so the focus sticks.
      setTimeout(() => confirmBtn?.focus(), 0);
    }
  });

  onMount(() => {
    // Use capture so we beat any inner handlers (the sketcher captures Esc, etc.)
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });
</script>

{#if dialogs.confirm}
  <!-- Backdrop -->
  <div
    class="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm"
    onclick={cancel}
    role="presentation"
  >
    <!-- Dialog -->
    <div
      class="min-w-[320px] max-w-md rounded-lg border border-border bg-card p-4 shadow-xl"
      onclick={(e) => e.stopPropagation()}
      role="dialog"
      aria-modal="true"
      aria-labelledby="pf4-confirm-title"
    >
      <div id="pf4-confirm-title" class="mb-1 text-sm font-medium text-foreground">
        {dialogs.confirm.title}
      </div>
      {#if dialogs.confirm.message}
        <div class="mb-4 text-xs text-muted-foreground">
          {dialogs.confirm.message}
        </div>
      {/if}
      <div class="flex justify-end gap-2">
        <button
          type="button"
          onclick={cancel}
          class="rounded border border-border bg-background/60 px-3 py-1 text-xs text-foreground hover:bg-accent"
        >
          {dialogs.confirm.cancelLabel}
          <span class="ml-1 text-[10px] opacity-60">Esc</span>
        </button>
        <button
          type="button"
          bind:this={confirmBtn}
          onclick={accept}
          class={
            'rounded px-3 py-1 text-xs font-medium ' +
            (dialogs.confirm.danger
              ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
              : 'bg-primary text-primary-foreground hover:bg-primary/90')
          }
        >
          {dialogs.confirm.confirmLabel}
          <span class="ml-1 text-[10px] opacity-70">Enter</span>
        </button>
      </div>
    </div>
  </div>
{/if}
