/**
 * Global dialog state — same pattern as palette.svelte.js. Each dialog has
 * its own boolean so they can stack predictably without a router.
 */
class DialogState {
  export = $state(false);
  settings = $state(false);
  parameters = $state(false);
  // Active form-driven command: { command, values } or null when closed.
  // Set by openForm(command) — CommandPalette routes here when a command
  // declares a `form` schema.
  featureForm = $state(null);
  // BuildScript editor. `script` is the visibility boolean (so the existing
  // open(name) / close(name) helpers keep working for keyboard shortcuts);
  // `scriptEditingFeatureId` carries which feature is being edited (null =
  // create a new one on Apply).
  script = $state(false);
  scriptEditingFeatureId = $state(null);
  // E5.1 — "New Document" confirm-unsaved-changes prompt.
  newDocConfirm = $state(false);

  open(name) {
    if (name in this) this[name] = true;
  }
  close(name) {
    if (name in this) this[name] = false;
  }
  openForm(command) {
    const initial = {};
    for (const f of command.form?.fields || []) initial[f.key] = f.default;
    this.featureForm = { command, values: initial };
  }
  closeForm() {
    this.featureForm = null;
  }
  /** Open the script editor. Pass a featureId to edit, or null to create. */
  openScript(featureId = null) {
    this.scriptEditingFeatureId = featureId || null;
    this.script = true;
  }
  closeScript() {
    this.script = false;
    this.scriptEditingFeatureId = null;
  }

  // ── Custom confirm() replacement ────────────────────────────────────────
  // Returns a Promise<boolean>. The ConfirmDialog component reads `confirm`
  // and resolves via the stored callbacks. Enter accepts, Esc cancels.
  //   const ok = await dialogs.askConfirm({ title: 'Delete?', message: '…' });
  confirm = $state(null);
  askConfirm({ title = 'Confirm', message = '', confirmLabel = 'OK', cancelLabel = 'Cancel', danger = false } = {}) {
    // If one is already open, resolve it as cancel before opening a new one.
    if (this.confirm) {
      try { this.confirm._resolve?.(false); } catch {}
      this.confirm = null;
    }
    return new Promise((resolve) => {
      this.confirm = {
        title, message, confirmLabel, cancelLabel, danger,
        _resolve: resolve,
      };
    });
  }
  resolveConfirm(answer) {
    if (!this.confirm) return;
    try { this.confirm._resolve?.(!!answer); } catch {}
    this.confirm = null;
  }
}

export const dialogs = new DialogState();
