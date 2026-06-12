<script>
  import Button from '$lib/components/ui/button.svelte';
  import { loadAllSettings, resetAllSettings } from '$lib/settings/schema.js';
  import { clearSavedDocument } from '$lib/document/persistence.svelte.js';

  let status = $state('');

  function flash(msg) {
    status = msg;
    setTimeout(() => { if (status === msg) status = ''; }, 2000);
  }

  function onReset() {
    resetAllSettings();
    flash('Settings reset to defaults.');
  }

  async function onCopyDiagnostics() {
    const diag = {
      settings: loadAllSettings(),
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
      screen: typeof window !== 'undefined' && window.screen
        ? { width: window.screen.width, height: window.screen.height, dpr: window.devicePixelRatio }
        : null,
      timestamp: new Date().toISOString(),
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(diag, null, 2));
      flash('Diagnostics copied to clipboard.');
    } catch (e) {
      console.warn('[presets] copy diagnostics failed:', e);
      flash('Copy failed.');
    }
  }

  function onClearCache() {
    clearSavedDocument();
    flash('Cached document cleared.');
  }
</script>

<div class="space-y-3">
  <p class="text-xs text-muted-foreground">
    Maintenance actions for application state.
  </p>

  <div class="space-y-2">
    <div class="flex items-center justify-between gap-3 rounded-md border border-border p-3">
      <div class="min-w-0">
        <div class="text-xs font-medium text-foreground">Reset to factory defaults</div>
        <div class="text-[11px] text-muted-foreground">Restore every panel to its default values.</div>
      </div>
      <Button size="sm" variant="outline" onclick={onReset}>
        {#snippet children()}Reset{/snippet}
      </Button>
    </div>

    <div class="flex items-center justify-between gap-3 rounded-md border border-border p-3">
      <div class="min-w-0">
        <div class="text-xs font-medium text-foreground">Copy diagnostics</div>
        <div class="text-[11px] text-muted-foreground">JSON of current settings, UA and screen.</div>
      </div>
      <Button size="sm" variant="outline" onclick={onCopyDiagnostics}>
        {#snippet children()}Copy{/snippet}
      </Button>
    </div>

    <div class="flex items-center justify-between gap-3 rounded-md border border-border p-3">
      <div class="min-w-0">
        <div class="text-xs font-medium text-foreground">Clear cache</div>
        <div class="text-[11px] text-muted-foreground">Remove the persisted document from local storage.</div>
      </div>
      <Button size="sm" variant="destructive" onclick={onClearCache}>
        {#snippet children()}Clear{/snippet}
      </Button>
    </div>
  </div>

  {#if status}
    <p class="text-[11px] text-muted-foreground">{status}</p>
  {/if}
</div>
