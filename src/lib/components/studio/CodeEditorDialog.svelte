<script>
  import { tick } from 'svelte';
  import Dialog from '$lib/components/ui/dialog.svelte';
  import Button from '$lib/components/ui/button.svelte';
  import { dialogs } from '$lib/dialogs/dialogs.svelte.js';
  import {
    getDocumentStore,
    getDocumentExecutor,
    addBuildScript,
    updateBuildScript,
  } from '../../../../lib/document/index.js';

  const store = getDocumentStore();

  // Default snippet shown when creating a brand-new script. Mirrors the
  // DEFAULT_BUILD_SCRIPT in lib/document/operations.js so users see the same
  // starting point whether they open the dialog or call the API directly.
  const DEFAULT_SCRIPT = `# Write build123d Python here, then assign your final body to a
# variable named \`result\` — that is what gets rendered. A script
# that assigns no \`result\` just defines helpers and renders nothing.
#
# Runs sandboxed: build123d, math and numpy are available; the
# filesystem, network and os/subprocess are not.
#
# build123d 0.10's public API ('Box', 'Cylinder', 'BuildPart',
# 'Locations', 'Mode', ...) is already in scope, but the explicit
# import keeps your script portable.

from build123d import *

with BuildPart() as part:
    Box(40, 40, 20)
    with Locations((0, 0, 20)):
        Cylinder(5, 20, mode=Mode.SUBTRACT)

result = part.part
`;

  let textareaEl = $state(null);
  let nameValue = $state('Script');
  let codeValue = $state(DEFAULT_SCRIPT);

  // Track which feature we last opened on so we only re-seed the editor when
  // the editing target actually changes (not on every keystroke).
  let lastSeededFor = $state(undefined);

  // (Re)seed editor state whenever the dialog (re)opens for a different
  // feature or transitions to "create new". Pulls from the live doc so the
  // textarea reflects the current saved code, not whatever the user typed
  // last time.
  $effect(() => {
    if (!dialogs.script) {
      lastSeededFor = undefined;
      return;
    }
    const fid = dialogs.scriptEditingFeatureId;
    const key = fid ?? '__new__';
    if (key === lastSeededFor) return;
    lastSeededFor = key;
    if (fid) {
      const f = store.doc.features?.[fid];
      if (f && f.type === 'BuildScript') {
        nameValue = f.name || 'Script';
        codeValue = typeof f.params?.code === 'string' ? f.params.code : DEFAULT_SCRIPT;
      } else {
        // featureId went stale (deleted between open and render). Fall back to create.
        nameValue = 'Script';
        codeValue = DEFAULT_SCRIPT;
      }
    } else {
      nameValue = 'Script';
      codeValue = DEFAULT_SCRIPT;
    }
    // Focus the textarea once the dialog has actually rendered.
    tick().then(() => {
      textareaEl?.focus();
    });
  });

  // Surface the most recent kernel error, but only when it likely concerns
  // this script. The executor's error string usually contains the feature
  // name or id — we substring-match on either. Hidden when nothing matches.
  let kernelError = $derived.by(() => {
    if (!dialogs.script) return null;
    const exec = getDocumentExecutor();
    const err = exec?.lastError?.();
    if (!err) return null;
    const fid = dialogs.scriptEditingFeatureId;
    if (!fid) return null;
    const f = store.doc.features?.[fid];
    const hay = String(err);
    const matches =
      hay.includes(fid) ||
      (f?.name && hay.includes(f.name)) ||
      hay.toLowerCase().includes('buildscript');
    return matches ? hay : null;
  });

  let isEditing = $derived(!!dialogs.scriptEditingFeatureId);
  let titleText = $derived(isEditing ? 'Edit Script' : 'New Script');

  function cancel() {
    dialogs.closeScript();
  }

  function apply() {
    const name = nameValue.trim() || 'Script';
    const code = codeValue;
    try {
      if (dialogs.scriptEditingFeatureId) {
        updateBuildScript(dialogs.scriptEditingFeatureId, { code, name });
      } else {
        addBuildScript({ code, name });
      }
    } catch (e) {
      console.error('[CodeEditorDialog] apply failed', e);
      return;
    }
    dialogs.closeScript();
  }

  function onTextareaKeydown(e) {
    // Ctrl/Cmd+S — apply without closing focus chain.
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      apply();
      return;
    }
    // Tab inserts 4 spaces at the caret instead of moving focus.
    if (e.key === 'Tab') {
      e.preventDefault();
      const el = e.currentTarget;
      const start = el.selectionStart;
      const end = el.selectionEnd;
      const indent = '    ';
      const next = codeValue.slice(0, start) + indent + codeValue.slice(end);
      codeValue = next;
      // Restore caret after the inserted indent — must run after the binding
      // round-trips through the DOM.
      tick().then(() => {
        el.selectionStart = el.selectionEnd = start + indent.length;
      });
    }
  }

  // Ctrl+S anywhere in the dialog body (e.g. while editing the name).
  function onDialogKeydown(e) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      apply();
    }
  }
</script>

<Dialog
  bind:open={dialogs.script}
  onclose={cancel}
  title={titleText}
  description="build123d Python (sandboxed) — assign your final body to a variable named `result` to render it."
  class="max-w-3xl"
>
  {#snippet children()}
    <div
      class="space-y-3"
      role="presentation"
      onkeydown={onDialogKeydown}
    >
      <div>
        <label for="codeeditor-name" class="mb-1 block text-xs font-medium text-muted-foreground">
          Name
        </label>
        <input
          id="codeeditor-name"
          type="text"
          bind:value={nameValue}
          autocomplete="off"
          spellcheck={false}
          class="h-7 w-full rounded border border-input bg-card px-2 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
      </div>

      <div>
        <label for="codeeditor-code" class="mb-1 block text-xs font-medium text-muted-foreground">
          Code
        </label>
        <textarea
          id="codeeditor-code"
          bind:this={textareaEl}
          bind:value={codeValue}
          onkeydown={onTextareaKeydown}
          rows="24"
          spellcheck={false}
          autocomplete="off"
          autocapitalize="off"
          autocorrect="off"
          class="h-96 w-full resize-y rounded border border-input bg-card font-mono text-xs leading-5 p-3 outline-none focus-visible:ring-1 focus-visible:ring-ring"
        ></textarea>
        <p class="mt-1 text-[10px] text-muted-foreground">
          Tab inserts 4 spaces. Ctrl+S applies.
        </p>
      </div>

      {#if kernelError}
        <div class="rounded-sm border border-destructive/40 bg-destructive/10 px-2 py-1.5 font-mono text-[10px] text-destructive whitespace-pre-wrap">
          {kernelError}
        </div>
      {/if}
    </div>
  {/snippet}

  {#snippet footer()}
    <Button variant="ghost" size="sm" onclick={cancel}>
      {#snippet children()}Cancel{/snippet}
    </Button>
    <Button size="sm" onclick={apply}>
      {#snippet children()}Apply{/snippet}
    </Button>
  {/snippet}
</Dialog>
