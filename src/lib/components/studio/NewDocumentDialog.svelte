<script>
  import Dialog from '$lib/components/ui/dialog.svelte';
  import Button from '$lib/components/ui/button.svelte';
  import { dialogs } from '$lib/dialogs/dialogs.svelte.js';
  import { resetDocument } from '../../../../lib/document/index.js';

  function close() {
    dialogs.close('newDocConfirm');
  }

  function discard() {
    try { resetDocument(); }
    catch (err) { console.warn('[new-document] reset failed:', err); }
    close();
  }
</script>

<Dialog
  bind:open={dialogs.newDocConfirm}
  title="Start a new document?"
  description="Unsaved changes will be lost. Save first if you want to keep them."
  class="max-w-sm"
  onclose={close}
>
  {#snippet children()}
    <p class="text-xs text-muted-foreground">
      This clears the current document and starts fresh. Autosaved data in
      this browser is replaced on the next change.
    </p>
  {/snippet}

  {#snippet footer()}
    <Button size="sm" variant="ghost" onclick={close}>
      {#snippet children()}Cancel{/snippet}
    </Button>
    <Button size="sm" variant="destructive" onclick={discard}>
      {#snippet children()}Discard &amp; start new{/snippet}
    </Button>
  {/snippet}
</Dialog>
